import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	test
} from 'bun:test'
import { call, os } from '@orpc/server'
import { z } from 'zod'
import { quiet } from '../../tests/fixture.js'
import { createFn } from '../index.js'
import type {
	BacklogOptions,
	PubSubMessage,
	PubSubTransport
} from './transport.js'

// Runtime lifecycle of the subscribe generator against a fake transport:
// hub fan-out, backlog replay, resubscribe, abort/drain cleanup, auth, and
// gey-mono's mirrorChannel/publishMany. Ported from lullu
// pub-sub-fn.subscribe.test.ts.

type Listener = (payload: string) => void

const listeners = new Map<string, Set<Listener>>()
const lostHandlers = new Set<(error: Error) => void>()
const backlogs = new Map<string, string[]>()
const published: Array<{
	messages: readonly PubSubMessage[]
	backlog: BacklogOptions | undefined
}> = []
let subscribeCalls: string[] = []
let unsubscribeCalls: string[] = []

const transport: PubSubTransport = {
	async publish(messages, backlog) {
		published.push({ messages, backlog })
	},
	async readBacklog(channel) {
		return backlogs.get(channel) ?? []
	},
	async subscribe(channel, listener, onLost) {
		subscribeCalls.push(channel)
		const set = listeners.get(channel) ?? new Set()
		set.add(listener)
		listeners.set(channel, set)
		if (onLost) lostHandlers.add(onLost)
		return async () => {
			unsubscribeCalls.push(channel)
			set.delete(listener)
			if (onLost) lostHandlers.delete(onLost)
		}
	}
}

const { createPubSub, drainPubSubSubscribers, activePubSubSubscriberCount } =
	createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		pubsub: { transport }
	})

const orderUpdates = createPubSub({
	name: 'test.order.updates',
	channel: 'test:orders',
	inputSchema: z.object({ orderId: z.string() }),
	eventSchema: z.object({ orderId: z.string(), status: z.string() }),
	filterFn: ({ input, data }) => data.orderId === input.orderId,
	useBacklog: true
})

function emit(channel: string, data: unknown) {
	for (const listener of listeners.get(channel) ?? []) {
		listener(JSON.stringify(data))
	}
}

/** Let oRPC's async input handling and the generator run to their next wait. */
async function settle() {
	await Bun.sleep(0)
}

async function openSubscription(orderId: string) {
	const abort = new AbortController()
	const iterator = await call(
		orderUpdates.subscribe,
		{ orderId },
		{ context: {}, signal: abort.signal }
	)
	return { abort, iterator }
}

beforeEach(() => {
	listeners.clear()
	lostHandlers.clear()
	backlogs.clear()
	published.length = 0
	subscribeCalls = []
	unsubscribeCalls = []
})

afterEach(() => {
	drainPubSubSubscribers()
})

