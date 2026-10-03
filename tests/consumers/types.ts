// Type tests run against the packed package (NodeNext and Bundler resolution).
import type { InferToolInput, InferToolOutput } from '@mastra/core/tools'
import * as otel from '@opentelemetry/api'
import {
	type InferRouterInputs,
	type InferRouterOutputs,
	ORPCError,
	os
} from '@orpc/server'
import {
	createFn,
	type FnLogger,
	readFnMeta,
	isExpectedClientError
} from 'orpc-fn'
import {
	type FnLivePatch,
	fnLivePatch,
	type PubSubTransport,
	streamLiveSnapshots
} from 'orpc-fn/live'
import { createMastraTool } from 'orpc-fn/mastra'
import { hasTag, listTools } from 'orpc-fn/mcp'
import { mountOrpc } from 'orpc-fn/hono'
import { createRpcLink, hasOrpcErrorCode } from 'orpc-fn/client'
import { createExpoLink } from 'orpc-fn/expo'
import { createORPCClient } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { ioredisTransport } from 'orpc-fn/live/ioredis'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun'
import { memoryTransport } from 'orpc-fn/live/memory'
import { Hono } from 'hono'
import { z } from 'zod'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false
type Assert<T extends true> = T

type User = { id: string; locale: string; flags: string[] }
type PublicContext = { headers?: Headers; user?: User }
type Translate = (key: string) => string
type AppLogger = FnLogger & { child(scope: string): AppLogger }
declare const appLogger: AppLogger

const base = os.$context<PublicContext>()
const authed = base.use(({ context, next }) => {
	if (!context.user) throw new ORPCError('UNAUTHORIZED')
	return next({ context: { user: context.user } })
})

const { fn, fnLive, createPubSub, readMeta } = createFn({
	procedures: { public: base, protected: authed },
	default: 'protected',
	tags: ['internal', 'external'],
	meta: {} as { readOnly?: boolean; risk?: 'low' | 'high' },
	otel,
	logger: (_scope, span) => {
		// The logger factory receives the real OpenTelemetry span type.
		const typed: otel.Span | undefined = span
		void typed
		return appLogger
	},
	extras: ({ context }) => ({
		db: { query: (sql: string) => [sql] },
		t: context.user ? (((key) => key) as Translate) : undefined
	}),
	guards: {
		neededFeatureFlags: (flags: string[], { context }) => {
			// Guards see the union of every procedure's context.
			const user: User | undefined = context.user
			if (!flags.every((flag) => user?.flags.includes(flag))) {
				throw new ORPCError('FORBIDDEN')
			}
		},
		permission: (_requirement: {
			resource: string
			action: 'read' | 'write'
		}) => {}
	},
	spanAttributes: ({ context }) => ({ 'user.id': context.user?.id }),
	onCompleted: ({ durationMs }) => ({ slow: durationMs > 1000 }),
	isExpectedError: (error) => isExpectedClientError(error),
	pubsub: { transport: memoryTransport() }
})

// ── Context narrowing per procedure ─────────────────────────────────────────
fn({
	name: 'protected.default',
	handler: ({ context }) => {
		const user: User = context.user
		return user.id
	}
})
fn({
	name: 'public.explicit',
	procedure: 'public',
	handler: ({ context }) => {
		// @ts-expect-error user is optional on the public builder
		const user: User = context.user
		return user
	}
})
fn({
	name: 'unknown.procedure',
	// @ts-expect-error only configured procedure keys
	procedure: 'admin',
	handler: () => null
})

// ── Guard, meta and tag option typing ───────────────────────────────────────
fn({
	name: 'guarded',
	neededFeatureFlags: ['beta'],
	permission: { resource: 'orders', action: 'write' },
	readOnly: true,
	risk: 'high',
	tags: ['external'],
	handler: () => null
})
// @ts-expect-error flags are strings
fn({ name: 'badFlags', neededFeatureFlags: [1], handler: () => null })
// biome-ignore format: the expected error must stay on one line
// @ts-expect-error action is 'read' | 'write'
fn({ name: 'badPermission', permission: { resource: 'x', action: 'delete' }, handler: () => null })
// @ts-expect-error risk is 'low' | 'high'
fn({ name: 'badMeta', risk: 'medium', handler: () => null })
// @ts-expect-error tags come from createFn({ tags })
fn({ name: 'badTag', tags: ['public'], handler: () => null })
// @ts-expect-error name is required
fn({ handler: () => null })

// ── Extras, logger and span on params ───────────────────────────────────────
fn({
	name: 'params',
	handler: ({ db, t, logger, span, signal }) => {
		const rows: string[] = db.query('select 1')
		const translate: Translate | undefined = t
		const child: AppLogger = logger.child('x')
		const active: otel.Span | undefined = span
		const abort: AbortSignal | undefined = signal
		return { rows, translate, child, active, abort }
	}
})

