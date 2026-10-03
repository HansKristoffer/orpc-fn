import type { AnySchema, ErrorMap, Schema } from '@orpc/contract'
import { type AnyProcedure, ORPCError } from '@orpc/server'
import type { ZodType, z } from 'zod'
import { RAW_INPUT } from '../timing.js'
import { LIVE_GAP, positiveInteger } from './lifecycle.js'
import type { FnLogger } from '../logger.js'
import { errorMessageOf, type SpanLike } from '../otel.js'
import type {
	FnContext,
	FnDefinition,
	FnProcedure,
	FnRouteOptions,
	HandlerParams,
	MaybePromise,
	ProcedureKey
} from '../types.js'
import type {
	AuthFn,
	Channel,
	ChannelDefinition,
	ChannelOptions,
	ChannelQueueOptions,
	ObjectSchema,
	PublisherConfig
} from './pub-sub.js'

/** Marks a coalesce window that ended before the next event arrived. */
const TIMEOUT = Symbol('timeout')

const fnLivePatchMarker = Symbol('fnLive.patch')

/**
 * Transformer result that splits the internal accumulator from the wire
 * payload: `state` becomes the `previous` snapshot for later events while only
 * `emit` is sent to the subscriber. Lets high-frequency streams avoid
 * re-serializing the full snapshot per event.
 */
export type FnLivePatch<TOutput, TEmit> = {
	[fnLivePatchMarker]: true
	state: TOutput
	emit: TEmit
}

export function fnLivePatch<TOutput, TEmit>(
	state: TOutput,
	emit: TEmit
): FnLivePatch<TOutput, TEmit> {
	return { [fnLivePatchMarker]: true, state, emit }
}

function isFnLivePatch(value: unknown): value is FnLivePatch<unknown, unknown> {
	return (
		typeof value === 'object' && value !== null && fnLivePatchMarker in value
	)
}

export type FnLiveConfig<
	TDef extends FnDefinition,
	TInput,
	TEventSchema extends ZodType,
	TOutput,
	TKey extends ProcedureKey<TDef>,
	TEmit = never,
	TErrors extends ErrorMap = Record<never, never>
> = Omit<PublisherConfig, 'name'> &
	ChannelQueueOptions & {
		/** Subscribe route name; default `${name}.live`. */
		name?: string
		/** Validates parsed reducer state without reapplying an output transform. Required with a transformer. */
		stateSchema?: Schema<TOutput, TOutput>
		/** Validates patch payloads. Required when a transformer returns fnLivePatch. */
		emitSchema?: Schema<TEmit, TEmit>
		/** Optional access check before each update; idle streams keep their initial authorization. */
		reauthorize?: AuthFn<TInput, FnContext<TDef, TKey>>
		eventSchema: TEventSchema
		channel: ChannelDefinition<
			TInput,
			z.output<TEventSchema>,
			FnContext<TDef, TKey>
		>
		/** Fold an event into the snapshot; without it every event re-runs the handler. */
		transformerFn?: FnLiveConfigTransformer<
			TDef,
			TInput,
			TEventSchema,
			TOutput,
			TKey,
			TEmit,
			TErrors
		>
		/** Return false to skip an event. */
		shouldUpdate?: (
			params: HandlerParams<TDef, TInput, TKey, TErrors> & {
				event: z.output<TEventSchema>
				previous: TOutput
			}
		) => MaybePromise<boolean>
		authFn?: AuthFn<TInput, FnContext<TDef, TKey>>
		/** Log publish failures instead of throwing them into the publishing route. */
		safePublish?: boolean
		/** Batch events arriving within this window into one snapshot update. */
		coalesceMs?: number
		/** Maximum events collected in one coalescing batch (default 1000). */
		maxBatchSize?: number
		/**
		 * When a slow subscriber's queue overflows (drop-oldest), this marker is
		 * enqueued INSTEAD of the dropped event so the client resyncs. Return
		 * `null` to skip.
		 */
		overflowMarker?: (input: TInput) => z.output<TEventSchema> | null
		summary?: string
		description?: string
	} & (
		| { transformerFn?: undefined }
		| {
				transformerFn: FnLiveConfigTransformer<
					TDef,
					TInput,
					TEventSchema,
					TOutput,
					TKey,
					TEmit,
					TErrors
				>
				stateSchema: Schema<TOutput, TOutput>
		  }
	) &
	([TEmit] extends [never] ? object : { emitSchema: Schema<TEmit, TEmit> })

