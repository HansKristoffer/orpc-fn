# orpc-fn: review and adoption plan

Reviewed on 2026-10-03 against `0.1.0`, commit `81638d5`. This review covers the library, public exports, adapters, examples, tests, and package checks. The consuming projects have not been changed or independently audited for this review.

## Implementation status — 2026-10-03

The library changes for R1–R11 are implemented and verified locally. The numbered findings below retain the original baseline evidence and design rationale; they describe the reviewed `81638d5` implementation, not the current working tree. [Migration guidance](migration.md) and [runnable examples](../examples/adoption/README.md) describe the final API.

| ID | Status | Implemented contract |
| --- | --- | --- |
| R1 | Complete | Guards return void/boolean; false denies; unsupported results fail types and runtime. Guard configuration is checked. |
| R2 | Complete | Explicit `stream: true` or native iterator schemas; runtime consistency checks; serializable actual-path manifests, including async lazy-router resolution; client batch exclusion. |
| R3 | Complete | Optional `orpc-fn/mcp/sdk` registration against SDK 1.32.0, explicit selection, typed required context, cancellation and result formatting. Mastra object unions work; streams/collisions reject; identical aliases deduplicate. |
| R4 | Complete | Successful, timed, cancellable subscription readiness; wire v2 event IDs with legacy decoding; bounded replay deduplication; reconnect/overflow recovery. Default invalidation reloads snapshots; revisions and reauthorization remain application policies with a worked example. |
| R5 | Complete | Bounded ingress, replay, delivery and coalescing. Factory defaults and per-definition queue overrides; typed safe `onMetric` events for depth, drops, reconnection and parse failures. One invalidation rerun per batch; all reducer events and ordered patches retained. |
| R6 | Complete | Core uses upstream schema inference; native iterator validation, metadata and merged error maps preserved. Handlers receive `errors`/`lastEventId`; reducer state and patch schemas are required at types/runtime. Generated live subscriptions install local errors too. |
| R7 | Complete | Typed library metadata namespace; readers infer the passed procedure's metadata and builder key; `defineMeta<T>()` declares the contract without defaults. |
| R8 | Complete | Procedure-correlated hooks, completion context discrimination, inferred scoped extras, safe bound calls and error predicates, typed Hono plugins/spec. Scoped extras replace shared keys in both types and runtime. One factory adaptation bridge; compatibility access is centralized. |
| R9 | Complete | Separate route normalization/assembly; all generated subscriptions use the common execution policy. Completion covers auth/input/output failures and stream lifetime. Logging/tracing/hooks cannot replace authoritative outcomes or canonical log attributes. |
| R10 | Complete | Separate required-input tenant channel resolvers and consistent namespaces; generic Expo bridge plus named Better Auth preset, async headers and web fetch override; reusable Fetch header finishing. |
| R11 | Complete | Namespaced route metadata, rejection of unknown options, terminal awaitable shutdown and explicit transport ownership; library-owned request timing; AST codemods and packed runnable adoption examples. |

Milestones 1–3 are complete. Milestone 4 (a pilot in consuming projects) remains pending: no external application has been migrated or audited, and no version has been published. Keep the P2 additions conditional on actual consumer requirements. Stream manifests and tool collision checks from the proposed startup-validation addition are already included; a broader startup audit is still optional.

Remaining limits are deliberate: replay is capped and expiring; event IDs do not establish exactly-once delivery or snapshot/delta consistency; reducers need revisions/idempotence. Idle streams retain their opening authorization. Applications own durable publication, tenant policy and immediate revocation. A noncancellable custom transport may finish initialization after shutdown; its late subscription is released. Redis Cluster needs a separate adapter/slot contract and integration coverage. Executable tools use the documented Zod/JSON Schema conversion boundary; the wider core schema contract does not promise every validator works with every adapter.

## Original recommendation

Keep the central design: one `createFn` per application, ordinary oRPC procedure builders for authentication and context, typed dependency injection, and optional adapters. It is a useful abstraction with a clear identity.

Before adoption, fix the authorization contract, explicit streaming support, MCP integration, and live-query consistency. Then strengthen the public TypeScript contracts and share the execution pipeline across route kinds. Make the breaking API decisions during `0.x`, while migration is still inexpensive.

