// Shared by orpc-fn/fetch, orpc-fn/node and orpc-fn/hono: the options, the
// per-request context and the oRPC handler wiring. Each adapter only adds its
// runtime's handler classes and response compression.
import type {
	OpenAPIDocument,
	OpenAPIGeneratorGenerateOptions,
	OpenAPIVersion
} from '@orpc/openapi'
import {
	type AnyORPCError,
	type AnyRouter,
	type Context,
	COMMON_ERROR_STATUS_MAP,
	type InferRouterInitialContext,
	onError as orpcOnError
} from '@orpc/server'
import {
	BatchHandlerPlugin,
	ResponseHeadersHandlerPlugin,
	SignalSyncHandlerPlugin
} from '@orpc/server/plugins'
import type {
	StandardHandlerHandleResult,
	StandardHandlerOptions,
	StandardHandlerPlugin,
	StandardHandlerRoutingInterceptorOptions
} from '@orpc/server/standard'
import {
	errorStatusOf,
	isExpectedWithStatusMap
} from '../expected-client-error.js'
import { allOf, type ProcedureFilter } from '../meta.js'
import type { OpenApiComponents } from '../openapi.js'
import { type InvocationTiming, REQUEST_TIMING } from '../timing.js'

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
 * Builds the router's initial context from the runtime's request. Return a
 * `Response` to answer (e.g. 401) instead.
 */
export type ContextFactory<Arg, R extends AnyRouter> = (
	request: Arg,
	base: BaseContext
) =>
	| InferRouterInitialContext<R>
	| Response
	| Promise<InferRouterInitialContext<R> | Response>

/** `context` is optional only when the base context already satisfies the router. */
export type ContextOption<Arg, R extends AnyRouter> =
	BaseContext extends InferRouterInitialContext<R>
		? { context?: ContextFactory<Arg, R> }
		: { context: ContextFactory<Arg, R> }

export type Path = `/${string}`
type Plugin<T extends Context> = StandardHandlerPlugin<T>
type RoutingInterceptorOptions<T extends Context> =
	StandardHandlerRoutingInterceptorOptions<T> & {
		next(): Promise<StandardHandlerHandleResult>
	}

type OpenApiInfo = { title: string; version: string; description?: string }

/** What a docs page shows. On a surface, the defaults for its pages. */
type OpenApiPageFields = {
	/** The document's `info`, also the docs page's title. */
	info?: OpenApiInfo
	/**
	 * Spec generator options, e.g. `version: '3.1.1'`. Document fields go in
	 * `base`: `{ base: { components: { securitySchemes }, security } }`. A
	 * page's keys replace the surface's.
	 */
	spec?: Omit<OpenAPIGeneratorGenerateOptions<OpenAPIVersion>, 'filter'>
	/**
	 * Named `components.schemas`, listed even when no route refers to them
	 * (see `generateOpenApiDocument` in `orpc-fn/openapi`).
	 */
	components?: OpenApiComponents
	/**
	 * Serve this document instead of generating one, e.g. one the app
	 * finishes itself: `() => generateOpenApiDocument(router, { ... })`.
	 * Called once, on the first request for the docs or the spec, and again
	 * after a failure.
	 */
	document?: () => AnyOpenApiDocument | Promise<AnyOpenApiDocument>
}

type AnyOpenApiDocument = OpenAPIDocument<OpenAPIVersion>

/** One API reference page of an OpenAPI surface, with its own spec. */
export type OpenApiDocsPage = OpenApiPageFields & {
	/** The page, relative to the surface's `prefix` (default '/'). */
	path?: Path
	/** Its spec JSON, relative to `prefix` (default '/spec.json'). */
	specPath?: Path
	/**
	 * The routes it lists, within the surface's `filter` (default: all the
	 * surface serves), e.g. `hasTag('customer-api')`.
	 */
	filter?: ProcedureFilter
}

