// OpenAPI documents with named components, on oRPC's own generator. oRPC 2
// dropped `commonSchemas`; it names a schema that carries a Zod `id` and
// hoists it into `components.schemas`, so this module only supplies the ids.
import type {
	JsonSchemaConverter,
	JsonSchemaConverterDirection
} from '@orpc/json-schema'
import {
	type OpenAPIDocument,
	OpenAPIGenerator,
	type OpenAPIGeneratorGenerateOptions,
	type OpenAPIVersion
} from '@orpc/openapi'
import type { AnyRouter } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod'
import { z } from 'zod/v4'
import {
	allOf,
	anyOf,
	hasTag,
	hasTags,
	not,
	type ProcedureFilter
} from './meta.js'

export { allOf, anyOf, hasTag, hasTags, not, type ProcedureFilter }

type Direction = JsonSchemaConverterDirection

/**
 * A named shape: a Zod 4 schema, or one limited to route inputs or outputs
 * (`only`), when it is named in one direction alone.
 */
export type OpenApiComponent =
	| z.core.$ZodType
	| { schema: z.core.$ZodType; only?: Direction }

/** `components.schemas` entries by name: `{ Error: ErrorSchema, Event: { schema, only: 'output' } }`. */
export type OpenApiComponents = Record<string, OpenApiComponent>

/** oRPC's generator options, plus the routes to document and named components. */
export type OpenApiDocumentOptions<TVersion extends OpenAPIVersion> = Omit<
	OpenAPIGeneratorGenerateOptions<TVersion>,
	'filter'
> & {
	/**
	 * The procedures to document, e.g. `hasTag('external')`; `() => true`
	 * documents every route.
	 */
	filter: ProcedureFilter
	/**
	 * Schemas written once under `components.schemas` and referred to by
	 * name wherever a route uses them, including ones no route refers to
	 * (a webhook payload). The names stay out of Zod's global registry, so
	 * the JSON Schema tools build from the same schemas does not change.
	 */
	components?: OpenApiComponents | undefined
}

type Entry = { name: string; schema: z.core.$ZodType; only?: Direction }

function entriesOf(components: OpenApiComponents): Entry[] {
	const names = new Map<z.core.$ZodType, string>()
	return Object.entries(components).map(([name, component]) => {
		const { schema, only } =
			'_zod' in component ? { schema: component, only: undefined } : component
		if (!schema || !('_zod' in schema))
			throw new TypeError(
				`orpc-fn: OpenAPI component ${name} needs a Zod 4 schema`
			)
		if (only !== undefined && only !== 'input' && only !== 'output')
			throw new TypeError(
				`orpc-fn: OpenAPI component ${name} has only: '${String(only)}'; use 'input' or 'output'`
			)
		const previous = names.get(schema)
		if (previous)
			throw new TypeError(
				`orpc-fn: OpenAPI components ${previous} and ${name} name the same schema`
			)
		names.set(schema, name)
		return { name, schema, ...(only ? { only } : {}) }
	})
}

/**
 * Zod's global metadata, plus an `id` on each component named in
 * `direction`. Zod writes a schema with an id into `$defs`, and oRPC hoists
 * `$defs` into `components.schemas`.
 */
function componentRegistry(entries: readonly Entry[], direction: Direction) {
	const ids = new Map<z.core.$ZodType, string>()
	const registry = z.registry<z.core.GlobalMeta>()
	for (const { name, schema, only } of entries) {
		if (only && only !== direction) continue
		ids.set(schema, name)
		registry.add(schema, { id: name })
	}
	registry.get = (schema) => {
		const meta = z.globalRegistry.get(schema)
		const id = ids.get(schema)
		return id ? { ...meta, id } : meta
	}
	return registry
}

function componentConverter(entries: readonly Entry[]): JsonSchemaConverter {
	const converters = {
		input: new ZodToJsonSchemaConverter({
			metadata: componentRegistry(entries, 'input')
		}),
		output: new ZodToJsonSchemaConverter({
			metadata: componentRegistry(entries, 'output')
		})
	}
	return {
		condition: (schema, direction) =>
			converters[direction].condition(schema, direction),
		convert: (schema, direction) =>
			converters[direction].convert(schema, direction)
	}
}

type SchemaObject = Record<string, unknown>

/**
 * Every component named in `direction`, as `components.schemas` entries;
 * oRPC writes only the ones a route refers to. Dates read as date-time
 * strings, as oRPC writes them.
 */
function componentSchemas(
	entries: readonly Entry[],
	direction: Direction
): Record<string, SchemaObject> {
	const { schemas } = z.toJSONSchema(componentRegistry(entries, direction), {
		io: direction,
		unrepresentable: 'any',
		uri: (id) => `#/components/schemas/${id}`,
		override: ({ zodSchema, jsonSchema }) => {
			if (zodSchema._zod.def.type === 'date') {
				jsonSchema.type = 'string'
				jsonSchema.format = 'date-time'
			}
		}
	})
	// Zod writes JSON Schema draft 2020-12, the dialect of OpenAPI 3.1+ schemas.
	return Object.fromEntries(
		Object.entries(schemas).map(([id, { $id: _, $schema: __, ...schema }]) => [
			id,
			schema as SchemaObject
		])
	)
}

/**
 * The OpenAPI document of `router`'s procedures that pass `filter`, from
 * oRPC's `OpenAPIGenerator`, with `components` named:
 *
 * ```ts
 * const document = await generateOpenApiDocument(router, {
 *   filter: hasTag('external'),
 *   version: '3.1.1',
 *   base: { info: { title: 'API', version: '1.0.0' } },
 *   components: { Error: ErrorSchema, Event: { schema: EventSchema, only: 'output' } }
 * })
 * ```
 *
 * `mountOrpc`'s docs pages generate theirs with it.
 */
export async function generateOpenApiDocument<
	TVersion extends OpenAPIVersion = '3.2.0'
>(
	router: AnyRouter,
	options: OpenApiDocumentOptions<TVersion>
): Promise<OpenAPIDocument<TVersion>> {
	const { components, filter, ...generate } = options
	if (typeof filter !== 'function')
		throw new TypeError(
			'orpc-fn: generateOpenApiDocument needs a filter; pass () => true to document every route'
		)
	const entries = components ? entriesOf(components) : []
	const generator = new OpenAPIGenerator({
		converters: [
			entries.length
				? componentConverter(entries)
				: new ZodToJsonSchemaConverter()
		]
	})
	const document = await generator.generate(router, {
		...generate,
		filter: (procedure, path) => filter(procedure, path)
	})
	if (!entries.length) return document

	// Names a route already refers to keep oRPC's schema; outputs come first.
	const generated = (document.components?.schemas ?? {}) as Record<
		string,
		unknown
	>
	const unreferenced: Record<string, SchemaObject> = {}
	for (const direction of ['output', 'input'] as const) {
		for (const [name, schema] of Object.entries(
			componentSchemas(entries, direction)
		)) {
			if (!(name in generated) && !(name in unreferenced))
				unreferenced[name] = schema
		}
	}
	return {
		...document,
		components: {
			...document.components,
			schemas: { ...unreferenced, ...generated }
		}
	} as OpenAPIDocument<TVersion>
}
