import type { AnyRouter } from '@orpc/server'

/**
 * Creates a router object from routes or nested routers.
 * Simply returns the routes as a const object for type inference.
 *
 * @example
 * ```ts
 * const items = createRouter({ getItem, updateItem })
 * export const api = createRouter({ metabase, items })
 * ```
 */
export function createRouter<T extends AnyRouter>(routes: T): Readonly<T> {
	return routes
}
