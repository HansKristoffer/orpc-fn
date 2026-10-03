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
}

/** The span type of an OpenTelemetry API, or `SpanLike` when absent. */
export type SpanOf<TOtel> =
	TOtel extends OtelApiLike<infer TSpan> ? TSpan : SpanLike

export type Tracing = {
	/**
	 * Run `fn` inside an active span: OK when it resolves, ERROR when it throws,
	 * ended either way. Without OpenTelemetry `span` is undefined.
	 */
	inSpan<T>(
		name: string,
		kind: 'INTERNAL' | 'SERVER' | 'PRODUCER',
		fn: (span: SpanLike | undefined) => Promise<T>
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
		inSpan(name, kind, fn) {
			if (!tracer || !otel) return fn(undefined)
			return tracer.startActiveSpan(
				name,
				{ kind: otel.SpanKind[kind] },
				async (span) => {
					try {
						const result = await fn(span)
						end(span)
						return result
					} catch (error) {
						end(span, error)
						throw error
					}
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
