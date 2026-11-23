import { describe, expect, expectTypeOf, test } from 'bun:test'
import type {
	InferRouterInputs as ORPCInferRouterInputs,
	InferRouterOutputs as ORPCInferRouterOutputs
} from '@orpc/server'
import { z } from 'zod'
import { call, ORPCError } from '@orpc/server'
import { createRouter, fnLive, transport } from '../../tests/fixture.js'
import { fnLivePatch } from './fn-live.js'

type AsyncIterableItem<T> = T extends AsyncIterable<infer U> ? U : never

const eventSchema = z.object({
	organizationId: z.string(),
	itemId: z.string(),
	kind: z.enum(['created', 'updated'])
})

const liveList = fnLive({
	name: 'test.liveList',
	method: 'GET',
	procedure: 'public',
	input: z.object({
		organizationId: z.string(),
		search: z.string().optional()
	}),
	handler: async ({ input }) => ({
		items: [{ id: input.organizationId, name: input.search ?? 'all' }],
		totalItems: 1
	}),
	live: {
		eventSchema,
		channel: ({ organizationId }) => `test.liveList:org:${organizationId}`
	}
})

const liveWithTransformer = fnLive({
	name: 'test.liveTransformer',
	method: 'GET',
	procedure: 'public',
	input: z.object({
		organizationId: z.string()
	}),
	output: z.object({
		items: z.array(z.object({ id: z.string() })),
		totalItems: z.number()
	}),
	handler: async () => ({
		items: [],
		totalItems: 0
	}),
	live: {
		eventSchema,
		channel: 'test.liveTransformer',
		stateSchema: z.object({
			items: z.array(z.object({ id: z.string() })),
			totalItems: z.number()
		}),
		coalesceMs: 25,
		shouldUpdate: ({ input, event }) =>
			input.organizationId === event.organizationId,
		transformerFn: ({ previous, event }) => {
			if (event.kind === 'updated') return undefined
			return {
				items: [...(previous?.items ?? []), { id: event.itemId }],
				totalItems: (previous?.totalItems ?? 0) + 1
			}
		}
	}
})

const liveRouter = createRouter({
	list: liveList.procedure,
	subscribeList: liveList.subscribe,
	listWithTransformer: liveWithTransformer.procedure,
	subscribeWithTransformer: liveWithTransformer.subscribe
})

describe('fnLive inference', () => {
	type Inputs = ORPCInferRouterInputs<typeof liveRouter>
	type Outputs = ORPCInferRouterOutputs<typeof liveRouter>

	test('procedure and subscribe use the same input', () => {
		expectTypeOf<Inputs['list']>().toEqualTypeOf<{
			organizationId: string
			search?: string | undefined
		}>()
		expectTypeOf<Inputs['subscribeList']>().toEqualTypeOf<Inputs['list']>()
	})

	test('subscribe yields the same output shape as procedure', () => {
		expectTypeOf<AsyncIterableItem<Outputs['subscribeList']>>().toEqualTypeOf<
			Outputs['list']
		>()
		expectTypeOf<Outputs['list']>().toEqualTypeOf<{
			items: { id: string; name: string }[]
			totalItems: number
		}>()
	})

	test('explicit output schema controls transformer return type', () => {
		expectTypeOf<Outputs['listWithTransformer']>().toEqualTypeOf<{
			items: { id: string }[]
			totalItems: number
		}>()
		expectTypeOf<
			AsyncIterableItem<Outputs['subscribeWithTransformer']>
		>().toEqualTypeOf<Outputs['listWithTransformer']>()
	})

	test('publish accepts raw event schema only', () => {
		type PublishEvent = Parameters<typeof liveList.publish>[0]
		expectTypeOf<PublishEvent>().toEqualTypeOf<{
			organizationId: string
			itemId: string
			kind: 'created' | 'updated'
		}>()

		const badEvent: PublishEvent = {
			organizationId: 'org_1',
			itemId: 'item_1',
			// @ts-expect-error kind must come from the raw event schema
			kind: 'x'
		}
		void badEvent
	})

	test('channel function derives channel names', () => {
		expect(
			liveList.getPublishChannelName({
				organizationId: 'org_1'
			} as never)
		).toBe('test.liveList:org:org_1')
	})
})

