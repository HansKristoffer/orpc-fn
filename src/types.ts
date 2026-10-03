import type { ErrorMap, Meta, Schema } from '@orpc/contract'
import type { DecoratedProcedure, Procedure, Route } from '@orpc/server'
import type { ZodType, z } from 'zod'
import type { BoundCall } from './bound-call.js'
import type { FnLogger } from './logger.js'
import type { SpanLike } from './otel.js'

export type MaybePromise<T> = T | Promise<T>

/** Anything with oRPC's builder chain: `os`, `os.$context<T>()`, `os.use(...)`. */
export type BuilderLike = {
	// biome-ignore lint/suspicious/noExplicitAny: matches every builder's generic handler
	handler(handler: any): Procedure<any, any, any, any, any, any>
}

type ProcedureOf<TBuilder> = TBuilder extends {
	handler(handler: never): infer TProcedure
}
	? TProcedure
	: never

/** Context a route built from this builder is called with. */
export type InitialContextOf<TBuilder> =
	ProcedureOf<TBuilder> extends Procedure<
		infer TContext,
		infer _TCurrent,
		infer _TIn,
		infer _TOut,
		infer _TErrors,
		infer _TMeta
	>
		? TContext
		: never

/** Context the handler sees, after the builder's middleware. */
export type CurrentContextOf<TBuilder> =
	ProcedureOf<TBuilder> extends Procedure<
		infer _TInitial,
		infer TContext,
		infer _TIn,
		infer _TOut,
		infer _TErrors,
		infer _TMeta
	>
		? TContext
		: never

type ErrorMapOf<TBuilder> =
	ProcedureOf<TBuilder> extends Procedure<
		infer _TInitial,
		infer _TCurrent,
		infer _TIn,
		infer _TOut,
		infer TErrors extends ErrorMap,
		infer _TMeta
	>
		? TErrors
		: ErrorMap

type MetaOf<TBuilder> =
	ProcedureOf<TBuilder> extends Procedure<
		infer _TInitial,
		infer _TCurrent,
		infer _TIn,
		infer _TOut,
		infer _TErrors,
		infer TMeta extends Meta
	>
		? TMeta
		: Meta

/**
 * Everything `createFn` inferred from its options. Route types read from it;
 * apps rarely spell it out.
 */
export type FnDefinition = {
	procedures: Record<string, BuilderLike>
	default: string
	extras: object
	guards: object
	meta: object
	tag: string
	span: SpanLike
	logger: FnLogger
}

export type ProcedureKey<TDef extends FnDefinition> = keyof TDef['procedures'] &
	string

/** Context the handler of a `procedure: TKey` route receives. */
export type FnContext<
	TDef extends FnDefinition,
	TKey extends ProcedureKey<TDef>
> = CurrentContextOf<TDef['procedures'][TKey]>

/** Union of every procedure's handler context: what guards and extras see. */
export type AnyFnContext<TDef extends FnDefinition> = {
	[K in ProcedureKey<TDef>]: FnContext<TDef, K>
}[ProcedureKey<TDef>]

export type GuardParams<TContext, TMeta> = {
	context: TContext
	input: unknown
	/** Route name (operationId). */
	name: string
	/** Procedures key the route was built from. */
	procedure: string
	meta: Partial<TMeta>
	signal: AbortSignal | undefined
}

/**
 * A check run before the handler. Its first parameter becomes an option on
 * `fn({...})`; the guard runs only on routes that set it. Throw (usually an
 * `ORPCError`) to refuse the call.
 */
export type Guard<TValue, TParams> = (value: TValue, params: TParams) => unknown

export type GuardOptions<TGuards> = {
	[K in keyof TGuards]?: TGuards[K] extends (
		value: infer TValue,
		params: never
	) => unknown
		? TValue
		: never
}

export type HandlerParams<
	TDef extends FnDefinition,
	TInput,
	TKey extends ProcedureKey<TDef>
> = Omit<
	TDef['extras'],
	'input' | 'context' | 'call' | 'signal' | 'span' | 'logger'
