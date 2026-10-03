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

/**
 * Default logger: silent for `debug`/`info`, console for `warn`/`error`, so a
 * library default never floods stdout with one line per call. Inject your own
 * with `createFn({ logger })`.
 */
export function createDefaultLogger(scope: string): FnLogger {
	return {
		debug() {},
		info() {},
		warn: (message, attributes) =>
			console.warn(format(scope, message, attributes)),
		error: (message, attributes) =>
			console.error(format(scope, message, attributes))
	}
}

/** Protect telemetry calls while preserving application logger extensions. */
export function protectLogger<T extends FnLogger>(logger: T): T {
	return new Proxy(logger, {
		get(target, key) {
			const value = Reflect.get(target, key, target)
			if (typeof value !== 'function') return value
			if (['debug', 'info', 'warn', 'error'].includes(String(key))) {
				return (...args: unknown[]) => {
					try {
						return value.apply(target, args)
					} catch {
						/* Telemetry must not replace a procedure outcome. */
					}
				}
			}
			return value.bind(target)
		}
	})
}
