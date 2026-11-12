import { ORPCError } from '@orpc/server'

// ponytail: one set per package copy; apps with two installed copies of
// orpc-fn must still pass isExpectedError to mountOrpc and the tool adapters.
const classifiedExpected = new WeakSet<object>()

/**
 * An expected client failure: an `ORPCError` with a 4xx status (validation,
 * auth, not-found) or an `AbortError` (the client closed the connection, e.g.
 * a browser leaving a live stream). These are normal outcomes the caller
 * drives, not server defects, so they must not be logged at `error` severity
 * or reported to error tracking. Only 5xx and unknown failures are defects.
 *
 * It is also true for any error a `createFn({ isExpectedError })` classified
 * as expected when a route threw it, so `mountOrpc` and the tool adapters
 * follow the factory's rule without being told it again.
 *
 * This is the default `isExpectedError`; extend it with `createFn({ isExpectedError })`.
 */
export function isExpectedClientError(error: unknown): boolean {
	if (error instanceof ORPCError && error.status < 500) return true
	if (
		typeof error === 'object' &&
		error !== null &&
		classifiedExpected.has(error)
	)
		return true
	return isAbortError(error)
}

/** @internal Remembers that the factory's `isExpectedError` accepted `error`. */
export function markExpected(error: unknown): void {
	if (typeof error === 'object' && error !== null) classifiedExpected.add(error)
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}
