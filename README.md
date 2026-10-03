# orpc-fn

Define a backend function once. You get a typed [oRPC](https://orpc.dev) procedure with tracing, structured logging, guards, handler extras from your app, nested calls that keep the context, and optional live queries over Redis. Adapters expose the same procedure as a Mastra tool, an MCP tool, or a route on Hono, and the client helpers call it from Vue, React or Expo.

Your app keeps everything app-specific: auth and session, context shape, database, queues, i18n, feature flags and permissions. You inject them once with `createFn`.

```sh
bun add orpc-fn @orpc/server @orpc/contract @orpc/client zod
```

ESM only, Node 20+ or Bun, TypeScript 5.7+, oRPC 1.14+ (`@orpc/client` is already a dependency of `@orpc/server`), Zod 4. Optional peers per subpath are listed below.

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
    permission: (required: Permission, { context }) => context.user?.can(required) ?? false
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

Every call runs in an OpenTelemetry span named `order.get` (for a streaming handler, until the stream ends), runs the `permission` guard, observes input/output validation, and logs one `fn.completed` line at `info`, `warn` (4xx) or `error` (defects).

## `orpc-fn`: `createFn`

```ts
createFn({
  procedures,      // named oRPC builders; the handler context is the builder's context
  default,         // builder used when a route omits `procedure`; leave out to require `procedure` on every route
  extras,          // ({ context, span, signal, name, procedure }) => values (or a promise) merged into handler params
  extrasByProcedure, // e.g. { protected: ({ context }) => ({ t: translator(context.user) }) }
  guards,          // { key: (value, params) => void | boolean | Promise<void | boolean> } — each key is a typed fn() option
  meta,            // defineMeta<AppMeta>() — allowed values of each route's meta object
  tags,            // ['internal', 'external'] — allowed route tags
  otel,            // `import * as otel from '@opentelemetry/api'`; omit for no tracing
  logger,          // (scope, span) => your logger (debug/info/warn/error)
  spanAttributes,  // ({ context, name, procedure, meta }) => extra span attributes
  onCompleted,     // (event) => extra attributes for the fn.completed log
  isExpectedError, // default: 4xx ORPCError or AbortError
  pubsub           // { transport (or () => transport, created on first use), namespace?, ownsTransport?, maxQueueSize?, maxIngressSize?, maxReplaySize?, initializationTimeoutMs?, onDrop?, onMetric? } for fnLive / createPubSub
})
```

It returns `fn`, `fnLive`, `createPubSub`, `createPublisher`, `createRouter`, `readMeta`, `createCall`, `shutdown`, `drainPubSubSubscribers` and `activePubSubSubscriberCount`.

Procedure builders must not set an input or output schema (`os.input(...)`); put schemas on routes. Guard keys cannot reuse route option names. Application metadata lives in a typed `meta` object and may share names with guards or route options. Unknown top-level route options and extras that shadow built-in handler params are rejected. Scoped extras replace matching shared keys, with handler types reflecting that precedence.

**`fn(options)`** has four overloads (input and output schema, each given or inferred). Route options: `name` (required; operationId and span name), `procedure`, `path`, `method`, `summary`, `description`, `tags`, `deprecated`, `successStatus`, `successDescription`, `inputStructure`, `outputStructure`, configured guard keys, `guardResolvers`, `meta`, `stream` and native `errors` declarations. Core schemas use Standard Schema; Zod 4 remains the default for tool/live adapters. The handler receives `input`, `context`, `call`, `signal`, `span`, `logger`, native typed `errors`, `lastEventId` and your extras. With an output schema, the handler returns the schema's input type and callers receive its output type, so `output: z.string().transform(Number)` means the handler returns a string and callers get a number.

**Guards** run inside the span, before the handler, and only on routes that set their option. Return `false` or throw an `ORPCError` to refuse; `true` and `undefined` allow. Static guards run sequentially in route declaration order, followed by resolved guards in resolver order. Unsupported return values fail types and runtime. For input-dependent checks use `guardResolvers: { permission: ({ input, context }) => requirement }`; these see parsed input. A guard cannot set both a static value and a resolver.

**`call(procedure, input)`** calls another procedure with the caller's context and abort signal, inside a `call: <name>` child span. Input and output are typed from the callee. Calling a procedure whose context the caller's context does not satisfy is a type error. Outside a handler (seeders, scripts, tests), use `createCall(context, signal?)` from `createFn`.

**Meta** is stored in oRPC's own procedure meta. It survives `os.router()`, prefixes and lazy routers. Declare the contract with `defineMeta<AppMeta>()` (no runtime defaults), then use `fn({ meta: { readOnly: true }, ... })`. Both `readMeta(procedure)` and `readFnMeta(procedure)` infer metadata from the passed procedure, including procedures from another factory.

Completion hooks discriminate by `procedure` and `handlerStarted`. Before handler context exists (auth/input failure), they receive the initial context. Logging, tracing, metrics and completion-hook failures preserve procedure results. Custom log fields cannot overwrite canonical completion fields. Stream completion runs once when the stream ends.

Also exported: `defineMeta`, `createStreamManifest`, `createStreamManifestAsync`, `renderStreamManifest`, `isExpectedClientError`, `createBoundedEventQueue`, `createRouter`, `createBoundCall`, and the types `HandlerParams`, `RouteConfig`, `BoundCall`, `FnMeta`, `FnContext`, `FnCompletedEvent`, `ProcedureInput`, `ProcedureOutput`, `ProcedureContext`, `InitialContextOf`, `CurrentContextOf` and `GuardOptions`.

## `orpc-fn/live`: pub/sub and live queries

```ts
import { createFn } from 'orpc-fn'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun' // or ioredis / memory

export const { fnLive, createPubSub, drainPubSubSubscribers } = createFn({
  /* … */,
  pubsub: {
    // A function defers the connection until the first publish or subscribe.
    transport: () => bunRedisTransport(new RedisClient(process.env.REDIS_URL)),
    ownsTransport: true,
    onDrop: (count) => dropCounter.add(count)
  }
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

The `subscribe` route runs builder middleware and the same fn guards/extras/meta/completion policy, then `authFn` and subscribes to the channel, then streams the initial snapshot, then reloads when invalidated (once per coalescing batch). Queue bounds (`maxQueueSize`, `maxIngressSize`, `maxReplaySize`) can be overridden per pub/sub definition or live config. `maxBatchSize` bounds a live coalescing batch (default 1000). `pubsub.onMetric` reports typed queue depths, drops, successful reconnects and parsing failures; keep this synchronous callback fast. Startup waits for a successful broker subscription, bounded by `initializationTimeoutMs` (10000ms by default) and cancellation. A refused subscriber receives nothing, and events published while the snapshot loads are not lost. Snapshots go through the output schema, like the route's own result. Options:

- `shouldUpdate` skips an event.
- `transformerFn` folds an event into initialized `previous`. It requires a `stateSchema` that validates parsed state. Patches returned by `fnLivePatch(state, emit)` additionally require `emitSchema`. These schemas should not transform already-parsed values. `rerun()` rechecks the current input through the procedure; it cannot change subscriber input.
- `coalesceMs` performs one rerun for an invalidation batch. Reducers process every event but emit their final full state; ordered patch payloads remain ordered. Batches are bounded (1000 events by default in `streamLiveSnapshots`).
- `authFn` and `useBacklog`/`backlogSize`/`backlogTtl` work as on `createPubSub`.
- Live queries reload a full snapshot after overflow or reconnect. Raw pub/sub streams fail with `SERVICE_UNAVAILABLE` after detected loss, or emit an application-provided `overflowMarker` that must trigger recovery.
- `reauthorize` can check access before each live update. Initial authorization covers idle streams; apps that need immediate revocation should close those streams.
- `safePublish` logs publish errors instead of throwing them; it does not retry or guarantee delivery.

**`createPubSub`** returns a typed `subscribe` route plus `publish`, `publishMany` (one atomic round-trip across channels) and typed `getSubscriptionChannelName({ input, context })` / `getPublishChannelName(event)` methods. The shared partial-input `getChannelName` method is deprecated. Publishers pass the event schema's input type; subscribers, filters and channel resolvers get its output type. The raw event travels in oRPC's JSON format, so `Date`, `Map`, `Set` and `BigInt` survive, and each receiver parses it once. Options include `filterFn`, `authFn`, `mirrorChannel`, `overflowMarker`, `procedure`, configured guards and `meta`. Channels may be static or use `channel: { subscribe: ({ input, context }) => key, publish: (parsedEvent) => key }`. Carry publishing tenant keys in the event. A factory `namespace` prefixes channels, mirrors and backlog keys. Each pub/sub definition subscribes to each channel once and parses each payload once for all local subscribers. Each subscriber then runs its filter in arrival order as it reads; its bounded queue holds events before filtering, so `onDrop` counts unfiltered events. Abort and drain release a subscription at once, even one that is not being read. A lost subscription is retried with exponential backoff and jitter. **`createPublisher`** is the publish-only half.

**Graceful shutdown:** `await shutdown()` stops new subscriptions/publication, cancels initialization/retries, ends existing streams and awaits cleanup. It closes a supplied transport only with `ownsTransport: true`, and a lazy `transport: () => …` only if it was ever created; it is never created during or after shutdown. A custom transport whose pending `subscribe` cannot be cancelled may resolve later; that late subscription is immediately released. `drainPubSubSubscribers()` remains a synchronous, nonterminal operation. Both are per factory.

Recent event IDs deduplicate replay/live overlap; legacy payloads remain readable. Replay is bounded and TTL-limited, so it is not durable resume. A snapshot may already include a queued delta: reducers must use revisions or idempotence. See [the revision example](examples/adoption/revisions.ts). Parsing ingress, replay staging and subscriber queues are bounded; positive queue/TTL/time options are validated.

**Transports** implement `PubSubTransport` (`publish(messages, backlog?)`, `readBacklog(channel)`, `subscribe(channel, listener, onLost, { onReconnect }?)`):

| Subpath | Client | Notes |
|---|---|---|
| `orpc-fn/live/redis-bun` | Bun `RedisClient` | Dedicated subscriber via `duplicate()`; re-subscribes after Bun's reconnects |
| `orpc-fn/live/ioredis` | ioredis 5 | Dedicated subscriber via `duplicate()`; ioredis re-subscribes itself |
| `orpc-fn/live/memory` | none | Tests and single-process dev |

A subscriber connection that is lost, or cannot restore its channels after a reconnect, is closed and replaced; nothing it still emits is delivered. The Redis transports publish and maintain backlogs with one Lua script, sent by SHA, with a fallback to `EVAL` when Redis returns `NOSCRIPT`. Await `transport.close()` when the app owns its lifecycle. The Redis Lua batching adapter supports standalone Redis; Redis Cluster requires compatible key slots and is not promised by this adapter.

`streamLiveSnapshots`, `fnLivePatch` and `throwInitialSnapshotError` are exported for custom streams.

## `orpc-fn/mastra`

Optional peers: `@mastra/core` ^1.51, `@orpc/zod`, `@orpc/json-schema`.

```ts
import { createMastraTool } from 'orpc-fn/mastra'

const tool = createMastraTool(getOrder, { requireApproval: true })
// at run time: requestContext.set('orpcContext', context)
```

Options: `id`, `description`, `requireApproval`, `allowMissingInputSchema`, `onExecuteFinish`, `contextKey` (default `'orpcContext'`). Execution goes through oRPC `call`, so middleware and guards apply.

The tool takes the procedure's raw input and returns its parsed output, and `InferToolInput`/`InferToolOutput`/`InferUITools` see exactly those types. Mastra validates the input (coercing date strings) but passes the raw value on, and the procedure parses that raw value: transforms/refinements must be pure: SDK validation and procedure execution may run them more than once, always on raw input. Agent tools accept objects and unions of object shapes. Other inputs and streams are rejected. Finish-hook failures preserve execution outcomes.

## `orpc-fn/mcp`

Optional peers: `@orpc/zod`, `@orpc/json-schema`.

Inspection definitions from `listTools` use Standard Schema and are not `McpServer.registerTool` configs. Executable registration is a separate optional entry point, with SDK `@modelcontextprotocol/sdk` ^1.32.0:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { hasTag } from 'orpc-fn/mcp'
import { registerMcpTools } from 'orpc-fn/mcp/sdk'

const server = new Server({ name: 'api', version: '1.0.0' }, { capabilities: { tools: {} } })
registerMcpTools(server, router, {
  filter: hasTag('external'),
  context: ({ signal }) => authenticateToolRequest(signal)
})
// Connect your SDK transport; see examples/adoption/mcp.ts.
```

The adapter installs the SDK list/call handlers on a low-level `Server` (also accessible as `McpServer.server`). Use one registration per server; these handlers own its tool list. It forwards cancellation, validates/coerces arguments, applies procedure authorization, and formats results as JSON/text MCP content. Override `formatResult` for images, structured content or other presentation. Tool selection is required. Object unions are supported; streams are rejected. Resolve lazy routers first with oRPC's `unlazyRouter`.

Sanitized tool-name collisions between distinct procedures throw; identical aliases are deduplicated. Override `name` to resolve deliberate collisions. Tool names are the sanitized `fn` names (`user.me` becomes `user-me`). Input schemas carry the same JSON Schema as your OpenAPI docs (dates become `string`/`date-time`), and validation turns them back into `Date`s. Validation returns the raw arguments, and `call(procedure, args, { context })` parses those: transforms/refinements must be pure: SDK validation and procedure execution may run them more than once, always on raw input. `readOnlyHint` defaults to GET routes; pass `readOnly` to change it. `hasTag(tag)` also works as an oRPC `OpenAPIHandler` filter.

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

- The response gets a `Server-Timing` header built from the request timing collector: app-recorded queue/auth/context metrics plus library-owned procedure time. Nested calls do not overwrite parent timing; batches aggregate their top-level procedure durations (which may overlap). `fn` does not mutate an arbitrary `context.timing` field. `formatServerTiming` and `finishOrpcHeaders` are available for composed Fetch adapters.
- SSE responses get keep-alive comments (15 s) and anti-buffering headers.
- RPC calls are batched (`BatchHandlerPlugin`).
- Scalar docs are served at the OpenAPI prefix.
- `onError` sees only unexpected errors.
- `openapi.filter`, `openapi.smartCoercion` and `openapi.spec` (for security schemes) cover an external API with its own auth.
- `context` builds the router's context and is checked against it: it is required when `{ headers, timing }` alone does not satisfy the router. It may return a `Response`, for example a 401.

## `orpc-fn/client`

Has no server code, so it is safe in frontends (Vue, React, Expo).

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

`createRpcLink` takes every `RPCLink` option. It also batches parallel calls into one request, matching `mountOrpc`'s server-side batching (`batch: { maxSize, exclude, groups }`, or `false` to turn it off). A batch is one request with one client context, so by default only calls without a client context are batched; pass `groups` to batch calls that share one. A streaming response cannot be batched, and the request doesn't say whether the response will stream, so pass `streamPaths` generated from the actual router with `createStreamManifest` (or `createStreamManifestAsync` for lazy routers). Serialize it to a frontend module; importing that data needs no server runtime. The `orpc-fn` CLI does that, resolving lazy routers, sorting paths and writing only on change:

```sh
orpc-fn stream-manifest src/router.ts#appRouter --out ../web/src/stream-paths.ts          # export const streamPaths = [...]
orpc-fn stream-manifest src/router.ts#appRouter --out ../web/src/stream-paths.ts --check  # CI: exit 1 when stale
```

`--out x.json` writes JSON instead, and `--name` renames the export. The CLI imports the router, so that module's side effects (database clients, SDKs) still run; it exits when done rather than waiting on their open handles. Run TypeScript routers with `bun`, `tsx` or Node ≥ 22.18. Mark custom iterator routes with `stream: true` or use oRPC's `eventIterator` output schema. Generated live/pubsub routes are marked automatically. `batch.exclude` remains an escape hatch, and the legacy `subscribe` naming heuristic remains as a fallback.

## `orpc-fn/expo`

Expo itself is passed in, not imported. The fetch must resolve to a response with the members oRPC reads (`expo/fetch` does).

```ts
import { fetch } from 'expo/fetch'
import { Platform } from 'react-native'
import { createBetterAuthExpoLink } from 'orpc-fn/expo'

const link = createBetterAuthExpoLink({
  url: `${baseUrl}/api/rpc`,
  fetch,
  native: Platform.OS !== 'web',
  getCookie: () => authClient.getCookie(), // Better Auth Expo
  getExpoOrigin,
  headers: () => ({ 'x-orpc-source': 'expo-react' })
})
```

On native, calls go through `expo/fetch`, the only fetch that streams there. The bridge forwards the request body and the abort signal. Without the signal, cancelled subscriptions keep their sockets open, the device's HTTP pool runs out, and later requests hang. Cookies are sent in a header (`credentials: 'omit'`), together with `expo-origin` and `x-skip-oauth-proxy`, the same headers `@better-auth/expo` sends. On the server, `mountOrpc({ normalizeHeaders: normalizeExpoOrigin })` copies `expo-origin` to `origin`. The generic `createExpoLink` forwards upstream headers (including async/context-aware resolvers) and adds no provider-specific headers. `createBetterAuthExpoLink` supplies the cookie/origin preset above. On web, the link uses the platform fetch with cookies, or your explicit `webFetch` override. `createExpoFetch` is exported for a custom link.

## Docs

- [Migrating an app from an in-repo `lib/fn`](docs/migration.md)
- [Decisions: what oRPC already ships and why this exists](docs/decisions.md)
- [Releasing](docs/releasing.md)
- [Independent core, tenant, revision, MCP and Expo examples](examples/adoption/README.md)
- [Example: Hono, in-memory pub/sub, two routes and a live query](examples/basic/server.ts)

## License

MIT
