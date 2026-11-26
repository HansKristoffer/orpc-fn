# orpc-fn

Define a backend function once. You get a typed [oRPC](https://orpc.dev) procedure with tracing, structured logging, guards, handler extras from your app, nested calls that keep the context, and optional live queries over Redis. Adapters expose the same procedure as a Mastra tool, an MCP tool, or an HTTP route (any Fetch runtime, Node `http` or Hono), and the client helpers call it from Vue, React or Expo.

Your app keeps everything app-specific: auth and session, context shape, database, queues, i18n, feature flags and permissions. You inject them once with `createFn`.

```sh
bun add orpc-fn @orpc/server @orpc/contract @orpc/client zod
```

ESM only, Node 20+ or Bun, oRPC 2 (`^2.0.0-beta.53`; `@orpc/client` is already a dependency of `@orpc/server`), Zod 4 or 3.25 ([which subpaths need Zod 4 schemas](#zod-325)). TypeScript 5.7+. Optional peers per subpath are listed below. orpc-fn 0.10 was the last release for oRPC 1.

### Upgrading from oRPC 1 (orpc-fn 0.10 or older)

What changes in app code, beyond the oRPC 2 changelog:

- **Live updates and guards.** orpc-fn 0.9.2 to 0.11.0 ran a `fnLive` route's guards only when its stream opened. They run again before every update now, as in 0.9.1 ([live queries](#orpc-fnlive-pubsub-and-live-queries)); drop any wrapper that re-ran them through `live.reauthorize`.
- **Links.** `url` is the path and the host goes in `origin` (a full URL in `url` throws, naming the split). A browser app on its API's origin passes only `url: '/api/rpc'`: the link fetches the path and the browser resolves it against the page. A custom `fetch` is called as `fetch(url, init)` with a string, not `fetch(request, init)`. `clientInterceptors` is `transportInterceptors`, on `createRpcLink`, `createExpoLink` and `createBetterAuthExpoLink` too; the batch plugin appends its own interceptor, so an app's stays outermost.
- **Procedure types.** `Procedure` and `DecoratedProcedure` take five type parameters (meta is gone), and procedure meta values are `unknown`. Read a route through `readFnMeta(procedure)` / `readMeta(procedure)` instead of `~orpc`: `~orpc.inputSchema` is `inputSchemas[]` and `~orpc.route` is `@orpc/openapi`'s `getOpenAPIMeta`. `walkProcedures(router, (procedure, path) => …)` replaces `traverseContractProcedures` plus `isProcedure`, and `withFnMeta(route, meta)` gives a test a route with other app meta.
- **Query keys** hold the serialized input (`{ input, inputMeta }`) and may start with a `prefix`; read a key's path with `operationPath(key)` from `orpc-fn/client`. oRPC's query options no longer fit vue-query's plain `UseQueryOptions<T, E>`; see [`orpc-fn/vue`](#orpc-fnvue).
- **Errors** carry no `status`. Map your own codes with the HTTP adapters' `errorStatusMap`; codes oRPC does not know answer 400, not 500, so they count as expected client errors. Read a status with `errorStatusOf` on the server and `responseStatusOf` on the client. To also treat hanzio's `ApiError` as expected: `createFn({ isExpectedError: (error) => isExpectedClientError(error) || isApiError(error) })`.
- **HTTP adapters.** A filter is oRPC's `(procedure, path) => boolean`, and `openapi.filter` is required. Document fields go in `openapi.spec.base` (`{ base: { components: { securitySchemes }, security } }`). CORS outside Hono is oRPC's `CORSHandlerPlugin` (its default `origin` is `*`); allow the headers the links send with `CLIENT_REQUEST_HEADERS`, which includes the batch header, now `orpc-batch` (oRPC 1 sent `x-orpc-batch`).
- **Vue Query options** that oRPC's `queryOptions` does not take, such as `shallow: true`, go beside it: `({ ...o.x.get.queryOptions({ input }), shallow: true })`.
- **Tool schemas** keep Zod's string limits, which oRPC 1's converter dropped; see [`orpc-fn/mastra`](#orpc-fnmastra).

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
  isExpectedError, // default: ORPCError oRPC answers with a 4xx, or AbortError
  errorMessages,   // 'all' (default) | 'unexpected': leave expected errors' text out of fn.completed
  routePolicy,     // ({ name, procedure, guards, dynamicGuards, meta, stream, tags }) => void; throw to reject a route
  pubsub           // { transport (or () => transport, created on first use), namespace?, ownsTransport?, safePublish?, maxStreamAgeMs?, maxQueueSize?, maxIngressSize?, maxReplaySize?, initializationTimeoutMs?, onDrop?, onMetric? } for fnLive / createPubSub
})
```

It returns `fn`, `fnLive`, `fnLivePatch`, `createPubSub`, `createPublisher`, `createRouter`, `readMeta`, `createCall`, `createTestCall`, `shutdown`, `drainPubSubSubscribers` and `activePubSubSubscriberCount`.

Procedure builders must not set an input or output schema (`os.input(...)`); put schemas on routes. Guard keys cannot reuse route option names. Application metadata lives in a typed `meta` object and may share names with guards or route options. Unknown top-level route options and extras that shadow built-in handler params are rejected. Scoped extras replace matching shared keys, with handler types reflecting that precedence.

**`fn(options)`** has four overloads (input and output schema, each given or inferred). Route options: `name` (required; operationId and span name), `procedure`, `path`, `method`, `summary`, `description`, `tags`, `deprecated`, `successStatus`, `successDescription`, `inputStructure`, `outputStructure`, configured guard keys, `guardResolvers`, `meta`, `stream` and native `errors` declarations. Core schemas use Standard Schema; the live and tool adapters read Zod 4 schemas ([Zod 3.25](#zod-325)). The handler receives `input`, `context`, `call`, `signal`, `span`, `logger`, native typed `errors`, `lastEventId` and your extras. With an output schema, the handler returns the schema's input type and callers receive its output type, so `output: z.string().transform(Number)` means the handler returns a string and callers get a number.

**Guards** run inside the span, before the handler, and only on routes that set their option. A route's guard values are stored in its meta: `readMeta(route).guards` returns them typed (`{ permission: 'deal.read' }`) and `dynamicGuards` names the ones a resolver decides, so a tool list or an audit reads the route's own declaration. To require a decision on every route, reject the rest at definition with `routePolicy`:

```ts
createFn({
  guards: { permission },
  routePolicy: ({ name, procedure, guards, dynamicGuards }) => {
    if (procedure === 'protected' && !('permission' in guards) && !dynamicGuards.includes('permission'))
      throw new Error(`${name}: declare permission (or permission: 'authenticated')`)
  }
})
```

It sees every route kind: `fn`, both `fnLive` routes and pub/sub subscriptions. Return `false` or throw an `ORPCError` to refuse; `true` and `undefined` allow. Static guards run sequentially in route declaration order, followed by resolved guards in resolver order. Unsupported return values fail types and runtime. For input-dependent checks use `guardResolvers: { permission: ({ input, context }) => requirement }`; these see parsed input. A guard cannot set both a static value and a resolver.

**`call(procedure, input)`** calls another procedure with the caller's context and abort signal, inside a `call: <name>` child span. Input and output are typed from the callee. Calling a procedure whose context the caller's context does not satisfy is a type error. Outside a handler (seeders, scripts, tests), use `createCall(context, signal?)` from `createFn`. A test calls a real route with `createTestCall(context, { extras: { db: fakeDb } })`: middleware, guards and schemas run as in production, and the given extras replace the configured ones for that call and the calls it makes. Mocking `fn` to return its options skips all of that.

**Meta** is stored in oRPC's own procedure meta. It survives `os.router()`, `.meta(openapi({ prefix }))` on a router and lazy routers. The OpenAPI route options (`path`, `method`, `summary`, `tags`, …) and `name` as `operationId` are oRPC's OpenAPI meta, the same `getOpenAPIMeta(route)` from `@orpc/openapi` reads, and tags a builder sets with `.meta(openapi({ tags }))` come first. Declare the contract with `defineMeta<AppMeta>()` (no runtime defaults), then use `fn({ meta: { readOnly: true }, ... })`. Both `readMeta(procedure)` and `readFnMeta(procedure)` infer metadata from the passed procedure, including procedures from another factory.

**Errors.** `fn.completed` carries `error_type`, `error_code` (an `ORPCError`'s code) and `error_message`. An error `isExpectedError` accepts logs at `warn`, and its span keeps an unset status with no exception event, as OpenTelemetry asks of server spans; `fn.error_code` names it. Its message was written for the caller and may name what they asked for, so `errorMessages: 'unexpected'` leaves it out of the log too. `mountOrpc` and the tool adapters treat errors this factory classified as expected the same way without being told again. To turn the app's own error classes into `ORPCError`s, put one middleware on the base builder rather than a mapper in every route. oRPC 2 errors carry no status: by default an `ORPCError` is expected when oRPC answers its code with a 4xx (its common map, and 400 for codes it does not know). Map your own codes with the HTTP adapters' `errorStatusMap`, and pass `isExpectedError` here when a code of yours is a defect. `errorStatusOf(error, errorStatusMap?)` returns the status a handler answers an error with (500 for anything but an `ORPCError`).

Completion hooks discriminate by `procedure` and `handlerStarted`. Before handler context exists (auth/input failure), they receive the initial context. Logging, tracing, metrics and completion-hook failures preserve procedure results. Custom log fields cannot overwrite canonical completion fields. Stream completion runs once when the stream ends.

`walkProcedures(router, (procedure, path) => …)` calls back with every procedure in a router (contract-only entries skipped), for a tool catalog or a route audit; resolve lazy routers first with oRPC's `unlazyRouter`. `withFnMeta(route, meta)` returns a copy of a `fn()` route with `meta` merged over its app meta, typed by the factory's `meta`, and leaves the route alone, e.g. for a test that needs another approval rule.

Also exported: `defineMeta`, `createStreamManifest`, `createStreamManifestAsync`, `renderStreamManifest`, `walkProcedures`, `withFnMeta`, `isExpectedClientError`, `errorStatusOf`, `createRouter`, `createBoundCall`, and the types `HandlerParams`, `RouteConfig`, `BoundCall`, `FnMeta`, `FnContext`, `FnCompletedEvent`, `ProcedureInput`, `ProcedureOutput`, `ProcedureContext`, `InitialContextOf`, `CurrentContextOf` and `GuardOptions`.

### Zod 3.25

`zod@3.25` ships Zod 4 as `zod/v4` next to Zod 3 at `zod`, and both implement Standard Schema. The floor is 3.25.3, because 3.25.0 and 3.25.2 publish a broken `zod/v4` entry. Core routes (`fn`), the HTTP adapters' RPC handler and the client subpaths take either, so a Zod 3 codebase keeps its schemas. These read Zod 4 schemas, which on 3.25 you import from `zod/v4`:

- `fnLive`, `createPubSub`, `defineScopedChangeBus` and `orpc-fn/live` (event, state and input schemas);
- `orpc-fn/mastra` and `orpc-fn/mcp` (JSON Schema through `@orpc/zod`, which needs `zod` 4.5 or later installed);
- the `openapi` mount's spec, docs and `smartCoercion`, and `orpc-fn/openapi` (also through `@orpc/zod`): a Zod 3 schema still validates, but appears untyped in the spec, and `components` must be Zod 4 schemas;
- `orpc-fn/cli`, whose `hanzio/cli` types read `zod` itself, so it needs `zod` 4 installed. The `orpc-fn` bin runs on 3.25 (pnpm warns that `hanzio` asks for `zod` ^4.3.6).

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

- `shouldUpdate` skips an event. It, `transformerFn` and `reauthorize` receive the same `context` object for every event of one subscription, so a `WeakMap` keyed on it holds per-subscription state.
- `transformerFn` folds an event into initialized `previous`. It requires a `stateSchema` that validates parsed state. Patches returned by `fnLivePatch(state, emit)` additionally require `emitSchema`. These schemas should not transform already-parsed values. `rerun()` rechecks the current input through the procedure; it cannot change subscriber input.
- Without a transformer, a rerun whose snapshot serializes the same as the last one sent is not sent again (`skipUnchanged: false` sends it anyway).
- `coalesceMs` performs one rerun for an invalidation batch. Reducers process every event but emit their final full state; ordered patch payloads remain ordered. Batches are bounded (1000 events by default in `streamLiveSnapshots`).
- `authFn` and `useBacklog`/`backlogSize`/`backlogTtl` work as on `createPubSub`.
- Live queries reload a full snapshot after overflow or reconnect. Raw pub/sub streams fail with `SERVICE_UNAVAILABLE` after detected loss, or emit an application-provided `overflowMarker` that must trigger recovery.
- The route's guards (static values and `guardResolvers`) run again before each live update, rerun or folded, so a permission or feature flag removed mid-stream ends the stream with the guard's error instead of sending the next snapshot. orpc-fn 0.9.1 did this by rerunning the whole procedure; 0.9.2 to 0.11.0 ran guards only when the stream opened. `rerunGuards: false` keeps the opening authorization for a route whose guards are costly. Middleware, input parsing and extras still run once per stream.
- `reauthorize` adds an access check of its own before each live update, after the guards. Initial authorization covers idle streams; `pubsub.maxStreamAgeMs` ends every route stream after that age (plus up to 10% jitter), and the client helpers reconnect with a freshly built context.
- `safePublish` logs publish errors at `warn` instead of throwing them; it does not retry or guarantee delivery. `pubsub.safePublish` sets the default for every definition.
- A route that only publishes needs no `createPublisher` beside it: `fnLive` returns `publish`.

**`createPubSub`** returns a typed `subscribe` route plus `publish`, `publishMany` (one atomic round-trip across channels) and typed `getSubscriptionChannelName({ input, context })` / `getPublishChannelName(event)` methods. `authFn` is required: return false to refuse with FORBIDDEN, or pass `true` to say that anyone who passes the procedure builder may subscribe. It receives `{ input, context }` (`ctx` is a deprecated alias). The server reads a bus without its route: `for await (const event of await bus.listen(input, { signal }))` resolves once subscribed and skips guards and `authFn`, and `await bus.readBacklog(event)` returns the parsed backlog of the channel an event goes to. Publishers pass the event schema's input type; subscribers, filters and channel resolvers get its output type. The raw event travels in oRPC's JSON format, so `Date`, `Map`, `Set` and `BigInt` survive, and each receiver parses it once. Options include `filterFn`, `authFn`, `mirrorChannel`, `overflowMarker`, `procedure`, configured guards and `meta`. Channels may be static or use `channel: { subscribe: ({ input, context }) => key, publish: (parsedEvent) => key }`. Carry publishing tenant keys in the event. A factory `namespace` prefixes channels, mirrors and backlog keys. Each pub/sub definition subscribes to each channel once and parses each payload once for all local subscribers. Each subscriber then runs its filter in arrival order as it reads; its bounded queue holds events before filtering, so `onDrop` counts unfiltered events. Abort and drain release a subscription at once, even one that is not being read. A lost subscription is retried with exponential backoff and jitter. `safePublish` logs a failed publish (`pubsub.publish_failed`) instead of throwing, as on `fnLive`. **`createPublisher`** is the publish-only half; it also has `listen` and `readBacklog`.

**`defineScopedChangeBus`** binds `createPubSub` to one scope rule, for buses that tell everyone in a scope (usually an organization) "this changed". Each bus names a channel `prefix`; events go to `${prefix}:${scope}`. Publishing is safe by default, since buses publish after committed writes. The scope is the access decision, so `authFn` defaults to `true`. `inputSchema` defaults to `z.object({})`. `bus.channel` lets an `fnLive` share the bus's events, and `bus.channelFor({ organizationId })` returns a scope's full channel name, namespace included, e.g. for `backlogKey(...)`.

```ts
import { defineScopedChangeBus, invalidationStream } from 'orpc-fn/live'

const defineChangeBus = defineScopedChangeBus(createPubSub, {
  subscribe: (context) => activeOrganizationId(context), // throw to refuse
  publish: (event: { organizationId: string }) => event.organizationId
})
export const dealChanges = defineChangeBus({
  name: 'deal.subscribe',
  prefix: 'deal:change',
  eventSchema: z.object({ organizationId: z.string(), dealId: z.string() })
})
```

**`invalidationStream`** fans several streams into one stream of `{ domain }` events, so a client holds one connection and invalidates queries per domain. `events` optionally forwards fields from a source event, for example to raise an alert. Sources are called with `{}` and the caller's context. Equal events that queue while the consumer is busy collapse into one. When one source ends (a deploy drain) the stream ends, when one throws the stream throws, and every source is closed either way.

```ts
export const subscribeChanges = fn({
  name: 'realtime.subscribeChanges',
  stream: true,
  input: z.object({}),
  handler: ({ context, signal }) =>
    invalidationStream({
      context,
      signal,
      sources: { deal: dealChanges.subscribe, workItem: workItemChanges.subscribe },
      events: { deal: (event) => (event.kind === 'won' ? { dealId: event.dealId } : undefined) }
    })
})
```

On the client, `useInvalidationStream` from `orpc-fn/vue` or `orpc-fn/react` consumes it; its `domains` map is typed from the route's domains.

**Graceful shutdown:** `await shutdown()` stops new subscriptions/publication, cancels initialization/retries, ends existing streams and awaits cleanup. It closes a supplied transport only with `ownsTransport: true`, and a lazy `transport: () => …` only if it was ever created; it is never created during or after shutdown. A custom transport whose pending `subscribe` cannot be cancelled may resolve later; that late subscription is immediately released. `drainPubSubSubscribers()` remains a synchronous, nonterminal operation; `await drainPubSubSubscribers({ overMs: 5000 })` spreads the closes over the window so clients do not reconnect in one burst. Both are per factory, and both end `listen` streams too.

Recent event IDs deduplicate replay/live overlap; legacy payloads remain readable. Replay is bounded and TTL-limited, so it is not durable resume. A snapshot may already include a queued delta: reducers must use revisions or idempotence. See [the revision example](examples/adoption/revisions.ts). Parsing ingress, replay staging and subscriber queues are bounded; positive queue/TTL/time options are validated.

**Transports** implement `PubSubTransport` (`publish(messages, backlog?)`, `readBacklog(channel)`, `subscribe(channel, listener, onLost, { onReconnect }?)` and optional `stats()`):

| Subpath | Client | Notes |
|---|---|---|
| `orpc-fn/live/redis-bun` | Bun `RedisClient` | Dedicated subscriber via `duplicate()`, or pass `subscriber`; then the command client needs only `send` (a wrapper with timeouts fits). Re-subscribes after Bun's reconnects |
| `orpc-fn/live/ioredis` | ioredis 5 | Dedicated subscriber via `duplicate()`; ioredis re-subscribes itself |
| `orpc-fn/live/memory` | none | Tests and single-process dev. `published(channel?)` returns what was published, decoded; `clearPublished()` resets it |

A subscriber connection that is lost, or cannot restore its channels after a reconnect, is closed and replaced; nothing it still emits is delivered. The Redis transports publish and maintain backlogs with one Lua script, sent by SHA, with a fallback to `EVAL` when Redis returns `NOSCRIPT`. Await `transport.close()` when the app owns its lifecycle.

All three return `stats()`: `{ channels, listeners, subscriberConnected }` on this instance. With `activePubSubSubscriberCount()` from `createFn` that covers pub/sub gauges; a transport opens no connection until the first subscribe, so it can be created eagerly:

```ts
const transport = bunRedisTransport(redis)
createFn({ /* … */, pubsub: { transport, ownsTransport: true } })
meter.createObservableGauge('pubsub_subscribed_channels').addCallback((g) => g.observe(transport.stats().channels))
meter.createObservableGauge('pubsub_redis_subscriber_connected').addCallback((g) => g.observe(transport.stats().subscriberConnected ? 1 : 0))
``` The Redis Lua batching adapter supports standalone Redis; Redis Cluster requires compatible key slots and is not promised by this adapter.

`streamLiveSnapshots`, `fnLivePatch` and `createBoundedEventQueue` are exported for custom streams.

In tests, return `memoryTransport()` from the lazy `pubsub.transport` and assert on `transport.published()` instead of mocking bus modules.

## `orpc-fn/mastra`

Optional peers: `@mastra/core` ^1.51, `@orpc/zod`, `@orpc/json-schema`.

```ts
import { createMastraTool } from 'orpc-fn/mastra'

const tool = createMastraTool(getOrder, { requireApproval: true })
// at run time: requestContext.set('orpcContext', context)
```

Options: `id`, `description` (default: the route's description, else its summary), `requireApproval`, `allowMissingInputSchema`, `onExecuteFinish`, `contextKey` (default `'orpcContext'`), or `context: (requestContext) => …` to read the oRPC context yourself. A failed call throws an `Error` whose message the model reads: `CODE: message`, plus one `path: message` line per validation issue, for an expected error; a fixed sentence for anything else, which goes to `onError(error, { tool })`. `isExpectedError` and `formatError(error, { tool, expected })` change the rule and the text. The same options exist on `registerMcpTools`. Mastra writes plain request-context values into run snapshots and spans, so a context holding a session belongs in a slot that serializes to nothing (better-mastra's `defineRequestContextHolder`), read through `context`. Execution goes through oRPC `call`, so middleware and guards apply.

The tool takes the procedure's raw input and returns its parsed output, and `InferToolInput`/`InferToolOutput`/`InferUITools` see exactly those types. Mastra validates the input (coercing date strings) but passes the raw value on, and the procedure parses that raw value: transforms/refinements must be pure: SDK validation and procedure execution may run them more than once, always on raw input. Agent tools accept objects and unions of object shapes. Other inputs and streams are rejected. Finish-hook failures preserve execution outcomes.

oRPC 2's Zod converter writes string checks into tool schemas that oRPC 1's left out (`minLength`, `maxLength`, and `format` together with Zod's full regex as `pattern`); in one app this made the tool prompt about 25% longer. Limits stay, but a `pattern` that repeats a standard `format` (`uuid`, `email`, `date-time`, `date`, `time`, `uri`, `ipv4`, …) is left out of the schema the model reads, here and in `orpc-fn/mcp`. Validation still applies every check. `keepFormatPatterns: true` (here, and on `listTools`, `prepareMcpTools` and `registerMcpTools`) keeps them.

## `orpc-fn/mcp`

Optional peers: `@orpc/zod`, `@orpc/json-schema`.

Inspection definitions from `listTools` use Standard Schema and are not `McpServer.registerTool` configs. Executable registration is a separate optional entry point per SDK major: `orpc-fn/mcp/sdk` for `@modelcontextprotocol/sdk` ^1.32.0 and `orpc-fn/mcp/server` for `@modelcontextprotocol/server` ^2.0.0:

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

For MCP SDK v2 (`@modelcontextprotocol/server` ^2.0.0), import the same `registerMcpTools` from `orpc-fn/mcp/server` instead; options and behaviour are identical:

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { registerMcpTools } from 'orpc-fn/mcp/server'

const mcp = new McpServer({ name: 'api', version: '1.0.0' }, { capabilities: { tools: {} } })
registerMcpTools(mcp.server, router, { filter: hasTag('external'), context })
```

An app that builds a server per request lists and converts its tools once with `prepareMcpTools(router, { filter })` (from either entry) and registers the result with `registerPreparedMcpTools(server, prepared, { context })`. `prepared.names` lists the tool names without a server.

The adapter installs the SDK list/call handlers on a low-level `Server` (also accessible as `McpServer.server`). Use one registration per server; these handlers own its tool list. It forwards cancellation, validates/coerces arguments, applies procedure authorization, and formats results as JSON/text MCP content. Override `formatResult` for images, structured content or other presentation. A failed call answers as on `orpc-fn/mastra`: expected errors as `CODE: message` with the paths of rejected arguments, anything else as a fixed sentence reported to `onError`. Tool selection is required. Object unions are supported. A stream cannot be a tool, so a streaming procedure the filter accepts is left out, and one filter such as `hasTag('external')` can describe a REST surface that has streams too; pass `streams: 'throw'` (also to `listTools` and `prepareMcpTools`) to fail on one instead. Resolve lazy routers first with oRPC's `unlazyRouter`.

Sanitized tool-name collisions between distinct procedures throw; identical aliases are deduplicated. Override `name` to resolve deliberate collisions. Tool names are the sanitized `fn` names (`user.me` becomes `user-me`). Input schemas carry the same JSON Schema as your OpenAPI docs (dates become `string`/`date-time`), minus a `pattern` that repeats a standard `format` (see [`orpc-fn/mastra`](#orpc-fnmastra); `keepFormatPatterns: true` keeps it), and validation turns dates back into `Date`s. Validation returns the raw arguments, and `call(procedure, args, { context })` parses those: transforms/refinements must be pure: SDK validation and procedure execution may run them more than once, always on raw input. `readOnlyHint` defaults to GET routes; pass `readOnly` to change it. `hasTag(tag)` also works as an oRPC `OpenAPIHandler` filter.

Filters combine without spelling out `(procedure, path)`: `hasTags('external', 'mcp-support')` needs every tag, and `allOf(...filters)`, `anyOf(...filters)` and `not(filter)` compose any filters, e.g. `allOf(hasTag('external'), not(hasTag('beta')))`. They are exported wherever `hasTag` is (`orpc-fn/mcp`, `orpc-fn/openapi` and the HTTP adapters).

## `orpc-fn/cli`

Tool descriptions are the route's `description`, else its `summary`, for MCP, Mastra and `readFnMeta(...).description` alike.

Built on `hanzio/cli`, which orpc-fn depends on (`hanzio` ^3.4.0). Your `defineCli` must come from the same `hanzio` copy, so keep your own `hanzio` on a matching major.

```ts
import { defineCli } from 'hanzio/cli'
import { procedureCommands } from 'orpc-fn/cli'

const updateDeal = fn({
  name: 'deal.update',
  summary: 'Move a deal to another stage', // the command's help
  meta: { cli: true },
  input: z.object({ id: z.string().meta({ positional: true }), stage: z.string() }),
  handler: async ({ input, context }) => { /* ... */ }
})

await defineCli({
  name: 'app',
  globals: z.object({ as: z.string().optional() }),
  context: async ({ as }) => ({ user: as ? await loadUser(as) : undefined }),
  commands: procedureCommands(router)
}).run() // app deal update d_1 --stage won --as ada@example.com
```

`procedureCommands(router)` turns the routes declared with `meta: { cli: true }` into commands nested like the router, kebab-cased (`dealRoom.update` is `deal-room update`); add `cli?: boolean` to your meta type, or select routes with `filter`. Flags and positionals come from the route's `z.object()` input. A command calls the procedure through oRPC with the CLI's context, so middleware, guards and tracing run as over HTTP; `context: (cliContext, meta) => ...` maps that context per procedure and can refuse with a `CliError`. A 4xx `ORPCError` prints as `CODE: message`; anything else keeps its stack. Streams and non-object inputs throw when the commands are built. The procedure parses the already-validated flags again, so transforms must accept their own output.

## HTTP: `orpc-fn/fetch`, `orpc-fn/node`, `orpc-fn/hono`

Three thin adapters over oRPC's own RPC and OpenAPI handlers share one set of options and behaviour. They need only the required peers; `hono` for `orpc-fn/hono`, and for `openapi` also `@orpc/openapi`, `@orpc/zod` and `@orpc/json-schema`, loaded on the first request to its prefix, so an RPC-only app does not install them.

**`orpc-fn/fetch`** is a Web `(request) => Promise<Response>` over `@orpc/server/fetch`, for the Next.js App Router, TanStack Start, Bun, Deno and Cloudflare Workers (compression uses `node:zlib`, so Workers need `nodejs_compat`). Requests no mount matches get a 404.

```ts
// app/api/rpc/[[...rest]]/route.ts
import { createFetchHandler } from 'orpc-fn/fetch'

const handler = createFetchHandler({
  router,
  rpcPrefix: '/api/rpc',
  context: async (request, base) => ({ ...base, session: await getSession(base.headers) })
})
export { handler as GET, handler as POST }
// TanStack Start: server: { handlers: { ANY: ({ request }) => handler(request) } }
```

**`orpc-fn/node`** is a `(req, res, next?)` handler over `@orpc/server/node`, for Next.js Pages Router API routes, Express and `http.createServer`. Unmatched requests go to `next` when given, else get a 404. A body an earlier middleware parsed (`req.body`) is used as is, but Next.js should leave it unparsed so file uploads arrive intact. The handler runs inside whatever wraps it, so an `AsyncLocalStorage` wrapper reaches every procedure, batched or not.

```ts
// pages/api/rpc/[[...rpc]].ts
import { createNodeHandler, timed } from 'orpc-fn/node'

export const config = { api: { bodyParser: false } }

export default withInRequestStorage(
  createNodeHandler({
    router,
    rpcPrefix: '/api/rpc',
    context: async (req, { headers, timing }) => ({
      headers,
      timing,
      session: await timed(timing, 'auth_ms', () => getSession(headers))
    }),
    onError: (error, request) => errorTracker.capture(error, request)
  })
)
```

**`orpc-fn/hono`** has `mountOrpc(app, options)`, which adds the handlers as middleware, and unmatched paths fall through to the app.

```ts
import { hasTag, mountOrpc, normalizeExpoOrigin, timed } from 'orpc-fn/hono'

mountOrpc(app, {
  router,
  rpcPrefix: '/rpc',
  // Only routes tagged 'external' get a REST endpoint and appear in the docs.
  openapi: { prefix: '/api', filter: hasTag('external'), info: { title: 'API', version: '1.0.0' } },
  context: async (c, { headers, timing }) => ({
    headers,
    timing,
    session: await timed(timing, 'auth_ms', () => getSession(headers))
  }),
  normalizeHeaders: normalizeExpoOrigin,
  onError: (error, request) => errorTracker.capture(error, request)
})
```

**Response headers.** Procedures set response headers through `context.resHeaders` (oRPC's `ResponseHeadersHandlerPlugin`, on in every adapter). A procedure opts in by declaring it in its builder's context; routes that do not mention it are unchanged. Headers set in a batched call stay on that call's result, so a CDN-cached route is called outside a batch, e.g. as an OpenAPI `GET`:

```ts
const base = os.$context<{ headers: Headers; resHeaders?: Headers }>()

export const getMenu = fn({
  name: 'menu.get',
  method: 'GET',
  path: '/menus/{id}',
  input: z.object({ id: z.string() }),
  handler: async ({ input, context, db }) => {
    context.resHeaders?.set('cdn-cache-control', 'public, s-maxage=300, stale-while-revalidate=60')
    return db.menu.find(input.id)
  }
})
```

Behaviour:

- The response gets a `Server-Timing` header built from the request timing collector: app-recorded queue/auth/context metrics plus library-owned procedure time (`serverTiming: false` turns it off). Nested calls do not overwrite parent timing; batches aggregate their top-level procedure durations (which may overlap). `fn` does not mutate an arbitrary `context.timing` field. `formatServerTiming` (and `finishOrpcHeaders` on `orpc-fn/hono`) are available for composed adapters.
- SSE responses get keep-alive comments (15 s) and anti-buffering headers.
- RPC calls are batched (`BatchHandlerPlugin`).
- JSON and batch responses are compressed when the client accepts it: brotli, or gzip when the client prefers or only accepts it (`compress: false` turns it off). Bodies under 512 bytes are sent as they are. A streaming batch (`application/vnd.orpc.batch`) sends each result as it finishes, so it is flushed after every result instead of buffered. Live event streams are never compressed, nor is a response that already has a `content-encoding` or `Cache-Control: no-transform`.
- `openapi.filter` is required and decides which routes get a REST endpoint and a place in the spec; `() => true` publishes all of them. Scalar docs are served at the OpenAPI prefix (or `docsPath` under it) and the spec at `/spec.json`, unless `docs: false`.
- `openapi` takes an array for several REST surfaces, each with its own `prefix`, `filter` and options. `docs` takes an array for several reference pages on one surface, each with its own `path`, `specPath`, `filter` (within the surface's), `info`, `spec` (oRPC's generator options, such as `version`), `components` and `document`; the surface's own fields are their defaults. Two pages may not share a path. Auth for a surface stays in the app, e.g. a Hono middleware in front that `context` reads:

  ```ts
  mountOrpc(app, {
    router,
    rpcPrefix: '/api/rpc',
    context: (c, base) => ({ ...base, user: c.get('apiUser') }), // set by your Basic-auth middleware on /api/v1
    openapi: [
      { prefix: '/api/openapi', filter: () => true },
      {
        prefix: '/api/v1',
        filter: hasTag('external'),
        spec: { version: '3.1.1', base: { components: { securitySchemes }, security: [{ basicAuth: [] }] } },
        docs: [
          { path: '/customer', specPath: '/customer/spec.json', filter: hasTag('customer-api'), info: { title: 'Customer API', version: '1.0.0' } },
          { info: { title: 'External API', version: '1.0.0' } } // at /api/v1, spec at /api/v1/spec.json
        ]
      }
    ]
  })
  ```
- `openapi.components` (or a page's) names shared schemas in `components.schemas`, as `generateOpenApiDocument` does (see [`orpc-fn/openapi`](#orpc-fnopenapi)). `document: () => myDocument()` serves a document the app builds instead, on the docs page and its `spec.json`, so there is one spec, not a second route beside the generated one.
- `openapi.errorResponseBodyEncoder: (error, status) => body` replaces oRPC's REST error body `{ defined, code, message, data }` (oRPC's own handler option, given the status the response answers with under `errorStatusMap`). RPC errors keep oRPC's format, which its client reads. Document the same shape with oRPC's `spec.errorResponseBodySchema`:

  ```ts
  openapi: {
    prefix: '/api',
    filter: hasTag('v1'),
    errorResponseBodyEncoder: (error, status) => ({ ...error.toJSON(), status }),
    spec: {
      errorResponseBodySchema: (_defined, status, defaultSchema) => ({
        allOf: [defaultSchema(), { type: 'object', properties: { status: { const: status } }, required: ['status'] }]
      })
    }
  }
  ```
- `onError` sees only unexpected errors: by default those `isExpectedClientError` rejects under `errorStatusMap`, and never errors the route's `createFn({ isExpectedError })` classified as expected.
- `errorStatusMap` sets the HTTP status per error code over oRPC's common map (`{ RATE_LIMITED: 429 }`); oRPC 2 errors no longer carry one, and unknown codes answer 400.
- `openapi.smartCoercion` and `openapi.spec` cover an external API with its own auth. `spec` takes oRPC's generator options; document fields go in `base`: `spec: { base: { components: { securitySchemes }, security } }`.
- A filter (`openapi.filter`, `listTools`, `registerMcpTools`) is oRPC's `(procedure, path) => boolean`; `readFnMeta(procedure)` reads a route's `method`, `tags` and meta inside one.
- CORS is set up once: Hono's `cors()` on a Hono app, oRPC's `CORSHandlerPlugin` in `plugins` (and `openapi.plugins`) otherwise. Its default `origin` is `*` since oRPC 2, so list origins when you send credentials. Spread `CLIENT_REQUEST_HEADERS` (from any HTTP adapter) into its allowed headers: the headers orpc-fn's links send (`content-type`, `orpc-batch` for batching, and the Expo link's `expo-origin` and `x-skip-oauth-proxy`), so the list follows orpc-fn: `cors({ origin, credentials: true, allowHeaders: [...CLIENT_REQUEST_HEADERS, 'authorization'] })`.
- `timed(timing, key, work)` adds the duration of `work` to the request timing, which `Server-Timing` reports.
- `markRequestArrival(request)` at the front door (`Bun.serve({ fetch })` or `http.createServer`, before routing) makes `queue_ms` the time until the procedure runs: in-process queueing no handler timer sees. Pass `queueMs` to measure it another way.
- `context` builds the router's context from `{ headers, timing }` and the runtime's request (the Hono context, the `Request`, the `IncomingMessage`), and is checked against the router: it is required when `{ headers, timing }` alone does not satisfy it. It may return a `Response`, for example a 401. Any field the app's auth middleware trusts when it is already set (a `user`) must only come from here: `createCall`, `createMastraTool({ context })` and `registerMcpTools({ context })` take a ready-made context too, so build a context that acts for someone in one app function.

## `orpc-fn/openapi`

Optional peers: `@orpc/openapi`, `@orpc/zod`, `@orpc/json-schema`.

`generateOpenApiDocument(router, options)` is oRPC's `OpenAPIGenerator` with a required `filter` and named components, for a document the app serves, publishes or post-processes itself (the HTTP adapters' docs pages use it too). Options are oRPC's generator options (`version`, `base`, `errorStatusMap`, …) plus:

```ts
import { generateOpenApiDocument, hasTag } from 'orpc-fn/openapi'

const document = await generateOpenApiDocument(router, {
  filter: hasTag('v1'),
  version: '3.1.1', // oRPC 2 defaults to 3.2; many client generators expect 3.1
  base: { info: { title: 'API', version: '1.0.0' }, servers: [{ url: '/api' }] },
  components: {
    Error: ErrorSchema,
    Reporter: { schema: ReporterSchema, only: 'input' },
    WebhookEvent: { schema: WebhookEventSchema, only: 'output' }
  }
})
```

`components` replaces oRPC 1's `commonSchemas`. Each named Zod 4 schema is written once under `components.schemas` and referred to by `$ref` wherever a route's input or output uses it; `only` names it in one direction alone. Components no route refers to, such as a webhook payload, are listed too. The names are kept in a private registry, not Zod's global one, so the JSON Schema the MCP and Mastra tools build from the same schemas does not change.

## `orpc-fn/client`

Has no server code, so it is safe in frontends (Vue, React, Expo).

```ts
import { createORPCClient } from '@orpc/client'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { createRpcLink, hasOrpcErrorCode } from 'orpc-fn/client'
import type { RouterClient } from '@orpc/server'
import type { router } from '@app/backend' // type-only import

const link = createRpcLink({
  origin: apiOrigin, // oRPC 2: `url` is the path
  url: '/rpc',
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include', cache: 'no-store' })
})
export const client: RouterClient<typeof router> = createORPCClient(link)
export const orpc = createTanstackQueryUtils(client) // Vue Query or React Query

if (hasOrpcErrorCode(error, 'NOT_FOUND')) { /* … */ }
toast(userFacingErrorMessage(error, t('errors.generic'))) // server text only when it opts in
```

`responseStatusOf(error)` is the HTTP status a failed call got, or `undefined` when no response arrived (offline, aborted). oRPC 2's `ORPCError` has no `status`; it is read from the response the link keeps on the error, and from the `MalformedResponseError` a non-oRPC answer (a proxy's 502 page) throws. It is the client half of the server's `errorStatusOf`. `operationPath(key)` reads the path from an `@orpc/tanstack-query` key, which oRPC 2 starts with the path or with a `prefix` and then the path: `operationPath(orpc.order.get.key())` is `['order', 'get']`.

Route error messages are developer text, so `userFacingErrorMessage` shows your localized fallback unless the server opted in with `new ORPCError('BAD_REQUEST', { message, data: { userMessage } })`. `formatClientError(error, fallback)` does the same but lists the rejected fields of a failed input validation (`lines.0.sku: Required`) before falling back.

Streams cannot be batched. The Vue and React helpers mark the streams they open (`streamCall` as the client context), so `createRpcLink` keeps them out of batches without a stream manifest; pass `context: streamCall` when you iterate a stream by hand. The manifest (`streamPaths`) remains for streams opened without either. `queryCacheSerializer` is a `serialize`/`deserialize` pair for TanStack Query persisters that round-trips `Date`s and the other types oRPC sends; caches persisted under oRPC 1 still restore.

`createRpcLink` takes every `RPCLink` option, and `url` takes any `string` path, so a path constant needs no `as const` (a full URL throws, naming the `origin`/`url` split, as does a path without a leading `/`). It also batches parallel calls into one request, matching `mountOrpc`'s server-side batching (`batch: { maxSize, exclude, groups }`, or `false` to turn it off), in oRPC's `streaming` mode so a fast result does not wait for a slow one. A batch is one request with one client context, so by default only calls without a client context are batched; pass `groups` to batch calls that share one. A streaming response cannot be batched, and the request doesn't say whether the response will stream, so pass `streamPaths` generated from the actual router with `createStreamManifest` (or `createStreamManifestAsync` for lazy routers). Serialize it to a frontend module; importing that data needs no server runtime. The `orpc-fn` CLI does that, resolving lazy routers, sorting paths and writing only on change:

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
  origin: baseUrl,
  url: '/api/rpc',
  fetch,
  native: Platform.OS !== 'web',
  getCookie: () => authClient.getCookie(), // Better Auth Expo
  getExpoOrigin,
  headers: () => ({ 'x-orpc-source': 'expo-react' })
})
```

On native, calls go through `expo/fetch`, the only fetch that streams there. In Expo SDK 55, cancelling a stream makes `expo/fetch` close its body twice and throw `Invalid state: Controller is already closed`; patch `src/winter/fetch/FetchResponse.ts` so its `didComplete` and `didFailWithError` listeners return when `isControllerClosed` is already set (with `bun patch expo` or `patch-package`). The bridge forwards the request body and the abort signal. Without the signal, cancelled subscriptions keep their sockets open, the device's HTTP pool runs out, and later requests hang. Cookies are sent in a header (`credentials: 'omit'`), together with `expo-origin` and `x-skip-oauth-proxy`, the same headers `@better-auth/expo` sends. On the server, `mountOrpc({ normalizeHeaders: normalizeExpoOrigin })` copies `expo-origin` to `origin`. The generic `createExpoLink` forwards upstream headers (including async/context-aware resolvers) and adds no provider-specific headers. `createBetterAuthExpoLink` supplies the cookie/origin preset above. On web, the link uses the platform fetch with cookies, or your explicit `webFetch(url, init)` override. `createExpoFetch` is exported for a custom link.

## `orpc-fn/vue`

Peers: `vue`, `@tanstack/vue-query`.

```ts
// main.ts
app.use(VueQueryPlugin, { queryClient })
provideOrpc(app, { client, utils: orpc })