// ── All four overloads ──────────────────────────────────────────────────────
const inOut = fn({
	name: 'inOut',
	input: z.object({ id: z.string() }),
	output: z.object({ ok: z.boolean() }),
	handler: ({ input }) => ({ ok: input.id.length > 0 })
})
const inOnly = fn({
	name: 'inOnly',
	input: z.object({ n: z.number() }),
	handler: ({ input }) => ({ doubled: input.n * 2 })
})
const outOnly = fn({
	name: 'outOnly',
	output: z.object({ status: z.literal('ok') }),
	handler: () => ({ status: 'ok' as const })
})
const neither = fn({ name: 'neither', handler: async () => ({ value: 42 }) })
const streaming = fn({
	name: 'streaming',
	handler: async function* () {
		yield { tick: 1 }
	}
})
// biome-ignore format: the expected error must stay on one line
// @ts-expect-error handler return must match the output schema
fn({ name: 'badOutput', output: z.object({ ok: z.boolean() }), handler: () => ({ ok: 'yes' }) })

const router = { inOut, inOnly, outOnly, neither, streaming }
type Inputs = InferRouterInputs<typeof router>
type Outputs = InferRouterOutputs<typeof router>
export type Overloads = [
	Assert<Equal<Inputs['inOut'], { id: string }>>,
	Assert<Equal<Outputs['inOut'], { ok: boolean }>>,
	Assert<Equal<Inputs['inOnly'], { n: number }>>,
	Assert<Equal<Outputs['inOnly'], { doubled: number }>>,
	Assert<Equal<Inputs['outOnly'], unknown>>,
	Assert<Equal<Outputs['outOnly'], { status: 'ok' }>>,
	Assert<Equal<Outputs['neither'], { value: number }>>,
	Assert<
		Outputs['streaming'] extends AsyncIterable<{ tick: number }> ? true : false
	>
]

// ── Bound call: input and output inference ──────────────────────────────────
fn({
	name: 'caller',
	handler: async ({ call }) => {
		const result = await call(inOnly, { n: 2 })
		const doubled: number = result.doubled
		// @ts-expect-error n must be a number
		await call(inOnly, { n: '2' })
		// @ts-expect-error result has no `tripled`
		result.tripled
		return doubled
	}
})

// ── Meta ────────────────────────────────────────────────────────────────────
const readOnly: boolean | undefined = readMeta(inOut).meta.readOnly
const name: string | undefined = readFnMeta(inOut).name
void [readOnly, name]

// ── Live ────────────────────────────────────────────────────────────────────
const events = createPubSub({
	name: 'events',
	procedure: 'public',
	channel: ({ room }) => `room:${room}`,
	inputSchema: z.object({ room: z.string() }),
	eventSchema: z.object({ room: z.string(), text: z.string() }),
	authFn: ({ ctx }) => {
		// @ts-expect-error public context: user may be missing
		const id: string = ctx.user.id
		return id.length > 0
	}
})
events.publish({ room: 'a', text: 'hi' })
events.publishMany([{ room: 'a', text: 'hi' }])
// @ts-expect-error text is required
events.publish({ room: 'a' })
createPubSub({
	name: 'protectedEvents',
	channel: 'x',
	inputSchema: z.object({}),
	eventSchema: z.object({}),
	authFn: ({ ctx }) => ctx.user.id.length > 0
})

const list = fnLive({
	name: 'list',
	input: z.object({ org: z.string() }),
	handler: ({ input, context }) => ({ org: input.org, by: context.user.id }),
	live: {
		eventSchema: z.object({ org: z.string() }),
		channel: ({ org }) => `org:${org}`,
		transformerFn: ({ previous, event }) =>
			previous ? fnLivePatch(previous, { touched: event.org }) : undefined
	}
})
type LiveOutputs = InferRouterOutputs<{ list: typeof list.procedure }>
export type LiveOutput = Assert<
	Equal<LiveOutputs['list'], { org: string; by: string }>
>
type LiveItem =
	InferRouterOutputs<{ s: typeof list.subscribe }>['s'] extends AsyncIterable<
		infer U
	>
		? U
		: never
export type LiveStream = Assert<
	Equal<LiveItem, { org: string; by: string } | { touched: string }>
>
list.publish({ org: 'a' })
const patch: FnLivePatch<number, string> = fnLivePatch(1, 'x')
void [patch, streamLiveSnapshots]

// ── Transports ──────────────────────────────────────────────────────────────
declare const bunClient: import('orpc-fn/live/redis-bun').BunRedisClientLike
declare const ioClient: import('orpc-fn/live/ioredis').IORedisLike
const transports: PubSubTransport[] = [
	memoryTransport(),
	bunRedisTransport(bunClient),
	ioredisTransport(ioClient)
]
void transports