Be opinionated about lifecycle, validation, authorization, cancellation, and error handling. Give projects explicit extension points for context, services, schemas, transports, and presentation. Keep database, auth-provider, permission vocabulary, jobs, and application transactions owned by the application.

## What is already worth preserving

- The selected procedure determines the handler context, including middleware narrowing.
- Nested calls check the callee's required context and inherit cancellation.
- Schema input and output are separated correctly: handlers return output-schema input; callers receive parsed output.
- Async extras work, and discriminated unions of extras retain useful narrowing.
- Metadata uses oRPC's own storage and survives router rebuilding.
- Optional integrations have separate entry points; the root works without their peers.
- Per-channel fan-out, bounded subscriber delivery, Redis connection generations, and streaming span lifetimes already have meaningful tests.
- Packed consumers, minimum dependency versions, NodeNext/Bundler resolution, and the TypeScript version floor are already checked. Extend this coverage instead of introducing another testing framework.

## Priorities

`P0` means fix before adopting the affected feature. `P1` means settle before broad migration and API stabilization. `P2` means add when a consuming project provides a concrete requirement.

| ID | Priority | Recommendation | Reason |
| --- | --- | --- | --- |
| R1 | P0 | Give guards an enforced denial contract | A permission check returning `false` currently permits execution. |
| R2 | P0 | Identify streaming routes explicitly | A stream with an ordinary router name fails when batched with another call. |
| R3 | P0 for MCP; P1 for Mastra | Verify adapters against their actual SDKs | The documented MCP registration fails; valid object unions fail Mastra construction. |
| R4 | P0 for live queries | Define connection, replay, and snapshot consistency | Initial connection failure can look successful; replay and snapshot races can apply events twice. |
| R5 | P1 | Bound the entire event pipeline and implement real coalescing | Subscriber bounds leave upstream queues unbounded; coalescing still performs every update. |
| R6 | P1 | Use oRPC schema types throughout the core | `fn` rejects oRPC's own `eventIterator` output schema. |
| R7 | P1 | Derive metadata types from the procedure | A factory can incorrectly type metadata from another factory. |
| R8 | P1 | Improve context correlation and public type helpers | Hooks lose procedure/context relationships; some helpers erase useful safety. |
| R9 | P1 | Share execution and make observability reliable | Pub/sub bypasses the fn wrapper; completion can report success for failed output validation. |
| R10 | P1 | Separate project-specific assumptions from generic adapters | Channel resolution and Expo authentication carry assumptions that limit reuse. |
| R11 | P1 | Clarify route options, lifecycle, and migration ergonomics | Unknown options become metadata; shutdown and configuration contracts need clearer boundaries. |

## R1 — Enforce guard results

**Evidence:** [guard type](../src/types.ts), [execution](../src/create-fn.ts), and the permission example in [README](../README.md). `Guard` returns `unknown`; the executor awaits it and discards the result. A probe with `permission: () => false` returned `"HANDLER RAN"`. The README uses precisely this predicate style.

**Change:** define one explicit result contract: `MaybePromise<void | boolean>`. `false` throws `FORBIDDEN`; `true` or `undefined` allows execution; thrown errors propagate. Reject unsupported result values, and constrain inferred guard return types so an accidental number, object, or string is a compile error. A bare `() => void` signature alone is insufficient because TypeScript allows value-returning functions to be assigned to it.

Keep existing assertion-style guards working. Make the README show both supported forms and specify the order in which multiple guards run. Validate configured guards at startup.

**Acceptance:** synchronous and async `false` block the handler; thrown errors retain their code; guards returning unsupported values are rejected by types and runtime; guards omitted from a route retain their documented behavior.

## R2 — Make streaming a declared contract

**Evidence:** [client batching](../src/client.ts) identifies streams through a router path containing `subscribe`. A stream mounted as `watch` works alone, but `Promise.all([client.watch(), client.health()])` produces `Internal Server Error` through one batch request. Both work with `batch: false`.

