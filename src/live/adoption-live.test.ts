import { expect, test } from 'bun:test'
import { call, os } from '@orpc/server'
import { z } from 'zod'
import { createFn } from '../index.js'
import { encodePayload } from './codec.js'
import { memoryTransport } from './memory.js'
import type { PubSubTransport } from './transport.js'
import { quiet } from '../../tests/fixture.js'

const settle = () => Bun.sleep(0)
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}
const schemas = {
	inputSchema: z.object({}),
	eventSchema: z.object({ n: z.number() })
}

test('failed startup never sends a snapshot; timeout and abort release local subscribers', async () => {
	const transport = memoryTransport()
	transport.subscribe = async () => {
		throw new Error('offline')
	}
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport, initializationTimeoutMs: 20 }
	})
	let snapshots = 0
	const live = factory.fnLive({
		name: 'startup',
		input: z.object({}),
		handler: () => {
			snapshots++
			return 42
		},
		live: { channel: 'startup', eventSchema: z.object({}) }
	})
	const stream = await call(live.subscribe, {})
	await expect(stream.next()).rejects.toMatchObject({
		code: 'SERVICE_UNAVAILABLE'
	})
	expect(snapshots).toBe(0)
	expect(factory.activePubSubSubscriberCount()).toBe(0)
	const abort = new AbortController()
	const other = await call(live.subscribe, {}, { signal: abort.signal })
	const pending = other.next()
	await settle()
	abort.abort()
	expect((await pending).done).toBe(true)
	await factory.shutdown()
})

test('events present in both replay and live buffers are delivered once', async () => {
	const memory = memoryTransport()
	const started = deferred<void>()
	const replay = deferred<string[]>()
	const transport: PubSubTransport = {
		...memory,
		readBacklog: () => {
			started.resolve()
			return replay.promise
		}
	}
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport }
	})
	const feed = factory.createPubSub({
		name: 'replay',
		channel: 'replay',
		useBacklog: true,
		...schemas
	})
	const abort = new AbortController()
	const stream = await call(feed.subscribe, {}, { signal: abort.signal })
	const first = stream.next()
	await started.promise
	await feed.publish({ n: 1 })
	await settle()
	replay.resolve(await memory.readBacklog('replay'))
	expect((await first).value).toEqual({ n: 1 })
	const next = stream.next()
	await feed.publish({ n: 2 })
	expect((await next).value).toEqual({ n: 2 })
	abort.abort()
	await factory.shutdown()
})

test('invalidation coalescing reruns once; snapshot overlap stays correct', async () => {
	const transport = memoryTransport()
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport }
	})
	let actual = 0
	let runs = 0
	const live = factory.fnLive({
		name: 'coalesced',
		input: z.object({}),
		handler: () => {
			runs++
			return { total: actual }
		},
		live: {
			channel: 'coalesced',
			eventSchema: z.object({ n: z.number() }),
			coalesceMs: 10
		}
	})
	const abort = new AbortController()
	const stream = await call(live.subscribe, {}, { signal: abort.signal })
	expect((await stream.next()).value).toEqual({ total: 0 })
	const next = stream.next()
	actual = 3
	await Promise.all([
		live.publish({ n: 1 }),
		live.publish({ n: 1 }),
		live.publish({ n: 1 })
	])
	expect((await next).value).toEqual({ total: 3 })
	expect(runs).toBe(2)
	abort.abort()
	await factory.shutdown()
})

test('live reducers use parsed input and validate state and patch payloads', async () => {
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport: memoryTransport() }
	})
	const live = factory.fnLive({
		name: 'state',
		input: z.object({ n: z.string().transform(Number) }),
		output: z.string().transform(Number),
		handler: ({ input }) => String(input.n),
		live: {
			channel: 'state',
			eventSchema: z.object({}),
			stateSchema: z.number().min(0),
			transformerFn: () => -1
		}
	})
	const stream = await call(live.subscribe, { n: '2' })
	expect((await stream.next()).value).toBe(2)
	const next = stream.next()
	await live.publish({})
	await expect(next).rejects.toThrow('Invalid live state')
	expect(factory.activePubSubSubscriberCount()).toBe(0)
	await factory.shutdown()
})

