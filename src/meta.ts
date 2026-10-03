import type { AnySchema } from '@orpc/contract'
import type { AnyProcedure } from '@orpc/server'

/**
 * Key under which `fn()` stores its metadata in oRPC's procedure meta
 * (`.meta()`). Living in oRPC's own meta means it survives everything that
 * rebuilds a procedure (`os.router()`, `.use()` on a router, lazy routers),
 * unlike a symbol property on the procedure object.
 */
export const FN_META_KEY = 'orpc-fn'

export type StoredFnMeta = {
	name: string
	procedure: string
	meta: Record<string, unknown>
}

export type FnMeta<TMeta extends object = Record<string, unknown>> = {
	/** `fn({ name })`, also the OpenAPI operationId; undefined if not made by `fn()`. */
	name: string | undefined
	/** The `procedures` key the route was built from. */
	procedure: string | undefined
	/** The app's typed meta (`createFn({ meta })`) declared on this route. */
	meta: Partial<TMeta>
	/** Route summary, falling back to description, falling back to ''. */
	description: string
	summary: string | undefined
	method: string | undefined
	path: string | undefined
	tags: readonly string[]
	inputSchema: AnySchema | undefined
	outputSchema: AnySchema | undefined
}

type ProcedureDefinition = {
	meta?: Record<string, unknown>
	route?: {
		summary?: string
		description?: string
		method?: string
		path?: string
		tags?: readonly string[]
	}
	inputSchema?: AnySchema
	outputSchema?: AnySchema
}

/** Read what `fn()` (and oRPC) recorded on a procedure. */
export function readFnMeta<TMeta extends object = Record<string, unknown>>(
	procedure: AnyProcedure
): FnMeta<TMeta> {
	const def = (procedure as { '~orpc'?: ProcedureDefinition })['~orpc'] ?? {}
	const stored = def.meta?.[FN_META_KEY] as StoredFnMeta | undefined
	const route = def.route ?? {}
	return {
		name: stored?.name,
		procedure: stored?.procedure,
		meta: (stored?.meta ?? {}) as Partial<TMeta>,
		description: route.summary ?? route.description ?? '',
		summary: route.summary,
		method: route.method,
		path: route.path,
		tags: route.tags ?? [],
		inputSchema: def.inputSchema,
		outputSchema: def.outputSchema
	}
}

/** Tool-safe name (`a-z0-9-_`): `Users.Get` becomes `users-get`. */
export function toToolName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-')
}
