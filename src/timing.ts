/** Internal bridge shared by the execution middleware and HTTP adapters. */
export const REQUEST_TIMING = Symbol('orpc-fn.requestTiming')
export type InvocationTiming = {
	/** Wall-clock during which a top-level procedure ran (see {@link Overlap}). */
	procedureMs: number
	calls: number
	running: Overlap
}

/**
 * Work that may overlap, timed as wall-clock: the calls of a batch run at
 * once, and the sum of their durations can exceed the whole request.
 */
export type Overlap = { active: number; since: number }

export const newOverlap = (): Overlap => ({ active: 0, since: 0 })

export function enterOverlap(overlap: Overlap): void {
	if (overlap.active++ === 0) overlap.since = performance.now()
}

/** The milliseconds to record: the span that just ended, or 0 while other work is still in flight. */
export function leaveOverlap(overlap: Overlap): number {
	return --overlap.active === 0 ? performance.now() - overlap.since : 0
}

/** Extras a `createTestCall` replaces, carried through nested calls. */
export const EXTRAS_OVERRIDE = Symbol('orpc-fn.extrasOverride')
