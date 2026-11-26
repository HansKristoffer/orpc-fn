import {
	type BuilderChain,
	createProcedureAssembler
} from './assemble-procedure.js'
import { isAsyncIteratorObject } from './stream.js'
import { normalizeRoute } from './route-options.js'
import type { AnyProcedureContract } from '@orpc/contract'
import { type AnyProcedure, ORPCError, os } from '@orpc/server'
import { decorateProcedure, procedureDefinition } from './compatibility.js'
import { type BoundCall, createBoundCall } from './bound-call.js'
import { isExpectedClientError, markExpected } from './expected-client-error.js'
import {
	createFnLive,
	type FnLive,
	fnLivePatch,
	type GuardRunner
} from './live/fn-live.js'
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
import { type FnMeta, readFnMeta } from './meta.js'
import {
	type AttributeValue,
	createTracing,
	errorAttributes,
	errorMessageOf,
	type OtelApiLike,
	type SpanLike,
	type SpanOf
} from './otel.js'
import {
	EXTRAS_OVERRIDE,
	REQUEST_TIMING,
	type InvocationTiming
} from './timing.js'
import { createRouter } from './router.js'
import {
	type ProcedureHookParams,
	type ProcedureSpecOf,
	type CompletedHookEvent,
	type CurrentContextOf,
	type BuilderLike,
	type FiniteExtras,
	type ScopedExtrasGuard,
	type Fn,
	type FnCompletedEvent,
	type FnDefinition,
	type Guard,
	type GuardOptions,
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
		((params: Record<string, unknown>) => unknown) | undefined
	>
	guards?: Record<
		string,
		(value: unknown, params: GuardParams<unknown, unknown>) => unknown
	>
	tags?: readonly string[]
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
	errorMessages?: 'all' | 'unexpected'
	routePolicy?: (route: Record<string, unknown>) => void
	pubsub?: PubSubRuntimeOptions
}

const INVOCATION = Symbol('orpc-fn.invocation')
const HANDLER_PARAM_KEYS = [
	'input',
	'context',
	'call',
	'signal',
	'span',
	'logger',
	'errors',
	'lastEventId'
] as const

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === 'function'
	)
}

/** What `routePolicy` sees of each route when it is defined. */
export type RoutePolicyParams<
	TKey extends string = string,
	TGuards = Record<string, unknown>,
	TMeta extends object = Record<string, unknown>,
	TTag extends string = string
> = {
	name: string
	procedure: TKey
	/** Guard values set on the route itself. */
	guards: GuardOptions<TGuards>
	/** Guards the route decides per call through `guardResolvers`. */
	dynamicGuards: readonly (keyof TGuards & string)[]
	meta: Partial<TMeta>
	stream: boolean
	tags: readonly TTag[]
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
	/**
	 * Errors that are the caller's fault: logged at `warn`, and their span keeps
	 * an unset status. `mountOrpc` and the tool adapters follow it for errors
	 * a route threw. Default: 4xx `ORPCError` or `AbortError`.
	 */
	isExpectedError?: (error: unknown) => boolean
	/**
	 * `'unexpected'` leaves the message of expected errors out of `fn.completed`
	 * (it was written for the caller and may name what they asked for);
	 * `error_code` and `error_type` stay. Default: `'all'`.
	 */
	errorMessages?: 'all' | 'unexpected'
	/**
	 * Sees every route (`fn`, `fnLive`, pub/sub subscriptions) when it is
	 * defined; throw to reject it, e.g. a protected route with no permission:
	 * `if (procedure === 'protected' && !('permission' in guards)) throw ...`.
	 */
	routePolicy?: (
		route: RoutePolicyParams<
			keyof TProcedures & string,
			NoInfer<TGuards>,
			NoInfer<TMeta>,
			NoInfer<TTag>
		>
	) => void
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
	procedures: { [K in keyof TProcedures]: ProcedureSpecOf<TProcedures[K]> }
	default: TDefault
	extras: TExtras
	extrasByProcedure: TScoped
	guards: TGuards
	meta: TMeta
	tag: TTag
	span: SpanOf<TOtel>
	logger: TLogger
}

