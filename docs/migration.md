# Adopting the library before migrating projects

Keep one app-bound `createFn`. The application owns auth builders, domain services, permission vocabulary, tenant authorization and reliable publication. This release changes several `0.x` contracts; settle the app wrapper first, then migrate a small router and verify it before moving the rest. These instructions do not migrate or audit external projects automatically.

## Install the features you use

```sh
bun add orpc-fn @orpc/server @orpc/contract @orpc/client zod
```

Use TypeScript 5.7+, oRPC 1.14+, Zod 4 and Node 20+ or Bun. Optional peers:

| Feature | Peers |
| --- | --- |
| Tracing | `@opentelemetry/api` |
| Hono/OpenAPI | `hono`, `@orpc/openapi`, `@orpc/zod`, `@orpc/json-schema` |
| Mastra | `@mastra/core` ^1.51.0, `@orpc/zod`, `@orpc/json-schema` |
| Executable MCP | `@modelcontextprotocol/sdk` ^1.32.0, `@orpc/zod`, `@orpc/json-schema` |
| ioredis transport | `ioredis` |
| Expo native app | Inject `fetch` from `expo/fetch`; the library does not import Expo |

## Breaking decisions

| Before | Now |
| --- | --- |
| Flat metadata such as `fn({ readOnly: true })` | `fn({ meta: { readOnly: true } })`; unknown top-level options throw |
| Factory `meta: {} as AppMeta` | Prefer `meta: defineMeta<AppMeta>()`; a type declaration, no defaults |
| Permission predicates returning false are ignored | `false` denies with `FORBIDDEN`; true/void allow; unsupported returns fail |
| Metadata reads use the calling factory's type | Readers infer the passed procedure's metadata and builder key |
| Zod-only core schemas | Core accepts native oRPC/Standard Schema, including `eventIterator` |
| Streaming inferred by `subscribe` in the path | Declare `stream: true` or use `eventIterator`; send the router manifest to the client |
| `BoundCall` defaults to any context; input always required | Explicit context generic; omit input when undefined is valid |
| Extras silently shadow built-in params | Shadowing fails types/runtime; `extrasByProcedure` scopes services by builder |
| Completion precedes output validation | Completion observes auth/input/output failures and stream lifetime |
| `context.timing.handler_ms` is overwritten | Library-owned request timing aggregates top-level calls; app timing is untouched |
| Pub/sub subscribe bypasses fn execution policy | Builder middleware, guards, extras, metadata and completion apply |
| Shared partial channel resolver is the only option | Prefer separate required-input subscription/event resolvers |
| Unbounded parsing/replay and best-effort startup | Bounded queues and successful, timed, abortable readiness |
| Raw streams silently continue after loss | Explicit unavailable error, or an app-provided recovery marker |
| Reducer state is unvalidated | Supply `stateSchema`; patches also need `emitSchema` |
| `rerun(nextInput)` changes input without validation/auth | `rerun()` reloads the current input through the procedure |
| Drain is the only shutdown API | `await shutdown()` is terminal; drain remains nonterminal |
| Better Auth headers are always added by Expo | Generic `createExpoLink`; named `createBetterAuthExpoLink` preset |
| Custom Standard Schema registered through `McpServer.registerTool` | `registerMcpTools` installs supported SDK JSON Schema list/call handlers |

## Build a thin application wrapper

```ts
import { ORPCError, os } from '@orpc/server'
import { createFn, defineMeta } from 'orpc-fn'

const publicProcedure = os.$context<AppContext>()
const protectedProcedure = publicProcedure.use(({ context, next }) => {
  if (!context.user) throw new ORPCError('UNAUTHORIZED')
  return next({ context: { user: context.user } })
})

export const {
  fn, fnLive, createPubSub, createPublisher, createRouter,
  readMeta, createCall, shutdown, drainPubSubSubscribers,
  activePubSubSubscriberCount
} = createFn({
  procedures: { public: publicProcedure, protected: protectedProcedure },
  default: 'protected',
  meta: defineMeta<{ readOnly?: boolean; automationSafe?: boolean }>(),
  extras: () => ({ db }),
  extrasByProcedure: {
    protected: ({ context }) => ({ t: translator(context.user.locale) })
  },
  guards: {
    permission: (requirement: PermissionRequirement, { context }) =>
      context.user?.can(requirement) ?? false
  },
  onCompleted: (event) => {
    if (event.handlerStarted && event.procedure === 'protected') {
      return { user_id: event.context.user.id }
    }
  }
})
```

