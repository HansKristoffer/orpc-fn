import {
	type AnySchema,
	defineMeta as defineOrpcMeta,
	type ErrorMap,
	type Meta
} from '@orpc/contract'
import {
	type AnyProcedure,
	DecoratedProcedure,
	type Procedure
} from '@orpc/server'

/** All runtime access to oRPC's implementation namespace is audited here. */
export type ProcedureDefinition = {
	meta: Meta
	/** oRPC 2 stacks `.input()` calls; `fn()` routes have at most one. */
	inputSchemas: readonly AnySchema[]
	/** oRPC 2 pipes `.output()` calls; `fn()` routes have at most one. */
	outputSchemas: readonly AnySchema[]
}

export function procedureDefinition(procedure: object): ProcedureDefinition {
	const def = (
		procedure as {
			'~orpc'?: {
				meta?: Meta
				inputSchemas?: AnySchema[]
				outputSchemas?: AnySchema[]
			}
		}
	)['~orpc']
	return {
		meta: def?.meta ?? {},
		inputSchemas: def?.inputSchemas ?? [],
		outputSchemas: def?.outputSchemas ?? []
	}
}

/**
 * The single schema of a procedure, for adapters that need one JSON Schema
 * (tools, CLI). Stacked schemas from a builder have no single equivalent.
 */
export function soleSchema(
	schemas: readonly AnySchema[],
	what: string
): AnySchema | undefined {
	if (schemas.length > 1)
		throw new TypeError(
			`orpc-fn: ${what} stacks ${schemas.length} schemas; tool and CLI adapters need one`
		)
	return schemas[0]
}

/**
 * The OpenAPI route fields `fn()` accepts. oRPC 2 keeps them in procedure meta
 * under `'~openapi'`, written by `@orpc/openapi`'s `openapi()`. They are
 * mirrored here, so the root entry never imports the optional `@orpc/openapi`.
 */
export type OpenAPIRoute = {
	method?: 'HEAD' | 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'QUERY'
	path?: `/${string}`
	operationId?: string
	summary?: string
	description?: string
	deprecated?: boolean
	successStatus?: number
	successDescription?: string
	inputStructure?: 'compact' | 'detailed'
	outputStructure?: 'compact' | 'detailed'
	tags?: string[]
	/** Set by `.meta(openapi({ prefix }))` on a builder or router. */
	prefix?: `/${string}`
}

const OPENAPI_META_KEY = '~openapi'

/**
 * The same merge `openapi()` applies for these fields: tags set on a builder
 * and on the route concatenate, every other field replaces. Built with oRPC's
 * native `defineMeta`.
 */
export const [openapiMetaPlugin, readNativeOpenAPIMeta] = defineOrpcMeta(
	OPENAPI_META_KEY,
	(route: OpenAPIRoute, existing) => {
		const tags =
			existing?.tags && route.tags
				? [...existing.tags, ...route.tags]
				: (route.tags ?? existing?.tags)
		return { ...existing, ...route, ...(tags !== undefined ? { tags } : {}) }
	}
)

export function openapiRoute(procedure: object): OpenAPIRoute {
	const meta =
		'~orpc' in procedure &&
		typeof procedure['~orpc'] === 'object' &&
		procedure['~orpc'] !== null &&
		'meta' in procedure['~orpc']
			? readNativeOpenAPIMeta(procedure as { '~orpc': { meta: Meta } })
			: undefined
	return meta ?? {}
}

/**
 * Key under which `fn()` stores its metadata in oRPC's procedure meta
 * (`.meta()`). Living in oRPC's own meta means it survives everything that
 * rebuilds a procedure (`os.router()`, `.use()` on a router, lazy routers),
 * unlike a symbol property on the procedure object.
 */
export const FN_META_KEY = 'orpc-fn'

export const [fnMetaPlugin, readNativeFnMeta] = defineOrpcMeta(
	FN_META_KEY,
	(incoming: unknown) => incoming
)

export function readStoredFnMeta(procedure: object): unknown {
	return '~orpc' in procedure &&
		typeof procedure['~orpc'] === 'object' &&
		procedure['~orpc'] !== null &&
		'meta' in procedure['~orpc']
		? readNativeFnMeta(procedure as { '~orpc': { meta: Meta } })
		: undefined
}

/**
 * `os.use(...).router(...)` returns a plain `Procedure` without `.meta()`,
 * `.errors()` or `.use()`. Re-wrap it as `DecoratedProcedure` so runtime
 * routes support the methods `fn()`'s return type exposes.
 */
export function decorateProcedure(procedure: AnyProcedure): AnyProcedure {
	return procedure instanceof DecoratedProcedure
		? procedure
		: new DecoratedProcedure(procedure['~orpc'])
}

/**
 * oRPC 2 procedure types no longer carry meta. `fn()` adds this type-only
 * property so `readMeta(route)` stays typed; it never exists at runtime.
 */
export type LibraryBrand<TStored> = { readonly '~orpc-fn'?: TStored }

export type LibraryMeta<T> =
	T extends LibraryBrand<infer M> ? Exclude<M, undefined> : never

export type NativeErrors<T> =
	T extends Procedure<
		infer _I,
		infer _C,
		infer _In,
		infer _Out,
		infer E extends ErrorMap
	>
		? E
		: ErrorMap
