// orpc-fn/node and orpc-fn/fetch under real Node, with only the required
// peers installed: batching, brotli, flushed batch streams, resHeaders and
// AsyncLocalStorage across a node:http round-trip.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, request } from 'node:http'
import zlib from 'node:zlib'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { BatchLinkPlugin } from '@orpc/client/plugins'
import { os } from '@orpc/server'
import { createFn } from 'orpc-fn'
import { createRpcLink } from 'orpc-fn/client'
import { createFetchHandler } from 'orpc-fn/fetch'
import { createNodeHandler } from 'orpc-fn/node'
import { z } from 'zod'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const { fn } = createFn({
	procedures: { public: os.$context() },
	default: 'public',
	logger: () => quiet
})
const store = new AsyncLocalStorage()
const rows = Array.from({ length: 2000 }, (_, id) => ({ id, name: `row ${id}` }))
let releaseSlow
const slowGate = new Promise((resolve) => {
	releaseSlow = resolve
})
const router = {
	big: fn({ name: 'big', handler: () => ({ rows }) }),
	slow: fn({
		name: 'slow',
		handler: async () => {
			await slowGate
			return { done: true }
		}
	}),
	echo: fn({ name: 'echo', input: z.object({ text: z.string() }), handler: ({ input }) => input.text }),
	requestId: fn({ name: 'requestId', handler: () => store.getStore()?.requestId ?? null }),
	cached: fn({
		name: 'cached',
		handler: ({ context }) => {
			context.resHeaders?.set('cache-control', 'public, max-age=60')
			return true
		}
	})
}

const handler = createNodeHandler({ router, rpcPrefix: '/api/rpc' })
const server = createServer((req, res) =>
	store.run({ requestId: req.headers['x-request-id'] }, () => handler(req, res))
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const url = `${origin}/api/rpc`

// The request oRPC's client sends for a streaming batch, captured to replay.
async function captureStreamingBatch(paths) {
	let captured
	const client = createORPCClient(
		new RPCLink({
			origin,
			url: '/api/rpc',
			fetch: async (input, init) => {
				const request = new Request(input, init)
				captured = {
					path: new URL(input).pathname,
					headers: Object.fromEntries(request.headers),
					body: Buffer.from(await request.arrayBuffer())
				}
				throw new Error('captured')
			},
			plugins: [new BatchLinkPlugin({ mode: 'streaming', groups: [{ condition: () => true, context: {} }] })]
		})
	)
	await Promise.allSettled(paths.map((path) => client[path]()))
	return captured
}

function raw(path, headers, body) {
	return new Promise((resolve, reject) => {
		const req = request(`${url}${path}`, { method: 'POST', headers }, (res) => {
			const chunks = []
			res.on('data', (chunk) => chunks.push(chunk))
			res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
		})
		req.on('error', reject)
		req.end(body)
	})
}

try {
	let requests = 0
	const client = createORPCClient(
		createRpcLink({
			origin,
			url: '/api/rpc',
			headers: { 'x-request-id': 'req-1' },
			fetch: (input, init) => {
				requests++
				return fetch(input, init)
			}
		})
	)
	assert.deepEqual(await client.big(), { rows })
	assert.deepEqual(await Promise.all([client.echo({ text: 'a' }), client.requestId(), client.big()]), [
		'a',
		'req-1',
		{ rows }
	])
	assert.equal(requests, 2, 'parallel calls share one batch request')

	const json = await raw('/big', { 'accept-encoding': 'gzip, br', 'content-type': 'application/json' }, '{"json":null}')
	assert.equal(json.headers['content-encoding'], 'br')
	assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(json.body)), { json: { rows } })

	const cached = await raw('/cached', {}, '{"json":null}')
	assert.equal(cached.headers['cache-control'], 'public, max-age=60')
	assert.match(cached.headers['server-timing'], /^total;dur=/)

	// A streaming batch is flushed per result: the fast one arrives first.
	const batch = await captureStreamingBatch(['big', 'slow'])
	const firstResult = await new Promise((resolve, reject) => {
		const req = request(
			`${origin}${batch.path}`,
			{ method: 'POST', headers: { ...batch.headers, 'accept-encoding': 'br' } },
			(res) => {
				assert.equal(res.headers['content-encoding'], 'br')
				let text = ''
				const decoded = res.pipe(zlib.createBrotliDecompress())
				decoded.on('data', (chunk) => {
					text += chunk
					if (text.includes('"row 1999"')) {
						resolve(text)
						releaseSlow()
					}
				})
				decoded.on('error', reject)
			}
		)
		req.on('error', reject)
		req.end(batch.body)
	})
	assert.ok(!firstResult.includes('"done"'))

	const fetchHandler = createFetchHandler({ router, rpcPrefix: '/rpc' })
	const response = await fetchHandler(
		new Request('http://localhost/rpc/big', {
			method: 'POST',
			headers: { 'accept-encoding': 'gzip', 'content-type': 'application/json' },
			body: '{"json":null}'
		})
	)
	assert.equal(response.headers.get('content-encoding'), 'gzip')
	assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(await response.arrayBuffer()))), { json: { rows } })
} finally {
	server.closeAllConnections()
	server.close()
}
console.log(`orpc-fn/node and orpc-fn/fetch passed on Node ${process.version}`)
