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
import type {
	AnyFnContext,
	BuilderLike,
	FiniteExtras,
	Fn,
	FnCompletedEvent,
	FnDefinition,
	Guard,
	GuardParams,
	MaybePromise,
	RejectKeys,
	ReservedOptionKey
} from './types.js'

const ROUTE_KEYS = [
	'path',
	'method',
	'summary',
	'description',
	'deprecated',
	'successStatus',
	'successDescription',
	'inputStructure',
	'outputStructure',
	'tags'
] as const

const RESERVED_KEYS: readonly ReservedOptionKey[] = [
	...ROUTE_KEYS,
	'name',
	'procedure',
	'input',
	'output',
	'handler',
	'live',
	'operationId'
]

type BuilderChain = {
	route(route: Record<string, unknown>): BuilderChain
	meta(meta: Record<string, unknown>): BuilderChain
	input(schema: AnySchema): BuilderChain
	output(schema: AnySchema): BuilderChain
	handler(handler: (options: HandlerOptions) => unknown): AnyProcedure
}

type HandlerOptions = {
	input: unknown
	context: Record<string, unknown>
	signal?: AbortSignal
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
	/** Builder used when a route omits `procedure`. */
	default: TDefault
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
	TDefault extends keyof TProcedures & string,
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
	const tracing = createTracing(options.otel)
	const createLogger = (options.logger ??
		((scope: string) => createDefaultLogger(scope))) as (
		scope: string,
		span: SpanLike | undefined
	) => FnLogger
	const isExpectedError = options.isExpectedError ?? isExpectedClientError
	const guards = (options.guards ?? {}) as Record<
		string,
		(value: unknown, params: GuardParams<unknown, unknown>) => unknown
	>
	const procedures = options.procedures as unknown as Record<
		string,
		BuilderChain
	>
	for (const guard of Object.keys(guards)) {
		if ((RESERVED_KEYS as readonly string[]).includes(guard)) {
			throw new Error(
				`orpc-fn: guard "${guard}" reuses a route option name; rename it`
			)
		}
	}
	for (const [key, builder] of Object.entries(procedures)) {
		const def = (builder as { '~orpc'?: Record<string, unknown> })['~orpc']
		if (def?.inputSchema !== undefined || def?.outputSchema !== undefined) {
			throw new Error(
				`orpc-fn: procedure "${key}" sets an input or output schema; set schemas on routes instead`
			)
		}
	}
	const resolveBuilder = (key: string | undefined) => {
		const builder = procedures[key ?? options.default]
		if (!builder) throw new Error(`orpc-fn: unknown procedure "${key}"`)
		return builder
	}

	// biome-ignore lint/suspicious/noExplicitAny: the overloads in `Fn` carry the types
	const fn = (routeOptions: any): AnyProcedure => {
		const { handler, input, output, name, procedure, ...rest } = routeOptions
		const key: string = procedure ?? options.default
		const route: Record<string, unknown> = { operationId: name }
		const guardChecks: Array<[string, unknown]> = []
		const meta: Record<string, unknown> = {}
		for (const [option, value] of Object.entries(rest)) {
			if (value === undefined) continue
			if ((ROUTE_KEYS as readonly string[]).includes(option))
				route[option] = value
			else if (Object.hasOwn(guards, option)) guardChecks.push([option, value])
			else meta[option] = value
		}
		const stored: StoredFnMeta = { name, procedure: key, meta }

		const wrapped = (params: HandlerOptions) =>
			tracing.inSpan(name, 'SERVER', async (span) => {
				const { context, signal } = params
				const startTime = performance.now()
				let success = false
				let caughtError: unknown
				const logger = createLogger('fn', span)
				try {
					span?.setAttribute('fn.operation', name)
					span?.setAttribute('fn.procedure', key)
					const attributes = options.spanAttributes?.({
						context: context as never,
						name,
						procedure: key,
						meta: meta as never
					})
					for (const [attribute, value] of Object.entries(attributes ?? {})) {
						if (value !== undefined) span?.setAttribute(attribute, value)
					}

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

					const extras = await options.extras?.({
						context: context as never,
						span: span as never,
						signal,
						name,
						procedure: key
					})
					const result = await handler({
						...extras,
						input: params.input,
						context,
						call: createBoundCall(context, signal, tracing),
						signal,
						span,
						logger
					})
					tracing.ok(span)
					success = true
					return result
				} catch (error) {
					caughtError = error
					tracing.fail(span, error)
					throw error
				} finally {
					const durationMs = performance.now() - startTime
					const handlerMs = Math.round(durationMs * 100) / 100
					const timing = context.timing
					if (typeof timing === 'object' && timing !== null) {
						;(timing as Record<string, unknown>).handler_ms = handlerMs
					}
					span?.setAttribute('fn.duration_ms', durationMs)
					logCompleted(logger, {
						name,
						procedure: key,
						durationMs: handlerMs,
						success,
						error: caughtError,
						input: params.input,
						context,
						span,
						meta
					})
					span?.end()
				}
			})

		let builder = resolveBuilder(key)
			.route(route)
			.meta({ [FN_META_KEY]: stored })
		if (input) builder = builder.input(input)
		if (output) builder = builder.output(output)
		return builder.handler(wrapped)
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
			extra = options.onCompleted?.(event as never) ?? undefined
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
		procedures: options.procedures,
		default: options.default,
		tracing,
		createLogger,
		...(options.pubsub ? { pubsub: options.pubsub } : {})
	})

	// The runtimes are untyped; `Fn`, `FnLive`, `CreatePubSub` and
	// `CreatePublisher` are their typed surface.
	return {
		fn: fn as never,
		fnLive: createFnLive(fn, live.createChannel, createLogger, (option) =>
			Object.hasOwn(guards, option)
		) as never,
		createPubSub: live.createPubSub as never,
		createPublisher: live.createPublisher as never,
		createRouter,
		readMeta: (procedure) => readFnMeta(procedure),
		createCall: (context, signal) => createBoundCall(context, signal, tracing),
		drainPubSubSubscribers: live.drainPubSubSubscribers,
		activePubSubSubscriberCount: live.activePubSubSubscriberCount
	}
}
