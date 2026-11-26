import { describe, expect, test } from 'bun:test'
import { call } from '@orpc/server'
import { z } from 'zod'
import { createRouter, fn } from '../tests/fixture.js'
import {
	allOf,
	anyOf,
	hasTag,
	hasTags,
	listTools,
	not,
	type ProcedureFilter
} from './mcp.js'
import { readFnMeta } from './meta.js'

const isExternal = hasTag('external')
const isMcpSupport = hasTag('mcp-support')
// gey-mono's rule: GET, or a non-GET route tagged as read-only.
const readOnly: ProcedureFilter = (procedure, path) =>
	readFnMeta(procedure).method === 'GET' ||
	hasTag('mcp-readonly')(procedure, path)
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

	test('supports non-Zod Standard JSON Schema v1 inputs via StandardJsonSchemaConverter', async () => {
		const standardInput = {
			'~standard': {
				version: 1 as const,
				vendor: 'custom',
				types: {} as { input: { query: string }; output: { query: string } },
				validate: (value: unknown) =>
					typeof value === 'object' &&
					value !== null &&
					typeof (value as { query?: unknown }).query === 'string'
						? { value: value as { query: string } }
						: { issues: [{ message: 'Expected { query: string }' }] },
				jsonSchema: {
					input: () => ({
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query']
					}),
					output: () => ({
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query']
					})
				}
			}
		}
		const search = fn({
			name: 'thing.search',
			procedure: 'public',
			input: standardInput,
			handler: ({ input }) => input.query
		})
		const [tool] = listTools(createRouter({ search }))
		const json = tool?.config.inputSchema?.['~standard'].jsonSchema.input()
		expect(json).toMatchObject({
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query']
		})
		expect(
			await tool?.config.inputSchema?.['~standard'].validate({ query: 'abc' })
		).toEqual({ value: { query: 'abc' } })
		expect(
			await tool?.config.inputSchema?.['~standard'].validate({})
		).toMatchObject({ issues: [{ message: 'Expected { query: string }' }] })
	})
})

describe('streaming procedures', () => {
	const watch = fn({
		name: 'thing.watch',
		procedure: 'public',
		tags: ['external'],
		stream: true,
		async *handler() {
			yield { ok: true }
		}
	})
	const withStream = createRouter({ external, watch })

	test('are left out by default, so one filter serves REST and MCP', () => {
		expect(listExternalTools(withStream).map((t) => t.name)).toEqual([
			'thing-get'
		])
	})

	test("streams: 'throw' fails on one the filter accepts", () => {
		expect(() =>
			listTools(withStream, { filter: isExternal, streams: 'throw' })
		).toThrow('streaming procedure thing.watch cannot be an MCP tool')
	})
})

describe('filter combinators', () => {
	const names = (filter: ProcedureFilter) =>
		listTools(router, { filter }).map((t) => t.name)

	test('hasTags needs every tag; allOf, anyOf and not combine filters', () => {
		expect(names(hasTags('external', 'mcp-support'))).toEqual(['thing-support'])
		expect(names(allOf(isExternal, isMcpSupport))).toEqual(['thing-support'])
		expect(names(anyOf(isMcpSupport, hasTag('mcp-readonly')))).toEqual([
			'thing-support',
			'thing-report'
		])
		expect(names(not(isExternal))).toEqual(['thing-secret'])
		expect(names(allOf())).toHaveLength(4)
		expect(names(anyOf())).toEqual([])
	})

	test('filters see the router path', () => {
		const underOther: ProcedureFilter = (_procedure, path) =>
			path[0] === 'other'
		expect(
			listTools(router, { filter: allOf(underOther, not(isExternal)) }).map(
				(t) => t.name
			)
		).toEqual(['thing-secret'])
	})
})
