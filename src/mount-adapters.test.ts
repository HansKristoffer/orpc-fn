// orpc-fn/fetch and orpc-fn/node share one suite, each over a real HTTP
// server: Bun.serve for the Fetch handler, node:http for the Node handler.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request as httpRequest
} from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { createORPCClient } from '@orpc/client'
import { ORPCError, os, type RouterClient } from '@orpc/server'
import { CORSHandlerPlugin } from '@orpc/server/plugins'
import { z } from 'zod'
import { captureStreamingBatch } from '../tests/batch.js'
import { quiet } from '../tests/fixture.js'
import { createRpcLink } from './client.js'
import { createFetchHandler, type FetchHandlerOptions, timed } from './fetch.js'
import { createFn } from './index.js'
import { createNodeHandler } from './node.js'
import type { RequestTiming } from './http/mount.js'
import { hasTag } from './meta.js'

type Ctx = {
	headers: Headers
	timing: RequestTiming
	resHeaders?: Headers
	user?: { id: string }
}
const publicProcedure = os.$context<Ctx>()
const protectedProcedure = publicProcedure.use(({ context, next }) => {
	if (!context.user) throw new ORPCError('UNAUTHORIZED')
	return next({ context: { user: context.user } })
})
const { fn, createRouter } = createFn({
	procedures: { public: publicProcedure, protected: protectedProcedure },
	default: 'public',
	logger: () => quiet
})

const store = new AsyncLocalStorage<{ requestId: string }>()
let releaseSlow = () => {}
let slowGate = Promise.resolve()
const rows = Array.from({ length: 2000 }, (_, id) => ({
	id,
	name: `row ${id}`
}))

const router = createRouter({
	echo: fn({
		name: 'echo',
		method: 'GET',
		path: '/echo',
		tags: ['external'],
		input: z.object({ text: z.string() }),
		handler: ({ input }) => ({ text: input.text })
	}),
	me: fn({
		name: 'me',
		procedure: 'protected',
		handler: ({ context }) => ({ id: context.user.id })
	}),
	cached: fn({
		name: 'cached',
		method: 'GET',
		path: '/cached',
		tags: ['external'],
		handler: ({ context }) => {
			context.resHeaders?.set('cache-control', 'public, max-age=60')
			context.resHeaders?.set('cdn-cache-control', 'public, s-maxage=300')
			return { cached: true }
		}
	}),
	big: fn({ name: 'big', handler: () => ({ rows }) }),
	slow: fn({
		name: 'slow',
		handler: async () => {
			await slowGate
			return { done: true }
		}
	}),
	limited: fn({
		name: 'limited',
		method: 'GET',
		path: '/limited',
		tags: ['external'],
		errors: { RATE_LIMITED: {} },
		handler: () => {
			throw new ORPCError('RATE_LIMITED')
		}
	}),
	bigTagged: fn({
		name: 'bigTagged',
		handler: ({ context }) => {
			context.resHeaders?.set('etag', '"v1"')
			context.resHeaders?.set('accept-ranges', 'bytes')
			return { rows }
		}
	}),
	partial: fn({
		name: 'partial',
		handler: ({ context }) => {
			context.resHeaders?.set('content-range', 'bytes 0-99/200')
			return { rows }
		}
	}),
	upstream: fn({
		name: 'upstream',
		handler: () => {
			throw new ORPCError('UPSTREAM_DOWN')
		}
	}),
	crash: fn({
		name: 'crash',
		handler: () => {
			throw new Error('db down')
		}
	}),
	missing: fn({
		name: 'missing',
		handler: () => {
			throw new ORPCError('NOT_FOUND')
		}
	}),
	requestId: fn({
		name: 'requestId',
		handler: async () => {
			await new Promise((resolve) => setTimeout(resolve, 1))
			return store.getStore()?.requestId ?? null
		}
	}),
	upload: fn({
		name: 'upload',
		input: z.object({ file: z.instanceof(File) }),
		handler: async ({ input }) => ({
			name: input.file.name,
			type: input.file.type,
			text: await input.file.text()
		})
	}),
	download: fn({
		name: 'download',
		input: z.object({ text: z.string() }),
		handler: ({ input }) =>
			new File([input.text], 'export.csv', { type: 'text/csv' })
	}),
	ticks: fn({
		name: 'ticks',
		stream: true,
		handler: async function* () {
			yield 1
		}
	})
})
type Router = typeof router
type Options = Omit<
	FetchHandlerOptions<Router>,
	'router' | 'context' | 'queueMs' | 'rpcPrefix'
