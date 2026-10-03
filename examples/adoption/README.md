# Adoption examples

Run these from the repository with `bun examples/adoption/core.ts`, `tenant-live.ts`, `revisions.ts`, or `expo.ts`. Run `bun examples/adoption/mcp.ts` through an MCP client that launches stdio servers. `bun test examples/adoption` exercises every example. The packed consumer checks compile the same files against the published artifact.

| Example | Boundary | Required peers |
| --- | --- | --- |
| `core.ts` | Hono with no live transport; a job/script using `createCall` | Core peers, Hono and the Hono adapter peers |
| `tenant-live.ts` | Separate tenant-aware subscription/publication resolvers and a namespace | Core peers |
| `revisions.ts` | Reducer skips snapshot/replay overlap and reloads when revisions skip | Core peers |
| `mcp.ts` | Real SDK registration with explicit tool selection | Core peers, SDK 1.32+, `@orpc/zod`, `@orpc/json-schema` |
| `expo.ts` | Cookie and bearer authentication with the native streaming bridge | Core peers; `expo/fetch` in a real Expo app |

The examples use in-process state and HTTP for reproducibility. Production applications own authentication, tenant authorization, database writes and reliable publication. Replace the Expo example's fetch with `fetch` from `expo/fetch` and set `native` from `Platform.OS !== 'web'`; browser fetch can be injected with `webFetch`.
