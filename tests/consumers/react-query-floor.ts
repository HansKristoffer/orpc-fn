// orpc-fn/react against @tanstack/react-query 5.66, its declared floor, with
// plain TanStack query options. (@orpc/tanstack-query 2 needs query-core
// 5.105 and fails at import on 5.90 and earlier, so the main type suite
// pairs it with 5.105.)
import { keepPreviousData } from '@tanstack/react-query'
import {
	useInvalidationStream,
	useLiveQuery,
	useOrpcSubscription,
	useQueryCacheOwner
} from 'orpc-fn/react'

type Order = { id: string; total: number }
declare const client: {
	order: {
		get(input: { id: string }): Promise<Order>
		watch(input: { id: string }): Promise<AsyncIterableIterator<Order>>
	}
	changes(input: object): Promise<AsyncIterableIterator<{ domain: 'order' }>>
}

export function useFloorHooks() {
	const order = useLiveQuery(
		{ id: '1' },
		(input) => ({
			queryKey: ['order', input.id],
			queryFn: () => client.order.get(input),
			placeholderData: keepPreviousData
		}),
		client.order.watch
	)
	const total: number | undefined = order.data?.total
	useOrpcSubscription({ id: '1' }, client.order.watch, {
		onEvent: (event) => void event.total
	})
	// @ts-expect-error the input is typed from the procedure
	useOrpcSubscription({ id: 1 }, client.order.watch)
	useInvalidationStream({}, client.changes, {
		domains: { order: { debounceMs: 500, queryKeys: [['order']] } }
	})
	useQueryCacheOwner('user-1')
	return [order.liveStatus, total] as const
}
