import ts from 'typescript-ast'
import {
	applyEdits,
	type Edit,
	propertyName,
	routeObjects
} from './route-objects.ts'

/** Explicit metadata keys only; spreads and existing meta need manual review. */
export function rewriteMeta(source: string, keys: readonly string[]): string {
	const edits: Edit[] = []
	routeObjects(source, (object) => {
		if (
			object.properties.some(
				(p) => ts.isSpreadAssignment(p) || propertyName(p) === 'meta'
			)
		)
			return
		const metadata = object.properties.filter((p) =>
			keys.includes(propertyName(p) ?? '')
		)
		if (!metadata.length) return
		const first = metadata[0]
		if (!first) return
		// Leave trailing property comments for manual review; moving an inline
		// line comment can swallow a separator and change the resulting syntax.
		if (metadata.some((p) => /^\s*\/[/*]/.test(source.slice(p.end)))) return
		const entries = metadata.map((p) =>
			source.slice(p.getFullStart(), p.end).trim()
		)
		edits.push({
			start: first.getFullStart(),
			end: first.end,
			text: `${source.slice(first.getFullStart(), first.getStart()).match(/^\s*/)?.[0] ?? ''}meta: {\n${entries.join(',\n')}\n}`
		})
		for (const property of metadata.slice(1))
			edits.push({
				start: property.getFullStart(),
				end: property.end + (source[property.end] === ',' ? 1 : 0),
				text: ''
			})
	})
	return applyEdits(source, edits)
}

if (import.meta.main) {
	const args = process.argv.slice(2)
	const keys = args
		.filter((arg) => arg.startsWith('--meta='))
		.flatMap((arg) => arg.slice(7).split(','))
	if (!keys.length)
		throw new Error('Pass explicit metadata keys with --meta=readOnly,risk')
	for (const path of args.filter((arg) => !arg.startsWith('--'))) {
		const file = Bun.file(path)
		const source = await file.text()
		const rewritten = rewriteMeta(source, keys)
		if (rewritten !== source) await Bun.write(path, rewritten)
	}
}
