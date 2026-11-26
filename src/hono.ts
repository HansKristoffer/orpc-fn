import type { AnyRouter } from '@orpc/server'
import type { Context as HonoContext, Env, Hono } from 'hono'
import type { StatusCode } from 'hono/utils/http-status'
import { createFetchCore } from './http/fetch.js'
import {
	type BaseContext,
	type ContextFactory as MountContextFactory,
	formatServerTiming,
	type MountOptions,
	markArrival,
	msSinceArrival,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
	type RequestTiming,
	timed
} from './http/mount.js'
import { hasTag, type ProcedureFilter } from './meta.js'

export {
	type BaseContext,
	formatServerTiming,
	hasTag,
	normalizeExpoOrigin,
	type OpenApiMountOptions,
	type ProcedureFilter,
	type RequestTiming,
	timed
}

/**
 * Builds the router's initial context from the request. Return a `Response`
 * to answer (e.g. 401) instead.
 */
export type ContextFactory<
	E extends Env,
	R extends AnyRouter
> = MountContextFactory<HonoContext<E>, R>

export type MountOrpcOptions<E extends Env, R extends AnyRouter> = MountOptions<
	R,
	HonoContext<E>,
	Request
>

/**
 * Marks a request at the server's front door (`Bun.serve({ fetch })`), before
 * routing and middleware. `mountOrpc` reports the time until the procedure
 * runs as `queue_ms`: in-process queueing no handler timer can see.
 */
export const markRequestArrival: (request: Request) => void = markArrival

/** Milliseconds since {@link markRequestArrival}, or undefined when unmarked. */
export const msSinceRequestArrival: (request: Request) => number | undefined =
	msSinceArrival

/**
 * Response headers plus Server-Timing, for composed Fetch adapters. For SSE,
 * also disable proxy buffering. A copy: some responses (e.g. redirects) have
 * immutable headers. `mountOrpc` and `orpc-fn/fetch` already do this.
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

/** Mount oRPC's RPC and OpenAPI handlers on a Hono app. */
export function mountOrpc<E extends Env, R extends AnyRouter>(
	app: Hono<E>,
	options: MountOrpcOptions<E, R>
): void {
	const core = createFetchCore<R, HonoContext<E>>(options)
	for (const prefix of core.prefixes) {
		const route = prefix === '/' ? '/*' : `${prefix.replace(/\/+$/, '')}/*`
		app.use(route, async (c, next) => {
			const response = await core.handle(c.req.raw, c, prefix)
			if (!response) return next()
			// newResponse keeps headers other middleware set with c.header().
			return c.newResponse(response.body, {
				// oRPC only produces valid HTTP status codes.
				status: response.status as StatusCode,
				headers: response.headers
			})
		})
	}
}
