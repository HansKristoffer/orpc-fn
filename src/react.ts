import {
	focusManager,
	hashKey,
	keepPreviousData,
	type QueryKey,
	type UseQueryOptions,
	type UseQueryResult,
	useQuery,
	useQueryClient
} from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
	createInvalidationCoordinator,
	createStreamScope,
	createSubscriptionRunner,
	type InvalidationStreamOptions,
	type LiveConnectionStatus,
	type SubscriptionRunner,
	seedQueryFn
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
	onError?: ((error: Error) => void) | undefined
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

type ApplyEvent<TStreamEvent, TData> = (
	event: TStreamEvent,
	previous: TData | undefined
) => TData | undefined

type LiveQueryOptions<
	TInput,
	TRouteData,
	TStreamEvent,
	TData,
	TSubscriptionInput
> = {
	/** Run the query and its stream (default: true). */
	enabled?: boolean | undefined
	/** Input for the stream when it differs from the query's. */
	subscriptionInput?: TSubscriptionInput | undefined
	/**
	 * Convert the route output once at fetch time into a differently typed
	 * cache; `applyEvent` then reduces stream events into that cache.
	 */
	select?: (data: TRouteData) => TData
	/** The raw route output of a seed, before `select` drops fields. */
	onSeed?: (data: TRouteData, input: TInput) => void
	/**
	 * Fold a stream event into the cached data. Required when the stream sends
	 * something other than the cached type (an `fnLive` patch route, or a
	 * `select`ed cache). Return `undefined` to skip the write.
	 */
	applyEvent?: ApplyEvent<TStreamEvent, NoInfer<TData>>
	onEvent?: (event: TStreamEvent, meta: { connectionId: number }) => void
	onError?: ((error: Error) => void) | undefined
	/**
	 * Reconcile a fetched seed with what the stream already wrote. The HTTP
	 * request can resolve last, so a plain overwrite would drop events that
	 * arrived while it was in flight. Default: take the fetched value.
	 */
	mergeSeed?: (
		fetched: NoInfer<TData>,
		cached: NoInfer<TData> | undefined
	) => NoInfer<TData>
	/** Show the previous key's data while a new key loads (default: true). */
	keepPreviousData?: boolean
	/** Close the stream while the app is not focused (default: true). */
	pauseWhenUnfocused?: boolean | undefined
}

type LiveQueryOptionsFn<TInput, TData, TError> = (
	input: TInput
) => UseQueryOptions<TData, TError, TData, QueryKey>

type LiveQueryResult<TData, TError> = UseQueryResult<TData, TError> & {
	liveStatus: LiveConnectionStatus
}

/**
 * The client half of `fnLive`: the HTTP query seeds the cache, and the live
 * route's stream writes each snapshot into the same cache entry. Marked
 * `meta.live`, so invalidation streams leave it alone.
 *
 * ```tsx
 * const order = useLiveQuery({ id }, (input) => orpc.order.get.queryOptions({ input }), client.order.watch)
 * ```
 *
 * One signature, not overloads: TypeScript fixes an untyped callback's
 * parameters at the first overload it tries, which made valid calls fail.
 */
export function useLiveQuery<
	TInput,
	TRouteData,
	TStreamEvent,
	TData = TRouteData,
	TError = Error,
	TSubscriptionInput = TInput
>(
	input: TInput,
	queryOptionsFn: LiveQueryOptionsFn<TInput, TRouteData, TError>,
	subscribe: SubscribeFn<NoInfer<TSubscriptionInput>, TStreamEvent>,
	...options: [TStreamEvent] extends [TData]
		? [
				options?: LiveQueryOptions<
					TInput,
					TRouteData,
					TStreamEvent,
					TData,
					TSubscriptionInput
				>
			]
		: [
				options: LiveQueryOptions<
					TInput,
					TRouteData,
					TStreamEvent,
					TData,
					TSubscriptionInput
				> & { applyEvent: ApplyEvent<TStreamEvent, NoInfer<TData>> }
			]
): LiveQueryResult<TData, TError>
export function useLiveQuery<
	TInput,
	TRouteData,
	TStreamEvent,
	TData,
	TError,
	TSubscriptionInput
