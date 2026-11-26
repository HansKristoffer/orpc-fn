#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AnyRouter } from '@orpc/server'
import { CliError, defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod/v4'
import { createStreamManifestAsync, renderStreamManifest } from './router.js'

const streamManifest = defineCommand({
	description: `Generate the stream manifest for createRpcLink({ streamPaths })

Imports the router (export "default" unless #export is given) and writes the
paths of its streaming routes for createRpcLink({ streamPaths }). The file is
only written when its content changes. --check writes nothing and exits 1 when
the file is missing or stale. Importing the router runs its module code; run
TypeScript routers with a runtime that loads .ts (bun, tsx, node >= 22.18).`,
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
		const hashIndex = input.module.lastIndexOf('#')
		const modulePath =
			hashIndex === -1 ? input.module : input.module.slice(0, hashIndex)
		const exportName =
			hashIndex === -1
				? 'default'
				: input.module.slice(hashIndex + 1) || 'default'
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
		await mkdir(dirname(out), { recursive: true })
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
