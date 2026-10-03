import type { Schema } from '@orpc/contract'
import { type AnyProcedure, ORPCError } from '@orpc/server'
import type { ZodObject, ZodRawShape, ZodType, z } from 'zod'
import type { FnLogger } from '../logger.js'
import { FN_META_KEY, type StoredFnMeta } from '../meta.js'
import { errorMessageOf, type SpanLike, type Tracing } from '../otel.js'
import type {
	BuilderLike,
	FnContext,
	FnDefinition,
	FnProcedure,
	MaybePromise,
	ProcedureKey
} from '../types.js'
import type {
	BacklogOptions,
	PubSubMessage,
	PubSubTransport
} from './transport.js'

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A static channel name, or one derived from (partial) subscriber input or
 * event data.
 */
export type ChannelDefinition<TInput, TEventData, TContext = unknown> =
	| string
	| ((
			params: Partial<TInput> | Partial<TEventData>,
			context?: TContext
	  ) => string)

/** Decides whether one event reaches one subscriber. */
export type FilterFn<TInput, TEventData> = (params: {
	input: TInput
	data: TEventData
}) => MaybePromise<boolean>

/**
 * Checked when a subscription opens. `true` allows everyone; a function
 * returns false (or throws) to refuse with FORBIDDEN.
 */
export type AuthFn<TInput, TContext> =
	| ((params: { input: TInput; ctx: TContext }) => MaybePromise<boolean>)
	| true

type PublisherConfig = {
	/** Required name for tracing (e.g. 'chat.messages'). */
	name: string
	/**
	 * Store recent events in a backlog list; new subscribers receive it before
	 * live events. Default: false
	 */
	useBacklog?: boolean
	/** Maximum backlog items to keep (default: 50). */
	backlogSize?: number
	/** Backlog TTL in seconds (default: 30). */
	backlogTtl?: number
	/**
	 * Also publish every payload to this channel (with its own backlog when
	 * `useBacklog`). Subscribers still use `channel`. Equal to the primary
	 * channel means no duplicate work.
	 */
	mirrorChannel?: string
}

export type PubSubOptions<
	TDef extends FnDefinition,
	TInputShape extends ZodRawShape,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>
> = PublisherConfig & {
	channel: ChannelDefinition<
		z.infer<ZodObject<TInputShape>>,
		z.infer<TEventSchema>,
		FnContext<TDef, TKey>
	>
	/** What the subscriber provides. */
	inputSchema: ZodObject<TInputShape>
	/** What gets published. */
	eventSchema: TEventSchema
	filterFn?: FilterFn<z.infer<ZodObject<TInputShape>>, z.infer<TEventSchema>>
	authFn?: AuthFn<z.infer<ZodObject<TInputShape>>, FnContext<TDef, TKey>>
	/**
	 * When a slow subscriber's queue overflows (drop-oldest), enqueue this
	 * marker INSTEAD of the new event so the subscriber resyncs from its
	 * cursor. A wholly dropped item leaves no per-item gap a consumer could
	 * detect, so the marker is the only reliable live signal of loss. Return
	 * null to skip.
	 */
	overflowMarker?: (
		input: z.infer<ZodObject<TInputShape>>
	) => z.infer<TEventSchema> | null
	/** Which `procedures` builder the subscribe route uses. */
	procedure?: TKey
	tags?: TDef['tag'][]
	summary?: string
	description?: string
}

export type PubSub<
	TDef extends FnDefinition,
	TInputShape extends ZodRawShape,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>
> = {
	subscribe: FnProcedure<
		TDef,
		TKey,
		ZodObject<TInputShape>,
		Schema<
			AsyncGenerator<z.infer<TEventSchema>, void, unknown>,
			AsyncGenerator<z.infer<TEventSchema>, void, unknown>
		>
	>
	publish: (data: z.infer<TEventSchema>) => Promise<void>
	/** Publish a batch in one atomic round-trip; items may target different channels. */
	publishMany: (items: z.infer<TEventSchema>[]) => Promise<void>
	getChannelName: (
		params:
			| Partial<z.infer<ZodObject<TInputShape>>>
			| Partial<z.infer<TEventSchema>>,
		context?: FnContext<TDef, TKey>
	) => string
}

