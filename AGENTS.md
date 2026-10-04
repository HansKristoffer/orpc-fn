# orpc-fn

orpc-fn lets an app define a backend function once and get a typed oRPC procedure with tracing, logging, guards, injected handler extras, nested calls and optional live queries over Redis. Adapters expose the same procedure as a Mastra tool, an MCP tool or a Hono route; client helpers call it from Vue, React and Expo. It is a published npm library, `0.x`, built for two consumers today: lullu and gey-mono.

## What we never compromise on

1. **Types are the product.** The common call, `fn({ input, handler })`, infers everything: no casts, no explicit type arguments. Handler context follows the selected procedure builder. `test:types-performance` must not regress on its 300-route fixture.
2. **Optional peers stay optional.** The root entry imports only `@orpc/server` and `@orpc/contract`. Tracing, Mastra, MCP, Hono, Redis and Expo live behind their own subpaths, and an app that does not use one never installs it.
3. **The client stays small.** `orpc-fn/client`, `orpc-fn/expo` and a serialized stream manifest pull in no server, live or tool-adapter code. `test:client-bundle` guards this.
4. **oRPC first.** Depend on oRPC where it covers the behaviour; keep our own code only where it falls short. Every such call is recorded in [decisions](docs/decisions.md).
5. **The app owns its domain.** Auth, permission vocabulary, database, transactions, tenancy, jobs and reliable publication stay in the app. The library takes them through `createFn`.

## A note from the maintainer

Prefer simple systems and the smallest model that makes the correct behaviour unsurprising. Do not keep complexity because it already exists, and do not add machinery because it looks impressive. Fight scope creep: an addition waits until a consumer needs it.

Treat this file as good defaults, not hard rules. The developer's instructions override it. If a rule here fights the task in front of you, say so and get sign-off before breaking it.

## Glossary

- **you** means the agent reading this file. **we** means the maintainer, Hans Kristoffer.
- **app** or **consumer** means a project that installs orpc-fn. lullu and gey-mono are the real ones; `tests/consumers` and `examples/` stand in for them.
- **route** means one `fn`, `fnLive` or pub/sub definition. Its `name` is also the span name and the OpenAPI operationId.
- **procedure builder** means an app's oRPC builder (`public`, `protected`) chosen with `procedure:`.
- **guard** means a typed per-route check configured on `createFn` (`permission: ...`). It returns void or a boolean; `false` denies.
- **extras** means app services injected into handlers (`db`, `logger`); `extrasByProcedure` scopes them by builder.
- **bound call** means the `call` a handler receives: a nested call with a child span, inherited signal and context.
- **transport** means a `PubSubTransport` (memory, Bun Redis, ioredis). **backlog** means its capped, expiring replay list.
- **stream manifest** means the serializable list of streaming router paths the client link uses to keep streams out of batches.

## The ways to hurt yourself

1. **Reaching into oRPC internals.** All runtime access to `~orpc` goes through `src/compatibility.ts`, so an upstream change is caught in one file.
2. **Statically importing an optional peer from shared code.** It breaks every app without that peer, and the root and client entries stop working. Take the module from the app (`createFn({ otel })`) or keep it in its subpath.
3. **Editing versions or `CHANGELOG.md` by hand.** Release Please owns both; the PR title decides the release. Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN` or a `registry-url` to `release.yml`: it breaks trusted publishing. See [releasing](docs/releasing.md).

## Hit every surface

The most common defect here is a change that works on the route kind you tested and is missing from the rest. Before calling work done, walk this list and say which entries applied:

- **Route kinds.** `fn`, `fnLive` (and patch mode), `createPubSub` subscriptions and plain streams share one execution policy. Guards, extras, meta and completion must behave the same on each.
- **Subpaths.** Each export in `package.json` is a surface: `live` and its transports, `mastra`, `mcp`, `mcp/sdk`, `mcp/server`, `hono`, `client`, `expo`, and the `orpc-fn` CLI. Adapter-shaped changes need a decision per adapter, even if the decision is "not supported here".
- **Transports.** Memory, Bun Redis and ioredis implement one contract; a change to one is a change to all three.
- **Types and runtime.** A rule enforced in the types also needs a runtime check for JavaScript callers and spread options, and the other way round.
- **Consumers.** `tests/consumers` compiles the packed package under NodeNext and Bundler, on TypeScript 5.7 and the current version. `examples/adoption` must keep compiling against it.
- **Reverse states.** A way in needs a way out: subscribe and unsubscribe, start and `shutdown()`, drain.
- **Breaking changes.** Use a `!` title (`feat!:`) and say in the PR body what an app must change; Release Please puts it in the release notes.
- **Docs.** Check whether the change makes the README section for that subpath inaccurate. Apply the [documentation rules](#documentation).

## Commands

- `bun install`, then `bun test <file>` and `bun run typecheck`.
- Redis tests are skipped unless `REDIS_URL` is set (CI uses `redis://localhost:6379`).
- When exports, peers or packaging change: `bun run build`, then `test:consumers`, `test:client-bundle`, `verify:package`, `attw` and `publint`.
- When public types change: `test:types-performance`, which compares the working tree with HEAD.
- `bun run lint:write` formats with Biome (tabs, single quotes, no semicolons).

