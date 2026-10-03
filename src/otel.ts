import {
	isAsyncIteratorObject,
	onStreamEnd,
	type StreamScope
} from './stream.js'

/** Attribute values accepted by OpenTelemetry spans. */
export type AttributeValue = string | number | boolean

/** The part of an OpenTelemetry `Span` this package uses. */
export interface SpanLike {
	setAttribute(key: string, value: AttributeValue): unknown
	setStatus(status: { code: number; message?: string }): unknown
	recordException(exception: Error): unknown
	end(): unknown
}

type SpanOptionsLike = {
	kind?: number
	attributes?: Record<string, AttributeValue>
}

interface TracerLike<TSpan> {
	startActiveSpan<F extends (span: TSpan) => unknown>(
		name: string,
		options: SpanOptionsLike,
		fn: F
	): ReturnType<F>
	startSpan(name: string, options?: SpanOptionsLike): TSpan
}

/**
 * The part of `@opentelemetry/api` this package uses. Pass the module itself:
 * `import * as otel from '@opentelemetry/api'` then `createFn({ otel })`.
 * Without it no spans are created and handlers receive `span: undefined`.
 */
export interface OtelApiLike<TSpan extends SpanLike = SpanLike> {
	trace: { getTracer(name: string): TracerLike<TSpan> }
	SpanStatusCode: { OK: number; ERROR: number }
	SpanKind: {
		INTERNAL: number
		SERVER: number
		PRODUCER: number
	}
	/** Restores a span's context for each step of a stream it returned. */
	context: {
		active(): unknown
		with<T>(context: never, fn: () => T): T
	}
}

/** The span type of an OpenTelemetry API, or `SpanLike` when absent. */
export type SpanOf<TOtel> =
	TOtel extends OtelApiLike<infer TSpan> ? TSpan : SpanLike

/** Called once when a span's work is done, before the span ends. */
export type OnSettled = (
	span: SpanLike | undefined,
	...error: [] | [unknown]
) => void

export type Tracing = {
	/**
	 * Run `fn` inside an active span: OK when it resolves, ERROR when it throws,
	 * ended either way. When `fn` resolves to a stream, the span stays open -
	 * and active for each step of the stream - until the stream ends.
	 * `onSettled` runs once at that point, before the span ends. Without
	 * OpenTelemetry `span` is undefined and `onSettled` still runs.
	 */
	inSpan<T>(
		name: string,
		kind: 'INTERNAL' | 'SERVER' | 'PRODUCER',
		fn: (span: SpanLike | undefined) => Promise<T>,
		onSettled?: OnSettled
	): Promise<T>
	/** Start a span that the caller ends with `end` (long-lived streams). */
	startSpan(
		name: string,
		kind: 'SERVER',
		attributes: Record<string, AttributeValue>
	): SpanLike | undefined
	/** Set OK, or ERROR with `error`, and end the span. */
	end(span: SpanLike | undefined, error?: unknown): void
}

export function createTracing(otel: OtelApiLike | undefined): Tracing {
	const tracer = otel?.trace.getTracer('orpc-fn')
	const end: Tracing['end'] = (span, ...error) => {
		if (!span || !otel) return
		if (error.length === 0) {
			span.setStatus({ code: otel.SpanStatusCode.OK })
		} else {
			span.setStatus({
				code: otel.SpanStatusCode.ERROR,
				message: errorMessageOf(error[0])
			})
			if (error[0] instanceof Error) span.recordException(error[0])
		}
		span.end()
	}
	return {
		inSpan(name, kind, fn, onSettled) {
			const settle = (span: SpanLike | undefined, ...error: [] | [unknown]) => {
				try {
					onSettled?.(span, ...error)
				} finally {
					end(span, ...error)
				}
			}
			const run = async (
				span: SpanLike | undefined,
				scope?: StreamScope
			): Promise<Awaited<ReturnType<typeof fn>>> => {
				let result: Awaited<ReturnType<typeof fn>>
				try {
					result = await fn(span)
				} catch (error) {
					settle(span, error)
					throw error
				}
				if (isAsyncIteratorObject(result)) {
					return onStreamEnd(
						result,
						(...error) => settle(span, ...error),
						scope
					) as typeof result
				}
				settle(span)
				return result
			}
			if (!tracer || !otel) return run(undefined)
			return tracer.startActiveSpan(
				name,
				{ kind: otel.SpanKind[kind] },
				(span) => {
					const active = otel.context.active()
					return run(span, (step) => otel.context.with(active as never, step))
				}
			)
		},
		startSpan(name, kind, attributes) {
			if (!tracer || !otel) return undefined
			return tracer.startSpan(name, { kind: otel.SpanKind[kind], attributes })
		},
		end
	}
}

export function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