**Change:** record whether a procedure streams and expose a small client-safe manifest of streaming router paths. Let `createRpcLink` use that manifest while retaining `batch.exclude` as an escape hatch. Automatically mark `fnLive.subscribe` and pub/sub subscriptions. Support ordinary streaming `fn` routes through an explicit streaming declaration or an oRPC event-iterator output schema.

A manifest should follow actual router paths, including nesting and aliases, and contain no server implementations, services, or credentials. Generate it at router assembly or build time. Reject inconsistent declarations during validation.

Document the current naming requirement and batching workaround until this is implemented.

**Acceptance:** streams named `watch`, `events`, or `live` work alongside parallel ordinary calls; only ordinary calls are batched; cancellation still closes streams; importing the manifest into a frontend brings in no server runtime.

## R3 — Make tool adapters executable and accurately typed

**Evidence:** [MCP definitions](../src/mcp.ts) return a custom Standard Schema as `config.inputSchema`. The locally installed `@modelcontextprotocol/sdk` **1.32.0** expects a Zod schema or raw shape for `McpServer.registerTool`. The README registration produces a TypeScript error and throws at runtime: `inputSchema must be a Zod schema or raw shape, received an unrecognized object`.

The callback shown in the README also needs to convert a procedure result into an MCP `CallToolResult`; arbitrary procedure results do not universally satisfy that protocol. Existing tests inspect definitions and call procedures directly without completing this SDK integration.

**Change:** keep schema inspection reusable, and add an adapter for an explicitly supported MCP SDK version behind an optional entry point. Use the SDK's supported registration mechanism, or its lower-level JSON Schema handlers when that is the appropriate boundary. Handle validation, context resolution, abort signals, and MCP result formatting together. Provide a default JSON/text result formatter and a typed override for application presentation.

Preserve the association between each procedure and its input, output, and required context in a generic adapter. Avoid exposing an execution API that quietly erases everything to `AnyProcedure`. Require explicit tool selection when registering a router, and reject unsupported streaming procedures unless their handling is deliberately defined.

**Mastra follow-up:** [createMastraTool](../src/mastra.ts) checks only whether the top-level JSON Schema has `type: 'object'`. A Zod discriminated union of object inputs passes the TypeScript check but throws at construction because its JSON Schema uses a union. Support valid object unions, or enforce a matching, documented restriction in the types.

**Names:** detect collisions after sanitization. `order.get` and `order-get` become the same tool name; existing MCP tests even accept duplicate names for aliased procedures. Deduplicate identical aliases deliberately, and require overrides or throw a useful error for distinct colliding procedures.

Keep raw-input versus parsed-output behavior. The two input validation passes are already documented; require pure transforms/refinements and verify the actual validation-plus-execution path, including date coercion. Tests named “transforms run once” currently call `execute` directly and do not establish that guarantee for the complete Mastra path.

**Acceptance:** a packed consumer registers tools with the real SDK, lists and invokes them, obtains a valid result, and forwards cancellation. Cover object unions, dates, transforms, missing input, name collisions, authorization errors, and unsupported streams. The documented example must compile without casts.

## R4 — Define live-query consistency and recovery

**Evidence:** [subscription readiness and replay](../src/live/pub-sub.ts), [snapshots and reducers](../src/live/fn-live.ts).

Three behaviors were reproduced:

1. If the first broker subscription fails, `ready` still resolves and `fnLive` sends its initial snapshot with **zero broker listeners**. It can miss changes before a retry succeeds.
2. A message published during backlog loading is delivered once from the backlog and again from the live buffer.
3. If the initial database snapshot already includes a queued write, a delta transformer applies that write again. A probe produced snapshots `{ total: 1 }`, then `{ total: 2 }`, while the actual state remained `1`.

Automatic reconnect currently restores delivery but provides no built-in indication that events may have been lost. A capped, expiring backlog also cannot promise complete resume.

**Change:** distinguish successful subscription readiness from a completed failed attempt. Give initialization a bounded, abortable timeout and surface unavailability when the subscription cannot be established. After connection loss or queue overflow, trigger an explicit recovery path: live queries reload a full snapshot; event feeds signal a typed gap or require consumers to reconnect and resync.

Add stable event IDs to a versioned wire envelope for deduplicating overlap between backlog and live delivery. Preserve the existing payload decoder for rolling deployment compatibility, with clearly documented weaker guarantees for legacy events.

