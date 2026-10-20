import { afterEach, describe, expect, test } from 'bun:test'
import {
	focusManager,
	QueryClient,
	QueryClientProvider
} from '@tanstack/react-query'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import {
	useInvalidationStream,
	useLiveQuery,
	useOrpcSubscription,
	useQueryCacheOwner
} from './react.js'
import { createTestStream } from './vue/testing.js'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/** Render a hook with React Query and return its latest result. */
async function renderHook<TProps, TResult>(
	hook: (props: TProps) => TResult,
	initialProps: TProps
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } }
	})
	const result = { current: undefined as TResult }
	function Probe(props: { value: TProps }) {
		result.current = hook(props.value)
		return null
	}
	const tree = (props: TProps) =>
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(Probe, { value: props })
		)
	let renderer!: ReactTestRenderer
	await act(async () => {
		renderer = create(tree(initialProps))
	})
	return {
		result,
		queryClient,
		rerender: (props: TProps) => act(async () => renderer.update(tree(props))),
		unmount: () => act(async () => renderer.unmount())
	}
}

afterEach(() => focusManager.setFocused(undefined))

describe('useOrpcSubscription', () => {
	test('streams events for its input and closes on unmount', async () => {
		const stream = createTestStream<number>()
		const events: number[] = []
		const hook = await renderHook(
			(input: string) =>
				useOrpcSubscription(input, stream.subscribe, {
					onEvent: (event) => events.push(event)
				}),
			'a' as string
		)
		const first = await stream.opened(1)
		expect(first.input).toBe('a')
		await act(() => stream.push(1))
		expect(events).toEqual([1])
		expect(hook.result.current.status).toBe('connected')

		await hook.rerender('b')
		const second = await stream.opened(2)
		expect(first.closed).toBe(true)
		expect(second.input).toBe('b')

		await hook.unmount()
		expect(second.closed).toBe(true)
	})

	test('closes while the app is unfocused and reopens on focus', async () => {
		const stream = createTestStream<number>()
		const hook = await renderHook(
			() => useOrpcSubscription(undefined, stream.subscribe),
			undefined
		)
		const first = await stream.opened(1)
		await act(async () => focusManager.setFocused(false))
		expect(first.closed).toBe(true)
		await act(async () => focusManager.setFocused(true))
		await stream.opened(2)
		await hook.unmount()
	})
})

type Item = { id: string; name: string }

describe('useLiveQuery', () => {
	const options = (input: { id: string }) => ({
		queryKey: ['item', input.id],
		queryFn: async () => ({ id: input.id, name: 'seed' })
	})

	test('the HTTP query seeds the cache and stream snapshots overwrite it', async () => {
		const stream = createTestStream<Item>()
		const hook = await renderHook(
			(input: { id: string }) => useLiveQuery(input, options, stream.subscribe),
			{ id: '1' }
		)
		await act(() => hook.queryClient.refetchQueries())
		expect(hook.result.current.data).toEqual({ id: '1', name: 'seed' })

		await stream.opened()
		await act(() => stream.push({ id: '1', name: 'live' }))
		expect(hook.queryClient.getQueryData<Item>(['item', '1'])).toEqual({
			id: '1',
			name: 'live'
		})
		expect(hook.result.current.liveStatus).toBe('connected')
		await hook.unmount()
	})

	test('an event from the previous input is not written into the new key', async () => {
		const stream = createTestStream<Item>()
		const hook = await renderHook(
			(input: { id: string }) => useLiveQuery(input, options, stream.subscribe),
			{ id: '1' }
		)
		const first = await stream.opened(1)
		await hook.rerender({ id: '2' })
		await act(() => first.push({ id: '1', name: 'stale' }))
		expect(hook.queryClient.getQueryData<Item>(['item', '2'])?.name).not.toBe(
			'stale'
		)
		await hook.unmount()
	})

	test('applyEvent folds patch events into the cache', async () => {
		const stream = createTestStream<Item | { rename: string }>()
		const hook = await renderHook(
			(input: { id: string }) =>
				useLiveQuery(input, options, stream.subscribe, {
					applyEvent: (event, previous) =>
						'rename' in event
							? previous && { ...previous, name: event.rename }
							: event
				}),
			{ id: '1' }
		)
		await act(() => hook.queryClient.refetchQueries())
		await stream.opened()
		await act(() => stream.push({ rename: 'patched' }))
		expect(hook.queryClient.getQueryData<Item>(['item', '1'])).toEqual({
			id: '1',
			name: 'patched'
		})
		await hook.unmount()
	})
})

describe('useInvalidationStream', () => {
	test('invalidates the event domain and leaves live queries alone', async () => {
		const stream = createTestStream<{ domain: 'order' }>()
		const hook = await renderHook(
			() =>
				useInvalidationStream(undefined, stream.subscribe, {
					domains: { order: { queryKeys: [['order']] } }
				}),
			undefined
		)
		const cache = hook.queryClient.getQueryCache()
		cache.build(hook.queryClient, { queryKey: ['order', 'list'] })
		cache.build(hook.queryClient, {
			queryKey: ['order', 'live'],
			meta: { live: true }
		})

		await stream.opened()
		await act(() => stream.push({ domain: 'order' }))

		const isInvalidated = (queryKey: string[]) =>
			hook.queryClient.getQueryState(queryKey)?.isInvalidated
		expect(isInvalidated(['order', 'list'])).toBe(true)
		expect(isInvalidated(['order', 'live'])).toBe(false)
		await hook.unmount()
	})
})

describe('useQueryCacheOwner', () => {
	test('clears the cache when the owner changes, not when signing in', async () => {
		const hook = await renderHook(
			(owner: string | null) => useQueryCacheOwner(owner),
			null as string | null
		)
		hook.queryClient.setQueryData(['me'], 'a')
		await hook.rerender('user-a')
		expect(hook.queryClient.getQueryData<string>(['me'])).toBe('a')

		await hook.rerender('user-b')
		expect(hook.queryClient.getQueryData(['me'])).toBeUndefined()
		await hook.unmount()
	})
})
