import {
	type DefaultError,
	type FetchQueryOptions,
	focusManager,
	hashKey,
	type InferDataFromTag,
	type InfiniteData,
	type InvalidateQueryFilters,
	type MutationObserverOptions,
	type UseInfiniteQueryOptions,
	type UseInfiniteQueryReturnType,
	type UseMutationReturnType,
	type UseQueryReturnType,
	type Updater,
	keepPreviousData,
	type QueryKey,
	type UseQueryOptions,
	useInfiniteQuery as useVueInfiniteQuery,
	useMutation as useVueMutation,
	useQuery as useVueQuery,
	useQueryClient
} from '@tanstack/vue-query'
import {
	type App,
	computed,
	getCurrentScope,
	hasInjectionContext,
	type InjectionKey,
	inject,
	type MaybeRefOrGetter,
	onScopeDispose,
	type Ref,
	ref,
	shallowRef,
	toValue,
	watch
} from 'vue'
import { userFacingErrorMessage } from './client.js'
import {
	createInvalidationCoordinator,
	createStreamScope,
	createSubscriptionRunner,
	type InvalidationStreamOptions,
	type LiveConnectionStatus,
	seedQueryFn
} from './realtime.js'

export type { InvalidationDomain, LiveConnectionStatus } from './realtime.js'

/**
 * Register your client types once so every composable infers them:
 *
 * ```ts
 * declare module 'orpc-fn/vue' {
 *   interface Register { utils: typeof orpc; client: typeof client }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled in by app module augmentation
export interface Register {}

export type RegisteredOrpcUtils = Register extends { utils: infer T }
	? T
	: {
			'orpc-fn/vue: register your utils with `declare module "orpc-fn/vue" { interface Register { utils: typeof orpc } }`, or pass `orpc`': never
		}
export type RegisteredOrpcClient = Register extends { client: infer T }
	? T
	: unknown

/** An explicit `<TData>`, else the data type oRPC tagged on the key. */
type CachedData<TData, TKey extends QueryKey> = [TData] extends [never]
	? InferDataFromTag<unknown, TKey>
	: TData

type ProvidedOrpc = { client: unknown; utils: unknown }
const orpcKey: InjectionKey<ProvidedOrpc> = Symbol('orpc-fn')

/**
 * Make an oRPC client and its TanStack Query utils the app's default. A
 * surface that talks to another API (an embed with its own auth) passes
 * `orpc` to each composable instead and never needs this.
 */
export function provideOrpc<TClient, TUtils>(
	app: App,
	orpc: { client: TClient; utils: TUtils }
): void {
	app.provide(orpcKey, orpc)
}

const missingOrpc = () =>
	new Error(
		'orpc-fn/vue: no oRPC client provided. Call provideOrpc(app, { client, utils }) or pass `orpc` to the composable.'
	)

/** The client and utils from {@link provideOrpc}. */
export function useOrpc(): {
	client: RegisteredOrpcClient
	utils: RegisteredOrpcUtils
} {
	const provided = hasInjectionContext() ? inject(orpcKey, null) : null
	if (!provided) throw missingOrpc()
	return provided as {
		client: RegisteredOrpcClient
		utils: RegisteredOrpcUtils
	}
}

/** Resolve the provided utils now; fail only when they are needed and missing. */
function useUtilsGetter<TOrpc>(
	explicit: MaybeRefOrGetter<TOrpc> | undefined
): () => TOrpc {
	if (explicit) return () => toValue(explicit)
	const provided = hasInjectionContext() ? inject(orpcKey, null) : null
	return () => {
		if (!provided) throw missingOrpc()
		return provided.utils as TOrpc
	}
}

let documentVisible: Ref<boolean> | null = null
/**
 * Whether the page is visible, from TanStack's `focusManager` (which follows
 * `visibilitychange` in browsers). Live streams pause while it is false.
 */
