import {
	type AnyRouter,
	type InferRouterInitialContext,
	call
} from '@orpc/server'
import { isObjectJsonSchema } from '../json-schema.js'
import { listTools, type McpTool, type ProcedureFilter } from '../mcp.js'

/** Text-only tool result: the shape both MCP SDK majors accept. */
export type TextToolResult = {
	content: { type: 'text'; text: string }[]
	isError?: boolean
}

export type RegisterMcpToolsOptions<R extends AnyRouter, TResult> = {
	/** Tool exposure must be an explicit application choice. */
	filter: ProcedureFilter
	context: (request: {
		name: string
		signal: AbortSignal
	}) => InferRouterInitialContext<R> | Promise<InferRouterInitialContext<R>>
	readOnly?: ProcedureFilter
	name?: NonNullable<Parameters<typeof listTools>[1]>['name']
	formatResult?: (value: unknown, tool: McpTool) => TResult | Promise<TResult>
}

/** Default protocol result: JSON/text. Provide formatResult for other MCP content. */
export function formatMcpResult(value: unknown): TextToolResult {
	const text =
		typeof value === 'string'
			? value
			: (JSON.stringify(value, (_key, item) =>
					typeof item === 'bigint' ? item.toString() : item
				) ?? 'null')
	return { content: [{ type: 'text', text }] }
}

const errorResult = (text: string): TextToolResult => ({
	content: [{ type: 'text', text }],
	isError: true
})

/** @internal SDK-independent `tools/list` and `tools/call` behind both adapters. */
export function createToolHandlers<R extends AnyRouter, TResult>(
	router: R,
	options: RegisterMcpToolsOptions<R, TResult>
) {
	const definitions = listTools(router, {
		filter: options.filter,
		...(options.readOnly ? { readOnly: options.readOnly } : {}),
		...(options.name ? { name: options.name } : {})
	})
	const tools = new Map(definitions.map((tool) => [tool.name, tool]))
	const descriptions = definitions.map((tool) => {
		const inputSchema = tool.config.inputSchema?.[
			'~standard'
		].jsonSchema.input() ?? { type: 'object', properties: {} }
		if (!isObjectJsonSchema(inputSchema))
			throw new TypeError(
				`orpc-fn: MCP tool ${tool.name} needs an object input`
			)
		// MCP requires a top-level object; object unions retain their constraints.
		return {
			name: tool.name,
			...tool.config,
			inputSchema: { ...inputSchema, type: 'object' as const }
		}
	})
	return {
		names: [...tools.keys()] as readonly string[],
		list: () => ({ tools: descriptions }),
		call: async (
			name: string,
			args: Record<string, unknown> | undefined,
			signal: AbortSignal
		): Promise<TResult | TextToolResult> => {
			const tool = tools.get(name)
			if (!tool) return errorResult(`Unknown tool: ${name}`)
			try {
				signal.throwIfAborted()
				const validation = await tool.config.inputSchema?.[
					'~standard'
				].validate(args ?? {})
				if (validation?.issues)
					return errorResult(
						validation.issues.map((issue) => issue.message).join('; ')
					)
				const context = await options.context({ name: tool.name, signal })
				const result = await call(tool.procedure, validation?.value, {
					context,
					signal
				})
				return await (options.formatResult ?? formatMcpResult)(result, tool)
			} catch (error) {
				if (signal.aborted) throw error
				return errorResult(
					error instanceof Error ? error.message : String(error)
				)
			}
		}
	}
}
