import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { ORPCError } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createRouter, fn, user } from '../tests/fixture.js'
import {
	formatServerTiming,
	markRequestArrival,
	mountOrpc,
	normalizeExpoOrigin
} from './hono.js'
import { hasTag } from './mcp.js'

describe('normalizeExpoOrigin (ported from orpc-context-headers.test.ts)', () => {
	test('copies expo-origin to origin when origin is missing', () => {
		const raw = new Headers({
			cookie: 'session=abc',
			'expo-origin': 'https://app.example.com'
		})
		const headers = normalizeExpoOrigin(raw)
		expect(headers.get('origin')).toBe('https://app.example.com')
		expect(headers.get('cookie')).toBe('session=abc')
	})

	test('does not override an existing origin header', () => {
		const raw = new Headers({
			origin: 'https://platform.example.com',
			'expo-origin': 'https://app.example.com'
		})
		const headers = normalizeExpoOrigin(raw)
		expect(headers.get('origin')).toBe('https://platform.example.com')
	})
})

const echo = fn({
	name: 'echo',
	procedure: 'public',
	method: 'GET',
	path: '/echo',
	tags: ['external'],
	input: z.object({ text: z.string() }),
	handler: ({ input, context }) => ({
		text: input.text,
		origin: context.headers?.get('origin') ?? null
	})
})
const me = fn({
	name: 'me',
	method: 'GET',
	path: '/me',
	handler: ({ context }) => ({ id: context.user.id })
})
const crash = fn({
	name: 'crash',
	procedure: 'public',
	method: 'GET',
	path: '/crash',
	handler: () => {
		throw new Error('db down')
	}
})
const missing = fn({
	name: 'missing',
	procedure: 'public',
	method: 'GET',
	path: '/missing',
	handler: () => {
		throw new ORPCError('NOT_FOUND')
	}
})
const ticks = fn({
	name: 'ticks',
	procedure: 'public',
	method: 'GET',
	path: '/ticks',
	stream: true,
	handler: async function* () {
		yield 1
	}
})
let releaseSlow = () => {}
let slowGate = Promise.resolve()
const fast = fn({
	name: 'fast',
	procedure: 'public',
	handler: () => ({ items: Array(100).fill('unit') })
})
const slow = fn({
	name: 'slow',
	procedure: 'public',
	handler: async () => {
		await slowGate
		return { done: true }
	}
})
const router = createRouter({ echo, me, crash, missing, ticks, fast, slow })

type Spec = { info: { title: string }; paths: Record<string, unknown> }

function createApp(
	overrides: Partial<Parameters<typeof mountOrpc>[1]> = {},
	rpcPrefix: '/rpc' | null = '/rpc'
) {
	const app = new Hono()
	mountOrpc(app, {
		router,
		...(rpcPrefix ? { rpcPrefix } : {}),
		openapi: {
			prefix: '/api',
			info: { title: 'Test API', version: '1.0.0' }
		},
		normalizeHeaders: normalizeExpoOrigin,
		...overrides
	})
	return app
}

