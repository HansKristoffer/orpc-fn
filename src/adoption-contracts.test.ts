import { expect, expectTypeOf, test } from 'bun:test'
import { call, eventIterator, ORPCError, os } from '@orpc/server'
import { z } from 'zod'
import {
	createFn,
	createStreamManifest,
	defineMeta,
	type OtelApiLike,
	readFnMeta
} from './index.js'
import { hasOrpcErrorCode } from './client.js'
import { createMastraTool } from './mastra.js'
import { listTools } from './mcp.js'
import { quiet } from '../tests/fixture.js'

test('false guards deny calls; invalid results fail types and runtime', async () => {
	let ran = false
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		guards: { allow: async (value: boolean) => value }
	})
	const route = factory.fn({
		name: 'denied',
		allow: false,
		handler: () => {
			ran = true
		}
	})
	await expect(call(route, undefined)).rejects.toMatchObject({
		code: 'FORBIDDEN'
	})
	expect(ran).toBe(false)
	const malformed = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet,
		// @ts-expect-error guard results are void or boolean, including inferred functions
		guards: { permission: () => 42 }
	})
	await expect(
		call(
			malformed.fn({
				name: 'bad',
				permission: undefined as never,
				handler: () => 1
			}),
			undefined
		)
	).resolves.toBe(1)
	// JS callers cannot silently grant access through invalid results.
	const bad = malformed.fn({
		name: 'badResult',
		permission: true as never,
		handler: () => 1
	})
	await expect(call(bad, undefined)).rejects.toThrow(
		'must return void or boolean'
	)
})

test('completion covers auth, input and output validation; telemetry cannot replace results', async () => {
	const outcomes: Array<{ success: boolean; handlerStarted: boolean }> = []
	const factory = createFn({
		procedures: {
			public: os,
			protected: os.use(() => {
				throw new ORPCError('UNAUTHORIZED')
			})
		},
		default: 'public',
		logger: () => ({
			...quiet,
			info: () => {
				throw new Error('logger broke')
			},
			warn: () => {
				throw new Error('warning broke')
			}
		}),
		spanAttributes: () => {
			throw new Error('attributes broke')
		},
		onCompleted: (event) => {
			outcomes.push(event)
			throw new Error('hook broke')
		}
	})
	const bad = factory.fn({
		name: 'badOutput',
		output: z.number().min(10),
		handler: () => 1
	})
	await expect(call(bad, undefined)).rejects.toThrow('Output validation failed')
	await expect(
		call(
			factory.fn({ name: 'badInput', input: z.number(), handler: () => 42 }),
			'x' as never
		)
	).rejects.toThrow('Input validation failed')
	await expect(
		call(
			factory.fn({ name: 'auth', procedure: 'protected', handler: () => 42 }),
			undefined
		)
	).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
	expect(
		await call(factory.fn({ name: 'good', handler: () => 42 }), undefined)
	).toBe(42)
	expect(
		outcomes.map(({ success, handlerStarted }) => [success, handlerStarted])
	).toEqual([
		[false, true],
		[false, false],
		[false, false],
		[true, true]
	])
})

test('native schemas, declared errors, resolvers and native metadata survive', async () => {
	const factory = createFn({
		procedures: {
			public: os
				.$meta<{ native: boolean }>({ native: true })
				.errors({ BASE: { data: z.string() } })
		},
		default: 'public',
		logger: () => quiet,
		guards: { permission: (id: string) => id === 'yes' }
	})
	const route = factory.fn({
		name: 'errors',
		input: z.object({ id: z.string() }),
		errors: { DOMAIN: { data: z.object({ id: z.string() }) } },
		guardResolvers: { permission: ({ input }) => input.id },
		handler: ({ errors, lastEventId }) => {
			expectTypeOf(lastEventId).toEqualTypeOf<string | undefined>()
			expectTypeOf(errors.BASE).toBeFunction()
			throw errors.DOMAIN({ data: { id: 'yes' } })
		}
	})
	expect(route['~orpc'].meta.native).toBe(true)
	await expect(call(route, { id: 'no' })).rejects.toMatchObject({
		code: 'FORBIDDEN'
	})
	await expect(call(route, { id: 'yes' })).rejects.toMatchObject({
		code: 'DOMAIN',
		data: { id: 'yes' }
	})
	const stream = factory.fn({
		name: 'watch',
		output: eventIterator(z.number().min(0)),
		handler: async function* () {
			yield -1
		}
	})
	const manifest = createStreamManifest({
		nested: { watch: stream, alias: stream },
		health: factory.fn({ name: 'health', handler: () => true })
	})
	expect(manifest).toEqual([
		['nested', 'watch'],
		['nested', 'alias']
	])
	const iterator = await call(stream, undefined)
	await expect(iterator.next()).rejects.toMatchObject({
		code: 'EVENT_ITERATOR_VALIDATION_FAILED'
	})
})

