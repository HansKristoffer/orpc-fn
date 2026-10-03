import assert from 'node:assert/strict'
import { call, os } from '@orpc/server'
import * as root from 'orpc-fn'
import * as live from 'orpc-fn/live'
import { memoryTransport } from 'orpc-fn/live/memory'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun'
import { ioredisTransport } from 'orpc-fn/live/ioredis'
import { z } from 'zod'

// Root and live entries work with only the required peers installed.
for (const name of ['createFn', 'readFnMeta', 'isExpectedClientError', 'createBoundedEventQueue', 'createRouter']) {
	assert.equal(typeof root[name], 'function', name)
}
assert.equal(root.createBoundedEventQueue, live.createBoundedEventQueue)
for (const name of ['streamLiveSnapshots', 'fnLivePatch', 'throwInitialSnapshotError', 'backlogKey']) {
	assert.equal(typeof live[name], 'function', name)
}
assert.equal(typeof bunRedisTransport, 'function')
assert.equal(typeof ioredisTransport, 'function')

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const { fn, fnLive, readMeta } = root.createFn({
	procedures: { public: os.$context() },
	default: 'public',
	logger: () => quiet,
	guards: {
		needsFlag: (flag, { context }) => {
			if (!context.flags?.includes(flag)) throw new Error(`missing ${flag}`)
		}
	},
	extras: () => ({ answer: 42 }),
	pubsub: { transport: memoryTransport() }
})
const inner = fn({ name: 'inner', input: z.object({ n: z.number() }), handler: ({ input }) => input.n * 2 })
const outer = fn({
	name: 'outer',
	needsFlag: 'beta',
	meta: { readOnly: true },
	handler: async ({ call, answer, span }) => {
		assert.equal(span, undefined)
		return (await call(inner, { n: answer })) + 1
	}
})
assert.equal(await call(outer, undefined, { context: { flags: ['beta'] } }), 85)
await assert.rejects(call(outer, undefined, { context: {} }), /missing beta/)
assert.deepEqual(readMeta(outer).meta, { readOnly: true })

const counter = fnLive({
	name: 'counter',
	input: z.object({ id: z.string() }),
	handler: () => ({ count: 0 }),
	live: {
		eventSchema: z.object({ id: z.string() }),
		channel: ({ id }) => `counter:${id}`,
		stateSchema: z.object({ count: z.number() }),
		transformerFn: ({ previous }) => ({ count: (previous?.count ?? 0) + 1 })
	}
})
const stream = await call(counter.subscribe, { id: 'a' }, { context: {} })
assert.deepEqual((await stream.next()).value, { count: 0 })
const next = stream.next()
await new Promise((resolve) => setTimeout(resolve, 10))
await counter.publish({ id: 'a' })
assert.deepEqual((await next).value, { count: 1 })
await stream.return(undefined)

// Adapters load once their optional peers are installed.
if (process.env.WITH_OPTIONAL_PEERS) {
	const { listTools, hasTag } = await import('orpc-fn/mcp')
	const { mountOrpc } = await import('orpc-fn/hono')
	const { createMastraTool } = await import('orpc-fn/mastra')
	const { Hono } = await import('hono')
	const { createRpcLink, hasOrpcErrorCode } = await import('orpc-fn/client')
	const { createBetterAuthExpoLink } = await import('orpc-fn/expo')
	const { createORPCClient } = await import('@orpc/client')
	const tools = listTools({ inner, outer }, { filter: () => true })
	assert.deepEqual(tools.map((tool) => tool.name), ['inner', 'outer'])
	assert.equal(typeof hasTag('x'), 'function')
	assert.equal(createMastraTool(inner).id, 'inner')
	const app = new Hono()
	mountOrpc(app, { router: { inner }, rpcPrefix: '/rpc', openapi: { prefix: '/api' } })
	const response = await app.request('/api/inner', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ n: 2 })
	})
	assert.equal(await response.json(), 4)
	const fetch = (request) => Promise.resolve(app.fetch(request))
	const client = createORPCClient(createRpcLink({ url: 'http://localhost/rpc', fetch }))
	assert.deepEqual(await Promise.all([client.inner({ n: 1 }), client.inner({ n: 2 })]), [2, 4])
	assert.equal(hasOrpcErrorCode(new Error('x'), 'NOT_FOUND'), false)
	const expo = createORPCClient(createBetterAuthExpoLink({
		url: 'http://localhost/rpc',
		native: true,
		fetch: (url, init) => app.fetch(new Request(url, init))
	}))
	assert.equal(await expo.inner({ n: 5 }), 10)
}
console.log(`Packed Node ${process.version} entry points passed${process.env.WITH_OPTIONAL_PEERS ? ' with optional peers' : ' without optional peers'}`)