Event IDs alone do **not** solve the snapshot race. Make full-snapshot invalidation the default live-query mode. For reducers/patches, require idempotent application or application-owned revisions linking events to snapshots. Provide a worked example using the existing `shouldUpdate` hook to reject events whose revision is already represented by `previous`.

Make authorization lifetime explicit. Middleware, guards, and `authFn` currently authorize opening the stream; repeated snapshots call the raw handler. Choose and document a policy for access revocation during a stream, with a reauthorization hook if a project needs it. Restrict `rerun` to the current subscription input by default; an input-changing rerun must not bypass validation and authorization for the new scope.

**Acceptance:** broker startup failure does not advertise a healthy subscription; reconnect and overflow recover current state; replay overlap is deduplicated; reducer examples handle the snapshot race; abort interrupts initialization. Document best-effort delivery and replay limits without promising exactly-once delivery.

## R5 — Bound upstream work and implement coalescing

**Evidence:** [hub parsing and backlog staging](../src/live/pub-sub.ts) explicitly contain unbounded queues. The `parsing.then(...)` chain retains raw messages while an async schema lags; `replaying` grows while backlog loading waits. [streamLiveSnapshots](../src/live/fn-live.ts) collects a batch, then applies and yields every event.

A probe with three immediate events and `coalesceMs: 50` performed **three applications** and emitted `[0, 1, 3, 6]`. For the default live query, that means three handler/database reruns despite the coalescing window.

**Change:** bound raw ingress, replay staging, and subscriber delivery. Define the drop/recovery policy at each stage and expose queue depth, drops, reconnects, and parsing failures through a small metrics/event interface. Ensure a failing metric hook cannot reject the hub's promise chain and stop later delivery.

For invalidation mode, coalescing should perform one snapshot rerun per window. For reducer mode, process every accepted event in order, then emit the final accumulated state once. Define patch handling explicitly; preserve ordered patches or provide a batching reducer, since keeping only the last patch can discard changes.

Validate queue sizes, backlog sizes/TTL, and timing options as finite values in their allowed ranges. Permit per-definition queue settings where different event rates justify them, with factory defaults.

**Acceptance:** sustained load with a deliberately slow async schema and backlog read keeps all queues within their bounds; overflow invokes recovery; an invalidation burst causes one rerun; reducer events are all applied; metrics failures do not interrupt fan-out.

## R6 — Strengthen schema and procedure types

**Evidence:** [Fn overloads and procedure types](../src/types.ts) constrain schemas to `ZodType` despite returning native oRPC procedures. A compile probe using `output: eventIterator(z.object({ n: z.number() }))` fails because oRPC's schema is a Standard Schema, not a Zod type.

**Change:** use oRPC's `Schema`/`AnySchema`, `InferSchemaInput`, and `InferSchemaOutput` in the core overloads. Keep the existing four useful inference cases and their readable diagnostics. This directly supports oRPC's own iterator schemas and leaves an extension point for other Standard Schema validators.

Retain Zod 4 as the documented default and as the default JSON Schema converter. Live/tool features can require a suitable converter or object-compatible schema explicitly; widening the core must not imply that every adapter supports every validator automatically.

Validate streamed values through an actual iterator schema when one is declared. Generated stream types must match the wire contract, including patch payloads. Today `fnLive` validates rerun snapshots, but a transformer can emit `{ n: -1 }` despite `output: z.object({ n: z.number().min(0) })`; this was reproduced. Define a schema for domain state and, when patches are enabled, a separate emitted-payload schema. Validate already-parsed state without reapplying transforming output schemas to their own output.

Preserve the builder's initial/current contexts, declared error map, and existing metadata through these changes. Add explicit type assertions for those properties, since current consumer tests emphasize input/output inference more heavily.

Expose oRPC's typed `errors` constructors to handlers and preserve `lastEventId` for custom resumable streams; the wrapper currently drops both native handler fields. Allow route-local error declarations through oRPC's own `.errors()` mechanism, merging them with the selected builder's error map. This gives endpoints precise error-data contracts without requiring a new procedure builder for each error combination.

