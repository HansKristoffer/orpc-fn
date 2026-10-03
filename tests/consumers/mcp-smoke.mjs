import assert from 'node:assert/strict'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { os } from '@orpc/server'
import { z } from 'zod'
import { createFn } from 'orpc-fn'
import { registerMcpTools } from 'orpc-fn/mcp/sdk'

const { fn } = createFn({ procedures: { public: os }, default: 'public' })
const route = fn({ name: 'packed.date', input: z.object({ at: z.date() }), handler: ({ input }) => input.at.getUTCFullYear() })
const server = new Server({ name: 'packed', version: '1' }, { capabilities: { tools: {} } })
const client = new Client({ name: 'packed-client', version: '1' })
registerMcpTools(server, { route }, { filter: () => true, context: () => ({}) })
const [a, b] = InMemoryTransport.createLinkedPair()
await server.connect(b)
await client.connect(a)
try {
 assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['packed-date'])
 assert.deepEqual((await client.callTool({ name: 'packed-date', arguments: { at: '2026-10-03T00:00:00Z' } })).content, [{ type: 'text', text: '2026' }])
 console.log('Packed MCP SDK registration and invocation passed')
} finally { await client.close(); await server.close() }
