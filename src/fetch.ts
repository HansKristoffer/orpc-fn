import type { AnyRouter } from '@orpc/server'
import { createFetchCore } from './http/fetch.js'
import {
	type BaseContext,
	type ContextFactory,
	formatServerTiming,
	type MaxBodySize,
	type MountOptions,
	type MountTarget,
	markArrival,
	msSinceArrival,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
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
	type MaxBodySize,
	not,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
	type ProcedureFilter,
	type RequestTiming,
	timed
}

/** Builds the router's context from the `Request`; return a `Response` (e.g. 401) to answer instead. */
export type FetchContextFactory<R extends AnyRouter> = ContextFactory<
	Request,
	R
>

export type FetchHandlerOptions<R extends AnyRouter> = MountOptions<
	R,
	Request,
	Request
> &
	MountTarget<R>

/** A Web handler: Next.js App Router, TanStack Start, Bun, Deno, Workers. */
export type FetchHandler = (request: Request) => Promise<Response>

/**
 * Marks a request at the server's front door (`Bun.serve({ fetch })`), before
 * routing and middleware. The handler reports the time until the procedure
 * runs as `queue_ms`: in-process queueing no handler timer can see.
 */
export const markRequestArrival: (request: Request) => void = markArrival

/** Milliseconds since {@link markRequestArrival}, or undefined when unmarked. */
export const msSinceRequestArrival: (request: Request) => number | undefined =
	msSinceArrival

/**
 * oRPC's RPC and OpenAPI handlers as one Web `Request -> Response` function,
 * with batching, `resHeaders`, Server-Timing, compression and error reporting.
 * Requests outside `rpcPrefix` and `openapi.prefix`, or matching no
 * procedure, get a 404.
 *
 * ```ts
 * // app/api/rpc/[[...rest]]/route.ts
 * const handler = createFetchHandler({ router, rpcPrefix: '/api/rpc' })
 * export { handler as GET, handler as POST }
 * ```
 */
export function createFetchHandler<R extends AnyRouter>(
	options: FetchHandlerOptions<R>
): FetchHandler {
	if (!options.rpcPrefix && !options.openapi)
		throw new TypeError(
			'orpc-fn: createFetchHandler needs rpcPrefix or openapi'
		)
	const core = createFetchCore(options)
	return async (request) =>
		(await core.handle(request, request)) ??
		new Response('Not Found', { status: 404 })
}
