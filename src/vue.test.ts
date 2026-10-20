import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ORPCError } from '@orpc/client'
import { focusManager } from '@tanstack/vue-query'
import { nextTick, ref } from 'vue'
import {
	useApiClient,
	useInvalidationStream,
	useLiveQuery,
	useOrpcSubscription,
	useQueryErrorMessage
} from './vue.js'
import { createOrpcMock, createTestStream, withOrpcApp } from './vue/testing.js'

type Item = { id: string; name: string }

/** Utils shaped like `createTanstackQueryUtils` output for one procedure. */
function itemUtils(fetchItem: (id: string) => Promise<Item>) {
	const stream = createTestStream<Item>()
	const utils = {
		item: {
			key: () => ['item'],
			get: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ['item', input.id],
					queryFn: () => fetchItem(input.id)
				})
			},
			watch: { call: stream.subscribe }
		}
	}
	return { utils, stream }
}

afterEach(() => focusManager.setFocused(undefined))

describe('useOrpcSubscription', () => {
	test('streams from the provided utils and closes when the scope stops', async () => {
		const stream = createTestStream<number>()
		const utils = { counter: { watch: { call: stream.subscribe } } }
		const app = withOrpcApp(
			() =>
				useApiClient<typeof utils>().useSubscription(
					{ from: 1 },
					(input, o, opts) => o.counter.watch.call(input, opts)
				),
			{ utils }
		)
		const connection = await stream.opened()
		expect(connection.input).toEqual({ from: 1 })
		await stream.push(1)
		await stream.push(2)
		expect(app.result.events.value).toEqual([1, 2])
		expect(app.result.status.value).toBe('connected')

		app.stop()
		expect(connection.closed).toBe(true)
	})

	test('a hidden page closes the stream and a visible one reopens it', async () => {
		const stream = createTestStream<number>()
		const app = withOrpcApp(() =>
			useOrpcSubscription(
				undefined,
				(_input, _o, opts) => stream.subscribe(opts),
				{
					orpc: {}
				}
			)
		)
		const first = await stream.opened(1)
		focusManager.setFocused(false)
		await nextTick()
		expect(first.closed).toBe(true)

		focusManager.setFocused(true)
		await stream.opened(2)
		app.stop()
	})

	test('an input change reconnects with the new input', async () => {
		const stream = createTestStream<number>()
		const input = ref('a')
		const app = withOrpcApp(() =>
			useOrpcSubscription(
				input,
				(value, _o, opts) => stream.subscribe(value, opts),
				{
					orpc: {}
				}
			)
		)
		const first = await stream.opened(1)
		input.value = 'b'
		const second = await stream.opened(2)
		expect(first.closed).toBe(true)
		expect(second.input).toBe('b')
		app.stop()
	})

	test('immediate: false waits for an explicit connect', async () => {
		const stream = createTestStream<number>()
		const app = withOrpcApp(() =>
			useOrpcSubscription(undefined, (_i, _o, opts) => stream.subscribe(opts), {
				orpc: {},
				immediate: false
			})
		)
		expect(stream.connections).toHaveLength(0)
		await app.result.connect()
		expect(stream.connections).toHaveLength(1)
		app.stop()
	})
})

