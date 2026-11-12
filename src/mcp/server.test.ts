import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/client'
import {
	InMemoryTransport,
	McpServer,
	Server
} from '@modelcontextprotocol/server'
import { os, ORPCError } from '@orpc/server'
import { z } from 'zod'
import { createFn } from '../index.js'
import { prepareMcpTools, registerMcpTools } from './server.js'
import { quiet } from '../../tests/fixture.js'

async function connect(server: Pick<Server, 'connect' | 'close'>) {
	const client = new Client({ name: 'test-client', version: '1' })
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	await client.connect(clientTransport)
	return client
}

test('MCP SDK v2 lists, validates, coerces, executes and cancels tools', async () => {
	const { fn } = createFn({
		procedures: { public: os.$context<{ user: string }>() },
		default: 'public',
		logger: () => quiet
	})
	const route = fn({
		name: 'dates.get',
		method: 'GET',
		input: z.object({ due: z.date(), n: z.string().transform(Number) }),
		handler: ({ input, context }) => ({
			year: input.due.getUTCFullYear(),
			n: input.n,
			user: context.user
		})
	})
	const deny = fn({
		name: 'deny',
		handler: () => {
			throw new ORPCError('FORBIDDEN')
		}
	})
	let started: (() => void) | undefined
	const waiting = new Promise<void>((resolve) => {
		started = resolve
	})
	let abortObserved: (() => void) | undefined
	const cancelled = new Promise<void>((resolve) => {
		abortObserved = resolve
	})
	const wait = fn({
		name: 'wait',
		handler: ({ signal }) =>
			new Promise<void>((_resolve, reject) => {
				started?.()
				signal?.addEventListener('abort', () => {
					abortObserved?.()
					reject(signal.reason)
				})
			})
	})
	const server = new Server(
		{ name: 'test', version: '1' },
		{ capabilities: { tools: {} } }
	)
	expect(
		registerMcpTools(
			server,
			{ route, deny, wait },
			{ filter: () => true, context: () => ({ user: 'alice' }) }
		)
	).toEqual(['dates-get', 'deny', 'wait'])
	const client = await connect(server)
	try {
		const { tools } = await client.listTools()
		expect(
			tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])
		).toEqual([
			['dates-get', true],
			['deny', false],
			['wait', false]
		])
		expect(
			(
				await client.callTool({
					name: 'dates-get',
					arguments: { due: '2026-10-03T00:00:00Z', n: '2' }
				})
			).content
		).toEqual([{ type: 'text', text: '{"year":2026,"n":2,"user":"alice"}' }])
		expect(
			(await client.callTool({ name: 'dates-get', arguments: {} })).isError
		).toBe(true)
		expect((await client.callTool({ name: 'deny' })).isError).toBe(true)
		expect((await client.callTool({ name: 'missing' })).isError).toBe(true)
		const abort = new AbortController()
		const request = client
			.callTool({ name: 'wait' }, { signal: abort.signal })
			.catch((error: unknown) => error)
		await waiting
		abort.abort()
		await request
		await cancelled
	} finally {
		await client.close()
		await server.close()
	}
})

test('MCP SDK v2 registration works through McpServer.server', async () => {
	const { fn } = createFn({ procedures: { public: os }, default: 'public' })
	const mcp = new McpServer(
		{ name: 'test', version: '1' },
		{ capabilities: { tools: {} } }
	)
	registerMcpTools(
		mcp.server,
		{ ping: fn({ name: 'ping', handler: () => 'pong' }) },
		{ filter: () => true, context: () => ({}) }
	)
	const client = await connect(mcp)
	try {
		expect((await client.callTool({ name: 'ping' })).content).toEqual([
			{ type: 'text', text: 'pong' }
		])
	} finally {
		await client.close()
		await mcp.close()
	}
})

test('MCP tools answer expected errors with code and fields, and hide the rest', async () => {
	const { fn } = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet
	})
	const routes = {
		create: fn({
			name: 'item.create',
			input: z.object({ item: z.object({ title: z.string() }) }),
			handler: () => 'ok'
		}),
		refuse: fn({
			name: 'item.refuse',
			handler: () => {
				throw new ORPCError('FORBIDDEN', { message: 'Not your vault' })
			}
		}),
		crash: fn({
			name: 'item.crash',
			handler: () => {
				throw new Error('connection to db-7 refused')
			}
		})
	}
	const reported: Array<[unknown, string]> = []
	const prepared = prepareMcpTools(routes, { filter: () => true })
	expect(prepared.names).toEqual(['item-create', 'item-refuse', 'item-crash'])
	const server = new Server(
		{ name: 'test', version: '1' },
		{ capabilities: { tools: {} } }
	)
	registerMcpTools(server, prepared, {
		context: () => ({}),
		onError: (error, { tool }) => reported.push([error, tool])
	})
	const client = await connect(server)
	const text = async (name: string, args?: Record<string, unknown>) =>
		(
			(await client.callTool({ name, arguments: args ?? {} })).content as {
				text: string
			}[]
		)[0]?.text
	try {
		expect(await text('item-create', { item: {} })).toBe(
			'BAD_REQUEST: Invalid tool input\nitem.title: Invalid input: expected string, received undefined'
		)
		expect(await text('item-refuse')).toBe('FORBIDDEN: Not your vault')
		expect(await text('item-crash')).toBe(
			'item-crash failed unexpectedly. The error was reported.'
		)
		expect(reported.map(([, tool]) => tool)).toEqual(['item-crash'])
	} finally {
		await client.close()
		await server.close()
	}
})
