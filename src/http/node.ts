// Node `http` glue for orpc-fn/node: header conversion, writing an early Web
// `Response`, and compressing what oRPC's node handler writes.
import type {
	IncomingHttpHeaders,
	OutgoingHttpHeaders,
	ServerResponse
} from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
	compressBytes,
	compressionKind,
	createFlushingCompressor,
	type Encoding,
	MIN_COMPRESS_BYTES,
	negotiateEncoding,
	varyWithAcceptEncoding
} from './compression.js'

/** Node request headers as Web `Headers` (HTTP/2 pseudo-headers dropped). */
export function toWebHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers()
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined || key.startsWith(':')) continue
		if (Array.isArray(value))
			for (const item of value) headers.append(key, item)
		else headers.append(key, value)
	}
	return headers
}

/** Writes a Web `Response` (a context factory's early answer) to `res`. */
export async function sendWebResponse(
	res: ServerResponse,
	response: Response
): Promise<void> {
	const headers: OutgoingHttpHeaders = {}
	response.headers.forEach((value, key) => {
		if (key !== 'set-cookie') headers[key] = value
	})
	const cookies = response.headers.getSetCookie()
	if (cookies.length) headers['set-cookie'] = cookies
	res.writeHead(response.status, headers)
	if (!response.body) {
		res.end()
		return
	}
	await pipeline(Readable.fromWeb(response.body as never), res)
}

function flatten(value: unknown): string | undefined {
	if (value === undefined) return undefined
	return Array.isArray(value) ? value.join(', ') : String(value)
}

type Callback = (error?: Error | null) => void
type WriteArgs = [chunk?: unknown, encoding?: unknown, callback?: unknown]
// The overloads of `writeHead`/`write`/`end`, flattened for forwarding
// arguments as given.
type WriteHead = (this: ServerResponse, ...args: unknown[]) => ServerResponse
type Write = (this: ServerResponse, ...args: unknown[]) => boolean
type End = (this: ServerResponse, ...args: unknown[]) => ServerResponse

function chunkOf([chunk, encoding]: WriteArgs): Buffer | undefined {
	if (chunk === undefined || chunk === null || typeof chunk === 'function')
		return undefined
	if (typeof chunk === 'string')
		return Buffer.from(
			chunk,
			typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
		)
	const bytes = chunk as Uint8Array
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function callbackOf(args: WriteArgs): Callback | undefined {
	for (let index = args.length - 1; index >= 0; index--)
		if (typeof args[index] === 'function') return args[index] as Callback
	return undefined
}

/**
 * Runs `send` (oRPC writing its response to `res`) and compresses JSON and
 * streaming batches on the way out, as the Fetch adapter does. oRPC's node
 * handler sets the status and headers on `res`, then calls `end(body)` or
 * pipes a stream, so `write` and `end` are wrapped for this response only and
 * decide on the first call, when the headers are known. A `writeHead` before
 * that is held back until then. oRPC's own `ResponseCompressionHandlerPlugin`
 * is not used (see docs/decisions.md).
 */
export async function withNodeCompression<T>(
	request: { method?: string | undefined; headers: IncomingHttpHeaders },
	res: ServerResponse,
	send: () => Promise<T>
): Promise<T> {
	if (request.method === 'HEAD') return send()
	const encoding = negotiateEncoding(
		flatten(request.headers['accept-encoding'])
	)
	if (!encoding) return send()

	const { writeHead, write, end } = res
	const restore = () => {
		res.writeHead = writeHead
		res.write = write
		res.end = end
	}
	const writeRaw = write as Write
	const endRaw = end as End
	const header = (name: string) => flatten(res.getHeader(name))

	// A compressed body has the compressed length, or none for a stream.
	const setEncodedHeaders = (length?: number) => {
		res.setHeader('content-encoding', encoding)
		if (length === undefined) res.removeHeader('content-length')
		else res.setHeader('content-length', length)
		const vary = varyWithAcceptEncoding(header('vary'))
		if (vary) res.setHeader('vary', vary)
	}

	// Wraps `res` for the response's kind; false leaves it as oRPC wrote it.
	const start = (): boolean => {
		restore()
		const kind = res.headersSent ? undefined : compressionKind(header)
		if (kind === 'batch-stream') {
			setEncodedHeaders()
			streamCompressed(res, encoding, writeRaw, endRaw)
		} else if (kind === 'json') {
			collectBody(res, async (raw, callback) => {
				restore()
				let body: Uint8Array = raw
				if (raw.byteLength >= MIN_COMPRESS_BYTES) {
					body = await compressBytes(encoding, raw)
					// The client may have gone while the body compressed.
					if (res.destroyed) return
					setEncodedHeaders(body.byteLength)
				}
				endRaw.call(res, body, ...(callback ? [callback] : []))
			})
		}
		return kind !== undefined
	}

	res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
		const given = rest.find((arg) => typeof arg === 'object' && arg !== null)
		// Raw header arrays are passed straight through, uncompressed.
		if (Array.isArray(given)) {
			restore()
			return (writeHead as WriteHead).call(res, statusCode, ...rest)
		}
		res.statusCode = statusCode
		const message = rest.find((arg) => typeof arg === 'string')
		if (message !== undefined) res.statusMessage = message as string
		for (const [name, value] of Object.entries(
			(given ?? {}) as OutgoingHttpHeaders
		))
			if (value !== undefined) res.setHeader(name, value)
		return res
	}) as typeof res.writeHead
	res.write = ((...args: WriteArgs) => {
		start()
		return (res.write as Write).call(res, ...args)
	}) as typeof res.write
	res.end = ((...args: WriteArgs) => {
		start()
		return (res.end as End).call(res, ...args)
	}) as typeof res.end

	try {
		return await send()
	} finally {
		// oRPC resolves once `res` closed, or without writing when unmatched.
		restore()
	}
}

/** Buffers what is written to `res` and hands the whole body to `onEnd`. */
function collectBody(
	res: ServerResponse,
	onEnd: (raw: Buffer, callback: Callback | undefined) => Promise<void>
): void {
	const chunks: Buffer[] = []
	res.write = ((...args: WriteArgs) => {
		const chunk = chunkOf(args)
		if (chunk) chunks.push(chunk)
		callbackOf(args)?.()
		return true
	}) as typeof res.write
	res.end = ((...args: WriteArgs) => {
		const chunk = chunkOf(args)
		if (chunk) chunks.push(chunk)
		onEnd(Buffer.concat(chunks), callbackOf(args)).catch((error: Error) =>
			res.destroy(error)
		)
		return res
	}) as typeof res.end
}

/** Routes what is written to `res` through a compressor that flushes each chunk. */
function streamCompressed(
	res: ServerResponse,
	encoding: Encoding,
	write: Write,
	end: End
): void {
	const compressor = createFlushingCompressor(encoding)
	compressor.on('data', (chunk: Buffer) => write.call(res, chunk))
	compressor.once('end', () => end.call(res))
	compressor.once('error', (error) => res.destroy(error))
	res.once('close', () => compressor.destroy())

	// Results are already in memory, so the compressor buffers instead of
	// pushing back on the pipe.
	res.write = ((...args: WriteArgs) => {
		const chunk = chunkOf(args)
		if (chunk) compressor.write(chunk, callbackOf(args))
		return true
	}) as typeof res.write
	res.end = ((...args: WriteArgs) => {
		const chunk = chunkOf(args)
		if (chunk) compressor.write(chunk)
		compressor.end(callbackOf(args))
		return res
	}) as typeof res.end
}
