import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { ioredisTransport, type IORedisLike } from './ioredis.js'
import {
	createRedisTransport,
	type SubscriberConnection,
	type SubscriberHandlers
} from './redis.js'

// Connection lifecycle of the shared Redis core, against fake drivers.

type FakeConnection = {
	handlers: SubscriberHandlers
	closed: boolean
	failResubscribe: Set<string>
}

function fakeDriver() {
	const connections: FakeConnection[] = []
	const transport = createRedisTransport({
		send: async () => null,
		async connectSubscriber(handlers) {
			const fake: FakeConnection = {
				handlers,
				closed: false,
				failResubscribe: new Set()
			}
			connections.push(fake)
			const connection: SubscriberConnection = {
				subscribe: async () => 1,
				unsubscribe: async () => 1,
				resubscribe: async (channel) => {
					if (fake.failResubscribe.has(channel)) throw new Error('nope')
					return 1
				},
				close: () => {
					fake.closed = true
				}
			}
			return connection
		}
	})
	return { transport, connections }
}

describe('Redis connection generations', () => {
	test('a failed restore after a reconnect retires the connection', async () => {
		const { transport, connections } = fakeDriver()
		const received: string[] = []
		const lost: string[] = []
		await transport.subscribe(
			'a',
			(m) => received.push(m),
			(e) => lost.push(e.message)
		)
		await transport.subscribe(
			'b',
			() => {},
			() => {}
		)
		const first = connections[0]!
		first.failResubscribe.add('b')

		first.handlers.onReconnect()
		await Bun.sleep(0)

		expect(first.closed).toBe(true)
		expect(lost).toEqual(['nope'])
		// The retired connection can no longer deliver: no duplicates later.
		first.handlers.onMessage('a', 'stale')
		expect(received).toEqual([])

		await transport.subscribe(
			'a',
			(m) => received.push(m),
			() => {}
		)
		expect(connections).toHaveLength(2)
		connections[1]!.handlers.onMessage('a', 'fresh')
		expect(received).toEqual(['fresh'])
	})

	test("a late loss from an old connection leaves the new one's channels alone", async () => {
		const { transport, connections } = fakeDriver()
		await transport.subscribe(
			'a',
			() => {},
			() => {}
		)
		connections[0]!.handlers.onLost(new Error('gone'))

		const received: string[] = []
		const lost: string[] = []
		await transport.subscribe(
			'a',
			(m) => received.push(m),
			(e) => lost.push(e.message)
		)
		connections[0]!.handlers.onLost(new Error('late'))
		connections[1]!.handlers.onMessage('a', 'still here')

		expect(lost).toEqual([])
		expect(received).toEqual(['still here'])
		expect(connections[1]!.closed).toBe(false)
	})

	test('a reconnect restores settled channels on the same connection', async () => {
		const { transport, connections } = fakeDriver()
		await transport.subscribe(
			'a',
			() => {},
			() => {}
		)
		connections[0]!.handlers.onReconnect()
		await Bun.sleep(0)
		expect(connections[0]!.closed).toBe(false)
		expect(connections).toHaveLength(1)
	})
})

describe('ioredis with a given subscriber', () => {
	test('reconnects do not stack message listeners', async () => {
		const subscriber = Object.assign(new EventEmitter(), {
			subscribe: async () => 1,
			unsubscribe: async () => 1,
			disconnect: () => {}
		}) as unknown as IORedisLike & EventEmitter
		const client = {
			call: async () => null,
			duplicate: () => subscriber
		} as unknown as IORedisLike
		const transport = ioredisTransport(client, { subscriber })
		const received: string[] = []
		const subscribe = () =>
			transport.subscribe(
				'a',
				(m) => received.push(m),
				() => {}
			)

		await subscribe()
		subscriber.emit('end')
		await subscribe()
		subscriber.emit('message', 'a', 'once')

		expect(received).toEqual(['once'])
		expect(subscriber.listenerCount('message')).toBe(1)
	})
})
