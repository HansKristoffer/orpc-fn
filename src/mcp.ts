import {
	type AnyProcedure,
	type AnyRouter,
	type TraverseContractProcedureCallbackOptions,
	traverseContractProcedures
} from '@orpc/server'
import { rawInputSchema, type ToolSchema } from './json-schema.js'
import { readFnMeta, toToolName } from './meta.js'

export { toToolName }
export { rawInputSchema as toolInputSchema }
export type { ToolSchema }

/** Picks procedures; also fits oRPC's `OpenAPIHandler({ filter })`. */
export type ProcedureFilter = (
	options: TraverseContractProcedureCallbackOptions
) => boolean

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

/** Procedures whose route has `tag`: `listTools(router, { filter: hasTag('external') })`. */
export const hasTag =
	(tag: string): ProcedureFilter =>
	({ contract }) =>
		contract['~orpc'].route.tags?.includes(tag) ?? false

const isGet: ProcedureFilter = ({ contract }) =>
	contract['~orpc'].route.method === 'GET'

/**
 * MCP tool definitions for the procedures in `router` matching `filter`
 * (default: all). Register them with any MCP server:
 * `server.registerTool(tool.name, tool.config, run)`.
 *
 * `readOnly` sets `readOnlyHint`; it defaults to GET routes, since an MCP
 * client treats anything else as a mutation and may ask for approval.
 */
export function listTools(
	router: AnyRouter,
	options: { filter?: ProcedureFilter; readOnly?: ProcedureFilter } = {}
): McpTool[] {
	const { filter, readOnly = isGet } = options
	const tools: McpTool[] = []
	traverseContractProcedures({ router, path: [] }, (traversed) => {
		if (filter && !filter(traversed)) return
		const procedure = traversed.contract as AnyProcedure
		const { inputSchema, route } = procedure['~orpc']
		const description = route.description ?? route.summary
		tools.push({
			name: toToolName(readFnMeta(procedure).name ?? traversed.path.join('.')),
			procedure,
			config: {
				...(description === undefined ? {} : { description }),
				...(inputSchema ? { inputSchema: rawInputSchema(inputSchema) } : {}),
				annotations: { readOnlyHint: readOnly(traversed) }
			}
		})
	})
	return tools
}
