import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/server'
import { throwInitialSnapshotError } from './fn-live.js'

function createFakeLogger() {
	const calls: Array<{ message: string; attributes?: unknown }> = []
	return {
		calls,
		error(message: string, attributes?: unknown) {
			calls.push({ message, attributes })
		}
	}
}

describe('throwInitialSnapshotError', () => {
	test('re-throws an expected 4xx client error without logging', () => {
		const logger = createFakeLogger()
		const clientError = new ORPCError('NOT_FOUND', {
			message: 'Support session not found'
		})

		expect(() =>
			throwInitialSnapshotError(clientError, 'support.subscribe', logger)
		).toThrow(clientError)
		expect(logger.calls).toHaveLength(0)
	})

	test('logs and re-throws a 5xx ORPCError', () => {
		const logger = createFakeLogger()
		const serverError = new ORPCError('INTERNAL_SERVER_ERROR', {
			message: 'boom'
		})

		expect(() =>
			throwInitialSnapshotError(serverError, 'support.subscribe', logger)
		).toThrow(serverError)
		expect(logger.calls).toHaveLength(1)
		expect(logger.calls[0]?.message).toBe('fnLive initial snapshot failed')
	})

	test('logs and wraps an unknown error as INTERNAL_SERVER_ERROR', () => {
		const logger = createFakeLogger()

		let thrown: unknown
		try {
			throwInitialSnapshotError(
				new Error('db down'),
				'support.subscribe',
				logger
			)
		} catch (err) {
			thrown = err
		}

		expect(thrown).toBeInstanceOf(ORPCError)
		expect((thrown as ORPCError<string, unknown>).code).toBe(
			'INTERNAL_SERVER_ERROR'
		)
		expect(logger.calls).toHaveLength(1)
	})
})
