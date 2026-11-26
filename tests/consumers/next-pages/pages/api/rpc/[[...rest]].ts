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

const BODY_LIMITS: Record<string, number> = {
	'documents.save': 12 * 1024 * 1024
}

const scopes = new WeakMap<IncomingMessage, RequestScope>()
let requests = 0
const unexpected: Array<{ error: unknown; url: string }> = []

const handler = createNodeHandler({
	router: appRouter,
	rpcPrefix: '/api/rpc',
	batch: { maxSize: 20 },
	// Nothing else limits the body once Next's parser is off. A batch has no
	// procedure and gets the default.
	maxBodySize: ({ path }) => BODY_LIMITS[path.join('.')] ?? 1024 * 1024,
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
