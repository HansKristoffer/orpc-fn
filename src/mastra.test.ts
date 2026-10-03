import { describe, test, expect } from 'bun:test'
import { RequestContext } from '@mastra/core/request-context'
import { z as zod } from 'zod'
import { fn } from '../tests/fixture.js'
import { createMastraTool } from './mastra.js'

const InputSchema = zod.object({
	userId: zod.string(),
	count: zod.number()
})

const OutputSchema = zod.object({
	success: zod.boolean(),
	message: zod.string()
})

const testProcedureWithSchemas = fn({
	name: 'test.withSchemas',
	method: 'GET',
	procedure: 'public',
	input: InputSchema,
	output: OutputSchema,
	handler: async ({ input }) => {
		return { success: true, message: `User ${input.userId}` }
	}
})

// Tool created with createMastraTool using defaults (no id/description override)
const defaultsProcedure = fn({
	name: 'Test.With:Weird',
	method: 'GET',
	procedure: 'public',
	summary: 'Default description from route summary',
	input: InputSchema,
	handler: async ({ input }) => {
		return { success: true, message: `User ${input.userId}` }
	}
})

const wrappedToolWithDefaults = createMastraTool(defaultsProcedure)

const noInputProcedure = fn({
	name: 'test.noInput',
	method: 'GET',
	procedure: 'public',
	output: OutputSchema,
	handler: async () => {
		return { success: true, message: 'ok' }
	}
})

const supportProcedure = fn({
	name: 'test.supportContext',
	method: 'POST',
	procedure: 'support',
	input: zod.object({ echo: zod.string() }),
	output: zod.object({
		echo: zod.string(),
		sessionId: zod.string(),
		organizationId: zod.string()
	}),
	handler: async ({ input, context }) => {
		return {
			echo: input.echo,
			sessionId: context.support.sessionId,
			organizationId: context.support.organizationId
		}
	}
})

const wrappedSupportTool = createMastraTool(supportProcedure)

const executableSupportTool = wrappedSupportTool as unknown as {
	execute: (
		input: { echo: string },
		ctx: { requestContext?: RequestContext }
	) => Promise<{
		echo: string
		sessionId: string
		organizationId: string
	}>
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: Mastra's built-in inference works (regression)
// ═══════════════════════════════════════════════════════════════════════════

describe('createMastraTool runtime behavior', () => {
	test('defaults id from procedure name', () => {
		expect(wrappedToolWithDefaults.id).toBe('test-with-weird')
	})

	test('defaults description from route summary', () => {
		expect(wrappedToolWithDefaults.description).toBe(
			'Default description from route summary'
		)
	})

	test('throws when procedure has no input schema', () => {
		expect(() => createMastraTool(noInputProcedure)).toThrow('input schema')
	})

	test('passes support request context to support-aware procedures', async () => {
		const requestContext = new RequestContext()
		requestContext.set('orpcContext', {
			support: {
				sessionId: 'support-session-1',
				organizationId: 'organization-1'
			}
		})

		const output = await executableSupportTool.execute(
			{ echo: 'hello' },
			{ requestContext }
		)

		expect(output).toEqual({
			echo: 'hello',
			sessionId: 'support-session-1',
			organizationId: 'organization-1'
		})
	})

	test('throws a focused error when orpcContext is missing', async () => {
		await expect(
			executableSupportTool.execute({ echo: 'hello' }, {})
		).rejects.toThrow(
			'createMastraTool execution requires orpcContext in the Mastra request context'
		)
	})

	test('reports tool execution outcome and duration', async () => {
		const events: Array<{
			toolId: string
			durationMs: number
			outcome: 'success' | 'error'
		}> = []
		const tool = createMastraTool(testProcedureWithSchemas, {
			id: 'instrumented-tool',
			onExecuteFinish: (event) => events.push(event)
		}) as unknown as {
			execute: (
				input: zod.infer<typeof InputSchema>,
				ctx: { requestContext: RequestContext }
			) => Promise<zod.infer<typeof OutputSchema>>
		}
		const requestContext = new RequestContext()
		requestContext.set('orpcContext', {})

		await tool.execute({ userId: 'user-1', count: 1 }, { requestContext })

		expect(events).toHaveLength(1)
		expect(events[0]?.toolId).toBe('instrumented-tool')
		expect(events[0]?.outcome).toBe('success')
		expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
	})

	test('reads the oRPC context from a custom key', async () => {
		const tool = createMastraTool(supportProcedure, {
			contextKey: 'rpc'
		}) as unknown as typeof executableSupportTool
		const requestContext = new RequestContext()
		requestContext.set('rpc', {
			support: { sessionId: 's', organizationId: 'o' }
		})
		await expect(
			tool.execute({ echo: 'x' }, { requestContext })
		).resolves.toMatchObject({ sessionId: 's' })
	})

	test('allowMissingInputSchema exposes no-input procedures', () => {
		const tool = createMastraTool(noInputProcedure, {
			allowMissingInputSchema: true
		})
		expect(tool.id).toBe('test-noinput')
	})
})
