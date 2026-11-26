// The browser client: one link with a typed client context that batches only
// TanStack queries, and TanStack Query utils over the router client.
import { createORPCClient } from '@orpc/client'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import {
	createRpcLink,
	hasOrpcErrorCode,
	responseStatusOf
} from 'orpc-fn/client'
import type { AppRouter, Category } from '../server/rpc'
import type { Equal, Expect, IsAny, Not } from '../types'

export type RpcClientContext = { batch?: false }

const link = createRpcLink<RpcClientContext>({
	url: '/api/rpc',
	headers: async () => ({ authorization: 'Bearer token' }),
	batch: {
		maxSize: 20,
		mode: 'buffered',
		only: 'queries',
		groups: [
			{ condition: ({ context }) => context.batch !== false, context: {} }
		]
	}
})

// @ts-expect-error the batch mode is one of oRPC's two
createRpcLink({ url: '/api/rpc', batch: { mode: 'stream' } })
// @ts-expect-error only queries can be singled out
createRpcLink({ url: '/api/rpc', batch: { only: 'mutations' } })

export const rpc: RouterClient<AppRouter, RpcClientContext> =
	createORPCClient(link)
export const orpc = createTanstackQueryUtils(rpc)

type ListOutput = Awaited<ReturnType<typeof rpc.productCategories.list>>
type CreateInput = Parameters<typeof rpc.productCategories.create>[0]
type _Output = [
	Expect<Not<IsAny<ListOutput>>>,
	Expect<
		Equal<ListOutput, { categories: Category[]; requestId: number | null }>
	>
]
type _Input = [
	Expect<Not<IsAny<CreateInput>>>,
	Expect<Equal<CreateInput, { partnerId: string; name: string }>>
]

export async function createCategory(name: string): Promise<Category | null> {
	try {
		return await rpc.productCategories.create(
			{ partnerId: 'p1', name },
			{ context: { batch: false } }
		)
	} catch (error) {
		if (hasOrpcErrorCode(error, 'CONFLICT')) return null
		const status: number | undefined = responseStatusOf(error)
		void status
		throw error
	}
}

// @ts-expect-error the client context is typed
void rpc.health.ping(undefined, { context: { batch: 'never' } })
// @ts-expect-error the input is typed from the Zod 3 schema
void rpc.productCategories.create({ partnerId: 'p1', title: 'Drinks' })
