// A Next.js Pages Router backend on TypeScript 5.4.5 with Zod 3 schemas:
// several builders, a builder middleware that reads the raw input and the
// route's meta, a route policy and typed meta.
import { AsyncLocalStorage } from 'node:async_hooks'
import { ORPCError, os } from '@orpc/server'
import { createFn, defineMeta, readFnMeta } from 'orpc-fn'
import type { RequestTiming } from 'orpc-fn/node'
import { z } from 'zod'
import type { Equal, Expect, IsAny, Not } from '../types'

export type RequestScope = {
	/** Verified at most once per HTTP request, whatever the batch size. */
	user: () => Promise<{ uid: string } | null>
}
export type BaseContext = {
	headers: Headers
	timing: RequestTiming
	resHeaders?: Headers
	scope: RequestScope
}
type Access = { used: boolean; authorize: () => Promise<void> }
type RouteMeta = { publicReason?: string; authz?: string }

export const requestStorage = new AsyncLocalStorage<{ requestId: number }>()

const base = os.$context<BaseContext>()

const authed = base.use(async ({ context, next, procedure, path }) => {
	const user = await context.scope.user()
	if (!user) throw new ORPCError('UNAUTHORIZED')
	const access: Access = {
		used: false,
		authorize: async () => {
			access.used = true
		}
	}
	const result = await next({ context: { uid: user.uid, access } })
	const { name, meta } = readFnMeta(procedure)
	type _Name = Expect<Equal<typeof name, string | undefined>>
	const authz: unknown = meta.authz
	if (typeof authz === 'string' && !access.used)
		throw new ORPCError('INTERNAL_SERVER_ERROR', {
			message: `${name ?? path.join('.')}: declared authz, checked nothing`
		})
	return result
})

// The partner id is read from the raw input, before the route's schema runs.
const partnerAdmin = authed.use(async ({ context, next }, input) => {
	type _Raw = Expect<Equal<typeof input, unknown>>
	const partnerId = (input as { partnerId?: unknown } | undefined)?.partnerId
	if (typeof partnerId !== 'string' || !partnerId.trim())
		throw new ORPCError('BAD_REQUEST', { message: 'partnerId is required' })
	const uid: string = context.uid
	return next({
		context: { partnerId: partnerId.trim(), admin: { id: uid } }
	})
})

export const { fn, createRouter, createTestCall, readMeta } = createFn({
	procedures: { public: base, authed, partnerAdmin },
	meta: defineMeta<RouteMeta>(),
	routePolicy: ({ name, procedure, meta }) => {
		const key: 'public' | 'authed' | 'partnerAdmin' = procedure
		if (key === 'public' && !meta.publicReason)
			throw new Error(`${name}: a public route needs meta.publicReason`)
	}
})

export type Category = { id: string; partnerId: string; name: string }
type StoredDocument = {
	id: string
	partnerId: string
	fields?: Record<string, unknown>
}

const list = fn({
	name: 'productCategories.list',
	procedure: 'partnerAdmin',
	input: z.object({ partnerId: z.string().trim().min(1) }),
	handler: async ({ input, context }) => {
		type _Input = Expect<Equal<typeof input, { partnerId: string }>>
		const partnerId: string = context.partnerId
		// @ts-expect-error the context is the builder's, which has no `tenant`
		void context.tenant
		const requestId = requestStorage.getStore()?.requestId ?? null
		const categories: Category[] = [{ id: 'c1', partnerId, name: 'Drinks' }]
		return { categories, requestId }
	}
})

const create = fn({
	name: 'productCategories.create',
	procedure: 'partnerAdmin',
	input: z.object({
		partnerId: z.string().trim().min(1),
		name: z.string().trim().min(1).max(50)
	}),
	handler: async ({ input, context }): Promise<Category> => {
		if (input.name === 'taken')
			throw new ORPCError('CONFLICT', { message: 'Name is taken' })
		return { id: 'c2', partnerId: context.partnerId, name: input.name }
	}
})

/** No validation: the value reaches the handler untouched, unknown fields included. */
const legacyInput = <Props>() => z.custom<Props>()

const saveDocument = fn({
	name: 'documents.save',
	procedure: 'authed',
	meta: { authz: 'partnerId of the stored document' },
	input: legacyInput<StoredDocument>(),
	handler: async ({ input, context }) => {
		type _Input = Expect<Equal<typeof input, StoredDocument>>
		await context.access.authorize()
		return { saved: input.id, by: context.uid }
	}
})

const ping = fn({
	name: 'health.ping',
	procedure: 'public',
	meta: { publicReason: 'uptime check' },
	handler: async () => ({ pong: true as const })
})

fn({
	name: 'health.wrongMeta',
	procedure: 'public',
	// @ts-expect-error meta is typed by defineMeta
	meta: { publicReason: 1 },
	handler: async () => null
})

export const appRouter = createRouter({
	productCategories: { list, create },
	documents: { save: saveDocument },
	health: { ping }
})
export type AppRouter = typeof appRouter

const listMeta = readMeta(list)
type _Meta = Expect<Not<IsAny<typeof listMeta.meta>>>
const authz: string | undefined = listMeta.meta.authz
void authz
