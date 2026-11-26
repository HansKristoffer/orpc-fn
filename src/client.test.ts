import { describe, expect, test } from 'bun:test'
import { createORPCClient, ORPCError } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { Hono } from 'hono'
import { z } from 'zod'
import { createRouter, fn, fnLive, transport } from '../tests/fixture.js'
import {
	createRpcLink,
	hasOrpcErrorCode,
	isSubscriptionPath,
	formatClientError,
	queryCacheSerializer,
	responseStatusOf,
	streamCall,
	userFacingErrorMessage
} from './client.js'
import {
	createExpoFetch,
	createBetterAuthExpoLink,
	type ExpoFetchInit
} from './expo.js'
import {
	CLIENT_REQUEST_HEADERS,
	mountOrpc,
	normalizeExpoOrigin
} from './hono.js'

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
		stateSchema: z.object({ count: z.number() }),
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
const serve = (input: Request | string, init?: RequestInit) =>
	Promise.resolve(
		app.fetch(input instanceof Request ? input : new Request(input, init))
	)
const origin = 'http://localhost'
const url = '/rpc'

describe('createRpcLink', () => {
	const client: RouterClient<typeof router> = createORPCClient(
		createRpcLink({ origin, url, fetch: serve })
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
		await Bun.sleep(20)
		await counter.publish({ id: 'batched' })
		expect((await next).value).toEqual({ count: 1 })
		abort.abort()
	})

	test('batch: false sends one request per call', async () => {
		hits.length = 0
		const plain: RouterClient<typeof router> = createORPCClient(
			createRpcLink({ origin, url, fetch: serve, batch: false })
		)
		await Promise.all([plain.echo({ text: 'a' }), plain.echo({ text: 'b' })])
		expect(hits).toHaveLength(2)
	})

	test('calls with a client context are not batched and keep it', async () => {
		hits.length = 0
		const seen: unknown[] = []
		const typed: RouterClient<typeof router, { token: string }> =
			createORPCClient(
				createRpcLink<{ token: string }>({
					origin,
					url,
					fetch: (input, init, options) => {
						seen.push(options.context.token)
						return serve(input, init)
					}
				})
			)
		await Promise.all([
			typed.echo({ text: 'a' }, { context: { token: 't1' } }),
			typed.echo({ text: 'b' }, { context: { token: 't2' } })
		])
		expect(seen.sort()).toEqual(['t1', 't2'])
		expect(hits).toHaveLength(2)
	})

	test('hasOrpcErrorCode checks route errors', async () => {
		const error = await client.missing().catch((caught: unknown) => caught)
		expect(hasOrpcErrorCode(error, 'NOT_FOUND')).toBe(true)
		expect(hasOrpcErrorCode(error, 'FORBIDDEN')).toBe(false)
		expect(hasOrpcErrorCode(new Error('x'), 'NOT_FOUND')).toBe(false)
	})

	test('responseStatusOf reads the status of an oRPC error and of a foreign response', async () => {
		const error = await client.missing().catch((caught: unknown) => caught)
		expect(responseStatusOf(error)).toBe(404)
		// A proxy's error page is not oRPC's format: MalformedResponseError.
		const behindProxy: RouterClient<typeof router> = createORPCClient(
			createRpcLink({
				origin,
				url,
				batch: false,
				fetch: async () =>
					new Response('<h1>Bad Gateway</h1>', {
						status: 502,
						headers: { 'content-type': 'text/html' }
					})
			})
		)
		const proxied = await behindProxy
			.echo({ text: 'a' })
			.catch((caught: unknown) => caught)
		expect(responseStatusOf(proxied)).toBe(502)
		// No response arrived at all.
		const offline: RouterClient<typeof router> = createORPCClient(
			createRpcLink({
				origin,
				url,
				batch: false,
				fetch: () => Promise.reject(new TypeError('fetch failed'))
			})
		)
		const unreachable = await offline
			.echo({ text: 'a' })
			.catch((caught: unknown) => caught)
		expect(unreachable).toBeInstanceOf(Error)
		expect(responseStatusOf(unreachable)).toBeUndefined()
		expect(responseStatusOf(new ORPCError('NOT_FOUND'))).toBeUndefined()
	})

	test('a full URL as url names the oRPC 2 origin/url split', () => {
		expect(() => createRpcLink({ url: 'https://api.test/rpc?v=2' })).toThrow(
			"pass origin: 'https://api.test' and url: '/rpc?v=2'"
		)
		expect(() => createRpcLink({ url: 'http://[' })).toThrow(
			'RPCLink url is a path since oRPC 2'
		)
	})

	test('url takes a plain string path, and rejects one without a leading slash', async () => {
		// A `string` constant, as apps keep their paths, with no `as const`.
		const path: string = ['', 'rpc'].join('/')
		const plain: RouterClient<typeof router> = createORPCClient(
			createRpcLink({ origin, url: path, fetch: serve, batch: false })
		)
		expect((await plain.echo({ text: 'a' })).text).toBe('a')
		expect(() => createRpcLink({ origin, url: 'rpc' })).toThrow(
			"RPCLink url must be a path starting with '/', got 'rpc'"
		)
	})

	test('TanStack Query calls batch, while liveOptions stays out of batches', async () => {
		const orpc = createTanstackQueryUtils(client)
		const q1 = orpc.echo.queryOptions({ input: { text: 'a' } })
		const q2 = orpc.echo.queryOptions({ input: { text: 'b' } })
		const signal = new AbortController().signal
		hits.length = 0
		const results = await Promise.all([
			q1.queryFn({ queryKey: q1.queryKey, signal, meta: undefined } as never),
			q2.queryFn({ queryKey: q2.queryKey, signal, meta: undefined } as never)
		])
		expect(results.map((r) => r.text)).toEqual(['a', 'b'])
		expect(hits).toHaveLength(1)

		// TanStack `liveOptions` attaches the same symbol with `type: 'live'`,
		// keeping streams out of batches even without a stream manifest or name hint.
		const watch = fn({
			name: 'client.watch',
			procedure: 'public',
			stream: true,
			handler: async function* () {
				yield 1
			}
		})
		const mixed = createRouter({ echo, watch })
		const mixedApp = new Hono()
		const mixedHits: string[] = []
		mixedApp.use('*', async (c, next) => {
			mixedHits.push(new URL(c.req.url).pathname)
			await next()
		})
		mountOrpc(mixedApp, { router: mixed, rpcPrefix: '/rpc' })
		const mixedClient: RouterClient<typeof mixed> = createORPCClient(
			createRpcLink({
				origin,
				url,
				fetch: (input, init) =>
					Promise.resolve(mixedApp.fetch(new Request(input, init)))
			})
		)
		const mixedUtils = createTanstackQueryUtils(mixedClient)
		const live = mixedUtils.watch.liveOptions()
		const query = mixedUtils.echo.queryOptions({ input: { text: 'c' } })
		const abort = new AbortController()
		const [value, echoed] = await Promise.all([
			live.queryFn({
				queryKey: live.queryKey,
				signal: abort.signal,
				meta: undefined,
				client: { setQueryData: () => {} }
			} as never),
			query.queryFn({
				queryKey: query.queryKey,
				signal: abort.signal,
				meta: undefined
			} as never)
		])
		abort.abort()
		expect(value).toBe(1)
		expect(echoed.text).toBe('c')
		expect(mixedHits.sort()).toEqual(['/rpc/echo', '/rpc/watch'])
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
			createBetterAuthExpoLink({
				origin,
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

	test('CLIENT_REQUEST_HEADERS lists every header the links add', async () => {
		inits.length = 0
		const client: RouterClient<typeof router> = createORPCClient(
			createBetterAuthExpoLink({
				origin,
				url,
				fetch: expoFetch,
				native: true,
				getCookie: () => 'session=abc',
				getExpoOrigin: () => 'myapp://'
			})
		)
		// Two parallel calls go out as one batch, which adds `orpc-batch`.
		await Promise.all([client.echo({ text: 'a' }), client.echo({ text: 'b' })])
		const sent = new Set(inits.flatMap((init) => Object.keys(init.headers)))
		expect(sent.has('orpc-batch')).toBe(true)
		// A browser cannot set `cookie`, and `accept` is CORS-safelisted.
		for (const name of ['cookie', 'accept']) sent.delete(name)
		expect([...sent].sort()).toEqual([...CLIENT_REQUEST_HEADERS].sort())
	})

	test('native: aborting a subscription closes the server stream', async () => {
		const client: RouterClient<typeof router> = createORPCClient(
			createBetterAuthExpoLink({ origin, url, fetch: expoFetch, native: true })
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
			await Bun.sleep(10)
		}
		expect(transport.listenerCount('client-counter:expo')).toBe(0)
	})

	test('web: uses the platform fetch with cookies, no native headers', async () => {
		inits.length = 0
		const original = globalThis.fetch
		const seen: Array<RequestInit | undefined> = []
		globalThis.fetch = ((input: string, init?: RequestInit) => {
			seen.push(init)
			return serve(input, init)
		}) as typeof fetch
		try {
			const bridged = createExpoFetch({ fetch: expoFetch, native: false })
			await bridged(`${origin}${url}/missing`, { method: 'POST' })
			expect(inits).toHaveLength(0)
			expect(seen[0]?.credentials).toBe('include')
		} finally {
			globalThis.fetch = original
		}
	})

	test('web: createBetterAuthExpoLink does not call getCookie or set Cookie header', async () => {
		let cookieCalls = 0
		let seenHeaders: Headers | undefined
		const link = createBetterAuthExpoLink({
			origin,
			url,
			native: false,
			fetch: expoFetch,
			webFetch: async (input, init) => {
				const request = new Request(input, init)
				seenHeaders = request.headers
				return serve(request)
			},
			getCookie: () => {
				cookieCalls++
				return 'session=should-not-send'
			}
		})
		const webClient: RouterClient<typeof router> = createORPCClient(link)
		await webClient.echo({ text: 'web' })
		expect(cookieCalls).toBe(0)
		expect(seenHeaders?.has('cookie')).toBe(false)
	})
})

test('manifest excludes aliased streaming routes with ordinary names from batches', async () => {
	const { createStreamManifest } = await import('./router.js')
	const mixed = { watch: counter.subscribe, health: echo }
	const mixedApp = new Hono()
	let requests = 0
	mixedApp.use('*', async (_c, next) => {
		requests++
		await next()
	})
	mountOrpc(mixedApp, { router: mixed, rpcPrefix: '/rpc' })
	const mixedClient: RouterClient<typeof mixed> = createORPCClient(
		createRpcLink({
			origin,
			url,
			fetch: (input, init) =>
				Promise.resolve(mixedApp.fetch(new Request(input, init))),
			streamPaths: createStreamManifest(mixed)
		})
	)
	const abort = new AbortController()
	const [stream, result] = await Promise.all([
		mixedClient.watch({ id: 'watch' }, { signal: abort.signal }),
		mixedClient.health({ text: 'healthy' })
	])
	expect(result.text).toBe('healthy')
	expect((await stream.next()).value).toEqual({ count: 0 })
	expect(requests).toBe(2)
	abort.abort()
})

test('a stream call marked with streamCall stays out of batches without a manifest', async () => {
	const mixed = { watch: counter.subscribe, health: echo }
	const mixedApp = new Hono()
	let requests = 0
	mixedApp.use('*', async (_c, next) => {
		requests++
		await next()
	})
	mountOrpc(mixedApp, { router: mixed, rpcPrefix: '/rpc' })
	const mixedClient: RouterClient<typeof mixed> = createORPCClient(
		createRpcLink({
			origin,
			url,
			fetch: (input, init) =>
				Promise.resolve(mixedApp.fetch(new Request(input, init)))
		})
	)
	const abort = new AbortController()
	const [stream, result] = await Promise.all([
		mixedClient.watch(
			{ id: 'marked' },
			{ signal: abort.signal, context: streamCall }
		),
		mixedClient.health({ text: 'healthy' })
	])
	expect(result.text).toBe('healthy')
	expect((await stream.next()).value).toEqual({ count: 0 })
	expect(requests).toBe(2)
	abort.abort()
})

test('symbol-keyed client context keeps calls out of batches', async () => {
	const customMark = Symbol('no-batch')
	const mixedApp = new Hono()
	let requests = 0
	mixedApp.use('*', async (_c, next) => {
		requests++
		await next()
	})
	mountOrpc(mixedApp, { router: { echo }, rpcPrefix: '/rpc' })
	const client: RouterClient<{ echo: typeof echo }, { [customMark]?: true }> =
		createORPCClient(
			createRpcLink({
				origin,
				url,
				fetch: (input, init) =>
					Promise.resolve(mixedApp.fetch(new Request(input, init)))
			})
		)
	const [a, b] = await Promise.all([
		client.echo({ text: 'marked' }, { context: { [customMark]: true } }),
		client.echo({ text: 'plain' })
	])
	expect(a.text).toBe('marked')
	expect(b.text).toBe('plain')
	expect(requests).toBe(2)
})

test('generic Expo headers support async context and browser fetch injection', async () => {
	const { createExpoLink } = await import('./expo.js')
	let seen: Headers | undefined
	const generic: RouterClient<typeof router, { token: string }> =
		createORPCClient(
			createExpoLink<{ token: string }>({
				origin,
				url,
				native: false,
				fetch: async () => {
					throw new Error('native fetch used on web')
				},
				webFetch: async (input, init) => {
					const request = new Request(input, init)
					seen = request.headers
					return serve(request)
				},
				headers: async ({ context }) => ({
					Authorization: `Bearer ${context.token}`
				})
			})
		)
	await generic.echo({ text: 'hi' }, { context: { token: 'secret' } })
	expect(seen?.get('authorization')).toBe('Bearer secret')
	expect(seen?.has('x-skip-oauth-proxy')).toBe(false)
})

describe('userFacingErrorMessage', () => {
	test('uses the server message only when data.userMessage opts in', () => {
		const fallback = 'Something went wrong'
		expect(userFacingErrorMessage(new Error('boom'), fallback)).toBe(fallback)
		expect(
			userFacingErrorMessage(
				new ORPCError('NOT_FOUND', { message: 'Work item not found' }),
				fallback
			)
		).toBe(fallback)
		expect(
			userFacingErrorMessage(
				new ORPCError('BAD_REQUEST', { data: { userMessage: '  ' } }),
				fallback
			)
		).toBe(fallback)
		expect(
			userFacingErrorMessage(
				new ORPCError('BAD_REQUEST', {
					data: { userMessage: 'Choose a stage first.' }
				}),
				fallback
			)
		).toBe('Choose a stage first.')
	})
})

test('formatClientError prefers userMessage, then lists rejected fields', () => {
	const invalid = new ORPCError('BAD_REQUEST', {
		data: {
			issues: [
				{ message: 'Required', path: ['lines', 0, 'sku'] },
				{ message: 'Too long', path: [{ key: 'title' }] }
			]
		}
	})
	expect(formatClientError(invalid, 'Could not save')).toBe(
		'lines.0.sku: Required\ntitle: Too long'
	)
	const safe = new ORPCError('BAD_REQUEST', {
		data: { userMessage: 'Pick a stage first.' }
	})
	expect(formatClientError(safe, 'Could not save')).toBe('Pick a stage first.')
	expect(formatClientError(new Error('boom'), 'Could not save')).toBe(
		'Could not save'
	)
})

describe('queryCacheSerializer', () => {
	test('round-trips dates that plain JSON would turn into strings', () => {
		const cache = {
			clientState: {
				queries: [
					{ state: { data: { at: new Date(0), tags: new Set(['a']) } } }
				]
			}
		}
		const restored = queryCacheSerializer.deserialize<typeof cache>(
			queryCacheSerializer.serialize(cache)
		)
		expect(restored).toEqual(cache)
		expect(restored.clientState.queries[0]?.state.data.at).toBeInstanceOf(Date)
	})
})