**Acceptance:** oRPC iterator schemas compile and validate yields; transforms retain raw-input/parsed-output separation; bad outputs and patches are rejected; declared errors check their data at the handler boundary; native error and metadata types survive; the public declarations pass under TypeScript 5.7 and the current supported version.

## R7 — Make metadata types follow their source

**Evidence:** [FnFactory.readMeta](../src/create-fn.ts) accepts any procedure but returns the calling factory's metadata type. A procedure from factory B with `risk: 123` can be read through factory A as `'low' | 'high' | undefined`, with no TypeScript error. Runtime returns `123`.

**Change:** include typed library metadata in the returned procedure's oRPC metadata type. Infer `readFnMeta`/`readMeta` from the procedure being read. Preserve its procedure key and application metadata shape. Native or unrecognized procedures should have an appropriately unknown/absent metadata result.

Make factory-owned APIs require compatible procedures when compatibility matters. An explicitly typed fallback reader should visibly require validation or an assertion; the default API must not make an automatic claim about a foreign factory's metadata.

Replace the ambiguous type-witness pattern `meta: {} as AppMeta` with a small helper such as `defineMeta<AppMeta>()`, or clearly name the declaration as a type contract. Document that it declares allowed metadata and does not supply runtime defaults.

**Acceptance:** reading foreign incompatible metadata is correctly inferred or rejected; native procedures remain readable; optional/required fields are represented honestly; router rebuilding and lazy/prefixed routers preserve the typed namespace.

## R8 — Improve context correlation and remove accidental type erasure

**Evidence:** [factory hooks](../src/create-fn.ts), [handler/guard parameters](../src/types.ts), and [BoundCall](../src/bound-call.ts).

Handlers narrow by the selected builder, but factory hooks receive a context union and `procedure: string` independently. Testing `procedure === 'protected'` cannot narrow that context. Extras also have one return type for every procedure, so an authenticated-only translator remains optional even in protected handlers.

**Changes:**

- Model hook parameters as a mapped discriminated union: `{ procedure: K; context: CurrentContextOf<Procedures[K]>; ... }` for each configured key.
- Add optional per-procedure extras, alongside shared extras, with return types selected by the route's procedure key. A registry such as `extrasByProcedure` should infer both callback context and handler extras without manual generic arguments.
- Reject extras that shadow built-in handler parameters, with useful diagnostics, rather than silently omitting their declared keys.
- Require an explicit context type when spelling `BoundCall`; its current `any` default erases the protection supplied by `createCall`.
- Mirror oRPC's conditional call arguments so `call(noInputProcedure)` is allowed while required input remains mandatory. Current bound calls require a redundant `undefined` argument.
- Type live callback `previous` as the initialized state once the initial snapshot has succeeded; these callbacks currently receive an unnecessary `TOutput | undefined` type.
- Give input-dependent permission checks a route-local typed policy/resolver. Factory-wide guards correctly use `input: unknown` today, but resource checks should have a way to use the selected route's parsed input without assertions.
- Make `hasOrpcErrorCode` a real generic type predicate. It currently returns `boolean`, so `error` remains `unknown` inside the successful branch. Narrow the code and error class, while leaving error data unknown unless a procedure/error schema justifies a stronger claim.
- Type Hono plugins against the router context and OpenAPI spec overrides against the upstream spec type instead of `any`/`Record<string, unknown>` where those public contracts can be checked.
- Consolidate unavoidable assertions at small internal adaptation boundaries. Replace broad `as never` factory assignments with auditable runtime interfaces and a narrow overload-to-runtime bridge. Use upstream inference helpers where available.

Keep the common call `fn({ input, handler })` entirely inferred. Measure TypeScript instantiations and editor/check time on a representative large router before and after these changes; an elaborate generic API can be less usable even when it accepts more cases.

**Acceptance:** hook narrowing follows the procedure key; protected-only extras are required on protected handlers and absent/optional where appropriate; incorrectly scoped calls and invalid guard/input combinations fail; custom logger/span types remain intact; common usage needs no casts or explicit type arguments.

## R9 — Share execution and make completion truthful