describe('fnLive runtime (memory transport)', () => {
	const live = fnLive({
		name: 'test.liveCounter',
		procedure: 'public',
		input: z.object({ organizationId: z.string() }),
		handler: async ({ input }) => ({
			organizationId: input.organizationId,
			count: 0
		}),
		live: {
			eventSchema,
			channel: ({ organizationId }) => `counter:${organizationId}`,
			stateSchema: z.object({ organizationId: z.string(), count: z.number() }),
			emitSchema: z.object({ bumped: z.string() }),
			shouldUpdate: ({ input, event }) =>
				input.organizationId === event.organizationId,
			transformerFn: ({ previous, event }) =>
				event.kind === 'updated' && previous
					? fnLivePatch(
							{ ...previous, count: previous.count + 1 },
							{ bumped: event.itemId }
						)
					: undefined
		}
	})

	test('streams the snapshot, then folds published events', async () => {
		const abort = new AbortController()
		const stream = await call(
			live.subscribe,
			{ organizationId: 'org_1' },
			{ context: {}, signal: abort.signal }
		)
		expect((await stream.next()).value).toEqual({
			organizationId: 'org_1',
			count: 0
		})
		const next = stream.next()
		await Bun.sleep(5)
		await live.publish({
			organizationId: 'org_1',
			itemId: 'a',
			kind: 'updated'
		})
		expect((await next).value).toEqual({ bumped: 'a' })
		abort.abort()
		await stream.return(undefined)
		expect(transport.listenerCount('counter:org_1')).toBe(0)
	})

	test('safePublish keeps a failed publish out of the publishing route', async () => {
		const safe = fnLive({
			name: 'test.liveSafe',
			procedure: 'public',
			input: z.object({}),
			handler: () => 0,
			live: { eventSchema, channel: 'safe', safePublish: true }
		})
		const invalid = {} as Parameters<typeof safe.publish>[0]
		await expect(safe.publish(invalid)).resolves.toBeUndefined()
		await expect(live.publish(invalid)).rejects.toThrow()
	})

	test('a rerun that changes nothing sends nothing', async () => {
		let version = 0
		let runs = 0
		let reran = () => {}
		const firstRerun = new Promise<void>((resolve) => {
			reran = resolve
		})
		const rerunning = fnLive({
			name: 'test.liveRerun',
			procedure: 'public',
			input: z.object({}),
			handler: () => {
				if (++runs === 2) reran()
				return { version }
			},
			live: { eventSchema, channel: 'rerun' }
		})
		const stream = await call(rerunning.subscribe, {}, { context: {} })
		expect((await stream.next()).value).toEqual({ version: 0 })
		const next = stream.next()
		const event = { organizationId: 'o', itemId: 'i', kind: 'updated' } as const
		await rerunning.publish(event)
		await firstRerun
		version = 1
		await rerunning.publish(event)
		expect((await next).value).toEqual({ version: 1 })
		await stream.return(undefined)
	})

	test('a failing initial snapshot releases the subscription', async () => {
		const failing = fnLive({
			name: 'test.liveFailing',
			procedure: 'public',
			input: z.object({ id: z.string() }),
			handler: async () => {
				throw new ORPCError('NOT_FOUND')
			},
			live: { eventSchema, channel: 'failing' }
		})
		const stream = await call(failing.subscribe, { id: 'x' }, { context: {} })
		await expect(stream.next()).rejects.toThrow(ORPCError)
		await Bun.sleep(5)
		expect(transport.listenerCount('failing')).toBe(0)
	})

	test('coalesced applyBatch short-circuits shouldUpdate on the first matching event', async () => {
		let checks = 0
		let value = 0
		const shortCircuit = fnLive({
			name: 'test.liveShortCircuit',
			procedure: 'public',
			input: z.object({}),
			handler: () => ({ value }),
			live: {
				eventSchema,
				channel: 'short-circuit',
				coalesceMs: 15,
				shouldUpdate: () => {
					checks++
					return true
				}
			}
		})
		const stream = await call(shortCircuit.subscribe, {}, { context: {} })
		expect((await stream.next()).value).toEqual({ value: 0 })
		const next = stream.next()
		value = 1
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				shortCircuit.publish({
					organizationId: 'o',
					itemId: String(i),
					kind: 'updated'
				})
			)
		)
		expect((await next).value).toEqual({ value: 1 })
		expect(checks).toBe(1)
		await stream.return(undefined)
	})

	test('subscribe and reruns run middleware, input parsing, guards and extras once while validating output', async () => {
		const { os } = await import('@orpc/server')
		const { createFn } = await import('../index.js')
		const { memoryTransport } = await import('./memory.js')
		const { quiet } = await import('../../tests/fixture.js')

		let middlewareRuns = 0
		let inputParses = 0
		let guardRuns = 0
		let extrasRuns = 0
		let version = 1

		const factory = createFn({
			procedures: {
				public: os.use(({ next }) => {
					middlewareRuns++
					return next({ context: { middlewareRuns } })
				})
			},
			default: 'public',
			logger: () => quiet,
			extras: () => {
				extrasRuns++
				return { tag: 'v' }
			},
			guards: {
				allow: () => {
					guardRuns++
					return true
				}
			},
			pubsub: { transport: memoryTransport() }
		})

		const live = factory.fnLive({
			name: 'test.oncePipeline',
			allow: true,
			input: z.object({
				n: z.string().transform((s) => {
					inputParses++
					return Number(s)
				})
			}),
			output: z.string().transform((s) => s.toUpperCase()),
			handler: ({ input, tag }) => `${tag}${input.n}:${version}`,
			live: { eventSchema: z.object({}), channel: 'once-pipeline' }
		})

		const stream = await call(live.subscribe, { n: '7' })
		expect((await stream.next()).value).toBe('V7:1')
		const next = stream.next()
		version = 2
		await live.publish({})
		expect((await next).value).toBe('V7:2')
		expect([middlewareRuns, inputParses, guardRuns, extrasRuns]).toEqual([
			1, 1, 1, 1
		])
		await stream.return(undefined)
		await factory.shutdown()
	})
})
