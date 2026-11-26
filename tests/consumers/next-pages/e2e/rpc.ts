// What Playwright helpers do with the wire format: answer a mocked call or
// batch, and call a procedure with `page.request`. No server import.
import { ORPCError } from '@orpc/client'
import {
	decodeRpcBatchRequest,
	decodeRpcBatchResponse,
	decodeRpcRequest,
	decodeRpcResponse,
	encodeRpcBatchRequest,
	encodeRpcBatchResponse,
	encodeRpcRequest,
	encodeRpcResponse,
	type RpcBatchCall,
	type RpcBatchResult
} from 'orpc-fn/client'
import type { Equal, Expect } from '../types'

type Fulfilment = { status: number; contentType: string; body: string }

export const rpcUrl = (name: string) => `/api/rpc/${name.split('.').join('/')}`

export function fulfilRpc(output: unknown, status = 200): Fulfilment {
	const body: string = encodeRpcResponse(output)
	return { status, contentType: 'application/json', body }
}

export const conflict = fulfilRpc(new ORPCError('CONFLICT'), 409)

export function fulfilRpcBatch(
	requestBody: string | null,
	answer: (call: RpcBatchCall) => unknown
): Fulfilment {
	const calls = decodeRpcBatchRequest(requestBody)
	type _Calls = Expect<
		Equal<typeof calls, { id: string; url: string; input: unknown }[]>
	>
	return {
		status: 207,
		contentType: 'application/json',
		body: encodeRpcBatchResponse(
			calls.map((call) => ({ id: call.id, output: answer(call) }))
		)
	}
}

export async function callRpc(name: string, input: unknown): Promise<unknown> {
	const response = await fetch(rpcUrl(name), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: encodeRpcRequest(input)
	})
	const output = decodeRpcResponse(await response.text())
	type _Output = Expect<Equal<typeof output, unknown>>
	return output
}

export async function callRpcBatch(
	calls: { name: string; input?: unknown }[]
): Promise<RpcBatchResult[]> {
	const [first] = calls
	if (!first) return []
	const response = await fetch(`${rpcUrl(first.name)}/__batch__`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'orpc-batch': 'buffered' },
		body: encodeRpcBatchRequest(
			calls.map(({ name, input }) => ({ url: rpcUrl(name), input }))
		)
	})
	return decodeRpcBatchResponse(await response.json())
}

export const readInput = (requestBody: string | null): unknown =>
	decodeRpcRequest(requestBody)

// @ts-expect-error a batch result is addressed by its call's id
encodeRpcBatchResponse([{ output: 1 }])