describe('createPubSub subscribe lifecycle', () => {
	test('replays the backlog, then delivers matching live events', async () => {
		backlogs.set('test:orders', [
			JSON.stringify({ orderId: 'a', status: 'queued' }),
			JSON.stringify({ orderId: 'b', status: 'other order' }),
			'not json'
		])
		const { abort, iterator } = await openSubscription('a')

		const first = await iterator.next()
		const secondPromise = iterator.next()
		await settle()
		emit('test:orders', { orderId: 'b', status: 'ignored' })
		emit('test:orders', { orderId: 'a', status: 'live' })
		const second = await secondPromise

		expect(first.value).toEqual({ orderId: 'a', status: 'queued' })
		expect(second.value).toEqual({ orderId: 'a', status: 'live' })
		expect(subscribeCalls).toEqual(['test:orders'])
		expect(activePubSubSubscriberCount()).toBe(1)

		abort.abort()
		await iterator.return(undefined)
	})

	test('abort ends the stream and releases the broker subscription', async () => {
		const { abort, iterator } = await openSubscription('a')
		const pending = iterator.next()
		await settle()

		abort.abort()
		const result = await pending

		expect(result.done).toBe(true)
		expect(activePubSubSubscriberCount()).toBe(0)
		expect(lostHandlers.size).toBe(0)
		expect(unsubscribeCalls).toEqual(['test:orders'])
	})

	test('subscribers on one channel share a single broker subscription', async () => {
		const first = await openSubscription('a')
		const second = await openSubscription('b')
		const firstNext = first.iterator.next()
		const secondNext = second.iterator.next()
		await settle()

		emit('test:orders', { orderId: 'b', status: 'for b' })
		emit('test:orders', { orderId: 'a', status: 'for a' })

		expect(subscribeCalls).toHaveLength(1)
		expect((await firstNext).value).toEqual({ orderId: 'a', status: 'for a' })
		expect((await secondNext).value).toEqual({ orderId: 'b', status: 'for b' })

		first.abort.abort()
		await first.iterator.return(undefined)
		expect(unsubscribeCalls).toHaveLength(0)

		second.abort.abort()
		await second.iterator.return(undefined)
		expect(unsubscribeCalls).toHaveLength(1)
	})

	test('drain closes every open subscription', async () => {
		const { iterator } = await openSubscription('a')
		const pending = iterator.next()
		await settle()

		expect(drainPubSubSubscribers()).toBe(1)
		expect((await pending).done).toBe(true)
		expect(activePubSubSubscriberCount()).toBe(0)
	})

	test('drain is per instance', async () => {
		const other = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => quiet,
			pubsub: { transport }
		})
		const { iterator } = await openSubscription('a')
		const pending = iterator.next()
		await settle()

		expect(other.drainPubSubSubscribers()).toBe(0)
		expect(activePubSubSubscriberCount()).toBe(1)
		drainPubSubSubscribers()
		await pending
	})

	test('abort releases the broker while the stream is parked after a yield', async () => {
		const { abort, iterator } = await openSubscription('a')
		const first = iterator.next()
		await settle()
		emit('test:orders', { orderId: 'a', status: 'one' })
		await first
		// The consumer has not asked for the next item: nothing resumes the
		// generator, yet the subscription must be gone.
		abort.abort()

		expect(activePubSubSubscriberCount()).toBe(0)
		expect(unsubscribeCalls).toEqual(['test:orders'])
		await iterator.return(undefined)
	})

	test('live events arriving during backlog replay follow it; drain mid-replay releases once', async () => {
		let releaseBacklog = () => {}
		const original = transport.readBacklog
		transport.readBacklog = async () => {
			await new Promise<void>((resolve) => {
				releaseBacklog = resolve
			})
			return [JSON.stringify({ orderId: 'a', status: 'old' })]
		}
		try {
			const { abort, iterator } = await openSubscription('a')
			const first = iterator.next()
			await settle()
			emit('test:orders', { orderId: 'a', status: 'new' })
			releaseBacklog()

			expect((await first).value).toEqual({ orderId: 'a', status: 'old' })
			expect((await iterator.next()).value).toEqual({
				orderId: 'a',
				status: 'new'
			})
			abort.abort()
			await iterator.return(undefined)

			const second = await openSubscription('a')
			const pending = second.iterator.next()
			await settle()
			// Still reading the backlog: drain releases now, and only once.
			expect(drainPubSubSubscribers()).toBe(1)
			expect(drainPubSubSubscribers()).toBe(0)
			expect(unsubscribeCalls).toEqual(['test:orders', 'test:orders'])
			releaseBacklog()
			expect((await pending).done).toBe(true)
			expect(unsubscribeCalls).toEqual(['test:orders', 'test:orders'])
		} finally {
			transport.readBacklog = original
		}
	})

	test('a lost raw subscription reports a gap after reconnect', async () => {
		const { abort, iterator } = await openSubscription('a')
		const pending = iterator.next()
		const failed = pending.catch((error: unknown) => error)
		await settle()
		for (const handler of [...lostHandlers]) handler(new Error('boom'))
		for (const handler of [...lostHandlers]) handler(new Error('again'))
		await Bun.sleep(1300)
		expect(await failed).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
		expect(unsubscribeCalls).toEqual(['test:orders', 'test:orders'])
		expect(subscribeCalls).toEqual(['test:orders', 'test:orders'])
		expect(lostHandlers.size).toBe(0)
		abort.abort()
		await iterator.return(undefined)
	})

	test('rejects when authFn denies access', async () => {
		const guarded = createPubSub({
			name: 'test.guarded',
			channel: 'test:guarded',
			inputSchema: z.object({}),
			eventSchema: z.object({ ok: z.boolean() }),
			authFn: () => false
		})

		const iterator = await call(guarded.subscribe, {}, { context: {} })

		await expect(iterator.next()).rejects.toThrow(
			'You do not have access to this subscription'
		)
		expect(subscribeCalls).toEqual([])
	})

	test('overflow drops oldest and enqueues the overflow marker', async () => {
		const drops: string[] = []
		const small = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => quiet,
			pubsub: {
				transport,
				maxQueueSize: 2,
				maxIngressSize: 100,
				onDrop: (count, { channel }) => drops.push(`${count}:${channel}`)
			}
		})
		const feed = small.createPubSub({
			name: 'test.overflow',
			channel: 'test:overflow',
			inputSchema: z.object({}),
			eventSchema: z.object({ n: z.number() }),
			overflowMarker: () => ({ n: -1 })
		})
		const abort = new AbortController()
		const iterator = await call(
			feed.subscribe,
			{},
			{
				context: {},
				signal: abort.signal
			}
		)
		const first = iterator.next()
		await settle()
		for (let n = 0; n < 5; n++) emit('test:overflow', { n })
		await settle()

		const values = [(await first).value]
		values.push((await iterator.next()).value, (await iterator.next()).value)
		// n0 went straight to the waiting reader; n1..n4 hit a queue of 2:
		// n3 displaced n1 with the marker, n4 displaced n2 (one marker per episode).
		expect(values).toEqual([{ n: 0 }, { n: -1 }, { n: 4 }])
		expect(drops).toEqual(['1:test:overflow', '1:test:overflow'])
		abort.abort()
		await iterator.return(undefined)
		small.drainPubSubSubscribers()
	})
})

