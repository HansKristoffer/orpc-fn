import { describe, expect, test } from 'bun:test'
import { queryCacheSerializer } from '../client.js'
import { decodeMessage, encodePayload } from './codec.js'

const value = {
	at: new Date(0),
	big: 12n,
	nan: Number.NaN,
	url: new URL('https://x.test/a'),
	re: /a+/gi,
	tags: new Set(['a', 'b']),
	byId: new Map([['k', { at: new Date(1) }]]),
	list: [1, undefined, { at: new Date(2) }],
	nested: { when: new Date(3) }
}

// Written by orpc-fn on oRPC 1 (StandardRPCJsonSerializer, numeric type tags).
const ORPC_1_PAYLOAD =
	'{"orpc-fn":2,"id":"evt-1","json":{"at":"1970-01-01T00:00:00.000Z","big":"12","nan":null,"url":"https://x.test/a","re":"/a+/gi","tags":["a","b"],"byId":[["k",{"at":"1970-01-01T00:00:00.001Z"}]],"list":[1,null,{"at":"1970-01-01T00:00:00.002Z"}],"nested":{"when":"1970-01-01T00:00:00.003Z"}},"meta":[[1,"at"],[0,"big"],[2,"nan"],[4,"url"],[5,"re"],[6,"tags"],[1,"byId",0,1,"at"],[7,"byId"],[3,"list",1],[1,"list",2,"at"],[1,"nested","when"]]}'

describe('pub/sub payloads across oRPC majors', () => {
	test('reads payloads and backlogs written under oRPC 1', () => {
		expect(decodeMessage(ORPC_1_PAYLOAD)).toEqual({ id: 'evt-1', value })
	})

	test('writes what instances on oRPC 1 read', () => {
		expect(encodePayload(value, 'evt-1')).toBe(ORPC_1_PAYLOAD)
	})

	test('types oRPC 1 lacked use envelope version 3 and round-trip', () => {
		const payload = encodePayload({ limit: Number.POSITIVE_INFINITY }, 'e')
		expect(JSON.parse(payload)['orpc-fn']).toBe(3)
		expect(decodeMessage(payload)).toEqual({
			id: 'e',
			value: { limit: Number.POSITIVE_INFINITY }
		})
	})

	test('payloads without the envelope stay plain JSON', () => {
		expect(decodeMessage('{"n":1}')).toEqual({ id: undefined, value: { n: 1 } })
	})

	test('invalid serialized RegExp throws TypeError', () => {
		expect(() =>
			decodeMessage(
				JSON.stringify({
					'orpc-fn': 2,
					id: 'bad',
					json: { re: 'not-a-regex' },
					meta: [[5, 're']]
				})
			)
		).toThrow(TypeError)
	})
})

describe('queryCacheSerializer', () => {
	test('restores caches persisted under oRPC 1', () => {
		const persisted = JSON.stringify({
			json: { at: '1970-01-01T00:00:00.000Z', ids: [1, 2] },
			meta: [
				[1, 'at'],
				[6, 'ids']
			]
		})
		expect(queryCacheSerializer.deserialize<unknown>(persisted)).toEqual({
			at: new Date(0),
			ids: new Set([1, 2])
		})
	})

	test('round-trips', () => {
		const data = { at: new Date(5), byId: new Map([['a', 1n]]) }
		expect(
			queryCacheSerializer.deserialize<typeof data>(
				queryCacheSerializer.serialize(data)
			)
		).toEqual(data)
	})
})
