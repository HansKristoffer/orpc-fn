import { describe, expect, test } from 'bun:test'
import { fnLivePatch, streamLiveSnapshots } from './fn-live.js'

/** Coalesce window used in tests - comfortably small but not flaky. */
const COALESCE_MS = 30
/** Gap between human-paced pushes; safely larger than the coalesce window. */
const GAP_MS = 90

/**
 * A push-based async iterator we can feed events into on demand, so tests can
 * control exact arrival timing relative to the coalesce window.
 */
function createChannel<T>() {
	const buffered: T[] = []
	const waiting: Array<(result: IteratorResult<T>) => void> = []
	let closed = false

	const iterator: AsyncIterator<T> = {
		next() {
			if (buffered.length > 0) {
				return Promise.resolve({ done: false, value: buffered.shift()! })
			}
			if (closed) {
				return Promise.resolve({ done: true, value: undefined as never })
			}
			return new Promise<IteratorResult<T>>((resolve) => {
				waiting.push(resolve)
			})
		},
		return() {
			closed = true
			return Promise.resolve({ done: true, value: undefined as never })
		}
	}

	return {
		iterator,
		push(value: T) {
			const resolve = waiting.shift()
			if (resolve) resolve({ done: false, value })
			else buffered.push(value)
		},
		close() {
			closed = true
			const resolve = waiting.shift()
			if (resolve) resolve({ done: true, value: undefined as never })
		}
	}
}

/** Collect every snapshot the generator yields into a growing array. */
function collectSnapshots<T>(generator: AsyncGenerator<T>) {
	const snapshots: T[] = []
	const finished = (async () => {
		for await (const snapshot of generator) {
			snapshots.push(snapshot)
		}
	})()
	return { snapshots, finished }
}

describe('streamLiveSnapshots', () => {
	test('human-paced delivery is never one behind (every-other regression)', async () => {
		const channel = createChannel<number>()
		const { snapshots, finished } = collectSnapshots(
			streamLiveSnapshots<number, number[]>({
				source: channel.iterator,
				initial: [],
				coalesceMs: COALESCE_MS,
				apply: (event, previous) => [...previous, event]
			})
		)

		// The initial snapshot is yielded immediately.
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual([])

		// Each event arrives more than a coalesce window apart. Before the fix,
		// even-numbered arrivals (E2, E4) stayed parked behind the next read and
		// only flushed on the following odd arrival. They must now apply on time.
		for (let event = 1; event <= 5; event++) {
			channel.push(event)
			await Bun.sleep(GAP_MS)
			expect(snapshots.at(-1)).toEqual(
				Array.from({ length: event }, (_, index) => index + 1)
			)
		}

		channel.close()
		await finished
		expect(snapshots.at(-1)).toEqual([1, 2, 3, 4, 5])
	})

	test('events within the coalesce window batch together', async () => {
		const channel = createChannel<number>()
		const applied: number[] = []
		const { snapshots, finished } = collectSnapshots(
			streamLiveSnapshots<number, number[]>({
				source: channel.iterator,
				initial: [],
				coalesceMs: COALESCE_MS,
				apply: (event, previous) => {
					applied.push(event)
					return [...previous, event]
				}
			})
		)

		channel.push(1)
		channel.push(2)
		channel.push(3)
		await Bun.sleep(GAP_MS)

		expect(applied).toEqual([1, 2, 3])
		expect(snapshots.at(-1)).toEqual([1, 2, 3])

		channel.close()
		await finished
	})

	test('apply returning undefined yields nothing and keeps previous', async () => {
		const channel = createChannel<number>()
		const { snapshots, finished } = collectSnapshots(
			streamLiveSnapshots<number, number[]>({
				source: channel.iterator,
				initial: [],
				coalesceMs: COALESCE_MS,
				apply: (event, previous) =>
					event === 2 ? undefined : [...previous, event]
			})
		)

		channel.push(1)
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual([1])

		channel.push(2)
		await Bun.sleep(GAP_MS)
		// Skipped: no new snapshot, previous unchanged.
		expect(snapshots.at(-1)).toEqual([1])

		channel.push(3)
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual([1, 3])

		channel.close()
		await finished
	})

	test('fnLivePatch keeps state as accumulator but yields only emit', async () => {
		const channel = createChannel<number>()
		const { snapshots, finished } = collectSnapshots(
			streamLiveSnapshots<number, number[], { latest: number }>({
				source: channel.iterator,
				initial: [],
				coalesceMs: COALESCE_MS,
				apply: (event, previous) =>
					event % 2 === 0
						? fnLivePatch([...previous, event], { latest: event })
						: [...previous, event]
			})
		)

		channel.push(1)
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual([1])

		// Patch result: the wire sees only the emit payload...
		channel.push(2)
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual({ latest: 2 })

		// ...but the internal accumulator advanced with the patched state.
		channel.push(3)
		await Bun.sleep(GAP_MS)
		expect(snapshots.at(-1)).toEqual([1, 2, 3])

		channel.close()
		await finished
	})

	test('works without coalescing', async () => {
		const channel = createChannel<number>()
		const { snapshots, finished } = collectSnapshots(
			streamLiveSnapshots<number, number[]>({
				source: channel.iterator,
				initial: [],
				apply: (event, previous) => [...previous, event]
			})
		)

		channel.push(1)
		await Bun.sleep(10)
		expect(snapshots.at(-1)).toEqual([1])

		channel.push(2)
		await Bun.sleep(10)
		expect(snapshots.at(-1)).toEqual([1, 2])

		channel.close()
		await finished
	})
})
