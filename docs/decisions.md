# Decisions

What oRPC already ships, checked against 1.14.8 and 1.15.4 (2026-10-03) and again against 2.0.0-beta.53 (2026-11-26, the oRPC 2 move), and what this package does on top. The rule: depend on oRPC where it covers the behaviour, keep our own code only where it falls short.

## `@orpc/opentelemetry` vs our spans

`@orpc/opentelemetry` (`@orpc/otel` before oRPC 2) is an `InstrumentationBase` that registers a global tracer with `@orpc/shared`. oRPC then wraps handling in generic spans such as `call_procedure` and `validate_input`, named by router path.

It does not give us:

- a span named after the route (`fn({ name })`, also the OpenAPI operationId) with `fn.operation`, `fn.procedure`, `fn.duration_ms` and the app's own attributes (`spanAttributes`);
- the `call: <name>` child span for nested calls, which is what makes a trace readable;
- the `fn.completed` wide event, with timing write-back and the expected/unexpected error split.

**Decision:** keep our spans, built through `createFn({ otel })`. An error `isExpectedError` accepts leaves its span with an unset status and no exception event, as OpenTelemetry asks of server spans; `fn.error_code` names it. Its message is written for the caller and often names what they asked for, so it has no place in a trace, and a 404 is not a failed span. They use `startActiveSpan`, so oRPC's spans nest under them when an app enables both. `@opentelemetry/api` stays an optional peer: the root entry never imports it, the app passes the module in, and without it `span` is `undefined` and nothing else changes.

## `@orpc/publisher` vs `/live`

The publisher (`@orpc/experimental-publisher` before oRPC 2) is an abstract `Publisher` with memory, ioredis and Upstash adapters. It publishes per event name, resumes through Redis streams (`XADD` plus `lastEventId`), and buffers subscribers with drop-oldest.

It falls short on what lullu and gey-mono rely on:

- no backlog-list replay (`useBacklog`/`backlogSize`/`backlogTtl`) and no atomic publish+backlog;
- no per-subscriber `filterFn` or `authFn`, and no overflow marker, so a dropped event leaves no signal;
- no Bun `RedisClient` adapter (lullu uses it);
- no per-channel fan-out that parses each payload once for every local subscriber;
- it was still `experimental-` when this was decided. oRPC 2 renamed it `@orpc/publisher` and moved its Redis adapter from ioredis to node-redis; the gaps above were not re-checked in that move.

**Decision:** do not build on it. `/live` defines a small `PubSubTransport` (publish with optional atomic backlog, read backlog, subscribe returning an unsubscribe function) with memory, Bun and ioredis implementations. Revisit when the publisher is stable and supports backlog replay and Bun. Moving would only touch the transports.

## `@orpc/ai-sdk` vs `/mastra` and `/mcp`

`@orpc/ai-sdk` turns a procedure into an AI SDK `Tool` (`createTool`, `implementTool`), reading the summary and schemas.

- **Mastra:** Mastra tools are AI SDK-compatible, but a Mastra `createTool` also carries `requestContext` (where we read the oRPC context), `requireApproval`, and the types behind `InferToolInput`/`InferUITools`. The ai-sdk adapter has none of these, so `/mastra` stays. Apps on plain AI SDK can use `@orpc/ai-sdk` directly. Our meta is in oRPC's `.meta()`, so it composes with its `AI_SDK_TOOL_META_SYMBOL`.
- **MCP:** `@orpc/ai-sdk` does not produce MCP tool definitions (JSON Schema with date coercion, `readOnlyHint`), so `/mcp` stays.

## `@orpc/experimental-durable-iterator`

This targeted Cloudflare Durable Objects (hibernation, signed tokens, a Durable Object holding the stream), and oRPC 2 removed it in favour of `@orpc/hibernation` and `@orpc/cloudflare`. Our streams run in ordinary servers, with Redis behind them, so neither applies. **Decision:** not used. The backlog replay in `/live` covers resume for short reconnects.

## `@orpc/server` primitives

