import {
	type AnyRouter,
	type InferRouterInitialContext,
	call
} from '@orpc/server'
import { formatIssue } from '../issues.js'
import { isObjectJsonSchema } from '../json-schema.js'
import { listTools, type McpTool, type ProcedureFilter } from '../mcp.js'
import { type ToolErrorOptions, toolErrorText } from '../tool-errors.js'

/** Text-only tool result: the shape both MCP SDK majors accept. */
export type TextToolResult = {
	content: { type: 'text'; text: string }[]
	isError?: boolean
}

/** Which procedures become tools, and their names and hints. */
export type McpToolSelection = {
	/** Tool exposure must be an explicit application choice. */
	filter: ProcedureFilter
	readOnly?: ProcedureFilter
	name?: NonNullable<Parameters<typeof listTools>[1]>['name']
}

/** How a registered tool is called and how its outcome reads. */
export type McpCallOptions<R extends AnyRouter, TResult> = ToolErrorOptions & {
	context: (request: {
		name: string
		signal: AbortSignal
	}) => InferRouterInitialContext<R> | Promise<InferRouterInitialContext<R>>
	formatResult?: (value: unknown, tool: McpTool) => TResult | Promise<TResult>
}

export type RegisterMcpToolsOptions<
	R extends AnyRouter,
	TResult
> = McpToolSelection & McpCallOptions<R, TResult>

type ToolDescription = Omit<McpTool['config'], 'inputSchema'> & {
	name: string
	inputSchema: Record<string, unknown> & { type: 'object' }
}

/** Tools listed and converted once, then registered per server or request. */
export type PreparedMcpTools<R extends AnyRouter> = {
	readonly router: R
	readonly names: readonly string[]
	readonly tools: readonly McpTool[]
	/** @internal The `tools/list` answer. */
	readonly descriptions: readonly ToolDescription[]
}

/**
 * List and convert a router's tools once, for an app that builds an MCP
 * server per request: `registerMcpTools(server, prepared, { context })`.
 */
export function prepareMcpTools<R extends AnyRouter>(
	router: R,
	options: McpToolSelection
): PreparedMcpTools<R> {
	const tools = listTools(router, {
		filter: options.filter,
		...(options.readOnly ? { readOnly: options.readOnly } : {}),
		...(options.name ? { name: options.name } : {})
	})
	const descriptions = tools.map((tool) => {
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
		router,
		names: tools.map((tool) => tool.name),
		tools,
		descriptions
	}
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

const isPrepared = <R extends AnyRouter>(
	source: R | PreparedMcpTools<R>
): source is PreparedMcpTools<R> =>
	'descriptions' in source && Array.isArray(source.descriptions)

/** @internal SDK-independent `tools/list` and `tools/call` behind both adapters. */
export function createToolHandlers<R extends AnyRouter, TResult>(
	source: R | PreparedMcpTools<R>,
	options: McpCallOptions<R, TResult> & Partial<McpToolSelection>
) {
	let prepared: PreparedMcpTools<R>
	if (isPrepared(source)) prepared = source
	else {
		if (typeof options.filter !== 'function')
			throw new TypeError(
				'orpc-fn: registerMcpTools needs a filter; tool exposure is an explicit choice'
			)
		prepared = prepareMcpTools(source, options as McpToolSelection)
	}
	const tools = new Map(prepared.tools.map((tool) => [tool.name, tool]))
	return {
		names: prepared.names,
		list: () => ({ tools: [...prepared.descriptions] }),
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
						[
							'BAD_REQUEST: Invalid tool input',
							...validation.issues.map(formatIssue)
						].join('\n')
					)
				const context = await options.context({ name: tool.name, signal })
				const result = await call(tool.procedure, validation?.value, {
					context,
					signal
				})
				return await (options.formatResult ?? formatMcpResult)(result, tool)
			} catch (error) {
				if (signal.aborted) throw error
				return errorResult(toolErrorText(error, tool.name, options))
			}
		}
	}
}
