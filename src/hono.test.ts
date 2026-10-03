import { describe, expect, mock, test } from 'bun:test'
import { ORPCError } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createRouter, fn, user } from '../tests/fixture.js'
import { formatServerTiming, mountOrpc, normalizeExpoOrigin } from './hono.js'
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
const router = createRouter({ echo, me, crash, missing, ticks })

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

test('formatServerTiming', () => {
	expect(
		formatServerTiming(10, { queue_ms: 1, auth_ms: 2.5, handler_ms: undefined })
	).toBe('total;dur=10.00, queue;dur=1.00, auth;dur=2.50')
})