>(
	input: TInput,
	queryOptionsFn: LiveQueryOptionsFn<TInput, TRouteData, TError>,
	subscribe: SubscribeFn<TSubscriptionInput, TStreamEvent>,
	options: LiveQueryOptions<
		TInput,
		TRouteData,
		TStreamEvent,
		TData,
		TSubscriptionInput
	> = {}
): LiveQueryResult<TData, TError> {
	const queryClient = useQueryClient()
	const focused = useIsFocused()
	const [scope] = useState(createStreamScope)

	// oRPC query options are plain objects; `queryFn` is read through one shape.
	const raw = queryOptionsFn(input) as unknown as {
		queryKey: QueryKey
		queryFn?: (context: unknown) => Promise<TRouteData>
		enabled?: UseQueryOptions['enabled']
		meta?: Record<string, unknown>
	} & Record<string, unknown>
	const keyHash = hashKey(raw.queryKey)
	const latest = useRef({ raw, keyHash, options })
	latest.current = { raw, keyHash, options }

	const { status } = useOrpcSubscription(
		(options.subscriptionInput === undefined
			? input
			: options.subscriptionInput) as TSubscriptionInput,
		subscribe,
		{
			enabled: options.enabled,
			pauseWhenUnfocused: options.pauseWhenUnfocused,
			onError: options.onError,
			onConnect: (connectionId) =>
				scope.open(connectionId, latest.current.keyHash),
			onEvent: (event, { connectionId }) => {
				const current = latest.current
				// The consumer callback must not see an event for a scope no longer shown.
				if (!scope.owns(connectionId, current.keyHash)) return
				// Without `applyEvent` the stream event is the cache type (the first overload).
				const applyEvent =
					current.options.applyEvent ??
					((streamEvent: TStreamEvent) => streamEvent as unknown as TData)
				const key = current.raw.queryKey
				const next = applyEvent(event, queryClient.getQueryData<TData>(key))
				if (next !== undefined) queryClient.setQueryData(key, next)
				current.options.onEvent?.(event, { connectionId })
			}
		}
	)

	const wrapsSeed = options.select || options.mergeSeed
	const queryFn =
		raw.queryFn && wrapsSeed
			? seedQueryFn(raw.queryFn, {
					input,
					readCache: () => queryClient.getQueryData<TData>(raw.queryKey),
					select: options.select,
					onSeed: options.onSeed,
					mergeSeed: options.mergeSeed
				})
			: raw.queryFn
	const runs = options.enabled !== false && focused
	const query = useQuery({
		...raw,
		...(queryFn ? { queryFn } : {}),
		enabled: runs ? (raw.enabled ?? true) : false,
		...(options.keepPreviousData === false
			? {}
			: { placeholderData: keepPreviousData }),
		staleTime: Number.POSITIVE_INFINITY,
		meta: { ...raw.meta, live: true }
	} as UseQueryOptions<TData, TError, TData, QueryKey>)

	return Object.assign(query, { liveStatus: status })
}

/**
 * One app-wide stream of `{ domain }` change events that keeps list and count
 * queries fresh: each event invalidates its domain's query keys (debounced),
 * and a reconnect that proves healthy invalidates every domain to cover
 * events lost while it was down. Mount once, in the signed-in shell.
 *
 * ```ts
 * useInvalidationStream({}, client.realtime.subscribeChanges, {
 *   enabled: signedIn,
 *   domains: { order: { debounceMs: 100, queryKeys: [orpc.order.key()] } }
 * })
 * ```
 */
export function useInvalidationStream<
	TInput,
	TEvent extends { domain: string }
>(
	input: TInput,
	subscribe: SubscribeFn<TInput, TEvent>,
	options: InvalidationStreamOptions<TEvent> &
		Pick<
			UseOrpcSubscriptionOptions<TInput, TEvent>,
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

	return useOrpcSubscription<TInput, TEvent>(input, subscribe, {
		enabled: options.enabled,
		pauseWhenUnfocused: options.pauseWhenUnfocused,
		onEvent: coordinator.event,
		onConnect: coordinator.connect,
		onError: coordinator.lost,
		onClose: coordinator.lost
	})
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