test('pubsub guards, extras and completion run through the common policy', async () => {
	let extras = 0
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		extras: () => {
			extras++
			return {}
		},
		meta: {} as { audit?: boolean },
		guards: { permission: (allow: boolean) => allow },
		pubsub: { transport: memoryTransport() }
	})
	const feed = factory.createPubSub({
		name: 'guarded',
		channel: 'guarded',
		...schemas,
		permission: false,
		meta: { audit: true }
	})
	await expect(call(feed.subscribe, {})).rejects.toMatchObject({
		code: 'FORBIDDEN'
	})
	expect(extras).toBe(0)
	expect(factory.readMeta(feed.subscribe).meta.audit).toBe(true)
	await factory.shutdown()
})

test('namespace and separate resolvers support different tenant input/event shapes', async () => {
	const transport = memoryTransport()
	const factory = createFn({
		procedures: { public: os.$context<{ tenant: string }>() },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport, namespace: 'app:dev' }
	})
	const feed = factory.createPubSub({
		name: 'tenant',
		inputSchema: z.object({ room: z.string() }),
		eventSchema: z.object({
			tenantId: z.string(),
			roomId: z.string(),
			n: z.number()
		}),
		channel: {
			subscribe: ({ input, context }) => `${context.tenant}:${input.room}`,
			publish: (event) => `${event.tenantId}:${event.roomId}`
		},
		useBacklog: true,
		mirrorChannel: 'all'
	})
	const abort = new AbortController()
	const stream = await call(
		feed.subscribe,
		{ room: 'r' },
		{ context: { tenant: 't' }, signal: abort.signal }
	)
	const next = stream.next()
	await settle()
	await feed.publish({ tenantId: 't', roomId: 'r', n: 1 })
	expect((await next).value).toMatchObject({ n: 1 })
	expect(transport.listenerCount('app:dev:t:r')).toBe(1)
	expect(await transport.readBacklog('app:dev:all')).toHaveLength(1)
	abort.abort()
	await factory.shutdown()
})

test('terminal shutdown is awaitable, idempotent and respects transport ownership', async () => {
	const memory = memoryTransport()
	const released = deferred<void>()
	let closed = 0
	const transport: PubSubTransport = {
		...memory,
		close: async () => {
			closed++
		},
		subscribe: async (...args) => {
			const remove = await memory.subscribe(...args)
			return async () => {
				await released.promise
				await remove()
			}
		}
	}
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport, ownsTransport: true }
	})
	const feed = factory.createPubSub({
		name: 'shutdown',
		channel: 'shutdown',
		...schemas
	})
	const stream = await call(feed.subscribe, {})
	const pending = stream.next()
	await settle()
	let settled = false
	const stopping = factory.shutdown().then(() => {
		settled = true
	})
	await settle()
	expect(settled).toBe(false)
	expect((await pending).done).toBe(true)
	released.resolve()
	await stopping
	await factory.shutdown()
	expect(closed).toBe(1)
	const other = await call(feed.subscribe, {})
	await expect(other.next()).rejects.toMatchObject({
		code: 'SERVICE_UNAVAILABLE'
	})
	const shared = createFn({
		procedures: { public: os },
		default: 'public',
		pubsub: { transport }
	})
	await shared.shutdown()
	expect(closed).toBe(1)
})

test('slow parsing ingress is bounded; telemetry failures do not poison live recovery', async () => {
	const gate = deferred<void>()
	let parsing = 0
	const transport = memoryTransport()
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: {
			transport,
			maxIngressSize: 2,
			maxQueueSize: 2,
			onDrop: () => {
				throw new Error('metrics failed')
			}
		}
	})
	const eventSchema = z.object({ n: z.number() }).superRefine(async () => {
		parsing++
		await gate.promise
	})
	let actual = 0
	const live = factory.fnLive({
		name: 'bounded',
		input: z.object({}),
		handler: () => actual,
		live: { channel: 'bounded', eventSchema, coalesceMs: 10 }
	})
	const abort = new AbortController()
	const stream = await call(live.subscribe, {}, { signal: abort.signal })
	expect((await stream.next()).value).toBe(0)
	actual = 20
	const next = stream.next()
	await transport.publish(
		Array.from({ length: 20 }, (_, n) => ({
			channel: 'bounded',
			payload: encodePayload({ n })
		}))
	)
	await settle()
	expect(parsing).toBe(1)
	expect((await next).value).toBe(20)
	gate.resolve()
	await settle()
	expect(parsing).toBeLessThanOrEqual(3)
	abort.abort()
	await factory.shutdown()
})

