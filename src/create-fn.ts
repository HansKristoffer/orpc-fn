import type { AnySchema } from '@orpc/contract'
import type { AnyProcedure } from '@orpc/server'
import { type BoundCall, createBoundCall } from './bound-call.js'
import { isExpectedClientError } from './expected-client-error.js'
import { createFnLive, type FnLive } from './live/fn-live.js'
import {
	type CreatePublisher,
	type CreatePubSub,
	createLiveRuntime,
	type PubSubRuntimeOptions
} from './live/pub-sub.js'
import {
	createDefaultLogger,
	type FnLogger,
	type LogAttributes
} from './logger.js'
import {
	FN_META_KEY,
	type FnMeta,
	readFnMeta,
	type StoredFnMeta
} from './meta.js'
import {
	type AttributeValue,
	createTracing,
	errorMessageOf,
	type OtelApiLike,
	type SpanLike,
	type SpanOf
} from './otel.js'
import { createRouter } from './router.js'
import {
	type AnyFnContext,
	type BuilderLike,
	type BuildProcedure,
	type FiniteExtras,
	type Fn,
	type FnCompletedEvent,
	type FnDefinition,
	type Guard,
	type GuardParams,
	type MaybePromise,
	type RejectKeys,
	RESERVED_OPTION_KEYS,
	ROUTE_OPTION_KEYS,
	type ReservedOptionKey
} from './types.js'

/** Builder methods `createFn` calls; `BuilderLike` is the public constraint. */
type BuilderChain = {
	route(route: Record<string, unknown>): BuilderChain
	meta(meta: Record<string, unknown>): BuilderChain
	input(schema: AnySchema): BuilderChain
	output(schema: AnySchema): BuilderChain
	handler(handler: Parameters<BuildProcedure>[0]['handler']): AnyProcedure
}

/** `CreateFnOptions` with the generics erased: what the implementation reads. */
type RuntimeOptions = {
	procedures: Record<string, BuilderChain>
	default?: string
	extras?: (params: Record<string, unknown>) => unknown
	guards?: Record<
		string,
		(value: unknown, params: GuardParams<unknown, unknown>) => unknown
	>
	otel?: OtelApiLike
	logger?: (scope: string, span: SpanLike | undefined) => FnLogger
	spanAttributes?: (params: {
		context: unknown
		name: string
		procedure: string
		meta: Record<string, unknown>
	}) => Record<string, AttributeValue | undefined>
	onCompleted?: (event: FnCompletedEvent) => LogAttributes | undefined
	isExpectedError?: (error: unknown) => boolean
	pubsub?: PubSubRuntimeOptions
}

type UnionContext<TProcedures extends Record<string, BuilderLike>> =
	AnyFnContext<{
		procedures: TProcedures
		default: string
		extras: object
		guards: object
		meta: object
		tag: string
		span: SpanLike
		logger: FnLogger
	}>

export type CreateFnOptions<
	TProcedures extends Record<string, BuilderLike>,
	TDefault extends keyof TProcedures & string,
	TExtras extends object,
	TGuards,
	TMeta extends object,
	TTag extends string,
	TOtel extends OtelApiLike | undefined,
	TLogger extends FnLogger
> = {
	/** Named oRPC builders, e.g. `{ public: os.$context<Ctx>(), protected: authed }`. */
	procedures: TProcedures
	/**
	 * Builder used when a route omits `procedure`. Leave it out to make every
	 * route name its procedure, so none gets one by accident.
	 */
	default?: TDefault
	/** Per-call values merged into every handler's params; may be async. */
	extras?: (params: {
		context: UnionContext<TProcedures>
		span: SpanOf<TOtel> | undefined
		signal: AbortSignal | undefined
		name: string
		procedure: string
	}) => MaybePromise<TExtras>
	/**
	 * Checks run before the handler; each key becomes a typed `fn()` option.
	 * Keys must not reuse route options or meta keys.
	 */
	guards?: TGuards &
		Record<
			string,
			Guard<never, GuardParams<UnionContext<TProcedures>, TMeta>>
		> &
		RejectKeys<
			NoInfer<TGuards>,
			ReservedOptionKey | keyof NoInfer<TMeta>,
			'orpc-fn: this guard name is a route option or meta key'
		>
	/**
	 * Typed route metadata: `meta: {} as { readOnly?: boolean }`. Keys become
	 * `fn()` options and must not reuse route options.
	 */
	meta?: TMeta &
		RejectKeys<
			NoInfer<TMeta>,
			ReservedOptionKey,
			'orpc-fn: this meta key is a route option'
		>
	/** Allowed route tags: `tags: ['internal', 'external']`. */
	tags?: readonly TTag[]
	/** `import * as otel from '@opentelemetry/api'`. Omit for no tracing. */
	otel?: TOtel
	logger?: (scope: string, span: SpanOf<TOtel> | undefined) => TLogger
	/** Extra span attributes per call; undefined values are skipped. */
	spanAttributes?: (params: {
		context: UnionContext<TProcedures>
		name: string
		procedure: string
		meta: Partial<TMeta>
	}) => Record<string, AttributeValue | undefined>
	/** Called after every handler; returned attributes join the `fn.completed` log. */
	onCompleted?: (
		event: FnCompletedEvent<UnionContext<TProcedures>, SpanOf<TOtel>>
		// biome-ignore lint/suspicious/noConfusingVoidType: lets hooks that return nothing type-check
	) => LogAttributes | undefined | void
	/** Errors that are the caller's fault, logged at `warn`. Default: 4xx `ORPCError` or `AbortError`. */
	isExpectedError?: (error: unknown) => boolean
	/** Needed for `fnLive` and `createPubSub`. */
	pubsub?: PubSubRuntimeOptions
}