describe('useLiveQuery', () => {
	test('the HTTP query seeds the cache and stream snapshots overwrite it', async () => {
		const { utils, stream } = itemUtils(async (id) => ({ id, name: 'seed' }))
		const app = withOrpcApp(
			() =>
				useLiveQuery(
					{ id: '1' },
					(input, o: typeof utils) => o.item.get.queryOptions({ input }),
					(input, o, opts) => o.item.watch.call(input, opts)
				),
			{ utils }
		)
		await app.result.suspense()
		expect(app.result.data.value).toEqual({ id: '1', name: 'seed' })

		await stream.opened()
		await stream.push({ id: '1', name: 'live' })
		expect(app.queryClient.getQueryData<Item>(['item', '1'])).toEqual({
			id: '1',
			name: 'live'
		})
		expect(app.result.liveStatus.value).toBe('connected')
		app.stop()
	})

	test('an event from the previous input is not written into the new key', async () => {
		const { utils, stream } = itemUtils(async (id) => ({ id, name: 'seed' }))
		const input = ref({ id: '1' })
		const onEvent = mock(() => {})
		const app = withOrpcApp(
			() =>
				useLiveQuery(
					input,
					(value, o: typeof utils) => o.item.get.queryOptions({ input: value }),
					(value, o, opts) => o.item.watch.call(value, opts),
					{ onEvent }
				),
			{ utils }
		)
		const first = await stream.opened(1)
		input.value = { id: '2' }
		await first.push({ id: '1', name: 'stale' })
		expect(app.queryClient.getQueryData(['item', '2'])).toBeUndefined()
		expect(onEvent).not.toHaveBeenCalled()
		app.stop()
	})

	test('mergeSeed reconciles a seed that resolves after stream events', async () => {
		let resolveSeed!: (item: Item) => void
		const { utils, stream } = itemUtils(
			() => new Promise((resolve) => (resolveSeed = resolve))
		)
		const app = withOrpcApp(
			() =>
				useLiveQuery(
					{ id: '1' },
					(input, o: typeof utils) => o.item.get.queryOptions({ input }),
					(input, o, opts) => o.item.watch.call(input, opts),
					{ mergeSeed: (fetched, cached) => cached ?? fetched }
				),
			{ utils }
		)
		await stream.opened()
		await stream.push({ id: '1', name: 'from stream' })
		resolveSeed({ id: '1', name: 'older seed' })
		await app.result.suspense()
		expect(app.result.data.value).toEqual({ id: '1', name: 'from stream' })
		app.stop()
	})

	test('select converts the route output and applyEvent reduces into it', async () => {
		const { utils, stream } = itemUtils(async (id) => ({ id, name: 'a' }))
		const app = withOrpcApp(
			() =>
				useLiveQuery(
					{ id: '1' },
					(input, o: typeof utils) => o.item.get.queryOptions({ input }),
					(input, o, opts) => o.item.watch.call(input, opts),
					{
						select: (item: Item) => [item.name],
						applyEvent: (event: Item, previous: string[] | undefined) =>
							previous ? [...previous, event.name] : undefined
					}
				),
			{ utils }
		)
		await app.result.suspense()
		await stream.opened()
		await stream.push({ id: '1', name: 'b' })
		expect(app.result.data.value).toEqual(['a', 'b'])
		app.stop()
	})
})

describe('useInvalidationStream', () => {
	test('invalidates the event domain and leaves live queries alone', async () => {
		const stream = createTestStream<{ domain: 'order' }>()
		const app = withOrpcApp(() =>
			useInvalidationStream((_o, opts) => stream.subscribe(opts), {
				orpc: {},
				domains: { order: { queryKeys: [['order']] } }
			})
		)
		const cache = app.queryClient.getQueryCache()
		cache.build(app.queryClient, { queryKey: ['order', 'list'] })
		cache.build(app.queryClient, {
			queryKey: ['order', 'live'],
			meta: { live: true }
		})

		await stream.opened()
		await stream.push({ domain: 'order' })

		const isInvalidated = (queryKey: string[]) =>
			app.queryClient.getQueryState(queryKey)?.isInvalidated
		expect(isInvalidated(['order', 'list'])).toBe(true)
		expect(isInvalidated(['order', 'live'])).toBe(false)
		app.stop()
	})
})

describe('useQueryErrorMessage', () => {
	test('shows the server message only when it was marked user-safe', () => {
		const error = ref<unknown>(null)
		const { result } = withOrpcApp(() =>
			useQueryErrorMessage(error, 'Something went wrong')
		)
		expect(result.value).toBeNull()
		error.value = new ORPCError('BAD_REQUEST', { message: 'Deal has no stage' })
		expect(result.value).toBe('Something went wrong')
		error.value = new ORPCError('BAD_REQUEST', {
			data: { userMessage: 'Choose a stage first.' }
		})
		expect(result.value).toBe('Choose a stage first.')
	})
})

describe('createOrpcMock', () => {
	test('auto-mocks namespaces, keys and procedures with stable mocks', async () => {
		const orpc = createOrpcMock({ fn: mock, keys: { order: ['orders'] } }) as {
			order: {
				key(): unknown
				get: { call(): Promise<AsyncIterable<unknown>> }
			}
			support: { key(): unknown }
			$reset(): void
		}
		expect(orpc.order.key()).toEqual(['orders'])
		expect(orpc.support.key()).toEqual(['support'])
		const iterable = await orpc.order.get.call()
		for await (const _ of iterable) throw new Error('expected an empty stream')
		expect(orpc.order.get.call).toHaveBeenCalledTimes(1)
		orpc.$reset()
		expect(orpc.order.get.call).toHaveBeenCalledTimes(0)
	})
})
