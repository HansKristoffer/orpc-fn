// oRPC 2's RPC wire format as plain functions, for tests that speak HTTP
// without a client: a Playwright `page.route` mock, a `page.request` call.
// JSON bodies only. A `File` travels as multipart form data, a returned
// `Blob` as its raw bytes, a stream as an event stream; none has a JSON body.
import { ORPCError, RPCJsonSerializer } from '@orpc/client'

const serializer = /* @__PURE__ */ new RPCJsonSerializer()

/** One call of a batch request: `url` is the procedure's path, `/rpc/order/get`. */
export type RpcBatchCall = { id: string; url: string; input: unknown }

/**
 * One result of a batch response. At 400 and above `output` is the error as
 * oRPC sends it: `{ defined, code, message, data }`.
 */
export type RpcBatchResult = { id: string; status: number; output: unknown }

type Envelope = { json?: unknown; meta?: unknown }
type BatchMessage = {
	id: string
	kind: string
	json?: { url?: unknown; status?: unknown; body?: unknown }
}

function toEnvelope(value: unknown, what: string): Envelope | undefined {
	if (value === undefined) return undefined
	const { json, meta, blobs } = serializer.serializeJson(
		value instanceof ORPCError ? value.toJSON() : value
	)
	if (blobs?.length)
		throw new TypeError(
			`orpc-fn: ${what} holds a Blob or File, which has no JSON body (oRPC sends multipart form data, or the raw bytes of a returned Blob)`
		)
	return meta?.length ? { json, meta } : { json }
}

function fromEnvelope(envelope: unknown, what: string): unknown {
	if (envelope === undefined || envelope === null) return undefined
	if (typeof envelope !== 'object' || Array.isArray(envelope))
		throw new TypeError(`orpc-fn: ${what} is not an oRPC body ({ json, meta })`)
	const { json, meta } = envelope as Envelope
	if (meta !== undefined && !Array.isArray(meta))
		throw new TypeError(`orpc-fn: ${what} is not an oRPC body ({ json, meta })`)
	return serializer.deserializeJson({ json, meta })
}

/** A body as text, or already parsed (`postDataJSON()`, `response.json()`). */
function parse(body: unknown, what: string): unknown {
	if (typeof body !== 'string') return body ?? undefined
	if (body === '') return undefined
	try {
		return JSON.parse(body)
	} catch {
		throw new TypeError(`orpc-fn: ${what} is not JSON`)
	}
}

const stringify = (envelope: Envelope | undefined): string =>
	envelope === undefined ? '' : JSON.stringify(envelope)

/**
 * The body of a `POST` to a procedure, sent as `application/json`. An
 * `undefined` input is an empty body.
 *
 * ```ts
 * await page.request.post('/api/rpc/order/get', {
 *   headers: { 'content-type': 'application/json' },
 *   data: encodeRpcRequest({ id: 'o1', since: new Date(0) })
 * })
 * ```
 */
export function encodeRpcRequest(input: unknown): string {
	return stringify(toEnvelope(input, 'the input'))
}

/** The input a request body carries; the body as text or parsed JSON. */
export function decodeRpcRequest(body: unknown): unknown {
	return fromEnvelope(parse(body, 'the request body'), 'the request body')
}

/**
 * The body of a procedure's response, sent as `application/json`: the output
 * with status 200, or an `ORPCError` with the status its code answers.
 *
 * ```ts
 * await page.route('**\/api/rpc/order/get', (route) =>
 *   route.fulfill({ contentType: 'application/json', body: encodeRpcResponse(order) }))
 * // An error: status: 409, body: encodeRpcResponse(new ORPCError('CONFLICT', { message }))
 * ```
 */
export function encodeRpcResponse(output: unknown): string {
	return stringify(toEnvelope(output, 'the output'))
}

/**
 * The output a response body carries, with `Date`s and the other types oRPC
 * sends restored. An error response (status 400 and above) gives the error's
 * `{ defined, code, message, data }`.
 */
export function decodeRpcResponse(body: unknown): unknown {
	return fromEnvelope(parse(body, 'the response body'), 'the response body')
}

/**
 * The body of one batch request: `POST` it to `<first url>/__batch__` as
 * `application/json` with the header `orpc-batch: buffered`. Ids default to
 * `'1'`, `'2'`, ... as the link numbers them.
 */
export function encodeRpcBatchRequest(
	calls: readonly { url: string; input?: unknown; id?: string }[]
): string {
	return JSON.stringify(
		calls.map((call, index) => {
			const body = toEnvelope(call.input, `the input of ${call.url}`)
			return {
				id: call.id ?? String(index + 1),
				kind: 'request',
				json: body === undefined ? { url: call.url } : { url: call.url, body }
			}
		})
	)
}

/** The calls of a batch request body (the request has an `orpc-batch` header). */
export function decodeRpcBatchRequest(body: unknown): RpcBatchCall[] {
	return messages(body, 'request', 'the batch request body').map(
		({ id, json }) => {
			if (typeof json?.url !== 'string')
				throw new TypeError('orpc-fn: a batch request has no url')
			return {
				id,
				url: json.url,
				input: fromEnvelope(json.body, `the input of ${json.url}`)
			}
		}
	)
}

/**
 * The body of one batch response, sent with status 207 as `application/json`:
 * one result per call, by the call's `id`, in any order. `status` defaults
 * to 200; an error result passes its status and an `ORPCError` as `output`.
 * The link reads this form in either batch mode.
 */
export function encodeRpcBatchResponse(
	results: readonly { id: string; output?: unknown; status?: number }[]
): string {
	return JSON.stringify(
		results.map(({ id, output, status = 200 }) => {
			const body = toEnvelope(output, `the output of call ${id}`)
			return {
				id,
				kind: 'response',
				json: {
					...(status === 200 ? {} : { status }),
					...(body === undefined ? {} : { body })
				}
			}
		})
	)
}

/**
 * The results of a batch response body in oRPC's `buffered` form, a JSON
 * array. A `streaming` batch answers in length-prefixed frames, which this
 * does not read: send `orpc-batch: buffered`.
 */
export function decodeRpcBatchResponse(body: unknown): RpcBatchResult[] {
	return messages(body, 'response', 'the batch response body').map(
		({ id, json }) => ({
			id,
			status: typeof json?.status === 'number' ? json.status : 200,
			output: fromEnvelope(json?.body, `the output of call ${id}`)
		})
	)
}

function messages(body: unknown, kind: string, what: string): BatchMessage[] {
	const parsed = parse(body, what)
	if (!Array.isArray(parsed))
		throw new TypeError(
			`orpc-fn: ${what} is not a JSON array of oRPC batch messages`
		)
	return parsed.map((message: BatchMessage) => {
		if (
			typeof message !== 'object' ||
			message === null ||
			typeof message.id !== 'string' ||
			message.kind !== kind
		)
			throw new TypeError(
				`orpc-fn: ${what} holds something other than a ${kind} message`
			)
		return message
	})
}
