import { describe, expect, expectTypeOf, test } from 'bun:test'
import { call, ORPCError, os } from '@orpc/server'
import { z } from 'zod'
import {
	createPubSub,
	fnLive,
	quiet,
	transport,
	user
} from '../../tests/fixture.js'
import { createFn } from '../index.js'
import { memoryTransport } from './memory.js'
import { defineScopedChangeBus } from './scoped-change-bus.js'

const defineChangeBus = defineScopedChangeBus(createPubSub, {
	subscribe: (context) => {
		const organizationId = context.support?.organizationId
		if (!organizationId) throw new ORPCError('UNAUTHORIZED')
		return organizationId
	},
	publish: (event: { organizationId: string }) => event.organizationId
})

const dealChanges = defineChangeBus({
	name: 'test.dealChanges',
	procedure: 'protected',
	prefix: 'deal:change',
	// No inputSchema: a bus without input defaults to z.object({}).
	eventSchema: z.object({ organizationId: z.string(), dealId: z.string() })
})

// Resolves with the first payload published on a channel.
async function nextPayload(channel: string) {
	let resolve: (payload: string) => void = () => {}
	const received = new Promise<string>((r) => {
		resolve = r
	})
	const stop = await transport.subscribe(channel, resolve)
	return received.finally(stop)
}

const supportContext = (organizationId: string) => ({
	user: user(),
	support: { sessionId: 's1', organizationId }
})

describe('defineScopedChangeBus', () => {
	test('publishes to and subscribes on prefix:scope', async () => {
		const payload = nextPayload('deal:change:org_1')
		await dealChanges.publish({ organizationId: 'org_1', dealId: 'd1' })
		expect(await payload).toContain('d1')
		expect(
			dealChanges.getSubscriptionChannelName({
				input: {},
				context: supportContext('org_1')
			})
		).toBe('deal:change:org_1')
	})

	test('a bus without inputSchema takes no input', () => {
		expectTypeOf<
			Parameters<typeof dealChanges.getSubscriptionChannelName>[0]['input']
		>().toEqualTypeOf<Record<string, never>>()
	})

	test('channelFor names the namespaced channel of a scope', async () => {
		const memory = memoryTransport()
		const app = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => quiet,
			pubsub: { transport: memory, namespace: 'app' }
		})
		const statusBus = defineScopedChangeBus(app.createPubSub, {
			subscribe: () => 'org_1',
			publish: (event: { organizationId: string }) => event.organizationId
		})({
			name: 'test.status',
			prefix: 'status',
			eventSchema: z.object({ organizationId: z.string(), stage: z.string() }),
			useBacklog: true
		})
		await statusBus.publish({ organizationId: 'org_1', stage: 'ready' })
		const channel = statusBus.channelFor({ organizationId: 'org_1' })
		expect(channel).toBe('app:status:org_1')
		expect(await memory.readBacklog(channel)).toHaveLength(1)
		await app.shutdown()
	})

	test('a context without a scope is refused', async () => {
		const open = async () => {
			const stream = await call(
				dealChanges.subscribe,
				{},
				{ context: { user: user() } }
			)
			return stream.next()
		}
		await expect(open()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
	})

	test('publishing is safe by default and strict on request', async () => {
		const invalid = { organizationId: 'org_1' } as unknown as Parameters<
			typeof dealChanges.publish
		>[0]
		await expect(dealChanges.publish(invalid)).resolves.toBeUndefined()

		const strict = defineChangeBus({
			name: 'test.strictChanges',
			procedure: 'support',
			prefix: 'strict:change',
			safePublish: false,
			inputSchema: z.object({}),
			eventSchema: z.object({ organizationId: z.string() })
		})
		await expect(
			strict.publish({} as unknown as { organizationId: string })
		).rejects.toThrow()
	})

	test('an fnLive shares the bus channel', async () => {
		const list = fnLive({
			name: 'test.dealList',
			input: z.object({}),
			handler: () => ['d1'],
			live: {
				eventSchema: z.object({
					organizationId: z.string(),
					dealId: z.string()
				}),
				channel: dealChanges.channel
			}
		})
		expect(
			list.getPublishChannelName({ organizationId: 'org_2', dealId: 'd2' })
		).toBe('deal:change:org_2')
	})

	test('events must carry what the scope reads', () => {
		defineChangeBus({
			name: 'test.unscoped',
			procedure: 'support',
			prefix: 'unscoped',
			inputSchema: z.object({}),
			// @ts-expect-error the scope needs organizationId on every event
			eventSchema: z.object({ dealId: z.string() })
		})
		expectTypeOf<Parameters<typeof dealChanges.publish>[0]>().toEqualTypeOf<{
			organizationId: string
			dealId: string
		}>()
	})
})
