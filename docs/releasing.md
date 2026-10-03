# Releasing orpc-fn

Use a pull request with a conventional title. While the package is `0.x`, `fix:` and `perf:` release a patch, and `feat:`, `feat!:` or a `BREAKING CHANGE:` footer release a minor (`bump-minor-pre-major`). The first release is `0.1.0`. The version stays `0.x` until lullu and gey-mono both run on it. `chore:`, `ci:`, `docs:`, `refactor:` and `test:` do not release. Squash merging uses the PR title; do not manually edit versions or changelogs.

CI checks the PR title, lint/types, tests (including the Redis tests against a Redis service, with both adapters), build, attw, publint, the packed consumer checks and the installed npm artifact. Release Please uses the built-in repository token. GitHub requires a maintainer to select **Approve workflows to run** on each bot-created or updated release PR before its PR checks start. Wait for those checks before merging; manual CI dispatches do not satisfy PR protection. No personal access token is needed.

## Publish

1. Merge a passing development PR. Release Please opens or updates a release PR containing the next version and changelog.
2. Review its release notes and any breaking-change migration instructions.
3. Merge the passing release PR when ready. The workflow creates the version tag and GitHub release, checks out that tag, validates the package, and publishes the exact verified tarball with provenance.

Publication uses npm trusted publishing. Its package configuration is GitHub Actions, owner `HansKristoffer`, repository `orpc-fn`, workflow `release.yml`, no environment, and **npm publish** ticked (configurations made after 2026-09-03 otherwise allow only staged publishing). The workflow installs npm 11.5.1+. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN` or setup-node's `registry-url` to this workflow: a token in the environment stops npm from using OIDC.

## First release (once)

npm attaches a trusted publisher only to a package that already exists, so `0.1.0` is published by hand:

1. Create the public GitHub repository `HansKristoffer/orpc-fn`, push, and under **Settings → Actions → General** allow GitHub Actions to create and approve pull requests (Release Please needs it).
2. Merge the first development PR, then the `0.1.0` release PR. The publish job fails at the OIDC exchange (`404 ... package not found`); that is expected.
3. Publish that tag's verified tarball from a clean checkout, signing in with 2FA in the browser:

   ```sh
   git fetch --tags && git checkout v0.1.0
   bun install --frozen-lockfile && bun run build && bun run verify:package
   npm login --auth-type=web
   npm publish .artifacts/package.tgz --access public --ignore-scripts
   ```

4. On npmjs.com, add the trusted publisher above (package **Settings → Trusted Publisher**), then set publishing access to **Require two-factor authentication and disallow tokens**.
5. Run the Release workflow for `v0.1.0` (below): it sees the published version and skips it. Every later release publishes from CI with provenance.

## Recover a failed publication

Fix the failure, then run the Release workflow manually with the existing tag:

```sh
gh workflow run release.yml --repo HansKristoffer/orpc-fn -f tag=vX.Y.Z
```

The workflow checks that the tag exists as a GitHub release and agrees with the package version. Existing npm versions are skipped; registry errors fail rather than being mistaken for an unpublished version. npm versions are immutable: a broken published package needs a new fix PR and release. A source change cannot repair an old tag's build; cut a new release for that.

GitHub documents this token behavior in [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
