import { decodePayload } from './codec.js'
import type { PubSubTransport, PubSubTransportStats } from './transport.js'

/** One message the memory transport carried, decoded. */
export type PublishedEvent = { channel: string; event: unknown }

/**
 * In-process transport for tests and single-process development. Delivery is
 * asynchronous (a microtask), like a real broker. It records what was
 * published, so a test asserts on `published()` instead of mocking a bus.
 */
export function memoryTransport(): PubSubTransport & {
	/** Active listeners per channel, for assertions. */
	listenerCount(channel: string): number
	stats(): PubSubTransportStats
	/** Events published so far, oldest first, decoded; optionally on one channel. */
	published(channel?: string): PublishedEvent[]
	/** Forget the recorded events. */
	clearPublished(): void
} {
	const listeners = new Map<string, Set<(payload: string) => void>>()
	const backlogs = new Map<string, { items: string[]; expiresAt: number }>()
	const log: { channel: string; payload: string }[] = []

	return {
		async close() {
			listeners.clear()
			backlogs.clear()
		},
		async publish(messages, backlog) {
			for (const { channel, payload } of messages) {
				log.push({ channel, payload })
				if (backlog) {
					const current = backlogs.get(channel)
					const items =
						current && current.expiresAt > Date.now() ? current.items : []
					items.push(payload)
					items.splice(0, Math.max(0, items.length - backlog.size))
					backlogs.set(channel, {
						items,
						expiresAt: Date.now() + backlog.ttlSeconds * 1000
					})
				}
				for (const listener of [...(listeners.get(channel) ?? [])]) {
					queueMicrotask(() => listener(payload))
				}
			}
		},
		async readBacklog(channel) {
			const backlog = backlogs.get(channel)
			return backlog && backlog.expiresAt > Date.now() ? [...backlog.items] : []
		},
		async subscribe(channel, listener) {
			const set = listeners.get(channel) ?? new Set()
			listeners.set(channel, set)
			// Wrap so the same listener can subscribe twice and unsubscribe once.
			const entry = (payload: string) => listener(payload)
			set.add(entry)
			return async () => {
				set.delete(entry)
				if (set.size === 0) listeners.delete(channel)
			}
		},
		listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
		published: (channel) =>
			log
				.filter((entry) => channel === undefined || entry.channel === channel)
				.map((entry) => ({
					channel: entry.channel,
					event: decodePayload(entry.payload)
				})),
		clearPublished: () => {
			log.length = 0
		},
		stats: () => ({
			channels: listeners.size,
			listeners: [...listeners.values()].reduce(
				(sum, set) => sum + set.size,
				0
			),
			subscriberConnected: true
		})
	}
}
