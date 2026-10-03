import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
const fixture = await mkdtemp(join(tmpdir(), 'orpc-fn-consumer-'))
async function run(
	args: string[],
	cwd = fixture,
	env: Record<string, string> = {}
) {
	const process_ = Bun.spawn(args, {
		cwd,
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, ...env }
	})
	const code = await process_.exited
	if (code)
		throw new Error(`Consumer check failed (${code}): ${args.join(' ')}`)
}
const install = (packages: string[]) =>
	run([
		'npm',
		'install',
		'--ignore-scripts',
		'--no-package-lock',
		'--no-audit',
		'--no-fund',
		'--legacy-peer-deps',
		...packages
	])
const node = process.env.NODE_VERSION
	? [
			'npm',
			'exec',
			'--yes',
			'--package',
			`node@${process.env.NODE_VERSION}`,
			'--',
			'node'
		]
	: ['node']

try {
	await run(
		[
			'npm',
			'pack',
			'--ignore-scripts',
			'--silent',
			'--pack-destination',
			fixture
		],
		root
	)
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
	await writeFile(
		join(fixture, 'package.json'),
		JSON.stringify({ private: true, type: 'module' })
	)
	const profile = process.env.PEER_PROFILE ?? 'locked'
	const required = ['@orpc/server', '@orpc/contract', '@orpc/client', 'zod']
	const optional = [
		'@orpc/openapi',
		'@orpc/zod',
		'@orpc/json-schema',
		'hono',
		'@mastra/core',
		'@opentelemetry/api'
	]
	const versions = (names: string[]) =>
		names.map((name) => {
			if (profile === 'minimum') {
				const minimum: Record<string, string> = {
					zod: '4.0.0',
					hono: '4.0.0',
					'@mastra/core': '1.51.0',
					'@opentelemetry/api': '1.9.0'
				}
				return `${name}@${minimum[name] ?? '1.14.0'}`
			}
			if (profile === 'latest') return `${name}@${pkg.peerDependencies[name]}`
			const resolved = require(
				`${root}/node_modules/${name}/package.json`
			).version
			return `${name}@${resolved}`
		})

	// Root and live entries need only the required peers.
	await install([`${pkg.name}-${pkg.version}.tgz`, ...versions(required)])
	await cp(join(root, 'tests/consumers/smoke.mjs'), join(fixture, 'smoke.mjs'))
	await run([...node, 'smoke.mjs'])

	// Adapters and types with every optional peer installed.
	await install([
		...versions(optional),
		'@types/node@22',
		`typescript@${process.env.TYPESCRIPT_VERSION ?? '5.9.3'}`
	])
	await run([...node, 'smoke.mjs'], fixture, { WITH_OPTIONAL_PEERS: '1' })
	await cp(join(root, 'tests/consumers/types.ts'), join(fixture, 'types.ts'))
	for (const resolution of ['NodeNext', 'Bundler']) {
		await writeFile(
			join(fixture, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
					moduleResolution: resolution,
					strict: true,
					exactOptionalPropertyTypes: true,
					noUncheckedIndexedAccess: true,
					// Third-party declarations are not ours to check.
					skipLibCheck: true,
					noEmit: true
				},
				include: ['types.ts']
			})
		)
		await run([
			'node',
			'node_modules/typescript/bin/tsc',
			'-p',
			'tsconfig.json'
		])
	}
	// Our own declarations must compile without skipLibCheck.
	await writeFile(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				strict: true,
				exactOptionalPropertyTypes: true,
				noEmit: true,
				types: []
			},
			files: [
				'node_modules/orpc-fn/dist/index.d.ts',
				'node_modules/orpc-fn/dist/live/index.d.ts',
				'node_modules/orpc-fn/dist/live/memory.d.ts',
				'node_modules/orpc-fn/dist/live/redis-bun.d.ts',
				'node_modules/orpc-fn/dist/live/ioredis.d.ts'
			]
		})
	)
	await run(['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])
	const typescript = JSON.parse(
		await readFile(
			join(fixture, 'node_modules/typescript/package.json'),
			'utf8'
		)
	).version
	console.log(`Packed consumers passed (${profile}, TypeScript ${typescript})`)
} finally {
	await rm(fixture, { recursive: true, force: true })
}