export type CreatePubSub<TDef extends FnDefinition> = <
	TInputShape extends ZodRawShape,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef> = TDef['default']
>(
	options: PubSubOptions<TDef, TInputShape, TEventSchema, NoInfer<TKey>> & {
		procedure?: TKey
	}
) => PubSub<TDef, TInputShape, TEventSchema, TKey>

export type PublisherOptions<TEventSchema extends ZodType> = PublisherConfig & {
	/** Static channel name, or a resolver over (partial) event data. */
	channel: string | ((params: Partial<z.infer<TEventSchema>>) => string)
	eventSchema: TEventSchema
}

export type Publisher<TEventSchema extends ZodType> = {
	publish: (data: z.infer<TEventSchema>) => Promise<void>
	publishMany: (items: z.infer<TEventSchema>[]) => Promise<void>
	getChannelName: (params: Partial<z.infer<TEventSchema>>) => string
}

/**
 * Publish-only counterpart to `createPubSub`, for buses whose subscribe side
 * lives elsewhere (e.g. an `fnLive` route sharing the channel and schema).
 */
export type CreatePublisher = <TEventSchema extends ZodType>(
	options: PublisherOptions<TEventSchema>
) => Publisher<TEventSchema>

export type LiveRuntimeOptions = {
	procedures: Record<string, BuilderLike>
	default: string
	tracing: Tracing
	createLogger: (scope: string, span: SpanLike | undefined) => FnLogger
	pubsub?: {
		transport: PubSubTransport
		/** Called once per event dropped from a slow subscriber's queue. */
		onDrop?: (count: number, info: { name: string; channel: string }) => void
		/** Per-subscriber queue bound before drop-oldest (default: 1000). */
		maxQueueSize?: number
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Bounded queue
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bounded drop-oldest FIFO with "one overflow marker per overflow episode"
 * semantics.
 *
 * On the FIRST overflow of an episode the oldest message is dropped and the
 * marker from `createOverflowMarker` is enqueued INSTEAD of the new event - the
 * subscriber's resync-from-cursor recovers the loss. While that marker is still
 * queued, further overflows drop the oldest NON-marker message (the marker
 * itself is never displaced) and enqueue the new event WITHOUT a second marker:
 * the pending marker's resync already covers every drop that happens before it
 * is delivered. Without this dedupe a sustained overflow converges the whole
 * queue to markers - one full snapshot re-run per queued slot. Dequeuing the
 * marker ends the episode; the next overflow starts a fresh one.
 *
 * `createOverflowMarker` absent (or returning null) falls back to plain
 * drop-oldest with the new event enqueued.
 */
export function createBoundedEventQueue<T>(opts: {
	maxSize: number
	createOverflowMarker?: () => T | null
	/** Called once per dropped message (metrics/counters). */
	onDrop?: () => void
}) {
	const items: T[] = []
	// The queued marker while an overflow episode is open. Created once per
	// episode, so identity is the exact "is this the pending marker?" test.
	let pendingOverflowMarker: T | null = null

	return {
		get length() {
			return items.length
		},
		enqueue(data: T): void {
			if (items.length >= opts.maxSize) {
				if (pendingOverflowMarker !== null) {
					// Episode already signalled: drop the oldest non-marker message
					// and enqueue WITHOUT a second marker.
					const dropIndex = items[0] === pendingOverflowMarker ? 1 : 0
					if (dropIndex >= items.length) {
						// Degenerate maxSize: the queue is just the pending marker, so
						// the new event is the drop - the marker's resync covers it.
						opts.onDrop?.()
						return
					}
					items.splice(dropIndex, 1)
					opts.onDrop?.()
					items.push(data)
					return
				}
				items.shift()
				opts.onDrop?.()
				const marker = opts.createOverflowMarker?.() ?? null
				if (marker !== null) {
					pendingOverflowMarker = marker
					items.push(marker)
					return
				}
			}
			items.push(data)
		},
		dequeue(): T | undefined {
			const next = items.shift()
			if (next !== undefined && next === pendingOverflowMarker) {
				pendingOverflowMarker = null
			}
			return next
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Runtime
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_QUEUE_SIZE = 1000

// Exponential resubscribe backoff with jitter so reconnecting subscribers don't stampede the broker.
const RESUBSCRIBE_BASE_DELAY_MS = 1000
const RESUBSCRIBE_MAX_DELAY_MS = 30_000
const RESUBSCRIBE_MAX_JITTER_MS = 250

function getResubscribeDelayMs(attempt: number): number {
	const base = Math.min(
		RESUBSCRIBE_BASE_DELAY_MS * 2 ** attempt,
		RESUBSCRIBE_MAX_DELAY_MS
	)
	return base + Math.floor(Math.random() * RESUBSCRIBE_MAX_JITTER_MS)
}

type LocalSubscriber<TInput, TEventData> = {
	input: TInput
	isActive: () => boolean
	deliver: (data: TEventData) => void
	onFilterError: (error: unknown) => void
}

type Hub<TInput, TEventData> = {
	subscribers: Set<LocalSubscriber<TInput, TEventData>>
	/** Resolves once the channel is first subscribed (or the hub closed). */
	ready: Promise<void>
	close: () => void
}

type BuilderChain = {
	route(route: Record<string, unknown>): BuilderChain
	meta(meta: Record<string, unknown>): BuilderChain
	input(schema: unknown): BuilderChain
	handler(handler: unknown): AnyProcedure
}

type SubscribeOptions = {
	input: Record<string, unknown>
	context: unknown
	signal?: AbortSignal
}

const compact = (value: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

export function createLiveRuntime(options: LiveRuntimeOptions) {
	const { tracing, createLogger } = options
	const logger = createLogger('pubsub', undefined)
	// Deploy drain: every open subscription registers its close here. On
	// SIGTERM the app ends them deliberately instead of letting the socket die
	// with the process: the generator returns, oRPC closes the SSE response and
	// the client's backoff reconnects to the new deployment.
	const activeSubscriberCleanups = new Set<() => void>()

	const requireTransport = () => {
		if (!options.pubsub) {
			throw new Error(
				'orpc-fn: live routes need a transport, pass createFn({ pubsub: { transport } })'
			)
		}
		return options.pubsub.transport
	}

	/**
	 * Shared publish pipeline: schema-validate, resolve the channel from the
	 * validated event, then publish (atomically maintaining the backlog when
	 * enabled) inside a producer span.
	 */
	function createChannelPublisher<TEventSchema extends ZodType>(
		config: PublisherConfig & {
			eventSchema: TEventSchema
			getChannelName: (data: z.infer<TEventSchema>) => string
		}
	) {
		const { name, eventSchema, getChannelName, mirrorChannel } = config
		const backlog: BacklogOptions | undefined = config.useBacklog
			? { size: config.backlogSize ?? 50, ttlSeconds: config.backlogTtl ?? 30 }
			: undefined

		const toMessages = (items: readonly unknown[]): PubSubMessage[] =>
			items.flatMap((item) => {
				const data = eventSchema.parse(item)
				const channel = getChannelName(data)
				const payload = JSON.stringify(data)
				return mirrorChannel && mirrorChannel !== channel
					? [
							{ channel, payload },
							{ channel: mirrorChannel, payload }
						]
					: [{ channel, payload }]
			})

		const send = (operation: 'publish' | 'publishMany', items: unknown[]) =>
			tracing.inSpan(`${name}:${operation}`, 'PRODUCER', async (span) => {
				const startTime = performance.now()
				try {
					span?.setAttribute('pubsub.operation', operation)
					span?.setAttribute('pubsub.name', name)
					const messages = toMessages(items)
					span?.setAttribute('pubsub.batch_size', items.length)
					const first = messages[0]
					if (first) {
						span?.setAttribute('pubsub.channel', first.channel)
						span?.setAttribute('pubsub.payload_size', first.payload.length)
					}
					await requireTransport().publish(messages, backlog)
					tracing.ok(span)
				} catch (error) {
					tracing.fail(span, error)
					throw error
				} finally {
					span?.setAttribute(
						'pubsub.duration_ms',
						performance.now() - startTime
					)
					span?.end()
				}
			})

		return {
			publish: (data: z.infer<TEventSchema>) => send('publish', [data]),
			publishMany: async (items: z.infer<TEventSchema>[]) => {
				if (items.length > 0) await send('publishMany', items)
			}
		}
	}

	/**
	 * Hubs for one pub/sub definition, keyed by channel. Many subscribers can
	 * share a channel (an org with many open tabs); one hub parses and
	 * validates each payload once and fans the parsed event out to every local
	 * subscriber, applying each subscriber's own filter. The hub also owns the
	 * broker subscription and its resubscribe backoff.
	 */
	function createChannelHubs<TInput, TEventData>(config: {
		eventSchema: ZodType<TEventData>
		filterFn: FilterFn<TInput, TEventData>
	}) {
		type Subscriber = LocalSubscriber<TInput, TEventData>
		const { eventSchema, filterFn } = config
		const hubs = new Map<string, Hub<TInput, TEventData>>()

		const createHub = (channel: string): Hub<TInput, TEventData> => {
			const subscribers = new Set<Subscriber>()
			let closed = false
			let unsubscribe: (() => Promise<void>) | null = null
			let attempt = 0
			let timer: ReturnType<typeof setTimeout> | null = null
			let markReady = () => {}
			const ready = new Promise<void>((resolve) => {
				markReady = resolve
			})

			const onRawMessage = (raw: string) => {
				let parsed: TEventData
				try {
					parsed = eventSchema.parse(JSON.parse(raw))
				} catch (error) {
					// Malformed payloads are dropped once for the whole channel.
					logger.warn(`Dropped malformed message on ${channel}`, {
						error: errorMessageOf(error)
					})
					return
				}
				for (const sub of [...subscribers]) {
					if (!sub.isActive()) continue
					Promise.resolve(filterFn({ input: sub.input, data: parsed }))
						.then((include) => {
							if (include && sub.isActive()) sub.deliver(parsed)
						})
						.catch((error) => sub.onFilterError(error))
				}
			}

			const release = (stale: (() => Promise<void>) | null) => {
				stale?.().catch((error) => {
					logger.warn(`Failed to unsubscribe from ${channel}`, {
						error: errorMessageOf(error)
					})
				})
			}

			const scheduleResubscribe = (reason: string) => {
				if (closed || timer) return
				const delayMs = getResubscribeDelayMs(attempt)
				attempt++
				logger.warn(`Scheduling resubscribe for ${channel}`, {
					reason,
					attempt,
					delayMs
				})
				timer = setTimeout(() => {
					timer = null
					if (closed) return
					release(unsubscribe)
					unsubscribe = null
					void connect()
				}, delayMs)
			}

			const connect = async () => {
				try {
					const next = await requireTransport().subscribe(
						channel,
						onRawMessage,
						(error) => {
							logger.error(`Subscription to ${channel} lost`, {
								error: error.message
							})
							scheduleResubscribe('lost')
						}
					)
					if (closed) return release(next)
					unsubscribe = next
					attempt = 0
					logger.info(`Subscribed to ${channel}`)
					markReady()
				} catch (error) {
					logger.error(`Failed to subscribe to ${channel}`, {
						error: errorMessageOf(error)
					})
					scheduleResubscribe('subscribe-failed')
				}
			}

			void connect()

			return {
				subscribers,
				ready,
				close: () => {
					closed = true
					if (timer) clearTimeout(timer)
					timer = null
					markReady()
					release(unsubscribe)
					unsubscribe = null
				}
			}
		}

		return function addLocalSubscriber(
			channel: string,
			subscriber: Subscriber
		) {
			let hub = hubs.get(channel)
			if (!hub) {
				hub = createHub(channel)
				hubs.set(channel, hub)
			}
			hub.subscribers.add(subscriber)
			const current = hub
			return {
				ready: current.ready,
				remove: () => {
					current.subscribers.delete(subscriber)
					if (current.subscribers.size === 0 && hubs.get(channel) === current) {
						current.close()
						hubs.delete(channel)
					}
				}
			}
		}
	}

	function createPubSub(pubsubOptions: {
		name: string
		channel: ChannelDefinition<Record<string, unknown>, unknown>
		inputSchema: ZodType
		eventSchema: ZodType
		filterFn?: FilterFn<Record<string, unknown>, unknown>
		authFn?: AuthFn<Record<string, unknown>, unknown>
		overflowMarker?: (input: Record<string, unknown>) => unknown
		procedure?: string
		tags?: string[]
		summary?: string
		description?: string
		useBacklog?: boolean
		backlogSize?: number
		backlogTtl?: number
		mirrorChannel?: string
	}) {
		const {
			name,
			channel,
			inputSchema,
			eventSchema,
			filterFn = () => true,
			authFn,
			overflowMarker,
			useBacklog = false
		} = pubsubOptions
		const key = pubsubOptions.procedure ?? options.default
		const builder = options.procedures[key] as unknown as
			| BuilderChain
			| undefined
		if (!builder) throw new Error(`orpc-fn: unknown procedure "${key}"`)

		const getChannelName = (
			params: Record<string, unknown>,
			context?: unknown
		): string =>
			typeof channel === 'string' ? channel : channel(params, context)

		const addLocalSubscriber = createChannelHubs<
			Record<string, unknown>,
			unknown
		>({
			eventSchema,
			filterFn
		})

		const stored: StoredFnMeta = { name, procedure: key, meta: {} }
		const subscribe = builder
			.route(
				compact({
					method: 'GET',
					operationId: name,
					tags: pubsubOptions.tags,
					summary: pubsubOptions.summary ?? `Subscribe to ${name}`,
					description: pubsubOptions.description
				})
			)
			.meta({ [FN_META_KEY]: stored })
			.input(inputSchema)
			.handler(async function* ({ input, signal, context }: SubscribeOptions) {
				const transport = requireTransport()
				const channelName = getChannelName(input, context)
				const startTime = performance.now()
				const span = tracing.startSpan(`${name}:subscribe`, 'SERVER', {
					'pubsub.channel': channelName,
					'pubsub.operation': 'subscribe',
					'pubsub.name': name
				})
				const subscriberLogger = createLogger('pubsub', span)

				if (authFn !== undefined && authFn !== true) {
					if (!(await authFn({ input, ctx: context }))) {
						tracing.fail(span, new Error('Subscription authorization failed'))
						span?.end()
						throw new ORPCError('FORBIDDEN', {
							message: 'You do not have access to this subscription'
						})
					}
				}

				subscriberLogger.info(`Subscribing to ${channelName}`)

				let isClosed = false
				let resolveNext: ((value: unknown) => void) | null = null
				let messageCount = 0
				let droppedCount = 0
				const queue = createBoundedEventQueue<unknown>({
					maxSize: options.pubsub?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
					createOverflowMarker: () => overflowMarker?.(input) ?? null,
					onDrop: () => {
						droppedCount++
						options.pubsub?.onDrop?.(1, { name, channel: channelName })
					}
				})
				const enqueue = (data: unknown) => {
					messageCount++
					if (resolveNext) {
						resolveNext(data)
						resolveNext = null
					} else {
						queue.enqueue(data)
					}
				}
				const close = () => {
					isClosed = true
					resolveNext?.(CLOSED)
					resolveNext = null
				}
				const next = () =>
					new Promise<unknown>((resolve) => {
						if (queue.length > 0) resolve(queue.dequeue())
						else if (isClosed) resolve(CLOSED)
						else resolveNext = resolve
					})

				activeSubscriberCleanups.add(close)
				signal?.addEventListener('abort', close)
				const local = addLocalSubscriber(channelName, {
					input,
					isActive: () => !isClosed,
					deliver: enqueue,
					onFilterError: (error) =>
						subscriberLogger.error('Error processing message', {
							error: errorMessageOf(error)
						})
				})

				// Replay the backlog once, after the channel is first subscribed.
				if (useBacklog) {
					void local.ready.then(async () => {
						if (isClosed) return
						try {
							const items = await transport.readBacklog(channelName)
							span?.setAttribute('pubsub.backlog_count', items.length)
							for (const raw of items) {
								if (isClosed) return
								try {
									const data = eventSchema.parse(JSON.parse(raw))
									if ((await filterFn({ input, data })) && !isClosed)
										enqueue(data)
								} catch {
									// Ignore malformed backlog entries
								}
							}
						} catch (error) {
							// Live events still flow; only the backlog replay is lost.
							subscriberLogger.warn(
								`Failed to replay backlog for ${channelName}`,
								{
									error: errorMessageOf(error)
								}
							)
						}
					})
				}

				try {
					while (!isClosed && !signal?.aborted) {
						const message = await next()
						if (message === CLOSED) break
						yield message
					}
					tracing.ok(span)
				} catch (error) {
					tracing.fail(span, error)
					throw error
				} finally {
					activeSubscriberCleanups.delete(close)
					close()
					signal?.removeEventListener('abort', close)
					local.remove()
					const durationMs = performance.now() - startTime
					span?.setAttribute('pubsub.duration_ms', durationMs)
					span?.setAttribute('pubsub.message_count', messageCount)
					span?.setAttribute('pubsub.dropped_count', droppedCount)
					span?.end()
					subscriberLogger.info(`Unsubscribed from ${channelName}`, {
						messageCount,
						droppedCount,
						durationMs: Math.round(durationMs)
					})
				}
			})

		const { publish, publishMany } = createChannelPublisher({
			...pubsubOptions,
			eventSchema,
			getChannelName: (data) => getChannelName(data as Record<string, unknown>)
		})

		return { subscribe, publish, publishMany, getChannelName }
	}

	function createPublisher(publisherOptions: {
		name: string
		channel: string | ((params: Record<string, unknown>) => string)
		eventSchema: ZodType
		useBacklog?: boolean
		backlogSize?: number
		backlogTtl?: number
		mirrorChannel?: string
	}) {
		const { channel } = publisherOptions
		const getChannelName = (params: Record<string, unknown>) =>
			typeof channel === 'string' ? channel : channel(params)
		const { publish, publishMany } = createChannelPublisher({
			...publisherOptions,
			getChannelName: (data) => getChannelName(data as Record<string, unknown>)
		})
		return { publish, publishMany, getChannelName }
	}

	return {
		createPubSub,
		createPublisher: createPublisher as CreatePublisher,
		/** Open subscriptions of this instance (drain progress, gauges). */
		activePubSubSubscriberCount: () => activeSubscriberCleanups.size,
		/** End every open subscription; returns how many were closed. */
		drainPubSubSubscribers: () => {
			const cleanups = [...activeSubscriberCleanups]
			activeSubscriberCleanups.clear()
			for (const cleanup of cleanups) {
				try {
					cleanup()
				} catch (error) {
					// A failed cleanup must not stop the drain.
					logger.warn('Subscriber cleanup failed during drain', {
						error: errorMessageOf(error)
					})
				}
			}
			return cleanups.length
		}
	}
}

/** Wakes a parked iterator when its subscription closes. */
const CLOSED = Symbol('closed')
