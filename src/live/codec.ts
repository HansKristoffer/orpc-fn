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

export function decodePayload(payload: string): unknown {
	const parsed: unknown = JSON.parse(payload)
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		[1, 2].includes(Number((parsed as Record<string, unknown>)[MARKER]))
	) {
		const { json, meta } = parsed as { json: unknown; meta: [] }
		return serializer.deserialize(json, meta)
	}
	return parsed
}

/** IDs distinguish replay/live overlap; legacy payloads remain readable. */
export function decodeMessage(payload: string): {
	id: string | undefined
	value: unknown
} {
	const envelope = JSON.parse(payload) as unknown
	const id =
		typeof envelope === 'object' &&
		envelope !== null &&
		(envelope as Record<string, unknown>)[MARKER] === 2 &&
		typeof (envelope as Record<string, unknown>).id === 'string'
			? (envelope as { id: string }).id
			: undefined
	return { id, value: decodePayload(payload) }
}
