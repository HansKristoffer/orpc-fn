import type {
	AnySchema,
	InferSchemaInput,
	InferSchemaOutput
} from '@orpc/contract'
import { type AnyProcedure, call, type Procedure } from '@orpc/server'
import { readFnMeta } from './meta.js'
import type { Tracing } from './otel.js'

type InferInput<T> =
	T extends Procedure<
		infer _TInitialContext,
		infer _TCurrentContext,
		infer TInputSchema extends AnySchema,
		AnySchema,
		infer _TErrorMap,
		infer _TMeta
	>
		? InferSchemaInput<TInputSchema>
		: unknown

type InferOutput<T> =
	T extends Procedure<
		infer _TInitialContext,
		infer _TCurrentContext,
		AnySchema,
		infer TOutputSchema extends AnySchema,
		infer _TErrorMap,
		infer _TMeta
	>
		? InferSchemaOutput<TOutputSchema>
		: unknown

/** Calls another procedure with the caller's context and signal. */
export type BoundCall = <T extends AnyProcedure>(
	procedure: T,
	input: InferInput<T>
) => Promise<InferOutput<T>>

/**
 * Creates a bound call: nested `fn` calls keep the caller's context and abort
 * signal and run inside a `call: <name>` child span, so the trace shows the
 * whole call tree. oRPC's `call` runs the callee's own middleware and guards.
 */
export function createBoundCall(
	context: unknown,
	signal: AbortSignal | undefined,
	tracing: Tracing
): BoundCall {
	return ((procedure: AnyProcedure, input: unknown) => {
		const name = readFnMeta(procedure).name ?? 'unknown_procedure'
		return tracing.inSpan(`call: ${name}`, 'INTERNAL', async (span) => {
			try {
				signal?.throwIfAborted()
				span?.setAttribute('rpc.method', name)
				const result = await call(
					procedure,
					input,
					signal ? { context, signal } : { context }
				)
				tracing.ok(span)
				return result
			} catch (error) {
				tracing.fail(span, error)
				throw error
			} finally {
				span?.end()
			}
		})
	}) as BoundCall
}