> & {
	input: TInput
	context: FnContext<TDef, TKey>
	/** Calls another procedure with this context and signal, in a child span. */
	call: BoundCall
	/** Cancellation is inherited by nested calls; pass to interruptible I/O. */
	signal: AbortSignal | undefined
	/** Active OpenTelemetry span, undefined when `createFn({ otel })` is not set. */
	span: TDef['span'] | undefined
	logger: TDef['logger']
}

/** Route options shared by every `fn()` overload. */
export type RouteConfig<TTag extends string = string> = Pick<
	Route,
	| 'path'
	| 'method'
	| 'summary'
	| 'description'
	| 'deprecated'
	| 'successStatus'
	| 'successDescription'
	| 'inputStructure'
	| 'outputStructure'
> & {
	/** Required. Becomes the OpenAPI operationId and the span name (e.g. 'user.create'). */
	name: string
	tags?: TTag[]
}

export type FnRouteOptions<
	TDef extends FnDefinition,
	TKey extends ProcedureKey<TDef>
> = RouteConfig<TDef['tag']> &
	GuardOptions<TDef['guards']> &
	TDef['meta'] & {
		/** Which `createFn({ procedures })` builder to use. Defaults to `default`. */
		procedure?: TKey
	}

export type FnProcedure<
	TDef extends FnDefinition,
	TKey extends ProcedureKey<TDef>,
	TInputSchema extends Schema<unknown, unknown>,
	TOutputSchema extends Schema<unknown, unknown>
> = DecoratedProcedure<
	InitialContextOf<TDef['procedures'][TKey]>,
	FnContext<TDef, TKey>,
	TInputSchema,
	TOutputSchema,
	ErrorMapOf<TDef['procedures'][TKey]>,
	MetaOf<TDef['procedures'][TKey]>
>

/** `fn()`: four overloads for input/output schema × inferred. */
export interface Fn<TDef extends FnDefinition> {
	// 1. With input + output schema
	<
		TInput extends ZodType,
		TOut extends ZodType,
		TKey extends ProcedureKey<TDef> = TDef['default']
	>(
		options: {
			input: TInput
			output: TOut
			handler: (
				params: HandlerParams<TDef, z.infer<TInput>, NoInfer<TKey>>
			) => MaybePromise<z.infer<TOut>>
		} & FnRouteOptions<TDef, TKey>
	): FnProcedure<TDef, TKey, TInput, TOut>

	// 2. With input, inferred output
	<
		TInput extends ZodType,
		TReturn,
		TKey extends ProcedureKey<TDef> = TDef['default']
	>(
		options: {
			input: TInput
			output?: undefined
			handler: (
				params: HandlerParams<TDef, z.infer<TInput>, NoInfer<TKey>>
			) => MaybePromise<TReturn>
		} & FnRouteOptions<TDef, TKey>
	): FnProcedure<TDef, TKey, TInput, Schema<TReturn, TReturn>>

	// 3. No input, with output schema
	<TOut extends ZodType, TKey extends ProcedureKey<TDef> = TDef['default']>(
		options: {
			input?: undefined
			output: TOut
			handler: (
				params: HandlerParams<TDef, unknown, NoInfer<TKey>>
			) => MaybePromise<z.infer<TOut>>
		} & FnRouteOptions<TDef, TKey>
	): FnProcedure<TDef, TKey, Schema<unknown, unknown>, TOut>

	// 4. No input, inferred output
	<TReturn, TKey extends ProcedureKey<TDef> = TDef['default']>(
		options: {
			input?: undefined
			output?: undefined
			handler: (
				params: HandlerParams<TDef, unknown, NoInfer<TKey>>
			) => MaybePromise<TReturn>
		} & FnRouteOptions<TDef, TKey>
	): FnProcedure<TDef, TKey, Schema<unknown, unknown>, Schema<TReturn, TReturn>>
}

/** What `fn.completed` reports, and what `onCompleted` receives. */
export type FnCompletedEvent<TContext = unknown, TSpan = SpanLike> = {
	name: string
	procedure: string
	durationMs: number
	success: boolean
	error: unknown
	input: unknown
	context: TContext
	span: TSpan | undefined
	meta: Record<string, unknown>
}
