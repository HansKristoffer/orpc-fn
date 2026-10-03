import { expect, test } from 'bun:test'
import { rewrite } from './procedure-option.ts'

test('maps boolean flags to procedure keys', () => {
	const source = [
		'fn({',
		"\tname: 'a',",
		'\tisPublic: true,',
		'\thandler',
		'})',
		'fn({ name: "b", isSupport: true, handler })',
		'fn({',
		'\tisPublic: false,',
		'\thandler',
		'})',
		'fn({ name: "c", isPublic: false, handler })'
	].join('\n')
	expect(
		rewrite(source, { flags: { isPublic: 'public', isSupport: 'support' } })
	).toBe(
		[
			'fn({',
			"\tname: 'a',",
			"\tprocedure: 'public',",
			'\thandler',
			'})',
			`fn({ name: "b", procedure: 'support', handler })`,
			'fn({',
			'\thandler',
			'})',
			'fn({ name: "c", handler })'
		].join('\n')
	)
})

test('renames an option whose value is the procedure key', () => {
	expect(
		rewrite("fn({ name: 'a', auth: 'admin', authFn: check, handler })", {
			renames: ['auth']
		})
	).toBe("fn({ name: 'a', procedure: 'admin', authFn: check, handler })")
	// Non-string values are left alone.
	expect(rewrite('const x = { auth: token }', { renames: ['auth'] })).toBe(
		'const x = { auth: token }'
	)
})

test('only rewrites route options and preserves comments and existing procedure', () => {
	const source =
		"const unrelated = { isPublic: true }; fn({ isPublic /* policy */: true, procedure: 'public', handler }); fn({ nested: { isPublic: true }, handler }); fn({ ...config, isPublic: true, handler })"
	const result = rewrite(source, { flags: { isPublic: 'public' } })
	expect(result).toContain('const unrelated = { isPublic: true }')
	expect(result).toContain("procedure: 'public'")
	expect(result).toContain('nested: { isPublic: true }')
	expect(result).toContain('...config, isPublic: true')
	expect(() =>
		rewrite("fn({ isPublic: true, procedure: 'protected', handler })", {
			flags: { isPublic: 'public' }
		})
	).toThrow('conflicts')
})
