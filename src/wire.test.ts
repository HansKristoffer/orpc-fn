// The wire helpers against the real link and the real handler: what they
// encode is byte for byte what oRPC sends, and what they decode is what it
// would have read. A change to oRPC's format fails here.
import { describe, expect, test } from 'bun:test'
import { createORPCClient, ORPCError } from '@orpc/client'
import { os, type RouterClient } from '@orpc/server'
import { z } from 'zod'
import { quiet } from '../tests/fixture.js'
import {
	createRpcLink,
	decodeRpcBatchRequest,
	decodeRpcBatchResponse,
	decodeRpcRequest,
	decodeRpcResponse,
	encodeRpcBatchRequest,
	encodeRpcBatchResponse,
	encodeRpcRequest,
	encodeRpcResponse
} from './client.js'
import { createFetchHandler } from './fetch.js'
import { createFn } from './index.js'

const { fn, createRouter } = createFn({
	procedures: { public: os.$context<{ headers: Headers }>() },
	default: 'public',
	logger: () => quiet
})

const since = new Date('2026-01-02T03:04:05.000Z')
const order = {
	id: 'o1',
	placedAt: since,
	total: 12n,
	tags: new Set(['a']),
	lines: new Map([[1, { sku: 'x', note: undefined }]])
}

const router = createRouter({
	order: {
		get: fn({
			name: 'order.get',
			input: z.object({ id: z.string(), since: z.date() }),
			handler: ({ input }) => ({
				...order,
				id: input.id,
				placedAt: input.since
			})
		}),
		taken: fn({
			name: 'order.taken',
			handler: () => {
				throw new ORPCError('CONFLICT', {
					message: 'Name is taken',
					data: { at: since }
				})
			}
		})
	},
	nothing: fn({ name: 'nothing', handler: () => undefined }),
	none: fn({ name: 'none', handler: () => null }),
	text: fn({ name: 'text', handler: () => 'csv;line' })
})
type Router = typeof router

const handler = createFetchHandler({
	router,
	rpcPrefix: '/rpc',
	compress: false
})
const json = { 'content-type': 'application/json' }
const post = (
	path: string,
	body: string,
	headers: Record<string, string> = {}
) =>
	handler(
		new Request(`http://localhost${path}`, {
			method: 'POST',
			...(body === ''
				? { headers }
				: { headers: { ...json, ...headers }, body })
		})
	)

type Exchange = {
	path: string
	headers: Headers
	request: string
	status: number
	response: string
}

/** A client whose HTTP exchanges are recorded, answered by `answer`. */
function recordingClient(
	answer: (request: Request, body: string) => Response | Promise<Response>,
	batch: false | { mode: 'streaming' | 'buffered' } = false
) {
	const exchanges: Exchange[] = []
	const client: RouterClient<Router> = createORPCClient(
		createRpcLink({
			origin: 'http://localhost',
			url: '/rpc',
			batch,
			fetch: async (url, init) => {
				const request = new Request(url, init)
				const body = await request.clone().text()
				const response = await answer(request, body)
				exchanges.push({
					path: new URL(request.url).pathname,
					headers: request.headers,
					request: body,
					status: response.status,
					response: await response.clone().text()
				})
				return response
			}
		})
	)
	return { client, exchanges }
}

describe('single calls', () => {
	test('encode what the link and the handler send, byte for byte', async () => {
		const { client, exchanges } = recordingClient((request) => handler(request))
		const input = { id: 'o2', since }
		expect(await client.order.get(input)).toEqual({ ...order, id: 'o2' })
		await client.nothing()
		await client.none()
		await client.text()
		await client.order.taken().catch(() => {})

		const [get, nothing, none, text, taken] = exchanges
		expect(get?.request).toBe(encodeRpcRequest(input))
		expect(get?.response).toBe(encodeRpcResponse({ ...order, id: 'o2' }))
		// No input and no output are an empty body, not `{}` or `null`.
		expect(nothing?.request).toBe(encodeRpcRequest(undefined))
		expect(nothing?.response).toBe(encodeRpcResponse(undefined))
		expect(encodeRpcResponse(undefined)).toBe('')
		expect(none?.response).toBe(encodeRpcResponse(null))
		expect(text?.response).toBe(encodeRpcResponse('csv;line'))
		expect(taken?.status).toBe(409)
		expect(taken?.response).toBe(
			encodeRpcResponse(
				new ORPCError('CONFLICT', {
					message: 'Name is taken',
					data: { at: since }
				})
			)
		)
	})

	test('an encoded request is read by the handler, an encoded response by the link', async () => {
		const response = await post(
			'/rpc/order/get',
			encodeRpcRequest({ id: 'o3', since })
		)
		expect(response.status).toBe(200)
		expect(decodeRpcResponse(await response.text())).toEqual({
			...order,
			id: 'o3'
		})
		const empty = await post('/rpc/nothing', encodeRpcRequest(undefined))
		expect(decodeRpcResponse(await empty.text())).toBeUndefined()
		const failed = await post('/rpc/order/taken', '')
		expect(decodeRpcResponse(await failed.json())).toEqual({
			defined: false,
			code: 'CONFLICT',
			message: 'Name is taken',
			data: { at: since }
		})

		// A mock: what `route.fulfill({ contentType, body })` would answer.
		const outputs: Record<string, { status?: number; output: unknown }> = {
			'/rpc/order/get': { output: { ...order, id: 'mocked' } },
			'/rpc/nothing': { output: undefined },
			'/rpc/none': { output: null },
			'/rpc/order/taken': {
				status: 409,
				output: new ORPCError('CONFLICT', { data: { at: since } })
			}
		}
		const inputs: unknown[] = []
		const { client } = recordingClient((request, body) => {
			inputs.push(decodeRpcRequest(body))
			const mock = outputs[new URL(request.url).pathname]
			return new Response(encodeRpcResponse(mock?.output), {
				status: mock?.status ?? 200,
				headers: json
			})
		})
		expect(await client.order.get({ id: 'o4', since })).toEqual({
			...order,
			id: 'mocked'
		})
		expect(await client.nothing()).toBeUndefined()
		expect(await client.none()).toBeNull()
		const error = await client.order.taken().catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(ORPCError)
		expect(error).toMatchObject({ code: 'CONFLICT', data: { at: since } })
		expect(inputs).toEqual([
			{ id: 'o4', since },
			undefined,
			undefined,
			undefined
		])
	})
})