type FnLiveConfigTransformer<
	TDef extends FnDefinition,
	TInput,
	TEventSchema extends ZodType,
	TOutput,
	TKey extends ProcedureKey<TDef>,
	TEmit,
	TErrors extends ErrorMap
> = (
	params: HandlerParams<TDef, TInput, TKey, TErrors> & {
		event: z.output<TEventSchema>
		previous: TOutput
		rerun: () => Promise<TOutput>
	}
) => MaybePromise<TOutput | FnLivePatch<TOutput, TEmit> | undefined>

export type FnLiveReturn<
	TDef extends FnDefinition,
	TKey extends ProcedureKey<TDef>,
	TInput extends ObjectSchema,
	TOutputSchema extends Schema<unknown, unknown>,
	TOutput,
	TEventSchema extends ZodType,
	TEmit = never,
	TErrors extends ErrorMap = Record<never, never>
> = {
	procedure: FnProcedure<TDef, TKey, TInput, TOutputSchema, TErrors>
	subscribe: FnProcedure<
		TDef,
		TKey,
		TInput,
		Schema<AsyncGenerator<TOutput | TEmit>, AsyncGenerator<TOutput | TEmit>>,
		TErrors
	>
	publish: (event: z.input<TEventSchema>) => Promise<void>
	getSubscriptionChannelName: (params: {
		input: z.output<TInput>
		context: FnContext<TDef, TKey>
	}) => string
	getPublishChannelName: (event: z.output<TEventSchema>) => string
	/** @deprecated Prefer the separate required-input resolver methods. */
	getChannelName: (
		params: Partial<z.output<TInput>> | Partial<z.output<TEventSchema>>,
		context?: FnContext<TDef, TKey>
	) => string
}

/**
 * A route plus a subscribe route that streams its result: the initial
 * snapshot, then an update for every event published on the channel.
 */
export interface FnLive<TDef extends FnDefinition> {
	<
		TInput extends ObjectSchema,
		TOutputSchema extends ZodType,
		TEventSchema extends ZodType,
		TKey extends ProcedureKey<TDef> = TDef['default'],
		TEmit = never,
		TErrors extends ErrorMap = Record<never, never>
	>(
		options: {
			input: TInput
			output: TOutputSchema
			handler: (
				params: HandlerParams<
					TDef,
					z.output<TInput>,
					NoInfer<TKey>,
					TErrors
				> & {
					publish: (event: z.input<TEventSchema>) => Promise<void>
				}
				// The output schema parses what the handler returns: its input type.
			) => MaybePromise<z.input<TOutputSchema>>
			live: FnLiveConfig<
				TDef,
				z.output<TInput>,
				TEventSchema,
				z.output<TOutputSchema>,
				NoInfer<TKey>,
				TEmit,
				TErrors
			>
		} & FnRouteOptions<TDef, TKey, z.output<TInput>, TErrors>
	): FnLiveReturn<
		TDef,
		TKey,
		TInput,
		TOutputSchema,
		z.output<TOutputSchema>,
		TEventSchema,
		TEmit,
		TErrors
	>

	<
		TInput extends ObjectSchema,
		TOutput,
		TEventSchema extends ZodType,
		TKey extends ProcedureKey<TDef> = TDef['default'],
		TEmit = never,
		TErrors extends ErrorMap = Record<never, never>
	>(
		options: {
			input: TInput
			output?: undefined
			handler: (
				params: HandlerParams<
					TDef,
					z.output<TInput>,
					NoInfer<TKey>,
					TErrors
				> & {
					publish: (event: z.input<TEventSchema>) => Promise<void>
				}
			) => MaybePromise<TOutput>
			live: FnLiveConfig<
				TDef,
				z.output<TInput>,
				TEventSchema,
				TOutput,
				NoInfer<TKey>,
				TEmit,
				TErrors
			>
		} & FnRouteOptions<TDef, TKey, z.output<TInput>, TErrors>
	): FnLiveReturn<
		TDef,
		TKey,
		TInput,
		Schema<TOutput, TOutput>,
		TOutput,
		TEventSchema,
		TEmit,
		TErrors
	>
}

