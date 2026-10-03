import { getEventIteratorSchemaDetails, type AnySchema } from '@orpc/contract'
import { type LibraryMeta, procedureDefinition } from './compatibility.js'
import type { AnyProcedure } from '@orpc/server'

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
	/** Route summary, falling back to description, falling back to ''. */
	description: string
	summary: string | undefined
	method: string | undefined
	path: string | undefined
	stream: boolean
	tags: readonly string[]
	inputSchema: AnySchema | undefined
	outputSchema: AnySchema | undefined
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

export function readFnMeta<T extends AnyProcedure>(
	procedure: T
): FnMeta<MetaFrom<T>, KeyFrom<T>> {
	const def = procedureDefinition(procedure)
	const stored = def.meta?.[FN_META_KEY] as StoredFnMeta | undefined
	const route = def.route ?? {}
	return {
		name: stored?.name,
		procedure: stored?.procedure as KeyFrom<T> | undefined,
		meta: (stored?.meta ?? {}) as Partial<MetaFrom<T>>,
		description: route.summary ?? route.description ?? '',
		summary: route.summary,
		method: route.method,
		path: route.path,
		tags: route.tags ?? [],
		stream:
			stored?.stream === true ||
			getEventIteratorSchemaDetails(def.outputSchema) !== undefined,
		inputSchema: def.inputSchema,
		outputSchema: def.outputSchema
	}
}

/** Tool-safe name (`a-z0-9-_`): `Users.Get` becomes `users-get`. */
export function toToolName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-')
}
