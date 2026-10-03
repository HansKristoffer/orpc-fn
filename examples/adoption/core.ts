import { os } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createFn, defineMeta } from 'orpc-fn'
import { mountOrpc } from 'orpc-fn/hono'

// No live transport is needed for ordinary procedures or script calls.
export const factory = createFn({
	procedures: { public: os.$context<{ headers?: Headers }>() },
	default: 'public',
	meta: defineMeta<{ readOnly?: boolean }>(),
	extras: () => ({
		repository: { find: (id: string) => ({ id, title: 'Example' }) }
	})
})
export const router = {
	get: factory.fn({
		name: 'item.get',
		input: z.object({ id: z.string() }),
		meta: { readOnly: true },
		handler: ({ input, repository }) => repository.find(input.id)
	}),
	auth: factory.fn({
		name: 'auth.echo',
		handler: ({ context }) => ({
			authorization: context.headers?.get('authorization'),
			cookie: context.headers?.get('cookie')
		})
	})
}
export const app = new Hono()
mountOrpc(app, { router, rpcPrefix: '/rpc' })

// Jobs/scripts use the same validation and execution policies as HTTP callers.
export async function runCoreExample() {
	return factory.createCall({})(router.get, { id: '123' })
}
if (process.argv[1]?.endsWith('/core.ts')) console.log(await runCoreExample())
