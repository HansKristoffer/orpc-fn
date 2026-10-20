import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	mock,
	test
} from 'bun:test'
import {
	createInvalidationCoordinator,
	createSubscriptionRunner,
	type LiveConnectionStatus,
	nextReconnectDelayMs
} from './realtime.js'
import { createTestStream } from './vue/testing.js'

describe('nextReconnectDelayMs', () => {
	test('escalates exponentially from 1s and caps the delay at 15s', () => {
		const noJitter = () => 0
		expect(nextReconnectDelayMs(1, noJitter)).toBe(1000)
		expect(nextReconnectDelayMs(2, noJitter)).toBe(2000)
		expect(nextReconnectDelayMs(3, noJitter)).toBe(4000)
		expect(nextReconnectDelayMs(4, noJitter)).toBe(8000)
		expect(nextReconnectDelayMs(5, noJitter)).toBe(15_000)
		// The cap is on the delay, never the attempts.
		expect(nextReconnectDelayMs(50, noJitter)).toBe(15_000)
	})

	test('adds at most 25% jitter', () => {
		const fullJitter = () => 1
		expect(nextReconnectDelayMs(1, fullJitter)).toBe(1250)
		expect(nextReconnectDelayMs(5, fullJitter)).toBe(18_750)
	})

	test('an errorCount of 0 behaves like the first attempt', () => {
		expect(nextReconnectDelayMs(0, () => 0)).toBe(1000)
	})
})

function runnerFor<T>(
	open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
	overrides: { shouldReconnect?: () => boolean } = {}
) {
	const statuses: LiveConnectionStatus[] = []
	const waiters: { status: LiveConnectionStatus; resolve: () => void }[] = []
	/** Resolves the next time the runner reports `status`. */
	const reaches = (status: LiveConnectionStatus) =>
		new Promise<void>((resolve) => waiters.push({ status, resolve }))
	const events: T[] = []
	const onClose = mock(() => {})
	const runner = createSubscriptionRunner<T>({
		open,
		onEvent: (event) => events.push(event),
		onStatus: (status) => {
			statuses.push(status)
			for (const waiter of waiters.splice(0)) {
				if (waiter.status === status) waiter.resolve()
				else waiters.push(waiter)
			}
		},
		onClose,
		canConnect: () => true,
		shouldReconnect: overrides.shouldReconnect ?? (() => false)
	})
	return { runner, statuses, events, onClose, reaches }
}

describe('createSubscriptionRunner', () => {
	test('does not report events after disconnect', async () => {
		const stream = createTestStream<{ value: string }>()
		const { runner, events } = runnerFor((signal) =>
			stream.subscribe({ signal })
		)

		await runner.connect()
		const connection = await stream.opened()
		await runner.disconnect()
		await connection.push({ value: 'late' })

		expect(events).toEqual([])
		expect(connection.closed).toBe(true)
	})

	test('a stream that ends closes after its last event', async () => {
		const stream = createTestStream<{ id: number }>()
		const { runner, events, statuses, onClose, reaches } = runnerFor((signal) =>
			stream.subscribe({ signal })
		)

		await runner.connect()
		await stream.push({ id: 1 })
		await stream.push({ id: 2 })
		const closed = reaches('closed')
		stream.end()
		await closed

		expect(events).toEqual([{ id: 1 }, { id: 2 }])
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(statuses.at(-1)).toBe('closed')
	})

	test('disconnect while connecting never leaves a zombie stream', async () => {
		let release!: (iterable: AsyncIterable<string>) => void
		let receivedSignal: AbortSignal | undefined
		const returned = mock(async () => ({
			done: true as const,
			value: undefined
		}))
		const { runner } = runnerFor<string>((signal) => {
			receivedSignal = signal
			return new Promise((resolve) => {
				release = resolve
			})
		})

		const connecting = runner.connect()
		expect(runner.getStatus()).toBe('connecting')
		await runner.disconnect()
		expect(runner.getStatus()).toBe('closed')
		expect(receivedSignal?.aborted).toBe(true)

		release({
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<string>>(() => {}),
				return: returned
			})
		})
		await connecting

		expect(runner.getStatus()).toBe('closed')
		expect(returned).toHaveBeenCalledTimes(1)
	})

	test('an unexpected end reconnects after backoff and aborts the failed request', async () => {
		jest.useFakeTimers()
		try {
			const stream = createTestStream<number>()
			const { runner, events, reaches } = runnerFor(
				(signal) => stream.subscribe({ signal }),
				{ shouldReconnect: () => true }
			)
			await runner.connect()
			const first = await stream.opened(1)
			const failed = reaches('error')
			first.fail(new Error('proxy reset'))
			await failed
			expect(runner.getStatus()).toBe('error')
			expect(first.signal?.aborted).toBe(true)
			expect(runner.isLive()).toBe(true)

			jest.advanceTimersByTime(1250)
			await stream.opened(2)
			await stream.push(7)
			expect(events).toEqual([7])
			await runner.dispose()
		} finally {
			jest.useRealTimers()
		}
	})
})

