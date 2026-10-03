import { describe, expect, test } from 'bun:test'
import { createORPCClient, ORPCError } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createRouter, fn, fnLive, transport } from '../tests/fixture.js'
import {
	createRpcLink,
	hasOrpcErrorCode,
	isSubscriptionPath
} from './client.js'
import { createExpoFetch, createExpoLink, type ExpoFetchInit } from './expo.js'
import { mountOrpc, normalizeExpoOrigin } from './hono.js'

const echo = fn({
	name: 'echo',
	procedure: 'public',
	input: z.object({ text: z.string() }),
	handler: ({ input, context }) => ({
		text: input.text,
		cookie: context.headers?.get('cookie') ?? null,
		origin: context.headers?.get('origin') ?? null
	})
})
const missing = fn({
	name: 'missing',
	procedure: 'public',
	handler: () => {
		throw new ORPCError('NOT_FOUND')
	}
})
const counter = fnLive({
	name: 'counter',
	procedure: 'public',
	input: z.object({ id: z.string() }),
	handler: () => ({ count: 0 }),
	live: {
		eventSchema: z.object({ id: z.string() }),
		channel: ({ id }) => `client-counter:${id}`,
		transformerFn: ({ previous }) => ({ count: (previous?.count ?? 0) + 1 })
	}
})
const router = createRouter({
	echo,
	missing,
	counter: createRouter({
		get: counter.procedure,
		subscribe: counter.subscribe
	})
})

const app = new Hono()
const hits: string[] = []
app.use('*', async (c, next) => {
	hits.push(new URL(c.req.url).pathname)
	await next()
})
mountOrpc(app, {
	router,
	rpcPrefix: '/rpc',
	normalizeHeaders: normalizeExpoOrigin
})
const serve = (request: Request) => Promise.resolve(app.fetch(request))
const url = 'http://localhost/rpc'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createRpcLink', () => {
	const client: RouterClient<typeof router> = createORPCClient(
		createRpcLink({ url, fetch: serve })
	)

	test('parallel calls share one request', async () => {
		hits.length = 0
		const results = await Promise.all([
			client.echo({ text: 'a' }),
			client.echo({ text: 'b' }),
			client.counter.get({ id: 'x' })
		])
		expect(
			results.map((result) => ('text' in result ? result.text : result.count))
		).toEqual(['a', 'b', 0])
		expect(hits).toHaveLength(1)
	})

	test('subscriptions are not batched and stream', async () => {
		const abort = new AbortController()
		const stream = await client.counter.subscribe(
			{ id: 'batched' },
			{ signal: abort.signal }
		)
		expect((await stream.next()).value).toEqual({ count: 0 })
		const next = stream.next()
		await sleep(20)
		await counter.publish({ id: 'batched' })
		expect((await next).value).toEqual({ count: 1 })
		abort.abort()
	})

	test('batch: false sends one request per call', async () => {
		hits.length = 0
		const plain: RouterClient<typeof router> = createORPCClient(
			createRpcLink({ url, fetch: serve, batch: false })
		)
		await Promise.all([plain.echo({ text: 'a' }), plain.echo({ text: 'b' })])
		expect(hits).toHaveLength(2)
	})

	test('hasOrpcErrorCode checks route errors', async () => {
		const error = await client.missing().catch((caught: unknown) => caught)
		expect(hasOrpcErrorCode(error, 'NOT_FOUND')).toBe(true)
		expect(hasOrpcErrorCode(error, 'FORBIDDEN')).toBe(false)
		expect(hasOrpcErrorCode(new Error('x'), 'NOT_FOUND')).toBe(false)
	})

	test('isSubscriptionPath', () => {
		expect(isSubscriptionPath(['counter', 'subscribe'])).toBe(true)
		expect(isSubscriptionPath(['support', 'subscribeTimeline'])).toBe(true)
		expect(isSubscriptionPath(['counter', 'get'])).toBe(false)
	})
})

describe('Expo', () => {
	const inits: ExpoFetchInit[] = []
	// Stands in for `expo/fetch`: records what the bridge sends, then serves it.
	const expoFetch = (target: string, init: ExpoFetchInit) => {
		inits.push(init)
		return serve(new Request(target, init))
	}

	test('native: forwards body, signal and Better Auth headers', async () => {
		inits.length = 0
		const client: RouterClient<typeof router> = createORPCClient(
			createExpoLink({
				url,
				fetch: expoFetch,
				native: true,
				batch: false,
				getCookie: () => 'session=abc',
				getExpoOrigin: () => 'myapp://',
				headers: () => ({ 'x-orpc-source': 'expo-react' })
			})
		)
		expect(await client.echo({ text: 'hi' })).toEqual({
			text: 'hi',
			cookie: 'session=abc',
			origin: 'myapp://'
		})
		const [init] = inits
		expect(init?.credentials).toBe('omit')
		expect(init?.body).toBeInstanceOf(ArrayBuffer)
		expect(init?.signal).toBeInstanceOf(AbortSignal)
		expect(init?.headers).toMatchObject({
			cookie: 'session=abc',
			'expo-origin': 'myapp://',
			'x-skip-oauth-proxy': 'true',
			'x-orpc-source': 'expo-react'
		})
	})

	test('native: aborting a subscription closes the server stream', async () => {
		const client: RouterClient<typeof router> = createORPCClient(
			createExpoLink({ url, fetch: expoFetch, native: true })
		)
		const abort = new AbortController()
		const stream = await client.counter.subscribe(
			{ id: 'expo' },
			{ signal: abort.signal }
		)
		expect((await stream.next()).value).toEqual({ count: 0 })
		expect(transport.listenerCount('client-counter:expo')).toBe(1)
		abort.abort()
		await stream.return(undefined).catch(() => {})
		for (let attempt = 0; attempt < 50; attempt++) {
			if (transport.listenerCount('client-counter:expo') === 0) break
			await sleep(10)
		}
		expect(transport.listenerCount('client-counter:expo')).toBe(0)
	})

	test('web: uses the platform fetch with cookies, no native headers', async () => {
		inits.length = 0
		const original = globalThis.fetch
		const seen: Array<RequestInit | undefined> = []
		globalThis.fetch = ((request: Request, init?: RequestInit) => {
			seen.push(init)
			return serve(request)
		}) as typeof fetch
		try {
			const bridged = createExpoFetch({ fetch: expoFetch, native: false })
			await bridged(new Request(`${url}/missing`, { method: 'POST' }))
			expect(inits).toHaveLength(0)
			expect(seen[0]?.credentials).toBe('include')
		} finally {
			globalThis.fetch = original
		}
	})
})
