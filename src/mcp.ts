import {
	type AnyProcedure,
	type AnyRouter,
	type TraverseContractProcedureCallbackOptions,
	traverseContractProcedures
} from '@orpc/server'
import { procedureDefinition } from './compatibility.js'
import { rawInputSchema, type ToolSchema } from './json-schema.js'
import { hasTag, type ProcedureFilter, readFnMeta, toToolName } from './meta.js'

export { hasTag, toToolName }
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

const isGet: ProcedureFilter = ({ contract }) =>
	procedureDefinition(contract).route?.method === 'GET'

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
		name?: (options: TraverseContractProcedureCallbackOptions) => string
	} = {}
): McpTool[] {
	const { filter, readOnly = isGet } = options
	const tools: McpTool[] = []
	const names = new Map<string, AnyProcedure>()
	const unresolved = traverseContractProcedures(
		{ router, path: [] },
		(traversed) => {
			if (filter && !filter(traversed)) return
			const procedure = traversed.contract as AnyProcedure
			const meta = readFnMeta(procedure)
			if (meta.stream)
				throw new TypeError(
					`orpc-fn: streaming procedure ${meta.name ?? traversed.path.join('.')} cannot be an MCP tool`
				)
			const name =
				options.name?.(traversed) ??
				toToolName(meta.name ?? traversed.path.join('.'))
			const previous = names.get(name)
			if (previous === procedure) return
			if (previous)
				throw new TypeError(
					`orpc-fn: MCP tool name collision: ${name}; provide a name override`
				)
			names.set(name, procedure)
			const { inputSchema } = procedureDefinition(procedure)
			const description = meta.description || undefined
			tools.push({
				name,
				procedure,
				config: {
					...(description === undefined ? {} : { description }),
					...(inputSchema ? { inputSchema: rawInputSchema(inputSchema) } : {}),
					annotations: { readOnlyHint: readOnly(traversed) }
				}
			})
		}
	)
	if (unresolved.length)
		throw new TypeError(
			'orpc-fn: resolve lazy routers with unlazyRouter before listing MCP tools'
		)
	return tools
}