> & {
	context?: (
		request: Request | IncomingMessage,
		base: { headers: Headers; timing: RequestTiming }
	) => Ctx | Response | Promise<Ctx | Response>
}
type Served = { url: string; close(): Promise<void> }

/** Each adapter served for real, optionally inside `store.run` per request. */
const adapters: Array<{
	name: 'fetch' | 'node'
	serve(options: Options, withStore?: boolean): Promise<Served>
}> = [
	{
		name: 'fetch',
		async serve(options, withStore) {
			const handler = createFetchHandler({
				router,
				rpcPrefix: '/rpc',
				...options
			})
			const server = Bun.serve({
				port: 0,
				fetch: (request) =>
					withStore
						? store.run(
								{ requestId: request.headers.get('x-request-id') ?? '' },
								() => handler(request)
							)
						: handler(request)
			})
			return {
				url: server.url.origin,
				close: async () => {
					await server.stop(true)
				}
			}
		}
	},
	{
		name: 'node',
		async serve(options, withStore) {
			const handler = createNodeHandler({
				router,
				rpcPrefix: '/rpc',
				...options
			})
			const server = createServer((req, res) => {
				const run = () => handler(req, res)
				void (withStore
					? store.run(
							{ requestId: String(req.headers['x-request-id'] ?? '') },
							run
						)
					: run())
			})
			await new Promise<void>((resolve) =>
				server.listen(0, '127.0.0.1', resolve)
			)
			const { port } = server.address() as AddressInfo
			return {
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((resolve) => {
						server.closeAllConnections()
						server.close(() => resolve())
					})
			}
		}
	}
]

type RawResponse = {
	status: number
	headers: IncomingHttpHeaders
	body: Buffer
}

/** node:http client: the bytes as sent, nothing decompressed. */
function raw(
	url: string,
	init: {
		method?: string
		headers?: Record<string, string>
		body?: string
	} = {}
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			url,
			{ method: init.method ?? 'POST', headers: init.headers },
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks)
					})
				)
				res.on('error', reject)
			}
		)
		req.on('error', reject)
		req.end(init.body)
	})
}

/** A streaming response, decompressed as its chunks arrive. */
function openStream(
	url: string,
	init: { headers: Record<string, string>; body: string | Uint8Array }
): Promise<{
	headers: IncomingHttpHeaders
	readUntil(text: string): Promise<string>
}> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			url,
			{ method: 'POST', headers: init.headers },
			(res) => {
				const encoding = res.headers['content-encoding']
				const decoded =
					encoding === 'br'
						? res.pipe(zlib.createBrotliDecompress())
						: encoding === 'gzip'
							? res.pipe(zlib.createGunzip())
							: res
				let received = ''
				const waiters: Array<() => void> = []
				decoded.on('data', (chunk: Buffer) => {
					received += chunk.toString()
					for (const waiter of waiters.splice(0)) waiter()
				})
				resolve({
					headers: res.headers,
					readUntil: async (text) => {
						while (!received.includes(text))
							await new Promise<void>((wake) => waiters.push(wake))
						return received
					}
				})
			}
		)
		req.on('error', reject)
		req.end(init.body)
	})
}

const rpcBody = (json: unknown = null) => JSON.stringify({ json })
const decode = (response: RawResponse) => {
	const encoding = response.headers['content-encoding']
	const body =
		encoding === 'br'
			? zlib.brotliDecompressSync(response.body)
			: encoding === 'gzip'
				? zlib.gunzipSync(response.body)
				: response.body
	return JSON.parse(body.toString())
}

