import type { Schema } from '@orpc/contract'
import { ORPCError } from '@orpc/server'
import type { ZodObject, ZodRawShape, ZodType, z } from 'zod'
import type { FnLogger } from '../logger.js'
import { errorMessageOf, type SpanLike, type Tracing } from '../otel.js'
import type {
	BuildProcedure,
	FnContext,
	FnDefinition,
	FnProcedure,
	MaybePromise,
	ProcedureKey,
	ProcedureOption
} from '../types.js'
import { decodePayload, encodePayload } from './codec.js'
import type {
	BacklogOptions,
	PubSubMessage,
	PubSubTransport
} from './transport.js'

// ═══════════════════════════════════════════════════════════════════════════
// Types
//
// Publishers pass an event schema's INPUT (`z.input`); subscribers, filters
// and channel resolvers see its OUTPUT (`z.output`). The raw input travels on
// the wire and every receiver parses it once.
// ═══════════════════════════════════════════════════════════════════════════

/** Any Zod object schema, including `.strict()`, `.passthrough()` and `.catchall()`. */
export type ObjectSchema = ZodObject<ZodRawShape, z.core.$ZodObjectConfig>

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
 * Checked when a subscription opens, before anything is sent. `true` allows
 * everyone; a function returns false (or throws) to refuse with FORBIDDEN.
 */
export type AuthFn<TInput, TContext> =
	| ((params: { input: TInput; ctx: TContext }) => MaybePromise<boolean>)
	| true

