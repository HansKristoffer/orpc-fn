# orpc-fn

Published `0.x` npm library built for `lullu` and `gey-mono`: define a backend function once to get a typed oRPC procedure with tracing, logging, guards, extras, nested calls, optional live queries over Redis, tool/HTTP/CLI adapters, and client helpers.

Keep the model minimal; wait until a consumer needs an addition. If a rule here conflicts with the task, flag it before breaking it.

## Invariants

1. **Types are the product.** `fn({ input, handler })` infers everything with no casts or explicit type arguments, handler context follows the selected procedure builder, and wrong route options produce readable type errors. Isolate unavoidable type assertions at one narrow adaptation boundary, and keep `test:types-performance` regression-free on its 300-route fixture.
2. **Optional peers stay optional.** Root entry imports only `@orpc/server` and `@orpc/contract`. Never statically import an optional peer from shared, root, or client code: take it from the app (`createFn({ otel })`) or keep it behind its subpath. `hanzio` is the only runtime dependency (backs the `orpc-fn` bin, which must run without optional peers).
3. **The client stays small.** Client subpaths (`client`, `expo`, `vue`, `react`) and serialized stream manifests pull in no server, live, or adapter code (`test:client-bundle` guards this).
4. **oRPC first.** Rely on oRPC where it covers the behaviour; keep library code only where oRPC falls short. Read and update [docs/decisions.md](docs/decisions.md) when touching that boundary or accepting a deliberate limit.
5. **The app owns its domain.** Keep auth, permission vocabulary, DB, transactions, tenancy, jobs, and reliable publication in the app, exposed through `createFn` extension points.

## Architecture & gotchas

- **oRPC internals:** Route all runtime access to `~orpc` through `src/compatibility.ts`.
- **Procedure state:** Stored under the single `'orpc-fn'` key in oRPC procedure meta so it survives `os.router()` rebuilding.
- **Execution pipeline:** Middleware runs guards, injects extras and bound `call`, opens spans, and logs one `fn.completed` line after oRPC validation settles. Logging and hooks must never change a call's outcome. Route `name` is both span name and OpenAPI `operationId`.
- **Live queries:** `fnLive` subscribes before loading its first snapshot, then reruns or reduces on events.
- **Releases:** Release Please owns `version` and `CHANGELOG.md` from PR titles; never edit them by hand. Keep `NPM_TOKEN`, `NODE_AUTH_TOKEN`, and `registry-url` out of `release.yml` (they break OIDC trusted publishing). Read [docs/releasing.md](docs/releasing.md) before changing release config or publishing.

## Hit every surface

Before finishing, walk every surface below and state which applied:

- **Route kinds:** `fn`, `fnLive` (including patch mode), `createPubSub` subscriptions, and plain streams share one execution policy (guards, extras, meta, completion).
- **Subpaths:** Check every export in `package.json#exports` and the `orpc-fn` bin; adapter-shaped changes require an explicit decision per adapter (even "not supported").
- **Transports:** Memory, Bun Redis, and ioredis implement one `PubSubTransport` contract; update all three together.
- **Types and runtime:** Mirror type-level rules with runtime checks (for JS callers and spread options) and vice versa.
- **Consumers:** Keep `tests/consumers` (NodeNext + Bundler, TS 5.7 and current; `kanpla/` on TS 5.4.5 with `skipLibCheck`, via `test:consumers:kanpla`) and `examples/adoption` compiling.
- **Reverse states:** Pair every entry with an exit (subscribe/unsubscribe, start/`shutdown()`, drain).
- **Docs:** Update the matching `README.md` section if public usage changed.

## Verification

- Run `bun run check` (`build` + `typecheck` + `biome check`; also wired to `.husky/pre-commit`) and focused `bun test <file>`. Format with `bun run lint:write`. Note `typecheck` reads `dist/` via `examples/adoption`, so run `bun run check` (or `build` first) on a fresh checkout.
- Redis tests skip unless `REDIS_URL` is set (`redis://localhost:6379` in CI).
- Run packaging checks (`test:consumers`, `test:client-bundle`, `verify:package`, `attw`, `publint`) only when exports, peers, or packaging change, and `test:types-performance` only when public types change. Leave the full Node/peer matrix to CI.
- Test observable behaviour and public contracts (use `tests/fixture.ts` for app-shaped routes and `tests/consumers/types.ts` for compile-pass/compile-fail type contracts). Ship every behaviour change or bug fix with a focused regression test.
- Synchronize live and stream tests on events, readiness promises, or stream completion instead of sleeps.

## Pull requests

- Open a PR only when asked.
- Use a conventional PR title (enforced by CI and read by Release Please: `fix:`/`perf:` patch, `feat:`/`feat!:` minor while `0.x`; `docs:`/`chore:`/`test:`/`refactor:`/`ci:` no release). For breaking changes (`feat!:`), include consumer migration steps in the PR body.
- Body: problem in 1–2 sentences, change (including surfaces touched), verification, and the model and harness used.

## Documentation

Most code changes need no documentation update.

- `README.md`: update a subpath's section only when how consumers use it changes.
- `docs/decisions.md`: record why (oRPC boundary, deliberate limits) only when code alone would mislead a maintainer; rewrite or remove stale entries in place.
- Keep doc comments on exported functions and types (how to use them), not narrating lines or duplicating types.
- Keep plans, reviews, and scratch notes outside git (`.plans/` is gitignored).