type Definition<
	TProcedures extends Record<string, BuilderLike>,
	TDefault extends string,
	TExtras extends object,
	TGuards,
	TMeta extends object,
	TTag extends string,
	TOtel,
	TLogger extends FnLogger
> = {
	procedures: TProcedures
	default: TDefault
	extras: TExtras
	guards: TGuards
	meta: TMeta
	tag: TTag
	span: SpanOf<TOtel>
	logger: TLogger
}

export type FnFactory<TDef extends FnDefinition> = {
	fn: Fn<TDef>
	fnLive: FnLive<TDef>
	createPubSub: CreatePubSub<TDef>
	createPublisher: CreatePublisher
	createRouter: typeof createRouter
	readMeta: (procedure: AnyProcedure) => FnMeta<TDef['meta']>
	/**
	 * A `call` outside any handler (seeders, scripts, tests), traced with this
	 * instance's OpenTelemetry.
	 */
	createCall: <TContext>(
		context: TContext,
		signal?: AbortSignal
	) => BoundCall<TContext>
	/** End every open subscription of this instance; returns how many closed. */
	drainPubSubSubscribers: () => number
	activePubSubSubscriberCount: () => number
}

/**
 * Builds the app's `fn` and friends once. Everything app-specific (auth,
 * context, database, queues, i18n, permissions) is injected here.
 */
export function createFn<
	const TProcedures extends Record<string, BuilderLike>,
	TDefault extends keyof TProcedures & string = never,
	TExtras extends object = Record<never, never>,
	TGuards extends object = Record<never, never>,
	TMeta extends object = Record<never, never>,
	const TTag extends string = string,
	TOtel extends OtelApiLike | undefined = undefined,
	TLogger extends FnLogger = FnLogger
>(
	options: CreateFnOptions<
		TProcedures,
		TDefault,
		TExtras,
		TGuards,
		TMeta,
		TTag,
		TOtel,
		TLogger
	> &
		FiniteExtras<NoInfer<TExtras>>
): FnFactory<
	Definition<
		TProcedures,
		TDefault,
		TExtras,
		TGuards,
		TMeta,
		TTag,
		TOtel,
		TLogger
	>