test('metadata follows the passed procedure across factories', () => {
	const a = createFn({
		procedures: { public: os },
		default: 'public',
		meta: defineMeta<{ risk?: 'low' | 'high' }>()
	})
	const b = createFn({
		procedures: { public: os },
		default: 'public',
		meta: defineMeta<{ risk?: number }>()
	})
	const route = b.fn({ name: 'foreign', meta: { risk: 123 }, handler: () => 1 })
	expectTypeOf(a.readMeta(route).meta.risk).toEqualTypeOf<number | undefined>()
	expect(a.readMeta(route).meta.risk).toBe(123)
	expect(readFnMeta(route).meta.risk).toBe(123)
	expect(() =>
		a.fn({ name: 'typo', handler: () => 1, ...{ summry: 'oops' } })
	).toThrow('unknown route option')
})

test('procedure-scoped extras and hooks retain context correlation', async () => {
	const base = os.$context<{ user?: string }>()
	const protectedBuilder = base.use(({ context, next }) => {
		if (!context.user) throw new ORPCError('UNAUTHORIZED')
		return next({ context: { user: context.user } })
	})
	const factory = createFn({
		procedures: { public: base, protected: protectedBuilder },
		default: 'protected',
		logger: () => quiet,
		extras: ({ procedure, context }) => {
			if (procedure === 'protected')
				expectTypeOf(context.user).toEqualTypeOf<string>()
			return { db: 42 }
		},
		extrasByProcedure: {
			protected: ({ context }) => ({
				translator: (key: string) => `${context.user}:${key}`
			})
		},
		onCompleted: (event) => {
			if (event.handlerStarted && event.procedure === 'protected')
				expectTypeOf(event.context.user).toEqualTypeOf<string>()
		}
	})
	const route = factory.fn({
		name: 'scoped',
		handler: ({ db, translator, call: nested }) => {
			expectTypeOf(db).toEqualTypeOf<number>()
			expectTypeOf(translator).toBeFunction()
			return nested(
				factory.fn({ name: 'nested', handler: () => translator('hi') })
			)
		}
	})
	expect(await call(route, undefined, { context: { user: 'alice' } })).toBe(
		'alice:hi'
	)
})

test('tool object unions work; collisions and streams fail clearly', () => {
	const { fn } = createFn({ procedures: { public: os }, default: 'public' })
	const union = fn({
		name: 'union',
		input: z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('a'), a: z.string() }),
			z.object({ kind: z.literal('b'), b: z.number() })
		]),
		handler: ({ input }) => input.kind
	})
	expect(createMastraTool(union)).toBeDefined()
	const first = fn({ name: 'order.get', handler: () => 1 })
	expect(listTools({ first, alias: first })).toHaveLength(1)
	expect(() =>
		listTools({ first, second: fn({ name: 'order-get', handler: () => 2 }) })
	).toThrow('collision')
	expect(() =>
		listTools({
			watch: fn({
				name: 'watch',
				stream: true,
				handler: async function* () {
					yield 1
				}
			})
		})
	).toThrow('streaming')
})

test('client error code is a real predicate', () => {
	const error: unknown = new ORPCError('NOT_FOUND')
	if (hasOrpcErrorCode(error, 'NOT_FOUND')) {
		expectTypeOf(error.code).toEqualTypeOf<'NOT_FOUND'>()
		expectTypeOf(error.data).toEqualTypeOf<unknown>()
	}
})