declare module 'orpc-fn/vue' {
  interface Register { client: typeof client; utils: typeof orpc }
}
```

```ts
const { useQuery, useMutation, invalidate } = useApiClient()
const orders = useQuery((o) => o.order.list.queryOptions({ input: { search: search.value } }))
// `invalidates` runs after a success, before the options' own onSuccess.
const save = useMutation((o) => o.order.update.mutationOptions(), { invalidates: (o) => [o.order.key()] })

// Form state: `inputData` is typed from the route; `initialInput` is checked against it.
const { inputData: form, mutate } = useMutation((o) => o.order.update.mutationOptions(), {
  initialInput: { id: props.id, data: {} }
})

// A helper that takes the composables: `ApiClient` is bound to the registered utils.
function invalidateOrders(invalidate: ApiClient['invalidate']) {
  void invalidate((o) => o.order.key())
}

// The client half of `fnLive`: HTTP seeds the cache, the stream keeps it current.
const order = useLiveQuery(
  () => ({ id: props.id }),
  (input, o) => o.order.get.queryOptions({ input }),
  (o) => o.order.watch.call // the composable passes the input and an abort signal
)

// A query as the props of a list or loading component.
const list = useQueryState(orders, { fallback: t('orders.loadFailed') })
// <ListStates v-bind="list" />: status, error, errorMessage, isRetrying, retry()

