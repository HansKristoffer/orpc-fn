import { errorMessageOf } from '../otel.js'
import { backlogKey, type PubSubTransport } from './transport.js'

export type RedisSend = (command: string, args: string[]) => Promise<unknown>

function isNoScriptError(error: unknown) {
	return errorMessageOf(error).includes('NOSCRIPT')
}

/**
 * Ship a Lua script by SHA instead of resending its source on every call.
 * Redis forgets its script cache on restart and on `SCRIPT FLUSH`, so a
 * `NOSCRIPT` reply falls back to an inline `EVAL` (which repopulates the
 * cache) and drops the stale digest.
 */
export function createLuaScript(send: RedisSend, source: string) {
	let sha: string | null = null
	let loading: Promise<string> | null = null

	function load() {
		loading ??= send('SCRIPT', ['LOAD', source])
			.then(String)
			.finally(() => {
				loading = null
			})
		return loading
	}

	return async function evalScript(keys: string[], args: string[]) {
		const tail = [String(keys.length), ...keys, ...args]
		sha ??= await load()
		try {
			return await send('EVALSHA', [sha, ...tail])
		} catch (error) {
			if (!isNoScriptError(error)) throw error
			sha = null
			return await send('EVAL', [source, ...tail])
		}
	}
}

/**
 * Publish payloads and maintain each channel's capped, TTL'd backlog in one
 * atomic round-trip. Separate PUBLISH/RPUSH/LTRIM/EXPIRE calls can tear (a
 * message published but missing from the backlog, or a backlog without TTL).
 *
 * KEYS = channel1, backlog1, channel2, backlog2, ...
 * ARGV[1] = max backlog size (0 = no backlog), ARGV[2] = TTL seconds,
 * ARGV[3..] = pairs of (channel slot, payload)
 */
const PUBLISH_LUA = `
local maxSize = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
for i = 3, #ARGV, 2 do
  local slot = tonumber(ARGV[i]) * 2
  redis.call('PUBLISH', KEYS[slot - 1], ARGV[i + 1])
  if maxSize > 0 then
    redis.call('RPUSH', KEYS[slot], ARGV[i + 1])
  end
end
if maxSize > 0 then
  for slot = 2, #KEYS, 2 do
    redis.call('LTRIM', KEYS[slot], -maxSize, -1)
    redis.call('EXPIRE', KEYS[slot], ttl)
  end
end
return (#ARGV - 2) / 2
`

export type SubscriberConnection = {
	subscribe(channel: string): Promise<unknown>
	unsubscribe(channel: string): Promise<unknown>
	/**
	 * Restore one channel after the driver reconnected on its own and lost its
	 * subscriptions. Omit when the client re-subscribes itself (ioredis).
	 */
	resubscribe?(channel: string): Promise<unknown>
	/** Stop delivering and release the connection (if the driver created it). */
	close(): void | Promise<void>
}

/** Callbacks for one connection; they do nothing once it is replaced. */
export type SubscriberHandlers = {
	onMessage(channel: string, message: string): void
	/** The driver reconnected; its subscriptions must be restored. */
	onReconnect(): void
	/** The connection is gone for good; a fresh one replaces it. */
	onLost(error: Error): void
}

type Entry = {
	listener: (payload: string) => void
	onLost: ((error: Error) => void) | undefined
	onReconnect: (() => void) | undefined
}

type ChannelState = {
	entries: Set<Entry>
	ready: Promise<unknown>
	settled: boolean
}

/**
 * Shared core of the Redis transports: one SUBSCRIBE per channel no matter
 * how many listeners, and one dedicated subscriber connection at a time.
 *
 * Each connection is a generation. Losing it (or failing to restore its
 * channels after a reconnect) retires it: the core closes it, ignores
 * anything it still emits, and tells every listener, whose resubscribe then
 * opens the next generation. Nothing from an old connection can reach the
 * channels of a new one.
 */
