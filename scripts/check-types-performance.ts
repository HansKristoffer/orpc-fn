import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(root, '.type-benchmark-'))
const count = 300
const fixture = (entry: string) => `import { createFn } from '${entry}'
import { os } from '@orpc/server'
import { z } from 'zod'
const base = os.$context<{ user?: { id: string } }>()
const { fn } = createFn({ procedures: { public: base }, default: 'public', extras: () => ({ db: { query: (id: string) => id } }), guards: { permission: (value: boolean) => { if (!value) throw new Error('denied') } } })
${Array.from({ length: count }, (_, i) => `const route${i} = fn({ name: 'route${i}', permission: true, input: z.object({ id: z.string() }), output: z.object({ id: z.string() }), handler: ({ input, db }) => ({ id: db.query(input.id) }) })`).join('\n')}
export const router = { ${Array.from({ length: count }, (_, i) => `route${i}`).join(', ')} }
`
async function check(path: string) {
	const config = `${path}.json`
	await writeFile(
		config,
		JSON.stringify({
			compilerOptions: {
				noEmit: true,
				strict: true,
				skipLibCheck: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				types: ['node']
			},
			files: [path]
		})
	)
	const process_ = Bun.spawn(
		['bunx', '--no-install', 'tsc', '--extendedDiagnostics', '-p', config],
		{ cwd: root, stdout: 'pipe', stderr: 'pipe' }
	)
	const output = await new Response(process_.stdout).text()
	if (await process_.exited)
		throw new Error(output + (await new Response(process_.stderr).text()))
	return output
		.split('\n')
		.filter((line) =>
			/^(Types:|Instantiations:|Check time:|Total time:)/.test(line)
		)
		.join('\n')
}
try {
	await writeFile(join(temporary, 'current.ts'), fixture('../src/index.js'))
	const archive = Bun.spawn(['git', 'archive', 'HEAD', 'src'], {
		cwd: root,
		stdout: 'pipe'
	})
	const extract = Bun.spawn(['tar', '-x', '-C', temporary], {
		stdin: archive.stdout,
		stdout: 'ignore',
		stderr: 'inherit'
	})
	if ((await archive.exited) || (await extract.exited))
		throw new Error('Unable to prepare baseline sources')
	await writeFile(join(temporary, 'baseline.ts'), fixture('./src/index.js'))
	console.log(
		`Baseline (${count} routes)\n${await check(join(temporary, 'baseline.ts'))}`
	)
	console.log(
		`Current (${count} routes)\n${await check(join(temporary, 'current.ts'))}`
	)
} finally {
	await rm(temporary, { recursive: true, force: true })
}
