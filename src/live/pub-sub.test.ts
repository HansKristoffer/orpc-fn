import { describe, test, expect, expectTypeOf } from 'bun:test'
import type {
	InferRouterInputs as ORPCInferRouterInputs,
	InferRouterOutputs as ORPCInferRouterOutputs
} from '@orpc/server'
import { z } from 'zod'
import { createPubSub, createRouter, readMeta } from '../../tests/fixture.js'
import { createBoundedEventQueue, createSubscriberDelivery } from './pub-sub.js'

type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T
type AsyncIterableItem<T> = T extends AsyncIterable<infer U> ? U : never

// ═══════════════════════════════════════════════════════════════════════════
// Test PubSub Definitions
// ═══════════════════════════════════════════════════════════════════════════

// Basic pubsub with dynamic channel
const orderUpdates = createPubSub({
	name: 'order.updates',
	channel: ({ orderId }) => `order:${orderId}`,
	inputSchema: z.object({ orderId: z.string() }),
	eventSchema: z.object({
		orderId: z.string(),
		status: z.enum(['pending', 'processing', 'completed']),
		updatedAt: z.string()
	}),
	filterFn: ({ input, data }) => data.orderId === input.orderId
})

// Static channel pubsub
const systemAlerts = createPubSub({
	name: 'system.alerts',
	channel: 'system:alerts',
	inputSchema: z.object({}),
	eventSchema: z.object({
		level: z.enum(['info', 'warning', 'error']),
		message: z.string()
	}),
	procedure: 'public'
})

// With backlog enabled
const chatMessages = createPubSub({
	name: 'chat.messages',
	channel: ({ roomId }) => `chat:${roomId}`,
	inputSchema: z.object({ roomId: z.string() }),
	eventSchema: z.object({
		roomId: z.string(),
		userId: z.string(),
		message: z.string(),
		timestamp: z.number()
	}),
	useBacklog: true,
	backlogSize: 100,
	backlogTtl: 60
})

// With authFn: true (allow all)
const publicWithAuthTrue = createPubSub({
	name: 'public.auth.true',
	channel: 'public:auth',
	inputSchema: z.object({ resourceId: z.string() }),
	eventSchema: z.object({ data: z.string() }),
	authFn: true
})

// With authFn: function (protected - has full context)
const protectedWithAuthFn = createPubSub({
	name: 'protected.auth.fn',
	channel: ({ resourceId }) => `protected:${resourceId}`,
	inputSchema: z.object({ resourceId: z.string() }),
	eventSchema: z.object({ resourceId: z.string(), data: z.string() }),
	authFn: async ({ input, ctx }) => {
		// ctx.user is guaranteed in protected context
		return ctx.user.id === input.resourceId
	}
})

// With authFn: function (public - partial context)
const publicWithAuthFn = createPubSub({
	name: 'public.auth.fn',
	channel: 'public:conditional',
	inputSchema: z.object({ token: z.string() }),
	eventSchema: z.object({ message: z.string() }),
	procedure: 'public',
	authFn: ({ input, ctx }) => {
		// ctx.user may be undefined in public context
		if (ctx.user) {
			return true
		}
		// Allow if token matches
		return input.token === 'valid-token'
	}
})

// With authFn: sync function (compile-time check)
createPubSub({
	name: 'sync.auth.fn',
	channel: 'sync:auth',
	inputSchema: z.object({ allowed: z.boolean() }),
	eventSchema: z.object({ value: z.number() }),
	authFn: ({ input }) => input.allowed
})

const orderUpdatesRouter = createRouter({ subscribe: orderUpdates.subscribe })
const chatRouter = createRouter({ subscribe: chatMessages.subscribe })
const systemAlertsRouter = createRouter({ subscribe: systemAlerts.subscribe })

