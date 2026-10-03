import type { AnySchema } from '@orpc/contract'
import { JsonSchemaCoercer } from '@orpc/json-schema'
import {
	type AnyProcedure,
	type AnyRouter,
	type TraverseContractProcedureCallbackOptions,
	traverseContractProcedures
} from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { readFnMeta, toToolName } from './meta.js'

export { toToolName }

/** Picks procedures; also fits oRPC's `OpenAPIHandler({ filter })`. */
export type ProcedureFilter = (
	options: TraverseContractProcedureCallbackOptions
) => boolean

type JsonSchema = Record<string, unknown>

/** A Standard Schema that also exposes JSON Schema, as MCP SDKs expect. */
export type ToolInputSchema = {
	'~standard': AnySchema['~standard'] & {
		jsonSchema: {
			input: (options?: unknown) => JsonSchema
			output: (options?: unknown) => JsonSchema
		}
	}
}

export type McpTool = {
	/** Tool name: the sanitized `fn` name (`user.me` becomes `user-me`). */
	name: string
	procedure: AnyProcedure
	config: {
		description?: string
		inputSchema?: ToolInputSchema
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

const jsonSchemaConverter = new ZodToJsonSchemaConverter()
const jsonSchemaCoercer = new JsonSchemaCoercer()

/**
 * Zod validates the tool input, but its own JSON Schema export rejects types
 * like `z.date()`, which breaks the whole tool list. Use oRPC's converter so
 * tools get the same JSON Schema as the OpenAPI docs (dates become
 * string/date-time). Clients then send those dates as strings, so validation
 * coerces them back first; without it every `z.date()` input fails.
 */
export function toolInputSchema(schema: AnySchema): ToolInputSchema {
	const [, jsonSchema] = jsonSchemaConverter.convert(schema, {
		strategy: 'input'
	})
	const json = jsonSchema as JsonSchema
	return {
		'~standard': {
			...schema['~standard'],
			validate: (value) =>
				schema['~standard'].validate(
					jsonSchemaCoercer.coerce(jsonSchema, value)
				),
			jsonSchema: { input: () => json, output: () => json }
		}
	}
}

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
				...(inputSchema ? { inputSchema: toolInputSchema(inputSchema) } : {}),
				annotations: { readOnlyHint: readOnly(traversed) }
			}
		})
	})
	return tools
}
