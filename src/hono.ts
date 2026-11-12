import { Readable, pipeline } from 'node:stream'
import zlib from 'node:zlib'
import type { OpenAPIGeneratorGenerateOptions } from '@orpc/openapi'
import {
	type AnyRouter,
	type InferRouterInitialContext,
	onError as orpcOnError
} from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import type { StandardHandlerPlugin } from '@orpc/server/standard'
import type { Context as HonoContext, Env, Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import { REQUEST_TIMING, type InvocationTiming } from './timing.js'
import { isExpectedClientError } from './expected-client-error.js'
import { hasTag, type ProcedureFilter } from './meta.js'

export { hasTag, type ProcedureFilter }

/** Per-request timings in ms; `fn()` adds `handler_ms`. Sent as Server-Timing. */
export type RequestTiming = Record<string, number>

/**
 * Run `work` and add its duration to `timing[key]` (rounded to 0.01 ms),
 * whether it resolves or throws: `await timed(context.timing, 'auth_ms', () => getSession(headers))`.
 */
export async function timed<T>(
	timing: RequestTiming,
	key: string,
	work: () => T | Promise<T>
): Promise<T> {
	const started = performance.now()
	try {
		return await work()
	} finally {
		timing[key] =
			(timing[key] ?? 0) + Math.round((performance.now() - started) * 100) / 100
	}
}

/** What every request starts with; the default context when `context` is omitted. */
export type BaseContext = { headers: Headers; timing: RequestTiming }

/**
 * Builds the router's initial context from the request. Return a `Response`
 * to answer (e.g. 401) instead.
 */
export type ContextFactory<E extends Env, R extends AnyRouter> = (
	c: HonoContext<E>,
	base: BaseContext
) =>
	| InferRouterInitialContext<R>
	| Response
	| Promise<InferRouterInitialContext<R> | Response>

/** `context` is optional only when the base context already satisfies the router. */
type ContextOption<E extends Env, R extends AnyRouter> =
	BaseContext extends InferRouterInitialContext<R>
		? { context?: ContextFactory<E, R> }
		: { context: ContextFactory<E, R> }

type Path = `/${string}`
type Handler<C> = {
	handle(
		request: Request,
		options: { prefix: Path; context: C }
	): Promise<{ matched: boolean; response: Response | undefined }>
}
type Plugin<T extends object> = StandardHandlerPlugin<T>

export type OpenApiMountOptions<R extends AnyRouter> = {
	prefix: Path
	info?: { title: string; version: string; description?: string }
	/** Docs page, relative to `prefix` (default '/'); the spec is at `/spec.json`. */
	docsPath?: Path
	/** false: serve the REST routes without the docs page and `spec.json`. */
	docs?: boolean
	/**
	 * The procedures to publish (also filters the spec), e.g.
	 * `hasTag('external')`. Required, so publishing is a choice;
	 * `() => true` publishes every route.
	 */
	filter: ProcedureFilter
	/** Turn JSON strings back into `Date`s etc. for `z.date()` inputs. */
	smartCoercion?: boolean
	/** Extra spec fields, e.g. `components.securitySchemes` and `security`. */
	spec?: Omit<OpenAPIGeneratorGenerateOptions, 'filter'>
	plugins?: Plugin<InferRouterInitialContext<R>>[]
}

export type MountOrpcOptions<
	E extends Env,
	R extends AnyRouter
> = ContextOption<E, R> & {
	router: R
	/** Mount the RPC handler (oRPC's `RPCLink`) here. Omit to skip it. */
	rpcPrefix?: Path
	/**
	 * Mount the OpenAPI (REST) handler and its Scalar docs here. Needs the
	 * optional peers `@orpc/openapi`, `@orpc/json-schema` and `@orpc/zod`,
	 * loaded on the first request to `prefix`.
	 */
	openapi?: OpenApiMountOptions<R>
	/** Collapse parallel RPC calls into one HTTP request. Default: true (25 calls). */
	batch?: boolean | { maxSize: number }
	/** Add a Server-Timing header from the request timing. Default: true */
	serverTiming?: boolean
	/**
	 * gzip JSON responses and batch event streams for clients that accept it,
	 * flushing after every batch result. Other event streams are left alone.
	 * Default: true
	 */
	compress?: boolean
	/** SSE keep-alive comments every N ms (default 15000), or false. */
	sseKeepAlive?: boolean | number
	/**
	 * Extra RPC plugins. CORS belongs to Hono's `cors()` on the app, once; a
	 * cross-origin client with batching needs `x-orpc-batch` in its `allowHeaders`.
	 */
	plugins?: Plugin<InferRouterInitialContext<R>>[]
	/** Rewrite request headers before they reach the context (see `normalizeExpoOrigin`). */
	normalizeHeaders?: (headers: Headers) => Headers
	/**
	 * Time spent before the handler ran, reported as `queue`. Default: time
	 * since {@link markRequestArrival}, when the server marked the request.
	 */
	queueMs?: (request: Request) => number | undefined
	/**
	 * Unexpected procedure errors (oRPC turns thrown errors into responses, so
	 * Hono's `onError` never sees them). Expected client errors are skipped.
	 */
	onError?: (error: unknown, request: { url: string; method: string }) => void
	/**
	 * Default: `isExpectedClientError`, which also accepts any error the
	 * route's `createFn({ isExpectedError })` classified as expected.
	 */
	isExpectedError?: (error: unknown) => boolean
}

const arrivals = new WeakMap<Request, number>()

/**
 * Marks a request at the server's front door (`Bun.serve({ fetch })`), before
 * routing and middleware. `mountOrpc` reports the time until the procedure
 * runs as `queue_ms`: in-process queueing no handler timer can see.
 */
export function markRequestArrival(request: Request): void {
	arrivals.set(request, performance.now())
}

/** Milliseconds since {@link markRequestArrival}, or undefined when unmarked. */
export function msSinceRequestArrival(request: Request): number | undefined {
	const arrivedAt = arrivals.get(request)
	return arrivedAt === undefined ? undefined : performance.now() - arrivedAt
}

/**
 * Expo native sends `expo-origin` but not `origin`; copy it so cookie-based
 * auth (e.g. Better Auth) sees the origin.
 */
export function normalizeExpoOrigin(raw: Headers): Headers {
	const expo = raw.get('expo-origin')
	if (!expo || raw.get('origin')) return raw
	const headers = new Headers(raw)
	headers.set('origin', expo)
	return headers
}

export function formatServerTiming(
	totalMs: number,
	timing: Record<string, number | undefined>
): string {
	const parts = [`total;dur=${totalMs.toFixed(2)}`]
	for (const [key, value] of Object.entries(timing)) {
		if (value !== undefined) {
			parts.push(`${key.replace(/_ms$/, '')};dur=${value.toFixed(2)}`)
		}
	}
	return parts.join(', ')
}

/**
 * Response headers plus Server-Timing. For SSE, also disable proxy buffering
 * so keep-alive comments reach the edge (empty `:` lines are otherwise easy
 * for nginx/Fastly to hold until an idle kill). A copy: some responses (e.g.
 * redirects) have immutable headers.
 */
export function finishOrpcHeaders(
	response: Response,
	serverTiming: string | undefined
): Headers {
	const headers = new Headers(response.headers)
	if (serverTiming) {
		headers.set('Server-Timing', serverTiming)
		headers.append('Access-Control-Expose-Headers', 'Server-Timing')
	}
	if ((headers.get('content-type') ?? '').includes('text/event-stream')) {
		headers.set('Cache-Control', 'no-cache')
		headers.set('X-Accel-Buffering', 'no')
	}
	return headers
}

const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i

/**
 * JSON, and the event stream oRPC answers a streaming batch with (one event
 * per result). Other event streams are live: they stay open and carry little.
 */
function shouldCompress(request: Request, response: Response): boolean {
	if (request.method === 'HEAD') return false
	if (!request.headers.get('accept-encoding')?.includes('gzip')) return false
	if (response.headers.has('content-encoding')) return false
	if (NO_TRANSFORM.test(response.headers.get('cache-control') ?? '')) {
		return false
	}
	const type = response.headers.get('content-type') ?? ''
	if (type.startsWith('text/event-stream')) {
		// BatchHandlerPlugin keys on this header too, whatever the URL.
		return request.headers.has('x-orpc-batch')
	}
	return type.startsWith('application/json')
}

/**
 * gzip that emits every chunk at once, so a fast batch result is not held
 * back by a slow one. Cancelling the result cancels `body`.
 */
function gzipFlushingEachChunk(
	body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
	pipeline(Readable.fromWeb(body as never), gzip, () => {})
	return Readable.toWeb(gzip) as unknown as ReadableStream<Uint8Array>
}

/** Mount oRPC's RPC and OpenAPI handlers on a Hono app. */
export function mountOrpc<E extends Env, R extends AnyRouter>(
	app: Hono<E>,
	options: MountOrpcOptions<E, R>
): void {
	const {
		router,
		batch = true,
		serverTiming = true,
		sseKeepAlive = true,
		compress = true
	} = options
	const isExpectedError = options.isExpectedError ?? isExpectedClientError
	const keepAlive =
		sseKeepAlive === false
			? { eventIteratorKeepAliveEnabled: false }
			: {
					eventIteratorKeepAliveEnabled: true,
					// Explicit keep-alive under proxy idle timers (~30s); oRPC's default is 5s.
					eventIteratorKeepAliveInterval:
						sseKeepAlive === true ? 15_000 : sseKeepAlive
				}
	const report = (
		error: unknown,
		{ request }: { request: { url: URL; method: string } }
	) => {
		try {
			if (isExpectedError(error)) return
			options.onError?.(error, {
				url: request.url.pathname,
				method: request.method
			})
		} catch {
			/* Error reporting cannot replace transport outcomes. */
		}
	}

	const mount = (
		prefix: Path,
		handler: Handler<InferRouterInitialContext<R>>
	) => {
		app.use(`${prefix}/*`, async (c, next) => {
			const timing: RequestTiming = {}
			const queueMs = (options.queueMs ?? msSinceRequestArrival)(c.req.raw)
			if (queueMs !== undefined)
				timing.queue_ms = Math.round(queueMs * 100) / 100
			const started = performance.now()
			const headers = options.normalizeHeaders
				? options.normalizeHeaders(c.req.raw.headers)
				: c.req.raw.headers
			const context = options.context
				? await options.context(c, { headers, timing })
				: { headers, timing }
			if (context instanceof Response) return context
			const invocationTiming: InvocationTiming = { procedureMs: 0, calls: 0 }
			const { matched, response } = await handler.handle(c.req.raw, {
				prefix,
				context: {
					...context,
					[REQUEST_TIMING]: invocationTiming
				} as InferRouterInitialContext<R>
			})
			if (!matched || !response) return next()
			const timed = serverTiming
				? formatServerTiming(performance.now() - started, {
						...timing,
						handler_ms: invocationTiming.procedureMs
					})
				: undefined
			const responseHeaders = finishOrpcHeaders(response, timed)
			let body = response.body
			if (body && compress && shouldCompress(c.req.raw, response)) {
				body = gzipFlushingEachChunk(body)
				responseHeaders.set('content-encoding', 'gzip')
				responseHeaders.delete('content-length')
				responseHeaders.append('vary', 'accept-encoding')
			}
			return c.newResponse(body, {
				// oRPC only produces valid HTTP status codes.
				status: response.status as StatusCode,
				headers: responseHeaders
			})
		})
	}

	if (options.rpcPrefix) {
		const plugins: Plugin<InferRouterInitialContext<R>>[] = [
			...(options.plugins ?? [])
		]
		if (batch) {
			plugins.push(
				new BatchHandlerPlugin({
					maxSize: batch === true ? 25 : batch.maxSize
				})
			)
		}
		mount(
			options.rpcPrefix,
			new RPCHandler(router, {
				...keepAlive,
				plugins,
				interceptors: options.onError ? [orpcOnError(report)] : []
			})
		)
	}

	if (options.openapi) {
		const { openapi } = options
		if (typeof openapi.filter !== 'function')
			throw new TypeError(
				'orpc-fn: mountOrpc openapi needs a filter; pass () => true to publish every route'
			)
		let loading: Promise<Handler<InferRouterInitialContext<R>>> | undefined
		mount(openapi.prefix, {
			handle: async (request, handleOptions) => {
				loading ??= createOpenApiHandler(
					router,
					openapi,
					keepAlive,
					options.onError ? report : undefined
				)
				return (await loading).handle(request, handleOptions)
			}
		})
	}
}

/** Loads the OpenAPI peers only for apps that mount it. */
async function createOpenApiHandler<R extends AnyRouter>(
	router: R,
	openapi: OpenApiMountOptions<R>,
	keepAlive: object,
	report:
		| ((
				error: unknown,
				options: { request: { url: URL; method: string } }
		  ) => void)
		| undefined
): Promise<Handler<InferRouterInitialContext<R>>> {
	const [
		{ SmartCoercionPlugin },
		{ OpenAPIHandler },
		{ OpenAPIReferencePlugin },
		{ ZodToJsonSchemaConverter }
	] = await Promise.all([
		import('@orpc/json-schema'),
		import('@orpc/openapi/fetch'),
		import('@orpc/openapi/plugins'),
		import('@orpc/zod/zod4')
	])
	const converters = [new ZodToJsonSchemaConverter()]
	const plugins: Plugin<InferRouterInitialContext<R>>[] = [
		...(openapi.plugins ?? [])
	]
	if (openapi.smartCoercion) {
		plugins.push(new SmartCoercionPlugin({ schemaConverters: converters }))
	}
	if (openapi.docs !== false) {
		plugins.push(
			new OpenAPIReferencePlugin({
				docsProvider: 'scalar',
				...(openapi.docsPath ? { docsPath: openapi.docsPath } : {}),
				schemaConverters: converters,
				specGenerateOptions: {
					info: openapi.info ?? { title: 'API', version: '0.0.0' },
					servers: [{ url: openapi.prefix }],
					filter: openapi.filter,
					...openapi.spec
				}
			})
		)
	}
	return new OpenAPIHandler(router, {
		...keepAlive,
		filter: openapi.filter,
		plugins,
		interceptors: report ? [orpcOnError(report)] : []
	})
}
