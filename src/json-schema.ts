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

function lazyJsonSchema(
	schema: AnySchema,
	direction: 'input' | 'output'
): () => JsonSchema {
	const conversion = lazyConversion(schema, direction)
	return () => conversion()[0]
}

/**
 * Tool input that validates like the procedure but returns the RAW input for
 * the procedure's own input schema to parse. Transforms run in both passes
 * but never on their own output, which handing over the parsed value would do. Zod's JSON Schema export rejects types like
 * `z.date()`; oRPC's converter gives the same JSON Schema as the OpenAPI docs
 * (dates become string/date-time), and clients send those dates as strings,
 * so values are coerced back before validating.
 */
export function rawInputSchema<TIn>(schema: AnySchema): ToolSchema<TIn> {
	const conversion = lazyConversion(schema, 'input')
	const jsonSchema = () => conversion()[0]
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
	schema: AnySchema
): ToolSchema<TOut> {
	const jsonSchema = lazyJsonSchema(schema, 'output')
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