- **`call`:** used as is by the bound call (`createBoundCall` only adds the child span, the inherited signal and the context).
- **`createRouterClient`:** not needed. Handlers call procedures one at a time with `call`, which keeps types per procedure.
- **Middleware:** the app's procedure builders stay plain oRPC builders with middleware (auth, context). Guards are not middleware because they need typed per-route options (`fn({ permission })`). oRPC middleware cannot add typed options to the procedure definition.
- **`.meta()`:** used instead of the `FN_*` symbols. `fn()` stores `{ name, procedure, meta }` under one key, `'orpc-fn'`, in oRPC's procedure meta. Unlike a symbol on the procedure object, oRPC's meta survives everything that rebuilds procedures (`os.router()`, `.use()` on a router, prefixes, lazy routers). There is a test for this. `readFnMeta` reads it together with the route's OpenAPI meta. All runtime access to oRPC's `~orpc` internals goes through `src/compatibility.ts`, so an upstream change surfaces in one file.
- **Typed meta:** oRPC 2 dropped the meta type parameter from `Procedure`, so a route's meta type no longer travels with it. `fn()` adds a type-only optional `'~orpc-fn'` property to the procedure type, which `readMeta(route)` infers from. It never exists at runtime, and oRPC types that rebuild a procedure (`.use()` on a router) drop it, so `readMeta` falls back to untyped meta there.

## Route options without importing `@orpc/openapi`

oRPC 2 removed `.route()`: `path`, `method`, `summary`, `tags` and the operationId are `@orpc/openapi`'s `openapi()` meta plugin, kept under `meta['~openapi']`. `@orpc/openapi` is an optional peer and the root entry imports only `@orpc/server` and `@orpc/contract`. **Decision:** `fn()` writes that key itself with a meta plugin in `src/compatibility.ts` that applies the same merge as `openapi()` for the fields `fn()` accepts (tags concatenate, the rest replace), so a builder's `.meta(openapi({ tags, prefix }))` and a route's options combine as they would in oRPC. `OpenAPIRoute` mirrors the field types. A test reads the result with `getOpenAPIMeta`, so a change to oRPC's key or shape fails there. Making `@orpc/openapi` required would have cost every RPC-only app a peer.

## Stacked schemas

oRPC 2 stacks `.input()` calls (object inputs merge) and pipes `.output()` calls. `createFn` still rejects builders that set a schema, so a `fn()` route has one of each. The tool and CLI adapters need one JSON Schema; a plain oRPC procedure with stacked schemas has no single equivalent, so they throw for it, and `readFnMeta(...).inputSchema` is undefined for it.

## `isPublic`/`isSupport` versus `procedure:`

`fn({ procedure: 'public' })` picks a builder by key. Apps choose builders in their own way (lullu and gey-mono with `isPublic`/`isSupport` flags, the Shopify template with `auth: 'admin'`), and supporting each spelling would mean hard-coding builder names, or adding another inferred type parameter to all four overloads. **Decision:** one option name, `procedure`, for every app.

`default` is optional. An app that wants every route to state its access (the template requires `auth` on every route) leaves it out, and then `procedure` is required on every `fn`, `fnLive` and `createPubSub`, in the types and at startup.

## Tags typing

The plan proposed `createFn<{ tags: ... }>()`. TypeScript cannot infer the remaining type parameters once one is given explicitly. **Decision:** tags are typed from a value, `createFn({ tags: ['internal', 'external'] })`, through a `const` type parameter.

## Route summary

