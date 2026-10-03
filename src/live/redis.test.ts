import { afterAll, describe, expect, test } from 'bun:test'
import { call, os } from '@orpc/server'
import { RedisClient } from 'bun'
import Redis from 'ioredis'
import { z } from 'zod'
import { createFn } from '../index.js'
import { ioredisTransport } from './ioredis.js'
import { bunRedisTransport } from './redis-bun.js'
import type { PubSubTransport } from './transport.js'

// Runs against a real Redis when REDIS_URL is set (CI starts one), once per
// adapter, so both clients' subscriber, NOSCRIPT and Lua semantics are covered.
const url = process.env.REDIS_URL
const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const bunClient = url ? new RedisClient(url) : undefined
const ioClient = url ? new Redis(url) : undefined
const adapters = [
	{
		name: 'redis-bun',
		send: (command: string, args: string[]) =>
			bunClient!.send(command, args) as Promise<unknown>,
		create: () => bunRedisTransport(bunClient!)
	},
	{
		name: 'ioredis',
		send: (command: string, args: string[]) => ioClient!.call(command, ...args),
		create: () => ioredisTransport(ioClient!)
	}
]

afterAll(() => {
	bunClient?.close()
	ioClient?.disconnect()
})

describe.skipIf(!url).each(adapters)('$name transport', (adapter) => {
	const prefix = `orpc-fn-test:${adapter.name}:${process.pid}`
	let transport: PubSubTransport & { close(): void }

	const received = (channel: string) => {
		const payloads: string[] = []
		return {
			payloads,
			subscribe: () =>
				transport.subscribe(channel, (payload) => payloads.push(payload))
		}
	}

	test('publishes to subscribers, one SUBSCRIBE shared per channel', async () => {
		transport = adapter.create()
		const channel = `${prefix}:plain`
		const first = received(channel)
		const second = received(channel)
		const unsubscribeFirst = await first.subscribe()
		const unsubscribeSecond = await second.subscribe()

		await transport.publish([{ channel, payload: 'hello' }])
		await sleep(50)
		expect(first.payloads).toEqual(['hello'])
		expect(second.payloads).toEqual(['hello'])

		await unsubscribeFirst()
		await transport.publish([{ channel, payload: 'again' }])
		await sleep(50)
		expect(first.payloads).toEqual(['hello'])
		expect(second.payloads).toEqual(['hello', 'again'])
		await unsubscribeSecond()
	})

	test('backlog is atomic, capped and expiring across channels', async () => {
		const a = `${prefix}:a`
		const b = `${prefix}:b`
		await transport.publish(
			[
				{ channel: a, payload: '1' },
				{ channel: b, payload: 'x' },
				{ channel: a, payload: '2' },
				{ channel: a, payload: '3' }
			],
			{ size: 2, ttlSeconds: 30 }
		)
		expect(await transport.readBacklog(a)).toEqual(['2', '3'])
		expect(await transport.readBacklog(b)).toEqual(['x'])
		const ttl = Number(await adapter.send('TTL', [`${a}:backlog`]))
		expect(ttl).toBeGreaterThan(0)
		expect(ttl).toBeLessThanOrEqual(30)
	})

	test('falls back to EVAL after SCRIPT FLUSH (NOSCRIPT)', async () => {
		const channel = `${prefix}:flush`
		await adapter.send('SCRIPT', ['FLUSH'])
		await transport.publish([{ channel, payload: 'after flush' }], {
			size: 5,
			ttlSeconds: 30
		})
		expect(await transport.readBacklog(channel)).toEqual(['after flush'])
	})

	test('subscriptions survive the subscriber connection being killed', async () => {
		const channel = `${prefix}:reconnect`
		const sub = received(channel)
		const unsubscribe = await sub.subscribe()
		await adapter.send('CLIENT', ['KILL', 'TYPE', 'pubsub'])
		// Both clients reconnect and re-subscribe on their own schedule.
		for (
			let attempt = 0;
			attempt < 40 && sub.payloads.length === 0;
			attempt++
		) {
			await transport.publish([{ channel, payload: 'after kill' }])
			await sleep(100)
		}
		expect(sub.payloads[0]).toBe('after kill')
		// Restored exactly once: no duplicate listener after the reconnect.
		await transport.publish([{ channel, payload: 'once' }])
		await sleep(100)
		expect(sub.payloads.filter((payload) => payload === 'once')).toHaveLength(1)
		await unsubscribe()
	})

	test('createPubSub + fnLive end to end', async () => {
		const { createPubSub, drainPubSubSubscribers } = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => quiet,
			pubsub: { transport }
		})
		const feed = createPubSub({
			name: 'test.redis.feed',
			channel: ({ room }) => `${prefix}:room:${room}`,
			inputSchema: z.object({ room: z.string() }),
			eventSchema: z.object({ room: z.string(), text: z.string() }),
			useBacklog: true
		})
		await feed.publish({ room: 'r1', text: 'before' })
		const stream = await call(feed.subscribe, { room: 'r1' }, { context: {} })
		expect((await stream.next()).value).toEqual({ room: 'r1', text: 'before' })
		const next = stream.next()
		await sleep(50)
		await feed.publishMany([
			{ room: 'r1', text: 'live' },
			{ room: 'r2', text: 'elsewhere' }
		])
		expect((await next).value).toEqual({ room: 'r1', text: 'live' })
		expect(drainPubSubSubscribers()).toBe(1)
		await stream.return(undefined)
		transport.close()
	})
})
