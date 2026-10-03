// Rewrites how route files choose their procedure builder to `procedure:`.
//
//   --flag=isPublic:public   `isPublic: true` -> `procedure: 'public'`; `isPublic: false` is dropped
//   --rename=auth            `auth: 'admin'` -> `procedure: 'admin'` (string values only)
//
// Usage: bun scripts/codemods/procedure-option.ts <file-or-dir>... --flag=isPublic:public --rename=auth
// Review the diff. Routes containing spreads are left for manual review.
import ts from 'typescript-ast'
import {
	applyEdits,
	type Edit,
	propertyName,
	removeProperty,
	routeObjects
} from './route-objects.ts'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Rules = {
	/** Boolean option -> procedure key it selects when true. */
	flags?: Record<string, string>
	/** Options whose string value already is the procedure key. */
	renames?: string[]
}

export function rewrite(source: string, rules: Rules): string {
	const edits: Edit[] = []
	routeObjects(source, (object) => {
		if (object.properties.some(ts.isSpreadAssignment)) return
		const procedure = object.properties.find(
			(p) => propertyName(p) === 'procedure'
		)
		const changes: Array<{
			property: ts.PropertyAssignment
			value: string | undefined
		}> = []
		for (const property of object.properties) {
			if (!ts.isPropertyAssignment(property)) continue
			const name = propertyName(property)
			if (!name) continue
			const flag = rules.flags?.[name]
			if (
				flag !== undefined &&
				[ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
					property.initializer.kind
				)
			)
				changes.push({
					property,
					value:
						property.initializer.kind === ts.SyntaxKind.TrueKeyword
							? flag
							: undefined
				})
			else if (
				rules.renames?.includes(name) &&
				ts.isStringLiteral(property.initializer)
			)
				changes.push({ property, value: property.initializer.text })
		}
		const selected = changes.filter((c) => c.value !== undefined)
		const values = new Set(selected.map((c) => c.value))
		if (values.size > 1)
			throw new Error('Conflicting procedure flags; review the route manually')
		if (procedure && selected.length) {
			const value =
				ts.isPropertyAssignment(procedure) &&
				ts.isStringLiteral(procedure.initializer)
					? procedure.initializer.text
					: undefined
			if (value !== selected[0]?.value)
				throw new Error(
					'Existing procedure conflicts with legacy options; review the route manually'
				)
		}
		let wrote = Boolean(procedure)
		for (const change of changes) {
			if (change.value === undefined || wrote)
				edits.push(...removeProperty(source, object, change.property))
			else {
				edits.push({
					start: change.property.name.getStart(),
					end: change.property.name.end,
					text: 'procedure'
				})
				const quote =
					"'" +
					change.value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") +
					"'"
				edits.push({
					start: change.property.initializer.getStart(),
					end: change.property.initializer.end,
					text: quote
				})
				wrote = true
			}
		}
	})
	return applyEdits(source, edits)
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
