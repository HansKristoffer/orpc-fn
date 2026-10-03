import { createORPCClient } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import {
	createBetterAuthExpoLink,
	createExpoLink,
	type ExpoFetch
} from 'orpc-fn/expo'
import { app, type router } from './core.js'

// In an Expo app pass `fetch` from expo/fetch instead of this in-process fetch.
const streamingFetch: ExpoFetch = async (url, init) =>
	app.fetch(new Request(url, init))
export async function runExpoExample() {
	const cookieClient: RouterClient<typeof router> = createORPCClient(
		createBetterAuthExpoLink({
			url: 'http://example/rpc',
			native: true,
			fetch: streamingFetch,
			getCookie: async () => 'session=abc',
			getExpoOrigin: () => 'myapp://'
		})
	)
	const bearerClient: RouterClient<typeof router, { token: string }> =
		createORPCClient(
			createExpoLink<{ token: string }>({
				url: 'http://example/rpc',
				native: true,
				fetch: streamingFetch,
				headers: async ({ context }) => ({
					Authorization: `Bearer ${context.token}`
				})
			})
		)
	return {
		cookie: await cookieClient.auth(),
		bearer: await bearerClient.auth(undefined, { context: { token: 'abc' } })
	}
}
if (process.argv[1]?.endsWith('/expo.ts')) console.log(await runExpoExample())
