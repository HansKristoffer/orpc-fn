import { isExpectedClientError } from './expected-client-error.js'
import { formatIssue, issuesOf } from './issues.js'
import { errorCodeOf, errorMessageOf } from './otel.js'

/** How a tool adapter turns a failed call into text for the model. */
export type ToolErrorOptions = {
	/**
	 * Errors the model may read. Default: `isExpectedClientError` (4xx
	 * `ORPCError`, aborts, and whatever the factory's `isExpectedError` accepted).
	 */
	isExpectedError?: (error: unknown) => boolean
	/** Unexpected errors, whose text the model does not see. Report them here. */
	onError?: (error: unknown, info: { tool: string }) => void
	/** Replace the text the model reads. */
	formatError?: (
		error: unknown,
		info: { tool: string; expected: boolean }
	) => string
}

/**
 * An expected error reads `CODE: message`, then one `path: message` line per
 * validation issue, so the model can fix its arguments. Anything else reads
 * as a fixed sentence: its text may hold internals and goes to `onError`.
 */
export function toolErrorText(
	error: unknown,
	tool: string,
	options: ToolErrorOptions
): string {
	let expected = false
	try {
		expected = (options.isExpectedError ?? isExpectedClientError)(error)
	} catch {
		/* A failing classifier hides the error. */
	}
	if (!expected) {
		try {
			options.onError?.(error, { tool })
		} catch {
			/* Reporting cannot change the tool's answer. */
		}
	}
	if (options.formatError) return options.formatError(error, { tool, expected })
	if (!expected) return `${tool} failed unexpectedly. The error was reported.`
	const code = errorCodeOf(error)
	const message = errorMessageOf(error)
	return [
		code ? `${code}: ${message}` : message,
		...issuesOf(error).map(formatIssue)
	].join('\n')
}
