// What a Vitest server test does: call a real procedure with a fake scope.
import { appRouter, createTestCall } from './rpc'
import type { Equal, Expect } from '../types'

const call = createTestCall({
	headers: new Headers(),
	timing: {},
	scope: { user: async () => ({ uid: 'u1' }) }
})

export async function listCategoryNames(): Promise<string[]> {
	const out = await call(appRouter.productCategories.list, { partnerId: 'p1' })
	type _Out = Expect<
		Equal<
			typeof out,
			{
				categories: { id: string; partnerId: string; name: string }[]
				requestId: number | null
			}
		>
	>
	// @ts-expect-error the input is typed from the Zod 3 schema
	void call(appRouter.productCategories.list, { partnerId: 1 })
	return out.categories.map((category) => category.name)
}
