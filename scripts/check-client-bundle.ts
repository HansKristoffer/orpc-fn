import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const temporary = await mkdtemp(join(tmpdir(), 'orpc-fn-browser-'))
try {
	const manifest = join(temporary, 'manifest.ts')
	await writeFile(
		manifest,
		'export const streamPaths = [["nested", "watch"]] as const\n'
	)
	const metafile = join(temporary, 'metadata.json')
	const process_ = Bun.spawn(
		[
			'bun',
			'build',
			'src/client.ts',
			'src/expo.ts',
			manifest,
			'--target=browser',
			'--outdir',
			join(temporary, 'bundle'),
			`--metafile=${metafile}`
		],
		{ stdout: 'pipe', stderr: 'pipe' }
	)
	if (await process_.exited)
		throw new Error(await new Response(process_.stderr).text())
	const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
		inputs: Record<string, unknown>
	}
	const unexpected = Object.keys(metadata.inputs).filter((path) =>
		/@orpc\/server|src\/create-fn|src\/live\/|@modelcontextprotocol|@mastra|src\/hono/.test(
			path
		)
	)
	if (unexpected.length)
		throw new Error(`Server code in frontend bundle: ${unexpected.join(', ')}`)
	console.log(
		`Browser entry points and serialized manifest passed (${Object.keys(metadata.inputs).length} modules; no server/adapters/live runtime)`
	)
} finally {
	await rm(temporary, { recursive: true, force: true })
}
