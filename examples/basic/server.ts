// Run: bun examples/basic/server.ts
// In your app, import from 'orpc-fn', 'orpc-fn/hono' and 'orpc-fn/live/memory'.
import { ORPCError, os } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { mountOrpc } from '../../src/hono.js'
import { createFn } from '../../src/index.js'
import { memoryTransport } from '../../src/live/memory.js'

// ── App context and procedures ──────────────────────────────────────────────
type Context = { headers: Headers; userId?: string }
const base = os.$context<Context>()
const authed = base.use(({ context, next }) => {
	if (!context.userId) throw new ORPCError('UNAUTHORIZED')
	return next({ context: { userId: context.userId } })
})

const todos = new Map<string, { id: string; title: string; done: boolean }>()

export const { fn, fnLive, createRouter } = createFn({
	procedures: { public: base, protected: authed },
	default: 'protected',
	extras: () => ({ todos }),
	pubsub: { transport: memoryTransport() }
})

// ── Routes ──────────────────────────────────────────────────────────────────
const health = fn({
	name: 'health',
	procedure: 'public',
	method: 'GET',
	path: '/health',
	handler: () => ({ ok: true })
})

const todoEvent = z.object({ listId: z.string(), id: z.string() })

const list = fnLive({
	name: 'todos.list',
	method: 'GET',
	path: '/todos/{listId}',
	input: z.object({ listId: z.string() }),
	handler: ({ todos }) => ({ items: [...todos.values()] }),
	live: {
		eventSchema: todoEvent,
		channel: ({ listId }) => `todos:${listId}`
	}
})

const add = fn({
	name: 'todos.add',
	method: 'POST',
	path: '/todos/{listId}',
	input: z.object({ listId: z.string(), title: z.string().min(1) }),
	handler: async ({ input, todos, call, logger }) => {
		const id = crypto.randomUUID()
		todos.set(id, { id, title: input.title, done: false })
		logger.info('todo added', { id })
		await list.publish({ listId: input.listId, id })
		// Nested calls keep the caller's context and signal.
		return call(list.procedure, { listId: input.listId })
	}
})

export const router = createRouter({
	health,
	todos: createRouter({
		list: list.procedure,
		subscribe: list.subscribe,
		add
	})
})

// ── Hono ────────────────────────────────────────────────────────────────────
const app = new Hono()
mountOrpc(app, {
	router,
	rpcPrefix: '/rpc',
	openapi: { prefix: '/api', info: { title: 'Todo API', version: '1.0.0' } },
	// Demo auth: `x-user-id` header. Real apps resolve a session here.
	context: (c, base) => ({ ...base, userId: c.req.header('x-user-id') })
})

export default { port: 3000, fetch: app.fetch }
if (import.meta.main) console.log('Docs at http://localhost:3000/api')
