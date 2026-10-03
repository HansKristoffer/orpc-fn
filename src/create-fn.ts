import {
	type BuilderChain,
	createProcedureAssembler
} from './assemble-procedure.js'
import { isAsyncIteratorObject } from './stream.js'
import { normalizeRoute } from './route-options.js'
import { type AnyProcedure, ORPCError, os } from '@orpc/server'
import { procedureDefinition } from './compatibility.js'
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
	protectLogger,
	type FnLogger,
	type LogAttributes
} from './logger.js'
import { readFnMeta } from './meta.js'
import {
	type AttributeValue,
	createTracing,
	errorMessageOf,
	type OtelApiLike,
	type SpanLike,
	type SpanOf
} from './otel.js'
import { RAW_INPUT, REQUEST_TIMING, type InvocationTiming } from './timing.js'
import { createRouter } from './router.js'
import {
	type ProcedureHookParams,
	type CompletedHookEvent,
	type CurrentContextOf,
	type BuilderLike,
	type FiniteExtras,
	type ScopedExtrasGuard,
	type Fn,
	type FnCompletedEvent,
	type FnDefinition,
	type Guard,
	type GuardParams,
	type MaybePromise,
	type RejectKeys,
	RESERVED_OPTION_KEYS,
	type ReservedOptionKey
} from './types.js'

