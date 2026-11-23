import {
	type AnyProcedure,
	call,
	type Procedure,
	type Schema
} from '@orpc/server'
import type { ProcedureContext, ProcedureInput } from '../types.js'
import { snapshotKey } from './codec.js'
import { positiveInteger } from './lifecycle.js'

/** A streaming procedure such as a `createPubSub` subscribe route. */
/* biome-ignore-start lint/suspicious/noExplicitAny: matches any context, input, errors and meta */
type StreamProcedure<TEvent> = Procedure<
	any,
	any,
	any,
	Schema<any, AsyncIterable<TEvent>>,
	any,
	any
>
/* biome-ignore-end lint/suspicious/noExplicitAny: matches any context, input, errors and meta */

/** Rejects a source whose input does not accept `{}` or whose context `TContext` does not satisfy. */
type SourceCheck<TContext, TSource> = [Record<never, never>] extends [
	ProcedureInput<TSource>
]
	? [TContext] extends [ProcedureContext<TSource>]
		? unknown
		: {
				'orpc-fn: invalidationStream context does not satisfy this source': ProcedureContext<TSource>
			}
	: {
			'orpc-fn: invalidationStream sources must accept empty input `{}`': ProcedureInput<TSource>
		}

/** One event of an invalidation stream: the domain that changed, plus whatever its mapper added. */
export type InvalidationEvent<
	TEvents extends Record<string, unknown>,
	TExtras extends { [K in keyof TEvents]?: object }
> = {
	[K in keyof TEvents & string]: { domain: K } & (K extends keyof TExtras
		? Partial<TExtras[K]>
		: unknown)
}[keyof TEvents & string]

const DEFAULT_MAX_QUEUE_SIZE = 1000

/**
 * Fans several change streams into one stream of `{ domain }` events, so a
 * client keeps one connection and invalidates queries per domain. Use it as
 * the body of a streaming `fn`:
 *
 * ```ts
 * fn({
 *   name: 'realtime.changes',
 *   stream: true,
 *   input: z.object({}),
 *   handler: ({ context, signal }) =>
 *     invalidationStream({
 *       context,
 *       signal,
 *       sources: { deal: dealChanges.subscribe, workItem: workItemChanges.subscribe },
 *       // Optional: forward fields a client acts on (alerts), not just the domain.
 *       events: { deal: (event) => (event.kind === 'won' ? { dealId: event.dealId } : undefined) }
 *     })
 * })
 * ```
 *
 * Each source is called with `{}`, the caller's context and a signal of its
 * own. Events that queue up while the consumer is busy collapse when equal.
 * When one source ends, the stream ends (a deploy drain); when one throws,
 * the stream throws. Either way every source is closed and the client
 * reconnects, which recreates them all.
 */
export async function* invalidationStream<
	TContext,
	TSources extends Record<string, StreamProcedure<unknown>>,
	TExtras extends {
		[K in keyof TSources]?: object
	} = Record<never, never>
>(options: {
	context: TContext
	signal?: AbortSignal | undefined
	sources: TSources & {
		[K in keyof TSources]: SourceCheck<TContext, TSources[K]>
	}
	events?: {
		[K in keyof TExtras]: (
			value: NoInfer<
				TSources[K & keyof TSources] extends StreamProcedure<infer TEvent>
					? TEvent
					: never
			>
		) => TExtras[K] | undefined
	}
	/** Maximum distinct queued events before dropping the oldest (default 1000). */
	maxQueueSize?: number
}): AsyncGenerator<
	InvalidationEvent<
		{
			[K in keyof TSources]: TSources[K] extends StreamProcedure<infer TEvent>
				? TEvent
				: never
		},
		TExtras
	>,
	void,
	unknown
> {
	type Event = InvalidationEvent<
		{
			[K in keyof TSources]: TSources[K] extends StreamProcedure<infer TEvent>
				? TEvent
				: never
		},
		TExtras
	>
	const maxQueueSize = positiveInteger(
		options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
		'maxQueueSize'
	)
	const controller = new AbortController()
	const abort = () => controller.abort()
	if (options.signal?.aborted) abort()
	options.signal?.addEventListener('abort', abort, { once: true })

	// Keyed by the serialized event: equal events collapse while queued.
	const queue = new Map<string, Event>()
	let wake: (() => void) | undefined
	let ended = false
	let failure: { error: unknown } | undefined
	const stop = (error?: { error: unknown }) => {
		if (ended) return
		ended = true
		failure = error
		controller.abort()
		wake?.()
	}
	controller.signal.addEventListener('abort', () => stop(), { once: true })

	const mappers = (options.events ?? {}) as Record<
		string,
		((value: unknown) => object | undefined) | undefined
	>
	const pump = async (domain: string, procedure: AnyProcedure) => {
		let iterator: AsyncIterator<unknown> | undefined
		try {
			// oRPC's `call`, not the handler's bound call: closing a source needs
			// a signal of its own, because return() waits behind a pending next().
			const stream = (await call(
				procedure,
				{},
				{ context: options.context, signal: controller.signal }
			)) as AsyncIterable<unknown>
			iterator = stream[Symbol.asyncIterator]()
			while (!ended) {
				const result = await iterator.next()
				if (result.done) return stop()
				const mapped = mappers[domain]?.(result.value)
				const event = (mapped ? { ...mapped, domain } : { domain }) as Event
				const key = mapped
					? (snapshotKey(event) ?? JSON.stringify(event))
					: domain
				if (!queue.has(key) && queue.size >= maxQueueSize) {
					const oldest = queue.keys().next()
					if (!oldest.done) queue.delete(oldest.value)
				}
				queue.set(key, event)
				wake?.()
			}
		} catch (error) {
			stop({ error })
		} finally {
			await iterator?.return?.().catch(() => {})
		}
	}
	const entries = Object.entries(options.sources)
	if (entries.length === 0) return
	const pumps = entries.map(([domain, procedure]) =>
		pump(domain, procedure as AnyProcedure)
	)

	try {
		while (true) {
			const next = queue.entries().next()
			if (!next.done) {
				queue.delete(next.value[0])
				yield next.value[1]
				continue
			}
			if (ended) break
			await new Promise<void>((resolve) => {
				wake = resolve
			})
			wake = undefined
		}
		if (failure) throw failure.error
	} finally {
		stop()
		options.signal?.removeEventListener('abort', abort)
		await Promise.allSettled(pumps)
	}
}
