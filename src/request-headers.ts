// Shared by the client links that send these headers and the server adapters
// that export them for CORS, so the list follows what the links send.
import { BATCH_HEADER } from '@orpc/client/plugins'

/** Better Auth's Expo plugin reads the app's origin from it on native. */
export const EXPO_ORIGIN_HEADER = 'expo-origin'
/** Tells Better Auth's OAuth proxy plugin to leave a native request alone. */
export const SKIP_OAUTH_PROXY_HEADER = 'x-skip-oauth-proxy'

/**
 * The request headers orpc-fn's links send beyond the CORS-safelisted ones:
 * spread it into a CORS allow-list (`allowHeaders` of Hono's `cors()`, or
 * oRPC's `CORSHandlerPlugin`), so the list follows orpc-fn when a link adds
 * a header. Add your own (e.g. `authorization`) beside it.
 */
export const CLIENT_REQUEST_HEADERS = [
	'content-type',
	// oRPC's batch link marks a batched request with it.
	BATCH_HEADER,
	EXPO_ORIGIN_HEADER,
	SKIP_OAUTH_PROXY_HEADER
] as const
