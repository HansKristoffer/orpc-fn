import { ORPCError } from '@orpc/server'

/**
 * An expected client failure: an `ORPCError` with a 4xx status (validation,
 * auth, not-found) or an `AbortError` (the client closed the connection, e.g.
 * a browser leaving a live stream). These are normal outcomes the caller
 * drives, not server defects, so they must not be logged at `error` severity
 * or reported to error tracking. Only 5xx and unknown failures are defects.
 *
 * This is the default `isExpectedError`; extend it with `createFn({ isExpectedError })`.
 */
export function isExpectedClientError(error: unknown): boolean {
	if (error instanceof ORPCError && error.status < 500) return true
	return isAbortError(error)
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}
