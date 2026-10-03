import { os } from '@orpc/server'
import { z } from 'zod'
import { createFn } from 'orpc-fn'
import { memoryTransport } from 'orpc-fn/live/memory'

export async function runTenantExample() {
	const transport = memoryTransport()
	const snapshots = new Map<string, number>()
	const factory = createFn({
		procedures: { authenticated: os.$context<{ tenant: string }>() },
		default: 'authenticated',
		pubsub: { transport, namespace: 'example:dev', ownsTransport: true }
	})
	const live = factory.fnLive({
		name: 'room.total',
		input: z.object({ room: z.string() }),
		handler: ({ input, context }) =>
			snapshots.get(`${context.tenant}:${input.room}`) ?? 0,
		live: {
			eventSchema: z.object({ tenantId: z.string(), roomId: z.string() }),
			channel: {
				subscribe: ({ input, context }) => `${context.tenant}:${input.room}`,
				publish: (event) => `${event.tenantId}:${event.roomId}`
			},
			coalesceMs: 10
		}
	})
	const abort = new AbortController()
	const call = factory.createCall({ tenant: 'tenant-a' }, abort.signal)
	const stream = await call(live.subscribe, { room: 'one' })
	const initial = (await stream.next()).value
	const next = stream.next()
	snapshots.set('tenant-a:one', 7)
	await live.publish({ tenantId: 'tenant-a', roomId: 'one' })
	const updated = (await next).value
	abort.abort()
	await factory.shutdown()
	return { initial, updated }
}
if (process.argv[1]?.endsWith('/tenant-live.ts'))
	console.log(await runTenantExample())
