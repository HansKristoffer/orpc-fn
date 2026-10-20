import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createApp, effectScope } from 'vue'
import { provideOrpc } from '../vue.js'

type Method = (...args: never[]) => unknown
type MockFactory = (implementation: Method) => Method

export type OrpcMock<T> = T & {
	/** Reset every method mock created so far (calls `mockReset` when the factory provides it). */
	$reset: () => void
}

export type CreateOrpcMockOptions = {
	/** Wraps each method, e.g. `mock` from `bun:test` or `vi.fn`, so calls can be asserted. */
	fn?: MockFactory
	/** Namespace `.key()` results (default: `[namespace]`). */
	keys?: Record<string, readonly unknown[]>
	/** Explicit namespace shapes merged over the auto-mock. */
	overrides?: Record<string, unknown>
}

const emptyAsyncIterable = () => ({
	async *[Symbol.asyncIterator]() {}
})

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A deep stand-in for oRPC utils or a client: `o.order.key()` is `['order']`,
 * `o.order.get.call()` resolves an empty stream, `.key()`/`.queryKey()` on a
 * procedure return `[]`, and any other method returns `{}`. The same path
 * always returns the same mock, so calls can be asserted. Type it as your
 * utils: `createOrpcMock<typeof orpc>({ fn: mock })`.
 */
export function createOrpcMock<T = Record<string, unknown>>(
	options: CreateOrpcMockOptions = {}
): OrpcMock<T> {
	const { fn = (implementation) => implementation, keys, overrides } = options
	const created: Method[] = []
	const method = (implementation: Method) => {
		const wrapped = fn(implementation)
		created.push(wrapped)
		return wrapped
	}
	const reset = () => {
		for (const wrapped of created) {
			;(wrapped as { mockReset?: () => void }).mockReset?.()
		}
	}

	const procedures = new Map<string, Record<string, unknown>>()
	const procedure = (path: string) => {
		let found = procedures.get(path)
		if (!found) {
			const methods = new Map<string, Method>()
			found = new Proxy(
				{},
				{
					get(_target, name) {
						if (typeof name === 'symbol') return undefined
						let existing = methods.get(name)
						if (!existing) {
							existing = method(
								name === 'call'
									? async () => emptyAsyncIterable()
									: name === 'key' || name === 'queryKey'
										? () => []
										: () => ({})
							)
							methods.set(name, existing)
						}
						return existing
					}
				}
			)
			procedures.set(path, found)
		}
		return found
	}

	const namespaces = new Map<string, Record<string, unknown>>()
	const namespace = (name: string) => {
		let found = namespaces.get(name)
		if (!found) {
			const override = overrides?.[name]
			const target = isObject(override) ? { ...override } : {}
			found = new Proxy(target, {
				get(shape, key) {
					if (typeof key === 'symbol') return undefined
					if (key === 'key') return () => keys?.[name] ?? [name]
					if (key in shape) return shape[key]
					return procedure(`${name}.${key}`)
				}
			})
			namespaces.set(name, found)
		}
		return found
	}

	// The proxy answers every path at runtime; `T` is the shape tests read it as.
	return new Proxy({ $reset: reset } as OrpcMock<T>, {
		get(_target, key) {
			if (key === '$reset') return reset
			if (typeof key === 'symbol') return undefined
			const override = overrides?.[key]
			if (override !== undefined && !isObject(override)) return override
			return namespace(key)
		}
	})
}

export type TestConnection<T> = {
	input: unknown
	signal: AbortSignal | undefined
	readonly closed: boolean
	/** Deliver an event. Resolves once the consumer asked for the next one, or the stream closed. */
	push: (event: T) => Promise<void>
	/** End the stream normally (`done`). */
	end: () => void
	/** Fail the stream. */
	fail: (error: Error) => void
}

export type TestStream<T> = {
	/** Pass as the subscribe function; works for any `(input, …, { signal })` shape. */
	subscribe: (...args: unknown[]) => Promise<AsyncIterable<T>>
	/** Every connection opened so far, oldest first. */
	connections: TestConnection<T>[]
	/** Resolves when at least `count` connections have been opened. */
	opened: (count?: number) => Promise<TestConnection<T>>
	/** Push into the newest connection. */
	push: (event: T) => Promise<void>
	end: () => void
	fail: (error: Error) => void
}