// Once, in the signed-in shell: one stream of `{ domain }` events invalidates list queries.
useInvalidationStream({}, (o) => o.realtime.subscribeChanges.call, {
  domains: { order: { debounceMs: 100, queryKeys: [orpc.order.key()] } },
  logger
})
```

`useQuery` and `useLiveQuery` infer data and error types from the options but leave the query key's type alone, so a route whose output is recursive (`z.json()`) does not hit TypeScript's "excessively deep" limit in vue-query's option types, and an explicit data type (`useQuery<Draft | null>((o) => ({ ...o.draft.get.queryOptions(...), refetchInterval }))`) fits oRPC's tagged options. oRPC 2's options do not fit vue-query's plain `UseQueryOptions<T, E>`, because their `queryFn` takes the tagged key, so a helper that passes options to these composables types them as `ApiQueryOptions<T, E>`. `useApiClient()` also returns the utils as `orpc`, for calls outside a composable such as `queryClient.fetchQuery(orpc.unit.list.queryOptions({ input }))`. `useOrpcSubscription` (also `useApiClient().useSubscription`) reconnects with jittered backoff and closes while the page is hidden (`respectVisibility: false` keeps it). `useLiveQuery` writes each stream event under the key it was opened for, so an event in flight from a previous input is dropped. A stream whose events are not the cached type (an `fnLive` patch route, or a `select`ed cache) does not compile without `applyEvent`, and the stream's input must match the query's unless you pass `subscriptionInput`. Use `mergeSeed` when the seed can resolve after stream events. For large live payloads such as chat timelines, pass vue-query's `shallow: true` in the query options so the data is not made deeply reactive; mutate it only through `setQueryData`. Live queries carry `meta.live`, so invalidation streams skip them. Leave `refetchType` at TanStack's `'active'`: `'all'` refetches every cached query of a domain on each event, including screens nobody has open, which refetch on their next visit anyway. `useSubscriptionInvalidates` treats a stream as a "something changed" ping, and `useQueryErrorMessage` is `userFacingErrorMessage` as a computed. A surface that talks to another API passes `orpc` to each composable instead of using `provideOrpc`; `useOrpc({ optional: true })` returns null instead of throwing when nothing was provided. `useDocumentVisible()` is the visibility ref the streams pause on.

`orpc-fn/vue/testing` runs composables in a real app without a DOM: `withOrpcApp(setup, { utils })`, `createTestStream()` for a subscription the test drives (`await stream.push(event)` resolves once it was handled), and `createOrpcMock({ fn: mock })` for a deep stand-in of the utils.

## `orpc-fn/react`

Peers: `react`, `@tanstack/react-query` ^5.66 (`@orpc/tanstack-query` 2, if you use its `queryOptions`, asks for `@tanstack/query-core` 5.105 itself). Works on React Native: pausing follows TanStack's `focusManager`, so wire it to `AppState` once, as TanStack recommends:

```ts
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener('change', (state) => setFocused(state === 'active'))
  return () => subscription.remove()
})
```

```tsx
const { status } = useOrpcSubscription({ id }, client.order.watch, { onEvent: (order) => setOrder(order) })

// Same contract as the Vue `useLiveQuery`, with the client procedure passed as is.
// For a large cache your `applyEvent` keeps immutable, pass `structuralSharing: false` in the query options.
const order = useLiveQuery({ id }, (input) => orpc.order.get.queryOptions({ input }), client.order.watch)

useInvalidationStream({}, client.realtime.subscribeChanges, {
  enabled: signedIn,
  domains: { order: { debounceMs: 500, queryKeys: [orpc.order.list.key()] } }
})

// Persist the cache per user: the buster drops someone else's saved cache, the hook clears memory.
const owner = session ? `${session.user.id}:${session.activeOrganizationId ?? ''}` : null
useQueryCacheOwner(owner)
const persister = createAsyncStoragePersister({ storage: AsyncStorage, ...queryCacheSerializer })
<PersistQueryClientProvider client={queryClient} persistOptions={{ persister, buster: owner ?? '' }} />
```

## Docs

- [Decisions: what oRPC already ships and why this exists](docs/decisions.md)
- [Releasing](docs/releasing.md)
- [Independent core, tenant, revision, MCP and Expo examples](examples/adoption/README.md)
- [Example: Hono, in-memory pub/sub, two routes and a live query](examples/basic/server.ts)

## License

MIT