// ═══════════════════════════════════════════════════════════════════════════
// Type Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('subscribe procedure schema inference', () => {
	type Inputs = ORPCInferRouterInputs<typeof orderUpdatesRouter>
	type ChatInputs = ORPCInferRouterInputs<typeof chatRouter>
	type SystemInputs = ORPCInferRouterInputs<typeof systemAlertsRouter>

	test('orderUpdates subscribe has correct input type', () => {
		expectTypeOf<Inputs['subscribe']>().toEqualTypeOf<{ orderId: string }>()
	})

	test('chatMessages subscribe infers input', () => {
		expectTypeOf<ChatInputs['subscribe']>().toEqualTypeOf<{ roomId: string }>()
	})

	test('systemAlerts subscribe infers empty input', () => {
		const _input: SystemInputs['subscribe'] = {}
		void _input
	})
})

describe('subscribe procedure output inference', () => {
	type Outputs = ORPCInferRouterOutputs<typeof orderUpdatesRouter>
	type ChatOutputs = ORPCInferRouterOutputs<typeof chatRouter>
	type SystemOutputs = ORPCInferRouterOutputs<typeof systemAlertsRouter>

	type OrderSubscribeOutput = Outputs['subscribe']
	type OrderEvent = AsyncIterableItem<OrderSubscribeOutput>
	const _orderSubscribeIsAsync: Assert<
		OrderSubscribeOutput extends AsyncIterable<unknown> ? true : false
	> = true
	const _orderEventNotAny: Assert<
		IsAny<OrderEvent> extends false ? true : false
	> = true

	type ChatSubscribeOutput = ChatOutputs['subscribe']
	type ChatEvent = AsyncIterableItem<ChatSubscribeOutput>
	const _chatSubscribeIsAsync: Assert<
		ChatSubscribeOutput extends AsyncIterable<unknown> ? true : false
	> = true
	const _chatEventNotAny: Assert<
		IsAny<ChatEvent> extends false ? true : false
	> = true

	type AlertsSubscribeOutput = SystemOutputs['subscribe']
	type AlertEvent = AsyncIterableItem<AlertsSubscribeOutput>
	const _alertsSubscribeIsAsync: Assert<
		AlertsSubscribeOutput extends AsyncIterable<unknown> ? true : false
	> = true
	const _alertEventNotAny: Assert<
		IsAny<AlertEvent> extends false ? true : false
	> = true

	void [
		_orderSubscribeIsAsync,
		_orderEventNotAny,
		_chatSubscribeIsAsync,
		_chatEventNotAny,
		_alertsSubscribeIsAsync,
		_alertEventNotAny
	]

	test('orderUpdates subscribe yields correct event type', () => {
		expectTypeOf<OrderEvent>().toEqualTypeOf<{
			orderId: string
			status: 'pending' | 'processing' | 'completed'
			updatedAt: string
		}>()
	})

	test('chatMessages subscribe yields correct event type', () => {
		expectTypeOf<ChatEvent>().toEqualTypeOf<{
			roomId: string
			userId: string
			message: string
			timestamp: number
		}>()
	})

	test('systemAlerts subscribe yields correct event type', () => {
		expectTypeOf<AlertEvent>().toEqualTypeOf<{
			level: 'info' | 'warning' | 'error'
			message: string
		}>()
	})
})

describe('publish function types', () => {
	test('orderUpdates publish accepts correct event data', () => {
		type PublishParam = Parameters<typeof orderUpdates.publish>[0]

		expectTypeOf<PublishParam>().toEqualTypeOf<{
			orderId: string
			status: 'pending' | 'processing' | 'completed'
			updatedAt: string
		}>()
	})

	test('publish parameter types are strict (compile-time)', () => {
		type PublishParam = Parameters<typeof orderUpdates.publish>[0]

		const _ok: PublishParam = {
			orderId: '123',
			status: 'pending',
			updatedAt: 'now'
		}
		void _ok

		const _invalidStatus: PublishParam = {
			orderId: '123',
			// @ts-expect-error invalid status enum
			status: 'nope',
			updatedAt: 'now'
		}
		void _invalidStatus

		// @ts-expect-error missing required field
		const _missingUpdatedAt: PublishParam = {
			orderId: '123',
			status: 'pending'
		}
		void _missingUpdatedAt
	})

	test('orderUpdates publish returns Promise<void>', () => {
		type PublishReturn = ReturnType<typeof orderUpdates.publish>
		expectTypeOf<PublishReturn>().toEqualTypeOf<Promise<void>>()
	})

	test('systemAlerts publish accepts correct event data', () => {
		type PublishParam = Parameters<typeof systemAlerts.publish>[0]

		expectTypeOf<PublishParam>().toEqualTypeOf<{
			level: 'info' | 'warning' | 'error'
			message: string
		}>()
	})
})