Builder input/output schemas are rejected: place them on routes. Guard keys cannot reuse route option names. Metadata keys may overlap because they have a namespace. Scoped extras replace matching shared keys; handler types follow that precedence. Shared and scoped extras cannot use `input`, `context`, `call`, `signal`, `span`, `logger`, `errors` or `lastEventId`.

Routes remain inferred:

```ts
const getOrder = fn({
  name: 'order.get',
  meta: { readOnly: true },
  input: z.object({ id: z.string() }),
  guardResolvers: {
    permission: ({ input }) => ({ resource: input.id, action: 'read' })
  },
  errors: { MISSING: { data: z.object({ orderId: z.string() }) } },
  handler: async ({ input, db, errors }) => {
    const order = await db.order.find(input.id)
    if (!order) throw errors.MISSING({ data: { orderId: input.id } })
    return order
  }
})
```

Static guard checks run first in route declaration order, then resolved checks in resolver order. A route cannot supply both forms for one guard. Assertion guards may throw; predicate guards must explicitly return false when access is unavailable. A return of undefined means allow.

## Reviewable AST migrations

The codemods rewrite direct `fn`, `fnLive` and `createPubSub` call options. They leave unrelated objects, nested objects and routes with spreads untouched. Conflicting legacy access flags or an incompatible existing `procedure` throw so a migration cannot guess the access policy. Install the repository dev dependencies before running them; the AST parser is a pinned dev-only TypeScript alias separate from the current compiler.

```sh
bun ../orpc-fn/scripts/codemods/procedure-option.ts apps/backend/src --flag=isPublic:public --flag=isSupport:support
# For string-valued builder selectors:
bun ../orpc-fn/scripts/codemods/procedure-option.ts apps/backend/src --rename=auth

# Move only explicitly named application metadata (explicit file arguments):
bun ../orpc-fn/scripts/codemods/route-meta.ts features/order/get.ts --meta=readOnly,automationSafe
```

Review every diff. Routes with spreads, existing metadata or trailing metadata comments need manual merging. Replace object-valued summaries with a native string `summary` plus an app-specific field inside `meta`. Keep domain helpers in the app; do not fold tenant policy, transactions, feature flags or job orchestration into the library.

## Streams and frontend batching

```ts
// Server/build step; serialize this result into a frontend module.
const streamPaths = createStreamManifest(router)
// Lazy routers: await createStreamManifestAsync(router).

// Frontend: import only that serialized data, plus the router type.
const link = createRpcLink({ url, streamPaths })
```

Router paths, including aliases, determine batching. Every custom stream must declare `stream: true` or use oRPC's `eventIterator` schema; inconsistent runtime results are rejected. Generated streams declare this automatically. `batch.exclude` can cover dynamic cases. The old `subscribe` name heuristic remains a fallback, but cannot identify a route named `watch` by itself.

## Live queries, tenancy and lifecycle

Prefer full-snapshot invalidation. Coalescing reruns once for a batch, while reducers process every event and emit the final full state. Ordered patch payloads are preserved. `previous` is initialized; `rerun()` invokes the current procedure again with its original raw input, repeating auth/guards/validation.

Use separate channel resolvers:

```ts
channel: {
  subscribe: ({ input, context }) => `${context.tenant}:${input.room}`,
  publish: (event) => `${event.tenantId}:${event.roomId}`
}
```

