import { StandardRPCJsonSerializer } from '@orpc/client/standard'

const serializer = new StandardRPCJsonSerializer()
const MARKER = 'orpc-fn'

/**
 * Wire format for pub/sub payloads: oRPC's own JSON serializer, so values
 * plain JSON loses (`Date`, `Map`, `Set`, `BigInt`, `URL`, `undefined`) arrive
 * intact. Payloads without the envelope are read as plain JSON, so a
 * publisher on the old format keeps working during a rolling deploy.
 */
export function encodePayload(
	value: unknown,
	id: string = crypto.randomUUID()
): string {
	const [json, meta, maps, blobs] = serializer.serialize(value)
	if (maps.length > 0 || blobs.length > 0) {
		throw new TypeError('orpc-fn: pub/sub events cannot contain files or blobs')
	}
	return JSON.stringify({ [MARKER]: 2, id, json, meta })
}

/** A comparable serialization of a snapshot; undefined when it holds files. */
export function snapshotKey(value: unknown): string | undefined {
	const [json, meta, maps, blobs] = serializer.serialize(value)
	if (maps.length > 0 || blobs.length > 0) return undefined
	return JSON.stringify([json, meta])
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
	if (version !== 1 && version !== 2) return { id: undefined, value: parsed }
	return {
		id:
			version === 2 && typeof envelope.id === 'string'
				? envelope.id
				: undefined,
		value: serializer.deserialize(envelope.json, envelope.meta as [])
	}
}
