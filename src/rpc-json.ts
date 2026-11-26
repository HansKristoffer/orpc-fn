import { RPCJsonSerializer, type RPCJsonSerializationMeta } from '@orpc/client'

/**
 * oRPC 1 tagged serialized types with numbers, oRPC 2 with names. Data written
 * under oRPC 1 (pub/sub backlogs, persisted query caches) is still read, and
 * pub/sub keeps writing numbers where it can (see `live/codec.ts`).
 */
const LEGACY_CODES: Record<string, number> = {
	bigint: 0,
	date: 1,
	nan: 2,
	undefined: 3,
	url: 4,
	regexp: 5,
	set: 6,
	map: 7
}
const LEGACY_TYPES: Record<number, string> = Object.fromEntries(
	Object.entries(LEGACY_CODES).map(([type, code]) => [code, type])
)

export type LegacyMeta = [code: number, ...path: (string | number)[]]

/**
 * oRPC's JSON serializer, plus RegExp, which oRPC 2 dropped: values written
 * under oRPC 1 keep it, as `/source/flags`.
 */
export const rpcJson = new RPCJsonSerializer({
	handlers: {
		regexp: {
			condition: (value) => value instanceof RegExp,
			serialize: (value: RegExp) => value.toString(),
			deserialize: (serialized) => {
				const [, source = '', flags] =
					/^\/(.*)\/([a-z]*)$/s.exec(String(serialized)) ?? []
				return new RegExp(source, flags)
			},
			isTerminal: true
		}
	}
})

/** The same meta in oRPC 1's numbers, or undefined when a type has none. */
export function toLegacyMeta(
	meta: readonly RPCJsonSerializationMeta[]
): LegacyMeta[] | undefined {
	const legacy: LegacyMeta[] = []
	for (const [type, ...path] of meta) {
		const code = LEGACY_CODES[type]
		if (code === undefined) return undefined
		legacy.push([code, ...(path as (string | number)[])])
	}
	return legacy
}

/** Reads meta written by either oRPC version. */
export function normalizeMeta(meta: unknown): RPCJsonSerializationMeta[] {
	if (!Array.isArray(meta)) return []
	return meta.map((entry: [unknown, ...(string | number)[]]) => {
		const [type, ...path] = entry
		return [
			typeof type === 'number'
				? (LEGACY_TYPES[type] ?? String(type))
				: String(type),
			...path
		]
	})
}
