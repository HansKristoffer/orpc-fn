import { focusManager, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
	createInvalidationCoordinator,
	createSubscriptionRunner,
	type InvalidationStreamOptions,
	type LiveConnectionStatus,
	type SubscriptionRunner
} from './realtime.js'

export type { InvalidationDomain, LiveConnectionStatus } from './realtime.js'

/** An oRPC client procedure fits: `client.order.watch`. */
export type SubscribeFn<TInput, TEvent> = (
	input: TInput,
	options: { signal: AbortSignal }
) => Promise<AsyncIterable<TEvent>>

export type UseOrpcSubscriptionOptions<TInput, TEvent> = {
	/** Run the stream (default: true). */
	enabled?: boolean | undefined
	onEvent?: (
		event: TEvent,
		meta: { connectionId: number; input: TInput }
	) => void
	/** Every successful connect; `connectionId > 1` is a reconnect. */
	onConnect?: (connectionId: number) => void
	onError?: (error: Error) => void
	onClose?: () => void
	/**
	 * Close the stream while the app is not focused (default: true). Focus is
	 * TanStack's `focusManager`: on React Native, wire it to `AppState` once.
	 */
	pauseWhenUnfocused?: boolean | undefined
}

const subscribeFocus = (listener: () => void) =>
	focusManager.subscribe(listener)
const getFocus = () => focusManager.isFocused()

/** Whether the app is focused, from TanStack's `focusManager`. */
function useIsFocused(): boolean {
	return useSyncExternalStore(subscribeFocus, getFocus, getFocus)
}

/**
 * An oRPC event iterator with backoff reconnects that closes while the app is
 * backgrounded. A changed input (compared as JSON) reconnects with a fresh
 * retry budget.
 */
export function useOrpcSubscription<TInput, TEvent>(
	input: TInput,
	subscribe: SubscribeFn<TInput, TEvent>,
	options: UseOrpcSubscriptionOptions<TInput, TEvent> = {}
): { status: LiveConnectionStatus } {
	const { enabled = true, pauseWhenUnfocused = true } = options
	const focused = useIsFocused()
	const shouldRun = enabled && (!pauseWhenUnfocused || focused)
	const [status, setStatus] = useState<LiveConnectionStatus>('idle')

	const latest = useRef({ input, subscribe, options, shouldRun })
	latest.current = { input, subscribe, options, shouldRun }

	const runnerRef = useRef<SubscriptionRunner | null>(null)
	if (!runnerRef.current) {
		let openedInput = input
		runnerRef.current = createSubscriptionRunner<TEvent>({
			open: (signal) => {
				openedInput = latest.current.input
				return latest.current.subscribe(openedInput, { signal })
			},
			canConnect: () => latest.current.shouldRun,
			shouldReconnect: () => latest.current.shouldRun,
			onStatus: setStatus,
			onEvent: (event, connectionId) =>
				latest.current.options.onEvent?.(event, {
					connectionId,
					input: openedInput
				}),
			onConnect: (id) => latest.current.options.onConnect?.(id),
			onError: (error) => latest.current.options.onError?.(error),
			onClose: () => latest.current.options.onClose?.()
		})
	}
	const runner = runnerRef.current
	const serializedInput = JSON.stringify(input)

	// biome-ignore lint/correctness/useExhaustiveDependencies: a changed input resubscribes
	useEffect(() => {
		if (!shouldRun) return
		void runner.start()
		return () => void runner.disconnect()
	}, [runner, shouldRun, serializedInput])

	return { status }
}

/**
 * One app-wide stream of `{ domain }` change events that keeps list and count
 * queries fresh: each event invalidates its domain's query keys (debounced),
 * and a reconnect that proves healthy invalidates every domain to cover
 * events lost while it was down. Mount once, in the signed-in shell.
 *
 * ```ts
 * useInvalidationStream((opts) => client.realtime.changes({}, opts), {
 *   enabled: signedIn,
 *   domains: { order: { debounceMs: 100, queryKeys: [orpc.order.key()] } }
 * })
 * ```
 */
export function useInvalidationStream<TEvent extends { domain: string }>(
	subscribe: (options: {
		signal: AbortSignal
	}) => Promise<AsyncIterable<TEvent>>,
	options: InvalidationStreamOptions<TEvent> &
		Pick<
			UseOrpcSubscriptionOptions<undefined, TEvent>,
			'enabled' | 'pauseWhenUnfocused'
		>
): { status: LiveConnectionStatus } {
	const queryClient = useQueryClient()
	const latestOptions = useRef(options)
	latestOptions.current = options
	// `domains`, `refetchType` and `logger` are read on mount; `onEvent` stays current.
	const [coordinator] = useState(() =>
		createInvalidationCoordinator<TEvent>(queryClient, {
			...options,
			onEvent: (event) => latestOptions.current.onEvent?.(event)
		})
	)
	useEffect(() => coordinator.dispose, [coordinator])

	return useOrpcSubscription<undefined, TEvent>(
		undefined,
		(_input, opts) => subscribe(opts),
		{
			enabled: options.enabled,
			pauseWhenUnfocused: options.pauseWhenUnfocused,
			onEvent: coordinator.event,
			onConnect: coordinator.connect,
			onError: coordinator.lost,
			onClose: coordinator.lost
		}
	)
}

/**
 * Clear the query cache when the signed-in owner of the cached data changes
 * (another user, another organization), so the next one never sees it.
 * `null` means signed out: signing in starts from the cache sign-out emptied.
 * Pass the same owner as the persister's `buster` so a saved cache from
 * someone else is discarded on the next launch too.
 */
export function useQueryCacheOwner(owner: string | null): void {
	const queryClient = useQueryClient()
	const previous = useRef(owner)
	useEffect(() => {
		const before = previous.current
		previous.current = owner
		if (owner !== before && before !== null) queryClient.clear()
	}, [owner, queryClient])
}
