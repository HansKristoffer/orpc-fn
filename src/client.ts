import { type ClientContext, ORPCError, type ORPCErrorCode } from '@orpc/client'
import { RPCLink, type RPCLinkOptions } from '@orpc/client/fetch'
import { BatchLinkPlugin } from '@orpc/client/plugins'

type BatchOptions<T extends ClientContext> = ConstructorParameters<
	typeof BatchLinkPlugin<T>
>[0]

export type CreateRpcLinkOptions<T extends ClientContext> =
	RPCLinkOptions<T> & {
		/**
		 * Collapse parallel calls into one HTTP request, matching `mountOrpc`'s
		 * server-side batching. Default: true (25 calls). Pass false to turn off.
		 *
		 * A batch is one HTTP request, so it carries one client context. By
		 * default only calls without a client context are batched; pass
		 * `groups` to batch calls that share a context (e.g. a token).
		 */
		batch?:
			| boolean
			| {
					maxSize?: number
					/** Calls that must not be batched. Default: {@link isSubscriptionPath}. */
					exclude?: (path: readonly string[]) => boolean
					groups?: BatchOptions<T>['groups']
			  }
	}

/**
 * Streaming responses cannot be batched, and the request does not say a
 * response will stream - so streaming routes are recognised by name. The
 * default treats any path segment containing `subscribe` as one (the
 * convention `fnLive` routers use: `{ list, subscribe }`).
 */
export const isSubscriptionPath = (path: readonly string[]) =>
	path.some((segment) => segment.toLowerCase().includes('subscribe'))

/**
 * `RPCLink` with request batching: a page-load burst becomes one request
 * instead of many queued on the server's event loop.
 *
 * ```ts
 * const client: RouterClient<typeof router> = createORPCClient(createRpcLink({ url }))
 * export const orpc = createTanstackQueryUtils(client)
 * ```
 */
export function createRpcLink<T extends ClientContext = ClientContext>(
	options: CreateRpcLinkOptions<T>
): RPCLink<T> {
	const { batch = true, plugins = [], ...rest } = options
	if (batch === false) return new RPCLink<T>({ ...rest, plugins })
	const {
		maxSize = 25,
		exclude = isSubscriptionPath,
		groups
	} = batch === true ? {} : batch
	return new RPCLink<T>({
		...rest,
		plugins: [
			new BatchLinkPlugin<T>({
				maxSize,
				groups: groups ?? [
					// Only context-free calls reach this group (see `exclude` below),
					// so the batch's empty context is exactly theirs.
					{ condition: () => true, context: {} as T }
				],
				exclude: ({ path, context }) =>
					exclude(path) ||
					(groups === undefined && Object.keys(context).length > 0)
			}),
			...plugins
		]
	})
}

/**
 * Typed check for a route error on the client. The RPC link rebuilds thrown
 * route errors as `ORPCError`, so `instanceof` plus `code` is the contract.
 */
export function hasOrpcErrorCode(error: unknown, code: ORPCErrorCode): boolean {
	return error instanceof ORPCError && error.code === code
}
