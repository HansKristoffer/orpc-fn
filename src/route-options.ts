import {
	type AnySchema,
	type ErrorMap,
	getEventIteratorSchemaDetails
} from '@orpc/contract'
import { ROUTE_OPTION_KEYS } from './types.js'

type Resolver = (params: {
	input: unknown
	context: unknown
	signal: AbortSignal | undefined
}) => unknown
function schemaOption(schema: unknown, name: string): AnySchema | undefined {
	if (schema === undefined) return undefined
	if (
		typeof schema !== 'object' ||
		schema === null ||
		!('~standard' in schema) ||
		typeof (schema as AnySchema)['~standard']?.validate !== 'function'
	)
		throw new TypeError(`orpc-fn: ${name} must be a Standard Schema`)
	return schema as AnySchema
}

/** Runtime validation for JavaScript callers and spread route options. */
export function normalizeRoute(
	options: Record<string, unknown>,
	isGuard: (key: string) => boolean
) {
	const {
		handler,
		input: rawInput,
		output: rawOutput,
		name,
		procedure,
		meta: appMeta = {},
		stream,
		errors,
		guardResolvers = {},
		...rest
	} = options
	if (typeof name !== 'string' || !name || typeof handler !== 'function')
		throw new TypeError('orpc-fn: routes require a name and handler')
	if (procedure !== undefined && typeof procedure !== 'string')
		throw new TypeError('orpc-fn: procedure must be a configured key')
	if (typeof appMeta !== 'object' || appMeta === null || Array.isArray(appMeta))
		throw new TypeError('orpc-fn: meta must be an object')
	if (stream !== undefined && typeof stream !== 'boolean')
		throw new TypeError('orpc-fn: stream must be boolean')
	if (
		typeof guardResolvers !== 'object' ||
		guardResolvers === null ||
		Array.isArray(guardResolvers)
	)
		throw new TypeError('orpc-fn: guardResolvers must be an object')
	const input = schemaOption(rawInput, 'input')
	const output = schemaOption(rawOutput, 'output')
	const route: Record<string, unknown> = {}
	const guardChecks: Array<[string, unknown]> = []
	for (const [option, value] of Object.entries(rest)) {
		if ((ROUTE_OPTION_KEYS as readonly string[]).includes(option))
			route[option] = value
		else if (isGuard(option)) {
			if (value !== undefined) guardChecks.push([option, value])
		} else
			throw new TypeError(
				`orpc-fn: unknown route option "${option}"; put application metadata in meta`
			)
	}
	const iterator = getEventIteratorSchemaDetails(output) !== undefined
	if (stream === false && iterator)
		throw new TypeError(
			'orpc-fn: an event iterator schema cannot declare stream: false'
		)
	for (const [guard, resolver] of Object.entries(guardResolvers)) {
		if (!isGuard(guard))
			throw new TypeError(`orpc-fn: unknown guard resolver "${guard}"`)
		if (typeof resolver !== 'function')
			throw new TypeError(
				`orpc-fn: guard resolver "${guard}" must be a function`
			)
		if (guardChecks.some(([key]) => key === guard))
			throw new TypeError(
				`orpc-fn: guard "${guard}" has both a value and resolver`
			)
	}
	return {
		handler: handler as (params: Record<PropertyKey, unknown>) => unknown,
		input,
		output,
		name,
		procedure,
		meta: appMeta as Record<string, unknown>,
		stream: stream === true || iterator,
		errors: errors as ErrorMap | undefined,
		guardResolvers: guardResolvers as Record<string, Resolver>,
		route,
		guardChecks
	}
}
