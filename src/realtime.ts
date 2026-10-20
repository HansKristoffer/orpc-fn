// Framework-free subscription and invalidation logic shared by `orpc-fn/vue`
// and `orpc-fn/react`. Not a public subpath: each framework wraps it.
import type { FnLogger } from './logger.js'

export type LiveConnectionStatus =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'error'
	| 'closed'

const BASE_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 15_000

/**
 * Backoff for attempt N (1-based): exponential from 1s capped at 15s, plus
 * 0-25% jitter so a fleet of clients doesn't thundering-herd a recovering
 * server. The delay is capped, never the attempts: a dead network keeps
 * retrying at the ceiling instead of killing the stream for good.
 */
export function nextReconnectDelayMs(
	errorCount: number,
	random: () => number = Math.random
): number {
	const attempt = Math.max(1, errorCount)
	const base = Math.min(
		BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1),
		MAX_RECONNECT_DELAY_MS
	)
	return Math.round(base + base * 0.25 * random())
}

type SubscriptionRunnerOptions<TEvent> = {
	open: (signal: AbortSignal) => Promise<AsyncIterable<TEvent>>
	onEvent: (event: TEvent, connectionId: number) => void
	onStatus: (status: LiveConnectionStatus) => void
	onConnect?: ((connectionId: number) => void) | undefined
	onError?: ((error: Error) => void) | undefined
	onClose?: (() => void) | undefined
	/** May a stream run at all right now (e.g. the app is in the foreground)? */
	canConnect: () => boolean
	/** Reconnect with backoff after an unexpected end? Checked when scheduling and firing. */
	shouldReconnect: () => boolean
}

export type SubscriptionRunner = ReturnType<typeof createSubscriptionRunner>

/**
 * One oRPC event-iterator stream with generation-guarded connects, abortable
 * teardown and backoff reconnects. Every connect claims a new connection id;
 * a superseded attempt closes its own iterator and never reports events.
 */
export function createSubscriptionRunner<TEvent>(
	options: SubscriptionRunnerOptions<TEvent>
) {
	let status: LiveConnectionStatus = 'idle'
	let abortController: AbortController | null = null
	let iterator: AsyncIterator<TEvent> | null = null
	let connectPromise: Promise<void> | null = null
	let activeConnectionId = 0
	/** Set by deliberate teardown so stream-end does not schedule a retry. */
	let intentionalDisconnect = false
	let errorCount = 0
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let disposed = false

	const setStatus = (next: LiveConnectionStatus) => {
		status = next
		options.onStatus(next)
	}

	function clearReconnectTimer() {
		if (reconnectTimer === null) return
		clearTimeout(reconnectTimer)
		reconnectTimer = null
	}

	function scheduleReconnect() {
		if (intentionalDisconnect || disposed || reconnectTimer !== null) return
		if (!options.shouldReconnect()) return
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null
			if (disposed || intentionalDisconnect || !options.shouldReconnect())
				return
			void connect()
		}, nextReconnectDelayMs(errorCount))
	}

	function handleUnexpectedEnd(error: Error | null) {
		errorCount += 1
		// Close the socket of a failed stream; on React Native an unaborted
		// expo/fetch request keeps holding a connection from the device's pool.
		abortController?.abort()
		abortController = null
		iterator = null
		if (error) {
			setStatus('error')
			options.onError?.(error)
		} else {
			setStatus('closed')
			options.onClose?.()
		}
		scheduleReconnect()
	}

	async function connect(): Promise<void> {
		if (disposed || !options.canConnect()) return
		if (connectPromise) return connectPromise
		if (status === 'connected' || reconnectTimer !== null) return

		intentionalDisconnect = false
		const thisConnect = (async () => {
			setStatus('connecting')
			// Claim the generation and controller before awaiting, so a
			// disconnect while opening supersedes this attempt.
			const controller = new AbortController()
			abortController = controller
			const connectionId = ++activeConnectionId
			try {
				const iterable = await options.open(controller.signal)
				const localIterator = iterable[Symbol.asyncIterator]()
				if (connectionId !== activeConnectionId || controller.signal.aborted) {
					await closeIterator(localIterator)
					return
				}
				iterator = localIterator
				setStatus('connected')
				options.onConnect?.(connectionId)
				void consume(localIterator, connectionId)
			} catch (error) {
				if (connectionId !== activeConnectionId || controller.signal.aborted)
					return
				handleUnexpectedEnd(toError(error))
			}
		})()
		connectPromise = thisConnect
		try {
			await thisConnect
		} finally {
			if (connectPromise === thisConnect) connectPromise = null
		}
	}

	async function consume(
		localIterator: AsyncIterator<TEvent>,
		connectionId: number
	) {
		try {
			while (status === 'connected' && connectionId === activeConnectionId) {
				const result = await localIterator.next()
				if (status !== 'connected' || connectionId !== activeConnectionId)
					return
				if (result.done) {
					// Proxy or idle end after a live connect: recoverable.
					if (!intentionalDisconnect) handleUnexpectedEnd(null)
					return
				}
				// Reset backoff only once the stream delivers. A server that accepts
				// and then dies before yielding must keep escalating.
				errorCount = 0
				options.onEvent(result.value, connectionId)
			}
		} catch (error) {
			if (connectionId !== activeConnectionId) return
			if (abortController?.signal.aborted || intentionalDisconnect) {
				setStatus('closed')
				options.onClose?.()
				return
			}
			handleUnexpectedEnd(toError(error))
		}
	}

	async function disconnect(): Promise<void> {
		intentionalDisconnect = true
		clearReconnectTimer()
		if (status === 'idle') return

		activeConnectionId++
		abortController?.abort()
		// A fresh connect() may start while the superseded attempt winds down.
		connectPromise = null
		const localIterator = iterator
		iterator = null
		abortController = null
		if (status !== 'closed') {
			setStatus('closed')
			options.onClose?.()
		}
		await closeIterator(localIterator)
	}

	return {
		connect,
		disconnect,
		/** Connect with a fresh retry budget (input change, foreground, re-enable). */
		start() {
			errorCount = 0
			intentionalDisconnect = false
			return connect()
		},
		/** Connected, connecting, or waiting to reconnect. */
		isLive: () =>
			status === 'connected' ||
			status === 'connecting' ||
			reconnectTimer !== null,
		getStatus: () => status,
		dispose() {
			disposed = true
			return disconnect()
		}
	}
}

