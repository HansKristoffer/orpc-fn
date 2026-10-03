import { type AnyProcedure, call } from '@orpc/server'
import { readFnMeta } from './meta.js'
import { createTracing, type Tracing } from './otel.js'
import type {
	ProcedureContext,
	ProcedureInput,
	ProcedureOutput
} from './types.js'

/** Rejects a procedure whose context the caller's context does not satisfy. */
type ContextCheck<TContext, T> = [TContext] extends [ProcedureContext<T>]
	? unknown
	: {
			'orpc-fn: the calling context does not satisfy this procedure': ProcedureContext<T>
		}

/**
 * Calls another procedure with the caller's context and signal. `TContext` is
 * the caller's context; the callee must accept it.
 */
export type BoundCall<TContext> = <T extends AnyProcedure>(
	procedure: T & ContextCheck<TContext, T>,
	...args: undefined extends ProcedureInput<T>
		? [input?: ProcedureInput<T>]
		: [input: ProcedureInput<T>]
) => Promise<ProcedureOutput<T>>

const noTracing = createTracing(undefined)

/**
 * Creates a bound call: nested calls keep the caller's context and abort
 * signal and run inside a `call: <name>` child span, so the trace shows the
 * whole call tree. oRPC's `call` runs the callee's own middleware and guards.
 *
 * Handlers get one as `call`. Outside a handler (seeders, tests) use
 * `createCall` from `createFn`, which traces with the instance's OpenTelemetry.
 */
export function createBoundCall<TContext>(
	context: TContext,
	signal?: AbortSignal,
	tracing: Tracing = noTracing
): BoundCall<TContext> {
	return ((procedure: AnyProcedure, input: unknown) => {
		const name = readFnMeta(procedure).name ?? 'unknown_procedure'
		return tracing.inSpan(`call: ${name}`, 'INTERNAL', async (span) => {
			signal?.throwIfAborted()
			span?.setAttribute('rpc.method', name)
			return call(procedure, input, signal ? { context, signal } : { context })
		})
	}) as BoundCall<TContext>
}
