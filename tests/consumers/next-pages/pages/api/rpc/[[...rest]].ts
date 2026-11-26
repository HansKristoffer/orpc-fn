// The one RPC route of a Next.js 16 Pages Router app.
import type { IncomingMessage } from 'node:http'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createNodeHandler } from 'orpc-fn/node'
import {
	appRouter,
	type RequestScope,
	requestStorage
} from '../../../server/rpc'

export const config = { api: { bodyParser: false, responseLimit: false } }

const scopes = new WeakMap<IncomingMessage, RequestScope>()
let requests = 0
const unexpected: Array<{ error: unknown; url: string }> = []

const handler = createNodeHandler({
	router: appRouter,
	rpcPrefix: '/api/rpc',
	batch: { maxSize: 20 },
	errorStatusMap: { BAD_GATEWAY: 502 },
	context: (req, base) => {
		const scope = scopes.get(req)
		if (!scope) throw new Error('no request scope')
		return { ...base, scope }
	},
	onError: (error, request) => {
		unexpected.push({ error, url: request.url })
	}
})

export default function rpc(req: NextApiRequest, res: NextApiResponse) {
	scopes.set(req, { user: async () => ({ uid: 'u1' }) })
	return requestStorage.run({ requestId: ++requests }, () => handler(req, res))
}
