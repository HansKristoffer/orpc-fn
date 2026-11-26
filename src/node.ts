import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnyRouter, InferRouterInitialContext } from '@orpc/server'
import { RPCHandler } from '@orpc/server/node'
import {
	sendWebResponse,
	toWebHeaders,
	withNodeCompression
} from './http/node.js'
import {
	type BaseContext,
	type ContextFactory,
	createMounts,
	createRequestContext,
	formatServerTiming,
	type MountOptions,
	type MountTarget,
	markArrival,
	matchesPrefix,
	msSinceArrival,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
	type Path,
	type RequestTiming,
	timed
} from './http/mount.js'
import {
	allOf,
	anyOf,
	hasTag,
	hasTags,
	not,
	type ProcedureFilter
} from './meta.js'
import { CLIENT_REQUEST_HEADERS } from './request-headers.js'

export {
	allOf,
	anyOf,
	type BaseContext,
	CLIENT_REQUEST_HEADERS,
	formatServerTiming,
	hasTag,
	hasTags,
	not,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
	type ProcedureFilter,
	type RequestTiming,
	timed
}

/** Builds the router's context from the request; return a `Response` (e.g. 401) to answer instead. */
export type NodeContextFactory<R extends AnyRouter> = ContextFactory<
	IncomingMessage,
	R
>

export type NodeHandlerOptions<R extends AnyRouter> = MountOptions<
	R,
	IncomingMessage,
	IncomingMessage
> &
	MountTarget<R>

/**
 * A Node `http` handler: a Next.js Pages Router API route, Express or
 * `http.createServer`. Unmatched requests go to `next` when given (Express),
 * else get a 404; errors outside oRPC (the context factory) go to `next(error)`.
 */
export type NodeHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	next?: (error?: unknown) => void
) => Promise<void>

/**
 * Marks a request at the server's front door (`http.createServer`), before
 * routing and middleware. The handler reports the time until the procedure
 * runs as `queue_ms`: in-process queueing no handler timer can see.
 */
export const markRequestArrival: (req: IncomingMessage) => void = markArrival

/** Milliseconds since {@link markRequestArrival}, or undefined when unmarked. */
export const msSinceRequestArrival: (
	req: IncomingMessage
) => number | undefined = msSinceArrival

type Handler<C> = {
	handle(
		req: IncomingMessage,
		res: ServerResponse,
		options: { prefix: Path; context: C }
	): Promise<{ matched: boolean }>
}

/**
 * oRPC's node RPC and OpenAPI handlers (`@orpc/server/node`) as one
 * `(req, res)` function, with batching, `resHeaders`, Server-Timing,
 * compression and error reporting. A body an earlier middleware parsed
 * (`req.body`) is used as is; Next.js should leave it unparsed.
 *
 * ```ts
 * // pages/api/rpc/[[...rpc]].ts
 * export const config = { api: { bodyParser: false } }
 * export default createNodeHandler({ router, rpcPrefix: '/api/rpc' })
 * ```
 */
export function createNodeHandler<R extends AnyRouter>(
	options: NodeHandlerOptions<R>
): NodeHandler {
	if (!options.rpcPrefix && !options.openapi)
		throw new TypeError('orpc-fn: createNodeHandler needs rpcPrefix or openapi')
	type C = InferRouterInitialContext<R>
	const compress = options.compress ?? true
	const mounts = createMounts<R, Handler<C>>(options, {
		rpc: (router, { eventStream, ...handlerOptions }) =>
			new RPCHandler<C>(router, {
				...handlerOptions,
				sendStandardResponse: { eventStream }
			}),
		openapi: async () => {
			const { OpenAPIHandler } = await import('@orpc/openapi/node')
			return (router, { eventStream, ...handlerOptions }) =>
				new OpenAPIHandler<C>(router, {
					...handlerOptions,
					sendStandardResponse: { eventStream }
				})
		}
	})
	const queueMs = options.queueMs ?? msSinceArrival
	return async (req, res, next) => {
		try {
			// oRPC reads Express's `originalUrl` too, so prefixes stay absolute.
			const url = (req as { originalUrl?: string }).originalUrl ?? req.url
			const path = new URL(url ?? '/', 'http://localhost').pathname
			const candidates = mounts.filter((mount) =>
				matchesPrefix(path, mount.prefix)
			)

			if (candidates.length) {
				const context = await createRequestContext(
					options,
					req,
					toWebHeaders(req.headers),
					queueMs(req)
				)
				if (context instanceof Response)
					return await sendWebResponse(res, context)

				for (const mount of candidates) {
					const handler = await mount.handler()
					const handle = () =>
						handler.handle(req, res, { prefix: mount.prefix, context })
					const { matched } = compress
						? // HTTP/2 compatibility responses have the same write methods.
							await withNodeCompression(req, res, handle)
						: await handle()
					if (matched) return
				}
			}

			if (next) return next()
			res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found')
		} catch (error) {
			if (!next) throw error
			next(error)
		}
	}
}
