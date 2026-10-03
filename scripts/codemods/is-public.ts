// Rewrites `isPublic: true` to `procedure: 'public'` and `isSupport: true` to
// `procedure: 'support'` in route files; drops `isPublic: false` /
// `isSupport: false`. Usage:
//   bun scripts/codemods/is-public.ts <file-or-dir>... [--public=public] [--support=support]
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function rewrite(
	source: string,
	keys: { public: string; support: string } = {
		public: 'public',
		support: 'support'
	}
): string {
	return source
		.replace(/^[ \t]*is(Public|Support):\s*false,?[ \t]*\r?\n/gm, '')
		.replace(/\bis(Public|Support):\s*false\s*,\s*/g, '')
		.replace(
			/\bis(Public|Support):\s*true\b/g,
			(_match, kind: 'Public' | 'Support') =>
				`procedure: '${kind === 'Public' ? keys.public : keys.support}'`
		)
}

async function* files(path: string): AsyncGenerator<string> {
	if (!(await stat(path)).isDirectory()) {
		yield path
		return
	}
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
		const child = join(path, entry.name)
		if (entry.isDirectory()) yield* files(child)
		else if (/\.tsx?$/.test(entry.name)) yield child
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2)
	const flag = (name: string) =>
		args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]
	const keys = {
		public: flag('public') ?? 'public',
		support: flag('support') ?? 'support'
	}
	let changed = 0
	for (const root of args.filter((arg) => !arg.startsWith('--'))) {
		for await (const file of files(root)) {
			const source = await readFile(file, 'utf8')
			const next = rewrite(source, keys)
			if (next === source) continue
			await writeFile(file, next)
			changed++
			console.log(`rewrote ${file}`)
		}
	}
	console.log(`${changed} file(s) changed`)
}