Publishing events must carry the channel's tenant keys. Subscription context must already be authorized. Configure `namespace` per application/environment. Inspect names through `getSubscriptionChannelName({ input, context })` and `getPublishChannelName(event)`; the partial-input `getChannelName` helper is deprecated.

Set positive queue, backlog, TTL and initialization bounds. Override `maxQueueSize`, `maxIngressSize` and `maxReplaySize` per pub/sub definition or live config when event rates differ. `live.maxBatchSize` bounds coalescing (default 1000). `pubsub.onMetric` reports queue depths, drops, reconnects and parse failures through a typed synchronous callback whose failures are isolated. The default parsing, replay and subscriber bounds are 1000 items; initialization waits up to 10 seconds. Overflow/reconnect causes live queries to reload. Raw event streams throw `SERVICE_UNAVAILABLE`, unless an explicit recovery marker provides an application protocol. Transport implementations should report restored connections through the fourth subscribe argument's `onReconnect` callback.

IDs deduplicate recent replay/live overlap and old wire payloads remain readable. IDs do not solve snapshot/delta overlap. Reducers must skip revisions already included in the snapshot and reload on revision gaps; [the revision example](../examples/adoption/revisions.ts) demonstrates both. Supply a schema for parsed reducer state, and a separate patch schema when using `fnLivePatch`. Keep these validators free from repeated transforms.

Authentication at open covers idle streams. `reauthorize` checks before updates; an app requiring immediate revocation must terminate affected streams. `safePublish` suppresses a broker error but offers no durability or retry. Use app-owned outbox logic for reliable notification.

Use `await shutdown()` at process shutdown. It rejects new live work, aborts initialization/retries, closes streams and awaits known cleanup. Set `ownsTransport: true` only when this factory owns disposal; otherwise close the shared transport in the app. Late results from noncancellable custom transport initialization are released when they arrive. `drainPubSubSubscribers()` remains useful for nonterminal draining. Redis Lua batching targets standalone Redis; Cluster support needs matching hash slots and integration coverage.

## Tools, HTTP and Expo

Use `registerMcpTools(server, router, { filter, context })` from `orpc-fn/mcp/sdk`. This owns the SDK's tool list/call handlers; register once per low-level `Server`, or `McpServer.server`, and connect its transport. Results default to protocol-compliant JSON/text; `formatResult` controls application presentation. `listTools` remains an inspection API, not SDK `registerTool` configs. Tool filters must explicitly exclude streaming routes. Resolve lazy routers with `unlazyRouter`. Distinct sanitized-name collisions throw; identical aliases deduplicate. Mastra accepts object unions. Transforms/refinements must be pure because validation and execution may run multiple passes over raw input.

Use `mountOrpc` for Hono; reusable `formatServerTiming`/`finishOrpcHeaders` help compose another Fetch server. Its plugins and OpenAPI spec are checked against upstream types. Completion logs are per invocation; request timing sums top-level durations, excludes nested double-counting, and can exceed elapsed request time for overlapping batch work. For auth/context timing, record app metrics in the provided `base.timing` collector instead of expecting fn to mutate your context.

Use `createExpoLink` for bearer or custom headers, including async/context-aware resolvers. Use `createBetterAuthExpoLink` for Better Auth cookies/origin headers. Pass `webFetch` for a browser override. The native bridge forwards both body and cancellation.

## Pilot checklist

1. Run the app wrapper and a small router through types, tests and a packed-package install.
2. Verify guard denials, public/protected context, native errors and metadata reads.
3. Check a stream named `watch` beside parallel ordinary calls and confirm cancellation releases it.
4. Exercise live startup failure, reconnect/overflow recovery and reducer revisions.
5. Invoke tools through the actual SDK and run both mobile auth presets in the consuming app.
6. Confirm terminal shutdown and transport ownership, then expand migration.

[Runnable examples and peers](../examples/adoption/README.md) cover the representative contracts. Durable envelopes, outbox hooks, Redis Cluster adapters and framework composables remain separate additions driven by a consumer requirement.
