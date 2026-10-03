import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import type { AnyRouter } from '@orpc/server'
import {
	createToolHandlers,
	formatMcpResult,
	type RegisterMcpToolsOptions as CoreOptions
} from './core.js'

export { formatMcpResult }

export type RegisterMcpToolsOptions<R extends AnyRouter> = CoreOptions<
	R,
	CallToolResult
>

/**
 * Register on the SDK v1 low-level Server, or on McpServer.server. For SDK v2
 * (`@modelcontextprotocol/server`) use `orpc-fn/mcp/server`.
 */
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	router: R,
	options: RegisterMcpToolsOptions<R>
): readonly string[] {
	const handlers = createToolHandlers(router, options)
	server.setRequestHandler(ListToolsRequestSchema, handlers.list)
	server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
		handlers.call(request.params.name, request.params.arguments, extra.signal)
	)
	return handlers.names
}