> {
	const runtime = options as unknown as RuntimeOptions
	const tracing = createTracing(runtime.otel)
	const defaultLogger = createDefaultLogger('fn')
	const createLogger =
		runtime.logger ??
		((scope: string) =>
			scope === 'fn' ? defaultLogger : createDefaultLogger(scope))
	const isExpectedError = runtime.isExpectedError ?? isExpectedClientError
	const guards = runtime.guards ?? {}
	const isGuard = (option: string) => Object.hasOwn(guards, option)
	for (const guard of Object.keys(guards)) {
		if ((RESERVED_OPTION_KEYS as readonly string[]).includes(guard)) {
			throw new Error(
				`orpc-fn: guard "${guard}" reuses a route option name; rename it`
			)
		}
	}
	for (const [key, builder] of Object.entries(runtime.procedures)) {
		const def = (builder as { '~orpc'?: Record<string, unknown> })['~orpc']
		if (def?.inputSchema !== undefined || def?.outputSchema !== undefined) {
			throw new Error(
				`orpc-fn: procedure "${key}" sets an input or output schema; set schemas on routes instead`
			)
		}
	}

	const resolveKey = (procedure: string | undefined, name: string) => {
		const key = procedure ?? runtime.default
		if (key === undefined) {
			throw new Error(
				`orpc-fn: "${name}" needs a procedure; createFn has no default`
			)
		}
		return key
	}

	const buildProcedure: BuildProcedure = (route) => {
		const key = resolveKey(route.procedure, route.name)
		let builder = runtime.procedures[key]
		if (!builder) throw new Error(`orpc-fn: unknown procedure "${key}"`)
		const stored: StoredFnMeta = {
			name: route.name,
			procedure: key,
			meta: route.meta
		}
		builder = builder
			.route({
				operationId: route.name,
				...Object.fromEntries(
					Object.entries(route.route).filter(([, value]) => value !== undefined)
				)
			})
			.meta({ [FN_META_KEY]: stored })
		if (route.input) builder = builder.input(route.input)
		if (route.output) builder = builder.output(route.output)
		return builder.handler(route.handler)
	}

	// biome-ignore lint/suspicious/noExplicitAny: the overloads in `Fn` carry the types
	const fn = (routeOptions: any): AnyProcedure => {
		const { handler, input, output, name, procedure, ...rest } = routeOptions
		const key = resolveKey(procedure, name)
		const route: Record<string, unknown> = {}
		const guardChecks: Array<[string, unknown]> = []
		const meta: Record<string, unknown> = {}
		for (const [option, value] of Object.entries(rest)) {
			if (value === undefined) continue
			if ((ROUTE_OPTION_KEYS as readonly string[]).includes(option))
				route[option] = value
			else if (isGuard(option)) guardChecks.push([option, value])
			else meta[option] = value
		}

		return buildProcedure({
			name,
			procedure: key,
			route,
			meta,
			input,
			output,
			handler: (params) => {
				const { context, signal } = params
				const startTime = performance.now()
				const elapsedMs = () =>
					Math.round((performance.now() - startTime) * 100) / 100
				let logger: FnLogger = defaultLogger
				return tracing.inSpan(
					name,
					'SERVER',
					async (span) => {
						logger = createLogger('fn', span)
						span?.setAttribute('fn.operation', name)
						span?.setAttribute('fn.procedure', key)
						const attributes = runtime.spanAttributes?.({
							context,
							name,
							procedure: key,
							meta
						})
						for (const [attribute, value] of Object.entries(attributes ?? {})) {
							if (value !== undefined) span?.setAttribute(attribute, value)
						}
						try {
							for (const [guard, value] of guardChecks) {
								await guards[guard]?.(value, {
									context,
									input: params.input,
									name,
									procedure: key,
									meta,
									signal
								})
							}
							const extras = await runtime.extras?.({
								context,
								span,
								signal,
								name,
								procedure: key
							})
							return await handler({
								...(extras as object | undefined),
								input: params.input,
								context,
								call: createBoundCall(context, signal, tracing),
								signal,
								span,
								logger
							})
						} finally {
							// Server-Timing reports the time until the result (or stream) exists.
							const timing = context.timing
							if (typeof timing === 'object' && timing !== null) {
								;(timing as Record<string, unknown>).handler_ms = elapsedMs()
							}
						}
					},
					// After the result, or after a returned stream ends; before the span ends.
					(span, ...error) => {
						const durationMs = elapsedMs()
						span?.setAttribute('fn.duration_ms', durationMs)
						logCompleted(logger, {
							name,
							procedure: key,
							durationMs,
							success: error.length === 0,
							error: error[0],
							input: params.input,
							context,
							span,
							meta
						})
					}
				)
			}
		})
	}

	const logCompleted = (logger: FnLogger, event: FnCompletedEvent) => {
		const { error, success } = event
		const timing = (event.context as { timing?: unknown }).timing
		const timingFields: LogAttributes = {}
		if (typeof timing === 'object' && timing !== null) {
			for (const [field, value] of Object.entries(timing)) {
				if (field !== 'handler_ms' && typeof value === 'number') {
					timingFields[field] = value
				}
			}
		}
		let extra: LogAttributes | undefined
		try {
			extra = runtime.onCompleted?.(event)
		} catch (hookError) {
			logger.warn('onCompleted hook failed', {
				error: errorMessageOf(hookError)
			})
		}
		const level = success ? 'info' : isExpectedError(error) ? 'warn' : 'error'
		logger[level]('fn.completed', {
			event: 'fn.completed',
			operation: event.name,
			procedure: event.procedure,
			duration_ms: event.durationMs,
			status: success ? 'success' : 'failed',
			...timingFields,
			...(error === undefined
				? {}
				: {
						error_type: error instanceof Error ? error.name : typeof error,
						error_message: errorMessageOf(error)
					}),
			...extra
		})
	}

	const live = createLiveRuntime({
		buildProcedure,
		tracing,
		createLogger,
		pubsub: runtime.pubsub
	})

	// The runtimes are untyped; `Fn`, `FnLive`, `CreatePubSub` and
	// `CreatePublisher` are their typed surface.
	return {
		fn: fn as never,
		fnLive: createFnLive({
			fn,
			createChannel: live.createChannel,
			createLogger,
			isGuard
		}) as never,
		createPubSub: live.createPubSub as never,
		createPublisher: live.createPublisher as never,
		createRouter,
		readMeta: (procedure) => readFnMeta(procedure),
		createCall: (context, signal) => createBoundCall(context, signal, tracing),
		drainPubSubSubscribers: live.drainPubSubSubscribers,
		activePubSubSubscriberCount: live.activePubSubSubscriberCount
	}
}
