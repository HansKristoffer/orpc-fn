import type { AnySchema } from '@orpc/contract'
import {
	DelegatingJsonSchemaConverter,
	extractJsonObjectSchemaEntries,
	JsonSchemaCoercer,
	StandardJsonSchemaConverter
} from '@orpc/json-schema'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import type { SchemaIssue } from './issues.js'

export type JsonSchema = Record<string, unknown>

/**
 * A Standard Schema with JSON Schema attached, as MCP SDKs and Mastra expect.
 * `TIn` is what is validated and what `validate` returns.
 */
export type ToolSchema<TIn = unknown, TOut = TIn> = {
	'~standard': {
		version: 1
		vendor: string
		validate: (
			value: unknown
		) =>
			| { value: TOut; issues?: undefined }
			| { issues: ReadonlyArray<SchemaIssue> }
			| Promise<
					| { value: TOut; issues?: undefined }
					| { issues: ReadonlyArray<SchemaIssue> }
			  >
		types?: { input: TIn; output: TOut }
		jsonSchema: {
			input: (options?: unknown) => JsonSchema
			output: (options?: unknown) => JsonSchema
		}
	}
}

const converter = new DelegatingJsonSchemaConverter([
	new ZodToJsonSchemaConverter(),
	new StandardJsonSchemaConverter()
])
const coercer = new JsonSchemaCoercer()

/** Converted on first use: an app building many tools at import pays per tool used. */
function lazyConversion(
	schema: AnySchema,
	direction: 'input' | 'output'
): () => [schema: JsonSchema, optional: boolean] {
	let converted: [JsonSchema, boolean] | undefined
	return () => {
		converted ??= converter.convert(schema, direction) as [JsonSchema, boolean]
		return converted
	}
}

/**
 * JSON Schema formats that say what a string is, so a `pattern` beside one
 * repeats it (Zod writes both: `format: 'uuid'` and a 150-character regex).
 * Zod's own formats (`cuid`, `nanoid`, `e164`, …) keep their pattern: a
 * model cannot tell what those names mean.
 */
const DESCRIBED_FORMATS = new Set([
	'date-time',
	'date',
	'time',
	'duration',
	'email',
	'idn-email',
	'hostname',
	'idn-hostname',
	'ipv4',
	'ipv6',
	'uri',
	'uri-reference',
	'iri',
	'iri-reference',
	'uuid'
])

/** How tool JSON Schemas are written for a model. */
export type ToolSchemaOptions = {
	/**
	 * Keep a string's `pattern` when a standard `format` (`uuid`, `email`,
	 * `date-time`, …) already describes it. Default: false, which keeps tool
	 * prompts short; validation still applies every check of the schema.
	 */
	keepFormatPatterns?: boolean
}

/** `schema` without patterns that repeat a standard format, as a copy. */
export function compactToolJsonSchema(schema: JsonSchema): JsonSchema {
	const compact = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(compact)
		if (typeof value !== 'object' || value === null) return value
		const node = value as Record<string, unknown>
		const dropPattern =
			typeof node.format === 'string' &&
			DESCRIBED_FORMATS.has(node.format) &&
			typeof node.pattern === 'string'
		const copy: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(node))
			if (!(dropPattern && key === 'pattern')) copy[key] = compact(child)
		return copy
	}
	return compact(schema) as JsonSchema
}

/** The JSON Schema a model reads, written once from `conversion`. */
function toolJsonSchema(
	conversion: () => [schema: JsonSchema, optional: boolean],
	options: ToolSchemaOptions
): () => JsonSchema {
	let written: JsonSchema | undefined
	return () => {
		written ??= options.keepFormatPatterns
			? conversion()[0]
			: compactToolJsonSchema(conversion()[0])
		return written
	}
}

/**
 * Tool input that validates like the procedure but returns the RAW input for
 * the procedure's own input schema to parse. Transforms run in both passes
 * but never on their own output, which handing over the parsed value would do. Zod's JSON Schema export rejects types like
 * `z.date()`; oRPC's converter gives the same JSON Schema as the OpenAPI docs
 * (dates become string/date-time), and clients send those dates as strings,
 * so values are coerced back before validating.
 */
export function rawInputSchema<TIn>(
	schema: AnySchema,
	options: ToolSchemaOptions = {}
): ToolSchema<TIn> {
	// Coercion reads the full conversion; the model reads the compact one.
	const conversion = lazyConversion(schema, 'input')
	const jsonSchema = toolJsonSchema(conversion, options)
	return {
		'~standard': {
			version: 1,
			vendor: 'orpc-fn',
			validate: (value) => {
				const coerced = coercer.coerce(conversion(), value) as TIn
				const finish = (
					result: Awaited<ReturnType<AnySchema['~standard']['validate']>>
				) => (result.issues ? { issues: result.issues } : { value: coerced })
				const result = schema['~standard'].validate(coerced)
				return result instanceof Promise ? result.then(finish) : finish(result)
			},
			jsonSchema: { input: jsonSchema, output: jsonSchema }
		}
	}
}

/** Tool output the procedure already validated: described, passed through. */
export function passThroughOutputSchema<TOut>(
	schema: AnySchema,
	options: ToolSchemaOptions = {}
): ToolSchema<TOut> {
	const jsonSchema = toolJsonSchema(lazyConversion(schema, 'output'), options)
	return {
		'~standard': {
			version: 1,
			vendor: 'orpc-fn',
			validate: (value) => ({ value: value as TOut }),
			jsonSchema: { input: jsonSchema, output: jsonSchema }
		}
	}
}

/** Tool protocols permit unions/intersections only when every branch accepts an object. */
export function isObjectJsonSchema(schema: JsonSchema): boolean {
	return extractJsonObjectSchemaEntries(schema) !== undefined
}
