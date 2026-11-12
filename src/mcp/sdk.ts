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
 * Register on the SDK v1 low-level Server, or on McpServer.server. For SDK v2
 * (`@modelcontextprotocol/server`) use `orpc-fn/mcp/server`.
 */
export function registerMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	router: R,
	options: RegisterMcpToolsOptions<R>
): readonly string[] {
	return install(
		server,
		createToolHandlers(prepareMcpTools(router, options), options)
	)
}

/** Register tools listed once with {@link prepareMcpTools}, e.g. on a server built per request. */
export function registerPreparedMcpTools<R extends AnyRouter>(
	server: Pick<Server, 'setRequestHandler'>,
	tools: PreparedMcpTools<R>,
	options: RegisterPreparedMcpToolsOptions<R>
): readonly string[] {
	return install(server, createToolHandlers(tools, options))
}

function install(
	server: Pick<Server, 'setRequestHandler'>,
	handlers: ReturnType<typeof createToolHandlers<AnyRouter, CallToolResult>>
): readonly string[] {
	server.setRequestHandler(ListToolsRequestSchema, handlers.list)
	server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
		handlers.call(request.params.name, request.params.arguments, extra.signal)
	)
	return handlers.names
}