function useDocumentVisible(): Ref<boolean> {
	if (!documentVisible) {
		const visible = ref(focusManager.isFocused())
		focusManager.subscribe((focused) => {
			visible.value = focused
		})
		documentVisible = visible
	}
	return documentVisible
}

function resolveQueryEnabled(enabled: unknown): boolean {
	if (enabled === undefined) return true
	if (typeof enabled === 'function') return Boolean(enabled())
	return Boolean(toValue(enabled))
}

/**
 * Picks the stream to open from the utils. A procedure's `call` fits as is:
 * `(o) => o.order.watch.call`. The composable passes the input and an abort signal.
 */
export type OrpcSubscribeFn<TInput, TEvent, TOrpc = RegisteredOrpcUtils> = (
	orpc: TOrpc
) => (
	input: TInput,
	options: { signal: AbortSignal }
) => Promise<AsyncIterable<TEvent>>

export interface UseSubscriptionOptions<TEvent, TOrpc = RegisteredOrpcUtils> {
	/** Start the stream on its own (default: true). With false, call `connect()`. */
	immediate?: MaybeRefOrGetter<boolean> | undefined
	onEvent?: (event: TEvent, meta?: { connectionId: number }) => void
	onError?: ((error: Error) => void) | undefined
	/** Every successful connect; `connectionId > 1` is a reconnect. */
	onConnect?: (connectionId: number) => void
	onClose?: () => void
	/** Events kept in `events` (default: 100). 1 keeps only `latestEvent`. */
	maxEvents?: number
	/** Reconnect when the input changes (default: true). */
	autoReconnectOnInputChange?: boolean
	/**
	 * After a connect, reconnect with backoff when the stream ends or errors
	 * unexpectedly (proxy idle timeout, network blip). Deliberate teardown
	 * does not retry. Default: true.
	 */
	autoReconnectOnClose?: boolean
	orpc?: MaybeRefOrGetter<TOrpc> | undefined
	/**
	 * Close the stream while the page is hidden (default: true), so a
	 * background tab holds no server connection. It reconnects, and a live
	 * route re-sends its snapshot, when the page is visible again.
	 */
	respectVisibility?: boolean | undefined
}

export interface UseSubscriptionReturn<TEvent> {
	events: Ref<TEvent[]>
	latestEvent: Ref<TEvent | undefined>
	status: Ref<LiveConnectionStatus>
	error: Ref<Error | null>
	isConnected: Ref<boolean>
	connect: () => Promise<void>
	disconnect: () => Promise<void>
	clearEvents: () => void
}

/**
 * An oRPC event iterator as reactive state, with backoff reconnects and a
 * pause while the page is hidden. Closed when the owning effect scope stops.
 */
export function useOrpcSubscription<
	TInput,
	TEvent,
	TOrpc = RegisteredOrpcUtils
