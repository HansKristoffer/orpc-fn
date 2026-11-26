import type { AnyMetaPlugin, AnySchema } from '@orpc/contract'
import type { AnyProcedure } from '@orpc/server'
import { fnMetaPlugin, openapiMetaPlugin } from './compatibility.js'
import type { StoredFnMeta } from './meta.js'
import type { BuildProcedure } from './types.js'

export type BuilderChain = {
	meta(...plugins: AnyMetaPlugin[]): BuilderChain
	input(schema: AnySchema): BuilderChain
	output(schema: AnySchema): BuilderChain
	errors(errors: import('@orpc/contract').ErrorMap): BuilderChain
	handler(handler: Parameters<BuildProcedure>[0]['handler']): AnyProcedure
}

export function createProcedureAssembler(
	procedures: Record<string, BuilderChain>,
	resolveKey: (key: string | undefined, name: string) => string
): BuildProcedure {
	return (route) => {
		const key = resolveKey(route.procedure, route.name)
		let builder = procedures[key]
		if (!builder) throw new Error(`orpc-fn: unknown procedure "${key}"`)
		const stored: StoredFnMeta = {
			name: route.name,
			procedure: key,
			meta: route.meta,
			stream: route.stream ?? false,
			guards: route.guards ?? {},
			dynamicGuards: route.dynamicGuards ?? []
		}
		builder = builder.meta(
			openapiMetaPlugin({
				operationId: route.name,
				...Object.fromEntries(
					Object.entries(route.route).filter(([, value]) => value !== undefined)
				)
			}),
			fnMetaPlugin(stored)
		)
		if (route.errors) builder = builder.errors(route.errors)
		if (route.input) builder = builder.input(route.input)
		if (route.output) builder = builder.output(route.output)
		return builder.handler(route.handler)
	}
}
