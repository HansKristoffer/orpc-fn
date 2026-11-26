import type { ClientContext } from '@orpc/client'
import type { RPCLink } from '@orpc/client/fetch'
import { type CreateRpcLinkOptions, createRpcLink } from './client.js'
import {
	EXPO_ORIGIN_HEADER,
	SKIP_OAUTH_PROXY_HEADER
} from './request-headers.js'

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

/** The link's own `fetch` signature (oRPC 2 passes a URL string and init). */
export type LinkFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * oRPC's link `fetch` for React Native, built on `expo/fetch`.
 *
 * The call is rebuilt for `expo/fetch`, so the body and the abort signal are
 * forwarded explicitly: the body (as bytes, which `expo/fetch` sends) so the
 * server receives the input, and the signal so a cancelled subscription
 * closes its socket. Without the signal, connections leak and exhaust the
 * device's HTTP pool after a few navigations, and every later request hangs.
 *
 * Native sends cookies by header (see `createExpoLink`), so it omits the
 * credentialed cookie jar. On web it uses the platform `fetch` with cookies.
 */
export function createExpoFetch(options: {
	fetch: ExpoFetch
	/** `Platform.OS !== 'web'`. */
	native: boolean
	webFetch?: LinkFetch
}): LinkFetch {
	return async (url, init) => {
		if (!options.native) {
			return (options.webFetch ?? globalThis.fetch)(url, {
				...init,
				credentials: 'include'
			})
		}
		// A Request encodes the body (and a form's content type) as fetch would.
		const request = new Request(url, init)
		const body =
			init.body === undefined || init.body === null
				? undefined
				: await request.arrayBuffer()
		const response = await options.fetch(url, {
			method: request.method,
			headers: Object.fromEntries(request.headers.entries()),
			...(init.redirect ? { redirect: init.redirect } : {}),
			...(body === undefined ? {} : { body }),
			signal: init.signal ?? request.signal,
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
	webFetch?: LinkFetch
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
			if (options.native) {
				const cookie = await getCookie?.()
				if (cookie) headers.set('Cookie', cookie)
				headers.set(SKIP_OAUTH_PROXY_HEADER, 'true')
				const origin = await getExpoOrigin?.()
				if (origin) headers.set(EXPO_ORIGIN_HEADER, origin)
			}
			return headers
		}
	})
}
