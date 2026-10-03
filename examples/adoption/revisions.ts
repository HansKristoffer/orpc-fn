import { os } from '@orpc/server'
import { z } from 'zod'
import { createFn } from 'orpc-fn'
import { memoryTransport } from 'orpc-fn/live/memory'

export async function runRevisionExample() {
	const stateSchema = z.object({
		total: z.number().int().min(0),
		revision: z.number().int().min(0)
	})
	const factory = createFn({
		procedures: { public: os },
		default: 'public',
		pubsub: { transport: memoryTransport(), ownsTransport: true }
	})
	let current = { total: 1, revision: 1 }
	const live = factory.fnLive({
		name: 'revision.total',
		input: z.object({}),
		output: stateSchema,
		handler: () => current,
		live: {
			channel: 'revision.total',
			eventSchema: z.object({ revision: z.number(), delta: z.number() }),
			stateSchema,
			shouldUpdate: ({ event, previous }) => event.revision > previous.revision,
			transformerFn: ({ event, previous, rerun }) =>
				event.revision === previous.revision + 1
					? { total: previous.total + event.delta, revision: event.revision }
					: rerun()
		}
	})
	const abort = new AbortController()
	const stream = await factory.createCall({}, abort.signal)(live.subscribe, {})
	const initial = (await stream.next()).value
	const next = stream.next()
	// The snapshot already contains revision 1; replaying its delta must be skipped.
	await live.publish({ revision: 1, delta: 1 })
	current = { total: 4, revision: 3 }
	await live.publish({ revision: 3, delta: 1 }) // Missing revision 2 forces a reload.
	const recovered = (await next).value
	abort.abort()
	await factory.shutdown()
	return { initial, recovered }
}
if (process.argv[1]?.endsWith('/revisions.ts'))
	console.log(await runRevisionExample())
