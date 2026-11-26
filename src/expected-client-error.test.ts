import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/server'
import {
	errorStatusOf,
	isExpectedClientError
} from './expected-client-error.js'

describe('isExpectedClientError', () => {
	test('treats a 4xx ORPCError as an expected client error', () => {
		const notFound = new ORPCError('NOT_FOUND', {
			message: 'Support session not found'
		})
		expect(isExpectedClientError(notFound)).toBe(true)
	})

	test('treats a 5xx ORPCError as a server fault', () => {
		const serverError = new ORPCError('INTERNAL_SERVER_ERROR', {
			message: 'boom'
		})
		expect(isExpectedClientError(serverError)).toBe(false)
	})

	test('treats a client disconnect abort as an expected client error', () => {
		const disconnect = new DOMException(
			'The connection was closed.',
			'AbortError'
		)
		expect(isExpectedClientError(disconnect)).toBe(true)
	})

	test('treats a plain Error as a server fault', () => {
		expect(isExpectedClientError(new Error('db down'))).toBe(false)
	})

	test('treats a non-error value as a server fault', () => {
		expect(isExpectedClientError(undefined)).toBe(false)
		expect(isExpectedClientError('nope')).toBe(false)
	})
})

describe('errorStatusOf', () => {
	test("is the status a handler answers with: the app's map, oRPC's, else 400", () => {
		expect(errorStatusOf(new ORPCError('NOT_FOUND'))).toBe(404)
		expect(errorStatusOf(new ORPCError('RATE_LIMITED'))).toBe(400)
		expect(
			errorStatusOf(new ORPCError('RATE_LIMITED'), { RATE_LIMITED: 429 })
		).toBe(429)
		expect(errorStatusOf(new ORPCError('NOT_FOUND'), { NOT_FOUND: 410 })).toBe(
			410
		)
	})

	test('any other thrown value answers 500', () => {
		expect(errorStatusOf(new Error('db down'))).toBe(500)
		expect(errorStatusOf(undefined)).toBe(500)
	})
})