/** `CreateFnOptions` with the generics erased: what the implementation reads. */
type RuntimeOptions = {
	procedures: Record<string, BuilderChain>
	default?: string
	extras?: (params: Record<string, unknown>) => unknown
	extrasByProcedure?: Record<
		string,
		(params: Record<string, unknown>) => unknown
	>
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

export type CreateFnOptions<
	TProcedures extends Record<string, BuilderLike>,
	TDefault extends keyof TProcedures & string,
	TExtras extends object,
	TGuards,
	TMeta extends object,
	TTag extends string,
	TOtel extends OtelApiLike | undefined,
	TLogger extends FnLogger,
	TScoped extends Partial<Record<keyof TProcedures, object>> = Record<
		never,
		never
	>
> = {
	/** Named oRPC builders, e.g. `{ public: os.$context<Ctx>(), protected: authed }`. */
	procedures: TProcedures
	/**
	 * Builder used when a route omits `procedure`. Leave it out to make every
	 * route name its procedure, so none gets one by accident.
	 */
	default?: TDefault
	/** Per-call values merged into every handler's params; may be async. */
	extras?: (
		params: ProcedureHookParams<
			TProcedures,
			{
				span: SpanOf<TOtel> | undefined
				signal: AbortSignal | undefined
				name: string
			}
		>
	) => MaybePromise<TExtras>
	extrasByProcedure?: {
		[K in keyof TScoped & keyof TProcedures]: (params: {
			context: CurrentContextOf<TProcedures[K]>
			span: SpanOf<TOtel> | undefined
			signal: AbortSignal | undefined
			name: string
			procedure: K
		}) => MaybePromise<TScoped[K] & ScopedExtrasGuard<NoInfer<TScoped[K]>>>
	}
	/**
	 * Checks run before the handler; each key becomes a typed `fn()` option.
	 * Keys must not reuse route options. False denies, true or void allows.
	 */
	guards?: TGuards &
		Record<
			string,
			Guard<
				never,
				ProcedureHookParams<
					TProcedures,
					Omit<GuardParams<unknown, TMeta>, 'context' | 'procedure'>
				>
			>
		> &
		RejectKeys<
			NoInfer<TGuards>,
			ReservedOptionKey,
			'orpc-fn: this guard name is a route option'
		>
	/**
	 * Typed route metadata contract: `meta: defineMeta<AppMeta>()`.
	 * Route declarations place values inside their own `meta` object.
	 */
	meta?: TMeta
	/** Allowed route tags: `tags: ['internal', 'external']`. */
	tags?: readonly TTag[]
	/** `import * as otel from '@opentelemetry/api'`. Omit for no tracing. */
	otel?: TOtel
	logger?: (scope: string, span: SpanOf<TOtel> | undefined) => TLogger
	/** Extra span attributes per call; undefined values are skipped. */
	spanAttributes?: (
		params: ProcedureHookParams<
			TProcedures,
			{ name: string; meta: Partial<TMeta> }
		>
	) => Record<string, AttributeValue | undefined>
	/** Called after the procedure (or stream) settles; returned attributes join the `fn.completed` log. */
	onCompleted?: (
		event: CompletedHookEvent<TProcedures, SpanOf<TOtel>>
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
	TLogger extends FnLogger,
	TScoped extends Partial<Record<keyof TProcedures, object>> = Record<
		never,
		never
	>
> = {
	procedures: TProcedures
	default: TDefault
	extras: TExtras
	extrasByProcedure: TScoped
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
	readMeta: typeof readFnMeta
	/**
	 * A `call` outside any handler (seeders, scripts, tests), traced with this
	 * instance's OpenTelemetry.
	 */
	createCall: <TContext>(
		context: TContext,
		signal?: AbortSignal
	) => BoundCall<TContext>
	/** Terminal, idempotent shutdown: close streams and await owned resources. */
	shutdown: () => Promise<void>
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
	TLogger extends FnLogger = FnLogger,
	TScoped extends Partial<Record<keyof TProcedures, object>> = Record<
		never,
		never
	>
>(
	options: CreateFnOptions<
		TProcedures,
		TDefault,
		TExtras,
		TGuards,
		TMeta,
		TTag,
		TOtel,
		TLogger,
		TScoped
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
		TLogger,
		TScoped
	>
> {
	const runtime = options as unknown as RuntimeOptions
	const tracing = createTracing(runtime.otel)
	const defaultLogger = protectLogger(createDefaultLogger('fn'))
	const createLogger = (
		scope: string,
		span: SpanLike | undefined
	): FnLogger => {
		try {
			return protectLogger(
				runtime.logger?.(scope, span) ??
					(scope === 'fn' ? defaultLogger : createDefaultLogger(scope))
			)
		} catch {
			return defaultLogger
		}
	}
	const isExpectedError = runtime.isExpectedError ?? isExpectedClientError
	const guards = runtime.guards ?? {}
	const isGuard = (option: string) => Object.hasOwn(guards, option)
	for (const guard of Object.keys(guards)) {
		if (typeof guards[guard] !== 'function')
			throw new TypeError(`orpc-fn: guard ${guard} must be a function`)
		if ((RESERVED_OPTION_KEYS as readonly string[]).includes(guard)) {
			throw new Error(
				`orpc-fn: guard "${guard}" reuses a route option name; rename it`
			)
		}
	}
	if (runtime.default && !Object.hasOwn(runtime.procedures, runtime.default))
		throw new TypeError(`orpc-fn: unknown default procedure ${runtime.default}`)
	for (const [key, builder] of Object.entries(runtime.procedures)) {
		const def = procedureDefinition(builder)
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

	const buildProcedure = createProcedureAssembler(
		runtime.procedures,
		resolveKey
	)

	const invocation = Symbol('orpc-fn.invocation')
	type Invocation = {
		span: SpanLike | undefined
		logger: FnLogger
		input: unknown
		context: unknown
		handlerStarted: boolean
		rawInput: unknown
	}
	// The overload-to-runtime boundary is adapted once at the returned factory.
	const fn = (routeOptions: Record<string, unknown>): AnyProcedure => {
		const {
			handler,
			input,
			output,
			name,
			procedure,
			meta,
			stream,
			errors,
			guardResolvers,
			route,
			guardChecks
		} = normalizeRoute(routeOptions, isGuard)
		const key = resolveKey(procedure, name)
		const built = buildProcedure({
			name,
			procedure: key,
			route,
			meta,
			input,
			output,
			stream,
			...(errors ? { errors } : {}),
			handler: async (params) => {
				const { context, signal } = params
				const state = context[invocation] as Invocation
				const { [invocation]: _invocation, ...observedContext } = context
				state.context = observedContext
				state.input = params.input
				state.handlerStarted = true
				try {
					const attributes = runtime.spanAttributes?.({
						context,
						name,
						procedure: key,
						meta
					})
					for (const [attribute, value] of Object.entries(attributes ?? {}))
						if (value !== undefined) state.span?.setAttribute(attribute, value)
				} catch (error) {
					state.logger.warn('spanAttributes hook failed', {
						error: errorMessageOf(error)
					})
				}
				const resolvedChecks = [...guardChecks]
				for (const [guard, resolver] of Object.entries(guardResolvers)) {
					const value = await resolver({ input: params.input, context, signal })
					if (value !== undefined) resolvedChecks.push([guard, value])
				}
				for (const [guard, value] of resolvedChecks) {
					const result = await guards[guard]?.(value, {
						context,
						input: params.input,
						name,
						procedure: key,
						meta,
						signal
					})
					if (result === false)
						throw new ORPCError('FORBIDDEN', {
							message: `Guard "${guard}" denied this call`
						})
					if (result !== undefined && result !== true)
						throw new TypeError(
							`orpc-fn: guard "${guard}" must return void or boolean`
						)
				}
				const extraParams = {
					context,
					span: state.span,
					signal,
					name,
					procedure: key
				}
				const shared = await runtime.extras?.(extraParams)
				const scoped = await runtime.extrasByProcedure?.[key]?.(extraParams)
				const extras = {
					...(shared as object | undefined),
					...(scoped as object | undefined)
				}
				if (extras && typeof extras === 'object') {
					for (const reserved of [
						'input',
						'context',
						'call',
						'signal',
						'span',
						'logger',
						'errors',
						'lastEventId'
					]) {
						if (Object.hasOwn(extras, reserved))
							throw new TypeError(
								`orpc-fn: extra "${reserved}" shadows a handler parameter`
							)
					}
				}
				return handler({
					...(extras as object | undefined),
					input: params.input,
					context,
					call: createBoundCall(context, signal, tracing),
					signal,
					span: state.span,
					logger: state.logger,
					errors: params.errors,
					lastEventId: params.lastEventId,
					[RAW_INPUT]: state.rawInput
				})
			}
		})
		// Prepending middleware shifts oRPC's validation indexes, covering auth,
		// input validation, output validation, and the final stream lifetime.
		return os
			.use(async ({ context, next }, rawInput) => {
				const started = performance.now()
				const state: Invocation = {
					span: undefined,
					logger: defaultLogger,
					input: undefined,
					context,
					handlerStarted: false,
					rawInput
				}
				const result = await tracing.inSpan(
					name,
					'SERVER',
					async (span) => {
						state.span = span
						state.logger = createLogger('fn', span)
						span?.setAttribute('fn.operation', name)
						span?.setAttribute('fn.procedure', key)
						try {
							const result = await next({ context: { [invocation]: state } })
							if (isAsyncIteratorObject(result.output) !== stream) {
								if (isAsyncIteratorObject(result.output)) {
									try {
										await result.output.return?.()
									} catch {
										/* Release the unexpected stream. */
									}
								}
								throw new TypeError(
									`orpc-fn: ${name} returned a result inconsistent with stream; declare stream: true for iterators`
								)
							}
							return result.output
						} finally {
							const timing = (context as Record<symbol, unknown>)[
								REQUEST_TIMING
							] as InvocationTiming | undefined
							if (timing && !(context as Record<symbol, unknown>)[invocation]) {
								timing.procedureMs += performance.now() - started
								timing.calls++
							}
						}
					},
					(span, ...error) => {
						const durationMs =
							Math.round((performance.now() - started) * 100) / 100
						span?.setAttribute('fn.duration_ms', durationMs)
						logCompleted(state.logger, {
							name,
							procedure: key,
							durationMs,
							success: error.length === 0,
							error: error[0],
							input: state.input,
							context: state.context,
							span,
							meta,
							handlerStarted: state.handlerStarted
						})
					}
				)
				return { output: result, context }
			})
			.router({ route: built }).route
	}

	const logCompleted = (logger: FnLogger, event: FnCompletedEvent) => {
		const { error, success } = event
		let extra: LogAttributes | undefined
		try {
			extra = runtime.onCompleted?.(event)
		} catch (hookError) {
			logger.warn('onCompleted hook failed', {
				error: errorMessageOf(hookError)
			})
		}
		let expected = false
		try {
			expected = isExpectedError(error)
		} catch {
			expected = isExpectedClientError(error)
		}
		const level = success ? 'info' : expected ? 'warn' : 'error'
		logger[level]('fn.completed', {
			...extra,
			event: 'fn.completed',
			operation: event.name,
			procedure: event.procedure,
			duration_ms: event.durationMs,
			status: success ? 'success' : 'failed',
			...(error === undefined
				? {}
				: {
						error_type: error instanceof Error ? error.name : typeof error,
						error_message: errorMessageOf(error)
					})
		})
	}

	const live = createLiveRuntime({
		fn,
		tracing,
		createLogger,
		pubsub: runtime.pubsub
	})

	// The runtimes are untyped; `Fn`, `FnLive`, `CreatePubSub` and
	// `CreatePublisher` are their typed surface.
	return {
		fn,
		fnLive: createFnLive({
			fn,
			createChannel: live.createChannel,
			createLogger,
			isGuard
		}),
		createPubSub: live.createPubSub,
		createPublisher: live.createPublisher,
		createRouter,
		readMeta: readFnMeta,
		createCall: <TContext>(context: TContext, signal?: AbortSignal) =>
			createBoundCall(context, signal, tracing),
		shutdown: live.shutdown,
		drainPubSubSubscribers: live.drainPubSubSubscribers,
		activePubSubSubscriberCount: live.activePubSubSubscriberCount
	} as unknown as FnFactory<
		Definition<
			TProcedures,
			TDefault,
			TExtras,
			TGuards,
			TMeta,
			TTag,
			TOtel,
			TLogger,
			TScoped
		>
	>
}
