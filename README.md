# carbonless

A local, AI-assisted tool for reviewing GitHub pull requests.

## Usage

Needs the GitHub CLI (`gh`), logged in (`gh auth login`).

```sh
pnpm install
pnpm build
node dist/cli.js https://github.com/<owner>/<repo>/pull/<n>
node dist/cli.js <owner>/<repo>#<n>
node dist/cli.js <n>        # a PR of the GitHub repo in the current directory
```

Installed as a package, the command is `crb <pr>`. It clones the repository
into its own cache (`$XDG_CACHE_HOME/carbonless`, default `~/.cache/carbonless`;
your working copies are never touched), prints `carbonless listening on <url>`
and opens the browser.

| Option | |
|---|---|
| `--port <n>` | Port to listen on (default: a free one) |
| `--host <h>` | Host to bind (default `127.0.0.1`). Any host other than `127.0.0.1`, `::1` or `localhost` gets a random access key, included in the printed URL as `?key=` |
| `--no-open` | Don't open the browser |
| `--api-only` | Serve only the API (used by `pnpm dev`) |

## Development

Requires Node 24 (`nvm use`) and pnpm.

| Command | What it does |
|---|---|
| `CRB_PR=<pr> pnpm dev` | API on :4747 (watch mode, reviewing `<pr>`) + Vite UI on :5173 |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Build, then Playwright UI tests against the real CLI |
| `pnpm lint` / `pnpm fix` | Biome lint + format check / auto-fix |
| `pnpm typecheck` | TypeScript |
| `pnpm verify` | All of the above |

Layout: `src/cli.ts` (entry), `src/server` (Fastify + git + gh), `src/web` (React),
`src/shared` (types used by both), `test/` (shared test helpers), `e2e/` (Playwright).
