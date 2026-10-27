# Decisions

What oRPC already ships, checked against 1.14.8 (lullu's pin) and 1.15.4 (latest on 2026-10-03), and what this package does on top. The rule: depend on oRPC where it covers the behaviour, keep our own code only where it falls short.

## `@orpc/otel` vs our spans

`@orpc/otel` is an `InstrumentationBase` that registers a global tracer with `@orpc/shared`. oRPC then wraps handling in generic spans such as `call_procedure` and `validate_input`, named by router path.

It does not give us:

- a span named after the route (`fn({ name })`, also the OpenAPI operationId) with `fn.operation`, `fn.procedure`, `fn.duration_ms` and the app's own attributes (`spanAttributes`);
- the `call: <name>` child span for nested calls, which is what makes a trace readable;
- the `fn.completed` wide event, with timing write-back and the expected/unexpected error split.

**Decision:** keep our spans, built through `createFn({ otel })`. They use `startActiveSpan`, so `@orpc/otel`'s spans nest under them when an app enables both. `@opentelemetry/api` stays an optional peer: the root entry never imports it, the app passes the module in, and without it `span` is `undefined` and nothing else changes.

## `@orpc/experimental-publisher` vs `/live`

The publisher is an abstract `Publisher` with memory, ioredis and Upstash adapters. It publishes per event name, resumes through Redis streams (`XADD` plus `lastEventId`), and buffers subscribers with drop-oldest.

It falls short on what lullu and gey-mono rely on:

- no backlog-list replay (`useBacklog`/`backlogSize`/`backlogTtl`) and no atomic publish+backlog;
- no per-subscriber `filterFn` or `authFn`, and no overflow marker, so a dropped event leaves no signal;
- no Bun `RedisClient` adapter (lullu uses it);
- no per-channel fan-out that parses each payload once for every local subscriber;
- it is still `experimental-`.

**Decision:** do not build on it. `/live` defines a small `PubSubTransport` (publish with optional atomic backlog, read backlog, subscribe returning an unsubscribe function) with memory, Bun and ioredis implementations. Revisit when the publisher is stable and supports backlog replay and Bun. Moving would only touch the transports.

## `@orpc/ai-sdk` vs `/mastra` and `/mcp`

`@orpc/ai-sdk` turns a procedure into an AI SDK `Tool` (`createTool`, `implementTool`), reading the summary and schemas.

- **Mastra:** Mastra tools are AI SDK-compatible, but a Mastra `createTool` also carries `requestContext` (where we read the oRPC context), `requireApproval`, and the types behind `InferToolInput`/`InferUITools`. The ai-sdk adapter has none of these, so `/mastra` stays. Apps on plain AI SDK can use `@orpc/ai-sdk` directly. Our meta is in oRPC's `.meta()`, so it composes with its `AI_SDK_TOOL_META_SYMBOL`.
- **MCP:** `@orpc/ai-sdk` does not produce MCP tool definitions (JSON Schema with date coercion, `readOnlyHint`), so `/mcp` stays.

## `@orpc/experimental-durable-iterator`

This targets Cloudflare Durable Objects (hibernation, signed tokens, a Durable Object holding the stream). Our streams run in ordinary servers, with Redis behind them, so it does not apply. **Decision:** not used. The backlog replay in `/live` covers resume for short reconnects.

## `@orpc/server` primitives

- **`call`:** used as is by the bound call (`createBoundCall` only adds the child span, the inherited signal and the context).
- **`createRouterClient`:** not needed. Handlers call procedures one at a time with `call`, which keeps types per procedure.
- **Middleware:** the app's procedure builders stay plain oRPC builders with middleware (auth, context). Guards are not middleware because they need typed per-route options (`fn({ permission })`). oRPC middleware cannot add typed options to the procedure definition.
- **`.meta()`:** used instead of the `FN_*` symbols. `fn()` stores `{ name, procedure, meta }` under one key, `'orpc-fn'`, in oRPC's procedure meta. Unlike a symbol on the procedure object, oRPC's meta survives everything that rebuilds procedures (`os.router()`, `.use()` on a router, prefixes, lazy routers). There is a test for this. `readFnMeta` reads it together with oRPC's route data. All runtime access to oRPC's `~orpc` internals goes through `src/compatibility.ts`, so an upstream change surfaces in one file.

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

oRPC parses a handler's return value through the output schema, so the handler returns the schema's input type and callers receive its output type. The same split applies to pub/sub: publishers pass the event schema's input type; subscribers, filters and channel resolvers receive its output type. The raw event travels in oRPC's own JSON format (`StandardRPCJsonSerializer`, from `@orpc/client`, which `@orpc/server` already depends on) and each receiver parses it once. Payloads without the envelope are read as plain JSON, so mixed versions keep working during a rolling deploy.

## Live subscriptions open eagerly

`fnLive` authorizes and subscribes before it builds the initial snapshot. The earlier pattern, calling the subscribe procedure and then loading the snapshot, sent the snapshot before `authFn` ran (an async generator does not run until its first `next()`). It also missed events published while the snapshot loaded. lullu's in-repo `fn-live.ts` has both problems.

## Client helpers

`orpc-fn/client` and `orpc-fn/expo` hold only what the apps wrote by hand: a batching link that sends subscriptions on their own, and the `expo/fetch` bridge with the Better Auth headers. `createORPCClient` and `createTanstackQueryUtils` are already one line each in `@orpc/client` and `@orpc/tanstack-query`, so they are not wrapped. Expo and React Native are passed in (`fetch`, `native`) rather than imported, so the package has no Expo dependency.

`orpc-fn/vue` and `orpc-fn/react` hold the subscription, live-query and invalidation-stream code hellu wrote once per framework. The connection logic (generation-guarded connects, backoff, reconnect catch-up) is one framework-free core; each subpath is a thin wrapper. Pausing follows TanStack's `focusManager` instead of `document` or React Native's `AppState`, so neither subpath imports a platform module and an app sets the focus source once. The "refetch stale queries on focus" that hellu's coordinator did by hand is TanStack's own `refetchOnWindowFocus`, so it is not repeated. Persisting the cache is TanStack's persister; we only supply oRPC's serializer and the cache-owner reset.

`@orpc/tanstack-query` 1.14 ships `experimental_liveOptions`, a query whose data is the latest event of a stream. For a plain `fnLive` snapshot stream it is enough, and an app can use it directly. `useLiveQuery` stays because the apps also need what it lacks: patch streams folded by `applyEvent`, an HTTP seed that a persisted or server-rendered cache can satisfy, backoff reconnects after a stream ends, and closing streams in hidden tabs.

## Guards return a decision

A guard returned `unknown` and its result was ignored, so `permission: () => false` let the handler run, although the README used exactly that predicate style. **Decision:** a guard returns `void | boolean` (or a promise of one). `false` throws `FORBIDDEN`, `true` or `undefined` allows, and a thrown error keeps its code. Other return values fail in the types and at runtime. Typing the guard as `() => void` alone would not catch this, because TypeScript lets a value-returning function stand in for it.

## Streams are declared, not guessed from the path

The client link used to keep a call out of a batch when its router path contained `subscribe`. A stream mounted as `watch` was batched with ordinary calls and the batch failed. **Decision:** a streaming route says so, with `stream: true` or oRPC's `eventIterator` output schema, and generated live routes declare it themselves. `createStreamManifest` lists the streaming paths of the actual router, aliases and nesting included, as data the client can import without server code. The name heuristic remains only as a fallback.

## `mountOrpc` compresses its own responses

oRPC answers a streaming batch as an event stream with one event per result, sent as each finishes. Hono's `compress()` skips `text/event-stream`, and `CompressionStream` or a default gzip buffer their output, so a fast result would wait behind a slow one. Apps served without a compressing proxy sent their largest responses raw. **Decision:** `mountOrpc` gzips JSON and batch event streams itself (`compress`, on by default) with `node:zlib`, flushing after every chunk. It recognises a batch by the `x-orpc-batch` request header, as `BatchHandlerPlugin` does. Other event streams stay uncompressed: they are long-lived and small. A response that already has a `content-encoding` is left alone, so an outer compressor still wins. Other routes on the app are the app's business (`hono/compress`).

## Route metadata lives in `meta`

Unknown top-level `fn` options used to become metadata, so a typo or a spread object became metadata silently. **Decision:** app metadata goes in `fn({ meta })` and unknown top-level options throw. Guard keys stay at the top level because every route uses them.

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
- A stream keeps the authorization it had when it opened. `reauthorize` checks before updates, and an app that needs immediate revocation closes the affected streams itself.
- `safePublish` suppresses a broker error. It does not retry or make publication durable: reliable notification is an app-owned outbox.
- `shutdown()` closes the transport only with `ownsTransport: true`, because apps share transports. A custom transport that cannot be cancelled may finish initializing after shutdown; its late subscription is released.
- Redis Lua batching targets standalone Redis. Cluster needs its own adapter, a hash-slot contract and integration tests.

## What waits for a consumer

These stay in the app: caching policy, mutation retries, database transactions, rate limits, permissions, feature flags and jobs. These are reasonable additions but wait for a consumer that needs them: a typed `snapshot`/`patch`/`resync` stream envelope, outbox hooks, Redis Cluster support, and disposal of scoped extras.
