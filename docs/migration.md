# Migrating from an in-repo `lib/fn`

This guide is for apps that still carry their own copy of `fn` (lullu and gey-mono, `apps/backend/src/lib/fn/`). The aim is a thin `lib/fn/index.ts` that calls `createFn` and keeps the same exports, so route files compile unchanged apart from one codemod.

## 1. Install and link

```sh
bun add orpc-fn
# before the first release: "orpc-fn": "file:../orpc-fn" in the root catalog, or `bun link orpc-fn`
```

Use oRPC 1.14 or newer and Zod 4. `@orpc/client` is a required peer, and it is already installed with `@orpc/server`. Add the optional peers you use: `@opentelemetry/api`; `ioredis` for the ioredis transport; `@mastra/core` ^1.51; and `hono`, `@orpc/openapi`, `@orpc/zod` and `@orpc/json-schema` for the adapters.

## 2. What moves where

| In-repo file | After |
|---|---|
| `fn.ts`, `bound-call.ts`, `handler-types.ts`, `router.ts` | `createFn` in `lib/fn/index.ts` |
| `pub-sub-fn.ts`, `fn-live.ts` | `createFn({ pubsub })` → `fnLive`, `createPubSub`, `createPublisher`; `streamLiveSnapshots`, `fnLivePatch` from `orpc-fn/live` |
| `../redis` managed client (pub/sub part) | `bunRedisTransport(redisClient)` (lullu) or `ioredisTransport(redis)` (gey-mono) |
| `expected-client-error.ts` | `isExpectedClientError` from `orpc-fn`; add `isApiError` with `createFn({ isExpectedError })` |
| `utils/procedure-meta.ts`, `utils/tool-meta.ts` | `readMeta(procedure)` from `createFn`, or `readFnMeta` |
| `utils/create-mastra-tool.ts` | `createMastraTool` from `orpc-fn/mastra` |
| `external-api.ts` (`listExternalTools`, `toolInputSchema`) | `listTools` and `hasTag` from `orpc-fn/mcp` |
| `use-orpc-hono-handler.ts`, `use-external-api-hono-handler.ts`, `orpc-context-headers.ts` | `mountOrpc` and `normalizeExpoOrigin` from `orpc-fn/hono` |
| `needed-feature-flags.ts`, gey `permission` | guards in `createFn({ guards })`; the check functions stay in the app |
| `FN_SUPPORT_*`, `FN_DRAFT_ACTION`, `FN_AUTOMATION_SAFE`, `FN_CHANNEL_SUMMARY` | typed `createFn({ meta })` |

These stay in the app: `orpc.ts` (context, auth, the procedure builders), `get-auth-filters.ts`, `get-orpc-tenant-scope.ts`, `define-organization-change-bus.ts`, `channel-scope.ts` and `utils/pagination.ts`. The MCP instructions, `authenticateBasic`/`authenticateMcp` and the MCP server itself stay too.

## 3. The new `lib/fn/index.ts` (lullu)

```ts
import * as otel from '@opentelemetry/api'
import { createFn } from 'orpc-fn'
import { bunRedisTransport } from 'orpc-fn/live/redis-bun'
import { isApiError } from 'hanzio/api-wrapper'
import { isExpectedClientError } from 'orpc-fn'
import { publicProcedure, protectedProcedure, supportProcedure } from './orpc'
import { prisma, getPrismaPoolStats } from '../prisma'
import { createJob } from '../queue/create-job'
import { createMessage } from '../message/create-message'
import { createT } from '../i18n'
import { createLogger } from '../log'
import { redisClient } from '../redis'
import { pubsubQueueDropTotal } from '../observability/pubsub-metrics'
import { assertNeededFeatureFlags } from './needed-feature-flags'

export const {
  fn, fnLive, createPubSub, createPublisher, createRouter,
  readMeta, createCall: createBoundCall, drainPubSubSubscribers, activePubSubSubscriberCount
} = createFn({
  procedures: { public: publicProcedure, protected: protectedProcedure, support: supportProcedure },
  default: 'protected',
  tags: ['internal'],
  otel,
  logger: (scope, span) => createLogger({ scope, span }),
  extras: ({ context }) => ({
    prisma,
    createJob,
    createMessage,
    t: context.user ? createT(context.user.locale) : undefined
  }),
  guards: {
    neededFeatureFlags: (flags: FeatureFlag[], { context }) =>
      flags.length ? assertNeededFeatureFlags(flags, context) : undefined
  },
  meta: {} as {
    requiresHumanApproval?: RequiresHumanApprovalFn
    automationSafe?: boolean
    renderKind?: SupportToolRender['kind']
    readOnly?: boolean
    supportTool?: SupportToolLifecycle
    draftAction?: SupportDraftActionDefinition
    channelSummary?: { chat?: string; voice?: string }
  },
  spanAttributes: ({ context }) => ({
    'user.id': context.session?.user.id,
    'support.organization_id': context.support?.organizationId
  }),
  onCompleted: ({ context }) => {
    const pool = getPrismaPoolStats()
    return {
      organization_id: context.user?.activeOrganizationId ?? context.support?.organizationId,
      ...(pool ? { db_pool_total: pool.total, db_pool_idle: pool.idle, db_pool_waiting: pool.waiting } : {})
    }
  },
  isExpectedError: (error) => isExpectedClientError(error) || isApiError(error),
  pubsub: {
    transport: bunRedisTransport(redisClient.getClient()),
    onDrop: (count) => pubsubQueueDropTotal.inc(count)
  }
})
```