/**
 * A controllable stand-in for an oRPC event iterator, for driving
 * subscriptions and live queries in tests without timers.
 */
export function createTestStream<T>(): TestStream<T> {
	const connections: TestConnection<T>[] = []
	const openWaiters: { count: number; resolve: () => void }[] = []

	function open(args: unknown[]): TestConnection<T> {
		const options = [...args]
			.reverse()
			.find(
				(arg): arg is { signal?: AbortSignal } =>
					isObject(arg) && 'signal' in arg
			)

		type Queued = {
			result: IteratorResult<T, undefined>
			delivered: () => void
		}
		const queue: Queued[] = []
		let failure: Error | null = null
		let closed = false
		let pending: {
			resolve: (result: IteratorResult<T, undefined>) => void
			reject: (error: Error) => void
		} | null = null
		// The event the consumer holds; it is processed once it asks for the next.
		let handedOut: (() => void) | null = null

		const settle = () => {
			if (!pending) return
			const current = pending
			if (failure) {
				pending = null
				current.reject(failure)
				return
			}
			const next = queue.shift()
			if (!next) return
			pending = null
			handedOut = next.delivered
			current.resolve(next.result)
		}

		const close = () => {
			closed = true
			handedOut?.()
			handedOut = null
			for (const queued of queue) queued.delivered()
		}

		// oRPC rejects a pending `next()` with an AbortError when the call is aborted.
		options?.signal?.addEventListener('abort', () => {
			const abort = new Error('This operation was aborted')
			abort.name = 'AbortError'
			failure = abort
			settle()
			close()
		})

		const connection: TestConnection<T> = {
			input: args[0],
			signal: options?.signal,
			get closed() {
				return closed
			},
			push(event) {
				if (closed) return Promise.resolve()
				return new Promise<void>((delivered) => {
					queue.push({ result: { done: false, value: event }, delivered })
					settle()
				})
			},
			end() {
				const done = { done: true as const, value: undefined }
				queue.push({ result: done, delivered: () => {} })
				settle()
				closed = true
			},
			fail(error) {
				failure = error
				settle()
				close()
			}
		}

		const iterator: AsyncIterator<T, undefined> = {
			next() {
				handedOut?.()
				handedOut = null
				return new Promise((resolve, reject) => {
					pending = { resolve, reject }
					settle()
				})
			},
			async return() {
				close()
				pending?.resolve({ done: true, value: undefined })
				pending = null
				return { done: true, value: undefined }
			}
		}

		connections.push(connection)
		for (const waiter of [...openWaiters]) {
			if (connections.length < waiter.count) continue
			openWaiters.splice(openWaiters.indexOf(waiter), 1)
			waiter.resolve()
		}
		return Object.assign(connection, {
			[Symbol.asyncIterator]: () => iterator
		})
	}

	const latest = () => {
		const connection = connections.at(-1)
		if (!connection) throw new Error('createTestStream: no connection opened')
		return connection
	}

	return {
		subscribe: async (...args) =>
			open(args) as TestConnection<T> & AsyncIterable<T>,
		connections,
		opened: (count = 1) =>
			new Promise((resolve) => {
				const done = () => resolve(connections[count - 1] as TestConnection<T>)
				if (connections.length >= count) done()
				else openWaiters.push({ count, resolve: done })
			}),
		push: (event) => latest().push(event),
		end: () => latest().end(),
		fail: (error) => latest().fail(error)
	}
}

/**
 * Run composables inside a real Vue app with a `QueryClient` and the provided
 * oRPC client, without a DOM. `stop()` disposes the scope, closing streams.
 */
export function withOrpcApp<T>(
	setup: () => T,
	options: {
		utils?: unknown
		client?: unknown
		queryClient?: QueryClient
	} = {}
) {
	const queryClient =
		options.queryClient ??
		new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const app = createApp({ render: () => null })
	app.use(VueQueryPlugin, { queryClient })
	provideOrpc(app, { client: options.client, utils: options.utils })
	const scope = effectScope()
	const result = app.runWithContext(() => scope.run(setup)) as T
	return { result, queryClient, app, stop: () => scope.stop() }
}