lullu passes `summary: { base, chat, voice }` in five files. The library keeps `summary: string` (it is oRPC's route summary). Per-channel text is app meta: lullu declares `channelSummary` in `createFn({ meta })`.

## Mastra version

Mastra 1.51 accepts any Standard Schema with JSON Schema attached, so `createMastraTool` gives Mastra a schema that checks the procedure's input and passes the raw value on, and a pass-through output schema. The procedure parses the raw input: transforms run during validation and again in the procedure, but never on their own output, which handing Mastra the procedure's own Zod schemas would do. Mastra 1.0.x requires Zod schemas, so the optional peer is `^1.51.0`.

## Schema input and output

oRPC parses a handler's return value through the output schema, so the handler returns the schema's input type and callers receive its output type. The same split applies to pub/sub: publishers pass the event schema's input type; subscribers, filters and channel resolvers receive its output type. The raw event travels in oRPC's own JSON format (`RPCJsonSerializer`, from `@orpc/client`, which `@orpc/server` already depends on) and each receiver parses it once. Payloads without the envelope are read as plain JSON, so mixed versions keep working during a rolling deploy.

oRPC 2 tags serialized types by name (`['date', 'at']`) where oRPC 1 used numbers (`[1, 'at']`), and reads neither the other's tags. Instances on both majors share a broker during a rolling deploy and replay each other's backlogs, so `src/rpc-json.ts` translates: payloads are still written with oRPC 1's numbers (envelope version 2, byte-identical to what orpc-fn on oRPC 1 wrote, which a test pins), and only a type oRPC 1 lacked (`Infinity`) is written with names (version 3), which oRPC 1 instances cannot read. Reading accepts both. RegExp, which oRPC 2 dropped, is kept with a custom handler. `queryCacheSerializer` reads caches persisted under oRPC 1 the same way. A rerun-mode `fnLive` skips a snapshot that serializes the same as the last one it sent, so an organization-wide bus does not resend every subscriber's unchanged list.

## Live subscriptions open eagerly

`fnLive` authorizes and subscribes before it builds the initial snapshot. The earlier pattern, calling the subscribe procedure and then loading the snapshot, sent the snapshot before `authFn` ran (an async generator does not run until its first `next()`). It also missed events published while the snapshot loaded. lullu's in-repo `fn-live.ts` has both problems.

## Client helpers

`orpc-fn/client` and `orpc-fn/expo` hold only what the apps wrote by hand: a batching link that sends subscriptions on their own, and the `expo/fetch` bridge with the Better Auth headers. `createORPCClient` and `createTanstackQueryUtils` are already one line each in `@orpc/client` and `@orpc/tanstack-query`, so they are not wrapped. Expo and React Native are passed in (`fetch`, `native`) rather than imported, so the package has no Expo dependency.

`orpc-fn/vue` and `orpc-fn/react` hold the subscription, live-query and invalidation-stream code hellu wrote once per framework. The connection logic (generation-guarded connects, backoff, reconnect catch-up) is one framework-free core; each subpath is a thin wrapper. Pausing follows TanStack's `focusManager` instead of `document` or React Native's `AppState`, so neither subpath imports a platform module and an app sets the focus source once. The "refetch stale queries on focus" that hellu's coordinator did by hand is TanStack's own `refetchOnWindowFocus`, so it is not repeated. Persisting the cache is TanStack's persister; we only supply oRPC's serializer and the cache-owner reset.

`@orpc/tanstack-query` ships `liveOptions` (`experimental_liveOptions` before oRPC 2), a query whose data is the latest event of a stream. For a plain `fnLive` snapshot stream it is enough, and an app can use it directly. `useLiveQuery` stays because the apps also need what it lacks: patch streams folded by `applyEvent`, an HTTP seed that a persisted or server-rendered cache can satisfy, backoff reconnects after a stream ends, and closing streams in hidden tabs.

## Guards return a decision

A guard returned `unknown` and its result was ignored, so `permission: () => false` let the handler run, although the README used exactly that predicate style. **Decision:** a guard returns `void | boolean` (or a promise of one). `false` throws `FORBIDDEN`, `true` or `undefined` allows, and a thrown error keeps its code. Other return values fail in the types and at runtime. Typing the guard as `() => void` alone would not catch this, because TypeScript lets a value-returning function stand in for it.

## Streams are declared, not guessed from the path

The client link used to keep a call out of a batch when its router path contained `subscribe`. A stream mounted as `watch` was batched with ordinary calls and the batch failed. **Decision:** a streaming route says so, with `stream: true` or oRPC's `eventIterator` output schema, and generated live routes declare it themselves; an `async function*` handler without it throws when the route is defined. On the client the caller knows best: the Vue and React helpers open streams with `streamCall` as the client context (a `Symbol.for` key, so copies agree), and `createRpcLink` never batches such a call. oRPC 2's batch can carry streams, but its default `buffered` mode would hold the whole batch until a live stream ends, so streams stay out and batches use `streaming` mode. `createStreamManifest` lists the streaming paths of the actual router, aliases and nesting included, for streams opened without a helper. The name heuristic remains only as a fallback.

## HTTP adapters: oRPC's handlers, one shared core

`orpc-fn/fetch`, `orpc-fn/node` and `orpc-fn/hono` build oRPC's own runtime handlers (`@orpc/server/fetch` and `/node`, `@orpc/openapi/fetch` and `/node`), so request parsing, a body Express already parsed, abort on disconnect and streaming stay oRPC's. `src/http/mount.ts` holds what they share: options, the per-request context, the plugin list (`BatchHandlerPlugin`, `ResponseHeadersHandlerPlugin`, the OpenAPI plugins) and error reporting. Server-Timing and the SSE anti-buffering headers are a plugin on oRPC's standard response, outermost (initialized after `~cors`, `~batch` and `~response-headers`, since each plugin prepends its routing interceptor), so both runtimes get them before anything is written. Hono reuses the Fetch core as middleware.

`ResponseHeadersHandlerPlugin` is always on: a procedure that does not declare `resHeaders` never sees it, and one passed in `plugins` is not added twice. Headers a batched call sets stay on its batch item, which is oRPC's behaviour.

## Errors carry no status

oRPC 2 removed `ORPCError`'s `status`: a handler maps codes with `errorStatusMap` (its common map otherwise) and answers codes it does not know with 400, where oRPC 1 used 500. **Decision:** `isExpectedClientError` classifies by the status oRPC would answer with, so an unknown code counts as expected, matching what the client receives. The HTTP adapters take `errorStatusMap`, merged over oRPC's common map because oRPC replaces it, and classify `onError` under it. The factory remembers only its app's own `isExpectedError` decisions, so the default rule is re-applied by each adapter under its map rather than frozen at the route.

## The adapters compress their own responses

oRPC answers a streaming batch with one frame per result (`application/vnd.orpc.batch` since oRPC 2, an event stream before), sent as each finishes. A compressor that buffers its output (`CompressionStream`, a default zlib stream) makes a fast result wait behind a slow one, and Hono's `compress()` and oRPC 1's `CompressionPlugin` skipped event streams altogether. oRPC 2's `ResponseCompressionHandlerPlugin` was not re-evaluated. Apps served without a compressing proxy sent their largest responses raw, and a Vercel function must stay under its response size limit. **Decision:** the adapters compress JSON and batch event streams themselves (`compress`, on by default) with `node:zlib`: brotli at quality 4 (about gzip's speed, smaller output) unless the client prefers or only accepts gzip, flushing after every chunk. A batch is recognised by its content type. Event streams stay uncompressed: they are long-lived and small. A response that already has a `content-encoding`, or says `no-transform`, is left alone, so an outer compressor still wins.

