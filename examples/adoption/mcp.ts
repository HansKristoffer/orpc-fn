import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerMcpTools } from 'orpc-fn/mcp/sdk'
import { router } from './core.js'

export function createExampleMcpServer() {
	const server = new Server(
		{ name: 'example', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	)
	registerMcpTools(server, router, {
		filter: ({ path }) => path.join('.') === 'get',
		context: () => ({})
	})
	return server
}
if (process.argv[1]?.endsWith('/mcp.ts'))
	await createExampleMcpServer().connect(new StdioServerTransport())
