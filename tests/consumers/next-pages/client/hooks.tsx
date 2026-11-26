import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Equal, Expect, IsAny, Not } from '../types'
import { orpc } from './rpc'

export function useCategories(partnerId: string | null) {
	const query = useQuery(
		orpc.productCategories.list.queryOptions({
			input: { partnerId: partnerId ?? '' },
			enabled: !!partnerId,
			context: { batch: false }
		})
	)
	type _Data = Expect<Not<IsAny<typeof query.data>>>
	const name: string | undefined = query.data?.categories[0]?.name
	// @ts-expect-error the data is typed, so a field the route does not return fails
	void query.data?.categories[0]?.title
	return { query, name }
}

export function useCreateCategory() {
	const queryClient = useQueryClient()
	const mutation = useMutation(
		orpc.productCategories.create.mutationOptions({
			onSuccess: (category) => {
				type _Category = Expect<
					Equal<typeof category, { id: string; partnerId: string; name: string }>
				>
				return queryClient.invalidateQueries({
					queryKey: orpc.productCategories.key()
				})
			}
		})
	)
	const create = () => mutation.mutate({ partnerId: 'p1', name: 'Drinks' })
	// @ts-expect-error the variables are the route's input
	const wrong = () => mutation.mutate({ partnerId: 'p1' })
	return { create, wrong }
}
