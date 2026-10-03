import { beforeEach, describe, expect, mock, test } from 'bun:test'
import * as otel from '@opentelemetry/api'
import { call, ORPCError, os } from '@orpc/server'
import { z } from 'zod'
import {
	completed,
	fn,
	type PublicContext,
	readMeta,
	user
} from '../tests/fixture.js'
import { createFn, readFnMeta } from './index.js'

beforeEach(() => {
	completed.length = 0
})

describe('procedure selection', () => {
	const whoAmI = fn({
		name: 'test.whoAmI',
		handler: ({ context }) => context.user.email
	})

	test('defaults to the `default` builder and runs its middleware', async () => {
		await expect(call(whoAmI, undefined, { context: {} })).rejects.toThrow(
			ORPCError
		)
		await expect(
			call(whoAmI, undefined, { context: { user: user() } })
		).resolves.toBe('user@example.com')
	})

	test('procedure: picks a named builder', async () => {
		const open = fn({
			name: 'test.open',
			procedure: 'public',
			handler: ({ context }) => context.user?.id ?? 'anonymous'
		})
		await expect(call(open, undefined, { context: {} })).resolves.toBe(
			'anonymous'
		)
	})

	test('an unknown procedure key throws when the route is defined', () => {
		expect(() =>
			fn({
				name: 'test.unknown',
				// @ts-expect-error not a configured procedure
				procedure: 'nope',
				handler: () => 1
			})
		).toThrow('unknown procedure "nope"')
	})
})

describe('guards (ported from needed-feature-flags.test.ts)', () => {
	const flagged = fn({
		name: 'test.flagged',
		neededFeatureFlags: ['vehicles', 'journeys'],
		handler: () => 'ok'
	})

	test('passes when the user has all needed flags', async () => {
		const context = {
			user: user({ featureFlags: ['vehicles', 'journeys', 'automations'] })
		}
		await expect(call(flagged, undefined, { context })).resolves.toBe('ok')
	})

	test('throws FORBIDDEN when the user is missing a needed flag', async () => {
		const context = { user: user({ featureFlags: ['vehicles'] }) }
		await expect(call(flagged, undefined, { context })).rejects.toThrow(
			"Feature flag 'journeys' is not available"
		)
	})

	test('a guard only runs on routes that set its option', async () => {
		const plain = fn({ name: 'test.plain', handler: () => 'ok' })
		await expect(
			call(plain, undefined, { context: { user: user() } })
		).resolves.toBe('ok')
	})
})

describe('guards (ported from gey-mono fn-permission.test.ts)', () => {
	const handler = mock(async () => ({ ok: true }))
	const gated = fn({
		name: 'test.permission.gated',
		method: 'GET',
		permission: { admin: ['main'] },
		handler
	})

	test('runs the handler when the caller has the permission', async () => {
		const canPermission = mock(() => {})
		const context = { user: user({ canPermission }) }
		await expect(call(gated, undefined, { context })).resolves.toEqual({
			ok: true
		})
		expect(canPermission).toHaveBeenCalledWith({ admin: ['main'] })
	})

	test('rejects before the handler when the check throws', async () => {
		handler.mockClear()
		const context = {
			user: user({
				canPermission: mock(() => {
					throw new Error('FORBIDDEN')
				})
			})
		}
		await expect(call(gated, undefined, { context })).rejects.toThrow(
			'FORBIDDEN'
		)
		expect(handler).not.toHaveBeenCalled()
	})

	test('guard options are typed', () => {
		fn({
			name: 'test.permission.typed',
			// @ts-expect-error permission takes a requirement record
			permission: 'admin',
			handler: () => null
		})
	})
})

