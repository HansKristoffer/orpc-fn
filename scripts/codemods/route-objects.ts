import ts from 'typescript-ast'

export type Edit = { start: number; end: number; text: string }
export function routeObjects(
	source: string,
	visit: (object: ts.ObjectLiteralExpression) => void
): void {
	const file = ts.createSourceFile(
		'routes.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX
	)
	const walk = (node: ts.Node) => {
		if (ts.isCallExpression(node)) {
			const name = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression)
					? node.expression.name.text
					: undefined
			const arg = node.arguments[0]
			if (
				name &&
				['fn', 'fnLive', 'createPubSub'].includes(name) &&
				arg &&
				ts.isObjectLiteralExpression(arg)
			)
				visit(arg)
		}
		ts.forEachChild(node, walk)
	}
	walk(file)
}
export function propertyName(
	property: ts.ObjectLiteralElementLike
): string | undefined {
	const name = property.name
	return name && (ts.isIdentifier(name) || ts.isStringLiteral(name))
		? name.text
		: undefined
}
export function removeProperty(
	source: string,
	object: ts.ObjectLiteralExpression,
	property: ts.ObjectLiteralElementLike
): Edit[] {
	let start = property.getStart()
	let end = property.end
	const following = source.slice(end).match(/^\s*,[ \t]*/)
	if (following) end += following[0].length
	else {
		const previous = object.properties[object.properties.indexOf(property) - 1]
		if (previous) {
			const comma = source.indexOf(',', previous.end)
			if (comma < start)
				return [
					{ start: comma, end: comma + 1, text: '' },
					{ start, end, text: '' }
				]
		}
	}
	const lineStart = source.lastIndexOf('\n', start - 1) + 1
	const lineEnd = source.indexOf('\n', end)
	if (
		/^[ \t]*$/.test(source.slice(lineStart, start)) &&
		lineEnd >= 0 &&
		/^[ \t]*$/.test(source.slice(end, lineEnd))
	) {
		start = lineStart
		end = lineEnd + 1
	}
	return [{ start, end, text: '' }]
}
export function applyEdits(source: string, edits: Edit[]): string {
	return edits
		.sort((a, b) => b.start - a.start)
		.reduce(
			(text, edit) =>
				text.slice(0, edit.start) + edit.text + text.slice(edit.end),
			source
		)
}