for (const adapter of adapters) {
	describe(`orpc-fn/${adapter.name}`, () => {
		const servers: Served[] = []
		const serve = async (options: Options = {}, withStore = false) => {
			const served = await adapter.serve(options, withStore)
			servers.push(served)
			return served.url
		}
		afterEach(async () => {
			await Promise.all(servers.splice(0).map((served) => served.close()))
		})
		beforeEach(() => {
			slowGate = new Promise((resolve) => {
				releaseSlow = resolve
			})
		})

		test('createRpcLink round-trip: a single call and a batch in one request', async () => {
			const url = await serve()
			let requests = 0
			const client: RouterClient<Router> = createORPCClient(
				createRpcLink({
					origin: url,
					url: '/rpc',
					fetch: (input, init) => {
						requests++
						return fetch(input, init)
					}
				})
			)
			expect(await client.big()).toEqual({ rows })
			expect(requests).toBe(1)
			releaseSlow()
			const [echo, big, slow] = await Promise.all([
				client.echo({ text: 'hi' }),
				client.big(),
				client.slow()
			])
			expect(echo).toEqual({ text: 'hi' })
			expect(big.rows).toHaveLength(2000)
			expect(slow).toEqual({ done: true })
			expect(requests).toBe(2)
		})

		test('the context factory builds the context or answers itself', async () => {
			const url = await serve({
				context: (_request, base) =>
					base.headers.get('authorization') === 'Bearer ok'
						? { ...base, user: { id: 'user-1' } }
						: base.headers.has('x-deny')
							? new Response('nope', {
									status: 401,
									headers: [
										['set-cookie', 'a=1'],
										['set-cookie', 'b=2']
									]
								})
							: base
			})
			const ok = await raw(`${url}/rpc/me`, {
				headers: {
					authorization: 'Bearer ok',
					'content-type': 'application/json'
				},
				body: rpcBody()
			})
			expect(decode(ok)).toEqual({ json: { id: 'user-1' } })
			const anonymous = await raw(`${url}/rpc/me`, {
				headers: { 'content-type': 'application/json' },
				body: rpcBody()
			})
			expect(anonymous.status).toBe(401)
			const denied = await raw(`${url}/rpc/me`, {
				headers: { 'x-deny': '1' },
				body: rpcBody()
			})
			expect(denied.status).toBe(401)
			expect(denied.body.toString()).toBe('nope')
			expect(denied.headers['set-cookie']).toEqual(['a=1', 'b=2'])
		})

		test('procedures set Cache-Control and CDN-Cache-Control through resHeaders', async () => {
			const url = await serve({
				openapi: { prefix: '/api', filter: hasTag('external') }
			})
			for (const response of [
				await raw(`${url}/rpc/cached`, {
					headers: { 'content-type': 'application/json' },
					body: rpcBody()
				}),
				await raw(`${url}/api/cached`, { method: 'GET' })
			]) {
				expect(response.status).toBe(200)
				expect(response.headers['cache-control']).toBe('public, max-age=60')
				expect(response.headers['cdn-cache-control']).toBe(
					'public, s-maxage=300'
				)
			}
			const plain = await raw(`${url}/api/echo?text=x`, { method: 'GET' })
			expect(decode(plain)).toEqual({ text: 'x' })
			expect(plain.headers['cache-control']).toBeUndefined()
		})

		test('Server-Timing reports total, timed() work and handler time', async () => {
			const url = await serve({
				context: async (_request, base) => ({
					...base,
					user: await timed(base.timing, 'auth_ms', async () => ({
						id: 'user-1'
					}))
				})
			})
			const response = await raw(`${url}/rpc/me`, {
				headers: { 'content-type': 'application/json' },
				body: rpcBody()
			})
			expect(response.headers['server-timing']).toMatch(
				/^total;dur=[\d.]+, auth;dur=[\d.]+, handler;dur=[\d.]+$/
			)
			expect(response.headers['access-control-expose-headers']).toContain(
				'Server-Timing'
			)
			const off = await serve({ serverTiming: false })
			const untimed = await raw(`${off}/rpc/me`, { body: rpcBody() })
			expect(untimed.headers['server-timing']).toBeUndefined()
		})

		test('large JSON is compressed with brotli or gzip as the client accepts', async () => {
			const url = await serve()
			const call = (acceptEncoding?: string) =>
				raw(`${url}/rpc/big`, {
					headers: {
						'content-type': 'application/json',
						...(acceptEncoding ? { 'accept-encoding': acceptEncoding } : {})
					},
					body: rpcBody()
				})
			const plainSize = JSON.stringify({ json: { rows } }).length
			const br = await call('gzip, deflate, br')
			expect(br.headers['content-encoding']).toBe('br')
			expect(br.headers.vary).toContain('accept-encoding')
			expect(Number(br.headers['content-length'])).toBe(br.body.byteLength)
			expect(br.body.byteLength).toBeLessThan(plainSize / 4)
			expect(decode(br)).toEqual({ json: { rows } })

			const gzip = await call('gzip')
			expect(gzip.headers['content-encoding']).toBe('gzip')
			expect(decode(gzip)).toEqual({ json: { rows } })

			const identity = await call()
			expect(identity.headers['content-encoding']).toBeUndefined()
			expect(identity.body.byteLength).toBe(plainSize)

			const tiny = await raw(`${url}/rpc/echo`, {
				headers: {
					'content-type': 'application/json',
					'accept-encoding': 'br'
				},
				body: rpcBody({ text: 'x' })
			})
			expect(tiny.headers['content-encoding']).toBeUndefined()
			expect(decode(tiny)).toEqual({ json: { text: 'x' } })

			const off = await serve({ compress: false })
			const uncompressed = await raw(`${off}/rpc/big`, {
				headers: { 'accept-encoding': 'br' },
				body: rpcBody()
			})
			expect(uncompressed.headers['content-encoding']).toBeUndefined()
		})

		for (const encoding of ['br', 'gzip'] as const) {
			test(`a ${encoding} batch stream delivers a result before a slower one`, async () => {
				const url = await serve()
				const batch = await captureStreamingBatch(['big', 'slow'])
				const stream = await openStream(`${url}${batch.path}`, {
					headers: { ...batch.headers, 'accept-encoding': encoding },
					body: batch.body
				})
				expect(stream.headers['content-encoding']).toBe(encoding)
				expect(stream.headers['content-length']).toBeUndefined()
				// The slow result is still pending, yet the fast one is readable.
				expect(await stream.readUntil('"row 1999"')).not.toContain('"done"')
				releaseSlow()
				expect(await stream.readUntil('"done":true')).toContain('"done":true')
			})
		}

		test('live event streams stay uncompressed and unbuffered', async () => {
			const url = await serve()
			const response = await raw(`${url}/rpc/ticks`, {
				headers: {
					'accept-encoding': 'br',
					'content-type': 'application/json'
				},
				body: rpcBody()
			})
			expect(response.headers['content-type']).toContain('text/event-stream')
			expect(response.headers['content-encoding']).toBeUndefined()
			expect(response.headers['cache-control']).toBe('no-cache')
			expect(response.headers['x-accel-buffering']).toBe('no')
			expect(response.body.toString()).toContain('data: {"json":1}')
		})

		test('onError sees unexpected errors only', async () => {
			const onError = mock(() => {})
			const url = await serve({ onError })
			const crash = await raw(`${url}/rpc/crash`, { body: rpcBody() })
			expect(crash.status).toBe(500)
			expect(decode(crash).json.code).toBe('INTERNAL_SERVER_ERROR')
			expect(JSON.stringify(decode(crash))).not.toContain('db down')
			expect(
				(await raw(`${url}/rpc/missing`, { body: rpcBody() })).status
			).toBe(404)
			expect(onError).toHaveBeenCalledTimes(1)
			expect(onError.mock.calls[0]).toMatchObject([
				expect.objectContaining({ message: 'db down' }),
				{ url: '/rpc/crash', method: 'POST' }
			])
		})

		test('errorStatusMap sets statuses and decides what reaches onError', async () => {
			const onError = mock(() => {})
			const url = await serve({
				onError,
				errorStatusMap: { RATE_LIMITED: 429, UPSTREAM_DOWN: 502 }
			})
			const limited = await raw(`${url}/rpc/limited`, { body: rpcBody() })
			expect(limited.status).toBe(429)
			const upstream = await raw(`${url}/rpc/upstream`, { body: rpcBody() })
			expect(upstream.status).toBe(502)
			// The common map still applies to codes the app did not map.
			const missing = await raw(`${url}/rpc/missing`, { body: rpcBody() })
			expect(missing.status).toBe(404)
			expect(onError).toHaveBeenCalledTimes(1)
			expect(onError.mock.calls[0]).toMatchObject([
				expect.objectContaining({ code: 'UPSTREAM_DOWN' }),
				{ url: '/rpc/upstream', method: 'POST' }
			])
		})

		test('AsyncLocalStorage around the handler reaches procedures, batched or not', async () => {
			const url = await serve({}, true)
			const client: RouterClient<Router> = createORPCClient(
				createRpcLink({
					origin: url,
					url: '/rpc',
					headers: { 'x-request-id': 'req-42' }
				})
			)
			expect(await client.requestId()).toBe('req-42')
			expect(
				await Promise.all([client.requestId(), client.requestId()])
			).toEqual(['req-42', 'req-42'])
		})

		test('files round-trip: upload a File, download a Blob', async () => {
			const url = await serve()
			const client: RouterClient<Router> = createORPCClient(
				createRpcLink({ origin: url, url: '/rpc', batch: false })
			)
			const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' })
			expect(await client.upload({ file })).toEqual({
				name: 'data.csv',
				type: 'text/csv',
				text: 'a,b\n1,2'
			})
			const downloaded = await client.download({ text: 'x,y' })
			expect(downloaded).toBeInstanceOf(Blob)
			expect(await downloaded.text()).toBe('x,y')
			expect((downloaded as File).name).toBe('export.csv')
		})

		test('the OpenAPI mount serves REST routes, the spec and docs', async () => {
			const url = await serve({
				errorStatusMap: { RATE_LIMITED: 429 },
				openapi: {
					prefix: '/api',
					filter: hasTag('external'),
					info: { title: 'Admin API', version: '1.0.0' }
				}
			})
			const spec = await raw(`${url}/api/spec.json`, { method: 'GET' })
			const doc = decode(spec)
			expect(Object.keys(doc.paths)).toEqual(['/echo', '/cached', '/limited'])
			// errorStatusMap flows into the generated spec so it agrees with the server.
			expect(doc.paths['/limited'].get.responses['429']).toBeDefined()
			const docs = await raw(`${url}/api`, { method: 'GET' })
			expect(docs.headers['content-type']).toContain('text/html')
			expect((await raw(`${url}/api/big`, { method: 'GET' })).status).toBe(404)
		})

		test('several OpenAPI surfaces, docs pages with their own specs, and an error body with its status', async () => {
			const url = await serve({
				errorStatusMap: { RATE_LIMITED: 429 },
				openapi: [
					{ prefix: '/internal', filter: () => true, docs: false },
					{
						prefix: '/v1',
						filter: hasTag('external'),
						spec: { version: '3.1.1' },
						errorResponseBodyEncoder: (error, status) => ({
							...error.toJSON(),
							status
						}),
						docs: [
							{
								path: '/customer',
								specPath: '/customer/spec.json',
								filter: (_procedure, path) => path[0] === 'echo',
								info: { title: 'Customer API', version: '1.0.0' }
							},
							{ info: { title: 'External API', version: '1.0.0' } }
						]
					}
				]
			})
			const customer = decode(
				await raw(`${url}/v1/customer/spec.json`, { method: 'GET' })
			)
			expect(customer.openapi).toBe('3.1.1')
			expect(customer.info.title).toBe('Customer API')
			expect(Object.keys(customer.paths)).toEqual(['/echo'])
			const external = decode(
				await raw(`${url}/v1/spec.json`, { method: 'GET' })
			)
			expect(external.info.title).toBe('External API')
			expect(Object.keys(external.paths)).toEqual([
				'/echo',
				'/cached',
				'/limited'
			])
			const page = await raw(`${url}/v1/customer`, { method: 'GET' })
			expect(page.headers['content-type']).toContain('text/html')
			// The REST error body carries the status, under errorStatusMap.
			const limited = await raw(`${url}/v1/limited`, { method: 'GET' })
			expect(limited.status).toBe(429)
			expect(decode(limited)).toMatchObject({
				code: 'RATE_LIMITED',
				status: 429
			})
			// The other surface keeps oRPC's body, and serves routes /v1 does not.
			const internal = await raw(`${url}/internal/limited`, { method: 'GET' })
			expect(internal.status).toBe(429)
			expect(decode(internal).status).toBeUndefined()
			expect(
				(await raw(`${url}/internal/spec.json`, { method: 'GET' })).status
			).toBe(404)
			// RPC errors keep oRPC's own format, which its client decodes.
			const rpc = await raw(`${url}/rpc/limited`, { body: rpcBody() })
			expect(decode(rpc).json.status).toBeUndefined()
		})

		test('compression weakens strong ETags, skips content-range and deduplicates exposed headers', async () => {
			const url = await serve({
				plugins: [
					new CORSHandlerPlugin({ exposeHeaders: ['Server-Timing', 'X-Other'] })
				]
			})
			const tagged = await raw(`${url}/rpc/bigTagged`, {
				headers: { 'accept-encoding': 'gzip', origin: 'https://app.test' },
				body: rpcBody()
			})
			expect(tagged.headers['content-encoding']).toBe('gzip')
			expect(tagged.headers.etag).toBe('W/"v1"')
			expect(tagged.headers['accept-ranges']).toBeUndefined()
			expect(tagged.headers['access-control-expose-headers']).toBe(
				'Server-Timing, X-Other'
			)

			const partial = await raw(`${url}/rpc/partial`, {
				headers: { 'accept-encoding': 'gzip' },
				body: rpcBody()
			})
			expect(partial.headers['content-encoding']).toBeUndefined()
			expect(partial.headers['content-range']).toBe('bytes 0-99/200')
		})

		test('requests outside the prefixes or matching no procedure get a 404', async () => {
			const url = await serve()
			const outside = await raw(`${url}/elsewhere`, { method: 'GET' })
			expect(outside.status).toBe(404)
			const unknown = await raw(`${url}/rpc/nope`, { body: rpcBody() })
			expect(unknown.status).toBe(404)
		})
	})
}

