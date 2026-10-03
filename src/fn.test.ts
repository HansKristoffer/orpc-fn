import { describe, test, expectTypeOf } from 'bun:test'
import type {
	InferRouterInputs as ORPCInferRouterInputs,
	InferRouterOutputs as ORPCInferRouterOutputs,
	RouterClient as ORPCRouterClient
} from '@orpc/server'
import { z } from 'zod'
import { createRouter, fn } from '../tests/fixture.js'

// ═══════════════════════════════════════════════════════════════════════════
// Test procedures for type testing
// ═══════════════════════════════════════════════════════════════════════════

// Procedure with input and output schema
const withInputOutput = fn({
	name: 'test.withInputOutput',
	method: 'POST',
	procedure: 'public',
	input: z.object({
		userId: z.string(),
		count: z.number()
	}),
	output: z.object({
		success: z.boolean(),
		message: z.string()
	}),
	handler: async ({ input }) => {
		return { success: true, message: `User ${input.userId}` }
	}
})

// Procedure with only input schema (inferred output)
const withInputOnly = fn({
	name: 'test.withInputOnly',
	method: 'GET',
	procedure: 'public',
	input: z.object({
		query: z.string()
	}),
	handler: async ({ input }) => {
		return { result: input.query.toUpperCase(), timestamp: Date.now() }
	}
})

// Procedure with only output schema (no input)
const withOutputOnly = fn({
	name: 'test.withOutputOnly',
	method: 'GET',
	procedure: 'public',
	output: z.object({
		status: z.literal('ok'),
		version: z.string()
	}),
	handler: async () => {
		return { status: 'ok' as const, version: '1.0.0' }
	}
})

// Procedure with no input or output schema (fully inferred)
const withNoSchema = fn({
	name: 'test.withNoSchema',
	method: 'GET',
	procedure: 'public',
	handler: async () => {
		return { inferred: true, value: 42 }
	}
})

