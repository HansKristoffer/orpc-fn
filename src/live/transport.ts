/** One payload for one channel. */
export type PubSubMessage = { channel: string; payload: string }

export type BacklogOptions = {
	/** Items kept per channel (oldest dropped). */
	size: number
	/** Seconds the backlog lives after its last write. */
	ttlSeconds: number
}

/**
 * The broker behind `createPubSub` / `fnLive`. Implementations:
 * `orpc-fn/live/redis-bun`, `orpc-fn/live/ioredis` and `orpc-fn/live/memory`.
 *
 * The backlog of a channel lives at `${channel}:backlog` (see {@link backlogKey}).
 */
export interface PubSubTransport {
	/** Optional disposal, used only with ownsTransport: true. */
	close?: () => void | Promise<void>
	/**
	 * Publish every message, in order. With `backlog`, also append each payload
	 * to its channel's backlog, trim and refresh its TTL - atomically, so a
	 * message is never published without its backlog entry or vice versa.
	 */
	publish(
		messages: readonly PubSubMessage[],
		backlog?: BacklogOptions
	): Promise<void>
	/** The channel's backlog, oldest first. */
	readBacklog(channel: string): Promise<string[]>
	/**
	 * Deliver every payload published to `channel` until the returned function
	 * is called. `onLost` fires when the subscription can no longer deliver
	 * (connection closed for good); the caller resubscribes.
	 */
	subscribe(
		channel: string,
		listener: (payload: string) => void,
		onLost?: (error: Error) => void,
		options?: { onReconnect?: () => void }
	): Promise<() => Promise<void>>
}

export const backlogKey = (channel: string) => `${channel}:backlog`
