import { describe, expect, test } from 'bun:test'
import { isAsyncIteratorObject, onStreamEnd } from './stream.js'

async function* numbers() {
	yield 1
	yield 2
}

describe('onStreamEnd', () => {
	test('finishes once after the last item', async () => {
		const calls: unknown[][] = []
		const stream = onStreamEnd(numbers(), (...error) => calls.push(error))
		const values: number[] = []
		for await (const value of stream) values.push(value)
		expect(values).toEqual([1, 2])
		expect(calls).toEqual([[]])
	})

	test('return() before the first next() still finishes', async () => {
		const calls: unknown[][] = []
		const stream = onStreamEnd(numbers(), (...error) => calls.push(error))
		await stream.return?.(undefined)
		await stream.return?.(undefined)
		expect(calls).toEqual([[]])
	})

	test('an error finishes with the error', async () => {
		const failure = new Error('boom')
		async function* failing() {
			yield 1
			throw failure
		}
		const calls: unknown[][] = []
		const stream = onStreamEnd(failing(), (...error) => calls.push(error))
		await stream.next()
		await expect(stream.next()).rejects.toBe(failure)
		expect(calls).toEqual([[failure]])
	})

	test('isAsyncIteratorObject', () => {
		expect(isAsyncIteratorObject(numbers())).toBe(true)
		expect(isAsyncIteratorObject([1, 2])).toBe(false)
		expect(isAsyncIteratorObject(null)).toBe(false)
	})
})
