import { promisify } from 'node:util'
import zlib from 'node:zlib'

/** oRPC 2's `BATCH_CONTENT_TYPE`, from `@orpc/server/plugins`. */
const BATCH_CONTENT_TYPE = 'application/vnd.orpc.batch'

/** Response encodings the mount adapters produce. */
export type Encoding = 'br' | 'gzip'

/** Smaller JSON bodies are sent as they are: the encoding overhead outweighs the gain. */
export const MIN_COMPRESS_BYTES = 512

const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i
const gzipAsync = promisify(zlib.gzip)
const brotliAsync = promisify(zlib.brotliCompress)
// Quality 4 is brotli's dynamic-content sweet spot: about gzip's speed, smaller output.
const BROTLI_QUALITY = 4

/**
 * RFC 9110 `Accept-Encoding` negotiation between brotli and gzip. The higher
 * `q` wins, brotli on a tie; `q=0` rejects; `*` covers an unlisted encoding.
 */
export function negotiateEncoding(
	header: string | null | undefined
): Encoding | undefined {
	if (!header) return undefined
	const weights = new Map<string, number>()
	for (const part of header.split(',')) {
		const [rawEncoding, ...params] = part.trim().split(';')
		const encoding = rawEncoding?.trim().toLowerCase()
		if (!encoding) continue
		let q = 1
		for (const param of params) {
			const [key, value] = param.trim().split('=')
			if (key?.trim().toLowerCase() === 'q' && value !== undefined) {
				const parsed = Number(value.trim())
				if (Number.isFinite(parsed)) q = parsed
			}
		}
		weights.set(encoding === 'x-gzip' ? 'gzip' : encoding, q)
	}
	const weight = (encoding: Encoding) =>
		weights.get(encoding) ?? weights.get('*') ?? 0
	const br = weight('br')
	const gzip = weight('gzip')
	if (br <= 0 && gzip <= 0) return undefined
	return br >= gzip ? 'br' : 'gzip'
}

/**
 * JSON, and the framed batch oRPC answers a streaming batch with (one frame
 * per result, `application/vnd.orpc.batch`). Event streams are live: they
 * stay open and carry little.
 */
export function compressionKind(
	header: (name: string) => string | undefined
): 'batch-stream' | 'json' | undefined {
	if (header('content-encoding')) return undefined
	if (NO_TRANSFORM.test(header('cache-control') ?? '')) return undefined
	const type = header('content-type') ?? ''
	if (type.startsWith(BATCH_CONTENT_TYPE)) return 'batch-stream'
	return type.startsWith('application/json') ? 'json' : undefined
}

/** Compresses a whole body at once. */
export async function compressBytes(
	encoding: Encoding,
	bytes: Uint8Array
): Promise<Uint8Array> {
	const compressed =
		encoding === 'br'
			? await brotliAsync(bytes, {
					params: {
						[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
						[zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
						[zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength
					}
				})
			: await gzipAsync(bytes)
	return new Uint8Array(
		compressed.buffer,
		compressed.byteOffset,
		compressed.byteLength
	)
}

/**
 * A compressor that emits every chunk at once, so a fast batch result is not
 * held back by a slow one.
 */
export function createFlushingCompressor(
	encoding: Encoding
): zlib.Gzip | zlib.BrotliCompress {
	return encoding === 'br'
		? zlib.createBrotliCompress({
				flush: zlib.constants.BROTLI_OPERATION_FLUSH,
				params: {
					[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
					[zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY
				}
			})
		: zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
}

/** `vary` with `accept-encoding` added, or undefined when it already covers it. */
export function varyWithAcceptEncoding(
	vary: string | undefined
): string | undefined {
	if (!vary) return 'accept-encoding'
	const parts = vary.split(',').map((part) => part.trim().toLowerCase())
	if (parts.includes('*') || parts.includes('accept-encoding')) return undefined
	return `${vary}, accept-encoding`
}
