import { type Atom, atom } from 'jotai'
import { atomWithQuery } from 'jotai-tanstack-query'
import type { Equal, Expect } from '../types'
import { orpc } from './rpc'

export const partnerIdAtom = atom<string | null>('p1')

export const categoriesQueryAtom = atomWithQuery((get) => {
	const partnerId = get(partnerIdAtom)
	return orpc.productCategories.list.queryOptions({
		input: { partnerId: partnerId ?? '' },
		enabled: !!partnerId
	})
})

export const categoryNamesAtom = atom(
	(get) =>
		get(categoriesQueryAtom).data?.categories.map(
			(category) => category.name
		) ?? []
)
type _Names = Expect<Equal<typeof categoryNamesAtom, Atom<string[]>>>