describe('handler params', () => {
	test('extras, logger, signal, call and context reach the handler', async () => {
		const callee = fn({
			name: 'test.callee',
			input: z.object({ n: z.number() }),
			handler: ({ input, context }) => ({
				doubled: input.n * 2,
				by: context.user.id
			})
		})
		const caller = fn({
			name: 'test.caller',
			handler: async ({ call, db, t, logger, signal }) => {
				logger.debug('calling')
				const result = await call(callee, { n: 21 })
				return {
					...result,
					sql: db.query('select 1'),
					greeting: t?.('hello'),
					hasSignal: signal instanceof AbortSignal
				}
			}
		})
		const abort = new AbortController()
		await expect(
			call(caller, undefined, {
				context: { user: user({ locale: 'da' }) },
				signal: abort.signal
			})
		).resolves.toEqual({
			doubled: 42,
			by: 'user-1',
			sql: 'select 1',
			greeting: 'da:hello',
			hasSignal: true
		})
	})

	test('a nested call stops when the signal is already aborted', async () => {
		const callee = fn({ name: 'test.never', handler: () => 'ran' })
		const caller = fn({
			name: 'test.abortingCaller',
			handler: ({ call }) => call(callee, undefined)
		})
		const abort = new AbortController()
		abort.abort()
		await expect(
			call(caller, undefined, {
				context: { user: user() },
				signal: abort.signal
			})
		).rejects.toThrow()
	})

	test('application context timing is not mutated', async () => {
		const timed = fn({ name: 'test.timed', handler: () => 'ok' })
		const context: PublicContext = { user: user(), timing: { queue_ms: 1 } }
		await call(timed, undefined, { context })
		expect(context.timing).toEqual({ queue_ms: 1 })
	})
})

describe('meta', () => {
	test('typed meta options are stored on the procedure', () => {
		const tool = fn({
			name: 'test.tool',
			summary: 'A tool',
			tags: ['external'],
			meta: { readOnly: true },
			handler: () => null
		})
		const meta = readMeta(tool)
		expect(meta.name).toBe('test.tool')
		expect(meta.procedure).toBe('protected')
		expect(meta.meta).toEqual({ readOnly: true })
		expect(meta.description).toBe('A tool')
		expect(meta.tags).toEqual(['external'])
	})

	test('meta options and tags are typed', () => {
		fn({
			name: 'test.badMeta',
			// @ts-expect-error readOnly is a boolean
			meta: { readOnly: 'yes' },
			handler: () => null
		})
		fn({
			name: 'test.badTag',
			// @ts-expect-error tags come from createFn({ tags })
			tags: ['nope'],
			handler: () => null
		})
	})

	test('meta survives procedures rebuilt by os.router()', () => {
		const tool = fn({
			name: 'test.rebuilt',
			meta: { readOnly: true },
			handler: () => 1
		})
		const rebuilt = os.prefix('/v1').router({ tool }).tool
		expect(rebuilt).not.toBe(tool)
		expect(readFnMeta(rebuilt).name).toBe('test.rebuilt')
		expect(readFnMeta(rebuilt).meta).toEqual({ readOnly: true })
	})

	test('procedures not made by fn() have no name', () => {
		const plain = os.handler(() => 1)
		expect(readFnMeta(plain).name).toBeUndefined()
		expect(readFnMeta(plain).description).toBe('')
	})
})

describe('fn.completed', () => {
	test('onCompleted sees every call, success or not', async () => {
		const ok = fn({ name: 'test.ok', handler: () => 1 })
		const boom = fn({
			name: 'test.boom',
			handler: () => {
				throw new Error('boom')
			}
		})
		await call(ok, undefined, { context: { user: user() } })
		await expect(
			call(boom, undefined, { context: { user: user() } })
		).rejects.toThrow('boom')
		expect(completed).toEqual([
			{ name: 'test.ok', success: true },
			{ name: 'test.boom', success: false }
		])
	})

	test('expected errors log at warn, defects at error', async () => {
		const lines: Array<[string, Record<string, unknown> | undefined]> = []
		const log =
			(level: string) =>
			(message: string, attributes?: Record<string, unknown>) =>
				lines.push([`${level}:${message}`, attributes])
		const { fn } = createFn({
			procedures: { public: os.$context<PublicContext>() },
			default: 'public',
			logger: () => ({
				debug: log('debug'),
				info: log('info'),
				warn: log('warn'),
				error: log('error')
			}),
			onCompleted: ({ context }) => ({
				pool_waiting: 0,
				auth_ms: context.timing?.auth_ms
			})
		})
		const notFound = fn({
			name: 'test.notFound',
			handler: () => {
				throw new ORPCError('NOT_FOUND')
			}
		})
		const crash = fn({
			name: 'test.crash',
			handler: () => {
				throw new Error('db down')
			}
		})
		const fine = fn({ name: 'test.fine', handler: () => 1 })
		await call(fine, undefined, { context: { timing: { auth_ms: 2 } } })
		await call(notFound, undefined, { context: {} }).catch(() => {})
		await call(crash, undefined, { context: {} }).catch(() => {})
		expect(lines.map(([line]) => line)).toEqual([
			'info:fn.completed',
			'warn:fn.completed',
			'error:fn.completed'
		])
		expect(lines[0]?.[1]).toMatchObject({
			operation: 'test.fine',
			status: 'success',
			auth_ms: 2,
			pool_waiting: 0
		})
		expect(lines[2]?.[1]).toMatchObject({
			status: 'failed',
			error_type: 'Error',
			error_message: 'db down'
		})
	})
})

