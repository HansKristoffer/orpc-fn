import { createRedisTransport } from './redis.js'

type Listener = (message: string, channel: string) => void

/** The part of Bun's `RedisClient` this transport uses. */
export interface BunRedisClientLike {
	send(command: string, args: string[]): Promise<unknown>
	subscribe(channel: string, listener: Listener): Promise<unknown>
	unsubscribe(channel: string, listener?: Listener): Promise<unknown>
	duplicate(): Promise<BunRedisClientLike>
	close(): void
	onconnect: ((this: never) => void) | null
	onclose: ((this: never, error: Error) => void) | null
}

/**
 * `PubSubTransport` for Bun's built-in `RedisClient`. Subscriptions use a
 * dedicated connection (`client.duplicate()` unless `subscriber` is given)
 * that re-subscribes its channels after every reconnect; configure retries on
 * the client (`maxRetries`) since the duplicate copies its options.
 *
 * Call `close()` on shutdown to close the subscriber connection it created.
 */
export function bunRedisTransport(
	client: BunRedisClientLike,
	options: { subscriber?: BunRedisClientLike } = {}
) {
	return createRedisTransport({
		send: (command, args) => client.send(command, args),
		async connectSubscriber(handlers) {
			const owned = !options.subscriber
			const subscriber = options.subscriber ?? (await client.duplicate())
			const dispatch: Listener = (message, channel) =>
				handlers.onMessage(channel, message)
			const ours = new Set<string>()
			// Bun reconnects on its own but drops every subscription. Also fires on
			// the first connect, when there is nothing to restore yet.
			subscriber.onconnect = () => handlers.onReconnect()
			// Fires only when Bun gives up reconnecting (and on close(), which
			// detaches it first).
			subscriber.onclose = (error) =>
				handlers.onLost(error ?? new Error('Redis subscriber closed'))
			return {
				subscribe: (channel) => {
					ours.add(channel)
					return subscriber.subscribe(channel, dispatch)
				},
				// Bun keeps listeners across a reconnect and does not dedupe them, so
				// clear the channel before adding its listener again. unsubscribe
				// throws synchronously outside subscriber mode.
				resubscribe: async (channel) => {
					await Promise.resolve()
						.then(() => subscriber.unsubscribe(channel))
						.catch(() => {})
					return subscriber.subscribe(channel, dispatch)
				},
				unsubscribe: (channel) => {
					ours.delete(channel)
					return subscriber.unsubscribe(channel, dispatch)
				},
				close() {
					// No-ops, not null: Bun calls `onclose` without checking it.
					subscriber.onconnect = () => {}
					subscriber.onclose = () => {}
					if (owned) return subscriber.close()
					// A given subscriber stays open: remove only this transport's listeners.
					for (const channel of ours) {
						void Promise.resolve()
							.then(() => subscriber.unsubscribe(channel, dispatch))
							.catch(() => {})
					}
				}
			}
		}
	})
}