On Fetch the adapter compresses the finished `Response`. On Node, oRPC writes straight to `res` (status and `setHeader`, then `end(body)` or a piped stream), so the adapter wraps `write` and `end` around its own `handle(req, res)` call for that one response and decides on the first call, when the headers are known. oRPC 2 removed the adapter interceptors this used to hook into. Because of `node:zlib`, Cloudflare Workers need `nodejs_compat`.

## Zod 3.25 is a peer, through `zod/v4`

`zod@3.25` exports Zod 3 at `zod` and Zod 4 at `zod/v4`; in `zod` 4, `zod/v4` is the same module as `zod`. Core schemas are Standard Schema, so Zod 3 schemas work in `fn`. Our own Zod use (live schema types, the CLI's `.meta()`, the bin) imports `zod/v4`, so it means Zod 4 under either major; with `zod` it would load Zod 3 on 3.25, where `z.core` and `.meta()` do not exist. The JSON Schema conversion (`@orpc/zod`, which in oRPC 2 asks for `zod` 4.5 or later) reads Zod 4 only, so live, tool and OpenAPI-spec schemas are Zod 4 schemas, and the tool and OpenAPI adapters need `zod` 4.5 installed. The packed consumer check runs core routes on 3.25 and the adapters on 4.5. `orpc-fn/cli` needs `zod` 4 installed, because `hanzio/cli`'s types import `zod`.

## Exposure and access are explicit

`mountOrpc`'s OpenAPI mount used to publish every route when its optional `filter` was left out, which the README example did. A pub/sub definition without `authFn` let through anyone who passed its procedure builder, and a bus meant only for the server was one router line away from that. **Decision:** `openapi.filter` is required (on every HTTP adapter), as `registerMcpTools`'s already was; `() => true` says "everything". `createPubSub` requires `authFn`; `true` says "anyone". A scoped change bus defaults it to `true`, because its scope, read from the context, is the access decision. The server reads a bus with `listen`, which needs no route. The OpenAPI modules load on the first request to the prefix, so an RPC-only app does not install those peers.

## Tools tell the model what it can fix, and nothing else

The tool adapters sent any error's text to the model: a database or provider message reached its context, and validation issues lost their paths. **Decision:** an expected error (`isExpectedClientError`, which includes what the route's factory classified as expected) reads `CODE: message` plus `path: message` per validation issue; anything else reads as a fixed sentence and goes to `onError`. Both adapters share the rule. `formatError` replaces the text for an app with its own policy. The factory remembers its classification per error object, so `mountOrpc` and the adapters agree with `isExpectedError` without being passed it; two installed copies of the package do not share that memory.