describe('OpenTelemetry', () => {
	test('without otel, span is undefined and nothing crashes', async () => {
		const traced = fn({ name: 'test.noOtel', handler: ({ span }) => span })
		await expect(
			call(traced, undefined, { context: { user: user() } })
		).resolves.toBeUndefined()
	})

	test('with otel, every fn and nested call gets a span', async () => {
		const ended: string[] = []
		const attributes: Record<string, unknown> = {}
		const makeSpan = (name: string) => ({
			setAttribute: (key: string, value: unknown) => {
				attributes[`${name}|${key}`] = value
			},
			setStatus: () => {},
			recordException: () => {},
			end: () => ended.push(name)
		})
		const fakeOtel = {
			...otel,
			trace: {
				getTracer: () => ({
					startActiveSpan: (
						name: string,
						_options: unknown,
						run: (span: ReturnType<typeof makeSpan>) => unknown
					) => run(makeSpan(name)),
					startSpan: (name: string) => makeSpan(name)
				})
			}
		}
		const { fn } = createFn({
			procedures: { public: os.$context<PublicContext>() },
			default: 'public',
			otel: fakeOtel as unknown as typeof otel,
			spanAttributes: ({ context }) => ({ 'user.id': context.user?.id })
		})
		const inner = fn({ name: 'inner', handler: () => 1 })
		const outer = fn({
			name: 'outer',
			handler: ({ call, span }) => {
				span?.setAttribute('custom', true)
				return call(inner, undefined)
			}
		})
		await call(outer, undefined, { context: { user: user() } })
		expect(ended).toEqual(['inner', 'call: inner', 'outer'])
		expect(attributes['outer|fn.operation']).toBe('outer')
		expect(attributes['outer|user.id']).toBe('user-1')
		expect(attributes['outer|custom']).toBe(true)
		expect(attributes['call: inner|rpc.method']).toBe('inner')
	})
})

describe('createFn without a default procedure', () => {
	const { fn, createPubSub, fnLive } = createFn({
		procedures: {
			public: os.$context<PublicContext>(),
			protected: os
				.$context<PublicContext>()
				.use(({ context, next }) =>
					next({ context: { user: context.user ?? user() } })
				)
		},
		logger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
	})

	test('every route must name its procedure', () => {
		// @ts-expect-error `procedure` is required without a default
		expect(() => fn({ name: 'test.noProcedure', handler: () => 1 })).toThrow(
			'"test.noProcedure" needs a procedure; createFn has no default'
		)
		expect(() =>
			// @ts-expect-error also for pub/sub
			createPubSub({
				name: 'test.noProcedurePubSub',
				channel: 'x',
				inputSchema: z.object({}),
				eventSchema: z.object({})
			})
		).toThrow('needs a procedure')
		expect(() =>
			// @ts-expect-error also for live queries
			fnLive({
				name: 'test.noProcedureLive',
				input: z.object({}),
				handler: () => 1,
				live: { channel: 'x', eventSchema: z.object({}) }
			})
		).toThrow('needs a procedure')
	})

	test('the named procedure types the context', async () => {
		const me = fn({
			name: 'test.me',
			procedure: 'protected',
			handler: ({ context }) => context.user.id
		})
		expect(await call(me, undefined, { context: {} })).toBe('user-1')
	})
})

