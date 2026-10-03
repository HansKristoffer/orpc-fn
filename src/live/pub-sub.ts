import type { Schema } from '@orpc/contract'
import { ORPCError } from '@orpc/server'
import type { ZodObject, ZodRawShape, ZodType, z } from 'zod'
import type { FnLogger } from '../logger.js'
import { errorMessageOf, type SpanLike, type Tracing } from '../otel.js'
import type {
	GuardOptions,
	FnContext,
	FnDefinition,
	FnProcedure,
	FnRouteOptions,
	MaybePromise,
	ProcedureKey,
	ProcedureOption
} from '../types.js'
import { decodeMessage, encodePayload } from './codec.js'
import { LIVE_GAP, positiveInteger, safely, waitFor } from './lifecycle.js'
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
	| {
			subscribe: (params: { input: TInput; context: TContext }) => string
			publish: (event: TEventData) => string
	  }
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

/** Per-definition overrides of the factory queue bounds. */
export type ChannelQueueOptions = {
	maxQueueSize?: number
	maxIngressSize?: number
	maxReplaySize?: number
}

/** Synchronous observational events; failures cannot interrupt delivery. */
export type PubSubMetric = { name: string; channel: string } & (
	| {
			type: 'queue'
			stage: 'ingress' | 'replay' | 'delivery'
			depth: number
			limit: number
	  }
	| { type: 'drop'; stage: 'ingress' | 'replay' | 'delivery'; count: number }
	| { type: 'reconnect' }
	| { type: 'parseError'; stage: 'ingress' | 'replay'; error: unknown }
)

export type PubSubOptions<
	TDef extends FnDefinition,
	TInputSchema extends ObjectSchema,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>
> = PublisherConfig &
	ChannelQueueOptions & {
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
	getSubscriptionChannelName: (params: {
		input: z.output<TInputSchema>
		context: FnContext<TDef, TKey>
	}) => string
	getPublishChannelName: (event: z.output<TEventSchema>) => string
	/** @deprecated Prefer the separate required-input resolver methods. */
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
		GuardOptions<TDef['guards']> &
		Pick<
			FnRouteOptions<TDef, TKey, z.output<TInputSchema>>,
			'meta' | 'guardResolvers'
		> &
		/** Which `procedures` builder the subscribe route uses. */ ProcedureOption<
			TDef,
			TKey
		>
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
	/** Queue depths, drops, successful reconnects and parse failures. */
	onMetric?: (event: PubSubMetric) => void
	transport: PubSubTransport
	/**
	 * Called per event dropped from ingress, replay or delivery queues.
	 * Delivery drops count events before subscriber filtering.
	 */
	onDrop?: (count: number, info: { name: string; channel: string }) => void
	/** Per-subscriber queue bound before drop-oldest (default: 1000). */
	maxQueueSize?: number
	/** Pending raw messages per channel, before asynchronous parsing. */
	maxIngressSize?: number
	/** Buffered live messages during replay. */
	maxReplaySize?: number
	/** Broker subscription and backlog wait bound (default 10000ms). */
	initializationTimeoutMs?: number
	/** Applied to channels, mirrors and therefore backlog keys. */
	namespace?: string
	/** Close this transport only when its ownership is explicitly transferred. */
	ownsTransport?: boolean
}

/** @internal */
export type LiveRuntimeOptions = {
	fn: (options: Record<string, unknown>) => import('@orpc/server').AnyProcedure
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
	onDepth?: (depth: number) => void
}) {
	positiveInteger(opts.maxSize, 'maxSize')
	const items: T[] = []
	// The queued marker while an overflow episode is open. Created once per
	// episode, so identity is the exact "is this the pending marker?" test.
	let pendingOverflowMarker: T | null = null

	return {
		get length() {
			return items.length
		},
		enqueue(data: T): void {
			try {
				if (items.length >= opts.maxSize) {
					if (pendingOverflowMarker !== null) {
						// Episode already signalled: drop the oldest non-marker message
						// and enqueue WITHOUT a second marker.
						const dropIndex = items[0] === pendingOverflowMarker ? 1 : 0
						if (dropIndex >= items.length) {
							// Degenerate maxSize: the queue is just the pending marker, so
							// the new event is the drop - the marker's resync covers it.
							safely(opts.onDrop)
							return
						}
						items.splice(dropIndex, 1)
						safely(opts.onDrop)
						items.push(data)
						return
					}
					items.shift()
					safely(opts.onDrop)
					const marker = opts.createOverflowMarker?.() ?? null
					if (marker !== null) {
						pendingOverflowMarker = marker
						items.push(marker)
						return
					}
				}
				items.push(data)
			} finally {
				safely(() => opts.onDepth?.(items.length))
			}
		},
		dequeue(): T | undefined {
			const next = items.shift()
			safely(() => opts.onDepth?.(items.length))
			if (next !== undefined && next === pendingOverflowMarker) {
				pendingOverflowMarker = null
			}
			return next
		}
	}
}

