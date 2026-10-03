import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { os, ORPCError } from '@orpc/server'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { createFn } from '../index.js'
import { registerMcpTools } from './sdk.js'
import { createMastraTool } from '../mastra.js'
import { quiet } from '../../tests/fixture.js'

test('actual MCP SDK lists, validates, coerces, executes and cancels tools', async () => {
	const { fn } = createFn({
		procedures: { public: os.$context<{ user: string }>() },
		default: 'public',
		logger: () => quiet
	})
	let parsed = 0
	let abortObserved: (() => void) | undefined
	const cancelled = new Promise<void>((resolve) => {
		abortObserved = resolve
	})
	const route = fn({
		name: 'dates.get',
		input: z.object({
			due: z.date(),
			n: z.string().transform((s) => {
				parsed++
				return Number(s)
			})
		}),
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
	const noInput = fn({ name: 'ping', handler: () => 'pong' })
	let started: (() => void) | undefined
	const waiting = new Promise<void>((resolve) => {
		started = resolve
	})
	const wait = fn({
		name: 'wait',
		handler: ({ signal }) =>
			new Promise<void>((_resolve, reject) => {
				started?.()
				signal?.addEventListener(
					'abort',
					() => {
						abortObserved?.()
						reject(signal.reason)
					},
					{ once: true }
				)
			})
	})
	const server = new Server(
		{ name: 'test', version: '1' },
		{ capabilities: { tools: {} } }
	)
	const client = new Client({ name: 'test-client', version: '1' })
	registerMcpTools(
		server,
		{ route, deny, noInput, wait },
		{ filter: () => true, context: () => ({ user: 'alice' }) }
	)
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	await client.connect(clientTransport)
	try {
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			'dates-get',
			'deny',
			'ping',
			'wait'
		])
		const result = await client.callTool({
			name: 'dates-get',
			arguments: { due: '2026-10-03T00:00:00Z', n: '2' }
		})
		expect(result.content).toEqual([
			{ type: 'text', text: '{"year":2026,"n":2,"user":"alice"}' }
		])
		expect(parsed).toBe(2) // Pure transforms validate twice; neither pass sees transformed input.
		expect(
			(await client.callTool({ name: 'dates-get', arguments: {} })).isError
		).toBe(true)
		expect((await client.callTool({ name: 'deny' })).isError).toBe(true)
		expect((await client.callTool({ name: 'ping' })).content).toEqual([
			{ type: 'text', text: 'pong' }
		])
		const abort = new AbortController()
		const request = client
			.callTool({ name: 'wait' }, undefined, { signal: abort.signal })
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

test('Mastra full input validation and execution preserves raw transforming input', async () => {
	const { fn } = createFn({
		procedures: { public: os },
		default: 'public',
		logger: () => quiet
	})
	let passes = 0
	const route = fn({
		name: 'union',
		input: z.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('count'),
				n: z.string().transform((n) => {
					passes++
					return Number(n)
				})
			}),
			z.object({ kind: z.literal('date'), due: z.date() })
		]),
		handler: ({ input }) =>
			input.kind === 'count' ? input.n + 1 : input.due.getUTCFullYear()
	})
	const tool = createMastraTool(route, {
		onExecuteFinish: () => {
			throw new Error('metrics failure')
		}
	})
	const context = new RequestContext()
	context.set('orpcContext', {})
	expect(
		await tool.execute?.(
			{ kind: 'count', n: '2' },
			{
				requestContext: context,
				observe: { span: async (_name, run) => run(), log: () => {} }
			}
		)
	).toBe(3)
	expect(passes).toBe(2)
	expect(
		await tool.execute?.(
			{ kind: 'date', due: new Date('2026-01-01') },
			{
				requestContext: context,
				observe: { span: async (_name, run) => run(), log: () => {} }
			}
		)
	).toBe(2026)
})