/**
 * Fail a live subscription whose initial snapshot could not be built.
 *
 * An expected client failure - an `ORPCError` with a 4xx status, e.g. the
 * subscribed resource was not found or access was refused - reaches the
 * subscriber unchanged and is NOT logged as a server fault. Only 5xx and
 * unknown failures are logged. Unknown errors are wrapped as
 * `INTERNAL_SERVER_ERROR`.
 */
export function throwInitialSnapshotError(
	err: unknown,
	liveName: string,
	logger: Pick<FnLogger, 'error'>,
	/** `createFn`'s `isExpectedError`; default: a 4xx `ORPCError`. */
	isExpected: (error: unknown) => boolean = (error) =>
		error instanceof ORPCError && error.status < 500
): never {
	if (!isExpected(err)) {
		logger.error('fnLive initial snapshot failed', {
			name: liveName,
			err: errorMessageOf(err)
		})
	}
	throw toSnapshotError(err, liveName)
}

/** An `ORPCError` passes through; anything else becomes INTERNAL_SERVER_ERROR. */
function toSnapshotError(
	err: unknown,
	liveName: string
): ORPCError<string, unknown> {
	if (err instanceof ORPCError) return err
	return new ORPCError('INTERNAL_SERVER_ERROR', {
		message: `Failed to load initial snapshot for ${liveName}`,
		cause: err
	})
}

/**
 * Drives a live subscription: yields the initial snapshot, then folds each
 * inbound event into the running snapshot via `apply`, yielding after every
 * change. With `coalesceMs`, events arriving within that window are batched so
 * bursty streams apply together.
 *
 * `apply` may return an {@link FnLivePatch} to keep the full snapshot as the
 * internal accumulator while yielding only the lighter `emit` payload.
 *
 * Invariant: there is never more than one outstanding `source.next()` read. On
 * a coalesce-window timeout the still-pending read is stashed in `pending` and
 * reused by the next `readNext()` - issuing a second concurrent read would
 * strand the in-flight event behind the next one (delivering it "one behind").
 */
export async function* streamLiveSnapshots<
	TEvent,
	TOutput,
	TEmit = never
>(opts: {
	source: AsyncIterator<TEvent>
	/** Maximum events retained in one coalescing batch. */
	maxBatchSize?: number
	applyBatch?: (
		events: readonly TEvent[],
		previous: TOutput
	) => MaybePromise<TOutput | undefined>
	initial: TOutput
	coalesceMs?: number | undefined
	apply: (
		event: TEvent,
		previous: TOutput
	) => MaybePromise<TOutput | FnLivePatch<TOutput, TEmit> | undefined>
}): AsyncGenerator<TOutput | TEmit> {
	const { source, initial, coalesceMs, apply } = opts
	const maxBatchSize = positiveInteger(
		opts.maxBatchSize ?? 1000,
		'maxBatchSize'
	)
	if (
		coalesceMs !== undefined &&
		(!Number.isFinite(coalesceMs) || coalesceMs < 0)
	)
		throw new RangeError('orpc-fn: coalesceMs must be finite and nonnegative')

	let pending: Promise<IteratorResult<TEvent>> | null = null
	const readNext = () => {
		const read = pending ?? source.next()
		pending = null
		return read
	}

	let previous = initial
	yield previous

	while (true) {
		const current = await readNext()
		if (current.done) break

		const batch: TEvent[] = [current.value]

		if (coalesceMs) {
			const endAt = Date.now() + coalesceMs
			while (Date.now() < endAt && batch.length < maxBatchSize) {
				const remainingMs = endAt - Date.now()
				const read = readNext()
				let timer: ReturnType<typeof setTimeout> | undefined
				const result = await Promise.race([
					read,
					new Promise<typeof TIMEOUT>((resolve) => {
						timer = setTimeout(resolve, remainingMs, TIMEOUT)
					})
				])
				clearTimeout(timer)

				if (result === TIMEOUT) {
					// Reuse the SAME in-flight read next iteration instead of starting
					// a new one - this is what prevents the "one behind" stranding.
					pending = read
					break
				}

				if (result.done) {
					pending = Promise.resolve(result)
					break
				}
				batch.push(result.value)
			}
		}

		if (opts.applyBatch) {
			const next = await opts.applyBatch(batch, previous)
			if (next !== undefined) {
				previous = next
				yield previous
			}
			continue
		}
		let changed = false
		for (const event of batch) {
			const next = await apply(event, previous)
			if (next === undefined) continue
			if (isFnLivePatch(next)) {
				if (changed) {
					yield previous
					changed = false
				}
				previous = next.state as TOutput
				yield next.emit as TEmit
				continue
			}
			previous = next
			changed = true
		}
		if (changed) yield previous
	}
}