// ── Adapters ────────────────────────────────────────────────────────────────
const tool = createMastraTool(inOut)
export type ToolTypes = [
	// Raw procedure input in, parsed procedure output out.
	Assert<Equal<InferToolInput<typeof tool>, { id: string }>>,
	Assert<Equal<InferToolOutput<typeof tool>, { ok: boolean }>>
]
const stringInput = fn({
	name: 'stringInput',
	input: z.string(),
	handler: () => 1
})
// @ts-expect-error agent tools need an object input
createMastraTool(stringInput)
const tools = listTools(router, { filter: hasTag('external') })
const toolName: string | undefined = tools[0]?.name
void toolName
mountOrpc(new Hono(), {
	router,
	rpcPrefix: '/rpc',
	openapi: { prefix: '/api', filter: hasTag('external') },
	context: (c, { headers }) =>
		c.req.header('x-deny') ? new Response(null, { status: 401 }) : { headers }
})
mountOrpc(new Hono(), {
	router,
	rpcPrefix: '/rpc',
	// @ts-expect-error the factory must return the router's context
	context: () => ({ headers: 'not headers' })
})
const strict = os
	.$context<{ tenant: string }>()
	.handler(({ context }) => context.tenant)
// @ts-expect-error `context` is required when the base context is not enough
mountOrpc(new Hono(), { router: { strict }, rpcPrefix: '/rpc' })

// ── Client ──────────────────────────────────────────────────────────────────
const client: RouterClient<typeof router> = createORPCClient(
	createRpcLink({ url: 'http://localhost/rpc', batch: { maxSize: 10 } })
)
client.inOnly({ n: 1 }).then((result) => {
	const doubled: number = result.doubled
	void doubled
})
// @ts-expect-error input is typed from the server
client.inOnly({ n: '1' })
const isMissing: boolean = hasOrpcErrorCode(new Error('x'), 'NOT_FOUND')
void isMissing
// `expo/fetch`'s signature, so passing it type-checks.
declare const expoFetch: (
	input: string | URL | Request,
	init?: {
		body?: RequestInit['body']
		headers?: RequestInit['headers']
		method?: string
		signal?: AbortSignal | null
		credentials?: RequestInit['credentials']
		redirect?: RequestInit['redirect']
	}
) => Promise<Response>
createExpoLink<{ keepalive?: boolean }>({
	url: 'http://localhost/rpc',
	fetch: expoFetch,
	native: true,
	getCookie: () => null
})
createExpoLink({
	url: 'http://localhost/rpc',
	// @ts-expect-error a fetch must resolve to a response oRPC can read
	fetch: async () => ({ status: 200 }),
	native: true
})

// ── Transformed schemas ─────────────────────────────────────────────────────
const lengthOut = z.string().transform((value) => value.length)
const measured = fn({
	name: 'measured',
	input: z.object({ at: z.string().transform((value) => new Date(value)) }),
	output: lengthOut,
	handler: ({ input }) => input.at.toISOString()
})
export type Transformed = [
	Assert<Equal<InferRouterInputs<{ m: typeof measured }>['m'], { at: string }>>,
	Assert<Equal<InferRouterOutputs<{ m: typeof measured }>['m'], number>>
]
// biome-ignore format: the expected error must stay on one line
// @ts-expect-error the handler returns the output schema's input (string)
fn({ name: 'badMeasured', output: lengthOut, handler: () => 3 })
const transformedEvents = createPubSub({
	name: 'transformedEvents',
	channel: 'x',
	inputSchema: z.object({}),
	eventSchema: z.object({
		at: z.string().transform((value) => new Date(value))
	}),
	filterFn: ({ data }) => data.at instanceof Date
})
transformedEvents.publish({ at: '2026-01-01' })
// @ts-expect-error publish takes the event schema input
transformedEvents.publish({ at: new Date() })

// ── Context-checked calls ───────────────────────────────────────────────────
const tenantOnly = os
	.$context<{ tenant: string }>()
	.handler(({ context }) => context.tenant)
fn({
	name: 'callsTenant',
	handler: ({ call }) =>
		// @ts-expect-error the protected context has no tenant
		call(tenantOnly, undefined)
})
const { createCall } = createFn({
	procedures: { public: os },
	default: 'public'
})
createCall({ tenant: 't' })(tenantOnly, undefined)
// @ts-expect-error the context lacks tenant
createCall({})(tenantOnly, undefined)

// ── Option collisions ───────────────────────────────────────────────────────
createFn({
	procedures: { public: os },
	default: 'public',
	// @ts-expect-error `name` is a route option
	guards: { name: (_value: string) => {} }
})
createFn({
	procedures: { public: os },
	default: 'public',
	// @ts-expect-error `path` is a route option
	meta: {} as { path?: string }
})

// ── Extras ──────────────────────────────────────────────────────────────────
const asyncExtras = createFn({
	procedures: { public: os },
	default: 'public',
	extras: async () => ({ db: { ready: true as const } })
})
asyncExtras.fn({
	name: 'usesDb',
	handler: ({ db }) => {
		const ready: true = db.ready
		return ready
	}
})
createFn({
	procedures: { public: os },
	default: 'public',
	// @ts-expect-error extras need known keys
	extras: () => ({}) as Record<string, number>
})
