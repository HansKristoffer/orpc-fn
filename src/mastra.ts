import type { AnySchema, InferSchemaOutput } from '@orpc/contract'
import type { RequestContext } from '@mastra/core/request-context'
import { createTool, type Tool } from '@mastra/core/tools'
import type { AnyProcedure, Procedure } from '@orpc/server'
import { call } from '@orpc/server'
import { z as zod, type ZodObject, type ZodRawShape, type ZodType } from 'zod'
import { readFnMeta, toToolName } from './meta.js'

export { toToolName }

type InferProcedureOutput<TProc> =
	TProc extends Procedure<
		infer _TInitialContext,
		infer _TCurrentContext,
		infer _TInputSchema,
		infer TOutputSchema extends AnySchema,
		infer _TErrorMap,
		infer _TMeta
	>
		? InferSchemaOutput<TOutputSchema>
		: unknown

type ExtractInputSchema<T> = T extends { '~orpc': { inputSchema?: infer S } }
	? NonNullable<S> extends ZodType
		? NonNullable<S>
		: undefined
	: undefined

type ExtractOutputSchema<T> = T extends { '~orpc': { outputSchema?: infer S } }
	? NonNullable<S> extends ZodType
		? NonNullable<S>
		: undefined
	: undefined

type MastraInputSchema<TProc extends AnyProcedure> =
	ExtractInputSchema<TProc> extends ZodObject<ZodRawShape>
		? ExtractInputSchema<TProc>
		: ZodObject<ZodRawShape>

type MastraOutputSchema<TProc extends AnyProcedure> =
	ExtractOutputSchema<TProc> extends ZodType
		? ExtractOutputSchema<TProc>
		: zod.ZodType<InferProcedureOutput<TProc>>

export type CreateMastraToolOptions = {
	/** Override the tool id (defaults to the sanitized `fn` name). */
	id?: string
	/** Override the tool description (defaults to the route summary). */
	description?: string
	/** Gate execution behind the AI SDK tool-approval flow. */
	requireApproval?: boolean
	/**
	 * Use an empty object input schema when the procedure declares none
	 * (instead of throwing). For no-input queries like `teams.list`.
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

export type CreateMastraToolReturn<TProc extends AnyProcedure> = Tool<
	MastraInputSchema<TProc>,
	MastraOutputSchema<TProc>
>

function isZodSchema(schema: unknown): schema is ZodType {
	return (
		!!schema &&
		typeof schema === 'object' &&
		'_zod' in schema &&
		typeof (schema as { safeParse?: unknown }).safeParse === 'function'
	)
}

/**
 * Creates a Mastra tool from a procedure made with `fn()`. Execution calls
 * the procedure with the oRPC context stored in the Mastra request context
 * (`requestContext.set('orpcContext', context)`), so auth and guards apply.
 *
 * The returned tool keeps the types Mastra's `InferToolInput`,
 * `InferToolOutput` and `InferUITools` read.
 */
export function createMastraTool<TProc extends AnyProcedure>(
	procedure: TProc,
	options: CreateMastraToolOptions = {}
): CreateMastraToolReturn<TProc> {
	const meta = readFnMeta(procedure)
	const name = options.id ?? meta.name
	if (!name) {
		throw new Error(
			'Procedure must be created with fn() to use createMastraTool'
		)
	}
	const inputSchema =
		meta.inputSchema ??
		(options.allowMissingInputSchema ? zod.object({}) : undefined)
	if (!inputSchema) {
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
		inputSchema: inputSchema as MastraInputSchema<TProc>,
		outputSchema: (isZodSchema(meta.outputSchema)
			? meta.outputSchema
			: zod.any()) as unknown as MastraOutputSchema<TProc>,
		// biome-ignore lint/suspicious/noExplicitAny: Mastra's execute output type diverges from oRPC call() when output is inferred
		execute: async (input, ctx): Promise<any> => {
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
					input,
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

	return tool as unknown as CreateMastraToolReturn<TProc>
}