## Route metadata lives in `meta`

Unknown top-level `fn` options used to become metadata, so a typo or a spread object became metadata silently. **Decision:** app metadata goes in `fn({ meta })` and unknown top-level options throw. Guard keys stay at the top level because every route uses them. Their values are stored in the route's meta too (`readMeta(route).guards`), and `routePolicy` sees them when a route is defined, so an app can require a guard decision on every route of a procedure without a source-grep audit. Requiring it in the types was left out: it would add a conditional to every `fn` overload, which the type-performance budget and readable errors argue against, and the definition-time throw fails at import.

## One execution policy, and completion tells the truth

Pub/sub subscriptions used to skip guards, extras and completion logging. Completion was logged before oRPC's output validation, so a failed call could log `success`. A logger that threw turned a successful call into a failure. **Decision:** every route kind runs the same execution middleware, and completion observes the final outcome, including auth, input and output failures and the stream's lifetime. Hook, logging and subscriber failures are isolated: they never replace a procedure's result or error, and custom log fields cannot overwrite the canonical status, name or duration.

## Tool schemas

The core accepts any Standard Schema, oRPC's own `eventIterator` included. Executable tools (MCP, Mastra) need JSON Schema, so they go through the Zod to JSON Schema conversion in `@orpc/zod`. A widened core does not promise that every validator works with every adapter. Validation and execution can both parse the raw tool input, so transforms and refinements must be pure.

## `trpc-cli` vs `/cli`

`trpc-cli` builds a CLI from an oRPC router, but it reads command metadata from oRPC's top-level `meta` (where `fn()` keeps its own record under one key) and route descriptions do not reach it, it calls procedures with one static context, and it is a second CLI style beside the one our library bins use. **Decision:** `/cli` maps opted-in routes to `hanzio/cli` commands, which own parsing, help, completion and exit codes; this package only reads `fn()` meta and calls the procedure.

The `orpc-fn` bin is built on `hanzio/cli` too, and a bin cannot sit behind an optional peer: it must run in an app that installed only the required peers. **Decision:** `hanzio` is a dependency, not a peer. It has no dependencies of its own and `hanzio/cli` needs only `node:util` and `zod`, which is already a required peer; the cost is its ~1.1 MB unpacked package. Commands are recognised across copies, but `CliError` is matched with `instanceof`, so an app using `/cli` should resolve to the same `hanzio` copy (a matching major dedupes).

## Limits of live delivery

These limits are deliberate; changing one needs a consumer that requires it.

- Replay is capped and expires. It covers short reconnects, not durable resume.
- Event IDs deduplicate overlap between backlog and live delivery. They do not give exactly-once delivery or snapshot/delta consistency, so full-snapshot invalidation is the default. Reducers must use revisions or be idempotent ([example](../examples/adoption/revisions.ts)).
- After a lost connection or a queue overflow, live queries reload a snapshot. Raw event streams throw `SERVICE_UNAVAILABLE` instead of continuing with a silent gap.
- A stream keeps the authorization it had when it opened. `reauthorize` checks before updates; `maxStreamAgeMs` bounds how long that lasts by ending streams, which the client helpers reopen with a fresh context. Immediate revocation closes the affected streams in the app.
- `safePublish` suppresses a broker error. It does not retry or make publication durable: reliable notification is an app-owned outbox.
- `shutdown()` closes the transport only with `ownsTransport: true`, because apps share transports. A custom transport that cannot be cancelled may finish initializing after shutdown; its late subscription is released.
- Redis Lua batching targets standalone Redis. Cluster needs its own adapter, a hash-slot contract and integration tests.

## What waits for a consumer

These stay in the app: caching policy, mutation retries, database transactions, rate limits, permissions, feature flags and jobs. These are reasonable additions but wait for a consumer that needs them: a typed `snapshot`/`patch`/`resync` stream envelope, outbox hooks, Redis Cluster support, and disposal of scoped extras.