>(
	input: MaybeRefOrGetter<TInput>,
	subscribeFn: OrpcSubscribeFn<TInput, TEvent, TOrpc>,
	options: UseSubscriptionOptions<TEvent, TOrpc> = {}
): UseSubscriptionReturn<TEvent> {
	const {
		immediate = true,
		maxEvents = 100,
		autoReconnectOnInputChange = true,
		autoReconnectOnClose = true,
		respectVisibility = true
	} = options
	const getUtils = useUtilsGetter(options.orpc)
	const visible = useDocumentVisible()

	// May a stream run at all? This gates a manual connect() too.
	const isStreamAllowed = computed(() => !respectVisibility || visible.value)
	// Should it start on its own? That is what `immediate` means.
	const shouldAutoConnect = computed(
		() => toValue(immediate) && isStreamAllowed.value
	)

	// Shallow: event payloads are replaced, never mutated, so deep proxies are wasted work.
	const events = shallowRef<TEvent[]>([])
	const latestEvent = shallowRef<TEvent | undefined>(undefined)
	const status = ref<LiveConnectionStatus>('idle')
	const error = ref<Error | null>(null)

	const runner = createSubscriptionRunner<TEvent>({
		open: (signal) => subscribeFn(getUtils())(toValue(input), { signal }),
		canConnect: () => isStreamAllowed.value,
		shouldReconnect: () => autoReconnectOnClose && shouldAutoConnect.value,
		onStatus: (next) => {
			status.value = next
			if (next === 'connecting') error.value = null
		},
		onEvent: (event, connectionId) => {
			latestEvent.value = event
			if (maxEvents > 1) {
				events.value = [...events.value.slice(-(maxEvents - 1)), event]
			}
			options.onEvent?.(event, { connectionId })
		},
		onError: (err) => {
			error.value = err
			options.onError?.(err)
		},
		onConnect: options.onConnect,
		onClose: options.onClose
	})

	function clearEvents() {
		events.value = []
		latestEvent.value = undefined
	}

	if (autoReconnectOnInputChange) {
		watch(
			() => toValue(input),
			async () => {
				const wasLive = runner.isLive()
				if (runner.getStatus() !== 'idle') {
					await runner.disconnect()
					clearEvents()
				}
				// Reconnect in auto mode, or in manual mode when it was running.
				if (shouldAutoConnect.value || (wasLive && isStreamAllowed.value)) {
					await runner.start()
				}
			},
			{ deep: true }
		)
	}

	// Visibility closes the stream in both modes; only the re-open waits for `immediate`.
	watch(
		isStreamAllowed,
		(allowed) => {
			if (!allowed) void runner.disconnect()
			else if (toValue(immediate)) {
				error.value = null
				void runner.start()
			}
		},
		{ immediate: true }
	)

	watch(
		() => toValue(immediate),
		(auto) => {
			if (!auto) void runner.disconnect()
			else if (isStreamAllowed.value) {
				error.value = null
				void runner.start()
			}
		}
	)

	// A detached effect scope may own the stream, not just a component.
	if (getCurrentScope()) onScopeDispose(() => void runner.dispose())

	return {
		events,
		latestEvent,
		status,
		error,
		isConnected: computed(() => status.value === 'connected'),
		connect: runner.connect,
		disconnect: runner.disconnect,
		clearEvents
	}
}

/** What {@link useApiClient} returns, e.g. `ApiClient['invalidate']` for a helper. */
export type ApiClient<TOrpc = RegisteredOrpcUtils> = ReturnType<
	typeof useBoundApiClient<TOrpc>
>

/**
 * TanStack Query composables that receive the oRPC utils, so call sites read
 * `useQuery((o) => o.order.get.queryOptions({ input }))`. Pass `orpc` to bind
 * another client than the provided one.
 */
export function useApiClient<TOrpc = RegisteredOrpcUtils>(clientOptions?: {
	orpc?: MaybeRefOrGetter<TOrpc> | undefined
}): ApiClient<TOrpc>
// `ReturnType<typeof useApiClient>` reads the last overload: the registered utils.
export function useApiClient(): ApiClient
export function useApiClient<TOrpc>(clientOptions?: {
	orpc?: MaybeRefOrGetter<TOrpc> | undefined
}): ApiClient<TOrpc> {
	return useBoundApiClient(clientOptions?.orpc)
}

