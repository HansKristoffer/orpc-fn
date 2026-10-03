import { expect, test } from 'bun:test'
import { rewrite } from './is-public.ts'

test('rewrites isPublic/isSupport to procedure keys', () => {
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
	expect(rewrite(source)).toBe(
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
	expect(rewrite('isPublic: true', { public: 'open', support: 's' })).toBe(
		"procedure: 'open'"
	)
})