export type PublisherConfig = {
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
	TInputSchema extends ObjectSchema,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>
> = PublisherConfig & {
	channel: ChannelDefinition<
		z.output<TInputSchema>,
		z.output<TEventSchema>,
		FnContext<TDef, TKey>
	>
	/** What the subscriber provides. */
	inputSchema: TInputSchema
	/** What gets published. */
	eventSchema: TEventSchema
	filterFn?: FilterFn<z.output<TInputSchema>, z.output<TEventSchema>>
	authFn?: AuthFn<z.output<TInputSchema>, FnContext<TDef, TKey>>
	/**
	 * When a slow subscriber's queue overflows (drop-oldest), enqueue this
	 * marker INSTEAD of the new event so the subscriber resyncs from its
	 * cursor. A wholly dropped item leaves no per-item gap a consumer could
	 * detect, so the marker is the only reliable live signal of loss. Return
	 * null to skip.
	 */
	overflowMarker?: (
		input: z.output<TInputSchema>
	) => z.output<TEventSchema> | null
	tags?: TDef['tag'][]
	summary?: string
	description?: string
}

export type PubSub<
	TDef extends FnDefinition,
	TInputSchema extends ObjectSchema,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>
> = {
	subscribe: FnProcedure<
		TDef,
		TKey,
		TInputSchema,
		Schema<
			AsyncGenerator<z.output<TEventSchema>, void, unknown>,
			AsyncGenerator<z.output<TEventSchema>, void, unknown>
		>
	>
	publish: (data: z.input<TEventSchema>) => Promise<void>
	/** Publish a batch in one atomic round-trip; items may target different channels. */
	publishMany: (items: readonly z.input<TEventSchema>[]) => Promise<void>
	getChannelName: (
		params: Partial<z.output<TInputSchema>> | Partial<z.output<TEventSchema>>,
		context?: FnContext<TDef, TKey>
	) => string
}

export type CreatePubSub<TDef extends FnDefinition> = <
	TInputSchema extends ObjectSchema,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef> = TDef['default']
>(
	options: PubSubOptions<TDef, TInputSchema, TEventSchema, NoInfer<TKey>> &
		/** Which `procedures` builder the subscribe route uses. */
		ProcedureOption<TDef, TKey>
) => PubSub<TDef, TInputSchema, TEventSchema, TKey>

export type PublisherOptions<TEventSchema extends ZodType> = PublisherConfig & {
	/** Static channel name, or a resolver over (partial) parsed event data. */
	channel: string | ((params: Partial<z.output<TEventSchema>>) => string)
	eventSchema: TEventSchema
}

export type Publisher<TEventSchema extends ZodType> = {
	publish: (data: z.input<TEventSchema>) => Promise<void>
	publishMany: (items: readonly z.input<TEventSchema>[]) => Promise<void>
	getChannelName: (params: Partial<z.output<TEventSchema>>) => string
}

/**
 * Publish-only counterpart to `createPubSub`, for buses whose subscribe side
 * lives elsewhere (e.g. an `fnLive` route sharing the channel and schema).
 */
export type CreatePublisher = <TEventSchema extends ZodType>(
	options: PublisherOptions<TEventSchema>
) => Publisher<TEventSchema>

export type PubSubRuntimeOptions = {
	transport: PubSubTransport
	/** Called once per event dropped from a slow subscriber's queue. */
	onDrop?: (count: number, info: { name: string; channel: string }) => void
	/** Per-subscriber queue bound before drop-oldest (default: 1000). */
	maxQueueSize?: number
}

/** @internal */
export type LiveRuntimeOptions = {
	buildProcedure: BuildProcedure
	tracing: Tracing
	createLogger: (scope: string, span: SpanLike | undefined) => FnLogger
	pubsub?: PubSubRuntimeOptions | undefined
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
// Runtime (internal: the typed surface is what `createFn` returns)
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

/** Wakes a parked iterator when its subscription closes. */
const CLOSED = Symbol('closed')

type Input = Record<string, unknown>

type LocalSubscriber = {
	input: Input
	isActive: () => boolean
	deliver: (data: unknown) => void
	onFilterError: (error: unknown) => void
}

type Hub = {
	subscribers: Set<LocalSubscriber>
	/** Settles after the first subscribe attempt (or when the hub closes). */
	ready: Promise<void>
	close: () => void
}

/** An open subscription: registered, authorized and subscribed. */
export type LiveSubscription = {
	/** Live events, after the backlog replay. Ends when closed or aborted. */
	events: AsyncGenerator<unknown, void, unknown>
	/** Release everything; safe to call more than once, and before `events` runs. */
	close: () => void
}

/** @internal Untyped options; `PubSubOptions` is the typed surface. */
export type ChannelOptions = PublisherConfig & {
	channel: ChannelDefinition<Input, unknown>
	eventSchema: ZodType
	filterFn?: FilterFn<Input, unknown>
	authFn?: AuthFn<Input, unknown>
	overflowMarker?: (input: Input) => unknown
}

/** @internal */
export type Channel = {
	/** Authorize and subscribe; resolves once events can be delivered. */
	open: (options: {
		input: Input
		context: unknown
		signal: AbortSignal | undefined
	}) => Promise<LiveSubscription>
	publish: (data: unknown) => Promise<void>
	publishMany: (items: readonly unknown[]) => Promise<void>
	getChannelName: (params: Input, context?: unknown) => string
}

const resolveChannel = (
	channel: string | ((params: Input, context?: unknown) => string),
	params: Input,
	context?: unknown
) => (typeof channel === 'string' ? channel : channel(params, context))

/** @internal */
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
	 * Shared publish pipeline: validate the raw event, resolve the channel from
	 * the parsed event, then publish the raw event (atomically maintaining the
	 * backlog when enabled) inside a producer span.
	 */
	function createChannelPublisher(
		config: PublisherConfig & {
			eventSchema: ZodType
			getChannelName: (data: Input) => string
		}
	) {
		const { name, eventSchema, getChannelName, mirrorChannel } = config
		const backlog: BacklogOptions | undefined = config.useBacklog
			? { size: config.backlogSize ?? 50, ttlSeconds: config.backlogTtl ?? 30 }
			: undefined

		const toMessages = async (items: readonly unknown[]) => {
			const messages: PubSubMessage[] = []
			for (const item of items) {
				const data = (await eventSchema.parseAsync(item)) as Input
				const channel = getChannelName(data)
				const payload = encodePayload(item)
				messages.push({ channel, payload })
				if (mirrorChannel && mirrorChannel !== channel) {
					messages.push({ channel: mirrorChannel, payload })
				}
			}
			return messages
		}

		const send = (
			operation: 'publish' | 'publishMany',
			items: readonly unknown[]
		) =>
			tracing.inSpan(`${name}:${operation}`, 'PRODUCER', async (span) => {
				const startTime = performance.now()
				try {
					span?.setAttribute('pubsub.operation', operation)
					span?.setAttribute('pubsub.name', name)
					span?.setAttribute('pubsub.batch_size', items.length)
					const messages = await toMessages(items)
					const first = messages[0]
					if (first) {
						span?.setAttribute('pubsub.channel', first.channel)
						span?.setAttribute('pubsub.payload_size', first.payload.length)
					}
					await requireTransport().publish(messages, backlog)
				} finally {
					span?.setAttribute(
						'pubsub.duration_ms',
						performance.now() - startTime
					)
				}
			})

		return {
			publish: (data: unknown) => send('publish', [data]),
			publishMany: async (items: readonly unknown[]) => {
				if (items.length > 0) await send('publishMany', items)
			}
		}
	}

	/**
	 * Hubs for one pub/sub definition, keyed by channel. Many subscribers can
	 * share a channel (an org with many open tabs); one hub decodes and parses
	 * each payload once and fans the event out to every local subscriber,
	 * applying each subscriber's own filter. The hub also owns the broker
	 * subscription and its resubscribe backoff.
	 */
	function createChannelHubs(config: {
		eventSchema: ZodType
		filterFn: FilterFn<Input, unknown> | undefined
	}) {
		const { eventSchema, filterFn } = config
		const hubs = new Map<string, Hub>()

		const createHub = (channel: string): Hub => {
			const subscribers = new Set<LocalSubscriber>()
			let closed = false
			let unsubscribe: (() => Promise<void>) | null = null
			let attempt = 0
			let timer: ReturnType<typeof setTimeout> | null = null
			let markReady = () => {}
			const ready = new Promise<void>((resolve) => {
				markReady = resolve
			})
			// Parse in arrival order even when the schema is async.
			let parsing = Promise.resolve()

			const deliver = async (raw: string) => {
				let parsed: unknown
				try {
					parsed = await eventSchema.parseAsync(decodePayload(raw))
				} catch (error) {
					// Malformed payloads are dropped once for the whole channel.
					logger.warn(`Dropped malformed message on ${channel}`, {
						error: errorMessageOf(error)
					})
					return
				}
				for (const sub of [...subscribers]) {
					if (!sub.isActive()) continue
					if (!filterFn) {
						sub.deliver(parsed)
						continue
					}
					// `then` also catches a filter that throws synchronously, so one
					// subscriber's filter cannot starve the others.
					Promise.resolve()
						.then(() => filterFn({ input: sub.input, data: parsed }))
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
						(raw) => {
							parsing = parsing.then(() => deliver(raw))
						},
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
				} catch (error) {
					logger.error(`Failed to subscribe to ${channel}`, {
						error: errorMessageOf(error)
					})
					scheduleResubscribe('subscribe-failed')
				} finally {
					// A failed first attempt must not hold subscribers forever; the
					// backoff keeps retrying in the background.
					markReady()
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
			subscriber: LocalSubscriber
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

	/** Publish and open subscriptions on one channel definition. */
	function createChannel(channelOptions: ChannelOptions): Channel {
		const {
			name,
			channel,
			eventSchema,
			filterFn,
			authFn,
			overflowMarker,
			useBacklog = false
		} = channelOptions

		const getChannelName = (params: Input, context?: unknown) =>
			resolveChannel(channel, params, context)
		const addLocalSubscriber = createChannelHubs({ eventSchema, filterFn })

		const open: Channel['open'] = async ({ input, context, signal }) => {
			const transport = requireTransport()
			const channelName = getChannelName(input, context)
			const startTime = performance.now()
			const span = tracing.startSpan(`${name}:subscribe`, 'SERVER', {
				'pubsub.channel': channelName,
				'pubsub.operation': 'subscribe',
				'pubsub.name': name
			})
			const subscriberLogger = createLogger('pubsub', span)

			try {
				if (
					authFn !== undefined &&
					authFn !== true &&
					!(await authFn({ input, ctx: context }))
				) {
					throw new ORPCError('FORBIDDEN', {
						message: 'You do not have access to this subscription'
					})
				}
			} catch (error) {
				tracing.end(span, error)
				throw error
			}

			subscriberLogger.info(`Subscribing to ${channelName}`)

			let closed = false
			let finished = false
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
			const wake = () => {
				closed = true
				resolveNext?.(CLOSED)
				resolveNext = null
			}
			const next = () =>
				new Promise<unknown>((resolve) => {
					if (queue.length > 0) resolve(queue.dequeue())
					else if (closed) resolve(CLOSED)
					else resolveNext = resolve
				})

			const local = addLocalSubscriber(channelName, {
				input,
				isActive: () => !closed,
				deliver: enqueue,
				onFilterError: (error) =>
					subscriberLogger.error('Error processing message', {
						error: errorMessageOf(error)
					})
			})
			activeSubscriberCleanups.add(wake)
			signal?.addEventListener('abort', wake)
			if (signal?.aborted) wake()

			const finish = (error?: unknown) => {
				if (finished) return
				finished = true
				wake()
				activeSubscriberCleanups.delete(wake)
				signal?.removeEventListener('abort', wake)
				local.remove()
				const durationMs = performance.now() - startTime
				span?.setAttribute('pubsub.duration_ms', durationMs)
				span?.setAttribute('pubsub.message_count', messageCount)
				span?.setAttribute('pubsub.dropped_count', droppedCount)
				if (error === undefined) tracing.end(span)
				else tracing.end(span, error)
				subscriberLogger.info(`Unsubscribed from ${channelName}`, {
					messageCount,
					droppedCount,
					durationMs: Math.round(durationMs)
				})
			}

			// Subscribed (or first attempt failed and retrying) before returning,
			// so nothing published after `open` resolves is missed.
			await local.ready
			if (useBacklog && !closed) {
				try {
					const items = await transport.readBacklog(channelName)
					span?.setAttribute('pubsub.backlog_count', items.length)
					for (const raw of items) {
						if (closed) break
						try {
							const data = await eventSchema.parseAsync(decodePayload(raw))
							if ((!filterFn || (await filterFn({ input, data }))) && !closed)
								enqueue(data)
						} catch {
							// Ignore malformed backlog entries
						}
					}
				} catch (error) {
					// Live events still flow; only the backlog replay is lost.
					subscriberLogger.warn(`Failed to replay backlog for ${channelName}`, {
						error: errorMessageOf(error)
					})
				}
			}

			async function* events() {
				try {
					while (!closed) {
						const message = await next()
						if (message === CLOSED) break
						yield message
					}
				} finally {
					finish()
				}
			}

			return { events: events(), close: () => finish() }
		}

		const { publish, publishMany } = createChannelPublisher({
			...channelOptions,
			getChannelName
		})

		return { open, publish, publishMany, getChannelName }
	}

	function createPubSub(
		pubsubOptions: ChannelOptions & {
			inputSchema: ZodType
			procedure?: string
			tags?: string[]
			summary?: string
			description?: string
		}
	) {
		const { name } = pubsubOptions
		const channel = createChannel(pubsubOptions)
		const subscribe = options.buildProcedure({
			name,
			procedure: pubsubOptions.procedure,
			meta: {},
			route: {
				method: 'GET',
				tags: pubsubOptions.tags,
				summary: pubsubOptions.summary ?? `Subscribe to ${name}`,
				description: pubsubOptions.description
			},
			input: pubsubOptions.inputSchema,
			handler: async function* ({ input, context, signal }) {
				// The generator from `events()` releases everything when it ends.
				yield* (await channel.open({ input: input as Input, context, signal }))
					.events
			}
		})

		const { publish, publishMany, getChannelName } = channel
		return { subscribe, publish, publishMany, getChannelName }
	}

	function createPublisher(publisherOptions: PublisherOptions<ZodType>) {
		const getChannelName = (params: Input) =>
			resolveChannel(publisherOptions.channel, params)
		const { publish, publishMany } = createChannelPublisher({
			...publisherOptions,
			getChannelName
		})
		return { publish, publishMany, getChannelName }
	}

	return {
		createChannel,
		createPubSub,
		createPublisher,
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
