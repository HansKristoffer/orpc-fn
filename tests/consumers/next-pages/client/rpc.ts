// The browser client: one link with a typed client context, batching only
// the calls a group accepts, and TanStack Query utils over the router client.
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

const TANSTACK_OPERATION = Symbol.for('ORPC_TANSTACK_QUERY_OPERATION_CONTEXT')
const isQuery = (context: RpcClientContext): boolean =>
	(context as { [TANSTACK_OPERATION]?: { type?: unknown } })[TANSTACK_OPERATION]
		?.type === 'query'

const link = createRpcLink<RpcClientContext>({
	url: '/api/rpc',
	headers: async () => ({ authorization: 'Bearer token' }),
	batch: {
		maxSize: 20,
		groups: [
			{
				condition: ({ context }) => context.batch !== false && isQuery(context),
				context: {}
			}
		]
	}
})

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
