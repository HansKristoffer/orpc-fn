#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a CLI reports on the console
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { AnyRouter } from '@orpc/server'
import { createStreamManifestAsync, renderStreamManifest } from './router.js'

const usage = `Usage: orpc-fn stream-manifest <module>[#export] --out <file.ts|file.json> [--name streamPaths] [--check]

Imports the router (export "default" unless #export is given) and writes the
paths of its streaming routes for createRpcLink({ streamPaths }). The file is
only written when its content changes. --check writes nothing and exits 1 when
the file is missing or stale. Importing the router runs its module code; run
TypeScript routers with a runtime that loads .ts (bun, tsx, node >= 22.18).`

async function run(argv: readonly string[]): Promise<number> {
	const { positionals, values } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			out: { type: 'string' },
			name: { type: 'string' },
			check: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' }
		}
	})
	const [command, target] = positionals
	if (values.help || command !== 'stream-manifest' || !target || !values.out) {
		console.error(usage)
		return values.help ? 0 : 2
	}
	const [modulePath = '', exportName = 'default'] = target.split('#')
	const loaded: Record<string, unknown> = await import(
		pathToFileURL(resolve(modulePath)).href
	)
	const router = loaded[exportName]
	if (!router || typeof router !== 'object') {
		console.error(`orpc-fn: ${modulePath} has no router export "${exportName}"`)
		return 2
	}
	const out = resolve(values.out)
	const source = renderStreamManifest(
		await createStreamManifestAsync(router as AnyRouter),
		{ format: out.endsWith('.json') ? 'json' : 'ts', name: values.name }
	)
	const current = await readFile(out, 'utf8').catch(() => undefined)
	if (current === source) return 0
	if (values.check) {
		console.error(
			`orpc-fn: ${values.out} is stale; rerun without --check to update it`
		)
		return 1
	}
	await writeFile(out, source)
	console.log(`orpc-fn: wrote ${values.out}`)
	return 0
}

// Exit explicitly: the imported router may hold open database or broker handles.
run(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		console.error(error)
		process.exit(1)
	}
)
