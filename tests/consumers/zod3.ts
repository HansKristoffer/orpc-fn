// Compiles against zod 3.25: core routes take v3 schemas (Standard Schema),
// live routes take `zod/v4` schemas, and both mount on the HTTP adapters.
import { call, os } from '@orpc/server'
import { createFn } from 'orpc-fn'
import { createFetchHandler } from 'orpc-fn/fetch'
import { memoryTransport } from 'orpc-fn/live/memory'
import { createNodeHandler } from 'orpc-fn/node'
import { z } from 'zod'
import { z as z4 } from 'zod/v4'

const { fn, fnLive } = createFn({
	procedures: {
		public: os.$context<{ headers: Headers; resHeaders?: Headers }>()
	},
	default: 'public',
	pubsub: { transport: memoryTransport() }
})

const getOrder = fn({
	name: 'order.get',
	input: z.object({ id: z.string(), at: z.coerce.date() }),
	output: z.object({ id: z.string(), year: z.number() }),
	handler: ({ input, context }) => {
		const id: string = input.id
		const at: Date = input.at
		context.resHeaders?.set('cache-control', 'private, max-age=30')
		// @ts-expect-error the input is typed from the v3 schema
		const wrong: number = input.id
		void wrong
		return { id, year: at.getFullYear() }
	}
})

const watchOrder = fnLive({
	name: 'order.watch',
	input: z4.object({ id: z4.string() }),
	handler: ({ input }) => ({ id: input.id, status: 'open' as const }),
	live: {
		eventSchema: z4.object({ id: z4.string() }),
		channel: ({ id }) => `order:${id}`
	}
})

const router = {
	getOrder,
	watchOrder: watchOrder.procedure,
	subscribeOrder: watchOrder.subscribe
}
createNodeHandler({ router, rpcPrefix: '/api/rpc' })
createFetchHandler({ router, rpcPrefix: '/api/rpc' })

void call(
	getOrder,
	{ id: 'o1', at: new Date() },
	{ context: { headers: new Headers() } }
).then((order) => {
	const year: number = order.year
	void year
})
