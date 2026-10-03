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

/** `fetch` from `expo/fetch` (the only fetch that streams on native). */
export type ExpoFetch = (url: string, init: ExpoFetchInit) => Promise<unknown>

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
}) {
	return async (
		request: Request,
		init?: { redirect?: NonNullable<RequestInit['redirect']> }
	): Promise<Response> => {
		if (!options.native) {
			return globalThis.fetch(request, { ...init, credentials: 'include' })
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
		// expo/fetch's response lacks a few DOM fields; oRPC only reads the body
		// stream, status and headers, which it has.
		return response as Response
	}
}

export type CreateExpoLinkOptions<T extends ClientContext> = Omit<
	CreateRpcLinkOptions<T>,
	'fetch' | 'headers'
> & {
	fetch: ExpoFetch
	native: boolean
	/** Session cookie, e.g. Better Auth's `authClient.getCookie()`. */
	getCookie?: () => string | null | undefined
	/** `expo-origin` header; the server copies it to `origin` (`normalizeExpoOrigin`). */
	getExpoOrigin?: () => string | null | undefined
	/** Extra headers on every request. */
	headers?: () => Record<string, string>
}

/**
 * `createRpcLink` for Expo: batching, the `expo/fetch` bridge and the headers
 * a Better Auth Expo client sends, so the API sees the same session and
 * origin as `/api/auth` requests.
 *
 * ```ts
 * import { fetch } from 'expo/fetch'
 * import { Platform } from 'react-native'
 *
 * const link = createExpoLink({
 *   url: `${baseUrl}/api/rpc`,
 *   fetch,
 *   native: Platform.OS !== 'web',
 *   getCookie: () => authClient.getCookie(),
 *   getExpoOrigin
 * })
 * ```
 */
export function createExpoLink<T extends ClientContext = ClientContext>(
	options: CreateExpoLinkOptions<T>
): RPCLink<T> {
	const {
		fetch,
		native,
		getCookie,
		getExpoOrigin,
		headers: extraHeaders,
		...rest
	} = options
	return createRpcLink<T>({
		...rest,
		fetch: createExpoFetch({ fetch, native }),
		headers: () => {
			const headers: Record<string, string> = { ...extraHeaders?.() }
			const cookie = getCookie?.()
			if (cookie) headers.Cookie = cookie
			if (native) {
				// What @better-auth/expo sends from native, for session and CORS parity.
				headers['x-skip-oauth-proxy'] = 'true'
				const origin = getExpoOrigin?.()
				if (origin) headers['expo-origin'] = origin
			}
			return headers
		}
	})
}