describe('batches', () => {
	test('encode the batch request the link sends, and read what the handler answers', async () => {
		const { client, exchanges } = recordingClient(
			(request) => handler(request),
			{ mode: 'buffered' }
		)
		const input = { id: 'o5', since }
		const settled = await Promise.allSettled([
			client.order.get(input),
			client.nothing(),
			client.order.taken()
		])
		expect(settled.map((result) => result.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'rejected'
		])
		expect(exchanges).toHaveLength(1)
		const [batch] = exchanges
		expect(batch?.path).toBe('/rpc/order/get/__batch__')
		expect(batch?.headers.get('orpc-batch')).toBe('buffered')

		const calls = [
			{ url: '/rpc/order/get', input },
			{ url: '/rpc/nothing' },
			{ url: '/rpc/order/taken' }
		]
		expect(batch?.request).toBe(encodeRpcBatchRequest(calls))
		expect(decodeRpcBatchRequest(batch?.request)).toEqual([
			{ id: '1', url: '/rpc/order/get', input },
			{ id: '2', url: '/rpc/nothing', input: undefined },
			{ id: '3', url: '/rpc/order/taken', input: undefined }
		])

		const results = decodeRpcBatchResponse(batch?.response)
		const byId = (id: string) => results.find((result) => result.id === id)
		expect(byId('1')).toEqual({
			id: '1',
			status: 200,
			output: { ...order, id: 'o5' }
		})
		expect(byId('2')).toEqual({ id: '2', status: 200, output: undefined })
		expect(byId('3')).toMatchObject({
			status: 409,
			output: { code: 'CONFLICT', data: { at: since } }
		})
		// Re-encoded, it is the handler's own body again.
		expect(encodeRpcBatchResponse(results)).toBe(batch?.response ?? '')

		// Sent by hand, as a test's `page.request.post` would.
		const direct = await post(
			'/rpc/order/get/__batch__',
			encodeRpcBatchRequest(calls),
			{ 'orpc-batch': 'buffered' }
		)
		expect(direct.status).toBe(207)
		expect(
			decodeRpcBatchResponse(await direct.json()).map(({ status }) => status)
		).toEqual(expect.arrayContaining([200, 200, 409]))
	})

	test.each(['streaming', 'buffered'] as const)(
		'a %s link reads an encoded batch response',
		async (mode) => {
			const { client, exchanges } = recordingClient(
				(_request, body) =>
					new Response(
						encodeRpcBatchResponse(
							decodeRpcBatchRequest(body)
								.reverse()
								.map(({ id, url, input }) =>
									url === '/rpc/order/taken'
										? { id, status: 409, output: new ORPCError('CONFLICT') }
										: url === '/rpc/order/get'
											? { id, output: { ...order, ...(input as object) } }
											: { id }
								)
						),
						{ status: 207, headers: json }
					),
				{ mode }
			)
			const [get, nothing, taken] = await Promise.allSettled([
				client.order.get({ id: 'o6', since }),
				client.nothing(),
				client.order.taken()
			])
			expect(exchanges).toHaveLength(1)
			expect(get).toMatchObject({
				status: 'fulfilled',
				value: { id: 'o6', total: 12n, placedAt: since }
			})
			expect(nothing).toEqual({ status: 'fulfilled', value: undefined })
			expect(taken).toMatchObject({
				status: 'rejected',
				reason: { code: 'CONFLICT' }
			})
		}
	)
})

test('bodies the helpers cannot speak for fail with a reason', () => {
	const file = new File(['a'], 'a.csv')
	expect(() => encodeRpcRequest({ file })).toThrow('Blob or File')
	expect(() => encodeRpcResponse(file)).toThrow('Blob or File')
	expect(() => decodeRpcResponse('<html>')).toThrow('not JSON')
	expect(() => decodeRpcResponse('"text"')).toThrow('not an oRPC body')
	expect(() => decodeRpcBatchResponse('{"json":1}')).toThrow('JSON array')
	// A streaming batch's frames are not JSON.
	expect(() =>
		decodeRpcBatchResponse('\0\0\0&{"id":"1","kind":"response"}')
	).toThrow('not JSON')
	expect(() =>
		decodeRpcBatchRequest([{ id: '1', kind: 'response', json: {} }])
	).toThrow('request message')
})
