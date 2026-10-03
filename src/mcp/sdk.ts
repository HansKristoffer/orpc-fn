import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import {
	type AnyRouter,
	type InferRouterInitialContext,
	call
} from '@orpc/server'
import { isObjectJsonSchema } from '../json-schema.js'
import { listTools, type McpTool, type ProcedureFilter } from '../mcp.js'

export type RegisterMcpToolsOptions<R extends AnyRouter> = {
	/** Tool exposure must be an explicit application choice. */
	filter: ProcedureFilter
	context: (request: {
		name: string
		signal: AbortSignal
	}) => InferRouterInitialContext<R> | Promise<InferRouterInitialContext<R>>
	readOnly?: ProcedureFilter
	name?: NonNullable<Parameters<typeof listTools>[1]>['name']
	formatResult?: (
		value: unknown,
		tool: McpTool
	) => CallToolResult | Promise<CallToolResult>
}

/** Default protocol result: JSON/text. Provide formatResult for other MCP content. */
export function formatMcpResult(value: unknown): CallToolResult {
	const text =
		typeof value === 'string'
			? value
			: (JSON.stringify(value, (_key, item) =>
					typeof item === 'bigint' ? item.toString() : item
				) ?? 'null')
	return { content: [{ type: 'text', text }] }
}

/** Register on the SDK's low-level Server, or on McpServer.server. */
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	router: R,
	options: RegisterMcpToolsOptions<R>
): readonly string[] {
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
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: descriptions
	}))
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = tools.get(request.params.name)
		if (!tool)
			return {
				content: [
					{ type: 'text', text: `Unknown tool: ${request.params.name}` }
				],
				isError: true
			}
		try {
			extra.signal.throwIfAborted()
			const validation = await tool.config.inputSchema?.['~standard'].validate(
				request.params.arguments ?? {}
			)
			if (validation?.issues)
				return {
					content: [
						{
							type: 'text',
							text: validation.issues.map((issue) => issue.message).join('; ')
						}
					],
					isError: true
				}
			const context = await options.context({
				name: tool.name,
				signal: extra.signal
			})
			const result = await call(tool.procedure, validation?.value, {
				context,
				signal: extra.signal
			})
			return await (options.formatResult ?? formatMcpResult)(result, tool)
		} catch (error) {
			if (extra.signal.aborted) throw error
			return {
				content: [
					{
						type: 'text',
						text: error instanceof Error ? error.message : String(error)
					}
				],
				isError: true
			}
		}
	})
	return [...tools.keys()]
}
