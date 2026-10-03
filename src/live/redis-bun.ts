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
			let closing = false
			subscriber.onconnect = () => {
				// Bun reconnects on its own but drops every subscription; restore
				// them. Also fires on the first connect, and Bun does not dedupe
				// listeners, so clear each channel before re-adding its listener.
				for (const channel of handlers.channels()) {
					// unsubscribe throws synchronously outside subscriber mode.
					void Promise.resolve()
						.then(() => subscriber.unsubscribe(channel))
						.catch(() => {})
						.then(() => subscriber.subscribe(channel, dispatch))
						.catch((error) => {
							handlers.onLost(
								error instanceof Error ? error : new Error(String(error))
							)
						})
				}
			}
			// `onclose` fires only when Bun gives up reconnecting, or on close().
			subscriber.onclose = (error) => {
				if (closing) return
				handlers.onLost(error ?? new Error('Redis subscriber closed'))
			}
			return {
				subscribe: (channel) => subscriber.subscribe(channel, dispatch),
				unsubscribe: (channel) => subscriber.unsubscribe(channel, dispatch),
				close() {
					closing = true
					if (owned) subscriber.close()
				}
			}
		}
	})
}
