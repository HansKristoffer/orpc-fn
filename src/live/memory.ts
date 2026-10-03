import type { PubSubTransport } from './transport.js'

/**
 * In-process transport for tests and single-process development. Delivery is
 * asynchronous (a microtask), like a real broker.
 */
export function memoryTransport(): PubSubTransport & {
	/** Active listeners per channel, for assertions. */
	listenerCount(channel: string): number
} {
	const listeners = new Map<string, Set<(payload: string) => void>>()
	const backlogs = new Map<string, { items: string[]; expiresAt: number }>()

	return {
		async close() {
			listeners.clear()
			backlogs.clear()
		},
		async publish(messages, backlog) {
			for (const { channel, payload } of messages) {
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
		listenerCount: (channel) => listeners.get(channel)?.size ?? 0
	}
}