describe('getChannelName function types', () => {
	test('orderUpdates getChannelName accepts input params', () => {
		type Param = Parameters<typeof orderUpdates.getChannelName>[0]

		expectTypeOf<{ orderId: string }>().toMatchTypeOf<Param>()
	})

	test('getChannelName returns string', () => {
		type ReturnType = globalThis.ReturnType<typeof orderUpdates.getChannelName>
		expectTypeOf<ReturnType>().toEqualTypeOf<string>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Functional Tests (getChannelName - no Redis needed)
// ═══════════════════════════════════════════════════════════════════════════

describe('getChannelName functionality', () => {
	test('dynamic channel resolves correctly', () => {
		const channel = orderUpdates.getChannelName({ orderId: '123' })
		expect(channel).toBe('order:123')
	})

	test('getChannelName accepts event-shaped object', () => {
		const channel = orderUpdates.getChannelName({
			orderId: '123',
			status: 'pending',
			updatedAt: 'now'
		})
		expect(channel).toBe('order:123')
	})

	test('static channel always returns same value', () => {
		const channel1 = systemAlerts.getChannelName({})
		const channel2 = systemAlerts.getChannelName({ level: 'info' })

		expect(channel1).toBe('system:alerts')
		expect(channel2).toBe('system:alerts')
	})
})

describe('subscribe procedure metadata', () => {
	test('subscribe procedure records its name in fn meta', () => {
		expect(readMeta(orderUpdates.subscribe).name).toBe('order.updates')
		expect(readMeta(systemAlerts.subscribe).name).toBe('system.alerts')
		expect(readMeta(systemAlerts.subscribe).procedure).toBe('public')
		expect(readMeta(chatMessages.subscribe).name).toBe('chat.messages')
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// authFn Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('authFn type safety', () => {
	test('protected authFn receives correct input type', () => {
		// This compiles because authFn receives typed input
		createPubSub({
			name: 'test.input.type',
			channel: 'test',
			inputSchema: z.object({ userId: z.string(), orgId: z.string() }),
			eventSchema: z.object({ data: z.string() }),
			authFn: ({ input }) => {
				// TypeScript should know these exist
				const _userId: string = input.userId
				const _orgId: string = input.orgId
				void _userId
				void _orgId
				return true
			}
		})
	})

	test('protected authFn receives the protected context', () => {
		createPubSub({
			name: 'test.protected.ctx',
			channel: 'test',
			inputSchema: z.object({}),
			eventSchema: z.object({ data: z.string() }),
			// procedure defaults to 'protected', so ctx.user is guaranteed
			authFn: ({ ctx }) => {
				const _userId = ctx.user.id
				const _locale = ctx.user.locale
				void _userId
				void _locale
				return true
			}
		})
	})

	test('public authFn receives the public context', () => {
		createPubSub({
			name: 'test.public.ctx',
			channel: 'test',
			inputSchema: z.object({}),
			eventSchema: z.object({ data: z.string() }),
			procedure: 'public',
			authFn: ({ ctx }) => {
				// ctx.user may be undefined in public context
				if (ctx.user) {
					const _userId = ctx.user.id
					void _userId
				}
				return true
			}
		})
	})
})

describe('authFn with routers', () => {
	const authTrueRouter = createRouter({
		subscribe: publicWithAuthTrue.subscribe
	})
	const protectedAuthRouter = createRouter({
		subscribe: protectedWithAuthFn.subscribe
	})
	const publicAuthRouter = createRouter({
		subscribe: publicWithAuthFn.subscribe
	})

	type AuthTrueInputs = ORPCInferRouterInputs<typeof authTrueRouter>
	type ProtectedAuthInputs = ORPCInferRouterInputs<typeof protectedAuthRouter>
	type PublicAuthInputs = ORPCInferRouterInputs<typeof publicAuthRouter>

	test('authFn: true router has correct input type', () => {
		expectTypeOf<AuthTrueInputs['subscribe']>().toEqualTypeOf<{
			resourceId: string
		}>()
	})

	test('protected authFn router has correct input type', () => {
		expectTypeOf<ProtectedAuthInputs['subscribe']>().toEqualTypeOf<{
			resourceId: string
		}>()
	})

	test('public authFn router has correct input type', () => {
		expectTypeOf<PublicAuthInputs['subscribe']>().toEqualTypeOf<{
			token: string
		}>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Filter Function Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('filterFn configuration', () => {
	test('async filterFn is valid', () => {
		const pubsub = createPubSub({
			name: 'test.async.filter',
			channel: 'test:asyncfilter',
			inputSchema: z.object({ userId: z.string() }),
			eventSchema: z.object({ userId: z.string(), data: z.string() }),
			filterFn: async ({ input, data }) => {
				await Promise.resolve()
				return data.userId === input.userId
			}
		})

		expectTypeOf(pubsub.subscribe).toMatchTypeOf<object>()
	})

	test('filterFn receives correct types', () => {
		createPubSub({
			name: 'test.filter.types',
			channel: 'test:filtertypes',
			inputSchema: z.object({
				orgId: z.string(),
				teamIds: z.array(z.string())
			}),
			eventSchema: z.object({
				orgId: z.string(),
				teamId: z.string(),
				payload: z.object({ value: z.number() })
			}),
			filterFn: ({ input, data }) => {
				// TypeScript should know the types
				const _orgMatch: boolean = data.orgId === input.orgId
				const _teamMatch: boolean = input.teamIds.includes(data.teamId)
				const _value: number = data.payload.value
				void _orgMatch
				void _teamMatch
				void _value
				return _orgMatch && _teamMatch
			}
		})
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Complex Schema Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('complex schema handling', () => {
	test('optional fields in schemas', () => {
		const pubsub = createPubSub({
			name: 'test.optional.fields',
			channel: 'test:optional',
			inputSchema: z.object({
				required: z.string(),
				optional: z.string().optional()
			}),
			eventSchema: z.object({
				data: z.string(),
				extra: z.number().optional()
			})
		})

		type PublishParam = Parameters<typeof pubsub.publish>[0]

		// Required only
		const _minimal: PublishParam = { data: 'test' }
		void _minimal

		// With optional
		const _full: PublishParam = { data: 'test', extra: 42 }
		void _full
	})

	test('union types in event schema', () => {
		const pubsub = createPubSub({
			name: 'test.union.event',
			channel: 'test:union',
			inputSchema: z.object({}),
			eventSchema: z.discriminatedUnion('type', [
				z.object({ type: z.literal('created'), id: z.string() }),
				z.object({
					type: z.literal('updated'),
					id: z.string(),
					changes: z.record(z.string(), z.unknown())
				}),
				z.object({ type: z.literal('deleted'), id: z.string() })
			])
		})

		type PublishParam = Parameters<typeof pubsub.publish>[0]

		const _created: PublishParam = { type: 'created', id: '1' }
		const _updated: PublishParam = {
			type: 'updated',
			id: '1',
			changes: { name: 'new' }
		}
		const _deleted: PublishParam = { type: 'deleted', id: '1' }

		void _created
		void _updated
		void _deleted
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Message Queue Bounds Tests (the real subscriber queue - createBoundedEventQueue)
// ═══════════════════════════════════════════════════════════════════════════

describe('bounded message queue (createBoundedEventQueue)', () => {
	const MAX_QUEUE_SIZE = 1000

	type Event = { kind: 'durable' | 'pubsubDrop'; n: number }
	const durable = (n: number): Event => ({ kind: 'durable', n })

	const drainAll = (queue: { dequeue: () => Event | undefined }): Event[] => {
		const drained: Event[] = []
		for (
			let next = queue.dequeue();
			next !== undefined;
			next = queue.dequeue()
		) {
			drained.push(next)
		}
		return drained
	}

	test('queue does not drop when under max size', () => {
		let droppedCount = 0
		const queue = createBoundedEventQueue<Event>({
			maxSize: MAX_QUEUE_SIZE,
			onDrop: () => droppedCount++
		})

		for (let i = 0; i < 100; i++) queue.enqueue(durable(i))

		expect(queue.length).toBe(100)
		expect(droppedCount).toBe(0)
	})

	test('without an overflowMarker the queue enforces max size by dropping oldest', () => {
		let droppedCount = 0
		const queue = createBoundedEventQueue<Event>({
			maxSize: MAX_QUEUE_SIZE,
			onDrop: () => droppedCount++
		})

		for (let i = 0; i < MAX_QUEUE_SIZE + 11; i++) queue.enqueue(durable(i))

		expect(queue.length).toBe(MAX_QUEUE_SIZE)
		expect(droppedCount).toBe(11)
		const drained = drainAll(queue)
		expect(drained[0]?.n).toBe(11) // 0-10 were dropped
		expect(drained[drained.length - 1]?.n).toBe(MAX_QUEUE_SIZE + 10)
	})

	test('first overflow enqueues the marker INSTEAD of the dropped event (§5)', () => {
		let droppedCount = 0
		const queue = createBoundedEventQueue<Event>({
			maxSize: MAX_QUEUE_SIZE,
			createOverflowMarker: () => ({ kind: 'pubsubDrop', n: -1 }),
			onDrop: () => droppedCount++
		})

		for (let i = 0; i < MAX_QUEUE_SIZE; i++) queue.enqueue(durable(i))
		expect(droppedCount).toBe(0)

		// One past max → drops oldest and enqueues the marker, NOT the new event.
		queue.enqueue(durable(MAX_QUEUE_SIZE))
		expect(queue.length).toBe(MAX_QUEUE_SIZE)
		expect(droppedCount).toBe(1)

		const drained = drainAll(queue)
		expect(drained[drained.length - 1]?.kind).toBe('pubsubDrop')
		// The new durable event was NOT enqueued (the marker stands in for the loss).
		expect(
			drained.some((e) => e.kind === 'durable' && e.n === MAX_QUEUE_SIZE)
		).toBe(false)
	})

	test('a sustained overflow enqueues exactly ONE marker per episode (no marker storm)', () => {
		let markersCreated = 0
		let droppedCount = 0
		const queue = createBoundedEventQueue<Event>({
			maxSize: MAX_QUEUE_SIZE,
			createOverflowMarker: () => {
				markersCreated++
				return { kind: 'pubsubDrop', n: -1 }
			},
			onDrop: () => droppedCount++
		})

		// Fill, then keep publishing 50 more into the full queue.
		for (let i = 0; i < MAX_QUEUE_SIZE + 50; i++) queue.enqueue(durable(i))

		expect(queue.length).toBe(MAX_QUEUE_SIZE)
		expect(markersCreated).toBe(1)
		expect(droppedCount).toBe(50)

		const drained = drainAll(queue)
		// Exactly ONE marker queued for the whole episode - its resync covers every
		// drop before it is delivered. The storm bug converged this to 1000 markers.
		expect(drained.filter((e) => e.kind === 'pubsubDrop')).toHaveLength(1)
		// Newest events still arrive after the marker (oldest were dropped instead).
		expect(drained[drained.length - 1]?.n).toBe(MAX_QUEUE_SIZE + 49)
	})

	test('the pending marker itself is never displaced by later overflows', () => {
		const queue = createBoundedEventQueue<Event>({
			maxSize: 3,
			createOverflowMarker: () => ({ kind: 'pubsubDrop', n: -1 })
		})

		queue.enqueue(durable(0))
		queue.enqueue(durable(1))
		queue.enqueue(durable(2))
		// Overflow: drop 0, enqueue marker → [1, 2, M]
		queue.enqueue(durable(3))
		// Keep overflowing until every pre-marker event is displaced; the marker
		// must survive at the FRONT, not be shifted out.
		queue.enqueue(durable(4)) // [2, M, 4]
		queue.enqueue(durable(5)) // [M, 4, 5]
		queue.enqueue(durable(6)) // [M, 5, 6]

		const drained = drainAll(queue)
		expect(drained.map((e) => e.kind)).toEqual([
			'pubsubDrop',
			'durable',
			'durable'
		])
		expect(drained.filter((e) => e.kind === 'pubsubDrop')).toHaveLength(1)
	})

	test('after the subscriber drains, a NEW overflow episode enqueues a fresh marker', () => {
		let markersCreated = 0
		const queue = createBoundedEventQueue<Event>({
			maxSize: 10,
			createOverflowMarker: () => {
				markersCreated++
				return { kind: 'pubsubDrop', n: -1 }
			}
		})

		// Episode 1: overflow with extra publishes → exactly one marker.
		for (let i = 0; i < 15; i++) queue.enqueue(durable(i))
		expect(markersCreated).toBe(1)
		const firstDrain = drainAll(queue)
		expect(firstDrain.filter((e) => e.kind === 'pubsubDrop')).toHaveLength(1)
		expect(queue.length).toBe(0)

		// Episode 2: dequeuing the marker closed the episode - a fresh overflow
		// enqueues a fresh marker.
		for (let i = 0; i < 11; i++) queue.enqueue(durable(i))
		expect(markersCreated).toBe(2)
		const secondDrain = drainAll(queue)
		expect(secondDrain.filter((e) => e.kind === 'pubsubDrop')).toHaveLength(1)
	})

	test('a null overflowMarker falls back to enqueuing the event itself', () => {
		const queue = createBoundedEventQueue<Event>({
			maxSize: MAX_QUEUE_SIZE,
			createOverflowMarker: () => null
		})

		for (let i = 0; i <= MAX_QUEUE_SIZE; i++) queue.enqueue(durable(i))

		expect(queue.length).toBe(MAX_QUEUE_SIZE)
		const drained = drainAll(queue)
		expect(drained[drained.length - 1]?.n).toBe(MAX_QUEUE_SIZE)
		expect(drained.some((e) => e.kind === 'pubsubDrop')).toBe(false)
	})
})

describe('createSubscriberDelivery', () => {
	const take = async (events: AsyncGenerator<number>, count: number) => {
		const out: number[] = []
		for (let i = 0; i < count; i++)
			out.push((await events.next()).value as number)
		return out
	}

	test('a slow async filter keeps arrival order', async () => {
		const delivery = createSubscriberDelivery<number>({
			maxSize: 10,
			// Earlier events take longer to filter.
			accept: (n) => Bun.sleep(5 - n).then(() => n !== 2),
			onFilterError: () => {},
			onDrop: () => {}
		})
		for (const n of [0, 1, 2, 3, 4]) delivery.push(n)
		expect(await take(delivery.events, 4)).toEqual([0, 1, 3, 4])
	})

	test('pending work is bounded and the marker skips the filter', async () => {
		let drops = 0
		const filtered: number[] = []
		const delivery = createSubscriberDelivery<number>({
			maxSize: 2,
			accept: (n) => {
				filtered.push(n)
				return n >= 0
			},
			overflowMarker: () => -1,
			onFilterError: () => {},
			onDrop: () => drops++
		})
		for (const n of [0, 1, 2, 3]) delivery.push(n)
		expect(await take(delivery.events, 2)).toEqual([-1, 3])
		// Dropped events never reach the filter; the marker never does.
		expect(filtered).toEqual([3])
		expect(drops).toBe(2)
	})

	test('close ends a parked read and is idempotent', async () => {
		const delivery = createSubscriberDelivery<number>({
			maxSize: 2,
			onFilterError: () => {},
			onDrop: () => {}
		})
		const pending = delivery.events.next()
		delivery.close()
		delivery.close()
		delivery.push(1)
		expect((await pending).done).toBe(true)
	})
})