type RuntimeParams = Record<string, unknown> & {
	input: Record<string, unknown>
	context: unknown
	signal: AbortSignal | undefined
	logger: FnLogger
	call: (procedure: AnyProcedure, input: unknown) => Promise<unknown>
	[RAW_INPUT]: unknown
}

/** `FnLiveConfig` with the generics erased: what the implementation reads. */
type RuntimeLiveConfig = Omit<ChannelOptions, 'name'> & {
	name?: string
	stateSchema?: AnySchema
	emitSchema?: AnySchema
	reauthorize?: AuthFn<Record<string, unknown>, unknown>
	transformerFn?: (params: RuntimeParams & Record<string, unknown>) => unknown
	shouldUpdate?: (params: RuntimeParams & Record<string, unknown>) => unknown
	safePublish?: boolean
	coalesceMs?: number
	maxBatchSize?: number
	summary?: string
	description?: string
}

/**
 * @internal Wires `fnLive` onto an `fn` and channel runtime of the same
 * instance. `createFn` returns it typed as {@link FnLive}.
 */
export function createFnLive(runtime: {
	// biome-ignore lint/suspicious/noExplicitAny: runtime half of the typed `Fn`
	fn: (options: any) => AnyProcedure
	createChannel: (options: ChannelOptions) => Channel
	createLogger: (scope: string, span: SpanLike | undefined) => FnLogger
	isGuard: (option: string) => boolean
}) {
	const { fn, createChannel, isGuard } = runtime
	const liveLogger = runtime.createLogger('fn-live', undefined)

	return (
		options: {
			live: RuntimeLiveConfig
			handler: (params: RuntimeParams) => unknown
			input: ZodType
			output?: ZodType
			name: string
			procedure?: string
			summary?: string
			description?: string
			tags?: string[]
		} & Record<string, unknown>
	) => {
		const { live, handler, input, output, name, ...routeConfig } = options
		if (live.transformerFn && !live.stateSchema)
			throw new TypeError(
				'orpc-fn: live transformers require a stateSchema for parsed state'
			)
		if (
			live.coalesceMs !== undefined &&
			(!Number.isFinite(live.coalesceMs) || live.coalesceMs < 0)
		)
			throw new RangeError('orpc-fn: coalesceMs must be finite and nonnegative')
		if (live.maxBatchSize !== undefined)
			positiveInteger(live.maxBatchSize, 'maxBatchSize')
		const liveName = live.name ?? `${name}.live`
		const liveSummary =
			live.summary ?? `Live updates of ${routeConfig.summary ?? name}`
		const liveDescription = live.description ?? routeConfig.description

		// `createChannel` reads only the channel keys of the live config.
		const channel = createChannel({ ...live, name: liveName })

		const publish = async (event: unknown) => {
			if (!live.safePublish) return channel.publish(event)
			try {
				await channel.publish(event)
			} catch (err) {
				// Live update failures must not roll back the route that emitted them,
				// but they should still be visible in logs.
				liveLogger.error('fnLive publish failed', {
					name: liveName,
					err: errorMessageOf(err)
				})
			}
		}

		const runHandler = (params: RuntimeParams) =>
			handler({ ...params, publish })

		const procedure = fn({
			...routeConfig,
			name,
			input,
			output,
			handler: runHandler
		})

		const validate = async (schema: AnySchema, value: unknown) => {
			const result = await schema['~standard'].validate(value)
			if (result.issues)
				throw new ORPCError('INTERNAL_SERVER_ERROR', {
					message: 'Invalid live state or patch',
					cause: result.issues
				})
			return result.value
		}
		const runSnapshot = (params: RuntimeParams) =>
			params.call(procedure, params[RAW_INPUT])
		// Generated streams inherit access policies and metadata; tool adapters reject streams.

		const guardOptions = Object.fromEntries(
			Object.entries(routeConfig).filter(([option]) => isGuard(option))
		)
		const subscribe = fn({
			...guardOptions,
			guardResolvers: routeConfig.guardResolvers,
			errors: routeConfig.errors,
			meta: routeConfig.meta,
			stream: true,
			procedure: routeConfig.procedure,
			tags: routeConfig.tags,
			name: liveName,
			method: 'GET',
			input,
			summary: liveSummary,
			description: liveDescription,
			handler: async function* (params: RuntimeParams) {
				// Authorize and subscribe before the snapshot: a refused subscriber
				// gets nothing, and events published while it loads are queued.
				const subscription = await channel.open({
					input: params.input,
					context: params.context,
					signal: params.signal,
					recoverGaps: true
				})
				try {
					if (subscription.isClosed()) return
					let initial: unknown
					try {
						initial = await runSnapshot(params)
					} catch (err) {
						// `fn.completed` logs it, at the level `isExpectedError` picks.
						throw toSnapshotError(err, liveName)
					}

					const rerun = () => runSnapshot(params)
					const authorize = async () => {
						if (
							live.reauthorize &&
							live.reauthorize !== true &&
							!(await live.reauthorize({
								input: params.input,
								ctx: params.context
							}))
						)
							throw new ORPCError('FORBIDDEN')
					}
					const apply = async (event: unknown, previous: unknown) => {
						await authorize()
						if (event === LIVE_GAP) return rerun()
						if (
							live.shouldUpdate &&
							!(await live.shouldUpdate({ ...params, event, previous }))
						)
							return undefined
						if (!live.transformerFn) return rerun()
						const next = await live.transformerFn({
							...params,
							event,
							previous,
							rerun
						})
						if (next === undefined) return undefined
						if (isFnLivePatch(next)) {
							if (!live.emitSchema)
								throw new TypeError('orpc-fn: live patches require emitSchema')
							return fnLivePatch(
								await validate(live.stateSchema as AnySchema, next.state),
								await validate(live.emitSchema, next.emit)
							)
						}
						return validate(live.stateSchema as AnySchema, next)
					}
					const applyBatch = live.transformerFn
						? undefined
						: async (events: readonly unknown[], previous: unknown) => {
								await authorize()
								let invalidated = false
								for (const event of events)
									if (
										event === LIVE_GAP ||
										!live.shouldUpdate ||
										(await live.shouldUpdate({ ...params, event, previous }))
									)
										invalidated = true
								return invalidated ? rerun() : undefined
							}

					yield* streamLiveSnapshots({
						source: subscription.events,
						initial,
						coalesceMs: live.coalesceMs,
						...(live.maxBatchSize !== undefined
							? { maxBatchSize: live.maxBatchSize }
							: {}),
						apply,
						...(applyBatch ? { applyBatch } : {})
					})
				} finally {
					subscription.close()
				}
			}
		})

		return {
			procedure,
			subscribe,
			publish,
			getChannelName: channel.getChannelName,
			getSubscriptionChannelName: channel.getSubscriptionChannelName,
			getPublishChannelName: channel.getPublishChannelName
		}
	}
}
