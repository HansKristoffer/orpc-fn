#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnyRouter } from '@orpc/server'
import { CliError, defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod'
import { createStreamManifestAsync, renderStreamManifest } from './router.js'

const streamManifest = defineCommand({
	description:
		"Write the paths of a router's streaming routes for createRpcLink({ streamPaths }), only when they change. Importing the router runs its module code: load .ts routers with bun, tsx or node >= 22.18.",
	input: z.object({
		module: z
			.string()
			.describe('Router module, with #export for a named export')
			.meta({ positional: true }),
		out: z.string().describe('Manifest to write: file.ts or file.json'),
		name: z
			.string()
			.optional()
			.describe('Exported constant name in a .ts file'),
		check: z.boolean().describe('Exit 1 when the file is missing or stale')
	}),
	run: async (input) => {
		const [modulePath = '', exportName = 'default'] = input.module.split('#')
		const loaded: Record<string, unknown> = await import(
			pathToFileURL(resolve(modulePath)).href
		)
		const router = loaded[exportName]
		if (!router || typeof router !== 'object')
			throw new CliError(
				`orpc-fn: ${modulePath} has no router export "${exportName}"`,
				{ exitCode: 2 }
			)
		const out = resolve(input.out)
		const source = renderStreamManifest(
			await createStreamManifestAsync(router as AnyRouter),
			{ format: out.endsWith('.json') ? 'json' : 'ts', name: input.name }
		)
		const current = await readFile(out, 'utf8').catch(() => undefined)
		if (current === source) return
		if (input.check)
			throw new CliError(
				`orpc-fn: ${input.out} is stale; rerun without --check to update it`
			)
		await writeFile(out, source)
		return `orpc-fn: wrote ${input.out}`
	}
})

const cli = defineCli({
	name: 'orpc-fn',
	commands: { 'stream-manifest': streamManifest }
})

// Exit explicitly: the imported router may hold open database or broker handles.
process.exit(await cli.run())
