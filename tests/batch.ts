import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { BatchLinkPlugin } from '@orpc/client/plugins'

export type CapturedBatch = {
	/** Batch path: the first call's plus `/__batch__`, e.g. `/rpc/big/__batch__`. */
	path: string
	headers: Record<string, string>
	body: Uint8Array
}

/**
 * The request oRPC's client sends for a streaming batch of no-input calls
 * to `paths`, captured instead of sent, so a test can replay it with its own
 * headers. The batch format is oRPC's to define.
 */
export async function captureStreamingBatch(
	paths: readonly string[],
	prefix: `/${string}` = '/rpc'
): Promise<CapturedBatch> {
	let captured: CapturedBatch | undefined
	const link = new RPCLink({
		origin: 'http://localhost',
		url: prefix,
		fetch: async (url, init) => {
			const request = new Request(url, init)
			captured = {
				path: new URL(url).pathname,
				headers: Object.fromEntries(request.headers),
				body: new Uint8Array(await request.arrayBuffer())
			}
			throw new Error('captured')
		},
		plugins: [
			new BatchLinkPlugin({
				mode: 'streaming',
				groups: [{ condition: () => true, context: {} }]
			})
		]
	})
	const client = createORPCClient<Record<string, () => Promise<unknown>>>(link)
	await Promise.allSettled(paths.map((path) => client[path]?.()))
	if (!captured) throw new Error('no batch request was sent')
	return captured
}
