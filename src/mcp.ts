import type { AnyProcedureContract } from '@orpc/contract'
import {
	type AnyProcedure,
	type AnyRouter,
	walkProcedureContractsSync
} from '@orpc/server'
import {
	openapiRoute,
	procedureDefinition,
	soleSchema
} from './compatibility.js'
import { rawInputSchema, type ToolSchema } from './json-schema.js'
import {
	allOf,
	anyOf,
	hasTag,
	hasTags,
	not,
	type ProcedureFilter,
	readFnMeta,
	toToolName
} from './meta.js'

export { allOf, anyOf, hasTag, hasTags, not, toToolName }
export { rawInputSchema as toolInputSchema }
export type { ProcedureFilter, ToolSchema }

export type McpTool = {
	/** Tool name: the sanitized `fn` name (`user.me` becomes `user-me`). */
	name: string
	procedure: AnyProcedure
	config: {
		description?: string
		/**
		 * Validates and coerces (date strings to `Date`) but returns the raw
		 * input: pass it to `call(procedure, args)`, which parses it.
		 */
		inputSchema?: ToolSchema
		annotations: { readOnlyHint: boolean }
	}
}

const isGet: ProcedureFilter = (procedure) =>
	openapiRoute(procedure).method === 'GET'

/**
 * MCP tool definitions for the procedures in `router` matching `filter`
 * (default: all). These are inspection definitions, not McpServer.registerTool configs.
 * Use registerMcpTools from orpc-fn/mcp/sdk for executable registration.
 *
 * `readOnly` sets `readOnlyHint`; it defaults to GET routes, since an MCP
 * client treats anything else as a mutation and may ask for approval.
 */
export function listTools(
	router: AnyRouter,
	options: {
		filter?: ProcedureFilter
		readOnly?: ProcedureFilter
		name?: (
			procedure: AnyProcedureContract | AnyProcedure,
			path: readonly string[]
		) => string
		/**
		 * A streaming procedure the filter accepts: `'skip'` leaves it out
		 * (default), so one filter such as `hasTag('external')` can describe
		 * a REST surface with streams; `'throw'` fails instead.
		 */
		streams?: 'skip' | 'throw'
	} = {}
): McpTool[] {
	const { filter, readOnly = isGet, streams = 'skip' } = options
	if (streams !== 'skip' && streams !== 'throw')
		throw new TypeError("orpc-fn: streams must be 'skip' or 'throw'")
	const tools: McpTool[] = []
	const names = new Map<string, AnyProcedure>()
	const unresolved = walkProcedureContractsSync(router, (contract, path) => {
		if (filter && !filter(contract, path)) return
		const procedure = contract as AnyProcedure
		const meta = readFnMeta(procedure)
		if (meta.stream) {
			if (streams === 'skip') return
			throw new TypeError(
				`orpc-fn: streaming procedure ${meta.name ?? path.join('.')} cannot be an MCP tool`
			)
		}
		const name =
			options.name?.(contract, path) ?? toToolName(meta.name ?? path.join('.'))
		const previous = names.get(name)
		if (previous === procedure) return
		if (previous)
			throw new TypeError(
				`orpc-fn: MCP tool name collision: ${name}; provide a name override`
			)
		names.set(name, procedure)
		const inputSchema = soleSchema(
			procedureDefinition(procedure).inputSchemas,
			`MCP tool ${name}`
		)
		const description = meta.description || undefined
		tools.push({
			name,
			procedure,
			config: {
				...(description === undefined ? {} : { description }),
				...(inputSchema ? { inputSchema: rawInputSchema(inputSchema) } : {}),
				annotations: { readOnlyHint: readOnly(contract, path) }
			}
		})
	})
	if (unresolved.length)
		throw new TypeError(
			'orpc-fn: resolve lazy routers with unlazyRouter before listing MCP tools'
		)
	return tools
}
