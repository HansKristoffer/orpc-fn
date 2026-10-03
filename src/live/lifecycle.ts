/** Internal control message: live queries reload after loss; raw streams fail. */
export const LIVE_GAP = Symbol('orpc-fn.liveGap')

export function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`orpc-fn: ${name} must be a positive safe integer`)
	return value
}

export function safely(callback: (() => unknown) | undefined): void {
	try {
		callback?.()
	} catch {
		/* Observability must not disrupt delivery. */
	}
}

/** Abort and timeout only stop waiting; callers release late transport results. */
export async function waitFor<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal: AbortSignal
): Promise<T> {
	signal.throwIfAborted()
	let timer: ReturnType<typeof setTimeout> | undefined
	let abort = () => {}
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason)
				signal.addEventListener('abort', abort, { once: true })
				timer = setTimeout(
					() =>
						reject(new Error('orpc-fn: subscription initialization timed out')),
					timeoutMs
				)
			})
		])
	} finally {
		clearTimeout(timer)
		signal.removeEventListener('abort', abort)
	}
}
