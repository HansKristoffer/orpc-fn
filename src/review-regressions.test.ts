// Regressions from the TypeScript review: each test fails without its fix.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import {
	call,
	type InferRouterInputs,
	type InferRouterOutputs,
	os
} from '@orpc/server'
import { z } from 'zod'
import { createPubSub, fn, fnLive, quiet } from '../tests/fixture.js'
import { createFn } from './index.js'
import { memoryTransport } from './live/memory.js'

describe('#1 guard and meta keys cannot shadow route options', () => {
	test('a reserved guard name is a type error and throws', () => {
		expect(() =>
			createFn({
				procedures: { public: os },
				default: 'public',
				// @ts-expect-error `tags` is a route option
				guards: { tags: (_tags: string[]) => {} }
			})
		).toThrow('guard "tags" reuses a route option name')
	})

	test('a reserved meta key is a type error', () => {
		createFn({
			procedures: { public: os },
			default: 'public',
			// @ts-expect-error `summary` is a route option
			meta: {} as { summary?: string }
		})
	})

	test('a guard cannot share a name with a meta key', () => {
		createFn({
			procedures: { public: os },
			default: 'public',
			meta: {} as { readOnly?: boolean },
			// @ts-expect-error `readOnly` is already a meta key
			guards: { readOnly: (_value: boolean) => {} }
		})
	})
})

describe('#2 handlers return the output schema input', () => {
	const length = z.string().transform((value) => value.length)

	test('a transforming output schema types the handler by its input', async () => {
		const route = fn({
			name: 'review.length',
			procedure: 'public',
			output: length,
			handler: () => 'abc'
		})
		expect(await call(route, undefined, { context: {} })).toBe(3)
		expectTypeOf<
			InferRouterOutputs<{ route: typeof route }>['route']
		>().toEqualTypeOf<number>()
	})

	test('returning the transformed type is rejected', () => {
		// biome-ignore format: the expected error must stay on one line
		// @ts-expect-error the handler returns the schema input (string)
		fn({ name: 'review.badLength', procedure: 'public', output: length, handler: () => 3 })
	})
})

describe('#3 fnLive authorizes before sending the snapshot', () => {
	test('a refused subscriber never sees the initial snapshot', async () => {
		let snapshots = 0
		const secret = fnLive({
			name: 'review.secret',
			procedure: 'public',
			input: z.object({}),
			handler: () => {
				snapshots++
				return { secret: 'SECRET' }
			},
			live: {
				channel: 'review:secret',
				eventSchema: z.object({}),
				authFn: () => false
			}
		})
		const stream = await call(secret.subscribe, {}, { context: {} })
		await expect(stream.next()).rejects.toThrow(
			'You do not have access to this subscription'
		)
		expect(snapshots).toBe(0)
	})

	test('events published while the snapshot loads are delivered', async () => {
		let release = () => {}
		const loading = new Promise<void>((resolve) => {
			release = resolve
		})
		const counter = fnLive({
			name: 'review.counter',
			procedure: 'public',
			input: z.object({}),
			handler: async () => {
				await loading
				return { count: 0 }
			},
			live: {
				channel: 'review:counter',
				eventSchema: z.object({}),
				transformerFn: ({ previous }) => ({ count: (previous?.count ?? 0) + 1 })
			}
		})
		const stream = await call(counter.subscribe, {}, { context: {} })
		const first = stream.next()
		await Bun.sleep(10)
		await counter.publish({})
		release()
		expect((await first).value).toEqual({ count: 0 })
		expect((await stream.next()).value).toEqual({ count: 1 })
		await stream.return(undefined)
	})
})

describe('#4 fnLive parses input once and snapshots through the output schema', () => {
	const live = fnLive({
		name: 'review.numbers',
		procedure: 'public',
		input: z.object({ x: z.string().transform(Number) }),
		output: z.string().transform((value) => value.toUpperCase()),
		handler: ({ input }) => `n${input.x}`,
		live: { channel: 'review:numbers', eventSchema: z.object({}) }
	})

	test('transformed input reaches the subscribe handler once', async () => {
		const stream = await call(live.subscribe, { x: '2' }, { context: {} })
		expect((await stream.next()).value).toBe('N2')
		await stream.return(undefined)
	})

	test('the route and the stream agree on the output', async () => {
		expect(await call(live.procedure, { x: '2' }, { context: {} })).toBe('N2')
	})
})