/**
 * One subscriber's ordered, bounded delivery. Events wait in a bounded
 * drop-oldest queue (see {@link createBoundedEventQueue}) BEFORE the
 * subscriber's filter runs; the filter runs in order as the consumer reads,
 * so a slow async filter neither reorders events nor lets pending work grow
 * past `maxSize`. Overflow markers skip the filter.
 */
export function createSubscriberDelivery<T>(options: {
	maxSize: number
	accept?: ((data: T) => MaybePromise<boolean>) | undefined
	overflowMarker?: (() => T | null) | undefined
	onFilterError: (error: unknown) => void
	onDrop: () => void
	onDepth?: (depth: number) => void
}) {
	type Item = { data: T; marker: boolean }
	const queue = createBoundedEventQueue<Item>({
		maxSize: options.maxSize,
		createOverflowMarker: () => {
			const marker = options.overflowMarker?.() ?? null
			return marker === null ? null : { data: marker, marker: true }
		},
		onDrop: options.onDrop,
		...(options.onDepth ? { onDepth: options.onDepth } : {})
	})
	let closed = false
	let failure: unknown
	let wake: (() => void) | null = null
	const notify = () => {
		wake?.()
		wake = null
	}

	async function* events(): AsyncGenerator<T, void, unknown> {
		while (!closed) {
			const item = queue.dequeue()
			if (!item) {
				await new Promise<void>((resolve) => {
					wake = resolve
				})
				continue
			}
			if (!item.marker && options.accept) {
				try {
					if (!(await options.accept(item.data))) continue
				} catch (error) {
					safely(() => options.onFilterError(error))
					continue
				}
				if (closed) break
			}
			yield item.data
		}
		if (failure !== undefined) throw failure
	}

	return {
		push(data: T, marker = false) {
			if (closed) return
			queue.enqueue({ data, marker })
			notify()
		},
		events: events(),
		/** Stop delivering; a parked read ends at once. */
		close(error?: unknown) {
			if (closed) return
			failure = error
			closed = true
			safely(() => options.onDepth?.(0))
			notify()
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

type Input = Record<string, unknown>

type LocalSubscriber = {
	isActive: () => boolean
	push: (data: unknown, id?: string) => void
	gap: () => void
	fail: (error: unknown) => void
}

type Hub = {
	subscribers: Set<LocalSubscriber>
	/** Resolves after a successful broker subscription (or closure). */
	ready: Promise<void>
	close: () => void
}

/** An open subscription: registered, authorized and subscribed. */
export type LiveSubscription = {
	/** Live events, after the backlog replay. Ends when closed or aborted. */
	events: AsyncGenerator<unknown, void, unknown>
	/** Release everything; safe to call more than once, and before `events` runs. */
	close: () => void
	isClosed: () => boolean
}

/** @internal Untyped options; `PubSubOptions` is the typed surface. */
export type ChannelOptions = PublisherConfig &
	ChannelQueueOptions & {
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
		recoverGaps?: boolean
	}) => Promise<LiveSubscription>
	publish: (data: unknown) => Promise<void>
	publishMany: (items: readonly unknown[]) => Promise<void>
	getChannelName: (params: Input, context?: unknown) => string
	getSubscriptionChannelName: (params: {
		input: Input
		context: unknown
	}) => string
	getPublishChannelName: (event: Input) => string
}

const resolveChannel = (
	channel: ChannelDefinition<Input, unknown>,
	params: Input,
	context?: unknown,
	publishing = false
) => {
	if (typeof channel === 'string') return channel
	if (typeof channel === 'function') return channel(params, context)
	return publishing
		? channel.publish(params)
		: channel.subscribe({ input: params, context })
}

/** @internal */
export function createLiveRuntime(options: LiveRuntimeOptions) {
	const { tracing, createLogger } = options
	const logger = createLogger('pubsub', undefined)
	let terminated = false
	let shutdownPromise: Promise<void> | undefined
	const releases = new Set<Promise<void>>()
	const pendingInitialization = new Set<() => void>()
	const pendingOpens = new Set<Promise<LiveSubscription>>()
	const defaultMaxQueue = positiveInteger(
		options.pubsub?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
		'maxQueueSize'
	)
	const defaultMaxIngress = positiveInteger(
		options.pubsub?.maxIngressSize ?? defaultMaxQueue,
		'maxIngressSize'
	)
	const defaultMaxReplay = positiveInteger(
		options.pubsub?.maxReplaySize ?? defaultMaxQueue,
		'maxReplaySize'
	)
	const initializationTimeout = positiveInteger(
		options.pubsub?.initializationTimeoutMs ?? 10000,
		'initializationTimeoutMs'
	)
	const metric = (event: PubSubMetric) =>
		safely(() => options.pubsub?.onMetric?.(event))
	const namespace = options.pubsub?.namespace
	const qualify = (name: string) => (namespace ? `${namespace}:${name}` : name)
	const assertOpen = () => {
		if (terminated)
			throw new ORPCError('SERVICE_UNAVAILABLE', {
				message: 'Live runtime has shut down'
			})
	}
	const releaseTransport = (release: (() => Promise<void>) | null) => {
		if (!release) return
		const task = Promise.resolve(release()).catch((error) => {
			logger.warn('Failed to release subscription', {
				error: errorMessageOf(error)
			})
		})
		releases.add(task)
		void task.finally(() => releases.delete(task))
	}

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
		const { name, eventSchema, getChannelName } = config
		const mirrorChannel = config.mirrorChannel
			? qualify(config.mirrorChannel)
			: undefined
		if (config.backlogSize !== undefined)
			positiveInteger(config.backlogSize, 'backlogSize')
		if (config.backlogTtl !== undefined)
			positiveInteger(config.backlogTtl, 'backlogTtl')
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
				assertOpen()
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
		name: string
		maxIngress: number
	}) {
		const { eventSchema } = config
		const hubs = new Map<string, Hub>()

		const createHub = (channel: string): Hub => {
			const subscribers = new Set<LocalSubscriber>()
			let closed = false
			let unsubscribe: (() => Promise<void>) | null = null
			let attempt = 0
			let timer: ReturnType<typeof setTimeout> | null = null
			let markReady = () => {}
			let connectedOnce = false
			let connected = false
			let ready: Promise<void>
			const markPending = () => {
				ready = new Promise<void>((resolve) => {
					markReady = resolve
				})
			}
			markPending()

			let parsing = false
			const ingress = createBoundedEventQueue<string>({
				maxSize: config.maxIngress,
				onDepth: (depth) =>
					metric({
						type: 'queue',
						stage: 'ingress',
						depth,
						limit: config.maxIngress,
						name: config.name,
						channel
					}),
				onDrop: () => {
					metric({
						type: 'drop',
						stage: 'ingress',
						count: 1,
						name: config.name,
						channel
					})
					safely(() =>
						options.pubsub?.onDrop?.(1, { name: config.name, channel })
					)
					for (const sub of [...subscribers]) {
						try {
							sub.gap()
						} catch (error) {
							safely(() => sub.fail(error))
						}
					}
				}
			})
			const parsePending = async () => {
				if (parsing) return
				parsing = true
				try {
					while (!closed) {
						const raw = ingress.dequeue()
						if (raw === undefined) break
						try {
							const message = decodeMessage(raw)
							const parsed = await eventSchema.parseAsync(message.value)
							if (closed) break
							for (const sub of [...subscribers])
								if (sub.isActive()) {
									try {
										sub.push(parsed, message.id)
									} catch (error) {
										safely(() => sub.fail(error))
									}
								}
						} catch (error) {
							metric({
								type: 'parseError',
								stage: 'ingress',
								error,
								name: config.name,
								channel
							})
							logger.warn(`Dropped malformed message on ${channel}`, {
								error: errorMessageOf(error)
							})
						}
					}
				} finally {
					parsing = false
				}
			}
			const release = releaseTransport

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
							if (closed) return
							ingress.enqueue(raw)
							void parsePending()
						},
						(error) => {
							if (connected) {
								connected = false
								markPending()
							}
							logger.error(`Subscription to ${channel} lost`, {
								error: error.message
							})
							scheduleResubscribe('lost')
						},
						{
							onReconnect: () => {
								if (closed) return
								metric({ type: 'reconnect', name: config.name, channel })
								for (const sub of [...subscribers]) {
									try {
										sub.gap()
									} catch (error) {
										safely(() => sub.fail(error))
									}
								}
							}
						}
					)
					if (closed) return release(next)
					unsubscribe = next
					connected = true
					if (connectedOnce) {
						metric({ type: 'reconnect', name: config.name, channel })
						for (const sub of [...subscribers]) {
							try {
								sub.gap()
							} catch (error) {
								safely(() => sub.fail(error))
							}
						}
					}
					connectedOnce = true
					markReady()
					attempt = 0
					logger.info(`Subscribed to ${channel}`)
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
				get ready() {
					return ready
				},
				close: () => {
					closed = true
					metric({
						type: 'queue',
						stage: 'ingress',
						depth: 0,
						limit: config.maxIngress,
						name: config.name,
						channel
					})
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
			qualify(resolveChannel(channel, params, context))
		const getPublishChannel = (params: Input) =>
			qualify(resolveChannel(channel, params, undefined, true))
		const maxQueue = positiveInteger(
			channelOptions.maxQueueSize ?? defaultMaxQueue,
			'maxQueueSize'
		)
		const maxIngress = positiveInteger(
			channelOptions.maxIngressSize ?? defaultMaxIngress,
			'maxIngressSize'
		)
		const maxReplay = positiveInteger(
			channelOptions.maxReplaySize ?? defaultMaxReplay,
			'maxReplaySize'
		)
		const addLocalSubscriber = createChannelHubs({
			eventSchema,
			name,
			maxIngress
		})

		const openInternal: Channel['open'] = async ({
			input,
			context,
			signal,
			recoverGaps = false
		}) => {
			assertOpen()
			signal?.throwIfAborted()
			const initializing = new AbortController()
			const transport = requireTransport()
			const channelName = getChannelName(input, context)
			const startTime = performance.now()
			const span = tracing.startSpan(`${name}:subscribe`, 'SERVER', {
				'pubsub.channel': channelName,
				'pubsub.operation': 'subscribe',
				'pubsub.name': name
			})
			const subscriberLogger = createLogger('pubsub', span)
			const cancelInitialization = () =>
				initializing.abort(
					signal?.reason ?? new Error('Subscription initialization stopped')
				)
			pendingInitialization.add(cancelInitialization)
			signal?.addEventListener('abort', cancelInitialization, { once: true })
			const finishInitialization = () => {
				pendingInitialization.delete(cancelInitialization)
				signal?.removeEventListener('abort', cancelInitialization)
			}

			try {
				if (
					authFn !== undefined &&
					authFn !== true &&
					!(await waitFor(
						Promise.resolve(authFn({ input, ctx: context })),
						initializationTimeout,
						initializing.signal
					))
				) {
					throw new ORPCError('FORBIDDEN', {
						message: 'You do not have access to this subscription'
					})
				}
			} catch (error) {
				finishInitialization()
				tracing.end(span, error)
				throw error
			}

			subscriberLogger.info(`Subscribing to ${channelName}`)

			let messageCount = 0
			let droppedCount = 0
			const delivery = createSubscriberDelivery<unknown>({
				maxSize: maxQueue,
				onDepth: (depth) =>
					metric({
						type: 'queue',
						stage: 'delivery',
						depth,
						limit: maxQueue,
						name,
						channel: channelName
					}),
				accept:
					filterFn &&
					((data) => (data === LIVE_GAP ? true : filterFn({ input, data }))),
				overflowMarker: recoverGaps
					? () => LIVE_GAP
					: overflowMarker && (() => overflowMarker(input)),
				onFilterError: (error) =>
					subscriberLogger.error('Error processing message', {
						error: errorMessageOf(error)
					}),
				onDrop: () => {
					droppedCount++
					metric({
						type: 'drop',
						stage: 'delivery',
						count: 1,
						name,
						channel: channelName
					})
					safely(() =>
						options.pubsub?.onDrop?.(1, { name, channel: channelName })
					)
					if (!recoverGaps && !overflowMarker)
						queueMicrotask(() =>
							close(
								new ORPCError('SERVICE_UNAVAILABLE', {
									message: 'Subscription queue overflow; reconnect and resync'
								})
							)
						)
				}
			})

			let replaying: Array<{ data: unknown; id: string | undefined }> | null =
				useBacklog ? [] : null
			let replayGap = false
			const seen = new Set<string>()
			const dedupe = (id: string | undefined) => {
				if (!id) return false
				if (seen.has(id)) return true
				seen.add(id)
				if (
					seen.size >
					Math.max(maxReplay, maxQueue, channelOptions.backlogSize ?? 50) * 2
				)
					seen.delete(seen.values().next().value as string)
				return false
			}
			const push = (data: unknown, id?: string) => {
				messageCount++
				if (replaying) {
					if (replaying.length >= maxReplay) {
						replaying.shift()
						replayGap = true
						metric({
							type: 'drop',
							stage: 'replay',
							count: 1,
							name,
							channel: channelName
						})
						safely(() =>
							options.pubsub?.onDrop?.(1, { name, channel: channelName })
						)
					}
					replaying.push({ data, id })
					metric({
						type: 'queue',
						stage: 'replay',
						depth: replaying.length,
						limit: maxReplay,
						name,
						channel: channelName
					})
				} else if (!dedupe(id)) delivery.push(data)
			}
			const gap = () => {
				if (replaying) {
					replayGap = true
					return
				}
				if (recoverGaps) delivery.push(LIVE_GAP)
				else if (overflowMarker) {
					const marker = overflowMarker(input)
					if (marker !== null) delivery.push(marker, true)
				} else
					close(
						new ORPCError('SERVICE_UNAVAILABLE', {
							message: 'Subscription lost events; reconnect and resync'
						})
					)
			}

			// The one way a subscription ends, whatever ends it: abort, drain, the
			// stream finishing, or `close()`. Releases everything at once, even
			// while the stream is parked or not yet read.
			let closed = false
			const close = (...error: [] | [unknown]) => {
				if (closed) return
				closed = true
				initializing.abort(error[0] ?? new Error('Subscription closed'))
				delivery.close(error[0])
				activeSubscriberCleanups.delete(stop)
				signal?.removeEventListener('abort', stop)
				local.remove()
				const durationMs = performance.now() - startTime
				span?.setAttribute('pubsub.duration_ms', durationMs)
				span?.setAttribute('pubsub.message_count', messageCount)
				span?.setAttribute('pubsub.dropped_count', droppedCount)
				tracing.end(span, ...error)
				subscriberLogger.info(`Unsubscribed from ${channelName}`, {
					messageCount,
					droppedCount,
					durationMs: Math.round(durationMs)
				})
			}
			const stop = () => close()
			const local = addLocalSubscriber(channelName, {
				isActive: () => !closed,
				push,
				gap,
				fail: (error) => close(error)
			})
			activeSubscriberCleanups.add(stop)
			signal?.addEventListener('abort', stop)
			if (signal?.aborted) close()

			try {
				await waitFor(local.ready, initializationTimeout, initializing.signal)
				if (replaying && !closed) {
					try {
						const items = await waitFor(
							transport.readBacklog(channelName),
							initializationTimeout,
							initializing.signal
						)
						span?.setAttribute('pubsub.backlog_count', items.length)
						for (const raw of items.slice(-maxReplay)) {
							if (closed) break
							try {
								const message = decodeMessage(raw)
								if (!dedupe(message.id)) {
									messageCount++
									delivery.push(
										await waitFor(
											eventSchema.parseAsync(message.value),
											initializationTimeout,
											initializing.signal
										)
									)
								}
							} catch (error) {
								metric({
									type: 'parseError',
									stage: 'replay',
									error,
									name,
									channel: channelName
								})
								/* Malformed backlog entries are skipped. */
							}
						}
						if (items.length > maxReplay) replayGap = true
					} catch (error) {
						replayGap = true
						subscriberLogger.warn(
							`Failed to replay backlog for ${channelName}`,
							{ error: errorMessageOf(error) }
						)
					}
				}
				for (const { data, id } of replaying ?? [])
					if (!dedupe(id)) delivery.push(data)
				replaying = null
				metric({
					type: 'queue',
					stage: 'replay',
					depth: 0,
					limit: maxReplay,
					name,
					channel: channelName
				})
				if (replayGap && !closed) gap()
			} catch (error) {
				if (!closed) {
					close(error)
					throw new ORPCError('SERVICE_UNAVAILABLE', {
						message: 'Unable to establish subscription',
						cause: error
					})
				}
			} finally {
				finishInitialization()
			}

			async function* events() {
				try {
					yield* delivery.events
				} finally {
					close()
				}
			}

			return { events: events(), close: () => close(), isClosed: () => closed }
		}

		const { publish, publishMany } = createChannelPublisher({
			...channelOptions,
			getChannelName: getPublishChannel
		})

		const open: Channel['open'] = (params) => {
			const task = openInternal(params)
			pendingOpens.add(task)
			void task.then(
				() => pendingOpens.delete(task),
				() => pendingOpens.delete(task)
			)
			return task
		}
		return {
			open,
			publish,
			publishMany,
			getChannelName,
			getSubscriptionChannelName: ({ input, context }) =>
				getChannelName(input, context),
			getPublishChannelName: getPublishChannel
		}
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

		const {
			channel: _channel,
			eventSchema: _eventSchema,
			inputSchema,
			filterFn: _filterFn,
			authFn: _authFn,
			overflowMarker: _overflowMarker,
			useBacklog: _useBacklog,
			backlogSize: _backlogSize,
			backlogTtl: _backlogTtl,
			mirrorChannel: _mirrorChannel,
			maxQueueSize: _maxQueueSize,
			maxIngressSize: _maxIngressSize,
			maxReplaySize: _maxReplaySize,
			...routeOptions
		} = pubsubOptions
		const subscribe = options.fn({
			...routeOptions,
			name,
			stream: true,
			method: 'GET',
			input: inputSchema,
			summary: pubsubOptions.summary ?? `Subscribe to ${name}`,
			handler: async function* ({
				input,
				context,
				signal
			}: {
				input: Input
				context: unknown
				signal: AbortSignal | undefined
			}) {
				yield* (await channel.open({ input, context, signal })).events
			}
		})

		const { publish, publishMany, getChannelName } = channel
		return {
			subscribe,
			publish,
			publishMany,
			getChannelName,
			getSubscriptionChannelName: channel.getSubscriptionChannelName,
			getPublishChannelName: channel.getPublishChannelName
		}
	}

	function createPublisher(publisherOptions: PublisherOptions<ZodType>) {
		const getChannelName = (params: Input) =>
			qualify(resolveChannel(publisherOptions.channel, params, undefined, true))
		const { publish, publishMany } = createChannelPublisher({
			...publisherOptions,
			getChannelName
		})
		return { publish, publishMany, getChannelName }
	}

	return {
		createChannel,
		shutdown: () => {
			if (shutdownPromise) return shutdownPromise
			terminated = true
			for (const cancel of [...pendingInitialization]) safely(cancel)
			for (const cleanup of [...activeSubscriberCleanups]) safely(cleanup)
			shutdownPromise = (async () => {
				await Promise.allSettled([...pendingOpens])
				await Promise.all([...releases])
				if (options.pubsub?.ownsTransport)
					await options.pubsub.transport.close?.()
			})()
			return shutdownPromise
		},
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
