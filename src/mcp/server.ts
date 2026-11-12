import type { CallToolResult, Server } from '@modelcontextprotocol/server'
import type { AnyRouter } from '@orpc/server'
import {
	createToolHandlers,
	formatMcpResult,
	type McpCallOptions,
	type PreparedMcpTools,
	prepareMcpTools,
	type RegisterMcpToolsOptions as CoreOptions
} from './core.js'

export { formatMcpResult, prepareMcpTools, type PreparedMcpTools }

export type RegisterMcpToolsOptions<R extends AnyRouter> = CoreOptions<
	R,
	CallToolResult
>

/** Options for registering tools from {@link prepareMcpTools}. */
export type RegisterPreparedMcpToolsOptions<R extends AnyRouter> =
	McpCallOptions<R, CallToolResult>

/**
 * Register on the SDK v2 (`@modelcontextprotocol/server`) low-level Server, or
 * on McpServer.server. Declare `capabilities: { tools: {} }` on the Server.
 */
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	tools: PreparedMcpTools<R>,
	options: RegisterPreparedMcpToolsOptions<R>
): readonly string[]
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	router: R,
	options: RegisterMcpToolsOptions<R>
): readonly string[]
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	source: R | PreparedMcpTools<R>,
	options: RegisterPreparedMcpToolsOptions<R> &
		Partial<RegisterMcpToolsOptions<R>>
): readonly string[] {
	const handlers = createToolHandlers(source, options)
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
