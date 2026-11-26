// The Fetch runtime of the mount core, shared by orpc-fn/fetch and orpc-fn/hono.
import { Readable, pipeline } from 'node:stream'
import type { AnyRouter, InferRouterInitialContext } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import {
	compressBytes,
	compressionKind,
	createFlushingCompressor,
	MIN_COMPRESS_BYTES,
	negotiateEncoding,
	varyWithAcceptEncoding
} from './compression.js'
import {
	createMounts,
	createRequestContext,
	type MountOptions,
	matchesPrefix,
	msSinceArrival,
	type Path
} from './mount.js'

type FetchHandler<C> = {
	handle(
		request: Request,
		options: { prefix: Path; context: C }
	): Promise<{ matched: boolean; response?: Response | undefined }>
}

/**
 * Answers `request` from the matching handler, or resolves to undefined when
 * no mount matched. `prefix` limits it to one mount (Hono routes per prefix).
 */
export type FetchCore<Arg> = {
	prefixes: Path[]
	handle(
		request: Request,
		arg: Arg,
		prefix?: Path
	): Promise<Response | undefined>
}

export function createFetchCore<R extends AnyRouter, Arg>(
	options: MountOptions<R, Arg, Request>
): FetchCore<Arg> {
	type C = InferRouterInitialContext<R>
	const mounts = createMounts<R, FetchHandler<C>>(options, {
		rpc: (router, { eventStream, ...handlerOptions }) =>
			new RPCHandler<C>(router, {
				...handlerOptions,
				toFetchResponse: { eventStream }
			}),
		openapi: async () => {
			const { OpenAPIHandler } = await import('@orpc/openapi/fetch')
			return (router, { eventStream, ...handlerOptions }) =>
				new OpenAPIHandler<C>(router, {
					...handlerOptions,
					toFetchResponse: { eventStream }
				})
		}
	})
	const compress = options.compress ?? true
	const queueMs = options.queueMs ?? msSinceArrival

	return {
		prefixes: mounts.map((mount) => mount.prefix),
		async handle(request, arg, prefix) {
			const path = new URL(request.url).pathname
			const candidates = mounts.filter(
				(mount) =>
					(prefix === undefined || mount.prefix === prefix) &&
					matchesPrefix(path, mount.prefix)
			)
			if (!candidates.length) return undefined

			const context = await createRequestContext(
				options,
				arg,
				request.headers,
				queueMs(request)
			)
			if (context instanceof Response) return context

			for (const mount of candidates) {
				const handler = await mount.handler()
				const { matched, response } = await handler.handle(request, {
					prefix: mount.prefix,
					context
				})
				if (matched && response)
					return compress ? compressResponse(request, response) : response
			}
			return undefined
		}
	}
}

/**
 * Brotli or gzip for JSON and streaming batches, when the client accepts
 * it. A batch stream is flushed after every result. Cancelling the result
 * cancels the original body.
 */
async function compressResponse(
	request: Request,
	response: Response
): Promise<Response> {
	if (!response.body || request.method === 'HEAD') return response
	const encoding = negotiateEncoding(request.headers.get('accept-encoding'))
	if (!encoding) return response
	const kind = compressionKind(
		(name) => response.headers.get(name) ?? undefined
	)
	if (!kind) return response

	const init = { status: response.status, statusText: response.statusText }
	const headers = new Headers(response.headers)
	let body: ReadableStream<Uint8Array> | Uint8Array
	if (kind === 'batch-stream') {
		const compressor = createFlushingCompressor(encoding)
		pipeline(Readable.fromWeb(response.body as never), compressor, () => {})
		body = Readable.toWeb(compressor) as unknown as ReadableStream<Uint8Array>
		headers.delete('content-length')
	} else {
		// oRPC sends JSON without a length; a declared small one skips the read.
		const declaredLength = Number(response.headers.get('content-length') ?? NaN)
		if (declaredLength < MIN_COMPRESS_BYTES) return response

		const raw = new Uint8Array(await response.arrayBuffer())
		if (raw.byteLength < MIN_COMPRESS_BYTES)
			return new Response(raw, { ...init, headers })
		body = await compressBytes(encoding, raw)
		headers.set('content-length', String(body.byteLength))
	}

	headers.set('content-encoding', encoding)
	const vary = varyWithAcceptEncoding(headers.get('vary') ?? undefined)
	if (vary) headers.set('vary', vary)
	return new Response(body as ConstructorParameters<typeof Response>[0], {
		...init,
		headers
	})
}
