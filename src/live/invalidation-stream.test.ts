import { describe, expect, expectTypeOf, test } from 'bun:test'
import { z } from 'zod'
import { fn } from '../../tests/fixture.js'
import { invalidationStream } from './invalidation-stream.js'

// A streaming route whose events the test pushes; `closed` settles when the
// source generator finishes (aborted, returned or failed).
function source<T>(name: string) {
	const pending: Array<IteratorResult<T> | { error: unknown }> = []
	let wake: (() => void) | undefined
	let markClosed: () => void = () => {}
	const closed = new Promise<void>((resolve) => {
		markClosed = resolve
	})
	const put = (item: IteratorResult<T> | { error: unknown }) => {
		pending.push(item)
		wake?.()
	}
	const procedure = fn({
		name,
		procedure: 'public',
		stream: true,
		input: z.object({}),
		handler: async function* ({ signal }) {
			try {
				while (!signal?.aborted) {
					const item = pending.shift()
					if (!item) {
						await new Promise<void>((resolve) => {
							wake = resolve
							signal?.addEventListener('abort', () => resolve(), { once: true })
						})
						continue
					}
					if ('error' in item) throw item.error
					if (item.done) return
					yield item.value
				}
			} finally {
				markClosed()
			}
		}
	})
	return {
		procedure,
		push: (value: T) => put({ done: false, value }),
		end: () => put({ done: true, value: undefined }),
		fail: (error: unknown) => put({ error }),
		closed
	}
}

describe('invalidationStream', () => {
	test('tags each event with its domain and forwards mapped fields', async () => {
		const deals = source<{ kind: 'won' | 'lost'; dealId: string }>('test.deals')
		const items = source<{ id: string }>('test.items')
		const stream = invalidationStream({
			context: {},
			sources: { deal: deals.procedure, workItem: items.procedure },
			events: {
				deal: (event) =>
					event.kind === 'won' ? { dealId: event.dealId } : undefined
			}
		})
		expectTypeOf<
			Extract<
				Awaited<ReturnType<typeof stream.next>>['value'],
				{ domain: 'deal' }
			>
		>().toEqualTypeOf<{ domain: 'deal' } & { dealId?: string }>()

		deals.push({ kind: 'won', dealId: 'd1' })
		expect((await stream.next()).value).toEqual({
			domain: 'deal',
			dealId: 'd1'
		})
		items.push({ id: 'i1' })
		expect((await stream.next()).value).toEqual({ domain: 'workItem' })
		deals.push({ kind: 'lost', dealId: 'd2' })
		expect((await stream.next()).value).toEqual({ domain: 'deal' })

		await stream.return(undefined)
		await Promise.all([deals.closed, items.closed])
	})

	test('equal events collapse while the consumer is busy', async () => {
		const deals = source<{ id: string }>('test.dealsBurst')
		const stream = invalidationStream({
			context: {},
			sources: { deal: deals.procedure }
		})
		deals.push({ id: '1' })
		expect((await stream.next()).value).toEqual({ domain: 'deal' })
		deals.push({ id: '2' })
		deals.push({ id: '3' })
		deals.end()
		// The source closes only after the stream has read all three.
		await deals.closed
		// The two queued invalidations are one; then the ended source ends the stream.
		expect((await stream.next()).value).toEqual({ domain: 'deal' })
		expect((await stream.next()).done).toBe(true)
	})

	test('one source ending ends the stream and closes the others', async () => {
		const deals = source<{ id: string }>('test.dealsEnd')
		const items = source<{ id: string }>('test.itemsEnd')
		const stream = invalidationStream({
			context: {},
			sources: { deal: deals.procedure, workItem: items.procedure }
		})
		deals.end()
		expect((await stream.next()).done).toBe(true)
		await items.closed
	})

	test('one source failing fails the stream and closes the others', async () => {
		const deals = source<{ id: string }>('test.dealsFail')
		const items = source<{ id: string }>('test.itemsFail')
		const stream = invalidationStream({
			context: {},
			sources: { deal: deals.procedure, workItem: items.procedure }
		})
		deals.fail(new Error('broker gone'))
		await expect(stream.next()).rejects.toThrow('broker gone')
		await items.closed
	})

	test('aborting the caller signal ends the stream', async () => {
		const abort = new AbortController()
		const deals = source<{ id: string }>('test.dealsAbort')
		const stream = invalidationStream({
			context: {},
			signal: abort.signal,
			sources: { deal: deals.procedure }
		})
		deals.push({ id: '1' })
		await stream.next()
		const next = stream.next()
		abort.abort()
		expect((await next).done).toBe(true)
		await deals.closed
	})
})