**Evidence:** [fn wrapper](../src/create-fn.ts), [pub/sub route construction](../src/live/pub-sub.ts), [tracing settlement](../src/otel.ts), and [Mastra finish hooks](../src/mastra.ts).

`createPubSub.subscribe` uses `buildProcedure` directly, so it retains builder middleware but bypasses fn guards, extras, and the completion wrapper. It does not accept the factory's guard/meta options. `fnLive` runs the snapshot handler directly inside its subscription and copies guards, but drops application metadata from the generated subscribe route.

The completion boundary also precedes oRPC output validation. A handler returning `1` for `z.number().min(10)` logs `fn.completed` with `status: 'success'`, while the call fails with `Output validation failed`. A logger whose `info` method throws changes a successful return of `42` into a rejected call; this was reproduced.

**Change:** separate route normalization, procedure assembly, execution policy, and observability into focused internal modules. Use one execution policy for ordinary routes and subscription routes. Support guard/meta declarations consistently, and decide explicitly which metadata a generated live route inherits, including whether it is eligible for tool exposure.

Use supported oRPC middleware/interceptors to observe the actual validation/execution outcome at the appropriate boundary. Distinguish handler readiness time, final procedure result, and stream lifetime. Include auth/input/output validation failures in the documented lifecycle where it claims to represent a complete call.

Make telemetry hooks and logging unable to replace procedure outcomes. Report hook failures through a guarded fallback. Keep guard/handler failures authoritative. Protect fan-out from individual subscriber callbacks and observability failures, and avoid allowing custom log fields to overwrite canonical status/name/duration fields.

Keep access to `~orpc` behind a small compatibility module; it is currently spread across types, factory construction, metadata readers, and adapters. This makes upstream compatibility changes easier to test and audit.

**Acceptance:** failed output validation is never reported as final success; all route kinds follow their declared guard/hook policy; hook/logger failures preserve the original result/error; one subscriber's failure does not poison a channel; stream completion still occurs once.

## R10 — Remove project-specific coupling from extension points

### Live channels

[ChannelDefinition](../src/live/pub-sub.ts) takes `Partial<Input> | Partial<Event>` plus optional context. Subscription resolution supplies context; publishing does not. A tenant available only in context cannot reliably determine both sides, and required channel keys are unnecessarily optional.

Introduce separate typed resolvers: a subscription channel from `{ input, context }`, and a publishing channel from the parsed event. Keep static channels and provide a shared-key helper for the common case. Make the publishing event carry the information needed to select its channel, or provide an explicitly typed publishing scope.

Provide an application/environment namespace applied consistently to channels, mirrors, and backlog keys. This prevents unrelated projects sharing Redis from colliding. Tenant selection and tenant authorization stay in the application, with a worked example using both resolvers.

### Expo and HTTP

[Expo](../src/expo.ts) usefully injects the fetch implementation, but automatically sends Better Auth-specific headers on native, restricts headers to a synchronous callback, and ignores the supplied fetch on web.

Separate the generic native streaming bridge from a named Better Auth Expo preset. Preserve the existing behavior through that preset. Accept upstream header resolver types, including async/context-aware authentication, and provide an explicit web fetch override. Keep body and abort forwarding mandatory.

Keep [Hono](../src/hono.ts) as a convenient preset over Fetch-based oRPC handlers. Factor reusable handler options/header finishing/context helpers so other servers can compose them without duplicating the whole adapter. Add a new framework wrapper only when an actual consumer needs it.

**Acceptance:** different subscriber/event shapes have fully typed resolvers; tenant-scoped channels resolve identically on both sides; namespaces cover all broker keys; cookie and bearer-token projects can use Expo without unintended provider headers; web fetch injection works; server adapters retain their existing streaming and batching guarantees.

## R11 — Clarify the API and adoption workflow

### Route options

[fn option extraction](../src/create-fn.ts) interprets every unrecognized top-level key as metadata. This makes flat application options convenient, but allows runtime typos or spread options to silently become metadata.

Move application metadata into a typed `meta` object on route declarations. Keep configured guard keys ergonomic at the top level and reject other unknown top-level options at construction. For example, the target shape could be:

```ts
// Final implemented API shape.
const getOrder = fn({
  name: 'order.get',
  procedure: 'protected',
  permission: 'orders:read',
  meta: { readOnly: true },
  input: z.object({ id: z.string() }),
  handler: ({ input, context, db }) => db.order.findForUser(input.id, context.user.id)
})
```

Keep the established `procedure` option and the choice of protected default versus explicitly required procedure. Avoid adding legacy aliases such as `isPublic` to the library. Consider a small typed preset helper only if repeated guard/tag/meta declarations appear in the first migrations; it must preserve selected-context and schema inference.

### Lifecycle and configuration

Add an awaitable terminal shutdown operation that stops accepting new subscriptions, aborts initialization/retry work, closes existing streams, and waits for owned resources to release. Retain `drainPubSubSubscribers` as the explicitly nonterminal operation if that use case is useful. Transport ownership must be explicit because applications may share an injected transport; a factory must not implicitly close somebody else's connection.

Move request timing/invocation bookkeeping into library-owned invocation state, with an optional bridge to Hono's `Server-Timing`. Avoid relying on arbitrary application `context.timing` fields and overwriting one shared `handler_ms` through nested or parallel batched calls. Distinguish per-procedure timing from request aggregates.

### Documentation and examples

Add short, independently runnable examples for a server with no live transport, a tenant-aware live query, a reducer with revisions, a job/script using `createCall`, real MCP registration, and Expo with both cookie and bearer authentication. Each example should include required peers and compile against the packed package.

Update the migration guide and codemod for the final chosen option shape. Use a TypeScript AST for expanded rewrites and cover comments, spreads, nested objects, and existing `procedure` declarations. Require migrations to produce a reviewable diff with no ambiguous access-policy rewrites.

**Acceptance:** typoed route options fail clearly; metadata has a visible boundary; terminal shutdown cannot reopen subscriptions; request timing remains meaningful under nested/batched calls; migration examples compile and codemods preserve unrelated code.

## Additions to consider after the first adoption

- **Router validation and manifest generation:** check operation/tool name uniqueness, declared streaming support, and adapter compatibility once at assembly/startup. This directly supports R2 and R3.
- **Typed live stream messages:** a discriminated `snapshot`/`patch`/`resync` envelope would make client handling and recovery easier to type. Introduce it as a versioned opt-in contract during migration, with explicit schemas for each message.
- **Reliable publication integration:** offer a documented outbox/enqueue hook if an application needs database writes and notifications to survive broker failures. `safePublish` currently suppresses an error; it does not retry or guarantee publication.
- **Transport capability reporting:** declare whether a transport supports bounded replay and which atomic batch guarantees it can provide. The current multi-key Lua design requires appropriate Redis key placement; arbitrary channels/backlog keys do not share a Redis Cluster slot. Document standalone Redis support now and add cluster/durable/serverless adapters only with matching integration tests.
- **Resource lifetime hooks:** add scoped extras disposal or request caching when a real consumer needs transactions or expensive request services. Define how nested calls and long-lived streams affect ownership first.

Keep caching policy, automatic mutation retries, database transactions, application rate limits, permissions, feature flags, and job orchestration in the app. Preserve the existing decision to use oRPC's own client/query primitives. Add React/Vue live composables when a second application establishes a reusable contract.

## Implementation order

| Milestone | Work | Exit condition |
| --- | --- | --- |
| 1. Close proven blockers | Add focused regression tests and fix R1–R4. Make streaming/SDK requirements visible in examples. | Denials are enforced; supported MCP examples execute; mixed streams work; live startup and state recovery are honest. |
| 2. Settle public types and API | R6–R8, namespaced route metadata, stream/state schema design, and the shared execution boundary from R9. | An app can define and call routes without casts; native oRPC schemas/errors/meta remain usable; breaking decisions are documented. |
| 3. Harden live and reuse boundaries | R5, remaining R9–R11 work, channel resolvers/namespaces, explicit shutdown, Expo preset separation. | Queue/load/reconnect tests pass; coalescing reduces work; adapters and ownership work across the representative contexts. |
| 4. Pilot and adopt | Migrate one small consumer, then one consumer exercising live queries, tools, and mobile. Update examples and migration notes from actual friction. | Consumer lint/types/tests pass; auth, stream cancellation/recovery, tool calls, and package imports are verified in the app. |

