import { expect, test } from 'bun:test'
import { rewriteMeta } from './route-meta.ts'

test('moves only selected route metadata and preserves comments and nested objects', () => {
	const source =
		"const other = { risk: 'low' }; fn({ name: 'a', readOnly: true, /* risk note */ risk: 'high', handler: () => ({ risk: 'high' }) })"
	const rewritten = rewriteMeta(source, ['readOnly', 'risk'])
	expect(rewritten).toContain('meta: {')
	expect(rewritten).toContain('/* risk note */')
	expect(rewritten).toContain("const other = { risk: 'low' }")
	expect(rewritten).toContain("handler: () => ({ risk: 'high' })")
	expect(
		rewriteMeta('fn({ ...options, readOnly: true, handler })', ['readOnly'])
	).toBe('fn({ ...options, readOnly: true, handler })')
})
