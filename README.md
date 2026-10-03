# orpc-fn

Define a backend function once. You get a typed [oRPC](https://orpc.dev) procedure with tracing, structured logging, guards, handler extras from your app, nested calls that keep the context, and optional live queries over Redis. Adapters expose the same procedure as a Mastra tool, an MCP tool, or a route on Hono, and the client helpers call it from Vue, React or Expo.

Your app keeps everything app-specific: auth and session, context shape, database, queues, i18n, feature flags and permissions. You inject them once with `createFn`.

```sh
bun add orpc-fn @orpc/server @orpc/contract zod
```

ESM only, Node 20+ or Bun, TypeScript 5.7+, oRPC 1.14+, Zod 4. Optional peers per subpath are listed below.

## 30 seconds

```ts
// lib/fn.ts — once per app
import { ORPCError, os } from '@orpc/server'
import * as otel from '@opentelemetry/api'
import { createFn } from 'orpc-fn'

const publicProcedure = os.$context<{ headers: Headers; user?: User }>()
const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.user) throw new ORPCError('UNAUTHORIZED')
  return next({ context: { user: context.user } })
})

export const { fn, fnLive, createPubSub, createRouter } = createFn({
  procedures: { public: publicProcedure, protected: protectedProcedure },
  default: 'protected',
  extras: () => ({ db }),
  guards: {
    permission: (required: Permission, { context }) => context.user?.can(required)
  },
  otel
})
```

```ts
// features/orders/get-order.ts
export const getOrder = fn({
  name: 'order.get',
  method: 'GET',
  path: '/orders/{id}',
  permission: 'orders:read',
  input: z.object({ id: z.string() }),
  handler: async ({ input, context, db, call, logger }) => {
    logger.info('loading order', { id: input.id }) // context.user is typed: protected
    const order = await db.order.find(input.id)
    const customer = await call(getCustomer, { id: order.customerId }) // child span, same context
    return { ...order, customer }
  }
})
```

Every call runs in an OpenTelemetry span named `order.get`, runs the `permission` guard, writes `handler_ms` back to `context.timing`, and logs one `fn.completed` line at `info`, `warn` (4xx) or `error` (defects).

## `orpc-fn`: `createFn`

```ts
createFn({
  procedures,      // named oRPC builders; the handler context is the builder's context
  default,         // builder used when a route omits `procedure`
  extras,          // ({ context, span, signal, name, procedure }) => values merged into handler params
  guards,          // { key: (value, { context, input, name, meta, signal }) => void } — each key is a typed fn() option
  meta,            // `{} as { readOnly?: boolean }` — typed fn() options stored on the procedure
  tags,            // ['internal', 'external'] — allowed route tags
  otel,            // `import * as otel from '@opentelemetry/api'`; omit for no tracing
  logger,          // (scope, span) => your logger (debug/info/warn/error)
  spanAttributes,  // ({ context, name, procedure, meta }) => extra span attributes
  onCompleted,     // (event) => extra attributes for the fn.completed log
  isExpectedError, // default: 4xx ORPCError or AbortError
  pubsub           // { transport, onDrop?, maxQueueSize? } for fnLive / createPubSub
})
```

It returns `fn`, `fnLive`, `createPubSub`, `createPublisher`, `createRouter`, `readMeta`, `drainPubSubSubscribers` and `activePubSubSubscriberCount`.

**`fn(options)`** has four overloads (input and output schema, each given or inferred). Route options: `name` (required; operationId and span name), `procedure`, `path`, `method`, `summary`, `description`, `tags`, `deprecated`, `successStatus`, `successDescription`, `inputStructure`, `outputStructure`, every guard key and every meta key. The handler receives `input`, `context`, `call`, `signal`, `span`, `logger` and your extras.

**Guards** run inside the span, before the handler, and only on routes that set their option. Throw (usually an `ORPCError`) to refuse.

**`call(procedure, input)`** calls another procedure with the caller's context and abort signal, inside a `call: <name>` child span. Input and output are typed from the callee.

**Meta** is stored in oRPC's own procedure meta. It survives `os.router()`, prefixes and lazy routers. Read it with `readMeta(procedure)` (typed) or `readFnMeta(procedure)`.

Also exported: `isExpectedClientError`, `createBoundedEventQueue`, `createRouter`, and the types `HandlerParams`, `RouteConfig`, `BoundCall`, `FnMeta`, `FnContext`, `FnCompletedEvent`.

## `orpc-fn/live`: pub/sub and live queries

```ts
import { createFn } from 'orpc-fn'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun' // or ioredis / memory

const transport = bunRedisTransport(new RedisClient(process.env.REDIS_URL))
export const { fnLive, createPubSub, drainPubSubSubscribers } = createFn({
  /* … */,
  pubsub: { transport, onDrop: (count) => dropCounter.add(count) }
})

export const listOrders = fnLive({
  name: 'order.list',
  input: z.object({ organizationId: z.string() }),
  handler: ({ input, db }) => db.order.list(input.organizationId),
  live: {
    eventSchema: z.object({ organizationId: z.string(), orderId: z.string() }),
    channel: ({ organizationId }) => `orders:${organizationId}`,
    coalesceMs: 50
  }
})
// router: { list: listOrders.procedure, subscribe: listOrders.subscribe }
await listOrders.publish({ organizationId, orderId }) // after a write
```

The `subscribe` route streams the initial snapshot, then a new one per event. Options:

- `shouldUpdate` skips an event.
- `transformerFn` folds an event into `previous` instead of re-running the handler. It may return `fnLivePatch(state, emit)` to send a small payload and keep the full state.
- `coalesceMs` batches events that arrive close together.
- `authFn` and `useBacklog`/`backlogSize`/`backlogTtl` work as on `createPubSub`.
- `overflowMarker` is enqueued when a slow subscriber's queue overflows, once per overflow episode, so the client can resync.
- `safePublish` logs publish errors instead of throwing them.

**`createPubSub`** returns a typed `subscribe` route plus `publish`, `publishMany` (one atomic round-trip across channels) and `getChannelName`. Options: `filterFn`, `authFn`, `mirrorChannel`, `overflowMarker`, `procedure`. Each pub/sub definition subscribes to each channel once and parses each payload once for all local subscribers. A lost subscription is retried with exponential backoff and jitter. **`createPublisher`** is the publish-only half.

**Graceful shutdown:** call `drainPubSubSubscribers()` on SIGTERM. Open streams end cleanly and clients reconnect to the new deployment. Draining is per `createFn` instance.

**Transports** implement `PubSubTransport` (`publish(messages, backlog?)`, `readBacklog(channel)`, `subscribe(channel, listener, onLost)`):

| Subpath | Client | Notes |
|---|---|---|
| `orpc-fn/live/redis-bun` | Bun `RedisClient` | Dedicated subscriber via `duplicate()`; re-subscribes after Bun's reconnects |
| `orpc-fn/live/ioredis` | ioredis 5 | Dedicated subscriber via `duplicate()`; ioredis re-subscribes itself |
| `orpc-fn/live/memory` | none | Tests and single-process dev |

The Redis transports publish and maintain backlogs with one Lua script, sent by SHA, with a fallback to `EVAL` when Redis returns `NOSCRIPT`. Call `transport.close()` on shutdown.

`streamLiveSnapshots`, `fnLivePatch` and `throwInitialSnapshotError` are exported for custom streams.

## `orpc-fn/mastra`

Optional peer: `@mastra/core` ^1.51.

```ts
import { createMastraTool } from 'orpc-fn/mastra'

const tool = createMastraTool(getOrder, { requireApproval: true })
// at run time: requestContext.set('orpcContext', context)
```

Options: `id`, `description`, `requireApproval`, `allowMissingInputSchema`, `onExecuteFinish`, `contextKey` (default `'orpcContext'`). The tool keeps the types Mastra's `InferToolInput`/`InferUITools` read. Execution goes through oRPC `call`, so middleware and guards apply.

## `orpc-fn/mcp`

Optional peers: `@orpc/zod`, `@orpc/json-schema`.

```ts
import { hasTag, listTools } from 'orpc-fn/mcp'

for (const { name, procedure, config } of listTools(router, { filter: hasTag('external') })) {
  server.registerTool(name, config, (args) => call(procedure, args, { context }))
}
```

Tool names are the sanitized `fn` names (`user.me` becomes `user-me`). Input schemas carry the same JSON Schema as your OpenAPI docs (dates become `string`/`date-time`), and validation turns them back into `Date`s. `readOnlyHint` defaults to GET routes; pass `readOnly` to change it. `hasTag(tag)` also works as an oRPC `OpenAPIHandler` filter.

## `orpc-fn/hono`

Optional peers: `hono`, `@orpc/openapi`, `@orpc/zod`, `@orpc/json-schema`.

```ts
import { mountOrpc, normalizeExpoOrigin } from 'orpc-fn/hono'

mountOrpc(app, {
  router,
  rpcPrefix: '/rpc',
  openapi: { prefix: '/api', info: { title: 'API', version: '1.0.0' } },
  context: async (c, { headers, timing }) => ({ headers, timing, session: await getSession(headers) }),
  normalizeHeaders: normalizeExpoOrigin,
  onError: (error, request) => errorTracker.capture(error, request)
})
```

Behaviour:

- The response gets a `Server-Timing` header built from `context.timing`: queue, auth and context if you record them, and handler from `fn`.
- SSE responses get keep-alive comments (15 s) and anti-buffering headers.
- RPC calls are batched (`BatchHandlerPlugin`).
- Scalar docs are served at the OpenAPI prefix.
- `onError` sees only unexpected errors.
- `openapi.filter`, `openapi.smartCoercion` and `openapi.spec` (for security schemes) cover an external API with its own auth.
- `context` may return a `Response`, for example a 401.

## `orpc-fn/client`

Optional peer: `@orpc/client`. Has no server code, so it is safe in frontends (Vue, React, Expo).

```ts
import { createORPCClient } from '@orpc/client'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { createRpcLink, hasOrpcErrorCode } from 'orpc-fn/client'
import type { RouterClient } from '@orpc/server'
import type { router } from '@app/backend' // type-only import

const link = createRpcLink({
  url: `${apiOrigin}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: 'include', cache: 'no-store' })
})
export const client: RouterClient<typeof router> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client) // Vue Query or React Query