describe('publish (ported from gey-mono mirrorChannel/publishMany)', () => {
	const shards = createPubSub({
		name: 'test.mirror',
		channel: ({ shardId }) => `test:shard:${shardId}`,
		mirrorChannel: 'test:broadcast',
		inputSchema: z.object({ shardId: z.string() }),
		eventSchema: z.object({ shardId: z.string(), data: z.string() }),
		useBacklog: true,
		backlogSize: 10,
		backlogTtl: 30
	})

	test('publish validates, resolves the channel and mirrors the payload', async () => {
		await shards.publish({ shardId: '1', data: 'x' })
		const payload = published[0]?.messages[0]?.payload ?? ''
		expect(typeof payload).toBe('string')
		expect(published).toEqual([
			{
				messages: [
					{ channel: 'test:shard:1', payload },
					{ channel: 'test:broadcast', payload }
				],
				backlog: { size: 10, ttlSeconds: 30 }
			}
		])
		// @ts-expect-error data is required
		await expect(shards.publish({ shardId: '1' })).rejects.toThrow()
	})

	test('publishMany sends one batch across channels', async () => {
		await shards.publishMany([
			{ shardId: '1', data: 'a' },
			{ shardId: '2', data: 'b' }
		])
		expect(published).toHaveLength(1)
		expect(published[0]?.messages.map((m) => m.channel)).toEqual([
			'test:shard:1',
			'test:broadcast',
			'test:shard:2',
			'test:broadcast'
		])
	})

	test('publishMany with no items is a no-op', async () => {
		await shards.publishMany([])
		expect(published).toHaveLength(0)
	})

	test('a mirror equal to the channel is not published twice', async () => {
		const same = createPubSub({
			name: 'test.sameMirror',
			channel: 'test:same',
			mirrorChannel: 'test:same',
			inputSchema: z.object({}),
			eventSchema: z.object({ ok: z.boolean() })
		})
		await same.publish({ ok: true })
		expect(published[0]?.messages).toHaveLength(1)
		expect(published[0]?.backlog).toBeUndefined()
	})

	test('publishMany is typed like publish', () => {
		expectTypeOf<Parameters<typeof shards.publishMany>[0]>().toEqualTypeOf<
			readonly { shardId: string; data: string }[]
		>()
	})

	test('createPublisher shares the publish pipeline', async () => {
		const { createPublisher } = createFn({
			procedures: { public: os },
			default: 'public',
			pubsub: { transport }
		})
		const publisher = createPublisher({
			name: 'test.publisher',
			channel: ({ id }) => `item:${id}`,
			eventSchema: z.object({ id: z.string() })
		})
		await publisher.publish({ id: '7' })
		expect(published[0]?.messages[0]?.channel).toBe('item:7')
		expect(publisher.getChannelName({ id: '8' })).toBe('item:8')
	})

	test('live routes without a transport fail clearly', async () => {
		const { createPublisher } = createFn({
			procedures: { public: os },
			default: 'public'
		})
		const publisher = createPublisher({
			name: 'test.noTransport',
			channel: 'x',
			eventSchema: z.object({})
		})
		await expect(publisher.publish({})).rejects.toThrow('need a transport')
	})
})