/** One OpenAPI (REST) handler under `prefix`, with its docs pages. */
export type OpenApiMountOptions<R extends AnyRouter> = OpenApiPageFields & {
	prefix: Path
	/** The docs page, relative to `prefix` (default '/'); the spec is at `/spec.json`. */
	docsPath?: Path
	/**
	 * false: serve the REST routes without docs. An array: several pages,
	 * each with its own path, filter and spec; the surface's `info`,
	 * `spec`, `components` and `document` are their defaults:
	 * `[{ path: '/customer', specPath: '/customer/spec.json', filter: hasTag('customer') }, {}]`.
	 */
	docs?: boolean | readonly OpenApiDocsPage[]
	/**
	 * The procedures to publish (also filters the spec), e.g.
	 * `hasTag('external')`. Required, so publishing is a choice;
	 * `() => true` publishes every route.
	 */
	filter: ProcedureFilter
	/** Turn JSON strings back into `Date`s etc. for `z.date()` inputs. */
	smartCoercion?: boolean
	/**
	 * The body of an error response, in place of oRPC's `{ defined, code,
	 * message, data }`; `status` is what the response answers with, under
	 * `errorStatusMap`. Document it with `spec.errorResponseBodySchema`:
	 * `(error, status) => ({ ...error.toJSON(), status })`.
	 */
	errorResponseBodyEncoder?: (error: AnyORPCError, status: number) => unknown
	plugins?: Plugin<InferRouterInitialContext<R>>[]
}

/** How the oRPC handlers are built, the same in every runtime. */
export type HandlerConfig<R extends AnyRouter> = {
	router: R
	/** Serve the RPC handler (oRPC's `RPCLink`) here. Omit to skip it. */
	rpcPrefix?: Path
	/**
	 * Serve the OpenAPI (REST) handler and its Scalar docs here; an array
	 * serves several surfaces, each with its own prefix and filter. Needs
	 * the optional peers `@orpc/openapi`, `@orpc/json-schema` and
	 * `@orpc/zod`, loaded on the first request to `prefix`.
	 */
	openapi?: OpenApiMountOptions<R> | readonly OpenApiMountOptions<R>[]
	/** Collapse parallel RPC calls into one HTTP request. Default: true (25 calls). */
	batch?: boolean | { maxSize: number }
	/** Add a Server-Timing header from the request timing. Default: true */
	serverTiming?: boolean
	/**
	 * Compress JSON responses and batch event streams (brotli or gzip, as the
	 * client accepts), flushing after every batch result. Other event streams
	 * are left alone. Default: true
	 */
	compress?: boolean
	/** SSE keep-alive comments every N ms (default 15000), or false. */
	sseKeepAlive?: boolean | number
	/**
	 * Extra RPC handler plugins. CORS is set up once: Hono's `cors()` on a
	 * Hono app, oRPC's `CORSHandlerPlugin` here otherwise. A cross-origin
	 * client with batching needs `orpc-batch` in its allowed headers.
	 */
	plugins?: Plugin<InferRouterInitialContext<R>>[]
	/**
	 * Unexpected procedure errors (oRPC turns thrown errors into responses, so
	 * the framework's error handler never sees them). Expected client errors
	 * are skipped.
	 */
	onError?: (error: unknown, request: { url: string; method: string }) => void
	/**
	 * HTTP status per error code, over oRPC's common map:
	 * `{ RATE_LIMITED: 429 }`. oRPC 2 errors carry no status, and codes it
	 * does not know answer 400. A code mapped to 5xx reaches `onError`.
	 */
	errorStatusMap?: Record<string, number>
	/**
	 * Default: `isExpectedClientError` under `errorStatusMap`, which also
	 * accepts any error the route's `createFn({ isExpectedError })` classified
	 * as expected.
	 */
	isExpectedError?: (error: unknown) => boolean
}

/**
 * Options every mount adapter shares. `Arg` is what the context factory gets
 * (a Hono context, a `Request`, an `IncomingMessage`), `Req` what `queueMs` gets.
 */
export type MountOptions<R extends AnyRouter, Arg, Req> = ContextOption<
	Arg,
	R
> &
	HandlerConfig<R> & {
		/** Rewrite request headers before they reach the context (see `normalizeExpoOrigin`). */
		normalizeHeaders?: (headers: Headers) => Headers
		/**
		 * Time spent before the handler ran, reported as `queue`. Default: time
		 * since `markRequestArrival`, when the server marked the request.
		 */
		queueMs?: (request: Req) => number | undefined
	}

/** Where a standalone handler serves: RPC, OpenAPI or both, at least one. */
export type MountTarget<R extends AnyRouter> =
	| { rpcPrefix: Path; openapi?: HandlerConfig<R>['openapi'] }
	| {
			rpcPrefix?: Path
			openapi: NonNullable<HandlerConfig<R>['openapi']>
	  }

const arrivals = new WeakMap<object, number>()

/** @internal Shared implementation of each adapter's `markRequestArrival`. */
export function markArrival(request: object): void {
	arrivals.set(request, performance.now())
}