// Protected procedure (requires auth)
const protectedProcedure = fn({
	name: 'test.protected',
	method: 'GET',
	procedure: 'protected', // requires auth
	input: z.object({ id: z.string() }),
	handler: async ({ input, context }) => {
		return { id: input.id, userEmail: context.user.email }
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// Test router
// ═══════════════════════════════════════════════════════════════════════════

const testRouter = createRouter({
	withInputOutput,
	withInputOnly,
	withOutputOnly,
	withNoSchema,
	protectedProcedure
})

// Nested router
const nestedRouter = createRouter({
	nested: createRouter({
		deep: withInputOutput
	}),
	flat: withInputOnly
})

// ═══════════════════════════════════════════════════════════════════════════
// Type Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('oRPC inference for fn procedures', () => {
	type RouterInputs = ORPCInferRouterInputs<typeof testRouter>
	type RouterOutputs = ORPCInferRouterOutputs<typeof testRouter>

	test('infers inputs for procedures with schemas', () => {
		expectTypeOf<RouterInputs['withInputOutput']>().toEqualTypeOf<{
			userId: string
			count: number
		}>()
		expectTypeOf<RouterInputs['withInputOnly']>().toEqualTypeOf<{
			query: string
		}>()
	})

	test('infers inputs for procedures without input schema', () => {
		expectTypeOf<RouterInputs['withOutputOnly']>().toEqualTypeOf<unknown>()
		expectTypeOf<RouterInputs['withNoSchema']>().toEqualTypeOf<unknown>()
	})

	test('infers outputs for procedures', () => {
		expectTypeOf<RouterOutputs['withInputOutput']>().toEqualTypeOf<{
			success: boolean
			message: string
		}>()
		expectTypeOf<RouterOutputs['withInputOnly']>().toEqualTypeOf<{
			result: string
			timestamp: number
		}>()
		expectTypeOf<RouterOutputs['withOutputOnly']>().toEqualTypeOf<{
			status: 'ok'
			version: string
		}>()
	})

	test('handles procedures without schemas', () => {
		expectTypeOf<RouterOutputs['withNoSchema']>().toEqualTypeOf<{
			inferred: boolean
			value: number
		}>()
	})

	test('respects protected procedure input/output', () => {
		expectTypeOf<RouterInputs['protectedProcedure']>().toEqualTypeOf<{
			id: string
		}>()
		expectTypeOf<RouterOutputs['protectedProcedure']>().toEqualTypeOf<{
			id: string
			userEmail: string
		}>()
	})
})

describe('nested router inference', () => {
	type NestedInputs = ORPCInferRouterInputs<typeof nestedRouter>
	type NestedOutputs = ORPCInferRouterOutputs<typeof nestedRouter>

	test('deeply nested routes infer correctly', () => {
		expectTypeOf<NestedInputs['nested']['deep']>().toEqualTypeOf<{
			userId: string
			count: number
		}>()
		expectTypeOf<NestedOutputs['nested']['deep']>().toEqualTypeOf<{
			success: boolean
			message: string
		}>()
	})

	test('flat routes are still inferred', () => {
		expectTypeOf<NestedInputs['flat']>().toEqualTypeOf<{ query: string }>()
		expectTypeOf<NestedOutputs['flat']>().toEqualTypeOf<{
			result: string
			timestamp: number
		}>()
	})
})

// Use a type with index signature to satisfy Record<string, unknown>
type TestClientContext = {
	apiKey?: string
	[key: string]: unknown
}

describe('RouterClient typing aligns with oRPC', () => {
	type Client = ORPCRouterClient<typeof testRouter, TestClientContext>

	test('procedure call has typed input', () => {
		type ProcedureCall = Client['withInputOutput']
		type InputParam = Parameters<ProcedureCall>[0]

		expectTypeOf<InputParam>().toEqualTypeOf<{
			userId: string
			count: number
		}>()
	})

	test('procedure call has typed output', () => {
		type ProcedureCall = Client['withInputOutput']
		type OutputType = Awaited<ReturnType<ProcedureCall>>

		expectTypeOf<OutputType>().toEqualTypeOf<{
			success: boolean
			message: string
		}>()
	})

	test('output-only procedures still have typed output', () => {
		type ProcedureCall = Client['withOutputOnly']
		type InputParam = Parameters<ProcedureCall>[0]
		type OutputType = Awaited<ReturnType<ProcedureCall>>

		expectTypeOf<InputParam>().toEqualTypeOf<unknown>()
		expectTypeOf<OutputType>().toEqualTypeOf<{
			status: 'ok'
			version: string
		}>()
	})

	test('procedures without schemas still have typed output (input stays unknown)', () => {
		type ProcedureCall = Client['withNoSchema']
		type InputParam = Parameters<ProcedureCall>[0]
		type OutputType = Awaited<ReturnType<ProcedureCall>>

		expectTypeOf<InputParam>().toEqualTypeOf<unknown>()
		expectTypeOf<OutputType>().toEqualTypeOf<{
			inferred: boolean
			value: number
		}>()
	})

	test('nested router clients are typed', () => {
		type NestedClient = ORPCRouterClient<typeof nestedRouter, TestClientContext>
		type DeepProcedure = NestedClient['nested']['deep']

		expectTypeOf<Parameters<DeepProcedure>[0]>().toEqualTypeOf<{
			userId: string
			count: number
		}>()
		expectTypeOf<Awaited<ReturnType<DeepProcedure>>>().toEqualTypeOf<{
			success: boolean
			message: string
		}>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Internal call() typing (BoundCall) regression
// ═══════════════════════════════════════════════════════════════════════════

const callCallee = fn({
	name: 'test.call.callee',
	method: 'GET',
	procedure: 'public',
	input: z.object({ subdata: z.string() }),
	output: z.object({ retfurn: z.string() }),
	handler: async ({ input }) => {
		return { retfurn: input.subdata }
	}
})

const callCaller = fn({
	name: 'test.call.caller',
	method: 'GET',
	procedure: 'public',
	input: z.object({}),
	handler: async ({ call }) => {
		const result = await call(callCallee, { subdata: '123' })
		const _retfurn: string = result.retfurn
		void _retfurn
		return result
	}
})

// Compile-time guard: if `call()` output becomes `unknown`, this will fail.
fn({
	name: 'test.call.typeErrors',
	method: 'GET',
	procedure: 'public',
	input: z.object({}),
	handler: async ({ call }) => {
		// @ts-expect-error subdata must be string
		await call(callCallee, { subdata: 123 })
		return { ok: true }
	}
})

describe('call() preserves typed return values', () => {
	const callRouter = createRouter({ callCaller })
	type CallOutputs = ORPCInferRouterOutputs<typeof callRouter>

	test('caller output is inferred from callee output', () => {
		expectTypeOf<CallOutputs['callCaller']>().toEqualTypeOf<{
			retfurn: string
		}>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Compile-time guardrails (negative tests)
// ═══════════════════════════════════════════════════════════════════════════

// Public contexts have optional user/session; ensure we don't accidentally make it required.
fn({
	name: 'test.publicContextGuards',
	method: 'GET',
	procedure: 'public',
	input: z.object({}),
	handler: ({ context }) => {
		// @ts-expect-error user is optional in public context
		const email = context.user.email
		return { email }
	}
})

fn({
	name: 'test.supportContextGuards',
	method: 'GET',
	procedure: 'support',
	input: z.object({}),
	handler: ({ context }) => {
		const { sessionId, organizationId } = context.support
		// @ts-expect-error support tools do not require a signed-in user
		const userEmail = context.user.email
		return { sessionId, organizationId, userEmail }
	}
})

// Output schema must match handler return type. Overload errors land on the
// call, so the whole call stays on one line.
// biome-ignore format: the expected error must stay on one line
// @ts-expect-error handler return must match output schema
fn({ name: 'test.outputTypeGuards', procedure: 'public', input: z.object({}), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: 'nope' }) })

// ═══════════════════════════════════════════════════════════════════════════
// Async Generator (streaming) Tests
// ═══════════════════════════════════════════════════════════════════════════

// Chunk type for streaming procedure
type StreamChunk = { chunk: string; index: number }

// Async generator procedure with input schema (streaming response)
const streamingProcedure = fn({
	name: 'test.streaming',
	method: 'POST',
	procedure: 'public',
	input: z.object({
		query: z.string(),
		count: z.number()
	}),
	handler: async function* ({ input }) {
		for (let i = 0; i < input.count; i++) {
			yield { chunk: `${input.query}-${i}`, index: i }
		}
	}
})

// Status chunk type for streaming without input
type StatusChunk = { status: string }

// Async generator with no input
const streamingNoInput = fn({
	name: 'test.streamingNoInput',
	method: 'GET',
	procedure: 'public',
	handler: async function* () {
		yield { status: 'starting' }
		yield { status: 'processing' }
		yield { status: 'done' }
	}
})

// Protected streaming chunk types
type ThreadChunk = { threadId: string; userId: string }
type MessageChunk = { message: string }
type ProtectedStreamChunk = ThreadChunk | MessageChunk

// Protected async generator procedure
const protectedStreaming = fn({
	name: 'test.protectedStreaming',
	method: 'POST',
	procedure: 'protected',
	input: z.object({ threadId: z.string() }),
	handler: async function* ({ input, context }) {
		yield { threadId: input.threadId, userId: context.user.id }
		yield { message: 'Hello from stream' }
	}
})

const streamingRouter = createRouter({
	streamingProcedure,
	streamingNoInput,
	protectedStreaming
})

describe('async generator (streaming) procedures', () => {
	type StreamInputs = ORPCInferRouterInputs<typeof streamingRouter>
	type StreamOutputs = ORPCInferRouterOutputs<typeof streamingRouter>

	test('infers inputs for streaming procedures', () => {
		expectTypeOf<StreamInputs['streamingProcedure']>().toEqualTypeOf<{
			query: string
			count: number
		}>()
		expectTypeOf<StreamInputs['streamingNoInput']>().toEqualTypeOf<unknown>()
		expectTypeOf<StreamInputs['protectedStreaming']>().toEqualTypeOf<{
			threadId: string
		}>()
	})

	test('infers async generator output for streaming procedures', () => {
		// oRPC infers the full AsyncGenerator type, not just the yielded value
		expectTypeOf<StreamOutputs['streamingProcedure']>().toMatchTypeOf<
			AsyncGenerator<StreamChunk>
		>()
	})

	test('streaming without input has async generator output', () => {
		expectTypeOf<StreamOutputs['streamingNoInput']>().toMatchTypeOf<
			AsyncGenerator<StatusChunk>
		>()
	})

	test('protected streaming has async generator with union yield type', () => {
		expectTypeOf<StreamOutputs['protectedStreaming']>().toMatchTypeOf<
			AsyncGenerator<ProtectedStreamChunk>
		>()
	})
})

describe('streaming RouterClient typing', () => {
	type StreamClient = ORPCRouterClient<
		typeof streamingRouter,
		TestClientContext
	>

	test('streaming procedure call has typed input', () => {
		type ProcedureCall = StreamClient['streamingProcedure']
		type InputParam = Parameters<ProcedureCall>[0]

		expectTypeOf<InputParam>().toEqualTypeOf<{
			query: string
			count: number
		}>()
	})

	test('streaming procedure returns async generator', () => {
		type ProcedureCall = StreamClient['streamingProcedure']
		type OutputType = Awaited<ReturnType<ProcedureCall>>

		// oRPC exposes the AsyncGenerator type
		expectTypeOf<OutputType>().toMatchTypeOf<AsyncGenerator<StreamChunk>>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Discriminated Union Input Tests
// ═══════════════════════════════════════════════════════════════════════════

const DiscriminatedCreateSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('organization'),
		organizationId: z.string(),
		name: z.string()
	}),
	z.object({
		type: z.literal('group'),
		groupId: z.string(),
		name: z.string()
	})
])

type DiscriminatedCreateInput = z.infer<typeof DiscriminatedCreateSchema>

const discriminatedProcedure = fn({
	name: 'test.discriminated',
	method: 'POST',
	procedure: 'public',
	input: DiscriminatedCreateSchema,
	handler: async ({ input }) => {
		if (input.type === 'organization') {
			return { created: 'org', id: input.organizationId }
		}
		return { created: 'group', id: input.groupId }
	}
})

const discriminatedWithOutput = fn({
	name: 'test.discriminatedWithOutput',
	method: 'POST',
	procedure: 'public',
	input: DiscriminatedCreateSchema,
	output: z.object({
		created: z.enum(['org', 'group']),
		id: z.string()
	}),
	handler: async ({ input }) => {
		if (input.type === 'organization') {
			return { created: 'org' as const, id: input.organizationId }
		}
		return { created: 'group' as const, id: input.groupId }
	}
})

const discriminatedRouter = createRouter({
	discriminatedProcedure,
	discriminatedWithOutput
})

describe('discriminated union input support', () => {
	type DiscriminatedInputs = ORPCInferRouterInputs<typeof discriminatedRouter>
	type DiscriminatedOutputs = ORPCInferRouterOutputs<typeof discriminatedRouter>

	test('infers discriminated union input correctly', () => {
		expectTypeOf<DiscriminatedInputs['discriminatedProcedure']>().toEqualTypeOf<
			| { type: 'organization'; organizationId: string; name: string }
			| { type: 'group'; groupId: string; name: string }
		>()
	})

	test('infers discriminated union input with output schema', () => {
		expectTypeOf<
			DiscriminatedInputs['discriminatedWithOutput']
		>().toEqualTypeOf<
			| { type: 'organization'; organizationId: string; name: string }
			| { type: 'group'; groupId: string; name: string }
		>()
	})

	test('infers output for discriminated union procedure', () => {
		expectTypeOf<
			DiscriminatedOutputs['discriminatedProcedure']
		>().toEqualTypeOf<{ created: string; id: string }>()
	})

	test('infers explicit output schema for discriminated union procedure', () => {
		expectTypeOf<
			DiscriminatedOutputs['discriminatedWithOutput']
		>().toEqualTypeOf<{ created: 'org' | 'group'; id: string }>()
	})
})

describe('discriminated union RouterClient typing', () => {
	type DiscriminatedClient = ORPCRouterClient<
		typeof discriminatedRouter,
		TestClientContext
	>

	test('discriminated procedure call has typed union input', () => {
		type ProcedureCall = DiscriminatedClient['discriminatedProcedure']
		type InputParam = Parameters<ProcedureCall>[0]

		expectTypeOf<InputParam>().toEqualTypeOf<DiscriminatedCreateInput>()
	})

	test('discriminated procedure has typed output', () => {
		type ProcedureCall = DiscriminatedClient['discriminatedWithOutput']
		type OutputType = Awaited<ReturnType<ProcedureCall>>

		expectTypeOf<OutputType>().toEqualTypeOf<{
			created: 'org' | 'group'
			id: string
		}>()
	})
})

// Compile-time guard: discriminated union narrowing works in handler
fn({
	name: 'test.discriminatedNarrowing',
	method: 'POST',
	procedure: 'public',
	input: DiscriminatedCreateSchema,
	handler: async ({ input }) => {
		if (input.type === 'organization') {
			const orgId: string = input.organizationId
			// @ts-expect-error groupId does not exist on organization variant
			const _badAccess = input.groupId
			return { orgId }
		}
		const groupId: string = input.groupId
		// @ts-expect-error organizationId does not exist on group variant
		const _badAccess = input.organizationId
		return { groupId }
	}
})

// ═══════════════════════════════════════════════════════════════════════════
// Zod Union (non-discriminated) Tests
// ═══════════════════════════════════════════════════════════════════════════

const UnionSchema = z.union([
	z.object({ kind: z.literal('a'), valueA: z.number() }),
	z.object({ kind: z.literal('b'), valueB: z.string() })
])

const unionProcedure = fn({
	name: 'test.union',
	method: 'POST',
	procedure: 'public',
	input: UnionSchema,
	handler: async ({ input }) => {
		if (input.kind === 'a') {
			return { result: input.valueA * 2 }
		}
		return { result: input.valueB.length }
	}
})

describe('regular union input support', () => {
	const unionRouter = createRouter({ unionProcedure })
	type UnionInputs = ORPCInferRouterInputs<typeof unionRouter>

	test('infers union input correctly', () => {
		expectTypeOf<UnionInputs['unionProcedure']>().toEqualTypeOf<
			{ kind: 'a'; valueA: number } | { kind: 'b'; valueB: string }
		>()
	})
})

// ═══════════════════════════════════════════════════════════════════════════
// Zod with Refinements Tests
// ═══════════════════════════════════════════════════════════════════════════

const RefinedSchema = z
	.object({
		password: z.string(),
		confirmPassword: z.string()
	})
	.refine((data) => data.password === data.confirmPassword, {
		message: 'Passwords must match'
	})

const refinedProcedure = fn({
	name: 'test.refined',
	method: 'POST',
	procedure: 'public',
	input: RefinedSchema,
	handler: async ({ input }) => {
		return { passwordSet: input.password.length > 0 }
	}
})

describe('refined schema input support', () => {
	const refinedRouter = createRouter({ refinedProcedure })
	type RefinedInputs = ORPCInferRouterInputs<typeof refinedRouter>

	test('infers refined schema input correctly', () => {
		expectTypeOf<RefinedInputs['refinedProcedure']>().toEqualTypeOf<{
			password: string
			confirmPassword: string
		}>()
	})
})