describe('#5 call() checks the callee context', () => {
	test('a callee needing more context than the caller has is rejected', () => {
		const restricted = os
			.$context<{ admin: string }>()
			.handler(({ context }) => context.admin)
		fn({
			name: 'review.caller',
			procedure: 'public',
			handler: ({ call }) =>
				// @ts-expect-error the public context has no `admin`
				call(restricted, undefined)
		})
	})

	test('a callee whose context the caller satisfies is accepted', () => {
		const open = os.$context<{ headers?: Headers }>().handler(() => 1)
		fn({
			name: 'review.okCaller',
			handler: ({ call }) => call(open, undefined)
		})
	})
})

describe('#7 pub/sub publishes schema input and keeps non-JSON values', () => {
	const events = createPubSub({
		name: 'review.events',
		procedure: 'public',
		channel: 'review:events',
		inputSchema: z.object({}),
		eventSchema: z.object({ n: z.string().transform(Number), at: z.date() })
	})

	test('publish takes the input type; subscribers get the output', async () => {
		expectTypeOf<Parameters<typeof events.publish>[0]>().toEqualTypeOf<{
			n: string
			at: Date
		}>()
		const stream = await call(events.subscribe, {}, { context: {} })
		const next = stream.next()
		await Bun.sleep(10)
		await events.publish({ n: '2', at: new Date(0) })
		expect((await next).value).toEqual({ n: 2, at: new Date(0) })
		await stream.return(undefined)
	})
})

describe('#9 builders with schemas are rejected', () => {
	test('a builder output schema throws at createFn', () => {
		expect(() =>
			createFn({
				// @ts-expect-error a builder with a schema is not a BuilderLike
				procedures: { public: os.output(z.number()) },
				default: 'public'
			})
		).toThrow('procedure "public" sets an input or output schema')
	})
})

describe('#10 async extras are awaited', () => {
	test('handlers receive the resolved extras', async () => {
		const { fn } = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => quiet,
			extras: async () => ({ db: 42 })
		})
		const route = fn({ name: 'review.db', handler: ({ db }) => db + 1 })
		expect(await call(route, undefined)).toBe(43)
	})
})

describe('#11 extras: unions narrow, index signatures are rejected', () => {
	test('discriminated union extras narrow in the handler', () => {
		type Extras = { kind: 'a'; a: number } | { kind: 'b'; b: string }
		const { fn } = createFn({
			procedures: { public: os },
			default: 'public',
			extras: (): Extras => ({ kind: 'a', a: 1 })
		})
		fn({
			name: 'review.union',
			handler: (params) => (params.kind === 'a' ? params.a : params.b.length)
		})
	})

	test('an index signature is a type error', () => {
		createFn({
			procedures: { public: os },
			default: 'public',
			// @ts-expect-error extras need known keys
			extras: () => ({}) as Record<string, number>
		})
	})
})

describe('#12 pub/sub keeps the whole input schema', () => {
	test('catchall keys stay in the subscribe input', () => {
		const events = createPubSub({
			name: 'review.catchall',
			procedure: 'public',
			channel: 'x',
			inputSchema: z.object({ room: z.number() }).catchall(z.number()),
			eventSchema: z.object({})
		})
		type Input = InferRouterInputs<{ s: typeof events.subscribe }>['s']
		const input: Input = { room: 1, counter: 2 }
		void input
	})
})

