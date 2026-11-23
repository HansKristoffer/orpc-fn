export type LogAttributes = Record<string, unknown>

/** The logger handlers receive. Any app logger with these four methods fits. */
export interface FnLogger {
	debug(message: string, attributes?: LogAttributes): void
	info(message: string, attributes?: LogAttributes): void
	warn(message: string, attributes?: LogAttributes): void
	error(message: string, attributes?: LogAttributes): void
}

const format = (scope: string, message: string, attributes?: LogAttributes) =>
	`[${scope}] ${message}${attributes ? ` ${JSON.stringify(attributes)}` : ''}`

const LOGGER_METHODS = new Set<PropertyKey>(['debug', 'info', 'warn', 'error'])
const protectedLoggers = new WeakSet<object>()

/**
 * Default logger: silent for `debug`/`info`, console for `warn`/`error`, so a
 * library default never floods stdout with one line per call. Inject your own
 * with `createFn({ logger })`.
 */
export function createDefaultLogger(scope: string): FnLogger {
	const logger: FnLogger = {
		debug() {},
		info() {},
		warn(message, attributes) {
			try {
				console.warn(format(scope, message, attributes))
			} catch {
				/* Telemetry must not replace a procedure outcome. */
			}
		},
		error(message, attributes) {
			try {
				console.error(format(scope, message, attributes))
			} catch {
				/* Telemetry must not replace a procedure outcome. */
			}
		}
	}
	protectedLoggers.add(logger)
	return logger
}

/** Protect telemetry calls while preserving application logger extensions. */
export function protectLogger<T extends FnLogger>(logger: T): T {
	if (protectedLoggers.has(logger)) return logger
	const cache = new Map<PropertyKey, unknown>()
	const proxy = new Proxy(logger, {
		get(target, key) {
			const value = Reflect.get(target, key, target)
			if (typeof value !== 'function') return value
			const cached = cache.get(key)
			if (cached !== undefined) return cached
			const wrapped = LOGGER_METHODS.has(key)
				? (...args: unknown[]) => {
						try {
							return value.apply(target, args)
						} catch {
							/* Telemetry must not replace a procedure outcome. */
						}
					}
				: value.bind(target)
			cache.set(key, wrapped)
			return wrapped
		}
	})
	protectedLoggers.add(proxy)
	return proxy
}
