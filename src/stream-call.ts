/**
 * Client-context key the `orpc-fn/vue` and `orpc-fn/react` stream helpers set,
 * so `createRpcLink` keeps the call out of a batch without a stream manifest.
 * Shared across package copies.
 */
export const STREAM_CALL: unique symbol = Symbol.for('orpc-fn.streamCall')

/**
 * Pass as the client context of a stream opened by hand:
 * `client.metrics.run(input, { signal, context: streamCall })`.
 */
export const streamCall = { [STREAM_CALL]: true } as const

export const isStreamCall = (context: object) =>
	(context as { [STREAM_CALL]?: unknown })[STREAM_CALL] === true
