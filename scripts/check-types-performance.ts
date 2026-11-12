import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const temporary = await mkdtemp(join(root, '.type-benchmark-'))
const count = 300
/** Allowed growth in instantiations over HEAD before the check fails. */
const maxGrowth = Number(process.env.TYPES_PERF_MAX_GROWTH ?? 0.05)
// App-shaped: two builders, shared and scoped extras, two guards, typed meta,
// explicit and inferred outputs, all read back through RouterClient.
const route = (i: number) => {
	const procedure = i % 3 === 0 ? 'public' : 'protected'
	const guards =
		procedure === 'protected' ? "permission: true, flags: ['beta'], " : ''
	const output = i % 2 === 0 ? 'output: z.object({ id: z.string() }), ' : ''
	const handler =
		procedure === 'protected'
			? '({ input, db, userId }) => ({ id: db.query(input.id) + userId })'
			: '({ input, db }) => ({ id: db.query(input.id) })'
	return `const route${i} = fn({ name: 'route${i}', procedure: '${procedure}', ${guards}meta: { audit: ${i % 2 === 0} }, input: z.object({ id: z.string() }), ${output}handler: ${handler} })`
}
const fixture = (
	entry: string
) => `import { createFn, defineMeta } from '${entry}'
import { os, type RouterClient } from '@orpc/server'
import { z } from 'zod'
const base = os.$context<{ user?: { id: string } }>()
const authed = base.use(({ context, next }) => next({ context: { user: context.user ?? { id: 'anonymous' } } }))
const { fn } = createFn({
	procedures: { public: base, protected: authed },
	extras: () => ({ db: { query: (id: string) => id } }),
	extrasByProcedure: { protected: ({ context }) => ({ userId: context.user.id }) },
	guards: {
		permission: (value: boolean) => { if (!value) throw new Error('denied') },
		flags: (value: string[]) => value.length > 0
	},
	meta: defineMeta<{ audit?: boolean }>()
})
${Array.from({ length: count }, (_, i) => route(i)).join('\n')}
export const router = { ${Array.from({ length: count }, (_, i) => `route${i}`).join(', ')} }
declare const client: RouterClient<typeof router>
export const ids = [${Array.from({ length: count }, (_, i) => `client.route${i}({ id: '${i}' }).then((output) => output.id)`).join(', ')}]
`
const instantiations = (report: string) =>
	Number(/^Instantiations:\s+(\d+)/m.exec(report)?.[1] ?? Number.NaN)
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
	const baseline = await check(join(temporary, 'baseline.ts'))
	const current = await check(join(temporary, 'current.ts'))
	console.log(`Baseline (${count} routes)\n${baseline}`)
	console.log(`Current (${count} routes)\n${current}`)
	const growth = instantiations(current) / instantiations(baseline) - 1
	if (!(growth <= maxGrowth)) {
		console.error(
			`Instantiations grew ${(growth * 100).toFixed(1)}% (limit ${(maxGrowth * 100).toFixed(0)}%)`
		)
		process.exitCode = 1
	}
} finally {
	await rm(temporary, { recursive: true, force: true })
}
