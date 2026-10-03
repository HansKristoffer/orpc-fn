import type { CallToolResult, Server } from '@modelcontextprotocol/server'
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
 * Register on the SDK v2 (`@modelcontextprotocol/server`) low-level Server, or
 * on McpServer.server. Declare `capabilities: { tools: {} }` on the Server.
 */
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	router: R,
	options: RegisterMcpToolsOptions<R>
): readonly string[] {
	const handlers = createToolHandlers(router, options)
	server.setRequestHandler('tools/list', handlers.list)
	server.setRequestHandler('tools/call', (request, ctx) =>
		handlers.call(
			request.params.name,
			request.params.arguments,
			ctx.mcpReq.signal
		)
	)
	return handlers.names
}