async function closeIterator<T>(iterator: AsyncIterator<T> | null) {
	try {
		await iterator?.return?.(undefined)
	} catch {
		// Cleanup errors are not the caller's concern.
	}
}

const toError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error))

type QueryKeyLike = readonly unknown[]

/** The part of a TanStack `QueryClient` the coordinator uses. */
type InvalidatingQueryClient = {
	invalidateQueries(filters: {
		queryKey: QueryKeyLike
		refetchType?: 'active' | 'inactive' | 'all' | 'none'
		predicate?: (query: {
			meta?: Record<string, unknown> | undefined
		}) => boolean
	}): Promise<unknown>
}

export type InvalidationDomain = {
	/**
	 * Batch a burst of events into one invalidation (ms). The window runs from
	 * the first event, so a steady stream cannot postpone the refresh forever.
	 */
	debounceMs?: number
	queryKeys: readonly QueryKeyLike[]
}

export type InvalidationStreamOptions<TEvent extends { domain: string }> = {
	/** Query keys to invalidate per event `domain`. Unmapped domains are ignored. */
	domains: { [K in TEvent['domain']]?: InvalidationDomain }
	/**
	 * Passed to `invalidateQueries`. Default: TanStack's `'active'`, which marks
	 * inactive queries stale so they refetch on their next use. `'all'` also
	 * refetches every cached query of the domain now, on each event.
	 */
	refetchType?: 'active' | 'inactive' | 'all' | 'none'
	/** Every event, after its domain is invalidated (alerts, chimes). */
	onEvent?: (event: TEvent) => void
	/** Receives one `invalidation_stream.disconnected` warning per minute at most. */
	logger?: Pick<FnLogger, 'warn'>
}

/**
 * How long a reconnected stream must stay up, having delivered nothing, before
 * it counts as working. Waiting for an event alone would leave a quiet
 * reconnect stale until the next change; not waiting at all lets a stream that
 * dies the instant it opens refetch everything once per retry.
 */
const SETTLE_MS = 1_500
const DISCONNECT_LOG_INTERVAL_MS = 60_000

/**
 * Turns a stream of `{ domain }` change events into debounced
 * `invalidateQueries` calls. Live queries (`meta.live`) are skipped: their own
 * stream keeps them current. Events published while the stream was down are
 * lost, so a reconnect that proves healthy invalidates every mapped domain.
 */