describe('mountOrpc', () => {
	test('serves OpenAPI routes with Server-Timing including handler time', async () => {
		const response = await createApp().request('/api/echo?text=hi', {
			headers: { 'expo-origin': 'https://app.example.com' }
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			text: 'hi',
			origin: 'https://app.example.com'
		})
		const timing = response.headers.get('Server-Timing') ?? ''
		expect(timing).toMatch(/^total;dur=[\d.]+, handler;dur=[\d.]+$/)
		expect(response.headers.get('Access-Control-Expose-Headers')).toContain(
			'Server-Timing'
		)
	})

	test('a request marked on arrival reports its queue time', async () => {
		const request = new Request('http://localhost/api/echo?text=hi')
		markRequestArrival(request)
		const response = await createApp().fetch(request)
		expect(response.headers.get('Server-Timing')).toMatch(/, queue;dur=[\d.]+/)
	})

	test('serves RPC calls', async () => {
		const response = await createApp().request('/rpc/echo', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ json: { text: 'rpc' } })
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ json: { text: 'rpc' } })
	})

	test('serves the spec and docs', async () => {
		const app = createApp()
		const spec = (await (await app.request('/api/spec.json')).json()) as Spec
		expect(spec.info.title).toBe('Test API')
		expect(Object.keys(spec.paths)).toContain('/echo')
		expect((await app.request('/api')).headers.get('content-type')).toContain(
			'text/html'
		)
	})

	test('context builder can authenticate or answer itself', async () => {
		const app = createApp({
			context: (c, base) =>
				c.req.header('authorization') === 'Bearer ok'
					? { ...base, user: user() }
					: base.headers.has('x-deny')
						? new Response('nope', { status: 401 })
						: base
		})
		const ok = await app.request('/api/me', {
			headers: { authorization: 'Bearer ok' }
		})
		expect(await ok.json()).toEqual({ id: 'user-1' })
		expect((await app.request('/api/me')).status).toBe(401)
		const denied = await app.request('/api/me', { headers: { 'x-deny': '1' } })
		expect(await denied.text()).toBe('nope')
	})

	test('reports unexpected errors only', async () => {
		const onError = mock(() => {})
		const app = createApp({ onError })
		expect((await app.request('/api/crash')).status).toBe(500)
		expect((await app.request('/api/missing')).status).toBe(404)
		expect(onError).toHaveBeenCalledTimes(1)
		expect(onError.mock.calls[0]).toMatchObject([
			expect.any(Error),
			{ url: '/api/crash', method: 'GET' }
		])
	})

	test('SSE responses disable proxy buffering', async () => {
		const response = await createApp().request('/api/ticks')
		expect(response.headers.get('content-type')).toContain('text/event-stream')
		expect(response.headers.get('X-Accel-Buffering')).toBe('no')
		expect(response.headers.get('Cache-Control')).toBe('no-cache')
		await response.body?.cancel()
	})

	test('openapi.filter limits routes and spec', async () => {
		const app = createApp(
			{ openapi: { prefix: '/ext', filter: hasTag('external') } },
			null
		)
		expect((await app.request('/ext/echo?text=x')).status).toBe(200)
		expect((await app.request('/ext/crash')).status).toBe(404)
		const spec = (await (await app.request('/ext/spec.json')).json()) as Spec
		expect(Object.keys(spec.paths)).toEqual(['/echo'])
	})

	test('unmatched paths fall through to the app', async () => {
		const app = createApp()
		app.get('/api/custom', (c) => c.text('custom'))
		expect(await (await app.request('/api/custom')).text()).toBe('custom')
	})
})

describe('mountOrpc compression', () => {
	beforeEach(() => {
		slowGate = new Promise((resolve) => {
			releaseSlow = resolve
		})
	})
	const gzip = { 'accept-encoding': 'gzip, br' }
	const batchRequest = (headers: Record<string, string> = gzip) =>
		new Request('http://localhost/rpc/__batch__', {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/json',
				'x-orpc-batch': 'streaming'
			},
			body: JSON.stringify([
				{ url: 'http://localhost/rpc/fast', body: { json: null } },
				{ url: 'http://localhost/rpc/slow', body: { json: null } }
			])
		})

	test('a batch stream is gzipped and delivers a result before a slower one', async () => {
		const response = await createApp().fetch(batchRequest())
		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(response.headers.get('vary')).toContain('accept-encoding')

		const reader = response
			.body!.pipeThrough(new DecompressionStream('gzip'))
			.pipeThrough(new TextDecoderStream())
			.getReader()
		// The slow result is still pending, yet the fast one can be read already.
		let received = ''
		while (!received.includes('"unit"')) received += (await reader.read()).value
		expect(received).not.toContain('"done"')

		releaseSlow()
		while (!received.includes('"done"')) {
			const { value, done } = await reader.read()
			if (done) break
			received += value
		}
		expect(received).toContain('"done":true')
	})

	test('JSON is gzipped', async () => {
		const response = await createApp().request('/rpc/fast', {
			method: 'POST',
			headers: { ...gzip, 'content-type': 'application/json' },
			body: JSON.stringify({ json: null })
		})
		expect(response.headers.get('content-encoding')).toBe('gzip')
		const text = new TextDecoder().decode(
			Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()))
		)
		expect(JSON.parse(text)).toMatchObject({
			json: { items: expect.any(Array) }
		})
	})

	test('a live event stream is not compressed', async () => {
		const response = await createApp().request('/rpc/ticks', {
			method: 'POST',
			headers: { ...gzip, 'content-type': 'application/json' },
			body: JSON.stringify({ json: null })
		})
		expect(response.headers.get('content-type')).toContain('text/event-stream')
		expect(response.headers.get('content-encoding')).toBeNull()
		await response.body?.cancel()
	})

	test('clients without gzip get the plain batch', async () => {
		const response = await createApp().fetch(batchRequest({}))
		expect(response.headers.get('content-encoding')).toBeNull()
		releaseSlow()
		const text = await response.text()
		expect(text).toContain('"unit"')
		expect(text).toContain('"done":true')
	})

	test('compress: false turns it off', async () => {
		const response = await createApp({ compress: false }).fetch(batchRequest())
		expect(response.headers.get('content-encoding')).toBeNull()
		releaseSlow()
		expect(await response.text()).toContain('"done":true')
	})
})

test('formatServerTiming', () => {
	expect(
		formatServerTiming(10, { queue_ms: 1, auth_ms: 2.5, handler_ms: undefined })
	).toBe('total;dur=10.00, queue;dur=1.00, auth;dur=2.50')
})
