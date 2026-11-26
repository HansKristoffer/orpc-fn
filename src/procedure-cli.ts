import {
	type AnyProcedure,
	type AnyRouter,
	call,
	type InferRouterInitialContext,
	walkProcedureContractsSync
} from '@orpc/server'
import {
	CliError,
	type Command,
	type CommandGroup,
	defineCommand
} from 'hanzio/cli'
import { z } from 'zod/v4'
import { procedureDefinition, soleSchema } from './compatibility.js'
import { isExpectedClientError } from './expected-client-error.js'
import { formatIssue, issuesOf } from './issues.js'
import { type FnMeta, readFnMeta } from './meta.js'
import { errorCodeOf, errorMessageOf } from './otel.js'
import type { MaybePromise } from './types.js'

export type ProcedureCommandsOptions<C, R extends AnyRouter = AnyRouter> = {
	/**
	 * Which procedures become commands. Default: those declared with
	 * `meta: { cli: true }` (add `cli?: boolean` to the app's meta type).
	 */
	filter?: (meta: FnMeta) => boolean
	/**
	 * The oRPC context a command calls its procedure with, from the CLI's
	 * context (`defineCli({ context })`). Default: that context as-is. It gets
	 * the procedure's meta, so it can refuse early with a `CliError`, e.g. a
	 * protected procedure run without a user.
	 */
	context?: (
		cliContext: C,
		meta: FnMeta
	) => MaybePromise<InferRouterInitialContext<R>>
}

const optedIn = (meta: FnMeta) => (meta.meta as { cli?: unknown }).cli === true

const kebab = (key: string) =>
	key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/**
 * The opted-in `fn()` procedures of a router as hanzio/cli commands, nested
 * like the router: `supportLearning.syncRun` is `support-learning sync-run`.
 * Flags come from the procedure's input schema, help from its summary. A
 * command calls the procedure through oRPC, so middleware, guards, tracing
 * and errors run as they do over HTTP.
 */
export function procedureCommands<C = unknown, R extends AnyRouter = AnyRouter>(
	router: R,
	options: ProcedureCommandsOptions<C, R> = {}
): CommandGroup<C> {
	const filter = options.filter ?? optedIn
	const commands: Record<string, Command<C> | CommandGroup<C>> = {}
	const unresolved = walkProcedureContractsSync(router, (contract, path) => {
		const procedure = contract as AnyProcedure
		const meta = readFnMeta(procedure)
		if (!filter(meta)) return
		const segments = path.map(kebab)
		let target = commands
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i]!
			const existing = target[segment]
			if (existing === undefined) {
				const group: Record<string, Command<C> | CommandGroup<C>> = {}
				target[segment] = group
				target = group
			} else if (
				typeof existing === 'object' &&
				existing !== null &&
				!('run' in existing)
			) {
				target = existing as Record<string, Command<C> | CommandGroup<C>>
			} else {
				throw new TypeError(
					`orpc-fn: CLI command name collision at "${segments.slice(0, i + 1).join(' ')}"`
				)
			}
		}
		const leaf = segments[segments.length - 1]!
		if (leaf in target) {
			throw new TypeError(
				`orpc-fn: CLI command name collision at "${segments.join(' ')}"`
			)
		}
		target[leaf] = toCommand(procedure, meta, options)
	})
	if (unresolved.length) {
		throw new TypeError(
			'orpc-fn: resolve lazy routers with unlazyRouter before building CLI commands'
		)
	}
	return commands
}

function toCommand<C, R extends AnyRouter>(
	procedure: AnyProcedure,
	meta: FnMeta,
	options: ProcedureCommandsOptions<C, R>
): Command<C> {
	const name = meta.name ?? 'procedure'
	if (meta.stream) {
		throw new TypeError(`orpc-fn: ${name} streams and cannot be a CLI command`)
	}
	const input = soleSchema(
		procedureDefinition(procedure).inputSchemas,
		`CLI command ${name}`
	)
	if (input !== undefined && !(input instanceof z.ZodObject)) {
		throw new TypeError(
			`orpc-fn: ${name} must take a z.object() input to be a CLI command`
		)
	}

	return defineCommand<z.ZodObject, unknown, C>({
		description: meta.description,
		input: input ?? z.object({}),
		run: async (parsed, ctx) => {
			const context = options.context
				? await options.context(ctx.context, meta)
				: ctx.context
			try {
				// The flags were validated against this schema; the procedure parses
				// them again, like any nested call with a parsed value.
				return await call(procedure, input ? parsed : undefined, {
					context: context as Record<never, never>
				})
			} catch (error) {
				// A refusal the caller drives (auth, permission, not found, expected
				// domain error) reads as a message, not a crash with a stack trace.
				if (isExpectedClientError(error)) {
					const code = errorCodeOf(error)
					const message = errorMessageOf(error)
					const lines = [
						code ? `${code}: ${message}` : message,
						...issuesOf(error).map(formatIssue)
					]
					throw new CliError(lines.join('\n'), { cause: error })
				}
				throw error
			}
		}
	})
}
