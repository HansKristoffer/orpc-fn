/** A value oRPC streams to the client (an async generator or iterator). */
export function isAsyncIteratorObject(
	value: unknown
): value is AsyncIterator<unknown> & AsyncIterable<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
			'function' &&
		typeof (value as AsyncIterator<unknown>).next === 'function'
	)
}

/**
 * Wraps a stream so `finish` runs once when it ends: after the last item,
 * when it throws (with the error), or when the consumer stops early with
 * `return()` - also before the first `next()`, which a plain async generator
 * wrapper would miss.
 */
export function onStreamEnd<T>(
	stream: AsyncIterator<T> & AsyncIterable<T>,
	finish: (...error: [] | [unknown]) => void
): AsyncIterator<T> & AsyncIterable<T> {
	let finished = false
	const done = (...error: [] | [unknown]) => {
		if (finished) return
		finished = true
		finish(...error)
	}
	const settle = async (step: () => Promise<IteratorResult<T>> | undefined) => {
		try {
			const result = await step()
			if (!result || result.done) done()
			return result ?? { done: true as const, value: undefined }
		} catch (error) {
			done(error)
			throw error
		}
	}
	const wrapped: AsyncIterator<T> & AsyncIterable<T> = {
		next: (...args) => settle(() => stream.next(...args)),
		return: (value) =>
			settle(() => stream.return?.(value)).finally(() => done()),
		throw: (error) =>
			settle(() => stream.throw?.(error) ?? Promise.reject(error)),
		[Symbol.asyncIterator]: () => wrapped
	}
	return wrapped
}
