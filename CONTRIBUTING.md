# Contributing

## Development

Requires Node 24 (`nvm use`) and pnpm. From a checkout, `pnpm build` and run
`node dist/cli.js` in place of `crb`.

| Command | What it does |
|---|---|
| `CRB_PR=<pr> pnpm dev` | API on :4747 (watch mode, reviewing `<pr>`) + Vite UI on :5173 |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Build, then Playwright UI tests against the real CLI |
| `pnpm lint` / `pnpm fix` | Biome lint + format check / auto-fix |
| `pnpm typecheck` | TypeScript |
| `pnpm release local` | Build, pack and install this checkout as the global `crb` |
| `pnpm test:pack` | Pack, install the tarball into a temp dir and run its `crb` |
| `pnpm verify` | All of the above |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, the pack
smoke test and Playwright (in four parallel shards) on every PR and push to
master. A release is promoted only from a commit CI passed on as a push to
master (`docs/releasing.md`).

Tests never call the real `gh`: `test/fake-gh/gh` answers from a scenario JSON
(`$CRB_FAKE_GH`, optional call log in `$CRB_FAKE_GH_LOG`). The Playwright
harness (`e2e/fixtures.ts`) puts it first on `PATH` and runs the built CLI
against throwaway git repos.

Layout: `src/cli.ts` (entry: turns on Node's compile cache, then loads
`src/main.ts`, the CLI), `src/server` (Fastify + git + gh), `src/web` (React),
`src/shared` (types used by both), `test/` (shared test helpers), `e2e/` (Playwright).

From a checkout instead of npm (any branch): `pnpm install && pnpm release local`
builds, packs and installs it as the global `crb`.

## Releases

Every merge to master publishes a release candidate to npm through trusted
publishing (no npm token anywhere); `pnpm release promote` stages one as a
release, and the owner approves it with npm two-factor (`pnpm release
publish`). The release workflows on master can publish without that
approval, so master's ruleset (merges only on the owner's approval) is the real gate:
`docs/releasing.md` (and the npm and GitHub setup).
