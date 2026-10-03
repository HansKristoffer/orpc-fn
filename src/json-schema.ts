import type { AnySchema } from '@orpc/contract'
import { JsonSchemaCoercer } from '@orpc/json-schema'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'

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
			| { issues: ReadonlyArray<{ message: string }> }
			| Promise<
					| { value: TOut; issues?: undefined }
					| { issues: ReadonlyArray<{ message: string }> }
			  >
		types?: { input: TIn; output: TOut }
		jsonSchema: {
			input: (options?: unknown) => JsonSchema
			output: (options?: unknown) => JsonSchema
		}
	}
}

const converter = new ZodToJsonSchemaConverter()
const coercer = new JsonSchemaCoercer()

export function toJsonSchema(
	schema: AnySchema,
	strategy: 'input' | 'output'
): JsonSchema {
	return converter.convert(schema, { strategy })[1] as JsonSchema
}

/**
 * Tool input that validates like the procedure but returns the RAW input, so
 * the procedure's own input schema parses it exactly once (transforms would
 * otherwise run twice). Zod's JSON Schema export rejects types like
 * `z.date()`; oRPC's converter gives the same JSON Schema as the OpenAPI docs
 * (dates become string/date-time), and clients send those dates as strings,
 * so values are coerced back before validating.
 */
export function rawInputSchema<TIn>(schema: AnySchema): ToolSchema<TIn> {
	const jsonSchema = toJsonSchema(schema, 'input')
	return {
		'~standard': {
			version: 1,
			vendor: 'orpc-fn',
			validate: (value) => {
				const coerced = coercer.coerce(jsonSchema, value) as TIn
				const finish = (
					result: Awaited<ReturnType<AnySchema['~standard']['validate']>>
				) => (result.issues ? { issues: result.issues } : { value: coerced })
				const result = schema['~standard'].validate(coerced)
				return result instanceof Promise ? result.then(finish) : finish(result)
			},
			jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
		}
	}
}

/** Tool output the procedure already validated: described, passed through. */
export function passThroughOutputSchema<TOut>(
	schema: AnySchema
): ToolSchema<TOut> {
	const jsonSchema = toJsonSchema(schema, 'output')
	return {
		'~standard': {
			version: 1,
			vendor: 'orpc-fn',
			validate: (value) => ({ value: value as TOut }),
			jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
		}
	}
}
