import {
	type AnyProcedureContract,
	type AnySchema,
	getAsyncIteratorObjectSchemasDetails
} from '@orpc/contract'
import type { AnyProcedure } from '@orpc/server'
import {
	type LibraryMeta,
	openapiRoute,
	procedureDefinition
} from './compatibility.js'

/**
 * Picks procedures by `(procedure, path)`; also fits oRPC's handler and
 * OpenAPI generator `filter`.
 */
export type ProcedureFilter = (
	procedure: AnyProcedureContract | AnyProcedure,
	path: readonly string[]
) => boolean

/** Procedures whose route has `tag`: `listTools(router, { filter: hasTag('external') })`. */
export const hasTag =
	(tag: string): ProcedureFilter =>
	(procedure) =>
		openapiRoute(procedure).tags?.includes(tag) ?? false

/**
 * Key under which `fn()` stores its metadata in oRPC's procedure meta
 * (`.meta()`). Living in oRPC's own meta means it survives everything that
 * rebuilds a procedure (`os.router()`, `.use()` on a router, lazy routers),
 * unlike a symbol property on the procedure object.
 */
export const FN_META_KEY = 'orpc-fn'

export type StoredFnMeta<
	TMeta extends object = Record<string, unknown>,
	TKey extends string = string
> = {
	name: string
	procedure: TKey
	meta: TMeta
	stream: boolean
	/** Guard values set on the route. */
	guards?: Record<string, unknown>
	/** Guards decided per call through `guardResolvers`. */
	dynamicGuards?: readonly string[]
}

export type FnMeta<
	TMeta extends object = Record<string, unknown>,
	TKey extends string = string
> = {
	/** `fn({ name })`, also the OpenAPI operationId; undefined if not made by `fn()`. */
	name: string | undefined
	/** The `procedures` key the route was built from. */
	procedure: TKey | undefined
	/** The app's typed meta (`createFn({ meta })`) declared on this route. */
	meta: Partial<TMeta>
	/** Route description, falling back to summary, falling back to ''. */
	description: string
	summary: string | undefined
	method: string | undefined
	/** The route's own `path`, without a builder or router `prefix`. */
	path: string | undefined
	stream: boolean
	tags: readonly string[]
	/**
	 * The route's input schema. Undefined when it has none, or when a plain
	 * oRPC procedure stacks several `.input()` calls (a `fn()` route cannot).
	 */
	inputSchema: AnySchema | undefined
	/** The route's output schema, undefined for none or several (see `inputSchema`). */
	outputSchema: AnySchema | undefined
	/** Guard values set on the route (`permission: 'deal.read'`). */
	guards: Record<string, unknown>
	/** Guards the route decides per call through `guardResolvers`. */
	dynamicGuards: readonly string[]
}

/** Read what `fn()` (and oRPC) recorded on a procedure. */
type MetaFrom<T> = [LibraryMeta<T>] extends [never]
	? Record<string, unknown>
	: LibraryMeta<T> extends StoredFnMeta<infer M, string>
		? M
		: Record<string, unknown>

type KeyFrom<T> = [LibraryMeta<T>] extends [never]
	? string
	: LibraryMeta<T> extends StoredFnMeta<object, infer K>
		? K
		: string

/** Declares the route metadata contract; it does not provide defaults. */
export function defineMeta<T extends object>(): T {
	return {} as T
}

/** Also reads the procedures a `ProcedureFilter` or a router walk gets. */
export function readFnMeta<T extends AnyProcedure | AnyProcedureContract>(
	procedure: T
): FnMeta<MetaFrom<T>, KeyFrom<T>> {
	const def = procedureDefinition(procedure)
	const stored = def.meta[FN_META_KEY] as StoredFnMeta | undefined
	const route = openapiRoute(procedure)
	return {
		name: stored?.name,
		procedure: stored?.procedure as KeyFrom<T> | undefined,
		meta: (stored?.meta ?? {}) as Partial<MetaFrom<T>>,
		description: route.description ?? route.summary ?? '',
		summary: route.summary,
		method: route.method,
		path: route.path,
		tags: route.tags ?? [],
		stream:
			stored?.stream === true ||
			getAsyncIteratorObjectSchemasDetails(def.outputSchemas) !== undefined,
		inputSchema: single(def.inputSchemas),
		outputSchema: single(def.outputSchemas),
		guards: stored?.guards ?? {},
		dynamicGuards: stored?.dynamicGuards ?? []
	}
}

function single(schemas: readonly AnySchema[]): AnySchema | undefined {
	return schemas.length === 1 ? schemas[0] : undefined
}

/** Tool-safe name (`a-z0-9-_`): `Users.Get` becomes `users-get`. */
export function toToolName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-')
}
