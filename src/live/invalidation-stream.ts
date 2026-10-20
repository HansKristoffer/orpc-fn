import {
	type AnyProcedure,
	call,
	type Procedure,
	type Schema
} from '@orpc/server'

/** A streaming procedure taking no input, such as a `createPubSub` subscribe route. */
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

/** One event of an invalidation stream: the domain that changed, plus whatever its mapper added. */
export type InvalidationEvent<
	TEvents extends Record<string, unknown>,
	TExtras extends { [K in keyof TEvents]?: object }
> = {
	[K in keyof TEvents & string]: { domain: K } & (K extends keyof TExtras
		? Partial<TExtras[K]>
		: unknown)
}[keyof TEvents & string]

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
	TEvents extends Record<string, unknown>,
	TExtras extends { [K in keyof TEvents]?: object } = Record<never, never>
>(options: {
	context: unknown
	signal?: AbortSignal | undefined
	sources: { [K in keyof TEvents]: StreamProcedure<TEvents[K]> }
	events?: {
		[K in keyof TExtras]: (
			value: NoInfer<TEvents[K & keyof TEvents]>
		) => TExtras[K] | undefined
	}
}): AsyncGenerator<InvalidationEvent<TEvents, TExtras>, void, unknown> {
	type Event = InvalidationEvent<TEvents, TExtras>
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
				const event = { ...mappers[domain]?.(result.value), domain } as Event
				queue.set(JSON.stringify(event), event)
				wake?.()
			}
		} catch (error) {
			stop({ error })
		} finally {
			await iterator?.return?.().catch(() => {})
		}
	}
	const pumps = Object.entries(options.sources).map(([domain, procedure]) =>
		pump(domain, procedure as AnyProcedure)
	)

	try {
		while (true) {
			const [next] = queue
			if (next) {
				queue.delete(next[0])
				yield next[1]
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