describe('streaming routes', () => {
	const events: Array<{ name: string; success: boolean; durationMs: number }> =
		[]
	const ended: string[] = []
	const makeSpan = (name: string) => ({
		setAttribute: () => {},
		setStatus: () => {},
		recordException: () => {},
		end: () => ended.push(name)
	})
	const { fn } = createFn({
		procedures: { public: os.$context<PublicContext>() },
		default: 'public',
		logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
		otel: {
			...otel,
			trace: {
				getTracer: () => ({
					startActiveSpan: (
						name: string,
						_options: unknown,
						run: (span: ReturnType<typeof makeSpan>) => unknown
					) => run(makeSpan(name)),
					startSpan: (name: string) => makeSpan(name)
				})
			}
		} as unknown as typeof otel,
		onCompleted: ({ name, success, durationMs }) => {
			events.push({ name, success, durationMs })
		}
	})
	const ticks = fn({
		name: 'test.ticks',
		stream: true,
		handler: async function* () {
			yield 1
			await Bun.sleep(30)
			yield 2
		}
	})
	const broken = fn({
		name: 'test.broken',
		stream: true,
		handler: async function* () {
			yield 1
			throw new Error('mid-stream')
		}
	})

	beforeEach(() => {
		events.length = 0
		ended.length = 0
	})

	test('the span and fn.completed cover the whole stream', async () => {
		const stream = await call(ticks, undefined, { context: {} })
		expect(events).toEqual([])
		expect(ended).toEqual([])
		const values: unknown[] = []
		for await (const value of stream) values.push(value)
		expect(values).toEqual([1, 2])
		expect(events).toMatchObject([{ name: 'test.ticks', success: true }])
		expect(events[0]?.durationMs).toBeGreaterThanOrEqual(25)
		expect(ended).toEqual(['test.ticks'])
	})

	test('an error mid-stream is logged as a failure', async () => {
		const stream = await call(broken, undefined, { context: {} })
		expect((await stream.next()).value).toBe(1)
		await expect(stream.next()).rejects.toThrow('mid-stream')
		expect(events).toMatchObject([{ name: 'test.broken', success: false }])
		expect(ended).toEqual(['test.broken'])
	})

	test('a consumer stopping early completes the stream', async () => {
		const stream = await call(ticks, undefined, { context: {} })
		expect((await stream.next()).value).toBe(1)
		await stream.return(undefined)
		expect(events).toMatchObject([{ name: 'test.ticks', success: true }])
		expect(ended).toEqual(['test.ticks'])
	})
})

describe('stream steps run inside their span', async () => {
	const { AsyncLocalStorage } = await import('node:async_hooks')
	type FakeSpan = { name: string; parent: string | undefined }
	const storage = new AsyncLocalStorage<FakeSpan>()
	const spans: FakeSpan[] = []
	const tracingOtel = {
		...otel,
		context: {
			active: () => storage.getStore(),
			with: <T>(context: FakeSpan, fn: () => T) => storage.run(context, fn)
		},
		trace: {
			getTracer: () => ({
				startActiveSpan: (
					name: string,
					_options: unknown,
					run: (span: unknown) => unknown
				) => {
					const span = { name, parent: storage.getStore()?.name }
					spans.push(span)
					return storage.run(span, () =>
						run({
							setAttribute() {},
							setStatus() {},
							recordException() {},
							end() {}
						})
					)
				},
				startSpan: () => ({})
			})
		}
	} as unknown as typeof otel

	test('a nested call inside a stream is a child of the stream span', async () => {
		const { fn } = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
			otel: tracingOtel
		})
		const inner = fn({ name: 'inner', handler: () => 1 })
		const outer = fn({
			name: 'outer',
			stream: true,
			handler: async function* ({ call }) {
				yield 0
				await Bun.sleep(1)
				yield await call(inner, undefined)
			}
		})
		const stream = await call(outer, undefined)
		const values: unknown[] = []
		for await (const value of stream) values.push(value)
		expect(values).toEqual([0, 1])
		expect(
			spans.map(({ name, parent }) => `${parent ?? '-'} > ${name}`)
		).toEqual(['- > outer', 'outer > call: inner', 'call: inner > inner'])
	})
})