gey-mono is the same with `ioredisTransport(redisClient.getClient())`, no `support` procedure, and a `permission` guard:

```ts
guards: {
  permission: (requirement: PermissionRequirements, { context }) => {
    if (!context.user) throw new ORPCError('UNAUTHORIZED', { message: 'Authentication required' })
    context.user.canPermission(requirement)
  }
}
```

## 4. Route files

1. Run the codemod, then review its diff (it is a text rewrite):
   - lullu: `bun ../orpc-fn/scripts/codemods/procedure-option.ts apps/backend/src --flag=isPublic:public --flag=isSupport:support`
   - gey-mono: the same with `--flag=isPublic:public`
   - an app with `auth: 'admin'`-style options: `--rename=auth`

   Flags become `procedure: '<key>'` (`false` is dropped) and renamed options keep their value. This also covers `createPubSub` options.
2. lullu only: five tools pass `summary: { base, chat, voice }`. Change them to `summary: base` and `channelSummary: { chat, voice }`, then read `readMeta(procedure).meta.channelSummary`.
3. Everything else stays: `name`, route options, `neededFeatureFlags`, `permission`, `readOnly`, `supportTool` and the other meta keys, the handler params, and `call`.

## 5. Readers of the old symbols

| Before | After |
|---|---|
| `readFnProcedureMeta(p).operationId` | `readMeta(p).name` |
| `readFnProcedureMeta(p).isSupport` | `readMeta(p).procedure === 'support'` |
| `readFnProcedureMeta(p).readOnly` (and the other support fields) | `readMeta(p).meta.readOnly` |
| `readFnProcedureMeta(p).inputSchema`, `.outputSchema`, `.description`, `.summary` | same names on `readMeta(p)` |
| `requireAgentToolMeta(p)` | `readMeta(p)`, then check `inputSchema` |
| `FN_OPERATION_ID` symbol lookups | `readMeta(p).name` |
| `createBoundCall(context)` in seeders and tests | `createCall(context)` from `createFn`, re-exported as `createBoundCall` if you want no diff |
| `getOperationId(p)` (gey-mono) | `toToolName(readMeta(p).name)` from `orpc-fn/mcp` |

## 6. Live

- **Shutdown:** `drainPubSubSubscribers()` and `activePubSubSubscriberCount()` now come from the `createFn` result, not a module. Call them in the SIGTERM handler and the OTel gauge.
- **Redis connection:** the transport opens its own subscriber connection with `duplicate()`. The old managed client's subscriber half (leases, ref counts, mux handlers) is no longer used.
- **Behaviour fixed:** `fnLive` now runs `authFn` before sending the initial snapshot, parses its input once, and sends snapshots through the output schema. `publish` takes the event schema's input type. A `filterFn` that throws no longer stops delivery to other subscribers. lullu's in-repo copy has all four bugs.
- **Behaviour kept:** per-channel fan-out, backlog replay, the drop-oldest bounded queue with one overflow marker per episode, resubscribe backoff with jitter, `coalesceMs`, `shouldUpdate`, `transformerFn`, patch emits, `mirrorChannel` and `publishMany`.

## 7. HTTP

```ts
mountOrpc(app, {
  router: orpcApiPublicRouter,
  rpcPrefix: ORPC_API_RPC_PATH,
  openapi: { prefix: ORPC_API_OPENAPI_PATH, info: { title: 'Platform API', version: '0.1.0' } },
  plugins: [new CORSPlugin({ allowHeaders: ALLOW_HEADERS })],
  normalizeHeaders: normalizeExpoOrigin,
  queueMs: msSinceRequestArrival,
  onError: (error, request) => captureException(error, 'api-orpc-error', request)
})
```

gey-mono's external API is a second mount with `openapi: { prefix: EXTERNAL_API_PATH, filter: hasTag('external'), smartCoercion: true, spec: { components, security } }`. Its `context` runs `authenticateBasic` and returns a 401 `Response` on failure; the docs paths skip auth. The MCP endpoints keep their SDK server and register `listTools(router, { filter, readOnly })`.

## 8. Frontends

The router type still comes from the backend package as a type-only import. Only the link changes:

| App | Before | After |
|---|---|---|
| Platform (Vue) | `orpc-shared.ts` `createOrpcRpcLink`, `hasOrpcErrorCode` | `createRpcLink`, `hasOrpcErrorCode` from `orpc-fn/client` |
| Expo | `utils/api.tsx` `RPCLink` with the hand-written headers and `expo/fetch` bridge | `createExpoLink({ url, fetch, native, getCookie, getExpoOrigin, headers })` from `orpc-fn/expo` |

`createORPCClient` and `createTanstackQueryUtils` stay as they are. gey-mono's Expo app currently uses the global `fetch` on native, so `createExpoLink` is also what lets its subscriptions stream on native and close when cancelled. lullu's Vue-only helpers (`isOrpcDocumentVisible`, `resolveQueryEnabled`, `useLiveQuery`, `useOrpcSubscription`) stay in the app for now.

## 9. Verify

Run `bun run lint` and `bun test` in the app. The only expected route-file diff is the codemod's.