test('lazy stream manifests resolve actual prefixed router paths', async () => {
	const { lazy } = await import('@orpc/server')
	const { createStreamManifestAsync } = await import('./router.js')
	const { fn } = createFn({ procedures: { public: os }, default: 'public' })
	const watch = fn({
		name: 'lazy.watch',
		stream: true,
		handler: async function* () {
			yield 1
		}
	})
	const router = { feature: lazy(async () => ({ default: { watch } })) }
	expect(() => createStreamManifest(router)).toThrow('lazy routers')
	expect(await createStreamManifestAsync(router)).toEqual([
		['feature', 'watch']
	])
})

test('misdeclared streams fail and resume cursors reach native handlers', async () => {
	const { fn } = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet
	})
	await expect(
		call(
			fn({
				name: 'missingStreamDeclaration',
				handler: async function* () {
					yield 1
				}
			}),
			undefined
		)
	).rejects.toThrow('inconsistent with stream')
	await expect(
		call(
			fn({ name: 'wrongStreamDeclaration', stream: true, handler: () => 42 }),
			undefined
		)
	).rejects.toThrow('inconsistent with stream')
	const stream = await call(
		fn({
			name: 'cursor',
			stream: true,
			handler: async function* ({ lastEventId }) {
				yield lastEventId
			}
		}),
		undefined,
		{ lastEventId: 'resume-123' }
	)
	expect((await stream.next()).value).toBe('resume-123')
	await stream.return(undefined)
})

test('throwing telemetry keeps authoritative outcomes and runs stream steps once', async () => {
	const span = {
		setAttribute: () => {
			throw new Error('attributes')
		},
		setStatus: () => {
			throw new Error('status')
		},
		recordException: () => {
			throw new Error('exception')
		},
		end: () => {
			throw new Error('end')
		}
	}
	let steps = 0
	const lines: Array<Record<string, unknown> | undefined> = []
	const testOtel: OtelApiLike = {
		trace: {
			getTracer: () => ({
				startSpan: () => span,
				startActiveSpan: (_name, _options, run) => {
					run(span)
					throw new Error('trace after callback')
				}
			})
		},
		SpanKind: { INTERNAL: 0, SERVER: 1, PRODUCER: 2 },
		SpanStatusCode: { OK: 1, ERROR: 2 },
		context: {
			active: () => ({}),
			with: (_context, run) => {
				run()
				throw new Error('scope after callback')
			}
		}
	}
	const { fn } = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => ({
			...quiet,
			info: (_message, attributes) => {
				lines.push(attributes)
			}
		}),
		onCompleted: () => ({
			status: 'hijacked',
			operation: 'hijacked',
			duration_ms: -1
		}),
		otel: testOtel
	})
	const stream = await call(
		fn({
			name: 'telemetry',
			stream: true,
			handler: async function* () {
				steps++
				yield 42
			}
		}),
		undefined
	)
	expect((await stream.next()).value).toBe(42)
	expect((await stream.next()).done).toBe(true)
	expect(steps).toBe(1)
	expect(lines[0]).toMatchObject({ operation: 'telemetry', status: 'success' })
	expect(lines[0]?.duration_ms).toBeGreaterThanOrEqual(0)
	const original = new Error('handler failed')
	await expect(
		call(
			fn({
				name: 'failure',
				handler: () => {
					throw original
				}
			}),
			undefined
		)
	).rejects.toBe(original)
})

test('scoped extras replace shared keys in both handler types and values', async () => {
	const { fn } = createFn({
		procedures: { public: os, protected: os },
		default: 'public',
		logger: () => quiet,
		extras: () => ({ service: 'shared', retained: true }),
		extrasByProcedure: { protected: () => ({ service: 42 }) }
	})
	const route = fn({
		name: 'scopedOverride',
		procedure: 'protected',
		handler: ({ service, retained }) => {
			expectTypeOf(service).toEqualTypeOf<number>()
			expectTypeOf(retained).toEqualTypeOf<boolean>()
			return service
		}
	})
	expect(await call(route, undefined)).toBe(42)
})
