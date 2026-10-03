import type { RequestContext } from '@mastra/core/request-context'
import { createTool, type Tool } from '@mastra/core/tools'
import { type AnyProcedure, call } from '@orpc/server'
import {
	passThroughOutputSchema,
	rawInputSchema,
	type ToolSchema
} from './json-schema.js'
import { readFnMeta, toToolName } from './meta.js'
import type { ProcedureInput, ProcedureOutput } from './types.js'

export { toToolName }

export type CreateMastraToolOptions = {
	/** Override the tool id (defaults to the sanitized `fn` name). */
	id?: string
	/** Override the tool description (defaults to the route summary). */
	description?: string
	/** Gate execution behind the AI SDK tool-approval flow. */
	requireApproval?: boolean
	/**
	 * Accept a procedure without an input schema (the tool then takes an empty
	 * object). For no-input queries like `teams.list`.
	 */
	allowMissingInputSchema?: boolean
	onExecuteFinish?: (event: {
		toolId: string
		durationMs: number
		outcome: 'success' | 'error'
	}) => void
	/** Key holding the oRPC context in Mastra's `RequestContext`. Default 'orpcContext'. */
	contextKey?: string
}

/** What the tool takes: the procedure's raw input, or `{}` without a schema. */
export type MastraToolInput<TProc> =
	unknown extends ProcedureInput<TProc>
		? Record<string, never>
		: ProcedureInput<TProc>

/** A Mastra tool typed by the procedure's raw input and parsed output. */
export type MastraTool<TProc extends AnyProcedure> = Tool<
	MastraToolInput<TProc>,
	ProcedureOutput<TProc>
>

/** LLM tool parameters must be an object; other inputs are a type error. */
type ObjectInputCheck<TProc> =
	MastraToolInput<TProc> extends Record<string, unknown>
		? unknown
		: { 'orpc-fn: an agent tool needs an object input': ProcedureInput<TProc> }

/**
 * Creates a Mastra tool from a procedure made with `fn()`. Execution calls
 * the procedure with the oRPC context stored in the Mastra request context
 * (`requestContext.set('orpcContext', context)`), so auth and guards apply.
 *
 * Mastra checks the input against the procedure's schema (with dates coerced
 * from strings) but passes the raw input on, so the procedure parses it once;
 * the output is the procedure's parsed result, passed through unchanged.
 */
export function createMastraTool<TProc extends AnyProcedure>(
	procedure: TProc & ObjectInputCheck<TProc>,
	options: CreateMastraToolOptions = {}
): MastraTool<TProc> {
	const meta = readFnMeta(procedure)
	const name = options.id ?? meta.name
	if (!name) {
		throw new Error(
			'Procedure must be created with fn() to use createMastraTool'
		)
	}
	let inputSchema: ToolSchema | undefined
	if (meta.inputSchema) {
		inputSchema = rawInputSchema(meta.inputSchema)
		if (inputSchema['~standard'].jsonSchema.input().type !== 'object') {
			throw new Error(`${name} must take an object input to be an agent tool`)
		}
	} else if (!options.allowMissingInputSchema) {
		throw new Error(
			`${name} must declare an input schema to be exposed as an agent tool`
		)
	}

	const id = options.id ?? toToolName(name)
	const contextKey = options.contextKey ?? 'orpcContext'

	const tool = createTool({
		id,
		description: options.description ?? meta.description,
		requireApproval: options.requireApproval === true,
		inputSchema:
			inputSchema ??
			({
				'~standard': {
					version: 1,
					vendor: 'orpc-fn',
					validate: () => ({ value: {} }),
					jsonSchema: {
						input: () => ({ type: 'object', properties: {} }),
						output: () => ({ type: 'object', properties: {} })
					}
				}
			} satisfies ToolSchema),
		...(meta.outputSchema
			? { outputSchema: passThroughOutputSchema(meta.outputSchema) }
			: {}),
		execute: async (input, ctx) => {
			const requestContext = ctx?.requestContext as RequestContext | undefined
			const context = requestContext?.get(contextKey)
			if (!context) {
				throw new Error(
					`createMastraTool execution requires ${contextKey} in the Mastra request context`
				)
			}
			const startedAt = performance.now()
			const finish = (outcome: 'success' | 'error') =>
				options.onExecuteFinish?.({
					toolId: id,
					durationMs: performance.now() - startedAt,
					outcome
				})
			try {
				const result = await call(
					procedure,
					meta.inputSchema ? input : undefined,
					ctx?.abortSignal ? { context, signal: ctx.abortSignal } : { context }
				)
				finish('success')
				return result
			} catch (error) {
				finish('error')
				throw error
			}
		}
	})

	// The runtime schemas are untyped `ToolSchema`s; `MastraTool` is the typed surface.
	return tool as unknown as MastraTool<TProc>
}
