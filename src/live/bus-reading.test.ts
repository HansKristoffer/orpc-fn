import { describe, expect, test } from 'bun:test'
import { call, os } from '@orpc/server'
import { z } from 'zod'
import { quiet } from '../../tests/fixture.js'
import { createFn } from '../index.js'
import { memoryTransport } from './memory.js'
import { defineScopedChangeBus } from './scoped-change-bus.js'

const eventSchema = z.object({ docId: z.string(), n: z.number() })

function setup(
	pubsub: Partial<Parameters<typeof createFn>[0]['pubsub']> = {},
	logger = quiet
) {
	const transport = memoryTransport()
	const factory = createFn({
		procedures: { public: os.$context<{ userId?: string }>() },
		default: 'public',
		logger: () => logger,
		pubsub: { transport, ...pubsub }
	})
	const bus = factory.createPubSub({
		name: 'doc.deltas',
		authFn: ({ context }) => context.userId === 'owner',
		channel: {
			subscribe: ({ input }) => `doc:${input.docId}`,
			publish: (event) => `doc:${event.docId}`
		},
		inputSchema: z.object({ docId: z.string() }),
		eventSchema,
		useBacklog: true
	})
	return { transport, factory, bus }
}

describe('reading a bus on the server', () => {
	test('listen skips the route and its authFn; readBacklog parses the envelope', async () => {
		const { bus } = setup()
		const controller = new AbortController()
		const events = await bus.listen(
			{ docId: 'a' },
			{ signal: controller.signal }
		)
		await bus.publish({ docId: 'a', n: 1 })
		expect((await events.next()).value).toEqual({ docId: 'a', n: 1 })
		controller.abort()
		expect((await events.next()).done).toBe(true)
		expect(await bus.readBacklog({ docId: 'a' })).toEqual([
			{ docId: 'a', n: 1 }
		])
		expect(await bus.readBacklog({ docId: 'b' })).toEqual([])
	})

	test('createPublisher can listen and read its backlog too', async () => {
		const { factory } = setup()
		const publisher = factory.createPublisher({
			name: 'frames',
			channel: ({ docId }) => `frames:${docId}`,
			eventSchema,
			useBacklog: true
		})
		const events = await publisher.listen({ docId: 'x' })
		await publisher.publish({ docId: 'x', n: 2 })
		expect((await events.next()).value).toEqual({ docId: 'x', n: 2 })
		await events.return(undefined)
		expect(await publisher.readBacklog({ docId: 'x' })).toEqual([
			{ docId: 'x', n: 2 }
		])
	})

	test('the memory transport records what was published, decoded', async () => {
		const { bus, transport } = setup()
		await bus.publish({ docId: 'a', n: 1 })
		await bus.publish({ docId: 'b', n: 2 })
		expect(transport.published('doc:b')).toEqual([
			{ channel: 'doc:b', event: { docId: 'b', n: 2 } }
		])
		expect(transport.published()).toHaveLength(2)
		transport.clearPublished()
		expect(transport.published()).toEqual([])
	})
})

describe('pub/sub access', () => {
	test('createPubSub needs an authFn, which receives the context', async () => {
		const { factory, bus } = setup()
		expect(() =>
			// @ts-expect-error who may subscribe must be said
			factory.createPubSub({
				name: 'open.bus',
				channel: 'open',
				inputSchema: z.object({}),
				eventSchema
			})
		).toThrow('needs an authFn')
		const refused = await call(
			bus.subscribe,
			{ docId: 'a' },
			{ context: { userId: 'other' } }
		)
		await expect(refused.next()).rejects.toThrow('You do not have access')
	})

	test('a scoped change bus treats its scope as the access decision', async () => {
		const { factory } = setup()
		const defineBus = defineScopedChangeBus(factory.createPubSub, {
			subscribe: (context) => context.userId ?? 'anonymous',
			publish: (event: { userId: string }) => event.userId
		})
		const bus = defineBus({
			name: 'user.changes',
			prefix: 'user',
			eventSchema: z.object({ userId: z.string() })
		})
		// Defining it would throw without an authFn; the route opens for any caller.
		const stream = await call(bus.subscribe, {}, { context: { userId: 'u1' } })
		await stream.return(undefined)
	})
})

describe('live runtime lifecycle', () => {
	test('maxStreamAgeMs ends a route stream cleanly', async () => {
		const { bus } = setup({ maxStreamAgeMs: 1 })
		const stream = await call(
			bus.subscribe,
			{ docId: 'a' },
			{ context: { userId: 'owner' } }
		)
		const received: unknown[] = []
		for await (const event of stream) received.push(event)
		expect(received).toEqual([])
	})

	test('a staggered drain closes every stream and resolves with the count', async () => {
		const { bus, factory } = setup()
		const streams = [
			await bus.listen({ docId: 'a' }),
			await bus.listen({ docId: 'b' })
		]
		const ended = streams.map(async (stream) => {
			for await (const _ of stream) {
				/* drained */
			}
		})
		await expect(factory.drainPubSubSubscribers({ overMs: 5 })).resolves.toBe(2)
		await Promise.all(ended)
		expect(factory.activePubSubSubscriberCount()).toBe(0)
	})

	test('the factory safePublish default turns a failed publish into a warning', async () => {
		const warnings: string[] = []
		const { bus } = setup(
			{ safePublish: true },
			{ ...quiet, warn: (message) => warnings.push(message) }
		)
		// @ts-expect-error an invalid event fails validation
		await expect(bus.publish({ docId: 'a' })).resolves.toBeUndefined()
		expect(warnings).toContain('pubsub.publish_failed')
	})
})
