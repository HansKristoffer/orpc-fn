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
- **`.meta()`:** used instead of the `FN_*` symbols. `fn()` stores `{ name, procedure, meta }` under one key, `'orpc-fn'`, in oRPC's procedure meta. Unlike a symbol on the procedure object, oRPC's meta survives everything that rebuilds procedures (`os.router()`, `.use()` on a router, prefixes, lazy routers). There is a test for this. `readFnMeta` reads it together with `~orpc` route data, the single place that touches oRPC internals.

## `isPublic`/`isSupport` versus `procedure:`

`fn({ procedure: 'public' })` picks a builder by key. An `isPublic`/`isSupport` alias would mean hard-coding builder names into the library or adding another inferred type parameter to all four overloads. **Decision:** no alias. `scripts/codemods/is-public.ts` rewrites route files mechanically.

## Tags typing

The plan proposed `createFn<{ tags: ... }>()`. TypeScript cannot infer the remaining type parameters once one is given explicitly. **Decision:** tags are typed from a value, `createFn({ tags: ['internal', 'external'] })`, through a `const` type parameter.

## Route summary

lullu passes `summary: { base, chat, voice }` in five files. The library keeps `summary: string` (it is oRPC's route summary). Per-channel text is app meta: declare `channelSummary` in `createFn({ meta })` and move it there during the migration.

## Mastra version

`createMastraTool` returns `Tool<InputSchema, OutputSchema>`, which is how `@mastra/core` 1.51 (lullu) types tools. Mastra 1.0.x typed `Tool<>` with values instead, so the optional peer is `^1.51.0`. gey-mono bumps Mastra during its migration.