describe('adapter-specific behaviour', () => {
	test('SignalSyncHandlerPlugin aborts procedure signal when a streaming response is cancelled', async () => {
		let signalAborted!: () => void
		const aborted = new Promise<void>((resolve) => {
			signalAborted = resolve
		})
		const stream = fn({
			name: 'stream.cancel',
			stream: true,
			handler: async function* ({ signal }) {
				signal?.addEventListener('abort', () => signalAborted(), { once: true })
				yield 1
				await aborted
			}
		})
		const handler = createFetchHandler({
			router: createRouter({ stream }),
			rpcPrefix: '/rpc'
		})
		const response = await handler(
			new Request('http://localhost/rpc/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: rpcBody()
			})
		)
		const reader = response.body!.getReader()
		await reader.read()
		await reader.cancel()
		await aborted
	})

	test('createFetchHandler hands the Request to the context factory and validates options', async () => {
		const seen: string[] = []
		const handler = createFetchHandler({
			router,
			rpcPrefix: '/rpc',
			context: (request, base) => {
				seen.push(new URL(request.url).pathname)
				return base
			}
		})
		const response = await handler(
			new Request('http://localhost/rpc/echo', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: rpcBody({ text: 'a' })
			})
		)
		expect(await response.json()).toEqual({ json: { text: 'a' } })
		expect(seen).toEqual(['/rpc/echo'])
		// A spread can lose both; the types require one of them.
		const spread: object = {}
		expect(() =>
			createFetchHandler({ router, ...(spread as { rpcPrefix: '/rpc' }) })
		).toThrow('rpcPrefix or openapi')
		// @ts-expect-error a handler must serve RPC, OpenAPI or both
		expect(() => createNodeHandler({ router })).toThrow('rpcPrefix or openapi')
		expect(() =>
			createFetchHandler({
				router,
				rpcPrefix: '/rpc',
				// @ts-expect-error publishing routes over REST is an explicit choice
				openapi: { prefix: '/api' }
			})
		).toThrow('needs a filter')
	})

	test('createNodeHandler: Express-style next, parsed bodies and context errors', async () => {
		const seen: IncomingMessage[] = []
		const handler = createNodeHandler({
			router,
			rpcPrefix: '/rpc',
			context: (req, base) => {
				seen.push(req)
				if (req.headers['x-fail']) throw new Error('auth backend down')
				return base
			}
		})
		const next = mock((_error?: unknown) => {})
		const server = createServer(async (req, res) => {
			// What express.json() or Next's bodyParser leave behind.
			if (req.headers['x-pre-parsed']) {
				const chunks: Buffer[] = []
				for await (const chunk of req) chunks.push(chunk as Buffer)
				Object.assign(req, {
					body: JSON.parse(Buffer.concat(chunks).toString())
				})
			}
			await handler(req, res, (error) => {
				next(error)
				res.writeHead(error ? 500 : 418).end()
			})
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		try {
			const parsed = await raw(`${url}/rpc/echo`, {
				headers: { 'content-type': 'application/json', 'x-pre-parsed': '1' },
				body: rpcBody({ text: 'parsed' })
			})
			expect(decode(parsed)).toEqual({ json: { text: 'parsed' } })
			expect(seen[0]?.url).toBe('/rpc/echo')

			expect((await raw(`${url}/other`, { method: 'GET' })).status).toBe(418)
			expect(next).toHaveBeenLastCalledWith(undefined)

			const failed = await raw(`${url}/rpc/echo`, {
				headers: { 'x-fail': '1' },
				body: rpcBody({ text: 'x' })
			})
			expect(failed.status).toBe(500)
			expect(next.mock.lastCall?.[0]).toBeInstanceOf(Error)
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})