if (hasOrpcErrorCode(error, 'NOT_FOUND')) { /* … */ }
```

`createRpcLink` takes every `RPCLink` option. It also batches parallel calls into one request, matching `mountOrpc`'s server-side batching (`batch: { maxSize, exclude }`, or `false` to turn it off). A streaming response cannot be batched, and the request doesn't say whether the response will stream, so streaming routes are recognised by name: any path segment containing `subscribe` is sent on its own (`isSubscriptionPath`).

## `orpc-fn/expo`

Optional peer: `@orpc/client`. Expo itself is passed in, not imported.

```ts
import { fetch } from 'expo/fetch'
import { Platform } from 'react-native'
import { createExpoLink } from 'orpc-fn/expo'

const link = createExpoLink({
  url: `${baseUrl}/api/rpc`,
  fetch,
  native: Platform.OS !== 'web',
  getCookie: () => authClient.getCookie(), // Better Auth Expo
  getExpoOrigin,
  headers: () => ({ 'x-orpc-source': 'expo-react' })
})
```

On native, calls go through `expo/fetch`, the only fetch that streams there. The bridge forwards the request body and the abort signal. Without the signal, cancelled subscriptions keep their sockets open, the device's HTTP pool runs out, and later requests hang. Cookies are sent in a header (`credentials: 'omit'`), together with `expo-origin` and `x-skip-oauth-proxy`, the same headers `@better-auth/expo` sends. On the server, `mountOrpc({ normalizeHeaders: normalizeExpoOrigin })` copies `expo-origin` to `origin`. On web, the link uses the platform fetch with cookies. `createExpoFetch` is exported for a custom link.

## Docs

- [Migrating an app from an in-repo `lib/fn`](docs/migration.md)
- [Decisions: what oRPC already ships and why this exists](docs/decisions.md)
- [Releasing](docs/releasing.md)
- [Example: Hono, in-memory pub/sub, two routes and a live query](examples/basic/server.ts)

## License

MIT