describe('createInvalidationCoordinator', () => {
	// How long a quiet reconnect must stay up before it counts as healthy.
	const settleMs = 1_500
	const invalidateQueries = mock(async (_filters: unknown) => {})
	type ChangeEvent = { domain: 'support' | 'knowledgeGap' | 'workItem' }
	const queryKeys = {
		support: ['support'],
		knowledgeGap: ['knowledgeGap'],
		workItem: ['workItem']
	}
	const coordinate = (onEvent?: (event: ChangeEvent) => void) =>
		createInvalidationCoordinator<ChangeEvent>(
			{ invalidateQueries },
			{
				domains: {
					support: { debounceMs: 500, queryKeys: [queryKeys.support] },
					knowledgeGap: { queryKeys: [queryKeys.knowledgeGap] },
					workItem: { debounceMs: 100, queryKeys: [queryKeys.workItem] }
				},
				refetchType: 'all',
				...(onEvent ? { onEvent } : {})
			}
		)
	const invalidatedKeys = () =>
		invalidateQueries.mock.calls.map(
			([filters]) => (filters as { queryKey: unknown }).queryKey
		)

	beforeEach(() => {
		jest.useFakeTimers()
		invalidateQueries.mockClear()
	})
	afterEach(() => jest.useRealTimers())

	test('routes domains to their keys; debounced domains batch a burst', () => {
		const coordinator = coordinate()
		coordinator.event({ domain: 'knowledgeGap' })
		expect(invalidateQueries).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ['knowledgeGap'],
				refetchType: 'all',
				predicate: expect.any(Function)
			})
		)
		invalidateQueries.mockClear()

		coordinator.event({ domain: 'support' })
		coordinator.event({ domain: 'support' })
		coordinator.event({ domain: 'support' })
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
		jest.advanceTimersByTime(500)
		expect(invalidatedKeys()).toEqual([['support']])
	})

	test('a steady stream of events cannot postpone the refresh', () => {
		const coordinator = coordinate()
		coordinator.event({ domain: 'support' })
		jest.advanceTimersByTime(400)
		coordinator.event({ domain: 'support' })
		jest.advanceTimersByTime(100)
		expect(invalidatedKeys()).toEqual([['support']])
	})

	test('ignores unknown domains and malformed events, and does not report them', () => {
		const onEvent = mock(() => {})
		const coordinator = coordinate(onEvent)
		coordinator.event({ domain: 'unknown-domain' } as unknown as ChangeEvent)
		coordinator.event({ domain: 'toString' } as unknown as ChangeEvent)
		coordinator.event({} as ChangeEvent)
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
		// A domain this client does not map is still a valid event.
		expect(onEvent).toHaveBeenCalledTimes(2)
	})

	test('dispose clears pending debounces', () => {
		const coordinator = coordinate()
		coordinator.event({ domain: 'support' })
		coordinator.dispose()
		jest.advanceTimersByTime(500)
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
	})

	test('the first connection never triggers a catch-up refetch', () => {
		const coordinator = coordinate()
		coordinator.connect(1)
		jest.advanceTimersByTime(settleMs)
		coordinator.event({ domain: 'knowledgeGap' })
		expect(invalidatedKeys()).toEqual([['knowledgeGap']])
	})

	test('reconnect catch-up waits for a delivered event, not the accept', () => {
		const coordinator = coordinate()
		coordinator.connect(2)
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
		coordinator.event({ domain: 'knowledgeGap' })
		expect(invalidatedKeys()).toContainEqual(['knowledgeGap'])
		expect(invalidatedKeys()).toContainEqual(['support'])
	})

	test('reconnect catch-up fires after the settle window if the stream stays quiet', () => {
		const coordinator = coordinate()
		coordinator.connect(2)
		jest.advanceTimersByTime(settleMs - 1)
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
		jest.advanceTimersByTime(1)
		expect(invalidatedKeys()).toContainEqual(['support'])
	})

	test('a connect that dies before settling does not invalidate', () => {
		const coordinator = coordinate()
		coordinator.connect(2)
		coordinator.lost()
		jest.advanceTimersByTime(settleMs)
		expect(invalidateQueries).toHaveBeenCalledTimes(0)
	})

	test('a catch-up owed by a dead connect is paid by the next one that settles', () => {
		const coordinator = coordinate()
		coordinator.connect(2)
		coordinator.lost()
		coordinator.connect(3)
		jest.advanceTimersByTime(settleMs)
		expect(invalidatedKeys()).toContainEqual(['support'])
	})

	test('logs a lost stream at most once a minute', () => {
		const warn = mock(() => {})
		const coordinator = createInvalidationCoordinator<ChangeEvent>(
			{ invalidateQueries },
			{ domains: {}, logger: { warn } }
		)
		coordinator.lost()
		coordinator.lost()
		expect(warn).toHaveBeenCalledTimes(1)
		jest.setSystemTime(Date.now() + 60_000)
		coordinator.lost()
		expect(warn).toHaveBeenCalledTimes(2)
	})
})
