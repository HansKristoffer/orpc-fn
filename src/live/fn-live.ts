import type { Schema } from '@orpc/contract'
import { type AnyProcedure, ORPCError } from '@orpc/server'
import type { ZodObject, ZodRawShape, ZodType, z } from 'zod'
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
import type { AuthFn, ChannelDefinition } from './pub-sub.js'

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

type LiveParams<
	TDef extends FnDefinition,
	TInput,
	TKey extends ProcedureKey<TDef>
> = HandlerParams<TDef, TInput, TKey>

export type FnLiveConfig<
	TDef extends FnDefinition,
	TInput,
	TEventSchema extends ZodType,
	TOutput,
	TKey extends ProcedureKey<TDef>,
	TEmit = never
> = {
	/** Subscribe route name; default `${name}.live`. */
	name?: string
	eventSchema: TEventSchema
	channel: ChannelDefinition<
		TInput,
		z.infer<TEventSchema>,
		FnContext<TDef, TKey>
	>
	/** Fold an event into the snapshot; without it every event re-runs the handler. */
	transformerFn?: (
		params: LiveParams<TDef, TInput, TKey> & {
			event: z.infer<TEventSchema>
			previous: TOutput | undefined
			rerun: (input?: TInput) => Promise<TOutput>
		}
	) => MaybePromise<TOutput | FnLivePatch<TOutput, TEmit> | undefined>
	/** Return false to skip an event. */
	shouldUpdate?: (
		params: LiveParams<TDef, TInput, TKey> & {
			event: z.infer<TEventSchema>
			previous: TOutput | undefined
		}
	) => MaybePromise<boolean>
	authFn?: AuthFn<TInput, FnContext<TDef, TKey>>
	/** Log publish failures instead of throwing them into the publishing route. */
	safePublish?: boolean
	/** Batch events arriving within this window into one snapshot update. */
	coalesceMs?: number
	useBacklog?: boolean
	backlogSize?: number
	backlogTtl?: number
	mirrorChannel?: string
	/**
	 * When a slow subscriber's queue overflows (drop-oldest), this marker is
	 * enqueued INSTEAD of the dropped event so the client resyncs. Return
	 * `null` to skip.
	 */
	overflowMarker?: (input: TInput) => z.infer<TEventSchema> | null
	summary?: string
	description?: string
}

export type FnLiveReturn<
	TDef extends FnDefinition,
	TKey extends ProcedureKey<TDef>,
	TInput extends ZodObject<ZodRawShape>,
	TOutputSchema extends Schema<unknown, unknown>,
	TOutput,
	TEventSchema extends ZodType,
	TEmit = never
> = {
	procedure: FnProcedure<TDef, TKey, TInput, TOutputSchema>
	subscribe: FnProcedure<
		TDef,
		TKey,
		TInput,
		Schema<AsyncGenerator<TOutput | TEmit>, AsyncGenerator<TOutput | TEmit>>
	>
	publish: (event: z.infer<TEventSchema>) => Promise<void>
	getChannelName: (
		params: Partial<z.infer<TInput>> | Partial<z.infer<TEventSchema>>,
		context?: FnContext<TDef, TKey>
	) => string
}

/**
 * A route plus a subscribe route that streams its result: the initial
 * snapshot, then an update for every event published on the channel.
 */
export interface FnLive<TDef extends FnDefinition> {
	<
		TInput extends ZodObject<ZodRawShape>,
		TOutputSchema extends ZodType,
		TEventSchema extends ZodType,
		TKey extends ProcedureKey<TDef> = TDef['default'],
		TEmit = never
	>(
		options: {
			input: TInput
			output: TOutputSchema
			handler: (
				params: LiveParams<TDef, z.infer<TInput>, NoInfer<TKey>> & {
					publish: (event: z.infer<TEventSchema>) => Promise<void>
				}
			) => MaybePromise<z.infer<TOutputSchema>>
			live: FnLiveConfig<
				TDef,
				z.infer<TInput>,
				TEventSchema,
				z.infer<TOutputSchema>,
				NoInfer<TKey>,
				TEmit
			>
		} & FnRouteOptions<TDef, TKey>
	): FnLiveReturn<
		TDef,
		TKey,
		TInput,
		TOutputSchema,
		z.infer<TOutputSchema>,
		TEventSchema,
		TEmit
	>

