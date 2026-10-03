import { createRedisTransport } from './redis.js'

/** The part of an ioredis `Redis` client this transport uses. */
export interface IORedisLike {
	call(command: string, ...args: string[]): Promise<unknown>
	subscribe(...channels: string[]): Promise<unknown>
	unsubscribe(...channels: string[]): Promise<unknown>
	duplicate(): IORedisLike
	disconnect(): void
	on(
		event: 'message',
		listener: (channel: string, message: string) => void
	): unknown
	on(event: 'end', listener: () => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * `PubSubTransport` for ioredis. Subscriptions use a dedicated connection
 * (`client.duplicate()` unless `subscriber` is given); ioredis re-subscribes
 * after reconnects itself (`autoResubscribe`). `onError` receives connection
 * errors that ioredis is already retrying.
 *
 * Call `close()` on shutdown to disconnect the subscriber it created.
 */
export function ioredisTransport(
	client: IORedisLike,
	options: { subscriber?: IORedisLike; onError?: (error: Error) => void } = {}
) {
	return createRedisTransport({
		send: (command, args) => client.call(command, ...args),
		async connectSubscriber(handlers) {
			const owned = !options.subscriber
			const subscriber = options.subscriber ?? client.duplicate()
			let closing = false
			subscriber.on('message', (channel, message) =>
				handlers.onMessage(channel, message)
			)
			// Without a listener an ioredis 'error' event would crash the process.
			subscriber.on('error', (error) => options.onError?.(error))
			// 'end' means ioredis stopped reconnecting.
			subscriber.on('end', () => {
				if (!closing)
					handlers.onLost(new Error('Redis subscriber connection ended'))
			})
			return {
				subscribe: (channel) => subscriber.subscribe(channel),
				unsubscribe: (channel) => subscriber.unsubscribe(channel),
				close() {
					closing = true
					if (owned) subscriber.disconnect()
				}
			}
		}
	})
}
