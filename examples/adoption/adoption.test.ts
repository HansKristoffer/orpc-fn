import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runCoreExample } from './core.js'
import { runTenantExample } from './tenant-live.js'
import { runRevisionExample } from './revisions.js'
import { runExpoExample } from './expo.js'
import { createExampleMcpServer } from './mcp.js'

test('independent adoption examples execute', async () => {
	expect(await runCoreExample()).toEqual({ id: '123', title: 'Example' })
	expect(await runTenantExample()).toEqual({ initial: 0, updated: 7 })
	expect(await runRevisionExample()).toEqual({
		initial: { total: 1, revision: 1 },
		recovered: { total: 4, revision: 3 }
	})
	expect(await runExpoExample()).toEqual({
		cookie: { cookie: 'session=abc', authorization: null },
		bearer: { cookie: null, authorization: 'Bearer abc' }
	})
	const server = createExampleMcpServer()
	const client = new Client({ name: 'example-client', version: '1' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await server.connect(b)
	await client.connect(a)
	try {
		expect(
			(await client.callTool({ name: 'item-get', arguments: { id: '123' } }))
				.content
		).toEqual([{ type: 'text', text: '{"id":"123","title":"Example"}' }])
	} finally {
		await client.close()
		await server.close()
	}
})
