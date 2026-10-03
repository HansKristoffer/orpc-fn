import { createRedisTransport } from './redis.js'

/** The part of an ioredis `Redis` client this transport uses. */
export interface IORedisLike {
	call(command: string, ...args: string[]): Promise<unknown>
	subscribe(...channels: string[]): Promise<unknown>
	unsubscribe(...channels: string[]): Promise<unknown>
	duplicate(): IORedisLike
	status?: string
	disconnect(): void
	on(
		event: 'message',
		listener: (channel: string, message: string) => void
	): unknown
	on(event: 'ready', listener: () => void): unknown
	on(event: 'end', listener: () => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
	off(
		event: 'message',
		listener: (channel: string, message: string) => void
	): unknown
	off(event: 'ready', listener: () => void): unknown
	off(event: 'end', listener: () => void): unknown
	off(event: 'error', listener: (error: Error) => void): unknown
}

/**
 * `PubSubTransport` for ioredis. Subscriptions use a dedicated connection
 * (`client.duplicate()` unless `subscriber` is given); ioredis re-subscribes
 * after reconnects itself (`autoResubscribe`), so no `resubscribe` is needed. `onError` receives connection
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
			const onMessage = (channel: string, message: string) =>
				handlers.onMessage(channel, message)
			// Without a listener an ioredis 'error' event would crash the process.
			const onError = (error: Error) => {
				try {
					options.onError?.(error)
				} catch {
					/* Isolate telemetry. */
				}
			}
			let readyOnce = subscriber.status === 'ready'
			const onReady = () => {
				if (readyOnce) handlers.onReconnect()
				readyOnce = true
			}
			// 'end' means ioredis stopped reconnecting.
			const onEnd = () =>
				handlers.onLost(new Error('Redis subscriber connection ended'))
			const ours = new Set<string>()
			subscriber.on('ready', onReady)
			subscriber.on('message', onMessage)
			subscriber.on('error', onError)
			subscriber.on('end', onEnd)
			return {
				subscribe: (channel) => {
					ours.add(channel)
					return subscriber.subscribe(channel)
				},
				resubscribe: (channel: string) => subscriber.subscribe(channel),
				unsubscribe: (channel) => {
					ours.delete(channel)
					return subscriber.unsubscribe(channel)
				},
				close() {
					// Detach first: a given subscriber outlives this transport's use.
					subscriber.off('ready', onReady)
					subscriber.off('message', onMessage)
					subscriber.off('end', onEnd)
					if (owned) return subscriber.disconnect()
					subscriber.off('error', onError)
					if (ours.size > 0) {
						return subscriber
							.unsubscribe(...ours)
							.then(() => {})
							.catch(() => {})
					}
				}
			}
		}
	})
}