## Verifying

- Run the smallest proof that the change works: the tests you touched, plus a typecheck.
- Do not run the whole matrix by default. CI owns it (Node and peer versions, Redis, packed consumers).
- Test observable behaviour and public contracts. Type-level contracts belong in `tests/consumers/types.ts` as compile-pass and compile-fail cases. Do not add tests that mirror the implementation.
- A behaviour change or bug fix ships with a focused regression test.
- Never wait on sleeps to make a live or stream test pass. Await the event, the readiness promise or the stream's end.

## Pull requests

- Never open a PR unless the developer asks.
- The title is a conventional commit and decides the release (`fix:` patch, `feat:` minor while `0.x`; `docs:`, `chore:`, `test:` do not release). CI rejects other titles.
- Body: the problem in a sentence or two, then the change and how you verified it. End with the model and harness that did the work.
- One request is one PR.

## Documentation

Most code changes need no documentation change. Agents can read the code.

- `README.md` is the user guide: one section per subpath with a short example. Update the section when how to use it changes.
- `docs/decisions.md` records why: what oRPC already ships, what we do on top, and the limits we accept deliberately. Before adding a paragraph, ask what a maintainer would get wrong without it. If the code answers it, leave it out.
- When a decision changes, rewrite or remove its entry. Do not append a second account of the new behaviour.
- Do not document every option, narrate control flow or keep file catalogs. Types, tests and code already record them. Keep a local explanation in a nearby code comment.

## Plans and work artifacts

- Do not commit implementation plans, reviews, research notes or scratch files. Keep them outside the repository; `.plans/` is gitignored as a safety net.
- Track open work in GitHub issues. A merged PR is the implementation record.

## How it works

An app calls `createFn` once with its procedure builders, guards, extras and optional `otel`. `fn()` normalizes and validates the route options (`src/route-options.ts`), then assembles a plain oRPC procedure (`src/assemble-procedure.ts`). The library's state is stored under one `'orpc-fn'` key in oRPC's own procedure meta, which survives router rebuilding. Execution middleware runs guards, injects extras and the bound call, opens the span and logs one `fn.completed` line after oRPC's validation settles. Logging and hooks can never change a call's outcome. `/live` adds pub/sub over a small `PubSubTransport`. `fnLive` subscribes before loading its first snapshot, then reruns or reduces on events.

## Where code lives

- `src/create-fn.ts`: the factory and its types. `src/types.ts` holds the public route and handler types.
- `src/compatibility.ts`: the only access to oRPC internals.
- `src/live/`: pub/sub, `fnLive`, wire codec, lifecycle and the three transports.
- `src/mcp.ts`, `src/mcp/`: tool definitions, plus the SDK v1 (`sdk.ts`) and v2 (`server.ts`) adapters on a shared core.
- `src/mastra.ts`, `src/hono.ts`, `src/client.ts`, `src/expo.ts`: the other adapters. `src/cli.ts`: the stream-manifest generator.
- `tests/fixture.ts`: the shared app-shaped `createFn` for tests. `tests/consumers/`: packed-package type checks.
- `scripts/`: build and package checks.

## Taste

- Inferred types over annotations. `any` is the enemy; unavoidable assertions sit at one small adaptation boundary.
- Readable type errors matter. A wrong route option should fail with a message an app developer understands.
- Comments describe how a thing is used, mostly on exported functions and types, not on every line.
- Be opinionated about lifecycle, validation, authorization, cancellation and errors. Give apps explicit extension points for context, services, schemas, transports and presentation.
