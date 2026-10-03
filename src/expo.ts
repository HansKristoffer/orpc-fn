import type { ClientContext } from '@orpc/client'
import type { RPCLink } from '@orpc/client/fetch'
import { type CreateRpcLinkOptions, createRpcLink } from './client.js'

/** What `fetch` from `expo/fetch` accepts from this bridge. */
export type ExpoFetchInit = {
	method: string
	headers: Record<string, string>
	body?: ArrayBuffer
	signal: AbortSignal
	credentials: 'omit'
	redirect?: NonNullable<RequestInit['redirect']>
}

/** The response members oRPC reads; `expo/fetch`'s `FetchResponse` has them. */
export type ExpoResponse = Pick<
	Response,
	'status' | 'headers' | 'body' | 'text' | 'blob' | 'formData'
>

/** `fetch` from `expo/fetch` (the only fetch that streams on native). */
export type ExpoFetch = (
	url: string,
	init: ExpoFetchInit
) => Promise<ExpoResponse>

/**
 * oRPC's link `fetch` for React Native, built on `expo/fetch`.
 *
 * oRPC carries the input and the abort signal on the `Request`, not in
 * `init`, and the call is rebuilt for `expo/fetch`, so both are forwarded
 * explicitly: the body so the server receives the input, and the signal so a
 * cancelled subscription closes its socket. Without the signal, connections
 * leak and exhaust the device's HTTP pool after a few navigations, and every
 * later request hangs.
 *
 * Native sends cookies by header (see `createExpoLink`), so it omits the
 * credentialed cookie jar. On web it uses the platform `fetch` with cookies.
 */
export function createExpoFetch(options: {
	fetch: ExpoFetch
	/** `Platform.OS !== 'web'`. */
	native: boolean
	webFetch?: (request: Request, init?: RequestInit) => Promise<Response>
}) {
	return async (
		request: Request,
		init?: { redirect?: NonNullable<RequestInit['redirect']> }
	): Promise<Response> => {
		if (!options.native) {
			return (options.webFetch ?? globalThis.fetch)(request, {
				...init,
				credentials: 'include'
			})
		}
		const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
		const body = hasBody ? await request.arrayBuffer() : undefined
		const response = await options.fetch(request.url, {
			method: request.method,
			headers: Object.fromEntries(request.headers.entries()),
			...init,
			...(body === undefined ? {} : { body }),
			signal: request.signal,
			credentials: 'omit'
		})
		// Not rebuilt with `new Response(...)`: React Native's Response polyfill
		// cannot stream a body. oRPC reads only the `ExpoResponse` members.
		return response as Response
	}
}

export type CreateExpoLinkOptions<T extends ClientContext> = Omit<
	CreateRpcLinkOptions<T>,
	'fetch'
> & {
	fetch: ExpoFetch
	native: boolean
	/** Explicit browser fetch override; native always uses expo/fetch. */
	webFetch?: (request: Request, init?: RequestInit) => Promise<Response>
}

/** Generic streaming bridge with upstream async/context-aware headers. */
export function createExpoLink<T extends ClientContext = ClientContext>(
	options: CreateExpoLinkOptions<T>
): RPCLink<T> {
	const { fetch, native, webFetch, ...rest } = options
	return createRpcLink<T>({
		...rest,
		fetch: createExpoFetch({ fetch, native, ...(webFetch ? { webFetch } : {}) })
	})
}

export type CreateBetterAuthExpoLinkOptions<T extends ClientContext> =
	CreateExpoLinkOptions<T> & {
		getCookie?: () =>
			| string
			| null
			| undefined
			| Promise<string | null | undefined>
		getExpoOrigin?: () =>
			| string
			| null
			| undefined
			| Promise<string | null | undefined>
	}

/** Better Auth's native cookie/origin headers, kept behind an explicit preset. */
export function createBetterAuthExpoLink<
	T extends ClientContext = ClientContext
>(options: CreateBetterAuthExpoLinkOptions<T>): RPCLink<T> {
	const { getCookie, getExpoOrigin, headers: extraHeaders, ...rest } = options
	return createExpoLink<T>({
		...rest,
		headers: async (...args) => {
			const supplied =
				typeof extraHeaders === 'function'
					? await extraHeaders(...args)
					: await extraHeaders
			const headers = new Headers(
				supplied as ConstructorParameters<typeof Headers>[0]
			)
			const cookie = await getCookie?.()
			if (cookie) headers.set('Cookie', cookie)
			if (options.native) {
				headers.set('x-skip-oauth-proxy', 'true')
				const origin = await getExpoOrigin?.()
				if (origin) headers.set('expo-origin', origin)
			}
			return headers
		}
	})
}
