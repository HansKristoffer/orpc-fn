import { COMMON_ERROR_STATUS_MAP, ORPCError } from '@orpc/server'

// ponytail: one set per package copy; apps with two installed copies of
// orpc-fn must still pass isExpectedError to mountOrpc and the tool adapters.
const classifiedExpected = new WeakSet<object>()

function ownStatus(
	map: Record<string, number> | undefined,
	code: string
): number | undefined {
	return map && Object.hasOwn(map, code) ? map[code] : undefined
}

function statusOf(code: string, statusMap?: Record<string, number>): number {
	return (
		ownStatus(statusMap, code) ??
		ownStatus(COMMON_ERROR_STATUS_MAP as Record<string, number>, code) ??
		400
	)
}

/**
 * The HTTP status a handler answers `error` with: oRPC 2 errors carry no
 * status, so it is the code's entry in `errorStatusMap` (the one given to
 * `mountOrpc`), else oRPC's common map, else 400. Any other thrown value
 * answers as `INTERNAL_SERVER_ERROR` (500), as oRPC does.
 *
 * ```ts
 * errorResponseBodyEncoder: (error) => ({ ...error.toJSON(), status: errorStatusOf(error, statusMap) })
 * ```
 */
export function errorStatusOf(
	error: unknown,
	errorStatusMap?: Record<string, number>
): number {
	return statusOf(
		error instanceof ORPCError ? error.code : 'INTERNAL_SERVER_ERROR',
		errorStatusMap
	)
}

/**
 * An expected client failure: an `ORPCError` oRPC answers with a 4xx (validation,
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
	return isExpectedWithStatusMap(error)
}

/** @internal `isExpectedClientError` under an adapter's `errorStatusMap`. */
export function isExpectedWithStatusMap(
	error: unknown,
	statusMap?: Record<string, number>
): boolean {
	if (error instanceof ORPCError && statusOf(error.code, statusMap) < 500)
		return true
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