export function createInvalidationCoordinator<
	TEvent extends { domain: string }
>(
	queryClient: InvalidatingQueryClient,
	options: InvalidationStreamOptions<TEvent>
) {
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	let settleTimer: ReturnType<typeof setTimeout> | null = null
	let catchUpPending = false
	let lastLostLogAt = Number.NEGATIVE_INFINITY

	const domainConfig = (domain: string): InvalidationDomain | undefined =>
		Object.hasOwn(options.domains, domain)
			? (options.domains as Record<string, InvalidationDomain | undefined>)[
					domain
				]
			: undefined

	function invalidate(config: InvalidationDomain) {
		for (const queryKey of config.queryKeys) {
			void queryClient.invalidateQueries({
				queryKey,
				...(options.refetchType ? { refetchType: options.refetchType } : {}),
				predicate: (query) => query.meta?.live !== true
			})
		}
	}

	function invalidateAll() {
		for (const config of Object.values(options.domains)) {
			if (config) invalidate(config as InvalidationDomain)
		}
	}

	function clearSettleTimer() {
		if (settleTimer === null) return
		clearTimeout(settleTimer)
		settleTimer = null
	}

	function markHealthy() {
		clearSettleTimer()
		if (!catchUpPending) return
		catchUpPending = false
		invalidateAll()
	}

	return {
		event(event: TEvent) {
			// A delivered event proves the connection; no need to wait it out.
			markHealthy()

			// The stream is typed, but a JavaScript caller or a newer server may send anything.
			const domain: unknown = (event as { domain?: unknown } | null)?.domain
			if (typeof domain !== 'string') return

			const config = domainConfig(domain)
			const delay = config?.debounceMs ?? 0
			if (config && delay <= 0) {
				invalidate(config)
			} else if (config && !timers.has(domain)) {
				const timer = setTimeout(() => {
					timers.delete(domain)
					invalidate(config)
				}, delay)
				timers.set(domain, timer)
			}

			options.onEvent?.(event)
		},
		connect(connectionId: number) {
			clearSettleTimer()
			catchUpPending ||= connectionId > 1
			settleTimer = setTimeout(markHealthy, SETTLE_MS)
		},
		lost() {
			// Reconnecting is the subscription's job; this connection can no longer settle.
			clearSettleTimer()
			const now = Date.now()
			if (now - lastLostLogAt < DISCONNECT_LOG_INTERVAL_MS) return
			lastLostLogAt = now
			options.logger?.warn('invalidation_stream.disconnected')
		},
		dispose() {
			clearSettleTimer()
			for (const timer of timers.values()) clearTimeout(timer)
			timers.clear()
			catchUpPending = false
		}
	}
}

/**
 * Which connection and query key the open live stream belongs to. An event
 * counts only while both still match: the input changes synchronously but the
 * stream is torn down asynchronously, so a frame in flight from the previous
 * subscription would otherwise land in the new key (and, with
 * `staleTime: Infinity`, stay there).
 */
export function createStreamScope() {
	let openConnectionId: number | null = null
	let openKeyHash: string | null = null
	return {
		open(connectionId: number, keyHash: string) {
			openConnectionId = connectionId
			openKeyHash = keyHash
		},
		owns: (connectionId: number, keyHash: string) =>
			connectionId === openConnectionId && keyHash === openKeyHash
	}
}

/**
 * Wrap a live query's HTTP `queryFn`: report the raw seed, convert it with
 * `select`, and reconcile it with what the stream already wrote. The cache is
 * read after the request resolves, because stream events can arrive while it
 * is in flight.
 */
export function seedQueryFn<TRouteData, TData, TInput>(
	queryFn: (context: unknown) => Promise<TRouteData>,
	options: {
		input: TInput
		readCache: () => TData | undefined
		select?: ((data: TRouteData) => TData) | undefined
		onSeed?: ((data: TRouteData, input: TInput) => void) | undefined
		mergeSeed?:
			| ((fetched: TData, cached: TData | undefined) => TData)
			| undefined
	}
) {
	const { select, onSeed, mergeSeed } = options
	return async (context: unknown): Promise<TData> => {
		const fetched = await queryFn(context)
		onSeed?.(fetched, options.input)
		// Without `select` the route output is the cache type.
		const data = select ? select(fetched) : (fetched as unknown as TData)
		return mergeSeed ? mergeSeed(data, options.readCache()) : data
	}
}
