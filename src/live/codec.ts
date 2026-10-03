import { StandardRPCJsonSerializer } from '@orpc/client/standard'

const serializer = new StandardRPCJsonSerializer()
const MARKER = 'orpc-fn'

/**
 * Wire format for pub/sub payloads: oRPC's own JSON serializer, so values
 * plain JSON loses (`Date`, `Map`, `Set`, `BigInt`, `URL`, `undefined`) arrive
 * intact. Payloads without the envelope are read as plain JSON, so a
 * publisher on the old format keeps working during a rolling deploy.
 */
export function encodePayload(value: unknown): string {
	const [json, meta, maps, blobs] = serializer.serialize(value)
	if (maps.length > 0 || blobs.length > 0) {
		throw new TypeError('orpc-fn: pub/sub events cannot contain files or blobs')
	}
	return JSON.stringify({ [MARKER]: 1, json, meta })
}

export function decodePayload(payload: string): unknown {
	const parsed: unknown = JSON.parse(payload)
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		(parsed as Record<string, unknown>)[MARKER] === 1
	) {
		const { json, meta } = parsed as { json: unknown; meta: [] }
		return serializer.deserialize(json, meta)
	}
	return parsed
}