	<
		TInput extends ZodObject<ZodRawShape>,
		TOutput,
		TEventSchema extends ZodType,
		TKey extends ProcedureKey<TDef> = TDef['default'],
		TEmit = never
	>(
		options: {
			input: TInput
			output?: undefined
			handler: (
				params: LiveParams<TDef, z.infer<TInput>, NoInfer<TKey>> & {
					publish: (event: z.infer<TEventSchema>) => Promise<void>
				}
			) => MaybePromise<TOutput>
			live: FnLiveConfig<
				TDef,
				z.infer<TInput>,
				TEventSchema,
				TOutput,
				NoInfer<TKey>,
				TEmit
			>
		} & FnRouteOptions<TDef, TKey>
	): FnLiveReturn<
		TDef,
		TKey,
		TInput,
		Schema<TOutput, TOutput>,
		TOutput,
		TEventSchema,
		TEmit
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
	logger: Pick<FnLogger, 'error'>
): never {
	const isExpectedClientError = err instanceof ORPCError && err.status < 500
	if (!isExpectedClientError) {
		logger.error('fnLive initial snapshot failed', {
			name: liveName,
			err: errorMessageOf(err)
		})
	}

	if (err instanceof ORPCError) throw err
	throw new ORPCError('INTERNAL_SERVER_ERROR', {
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
	initial: TOutput
	coalesceMs?: number | undefined
	apply: (
		event: TEvent,
		previous: TOutput
	) => MaybePromise<TOutput | FnLivePatch<TOutput, TEmit> | undefined>
}): AsyncGenerator<TOutput | TEmit> {
	const { source, initial, coalesceMs, apply } = opts

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
			while (Date.now() < endAt) {
				const remainingMs = endAt - Date.now()
				const read = readNext()
				let timer: ReturnType<typeof setTimeout> | undefined
				let timedOut = false
				const result = await Promise.race([
					read,
					new Promise<IteratorResult<TEvent>>((resolve) => {
						timer = setTimeout(() => {
							timedOut = true
							resolve({ done: true, value: undefined })
						}, remainingMs)
					})
				])

				if (timedOut) {
					// Reuse the SAME in-flight read next iteration instead of starting
					// a new one - this is what prevents the "one behind" stranding.
					pending = read
					break
				}

				if (timer !== undefined) clearTimeout(timer)
				if (result.done) {
					pending = Promise.resolve(result)
					break
				}
				batch.push(result.value)
			}
		}

		for (const event of batch) {
			const next = await apply(event, previous)
			if (next === undefined) continue
			if (isFnLivePatch(next)) {
				previous = next.state as TOutput
				yield next.emit as TEmit
				continue
			}
			previous = next
			yield previous
		}
	}
}

type RuntimeParams = Record<string, unknown> & {
	input: Record<string, unknown>
	call: (procedure: AnyProcedure, input: unknown) => Promise<unknown>
	logger: FnLogger
}

type RuntimeLiveConfig = FnLiveConfig<
	FnDefinition,
	Record<string, unknown>,
	ZodType,
	unknown,
	string,
	unknown
>

/** Wires `fnLive` onto an `fn` and `createPubSub` of the same instance. */
export function createFnLive(
	// biome-ignore lint/suspicious/noExplicitAny: runtime half of the typed `Fn`
	fn: (options: any) => AnyProcedure,
	// biome-ignore lint/suspicious/noExplicitAny: runtime half of the typed `CreatePubSub`
	createPubSub: (options: any) => {
		subscribe: AnyProcedure
		publish: (event: unknown) => Promise<void>
		getChannelName: (
			params: Record<string, unknown>,
			context?: unknown
		) => string
	},
	createLogger: (scope: string, span: SpanLike | undefined) => FnLogger,
	isGuard: (option: string) => boolean
) {
	const liveLogger = createLogger('fn-live', undefined)

	// biome-ignore lint/suspicious/noExplicitAny: the overloads in `FnLive` carry the types
	return (options: any) => {
		const { live, handler, input, output, name, ...routeConfig } = options as {
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
		const liveName = live.name ?? `${name}.live`
		const liveSummary =
			live.summary ?? `Live updates of ${routeConfig.summary ?? name}`
		const liveDescription = live.description ?? routeConfig.description

		const pubsub = createPubSub({
			name: liveName,
			channel: live.channel,
			inputSchema: input,
			eventSchema: live.eventSchema,
			authFn: live.authFn,
			procedure: routeConfig.procedure,
			tags: routeConfig.tags,
			summary: liveSummary,
			description: liveDescription,
			useBacklog: live.useBacklog,
			backlogSize: live.backlogSize,
			backlogTtl: live.backlogTtl,
			mirrorChannel: live.mirrorChannel,
			overflowMarker: live.overflowMarker
		})

		const publish = async (event: unknown) => {
			if (!live.safePublish) return pubsub.publish(event)
			try {
				await pubsub.publish(event)
			} catch (err) {
				// Live update failures must not roll back the route that emitted them,
				// but they should still be visible in logs.
				liveLogger.error('fnLive publish failed', {
					name: liveName,
					err: errorMessageOf(err)
				})
			}
		}

		const runRoute = async (params: RuntimeParams) =>
			handler({ ...params, publish })

		const procedure = fn({
			...routeConfig,
			name,
			input,
			output,
			handler: runRoute
		})

		// Guards run on the subscribe route too; route meta stays on `procedure`.
		const guardOptions = Object.fromEntries(
			Object.entries(routeConfig).filter(([option]) => isGuard(option))
		)
		const subscribe = fn({
			...guardOptions,
			procedure: routeConfig.procedure,
			tags: routeConfig.tags,
			name: liveName,
			method: 'GET',
			input,
			output: undefined,
			summary: liveSummary,
			description: liveDescription,
			handler: async function* (params: RuntimeParams) {
				const stream = (await params.call(
					pubsub.subscribe,
					params.input
				)) as AsyncIterable<unknown>
				const iterator = stream[Symbol.asyncIterator]()

				let initial: unknown
				try {
					initial = await runRoute(params)
				} catch (err) {
					await iterator.return?.()
					throwInitialSnapshotError(err, liveName, params.logger)
				}

				const apply = async (event: unknown, previous: unknown) => {
					const shouldUpdate = await (live.shouldUpdate?.({
						...params,
						event,
						previous
					} as never) ?? true)
					if (!shouldUpdate) return undefined
					if (!live.transformerFn) return runRoute(params)
					return live.transformerFn({
						...params,
						event,
						previous,
						rerun: (nextInput?: Record<string, unknown>) =>
							runRoute({ ...params, input: nextInput ?? params.input })
					} as never)
				}

				try {
					yield* streamLiveSnapshots({
						source: iterator,
						initial,
						coalesceMs: live.coalesceMs,
						apply
					})
				} finally {
					await iterator.return?.()
				}
			}
		})

		return {
			procedure,
			subscribe,
			publish,
			getChannelName: pubsub.getChannelName
		}
	}
}