test('a driver reconnect reloads live state after successful channel restoration', async () => {
	const memory = memoryTransport()
	let restored: (() => void) | undefined
	const transport: PubSubTransport = {
		...memory,
		subscribe: async (channel, listener, lost, options) => {
			restored = options?.onReconnect
			return memory.subscribe(channel, listener, lost)
		}
	}
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport }
	})
	let actual = 1
	const live = factory.fnLive({
		name: 'reconnected',
		input: z.object({}),
		handler: () => actual,
		live: { channel: 'reconnected', eventSchema: z.object({}) }
	})
	const abort = new AbortController()
	const stream = await call(live.subscribe, {}, { signal: abort.signal })
	expect((await stream.next()).value).toBe(1)
	const next = stream.next()
	actual = 7
	restored?.()
	expect((await next).value).toBe(7)
	abort.abort()
	await factory.shutdown()
})

test('live subscriptions install route-local error constructors for reducers', async () => {
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport: memoryTransport() }
	})
	const live = factory.fnLive({
		name: 'declaredErrors',
		input: z.object({}),
		errors: { STALE: { data: z.object({ revision: z.number() }) } },
		handler: () => 1,
		live: {
			channel: 'declaredErrors',
			eventSchema: z.object({ revision: z.number() }),
			stateSchema: z.number(),
			transformerFn: ({ errors, event }) => {
				throw errors.STALE({ data: { revision: event.revision } })
			}
		}
	})
	const stream = await call(live.subscribe, {})
	expect((await stream.next()).value).toBe(1)
	const next = stream.next()
	await live.publish({ revision: 2 })
	await expect(next).rejects.toMatchObject({
		code: 'STALE',
		data: { revision: 2 }
	})
	await factory.shutdown()
})

test('per-definition queue limits and throwing metrics preserve recovery', async () => {
	const metrics: import('./pub-sub.js').PubSubMetric[] = []
	const transport = memoryTransport()
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: {
			transport,
			maxQueueSize: 10,
			onMetric: (event) => {
				metrics.push(event)
				throw new Error('metrics unavailable')
			}
		}
	})
	const feed = factory.createPubSub({
		name: 'boundedDefinition',
		channel: 'boundedDefinition',
		...schemas,
		maxQueueSize: 1,
		maxIngressSize: 2,
		maxReplaySize: 3
	})
	const stream = await call(feed.subscribe, {})
	const first = stream.next()
	await settle()
	await transport.publish([
		{ channel: 'boundedDefinition', payload: 'invalid-json' }
	])
	await feed.publish({ n: 1 })
	expect((await first).value).toEqual({ n: 1 })
	await feed.publish({ n: 2 })
	await settle()
	await feed.publish({ n: 3 })
	await settle()
	await expect(stream.next()).rejects.toMatchObject({
		code: 'SERVICE_UNAVAILABLE'
	})
	expect(
		metrics.some(
			(event) => event.type === 'parseError' && event.stage === 'ingress'
		)
	).toBe(true)
	expect(
		metrics.some((event) => event.type === 'drop' && event.stage === 'delivery')
	).toBe(true)
	for (const event of metrics) {
		if (event.type === 'queue') {
			expect(event.depth).toBeLessThanOrEqual(event.limit)
			if (event.stage === 'delivery') expect(event.limit).toBe(1)
			if (event.stage === 'ingress') expect(event.limit).toBe(2)
		}
	}
	expect(() =>
		factory.createPubSub({
			name: 'invalidBounds',
			channel: 'invalidBounds',
			...schemas,
			maxQueueSize: 0
		})
	).toThrow('positive safe integer')
	await factory.shutdown()
})
