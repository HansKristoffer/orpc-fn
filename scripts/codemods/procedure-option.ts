// Rewrites how route files choose their procedure builder to `procedure:`.
//
//   --flag=isPublic:public   `isPublic: true` -> `procedure: 'public'`; `isPublic: false` is dropped
//   --rename=auth            `auth: 'admin'` -> `procedure: 'admin'` (string values only)
//
// Usage: bun scripts/codemods/procedure-option.ts <file-or-dir>... --flag=isPublic:public --rename=auth
// Review the diff: the rewrite is textual and also hits other objects using these keys.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Rules = {
	/** Boolean option -> procedure key it selects when true. */
	flags?: Record<string, string>
	/** Options whose string value already is the procedure key. */
	renames?: string[]
}

export function rewrite(source: string, rules: Rules): string {
	let next = source
	for (const [flag, key] of Object.entries(rules.flags ?? {})) {
		next = next
			.replace(
				new RegExp(`^[ \\t]*${flag}:\\s*false,?[ \\t]*\\r?\\n`, 'gm'),
				''
			)
			.replace(new RegExp(`\\b${flag}:\\s*false\\s*,\\s*`, 'g'), '')
			.replace(new RegExp(`\\b${flag}:\\s*true\\b`, 'g'), `procedure: '${key}'`)
	}
	for (const option of rules.renames ?? []) {
		next = next.replace(
			new RegExp(`\\b${option}:(\\s*)(['"])`, 'g'),
			'procedure:$1$2'
		)
	}
	return next
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
	const values = (name: string) =>
		args
			.filter((arg) => arg.startsWith(`--${name}=`))
			.map((arg) => arg.slice(name.length + 3))
	const rules: Rules = {
		flags: Object.fromEntries(values('flag').map((flag) => flag.split(':'))),
		renames: values('rename')
	}
	if (!Object.keys(rules.flags ?? {}).length && !rules.renames?.length) {
		console.error('Pass at least one --flag=option:key or --rename=option')
		process.exit(1)
	}
	let changed = 0
	for (const root of args.filter((arg) => !arg.startsWith('--'))) {
		for await (const file of files(root)) {
			const source = await readFile(file, 'utf8')
			const next = rewrite(source, rules)
			if (next === source) continue
			await writeFile(file, next)
			changed++
			console.log(`rewrote ${file}`)
		}
	}
	console.log(`${changed} file(s) changed`)
}
