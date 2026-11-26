import { normalizeMeta, rpcJson, toLegacyMeta } from '../rpc-json.js'

const MARKER = 'orpc-fn'

function serializeEvent(value: unknown) {
	const serialized = rpcJson.serializeJson(value)
	if (serialized.maps?.length || serialized.blobs?.length)
		throw new TypeError('orpc-fn: pub/sub events cannot contain files or blobs')
	return { json: serialized.json, meta: serialized.meta ?? [] }
}

/**
 * Wire format for pub/sub payloads: oRPC's own JSON serializer, so values
 * plain JSON loses (`Date`, `Map`, `Set`, `BigInt`, `URL`, `undefined`) arrive
 * intact. Payloads without the envelope are read as plain JSON, so a
 * publisher on the old format keeps working during a rolling deploy.
 *
 * Envelope version 2 holds oRPC 1's numeric type tags, which every orpc-fn
 * version reads, so instances on either oRPC major share a broker and each
 * other's backlogs. Only a type oRPC 1 lacked (`Infinity`) needs version 3,
 * with oRPC 2's named tags.
 */
export function encodePayload(
	value: unknown,
	id: string = crypto.randomUUID()
): string {
	const { json, meta } = serializeEvent(value)
	const legacy = toLegacyMeta(meta)
	return legacy
		? JSON.stringify({ [MARKER]: 2, id, json, meta: legacy })
		: JSON.stringify({ [MARKER]: 3, id, json, meta })
}

/** A comparable serialization of a snapshot; undefined when it holds files. */
export function snapshotKey(value: unknown): string | undefined {
	const serialized = rpcJson.serializeJson(value)
	if (serialized.maps?.length || serialized.blobs?.length) return undefined
	return JSON.stringify([serialized.json, serialized.meta ?? []])
}

export function decodePayload(payload: string): unknown {
	return decodeMessage(payload).value
}

/** IDs distinguish replay/live overlap; legacy payloads remain readable. */
export function decodeMessage(payload: string): {
	id: string | undefined
	value: unknown
} {
	const parsed: unknown = JSON.parse(payload)
	if (typeof parsed !== 'object' || parsed === null)
		return { id: undefined, value: parsed }
	const envelope = parsed as Record<string, unknown>
	const version = Number(envelope[MARKER])
	if (version !== 1 && version !== 2 && version !== 3)
		return { id: undefined, value: parsed }
	return {
		id:
			version !== 1 && typeof envelope.id === 'string'
				? envelope.id
				: undefined,
		value: rpcJson.deserializeJson({
			json: envelope.json,
			meta: normalizeMeta(envelope.meta)
		})
	}
}