describe('#16 a throwing filter does not starve other subscribers', () => {
	test('the next subscriber still receives the event', async () => {
		const transport = memoryTransport()
		const errors: string[] = []
		const { createPubSub } = createFn({
			procedures: { public: os },
			default: 'public',
			logger: () => ({
				...quiet,
				error: (message: string) => errors.push(message)
			}),
			pubsub: { transport }
		})
		const feed = createPubSub({
			name: 'review.filter',
			channel: 'review:filter',
			inputSchema: z.object({ bad: z.boolean() }),
			eventSchema: z.object({ n: z.number() }),
			filterFn: ({ input }) => {
				if (input.bad) throw new Error('sync filter')
				return true
			}
		})
		const abort = new AbortController()
		const bad = await call(
			feed.subscribe,
			{ bad: true },
			{ context: {}, signal: abort.signal }
		)
		const good = await call(feed.subscribe, { bad: false }, { context: {} })
		const badNext = bad.next()
		const goodNext = good.next()
		await Bun.sleep(10)
		await feed.publish({ n: 1 })
		expect((await goodNext).value).toEqual({ n: 1 })
		expect(errors).toContain('Error processing message')
		abort.abort()
		expect((await badNext).done).toBe(true)
		await good.return(undefined)
	})
})

describe('createCall', () => {
	test('calls procedures outside a handler with a given context', async () => {
		const { createCall, fn: appFn } = createFn({
			procedures: { public: os.$context<{ userId: string }>() },
			default: 'public',
			logger: () => quiet
		})
		const me = appFn({
			name: 'review.me',
			handler: ({ context }) => context.userId
		})
		expect(await createCall({ userId: 'u1' })(me, undefined)).toBe('u1')
		// @ts-expect-error the context lacks userId
		createCall({})(me, undefined)
	})
})

describe('#6 #13 Mastra tools parse once and are typed by the procedure', async () => {
	const { RequestContext } = await import('@mastra/core/request-context')
	const { createMastraTool } = await import('./mastra.js')
	type InferToolInput<T> = import('@mastra/core/tools').InferToolInput<T>
	type InferToolOutput<T> = import('@mastra/core/tools').InferToolOutput<T>

	const transforming = fn({
		name: 'review.transforming',
		procedure: 'public',
		input: z.object({ x: z.string().transform(Number) }),
		output: z.string().transform((value) => `${value}!`),
		handler: ({ input }) => `n${input.x}`
	})
	const tool = createMastraTool(transforming)
	const execute = tool.execute as unknown as (
		input: unknown,
		ctx: { requestContext: InstanceType<typeof RequestContext> }
	) => Promise<unknown>

	test('input and output transforms run once', async () => {
		const requestContext = new RequestContext()
		requestContext.set('orpcContext', {})
		expect(await execute({ x: '2' }, { requestContext })).toBe('n2!')
	})

	test('the tool takes raw input and returns parsed output', () => {
		expectTypeOf<InferToolInput<typeof tool>>().toEqualTypeOf<{ x: string }>()
		expectTypeOf<InferToolOutput<typeof tool>>().toEqualTypeOf<string>()
	})

	test('non-object input is a type error and throws', () => {
		const echo = fn({
			name: 'review.echo',
			procedure: 'public',
			input: z.string(),
			handler: ({ input }) => input
		})
		// @ts-expect-error agent tools need an object input
		expect(() => createMastraTool(echo)).toThrow('must take an object input')
	})
})

describe('#15 mountOrpc checks the context against the router', async () => {
	const { Hono } = await import('hono')
	const { mountOrpc } = await import('./hono.js')
	const required = os
		.$context<{ user: { id: string } }>()
		.handler(({ context }) => context.user.id)

	test('a router needing more than the base context requires a factory', () => {
		// @ts-expect-error `context` is required for this router
		mountOrpc(new Hono(), { router: { required }, rpcPrefix: '/rpc' })
	})

	test('the factory must return the router context (or a Response)', () => {
		mountOrpc(new Hono(), {
			router: { required },
			rpcPrefix: '/rpc',
			// @ts-expect-error 42 is not a context
			context: () => 42
		})
		mountOrpc(new Hono(), {
			router: { required },
			rpcPrefix: '/rpc',
			context: (c) =>
				c.req.header('x-user')
					? { user: { id: c.req.header('x-user') ?? '' } }
					: new Response('nope', { status: 401 })
		})
	})

	test('a router the base context satisfies needs no factory', () => {
		const open = os.$context<{ headers: Headers }>().handler(() => 1)
		mountOrpc(new Hono(), { router: { open }, rpcPrefix: '/rpc' })
	})
})