function useBoundApiClient<TOrpc>(orpc: MaybeRefOrGetter<TOrpc> | undefined) {
	const queryClient = useQueryClient()
	const getO = useUtilsGetter(orpc)

	// Each wrapper forwards TanStack's own generics, so `select`, typed errors,
	// page params and oRPC's tagged keys infer exactly as with vue-query itself.
	function useQuery<TQueryFnData, TError = DefaultError, TData = TQueryFnData>(
		optionsFn: (
			orpc: TOrpc
		) => UseQueryOptions<TQueryFnData, TError, TData, TQueryFnData>
	): UseQueryReturnType<TData, TError> {
		// A computed is a ref at runtime; TypeScript cannot relate a computed of
		// the generic options to vue-query's MaybeRef parameter, so it is asserted.
		const options = computed(() => optionsFn(getO()))
		return useVueQuery<TQueryFnData, TError, TData>(
			options as unknown as UseQueryOptions<
				TQueryFnData,
				TError,
				TData,
				TQueryFnData
			>
		)
	}

	/** `useInfiniteQuery((o) => o.order.list.infiniteOptions({ input, initialPageParam, getNextPageParam }))` */
	function useInfiniteQuery<
		TQueryFnData,
		TError = DefaultError,
		TData = InfiniteData<TQueryFnData>,
		TQueryKey extends QueryKey = QueryKey,
		TPageParam = unknown
	>(
		optionsFn: (
			orpc: TOrpc
		) => UseInfiniteQueryOptions<
			TQueryFnData,
			TError,
			TData,
			TQueryKey,
			TPageParam
		>
	): UseInfiniteQueryReturnType<TData, TError> {
		const options = computed(() => optionsFn(getO()))
		return useVueInfiniteQuery<
			TQueryFnData,
			TError,
			TData,
			TQueryKey,
			TPageParam
		>(
			options as unknown as UseInfiniteQueryOptions<
				TQueryFnData,
				TError,
				TData,
				TQueryKey,
				TPageParam
			>
		)
	}

	/**
	 * With `initialInput`, also returns `inputData`, a ref that `mutate()` and
	 * `mutateAsync()` use when called without variables (form state).
	 */
	// The input type comes from the route alone; `initialInput` is only checked
	// against it. `unknown`, not `void`, lets `initialInput` pass the first
	// inference pass, which runs before the `(o) => ...` callback is read.
	function useMutation<
		TData = unknown,
		TError = DefaultError,
		TVariables = unknown,
		TContext = unknown
	>(
		optionsFn: (
			orpc: TOrpc
		) => MutationObserverOptions<TData, TError, TVariables, TContext>,
		config: { initialInput: NoInfer<TVariables> }
	): UseMutationReturnType<TData, TError, TVariables, TContext> & {
		inputData: Ref<TVariables>
		mutate: (variables?: TVariables) => void
		mutateAsync: (variables?: TVariables) => Promise<TData>
	}
	function useMutation<
		TData = unknown,
		TError = DefaultError,
		TVariables = void,
		TContext = unknown
	>(
		optionsFn: (
			orpc: TOrpc
		) => MutationObserverOptions<TData, TError, TVariables, TContext>
	): UseMutationReturnType<TData, TError, TVariables, TContext>
	function useMutation<TData, TError, TVariables, TContext>(
		optionsFn: (
			orpc: TOrpc
		) => MutationObserverOptions<TData, TError, TVariables, TContext>,
		config?: { initialInput: TVariables }
	) {
		const mutation = useVueMutation(computed(() => optionsFn(getO())))
		if (config?.initialInput === undefined) return mutation
		const inputData = ref(config.initialInput) as Ref<TVariables>
		return {
			...mutation,
			inputData,
			mutate: (variables?: TVariables) =>
				mutation.mutate(variables ?? inputData.value),
			mutateAsync: (variables?: TVariables) =>
				mutation.mutateAsync(variables ?? inputData.value)
		}
	}

	function useSubscription<TInput, TEvent>(
		input: MaybeRefOrGetter<TInput>,
		subscribeFn: OrpcSubscribeFn<TInput, TEvent, TOrpc>,
		options: UseSubscriptionOptions<TEvent, TOrpc> = {}
	) {
		return useOrpcSubscription<TInput, TEvent, TOrpc>(input, subscribeFn, {
			...options,
			orpc: getO
		})
	}

	const keyOf = <TKey extends QueryKey>(keyFn: (orpc: TOrpc) => TKey) =>
		keyFn(getO())

	return {
		/** The utils themselves, for `queryClient.fetchQuery(orpc.x.queryOptions(...))` and the like. */
		get orpc(): TOrpc {
			return getO()
		},
		useQuery,
		useInfiniteQuery,
		useMutation,
		useSubscription,
		invalidate: (
			keyFn: (orpc: TOrpc) => QueryKey,
			filters?: Omit<InvalidateQueryFilters, 'queryKey'>
		) => queryClient.invalidateQueries({ queryKey: keyOf(keyFn), ...filters }),
		/** Route preloading and hover-to-prefetch. */
		prefetch: <
			TQueryFnData,
			TError = DefaultError,
			TData = TQueryFnData,
			TQueryKey extends QueryKey = QueryKey
		>(
			optionsFn: (
				orpc: TOrpc
			) => FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>
		) => queryClient.prefetchQuery(optionsFn(getO())),
		/** Data is typed from oRPC's tagged key; pass `<TData>` for an untagged one. */
		getQueryData: <TData = never, TKey extends QueryKey = QueryKey>(
			keyFn: (orpc: TOrpc) => TKey
		): CachedData<TData, TKey> | undefined =>
			queryClient.getQueryData<CachedData<TData, TKey>>(keyOf(keyFn)),
		/** Optimistic updates, typed like `getQueryData`. */
		setQueryData: <TData = never, TKey extends QueryKey = QueryKey>(
			keyFn: (orpc: TOrpc) => TKey,
			updater: Updater<
				CachedData<TData, TKey> | undefined,
				CachedData<TData, TKey> | undefined
			>
		) =>
			queryClient.setQueryData<CachedData<TData, TKey>>(keyOf(keyFn), updater),
		cancelQueries: (keyFn: (orpc: TOrpc) => QueryKey) =>
			queryClient.cancelQueries({ queryKey: keyOf(keyFn) }),
		removeQueries: (keyFn: (orpc: TOrpc) => QueryKey) =>
			queryClient.removeQueries({ queryKey: keyOf(keyFn) }),
		isFetching: (keyFn?: (orpc: TOrpc) => QueryKey) =>
			queryClient.isFetching(keyFn ? { queryKey: keyOf(keyFn) } : {}),
		queryClient
	}
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
	TOrpc,
	TSubscriptionInput
> = {
	immediate?: MaybeRefOrGetter<boolean>
	orpc?: MaybeRefOrGetter<TOrpc>
	/** Input for the stream when it differs from the query's. */
	subscriptionInput?: MaybeRefOrGetter<TSubscriptionInput>
	/**
	 * Convert the route output once at fetch time into a differently typed
	 * cache; `applyEvent` then reduces stream events into that cache.
	 */
	select?: (data: TRouteData) => TData
	/**
	 * The raw route output of a seed before `select` drops fields. `input` is
	 * what the seed was fetched for, so a seed that resolves after the input
	 * moved on can be told apart.
	 */
	onSeed?: (data: TRouteData, input: TInput) => void
	/**
	 * Fold a stream event into the cached data. Required when the stream sends
	 * something other than the cached type (an `fnLive` patch route, or a
	 * `select`ed cache). Return `undefined` to skip the write.
	 */
	applyEvent?: ApplyEvent<TStreamEvent, NoInfer<TData>>
	onEvent?: (event: TStreamEvent, meta?: { connectionId: number }) => void
	onError?: (error: Error) => void
	/**
	 * Reconcile a fetched seed with what the stream already wrote. The HTTP
	 * request can resolve last, so a plain overwrite would drop events that
	 * arrived while it was in flight. Default: take the fetched value.
	 */
	mergeSeed?: (
		fetched: NoInfer<TData>,
		cached: NoInfer<TData> | undefined
	) => NoInfer<TData>
	/**
	 * Show the previous key's data while a new key loads (default: true). Pass
	 * false when the key says which entity is shown, not just how it is
	 * filtered: another conversation's timeline must not stand in for this one.
	 */
	keepPreviousData?: boolean
	/** Pause the stream while the page is hidden (default: true). */
	respectVisibility?: boolean
}

type LiveQueryReturn<TData, TError> = ReturnType<
	typeof useVueQuery<TData, TError>
> & { liveStatus: Ref<LiveConnectionStatus> }

/**
 * The client half of `fnLive`: the HTTP query seeds the cache, and the live
 * route's stream writes each snapshot into the same cache entry. Marked
 * `meta.live`, so invalidation streams leave it alone.
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
	TOrpc = RegisteredOrpcUtils,
	TSubscriptionInput = TInput
>(
	input: MaybeRefOrGetter<TInput>,
	queryOptionsFn: (
		input: TInput,
		orpc: TOrpc
	) => UseQueryOptions<TRouteData, TError> & { queryKey: QueryKey },
	subscribeFn: OrpcSubscribeFn<
		NoInfer<TSubscriptionInput>,
		TStreamEvent,
		TOrpc
	>,
	...options: [TStreamEvent] extends [TData]
		? [
				options?: LiveQueryOptions<
					TInput,
					TRouteData,
					TStreamEvent,
					TData,
					TOrpc,
					TSubscriptionInput
				>
			]
		: [
				options: LiveQueryOptions<
					TInput,
					TRouteData,
					TStreamEvent,
					TData,
					TOrpc,
					TSubscriptionInput
				> & { applyEvent: ApplyEvent<TStreamEvent, NoInfer<TData>> }
			]
): LiveQueryReturn<TData, TError>
export function useLiveQuery<
	TInput,
	TRouteData,
	TStreamEvent,
	TData,
	TError,
	TOrpc,
	TSubscriptionInput
>(
	input: MaybeRefOrGetter<TInput>,
	queryOptionsFn: (
		input: TInput,
		orpc: TOrpc
	) => UseQueryOptions<TRouteData, TError> & { queryKey: QueryKey },
	subscribeFn: OrpcSubscribeFn<TSubscriptionInput, TStreamEvent, TOrpc>,
	options: LiveQueryOptions<
		TInput,
		TRouteData,
		TStreamEvent,
		TData,
		TOrpc,
		TSubscriptionInput
	> = {}
): LiveQueryReturn<TData, TError> {
	const queryClient = useQueryClient()
	const getO = useUtilsGetter(options.orpc)
	const visible = useDocumentVisible()
	// Without `applyEvent` the stream event is the cache type (the first overload).
	const applyEvent =
		options.applyEvent ?? ((event: TStreamEvent) => event as unknown as TData)
	// Recomputed when the input changes, not once per stream event.
	const queryKey = computed(
		() => queryOptionsFn(toValue(input), getO()).queryKey
	)
	const queryHash = computed(() => hashKey(queryKey.value))
	const scope = createStreamScope()

	const subscription = useOrpcSubscription(
		computed(
			() =>
				(options.subscriptionInput === undefined
					? toValue(input)
					: toValue(options.subscriptionInput)) as TSubscriptionInput
		),
		subscribeFn,
		{
			immediate: options.immediate,
			respectVisibility: options.respectVisibility,
			onError: options.onError,
			maxEvents: 1,
			orpc: getO,
			onConnect: (connectionId) => scope.open(connectionId, queryHash.value),
			onEvent: (event, meta) => {
				// The consumer callback must not see an event for a scope no longer shown.
				if (!meta || !scope.owns(meta.connectionId, queryHash.value)) return
				const key = queryKey.value
				const next = applyEvent(event, queryClient.getQueryData<TData>(key))
				if (next !== undefined) queryClient.setQueryData(key, next)
				options.onEvent?.(event, meta)
			}
		}
	)

	const query = useVueQuery<TData, TError>(
		computed(() => {
			const inputValue = toValue(input)
			// oRPC query options are plain objects at runtime; vue-query's type
			// wraps fields in MaybeRefDeep, so `queryFn` is read through one shape.
			const raw = queryOptionsFn(inputValue, getO()) as unknown as {
				queryKey: QueryKey
				queryFn?: (context: unknown) => Promise<TRouteData>
				enabled?: unknown
			} & Record<string, unknown>
			const wrapsSeed = options.select || options.mergeSeed
			const queryFn =
				raw.queryFn && wrapsSeed
					? seedQueryFn(raw.queryFn, {
							input: inputValue,
							readCache: () => queryClient.getQueryData<TData>(raw.queryKey),
							select: options.select,
							onSeed: options.onSeed,
							mergeSeed: options.mergeSeed
						})
					: raw.queryFn
			return {
				...raw,
				...(queryFn ? { queryFn } : {}),
				enabled: visible.value && resolveQueryEnabled(raw.enabled),
				...(options.keepPreviousData === false
					? {}
					: { placeholderData: keepPreviousData }),
				staleTime: Number.POSITIVE_INFINITY,
				meta: { live: true }
			} as unknown as UseQueryOptions<TData, TError>
		})
	)

	return Object.assign(query, { liveStatus: subscription.status })
}

/**
 * Treat a stream as a "something changed" ping: invalidate `keyFn` on each
 * event. Prefer {@link useLiveQuery} when the stream carries the data itself.
 */
export function useSubscriptionInvalidates<
	TInput,
	TEvent,
	TOrpc = RegisteredOrpcUtils
>(
	input: MaybeRefOrGetter<TInput>,
	subscribeFn: OrpcSubscribeFn<TInput, TEvent, TOrpc>,
	keyFn: (orpc: TOrpc) => QueryKey,
	options: Pick<
		UseSubscriptionOptions<TEvent, TOrpc>,
		'immediate' | 'maxEvents' | 'respectVisibility' | 'orpc'
	> & {
		onEvent?: (event: TEvent) => void
		/** Return false to skip invalidation for this event. */
		shouldInvalidate?: (event: TEvent) => boolean
	} = {}
): UseSubscriptionReturn<TEvent> {
	const { onEvent, shouldInvalidate, ...subscriptionOptions } = options
	const { useSubscription, invalidate } = useApiClient<TOrpc>({
		orpc: options.orpc
	})
	return useSubscription(input, subscribeFn, {
		...subscriptionOptions,
		onEvent: (event) => {
			onEvent?.(event)
			if (shouldInvalidate?.(event) === false) return
			void invalidate(keyFn)
		}
	})
}

/**
 * One app-wide stream of `{ domain }` change events that keeps list and count
 * queries fresh: each event invalidates its domain's query keys (debounced),
 * and a reconnect that proves healthy invalidates every domain to cover
 * events lost while it was down. Call once, in the signed-in shell.
 *
 * ```ts
 * useInvalidationStream({}, (o) => o.realtime.subscribeChanges.call, {
 *   domains: { order: { debounceMs: 100, queryKeys: [orpc.order.key()] } }
 * })
 * ```
 */
export function useInvalidationStream<
	TInput,
	TEvent extends { domain: string },
	TOrpc = RegisteredOrpcUtils
>(
	input: MaybeRefOrGetter<TInput>,
	subscribe: OrpcSubscribeFn<TInput, TEvent, TOrpc>,
	options: InvalidationStreamOptions<TEvent> &
		Pick<
			UseSubscriptionOptions<TEvent, TOrpc>,
			'immediate' | 'respectVisibility' | 'orpc'
		>
): UseSubscriptionReturn<TEvent> {
	const coordinator = createInvalidationCoordinator(useQueryClient(), options)
	if (getCurrentScope()) onScopeDispose(coordinator.dispose)
	return useOrpcSubscription<TInput, TEvent, TOrpc>(input, subscribe, {
		immediate: options.immediate,
		respectVisibility: options.respectVisibility,
		orpc: options.orpc,
		maxEvents: 1,
		onEvent: coordinator.event,
		onConnect: coordinator.connect,
		onError: coordinator.lost,
		onClose: coordinator.lost
	})
}

/** Localized text for a failed query: your fallback unless the server marked its message user-safe. */
export function useQueryErrorMessage(
	error: MaybeRefOrGetter<unknown>,
	fallback: MaybeRefOrGetter<string>
) {
	return computed(() => {
		const err = toValue(error)
		return err ? userFacingErrorMessage(err, toValue(fallback)) : null
	})
}