export function createRedisTransport(driver: {
	send: RedisSend
	connectSubscriber: (
		handlers: SubscriberHandlers
	) => Promise<SubscriberConnection>
}): PubSubTransport & { close(): Promise<void> } {
	const publishScript = createLuaScript(driver.send, PUBLISH_LUA)
	const channels = new Map<string, ChannelState>()
	// An UNSUBSCRIBE still in flight would cancel a SUBSCRIBE sent after it.
	const unsubscribing = new Map<string, Promise<unknown>>()
	let current: {
		connection: Promise<SubscriberConnection>
		retire: () => Promise<void>
	} | null = null

	const connect = () => {
		let retired = false
		let closing: Promise<void> | undefined
		const retire = (error?: Error) => {
			if (retired) return closing ?? Promise.resolve()
			retired = true
			if (current?.connection === connection) current = null
			closing = connection.then((open) => open.close()).catch(() => {})
			if (!error) return closing
			const lost = [...channels.values()].flatMap((state) => [...state.entries])
			channels.clear()
			for (const entry of lost) {
				try {
					entry.onLost?.(error)
				} catch {
					/* One callback cannot interrupt retirement. */
				}
			}
			return closing
		}
		const handlers: SubscriberHandlers = {
			onMessage(channel, message) {
				if (retired) return
				for (const entry of [...(channels.get(channel)?.entries ?? [])]) {
					try {
						entry.listener(message)
					} catch {
						// One listener must not starve the others.
					}
				}
			},
			onReconnect() {
				if (retired) return
				// In-flight SUBSCRIBEs are excluded: they still land on their own.
				const settled = [...channels]
					.filter(([, state]) => state.settled)
					.map(([channel]) => channel)
				void connection
					.then((open) =>
						Promise.all(settled.map((channel) => open.resubscribe?.(channel)))
					)
					.then(() => {
						if (retired) return
						for (const channel of settled)
							for (const entry of [...(channels.get(channel)?.entries ?? [])]) {
								try {
									entry.onReconnect?.()
								} catch {
									/* Isolate subscriber callbacks. */
								}
							}
					})
					.catch((error) => retire(asError(error)))
			},
			onLost: (error) => retire(error)
		}
		const connection = driver.connectSubscriber(handlers)
		connection.catch(() => {
			if (current?.connection === connection) current = null
		})
		current = { connection, retire: () => retire() }
		return connection
	}

	return {
		async publish(messages, backlog) {
			const [first] = messages
			if (!first) return
			if (!backlog && messages.length === 1) {
				await driver.send('PUBLISH', [first.channel, first.payload])
				return
			}
			const keys: string[] = []
			const slots = new Map<string, number>()
			const args = [
				String(backlog?.size ?? 0),
				String(backlog?.ttlSeconds ?? 0)
			]
			for (const { channel, payload } of messages) {
				let slot = slots.get(channel)
				if (slot === undefined) {
					keys.push(channel, backlogKey(channel))
					slot = keys.length / 2
					slots.set(channel, slot)
				}
				args.push(String(slot), payload)
			}
			await publishScript(keys, args)
		},
		async readBacklog(channel) {
			const items = await driver.send('LRANGE', [
				backlogKey(channel),
				'0',
				'-1'
			])
			return Array.isArray(items) ? items.map(String) : []
		},
		async subscribe(channel, listener, onLost, options) {
			const connection = await (current?.connection ?? connect())
			const entry: Entry = {
				listener,
				onLost,
				onReconnect: options?.onReconnect
			}
			await unsubscribing.get(channel)
			let state = channels.get(channel)
			if (!state) {
				const created: ChannelState = {
					entries: new Set(),
					ready: connection.subscribe(channel),
					settled: false
				}
				created.ready.then(
					() => {
						created.settled = true
					},
					() => {
						if (channels.get(channel) === created) channels.delete(channel)
					}
				)
				channels.set(channel, created)
				state = created
			}
			state.entries.add(entry)
			try {
				await state.ready
			} catch (error) {
				state.entries.delete(entry)
				throw error
			}
			const subscribed = state
			return async () => {
				if (!subscribed.entries.delete(entry)) return
				if (subscribed.entries.size > 0 || channels.get(channel) !== subscribed)
					return
				channels.delete(channel)
				const done = connection.unsubscribe(channel).finally(() => {
					if (unsubscribing.get(channel) === done) unsubscribing.delete(channel)
				})
				unsubscribing.set(channel, done)
				await done
			}
		},
		async close() {
			const closing = current?.retire()
			channels.clear()
			await closing
			await Promise.allSettled([...unsubscribing.values()])
		}
	}
}

const asError = (error: unknown) =>
	error instanceof Error ? error : new Error(errorMessageOf(error))
