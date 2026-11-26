import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname
// Consumers type-check with the repo's own TypeScript unless told otherwise.
const rootTypeScript: string = (
	await Bun.file(join(root, 'node_modules/typescript/package.json')).json()
).version
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
const tsc = ['node', 'node_modules/typescript/bin/tsc']
const lockedVersion = (name: string): string =>
	require(`${root}/node_modules/${name}/package.json`).version

/**
 * Kanpla's Admin app (Next.js Pages Router), whose pins do not move with
 * ours: TypeScript 5.4.5, its compiler options (`tests/consumers/kanpla/
 * tsconfig.json`), Zod 3 and React Query 5.108 with Jotai. oRPC is ours.
 */
async function checkKanpla() {
	await install([
		tarball,
		...[
			'@orpc/server',
			'@orpc/contract',
			'@orpc/client',
			'@orpc/tanstack-query'
		].map((name) => `${name}@${lockedVersion(name)}`),
		'typescript@5.4.5',
		'zod@3.25.76',
		'next@16.4.5',
		'react@19.1.1',
		'react-dom@19.1.1',
		'@tanstack/react-query@5.108.4',
		'jotai@2.12.1',
		'jotai-tanstack-query@0.9.0',
		'@types/node@22',
		'@types/react@19'
	])
	await cp(join(root, 'tests/consumers/kanpla'), fixture, { recursive: true })
	await run([...tsc, '-p', 'tsconfig.json'])

	// `skipLibCheck` hides errors inside declarations, ours included: a type
	// TypeScript 5.4 cannot read would silently become `any`. So check again
	// without it and fail on what our own declarations report (oRPC's need 5.7).
	const strict = Bun.spawn(
		[
			...tsc,
			'-p',
			'tsconfig.json',
			'--skipLibCheck',
			'false',
			'--pretty',
			'false'
		],
		{ cwd: fixture, stdout: 'pipe', stderr: 'inherit' }
	)
	const output = await new Response(strict.stdout).text()
	await strict.exited
	const ours = output
		.split('\n')
		.filter((line) => line.startsWith('node_modules/orpc-fn/'))
	if (ours.length)
		throw new Error(
			`orpc-fn's declarations do not compile on TypeScript 5.4.5:\n${ours.join('\n')}`
		)
	console.log('Packed consumer passed (kanpla, TypeScript 5.4.5)')
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

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarball = `${pkg.name}-${pkg.version}.tgz`
const profile = process.env.PEER_PROFILE ?? 'locked'

/** The package against a peer profile: our locked versions, the floors or the newest. */
async function checkPeers() {
	const required = ['@orpc/server', '@orpc/contract', '@orpc/client', 'zod']
	const optional = [
		'@orpc/openapi',
		'@orpc/zod',
		'@orpc/json-schema',
		'hono',
		'@mastra/core',
		'@opentelemetry/api',
		'@modelcontextprotocol/sdk',
		'@modelcontextprotocol/server',
		'vue',
		'@tanstack/vue-query',
		'react',
		'@tanstack/react-query'
	]
	const versions = (names: string[]) =>
		names.map((name) => {
			if (profile === 'minimum') {
				const minimum: Record<string, string> = {
					zod: '4.0.0',
					hono: '4.0.0',
					'@mastra/core': '1.51.0',
					'@opentelemetry/api': '1.9.0',
					'@modelcontextprotocol/sdk': '1.32.0',
					'@modelcontextprotocol/server': '2.0.0',
					vue: '3.3.0',
					// With @orpc/tanstack-query 2 (query-core >= 5.105); the 5.66
					// floor of orpc-fn/react is checked on its own below.
					'@tanstack/vue-query': '5.105.0',
					react: '18.0.0',
					'@tanstack/react-query': '5.105.0'
				}
				return `${name}@${minimum[name] ?? '2.0.0-beta.53'}`
			}
			if (profile === 'latest') return `${name}@${pkg.peerDependencies[name]}`
			return `${name}@${lockedVersion(name)}`
		})

	// Root and live entries need only the required peers.
	await install([tarball, ...versions(required)])
	await cp(join(root, 'tests/consumers/smoke.mjs'), join(fixture, 'smoke.mjs'))
	await run([...node, 'smoke.mjs'])
	// The fetch and node mount adapters need no optional peer either.
	await cp(
		join(root, 'tests/consumers/http-smoke.mjs'),
		join(fixture, 'http-smoke.mjs')
	)
	await run([...node, 'http-smoke.mjs'])

	// Adapters and types with every optional peer installed. @orpc/zod 2
	// converts with zod >= 4.5; core routes accept older zod (checked above).
	await install([
		...versions(optional),
		...(profile === 'minimum' ? ['zod@4.5.0'] : []),
		// The client type tests build real query utils; same version as @orpc/client.
		versions(['@orpc/client'])[0]?.replace(
			'@orpc/client',
			'@orpc/tanstack-query'
		) ?? '',
		'@types/node@22',
		'@types/react@19',
		`typescript@${process.env.TYPESCRIPT_VERSION || rootTypeScript}`
	])
	await run([...node, 'smoke.mjs'], fixture, { WITH_OPTIONAL_PEERS: '1' })
	await cp(join(root, 'tests/consumers/types.ts'), join(fixture, 'types.ts'))
	await cp(join(root, 'examples/adoption'), join(fixture, 'examples'), {
		recursive: true,
		filter: (path) => !path.endsWith('.test.ts')
	})
	await cp(
		join(root, 'tests/consumers/mcp-smoke.mjs'),
		join(fixture, 'mcp-smoke.mjs')
	)
	await run([...node, 'mcp-smoke.mjs'])
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
					types: ['node'],
					// Third-party declarations are not ours to check.
					skipLibCheck: true,
					noEmit: true
				},
				include: ['types.ts', 'examples/*.ts']
			})
		)
		await run([...tsc, '-p', 'tsconfig.json'])
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
				'node_modules/orpc-fn/dist/fetch.d.ts',
				'node_modules/orpc-fn/dist/live/index.d.ts',
				'node_modules/orpc-fn/dist/live/memory.d.ts',
				'node_modules/orpc-fn/dist/live/redis-bun.d.ts',
				'node_modules/orpc-fn/dist/live/ioredis.d.ts'
			]
		})
	)
	await run([...tsc, '-p', 'tsconfig.json'])
	// zod 3.25 (the bridge release shipping `zod/v4`) satisfies the peer range:
	// v3 schemas in core routes, `zod/v4` schemas for live, and the adapters.
	await install([`zod@${profile === 'minimum' ? '3.25.3' : '3.25.76'}`])
	await run([...node, 'smoke.mjs'])
	await run([...node, 'http-smoke.mjs'])
	const checkBundler = async (file: string) => {
		await cp(join(root, 'tests/consumers', file), join(fixture, file))
		await writeFile(
			join(fixture, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					exactOptionalPropertyTypes: true,
					noEmit: true,
					types: ['node'],
					skipLibCheck: true
				},
				files: [file]
			})
		)
		await run([...tsc, '-p', 'tsconfig.json'])
	}
	await checkBundler('zod3.ts')
	if (profile === 'minimum') {
		await install(['@tanstack/react-query@5.66.0'])
		await checkBundler('react-query-floor.ts')
	}
	const typescript = JSON.parse(
		await readFile(
			join(fixture, 'node_modules/typescript/package.json'),
			'utf8'
		)
	).version
	console.log(`Packed consumers passed (${profile}, TypeScript ${typescript})`)
}

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
	await writeFile(
		join(fixture, 'package.json'),
		JSON.stringify({ private: true, type: 'module' })
	)
	await (profile === 'kanpla' ? checkKanpla() : checkPeers())
} finally {
	await rm(fixture, { recursive: true, force: true })
}
