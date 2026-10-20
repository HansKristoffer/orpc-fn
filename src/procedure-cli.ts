import { type AnyProcedure, call, isProcedure, ORPCError } from '@orpc/server'
import {
	CliError,
	type Command,
	type CommandGroup,
	defineCommand
} from 'hanzio/cli'
import { z } from 'zod'
import { type FnMeta, readFnMeta } from './meta.js'

export type ProcedureCommandsOptions<C> = {
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
	context?: (cliContext: C, meta: FnMeta) => unknown
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
export function procedureCommands<C = unknown>(
	router: object,
	options: ProcedureCommandsOptions<C> = {}
): CommandGroup<C> {
	const filter = options.filter ?? optedIn
	const commands: Record<string, Command<C> | CommandGroup<C>> = {}

	for (const [key, value] of Object.entries(router)) {
		if (isProcedure(value)) {
			const meta = readFnMeta(value)
			if (filter(meta)) commands[kebab(key)] = toCommand(value, meta, options)
		} else if (value && typeof value === 'object') {
			const group = procedureCommands(value, options)
			if (Object.keys(group).length > 0) commands[kebab(key)] = group
		}
	}

	return commands
}

function toCommand<C>(
	procedure: AnyProcedure,
	meta: FnMeta,
	options: ProcedureCommandsOptions<C>
): Command<C> {
	const name = meta.name ?? 'procedure'
	if (meta.stream) {
		throw new TypeError(`orpc-fn: ${name} streams and cannot be a CLI command`)
	}
	const input = meta.inputSchema
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
				// A refusal the caller drives (auth, permission, not found) reads as
				// a message, not a crash with a stack trace.
				if (error instanceof ORPCError && error.status < 500) {
					throw new CliError(`${error.code}: ${error.message}`, {
						cause: error
					})
				}
				throw error
			}
		}
	})
}
