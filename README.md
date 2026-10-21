# carbonless

A local, AI-assisted tool for reading the changes between two git commits.

## Usage

```sh
pnpm install
pnpm build
node dist/cli.js [repo] [base] [head]   # defaults: . HEAD~1 HEAD
```

The CLI prints `carbonless listening on <url>` and opens the browser
(`--no-open` to skip, `--port <n>` to pick a port).

## Development

Requires Node 24 (`nvm use`) and pnpm.

| Command | What it does |
|---|---|
| `pnpm dev` | API on :4747 (watch mode, compares this repo) + Vite UI on :5173 |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Build, then Playwright UI tests against the real CLI |
| `pnpm lint` / `pnpm fix` | Biome lint + format check / auto-fix |
| `pnpm typecheck` | TypeScript |
| `pnpm verify` | All of the above |

Layout: `src/cli.ts` (entry), `src/server` (Fastify + git), `src/web` (React),
`src/shared` (types used by both), `test/` (shared test helpers), `e2e/` (Playwright).