Do not migrate a consumer using an unresolved P0 feature. Use small implementation PRs with the relevant acceptance criteria, and keep broader adapter additions separate from the correctness work.

## Verification strategy

Extend the existing packed consumer suite with compile-pass and compile-fail cases for Standard Schema and iterator outputs, foreign metadata, procedure-aware hooks/extras, declared error maps, invalid guard returns, object-union tools, actual SDK registration, and client error narrowing. Test both the TypeScript floor and the current version under NodeNext and Bundler.

Add runtime tests for the exact failures above, then integration tests for reconnect gaps, duplicate replay, snapshot/reducer races, cancellation during initialization, overflow recovery, throwing hooks, terminal shutdown, and sustained slow parsing. Use a shared transport contract suite for memory, Bun Redis, ioredis, and future transports.

Retain the existing CI matrix, optional-peer isolation, `attw`, `publint`, and installed-artifact checks. Add frontend bundle checks showing that client/Expo/manifest imports do not pull in server code. Track declaration size and TypeScript check cost on a representative large-router fixture.

## Baseline checks performed for the review

- `bun run typecheck` — passed.
- `bun test` — **198 passed, 10 skipped, 0 failed**. The skipped tests require a configured Redis service; real Redis integration was not run locally.
- `bun run build` — passed.
- `bun run attw` — passed for the declared ESM-only profile.
- `bun run publint` — passed.
- `bun run test:consumers` — passed with locked peers and TypeScript **7.0.2**, using Node **22.22.3**.
- `PEER_PROFILE=minimum TYPESCRIPT_VERSION=5.7.3 bun run test:consumers` — passed with minimum peers and TypeScript **5.7.3**, using the same Node version.
- Temporary runtime/type probes reproduced the guard, stream batching, MCP, Mastra union, metadata, readiness, replay, snapshot race, coalescing, output validation, and throwing-logger findings above. These findings are additional gaps in the current suite; passing baseline checks does not cover them.

## Final implementation verification

Verified the current working tree on 2026-10-03:

- `REDIS_URL=<temporary local Redis> bun test` — **238 passed, 0 failed, 0 skipped**, 460 assertions across 23 files. Includes real Redis publication, backlog, reconnect and live-query integration for both Bun Redis and ioredis. The isolated test container was removed after verification.
- `bun run lint` — passed, including source/consumer type checks and Biome.
- `bun run build` — passed.
- `bun run attw` — passed under the declared ESM-only profile.
- `bun run publint` — passed.
- `bun run test:consumers` — passed against the packed artifact with locked peers, TypeScript **7.0.2**, Node **22.22.3**, NodeNext and Bundler resolution. Runnable examples compile; real SDK registration/list/invoke passes; optional-peer isolation passes.
- `PEER_PROFILE=minimum TYPESCRIPT_VERSION=5.7.3 bun run test:consumers` — passed with minimum peers under the same resolution checks and Node version.
- `bun run verify:package` — passed: 158 packaged files and all 11 entry points resolve.
- `bun run test:client-bundle` — passed: 13 browser modules with no server, live or tool-adapter runtime in the client/Expo/serialized-manifest fixture.
- `bun run test:types-performance` — passed on a common 300-route fixture. Baseline: **105,813 types**, **340,331 instantiations**, **0.259s check**. Implementation: **74,517 types**, **302,997 instantiations**, **0.182s check**. Roughly 11% fewer instantiations in this single local TypeScript 7.0.2 measurement; timings vary and this is not a universal editor-performance claim. The script compares the working tree with HEAD; this run used baseline `81638d5`.
- `git diff --check` — passed.

Regression coverage lives in [core adoption contracts](../src/adoption-contracts.test.ts), [live adoption contracts](../src/live/adoption-live.test.ts), [real MCP SDK integration](../src/mcp/sdk.test.ts), the packed consumer fixtures and the existing transport suites. CI runs the new bundle/compiler checks and retains its broader Node/peer matrix; that remote matrix was not run locally.

The next project work is the pilot checklist in [the migration guide](migration.md). No release or consumer migration is included in this implementation.