/** @internal Shared implementation of each adapter's `msSinceRequestArrival`. */
export function msSinceArrival(request: object): number | undefined {
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

/** Whether `path` is `prefix` or below it, as oRPC's handlers match. */
export function matchesPrefix(path: string, prefix: Path): boolean {
	const base = prefix.replace(/\/+$/, '')
	return base === '' || path === base || path.startsWith(`${base}/`)
}

const MOUNT_REQUEST = Symbol('orpc-fn.mountRequest')
type MountRequest = { started: number; timing: RequestTiming }

/**
 * Builds the context for one request: the base context, the app's factory
 * and the timing state Server-Timing reads. A `Response` means the factory
 * answered the request itself.
 */
export async function createRequestContext<R extends AnyRouter, Arg>(
	options: Pick<MountOptions<R, Arg, never>, 'context' | 'normalizeHeaders'>,
	request: Arg,
	rawHeaders: Headers,
	queueMs: number | undefined
): Promise<InferRouterInitialContext<R> | Response> {
	const timing: RequestTiming = {}
	if (queueMs !== undefined) timing.queue_ms = Math.round(queueMs * 100) / 100
	const started = performance.now()

	const headers = options.normalizeHeaders
		? options.normalizeHeaders(rawHeaders)
		: rawHeaders
	const context = options.context
		? await options.context(request, { headers, timing })
		: { headers, timing }
	if (context instanceof Response) return context

	const invocation: InvocationTiming = { procedureMs: 0, calls: 0 }
	const mountRequest: MountRequest = { started, timing }
	// The symbols ride along with the app's context; oRPC passes them through.
	return {
		...context,
		[REQUEST_TIMING]: invocation,
		[MOUNT_REQUEST]: mountRequest
	} as InferRouterInitialContext<R>
}

/** The bodies oRPC sends as `text/event-stream`; a `ReadableStream` goes out as raw bytes. */
function isEventIterator(body: unknown): boolean {
	return (
		typeof body === 'object' &&
		body !== null &&
		!(body instanceof ReadableStream) &&
		typeof (body as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] === 'function'
	)
}

function exposeHeader(
	existing: string | string[] | undefined,
	name: string
): string {
	if (existing === undefined) return name
	const flat = Array.isArray(existing) ? existing.join(', ') : existing
	if (!flat.trim()) return name
	const parts = flat.split(',').map((part) => part.trim().toLowerCase())
	if (parts.includes('*') || parts.includes(name.toLowerCase())) return flat
	return `${flat}, ${name}`
}

/**
 * Adds Server-Timing to the final response, and for SSE disables proxy
 * buffering so keep-alive comments reach the edge (empty `:` lines are
 * otherwise easy for nginx/Fastly to hold until an idle kill). It works on
 * oRPC's standard response, before any runtime writes it.
 */
function mountPlugin<T extends Context>(serverTiming: boolean): Plugin<T> {
	return {
		name: 'orpc-fn:mount',
		// Initialized last, so its interceptor wraps every other plugin's
		// (each prepends its own), CORS and batching included.
		after: ['~cors', '~batch', '~response-headers', '~tracing'],
		init(options) {
			const routing = async (
				interceptor: RoutingInterceptorOptions<T>
			): Promise<StandardHandlerHandleResult> => {
				const result = await interceptor.next()
				if (!result.matched) return result

				const { response } = result
				const headers = { ...response.headers }
				const context = interceptor.context as Record<symbol, unknown>
				const request = context[MOUNT_REQUEST] as MountRequest | undefined
				if (serverTiming && request) {
					const invocation = context[REQUEST_TIMING] as
						| InvocationTiming
						| undefined
					headers['server-timing'] = formatServerTiming(
						performance.now() - request.started,
						{ ...request.timing, handler_ms: invocation?.procedureMs }
					)
					headers['access-control-expose-headers'] = exposeHeader(
						headers['access-control-expose-headers'],
						'Server-Timing'
					)
				}
				if (isEventIterator(response.body)) {
					headers['cache-control'] = 'no-cache'
					headers['x-accel-buffering'] = 'no'
				}

				return { matched: true, response: { ...response, headers } }
			}
			return {
				...options,
				routingInterceptors: [routing, ...(options.routingInterceptors ?? [])]
			}
		}
	}
}

/** What the handlers of both runtimes take; each adapter adds its own options. */
export type HandlerOptions<T extends Context> = {
	plugins: Plugin<T>[]
	interceptors: NonNullable<StandardHandlerOptions<T>['interceptors']>
	/** Event stream options; each runtime passes them to its response writer. */
	eventStream: { keepAlive: boolean | { interval: number } }
	errorStatusMap?: Record<string, number>
	/** OpenAPI only: the error body (oRPC's handler option). */
	errorResponseBodyEncoder?: (error: AnyORPCError) => unknown
}

/** A runtime's oRPC handler classes, as factories. */
export type HandlerRuntime<R extends AnyRouter, H> = {
	rpc: (router: R, options: HandlerOptions<InferRouterInitialContext<R>>) => H
	/** Loads `@orpc/openapi/<runtime>` on the first OpenAPI request. */
	openapi: () => Promise<
		(
			router: R,
			options: HandlerOptions<InferRouterInitialContext<R>> & {
				filter: ProcedureFilter
			}
		) => H
	>
}

export type Mount<H> = { prefix: Path; handler: () => H | Promise<H> }

/**
 * Validates the options and builds the RPC and OpenAPI handlers (the latter
 * lazily, so an RPC-only app does not install its peers).
 */
export function createMounts<R extends AnyRouter, H>(
	options: HandlerConfig<R>,
	runtime: HandlerRuntime<R, H>
): Mount<H>[] {
	const {
		router,
		batch = true,
		serverTiming = true,
		sseKeepAlive = true
	} = options
	type T = InferRouterInitialContext<R>

	if (
		typeof sseKeepAlive === 'number' &&
		(!Number.isFinite(sseKeepAlive) || sseKeepAlive <= 0)
	)
		throw new RangeError(
			'orpc-fn: sseKeepAlive must be a positive finite number'
		)
	const surfaces = options.openapi === undefined ? [] : [options.openapi].flat()
	const prefixes = new Set<string>()
	for (const surface of surfaces) {
		if (typeof surface.filter !== 'function')
			throw new TypeError(
				'orpc-fn: openapi needs a filter; pass () => true to publish every route'
			)
		const prefix = surface.prefix.replace(/\/+$/, '')
		if (prefixes.has(prefix))
			throw new TypeError(
				`orpc-fn: two openapi surfaces share the prefix ${surface.prefix}`
			)
		prefixes.add(prefix)
		docsPages(surface)
	}

	const statusMap = options.errorStatusMap
	const isExpectedError =
		options.isExpectedError ??
		((error: unknown) => isExpectedWithStatusMap(error, statusMap))
	const report = (
		error: unknown,
		{ request }: { request: { url: string; method: string } }
	) => {
		try {
			if (isExpectedError(error)) return
			options.onError?.(error, {
				url: new URL(request.url, 'http://localhost').pathname,
				method: request.method
			})
		} catch {
			/* Error reporting cannot replace transport outcomes. */
		}
	}

	// A fresh object per handler: oRPC's handlers add to the arrays they get.
	const handlerOptions = (extra: Plugin<T>[] = []): HandlerOptions<T> => {
		const plugins: Plugin<T>[] = [...extra, mountPlugin<T>(serverTiming)]
		if (!extra.some((plugin) => plugin.name === '~response-headers'))
			plugins.push(new ResponseHeadersHandlerPlugin<T>())
		if (!extra.some((plugin) => plugin.name === '~signal-sync'))
			plugins.push(new SignalSyncHandlerPlugin<T>())
		return {
			plugins,
			interceptors: options.onError ? [orpcOnError(report)] : [],
			// oRPC replaces its common map with a given one, so it is merged in.
			...(statusMap
				? { errorStatusMap: { ...COMMON_ERROR_STATUS_MAP, ...statusMap } }
				: {}),
			// Keep-alive under proxy idle timers (~30s); oRPC 2's default is 15s too.
			eventStream: {
				keepAlive:
					sseKeepAlive === false
						? false
						: { interval: sseKeepAlive === true ? 15_000 : sseKeepAlive }
			}
		}
	}

	const mounts: Mount<H>[] = []
	if (options.rpcPrefix) {
		const extra: Plugin<T>[] = [...(options.plugins ?? [])]
		if (batch)
			extra.push(
				new BatchHandlerPlugin<T>({
					maxSize: batch === true ? 25 : batch.maxSize
				})
			)
		const handler = runtime.rpc(router, handlerOptions(extra))
		mounts.push({ prefix: options.rpcPrefix, handler: () => handler })
	}

	for (const openapi of surfaces) {
		let loading: Promise<H> | undefined
		mounts.push({
			prefix: openapi.prefix,
			handler: () => {
				loading ??= createOpenApiHandler(
					router,
					openapi,
					handlerOptions(openapi.plugins),
					runtime.openapi
				).catch((error) => {
					// A missing peer fails this request; the next one tries again.
					loading = undefined
					throw error
				})
				return loading
			}
		})
	}

	return mounts
}

type ResolvedPage = Omit<OpenApiDocsPage, 'filter'> & {
	path: Path
	specPath: Path
	filter: ProcedureFilter
}

/**
 * A surface's docs pages, with the surface's fields as their defaults.
 * Throws when two pages share a path, so it runs when the app mounts.
 */
function docsPages<R extends AnyRouter>(
	surface: OpenApiMountOptions<R>
): ResolvedPage[] {
	const { docs = true } = surface
	const pages = docs === false ? [] : docs === true ? [{}] : docs
	const seen = new Set<string>()
	return pages.map((page: OpenApiDocsPage) => {
		const resolved: ResolvedPage = {
			path: page.path ?? surface.docsPath ?? '/',
			specPath: page.specPath ?? '/spec.json',
			filter: page.filter ? allOf(surface.filter, page.filter) : surface.filter
		}
		const info = page.info ?? surface.info
		if (info) resolved.info = info
		if (surface.spec || page.spec)
			resolved.spec = { ...surface.spec, ...page.spec }
		const components = page.components ?? surface.components
		if (components) resolved.components = components
		const document = page.document ?? surface.document
		if (document) resolved.document = document
		for (const path of [resolved.path, resolved.specPath]) {
			if (seen.has(path))
				throw new TypeError(
					`orpc-fn: two openapi docs pages under ${surface.prefix} use ${path}; give each its own path and specPath`
				)
			seen.add(path)
		}
		return resolved
	})
}

/** Loads the OpenAPI peers only for apps that mount it. */
async function createOpenApiHandler<R extends AnyRouter, H>(
	router: R,
	openapi: OpenApiMountOptions<R>,
	options: HandlerOptions<InferRouterInitialContext<R>>,
	loadHandler: HandlerRuntime<R, H>['openapi']
): Promise<H> {
	const [
		{ SmartCoercionHandlerPlugin },
		{ OpenAPIReferenceHandlerPlugin },
		{ ZodToJsonSchemaConverter },
		{ generateOpenApiDocument },
		createHandler
	] = await Promise.all([
		import('@orpc/json-schema'),
		import('@orpc/openapi/plugins'),
		import('@orpc/zod'),
		import('../openapi.js'),
		loadHandler()
	])
	if (openapi.smartCoercion) {
		options.plugins.push(
			new SmartCoercionHandlerPlugin({
				converters: [new ZodToJsonSchemaConverter()]
			})
		)
	}
	for (const page of docsPages(openapi)) {
		const { base, errorStatusMap, ...generate } = page.spec ?? {}
		const resolvedErrorStatusMap = errorStatusMap ?? options.errorStatusMap
		const { document } = page
		const load = (): Promise<AnyOpenApiDocument> =>
			document
				? Promise.resolve().then(document)
				: generateOpenApiDocument(router, {
						...generate,
						...(resolvedErrorStatusMap
							? { errorStatusMap: resolvedErrorStatusMap }
							: {}),
						...(page.components ? { components: page.components } : {}),
						filter: page.filter,
						base: {
							info: page.info ?? { title: 'API', version: '0.0.0' },
							servers: [{ url: openapi.prefix }],
							...base
						}
					})
		let spec: Promise<AnyOpenApiDocument> | undefined
		options.plugins.push(
			new OpenAPIReferenceHandlerPlugin({
				provider: 'scalar',
				docsPath: page.path,
				specPath: page.specPath,
				// Generated once, on the first request for the docs or the spec.
				spec: () => {
					spec ??= load().catch((error) => {
						spec = undefined
						throw error
					})
					return spec
				}
			})
		)
	}
	const encode = openapi.errorResponseBodyEncoder
	return createHandler(router, {
		...options,
		...(encode
			? {
					errorResponseBodyEncoder: (error: AnyORPCError) =>
						encode(error, errorStatusOf(error, options.errorStatusMap))
				}
			: {}),
		filter: (procedure, path) => openapi.filter(procedure, path)
	})
}
