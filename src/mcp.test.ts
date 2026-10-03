import { describe, expect, test } from 'bun:test'
import { call } from '@orpc/server'
import { z } from 'zod'
import { createRouter, fn } from '../tests/fixture.js'
import { hasTag, listTools, type ProcedureFilter } from './mcp.js'

const isExternal = hasTag('external')
const isMcpSupport = hasTag('mcp-support')
// gey-mono's rule: GET, or a non-GET route tagged as read-only.
const readOnly: ProcedureFilter = (options) =>
	options.contract['~orpc'].route.method === 'GET' ||
	hasTag('mcp-readonly')(options)
const listExternalTools = (
	router: Parameters<typeof listTools>[0],
	filter: ProcedureFilter = isExternal
) => listTools(router, { filter, readOnly })

const external = fn({
	name: 'thing.get',
	method: 'GET',
	procedure: 'public',
	tags: ['external'],
	summary: 'Get a thing',
	input: z.object({ id: z.string(), since: z.coerce.date().optional() }),
	handler: async ({ input }) => ({ id: input.id })
})
const supportTool = fn({
	name: 'thing.support',
	method: 'GET',
	procedure: 'public',
	tags: ['external', 'mcp-support'],
	summary: 'Support-safe thing',
	handler: async () => ({ ok: true })
})
const postRead = fn({
	name: 'thing.report',
	procedure: 'public',
	tags: ['external', 'mcp-readonly'],
	summary: 'POST that only reads',
	handler: async () => ({ ok: true })
})
const internal = fn({
	name: 'thing.secret',
	method: 'GET',
	procedure: 'public',
	handler: async () => ({ ok: true })
})
const router = createRouter({
	thing: createRouter({ external, supportTool, postRead, internal }),
	other: createRouter({ internal })
})

describe('listExternalTools', () => {
	test('keeps only external-tagged procedures with MCP-safe names', () => {
		const tools = listExternalTools(router)
		expect(tools.map((t) => t.name)).toEqual([
			'thing-get',
			'thing-support',
			'thing-report'
		])
		expect(tools[0]?.config.description).toBe('Get a thing')
		expect(tools[0]?.config.inputSchema).toBeDefined()
	})

	test('the support MCP only sees mcp-support procedures', () => {
		expect(listExternalTools(router, isMcpSupport).map((t) => t.name)).toEqual([
			'thing-support'
		])
	})

	test('GET and mcp-readonly are read-only hints, other methods are not', () => {
		const readOnly = Object.fromEntries(
			listExternalTools(router).map((t) => [
				t.name,
				t.config.annotations?.readOnlyHint
			])
		)
		expect(readOnly).toEqual({
			'thing-get': true,
			'thing-support': true,
			'thing-report': true
		})
	})

	test('tool input JSON Schema represents dates (zod alone throws)', () => {
		const schema = listExternalTools(router)[0]?.config.inputSchema
		const json = schema?.['~standard'].jsonSchema.input({
			target: 'draft-2020-12'
		})
		expect(json?.properties).toMatchObject({
			id: { type: 'string' },
			since: { type: 'string', format: 'date-time' }
		})
		expect(
			schema?.['~standard'].validate({ id: 'x', since: '2026-01-01' })
		).toMatchObject({
			value: { id: 'x', since: new Date('2026-01-01') }
		})
	})

	test('tool validation turns date strings back into Dates for z.date() inputs', async () => {
		const strict = fn({
			name: 'thing.create',
			procedure: 'public',
			tags: ['external'],
			input: z.object({ due: z.date().nullable().optional() }),
			handler: async () => ({ ok: true })
		})
		const [tool] = listExternalTools(createRouter({ strict }))
		expect(
			await tool?.config.inputSchema?.['~standard'].validate({
				due: '2026-10-05'
			})
		).toEqual({ value: { due: new Date('2026-10-05') } })
	})

	test('defaults: every procedure, read-only means GET', () => {
		const tools = listTools(router)
		expect(tools.map((t) => t.name)).toEqual([
			'thing-get',
			'thing-support',
			'thing-report',
			'thing-secret'
		])
		expect(
			tools.find((t) => t.name === 'thing-report')?.config.annotations
		).toEqual({ readOnlyHint: false })
	})

	test('validated arguments are raw input: call() transforms them once', async () => {
		const counted = fn({
			name: 'thing.count',
			procedure: 'public',
			input: z.object({ n: z.string().transform(Number) }),
			handler: ({ input }) => input.n + 1
		})
		const [tool] = listTools(createRouter({ counted }))
		const validated = await tool?.config.inputSchema?.['~standard'].validate({
			n: '2'
		})
		expect(validated).toEqual({ value: { n: '2' } })
		const args = validated && 'value' in validated ? validated.value : undefined
		expect(await call(counted, args as { n: string }, { context: {} })).toBe(3)
	})

	test('invalid arguments still fail validation', async () => {
		const [tool] = listTools(router, { filter: isExternal })
		const result = await tool?.config.inputSchema?.['~standard'].validate({})
		expect(result && 'issues' in result && result.issues?.length).toBeTruthy()
	})
})