type AllExtras<TDef extends FnDefinition> =
	| TDef['extras']
	| (TDef extends { extrasByProcedure: infer E }
			? [keyof E] extends [never]
				? never
				: NonNullable<E[keyof E]>
			: never)

type UnionKeys<T> = T extends unknown ? keyof T : never
type PropertyValue<T, K extends PropertyKey> = T extends unknown
	? K extends keyof T
		? T[K]
		: never
	: never

/** Extras a test call may replace: any shared or scoped extra. */
export type TestCallExtras<TDef extends FnDefinition> = {
	[K in UnionKeys<AllExtras<TDef>>]?: PropertyValue<AllExtras<TDef>, K>
}

export type FnFactory<TDef extends FnDefinition> = {
	fn: Fn<TDef>
	fnLive: FnLive<TDef>
	/** Same as `fnLivePatch` from `orpc-fn/live`. */
	fnLivePatch: typeof fnLivePatch
	createPubSub: CreatePubSub<TDef>
	createPublisher: CreatePublisher
	createRouter: typeof createRouter
	/** `readFnMeta`, with guard values typed by this factory's guards. */
	readMeta: <T extends AnyProcedure | AnyProcedureContract>(
		procedure: T
	) => Omit<ReturnType<typeof readFnMeta<T>>, 'guards' | 'dynamicGuards'> & {
		guards: GuardOptions<TDef['guards']>
		dynamicGuards: readonly (keyof TDef['guards'] & string)[]
	}
	/**
	 * A `call` outside any handler (seeders, scripts, tests), traced with this
	 * instance's OpenTelemetry.
	 */
	createCall: <TContext>(
		context: TContext,
		signal?: AbortSignal
	) => BoundCall<TContext>
	/**
	 * `createCall` for tests: middleware, guards and schemas run as in
	 * production, and `extras` replace the configured ones (`{ db: fakeDb }`)
	 * for this call and the calls it makes.
	 */
	createTestCall: <TContext>(
		context: TContext,
		options?: { extras?: TestCallExtras<TDef>; signal?: AbortSignal }
	) => BoundCall<TContext>
	/** Terminal, idempotent shutdown: close streams and await owned resources. */
	shutdown: () => Promise<void>
	/**
	 * End every open subscription and return how many were closed. With
	 * `overMs`, spread the closes evenly over that window so clients do not
	 * reconnect in one burst; the promise resolves after the last one.
	 */
	drainPubSubSubscribers: {
		(): number
		(options: { overMs: number }): Promise<number>
	}
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
	const configuredExpected = runtime.isExpectedError ?? isExpectedClientError
	const isExpectedError = (error: unknown) => {
		let expected: boolean
		try {
			expected = configuredExpected(error)
		} catch {
			expected = isExpectedClientError(error)
		}
		// Only the app's own rule is remembered: adapters apply the default
		// themselves, under their `errorStatusMap`.
		if (expected && runtime.isExpectedError) markExpected(error)
		return expected
	}
	const tracing = createTracing(runtime.otel, isExpectedError)
	const defaultLogger = createDefaultLogger('fn')
	const createLogger = (
		scope: string,
		span: SpanLike | undefined
	): FnLogger => {
		if (!runtime.logger) {
			return scope === 'fn' ? defaultLogger : createDefaultLogger(scope)
		}
		try {
			return protectLogger(
				runtime.logger(scope, span) ??
					(scope === 'fn' ? defaultLogger : createDefaultLogger(scope))
			)
		} catch {
			return defaultLogger
		}
	}
	if (
		runtime.errorMessages !== undefined &&
		runtime.errorMessages !== 'all' &&
		runtime.errorMessages !== 'unexpected'
	)
		throw new TypeError("orpc-fn: errorMessages must be 'all' or 'unexpected'")
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
		if (def.inputSchemas.length > 0 || def.outputSchemas.length > 0) {
			throw new Error(
				`orpc-fn: procedure "${key}" sets an input or output schema; set schemas on routes instead`
			)
		}
	}
	if (runtime.extrasByProcedure !== undefined) {
		for (const [key, factory] of Object.entries(runtime.extrasByProcedure)) {
			if (factory === undefined) continue
			if (!Object.hasOwn(runtime.procedures, key))
				throw new TypeError(
					`orpc-fn: extrasByProcedure references unknown procedure "${key}"`
				)
			if (typeof factory !== 'function')
				throw new TypeError(
					`orpc-fn: extrasByProcedure "${key}" must be a function`
				)
		}
	}
	const allowedTags = runtime.tags ? new Set(runtime.tags) : undefined

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

	type Invocation = {
		span: SpanLike | undefined
		logger: FnLogger
		input: unknown
		context: unknown
		handlerStarted: boolean
	}
	// Each guarded route's guard runner, for `fnLive` to repeat before updates.
	const guardRunners = new WeakMap<object, GuardRunner>()
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
		} = normalizeRoute(routeOptions, isGuard, allowedTags)
		const key = resolveKey(procedure, name)
		const staticGuards = Object.fromEntries(guardChecks)
		const resolverEntries = Object.entries(guardResolvers)
		const dynamicGuards = resolverEntries.map(([guard]) => guard)
		const hasStaticGuards = guardChecks.length > 0
		const hasDynamicGuards = resolverEntries.length > 0
		const scopedExtras = runtime.extrasByProcedure?.[key]
		runtime.routePolicy?.({
			name,
			procedure: key,
			guards: staticGuards,
			dynamicGuards,
			meta,
			stream,
			tags: (route.tags as string[] | undefined) ?? []
		})
		/** The route's static, then resolved, guards: before the handler, and before each live update. */
		const runGuards = async ({
			input,
			context,
			signal
		}: {
			input: unknown
			context: unknown
			signal: AbortSignal | undefined
		}) => {
			let checks: readonly [string, unknown][] = guardChecks
			if (hasDynamicGuards) {
				const resolved: Array<[string, unknown]> = [...guardChecks]
				for (const [guard, resolver] of resolverEntries) {
					const value = await resolver({ input, context, signal })
					if (value !== undefined) resolved.push([guard, value])
				}
				checks = resolved
			}
			for (const [guard, value] of checks) {
				const rawResult = guards[guard]?.(value, {
					context,
					input,
					name,
					procedure: key,
					meta,
					signal
				})
				const result = isPromiseLike(rawResult) ? await rawResult : rawResult
				if (result === false)
					throw new ORPCError('FORBIDDEN', {
						message: `Guard "${guard}" denied this call`
					})
				if (result !== undefined && result !== true)
					throw new TypeError(
						`orpc-fn: guard "${guard}" must return void or boolean`
					)
			}
		}
		const built = buildProcedure({
			name,
			procedure: key,
			route,
			meta,
			guards: staticGuards,
			dynamicGuards,
			input,
			output,
			stream,
			...(errors ? { errors } : {}),
			handler: async (params) => {
				const { context, signal } = params
				const state = context[INVOCATION] as Invocation
				const overrides = context[EXTRAS_OVERRIDE] as object | undefined
				state.context = context
				state.input = params.input
				state.handlerStarted = true
				if (runtime.spanAttributes) {
					try {
						const attributes = runtime.spanAttributes({
							context,
							name,
							procedure: key,
							meta
						})
						if (attributes) {
							for (const [attribute, value] of Object.entries(attributes))
								if (value !== undefined)
									state.span?.setAttribute(attribute, value)
						}
					} catch (error) {
						state.logger.warn('spanAttributes hook failed', {
							error: errorMessageOf(error)
						})
					}
				}
				if (hasStaticGuards || hasDynamicGuards)
					await runGuards({ input: params.input, context, signal })
				let shared: unknown
				let scoped: unknown
				if (runtime.extras || scopedExtras) {
					const extraParams = {
						context,
						span: state.span,
						signal,
						name,
						procedure: key
					}
					if (runtime.extras) {
						const maybeShared = runtime.extras(extraParams)
						shared = isPromiseLike(maybeShared)
							? await maybeShared
							: maybeShared
					}
					if (scopedExtras) {
						const maybeScoped = scopedExtras(extraParams)
						scoped = isPromiseLike(maybeScoped)
							? await maybeScoped
							: maybeScoped
					}
				}
				const hasExtras =
					shared !== undefined ||
					scoped !== undefined ||
					overrides !== undefined
				let extras: object | undefined
				if (hasExtras) {
					extras = {
						...(shared as object | undefined),
						...(scoped as object | undefined),
						...overrides
					}
					for (const reserved of HANDLER_PARAM_KEYS) {
						if (Object.hasOwn(extras, reserved))
							throw new TypeError(
								`orpc-fn: extra "${reserved}" shadows a handler parameter`
							)
					}
				}
				return handler({
					...extras,
					input: params.input,
					context,
					call: createBoundCall(context, signal, tracing),
					signal,
					span: state.span,
					logger: state.logger,
					errors: params.errors,
					lastEventId: params.lastEventId
				})
			}
		})
		// Prepending middleware shifts oRPC's validation indexes, covering auth,
		// input validation, output validation, and the final stream lifetime.
		const decorated = decorateProcedure(
			os
				.use(async ({ context, next }) => {
					const started = performance.now()
					const state: Invocation = {
						span: undefined,
						logger: defaultLogger,
						input: undefined,
						context,
						handlerStarted: false
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
								const result = await next({ context: { [INVOCATION]: state } })
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
								if (
									timing &&
									!(context as Record<symbol, unknown>)[INVOCATION]
								) {
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
		)
		if (hasStaticGuards || hasDynamicGuards)
			guardRunners.set(decorated, runGuards)
		return decorated
	}

	const logCompleted = (logger: FnLogger, event: FnCompletedEvent) => {
		const { error, success } = event
		let extra: LogAttributes | undefined
		if (runtime.onCompleted) {
			let observedContext = event.context
			if (typeof observedContext === 'object' && observedContext !== null) {
				const {
					[INVOCATION]: _invocation,
					[EXTRAS_OVERRIDE]: _overrides,
					...rest
				} = observedContext as Record<PropertyKey, unknown>
				observedContext = rest
			}
			try {
				extra = runtime.onCompleted({ ...event, context: observedContext })
			} catch (hookError) {
				logger.warn('onCompleted hook failed', {
					error: errorMessageOf(hookError)
				})
			}
		}
		const expected = !success && isExpectedError(error)
		const level = success ? 'info' : expected ? 'warn' : 'error'
		logger[level]('fn.completed', {
			...extra,
			event: 'fn.completed',
			operation: event.name,
			procedure: event.procedure,
			duration_ms: event.durationMs,
			status: success ? 'success' : 'failed',
			...(success
				? {}
				: errorAttributes(
						error,
						!(expected && runtime.errorMessages === 'unexpected')
					))
		})
	}

	const live = createLiveRuntime({
		fn,
		tracing,
		createLogger,
		pubsub: runtime.pubsub
	})

	const readMeta = (procedure: AnyProcedure | AnyProcedureContract): FnMeta =>
		readFnMeta(procedure)

	// The runtimes are untyped; `Fn`, `FnLive`, `CreatePubSub` and
	// `CreatePublisher` are their typed surface.
	return {
		fn,
		fnLive: createFnLive({
			fn,
			createChannel: live.createChannel,
			isGuard,
			guardsOf: (procedure) => guardRunners.get(procedure)
		}),
		fnLivePatch,
		createPubSub: live.createPubSub,
		createPublisher: live.createPublisher,
		createRouter,
		readMeta,
		createCall: <TContext>(context: TContext, signal?: AbortSignal) =>
			createBoundCall(context, signal, tracing),
		createTestCall: <TContext>(
			context: TContext,
			{ extras, signal }: { extras?: object; signal?: AbortSignal } = {}
		) =>
			createBoundCall(
				extras ? { ...context, [EXTRAS_OVERRIDE]: extras } : context,
				signal,
				tracing
			),
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
