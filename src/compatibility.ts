import type { AnySchema, ErrorMap, Meta } from '@orpc/contract'
import type { Procedure, Route } from '@orpc/server'

/** All runtime access to oRPC's implementation namespace is audited here. */
export type ProcedureDefinition = {
	meta?: Record<string, unknown>
	route?: Route
	inputSchema?: AnySchema
	outputSchema?: AnySchema
}

export function procedureDefinition(procedure: object): ProcedureDefinition {
	return (procedure as { '~orpc'?: ProcedureDefinition })['~orpc'] ?? {}
}

export type NativeMeta<T> =
	T extends Procedure<
		infer _I,
		infer _C,
		infer _In,
		infer _Out,
		infer _E,
		infer M extends Meta
	>
		? M
		: Meta
export type NativeErrors<T> =
	T extends Procedure<
		infer _I,
		infer _C,
		infer _In,
		infer _Out,
		infer E extends ErrorMap,
		infer _M
	>
		? E
		: ErrorMap
export type LibraryMeta<T> =
	NativeMeta<T> extends { 'orpc-fn': infer M } ? M : never
