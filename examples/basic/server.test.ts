import { expect, test } from 'bun:test'
import server from './server.js'

const request = (path: string, init?: RequestInit) =>
	server.fetch(new Request(`http://localhost${path}`, init))

test('example: public route, auth, nested call and live stream', async () => {
	expect(await (await request('/api/health')).json()).toEqual({ ok: true })
	expect((await request('/api/todos/a')).status).toBe(401)

	const auth = { 'x-user-id': 'u1', 'content-type': 'application/json' }
	const added = await request('/api/todos/a', {
		method: 'POST',
		headers: auth,
		body: JSON.stringify({ title: 'Write docs' })
	})
	const body = (await added.json()) as { items: { title: string }[] }
	expect(body.items.map((item) => item.title)).toEqual(['Write docs'])
})
