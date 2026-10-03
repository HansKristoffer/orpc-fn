import { SmartCoercionPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import {
	type AnyRouter,
	type InferRouterInitialContext,
	onError as orpcOnError
} from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { BatchHandlerPlugin } from '@orpc/server/plugins'
import type { StandardHandlerPlugin } from '@orpc/server/standard'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { Context as HonoContext, Env, Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import { isExpectedClientError } from './expected-client-error.js'
import type { ProcedureFilter } from './mcp.js'

/** Per-request timings in ms; `fn()` adds `handler_ms`. Sent as Server-Timing. */
export type RequestTiming = Record<string, number>

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
// biome-ignore lint/suspicious/noExplicitAny: plugins are context-agnostic here
type Plugin = StandardHandlerPlugin<any>

export type MountOrpcOptions<
	E extends Env,
	R extends AnyRouter
> = ContextOption<E, R> & {
	router: R
	/** Mount the RPC handler (oRPC's `RPCLink`) here. Omit to skip it. */
	rpcPrefix?: Path
	/** Mount the OpenAPI (REST) handler and its Scalar docs here. */
	openapi?: {
		prefix: Path
		info?: { title: string; version: string; description?: string }
		/** Docs page, relative to `prefix` (default '/'); the spec is at `/spec.json`. */
		docsPath?: Path
		/** Only expose matching procedures (also filters the spec). */
		filter?: ProcedureFilter
		/** Turn JSON strings back into `Date`s etc. for `z.date()` inputs. */
		smartCoercion?: boolean
		/** Extra spec fields, e.g. `components.securitySchemes` and `security`. */
		spec?: Record<string, unknown>
		plugins?: Plugin[]
	}
	/** Collapse parallel RPC calls into one HTTP request. Default: true (25 calls). */
	batch?: boolean | { maxSize: number }
	/** Add a Server-Timing header from the request timing. Default: true */
	serverTiming?: boolean
	/** SSE keep-alive comments every N ms (default 15000), or false. */
	sseKeepAlive?: boolean | number
	/** Extra RPC plugins (e.g. `CORSPlugin`). */
	plugins?: Plugin[]
	/** Rewrite request headers before they reach the context (see `normalizeExpoOrigin`). */
	normalizeHeaders?: (headers: Headers) => Headers
	/** Time spent before the handler ran, reported as `queue`. */
	queueMs?: (request: Request) => number | undefined
	/**
	 * Unexpected procedure errors (oRPC turns thrown errors into responses, so
	 * Hono's `onError` never sees them). Expected client errors are skipped.
	 */
	onError?: (error: unknown, request: { url: string; method: string }) => void
	/** Default: 4xx `ORPCError` or `AbortError`. */
	isExpectedError?: (error: unknown) => boolean
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
function finishHeaders(
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

/** Mount oRPC's RPC and OpenAPI handlers on a Hono app. */
export function mountOrpc<E extends Env, R extends AnyRouter>(
	app: Hono<E>,
	options: MountOrpcOptions<E, R>
): void {
	const {
		router,
		batch = true,
		serverTiming = true,
		sseKeepAlive = true
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
		if (isExpectedError(error)) return
		options.onError?.(error, {
			url: request.url.pathname,
			method: request.method
		})
	}

	const mount = (prefix: Path, handler: Pick<RPCHandler<object>, 'handle'>) => {
		app.use(`${prefix}/*`, async (c, next) => {
			const timing: RequestTiming = {}
			const queueMs = options.queueMs?.(c.req.raw)
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
			const { matched, response } = await handler.handle(c.req.raw, {
				prefix,
				context: context as object
			})
			if (!matched) return next()
			const timed = serverTiming
				? formatServerTiming(performance.now() - started, timing)
				: undefined
			return c.newResponse(response.body, {
				// oRPC only produces valid HTTP status codes.
				status: response.status as StatusCode,
				headers: finishHeaders(response, timed)
			})
		})
	}

	if (options.rpcPrefix) {
		const plugins: Plugin[] = [...(options.plugins ?? [])]
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
		const filter = openapi.filter ? { filter: openapi.filter } : {}
		const converters = [new ZodToJsonSchemaConverter()]
		const plugins: Plugin[] = [...(openapi.plugins ?? [])]
		if (openapi.smartCoercion) {
			plugins.push(new SmartCoercionPlugin({ schemaConverters: converters }))
		}
		plugins.push(
			new OpenAPIReferencePlugin({
				docsProvider: 'scalar',
				...(openapi.docsPath ? { docsPath: openapi.docsPath } : {}),
				schemaConverters: converters,
				specGenerateOptions: {
					info: openapi.info ?? { title: 'API', version: '0.0.0' },
					servers: [{ url: openapi.prefix }],
					...filter,
					...openapi.spec
				}
			})
		)
		mount(
			openapi.prefix,
			new OpenAPIHandler(router, {
				...keepAlive,
				...filter,
				plugins,
				interceptors: options.onError ? [orpcOnError(report)] : []
			})
		)
	}
}
