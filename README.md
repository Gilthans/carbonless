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

Installed as a package, the command is `crb <pr>`. It asks this machine's
`crb serve` for the PR's review and prints its link, `http://<host>:<port>/r/<id>`
(nothing else on stdout); with no server running it starts one in the
background (logging to `$XDG_STATE_HOME/carbonless/serve.log`). The server
clones the repository into its own cache (`$XDG_CACHE_HOME/carbonless`,
default `~/.cache/carbonless`; your working copies are never touched). Its
root is Home; `/pr/<owner>/<repo>/<n>` opens any PR's review.

| `crb <pr>` option | |
|---|---|
| `--head <sha\|reviewed>` | The PR's changes up to that commit, in a review of its own |
| `--open` | Also open the browser |
| `--version` | Print the version (`crb serve` must run the same) |

`crb serve` runs the server in the foreground. Host and port come from
`$XDG_CONFIG_HOME/carbonless/config.json` (`{ "serve": { "host": "…", "port": 4747 } }`),
default `127.0.0.1:4747`.

| `crb serve` option | |
|---|---|
| `--port <n>` | Port to listen on (0: a free one) |
| `--host <h>` | Host to bind. Any host other than `127.0.0.1`, `::1` or `localhost` needs the access key, kept in `$XDG_STATE_HOME/carbonless/key` across restarts and included in the printed URL as `?key=` |
| `--new-key` | Replace the access key |
| `--api-only` | Serve only the API (used by `pnpm dev`) |

The page opens on the PR overview (checks, reviews, unresolved threads). The
Files changed view lists every changed line grouped into clusters; mark clusters
or files reviewed, or cross them off, and progress is saved as git refs
(`refs/crb/...`) in crb's private clone, so it survives restarts. crb only
reads from GitHub; it never pushes or comments.

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

Tests never call the real `gh`: `test/fake-gh/gh` answers from a scenario JSON
(`$CRB_FAKE_GH`, optional call log in `$CRB_FAKE_GH_LOG`). The Playwright
harness (`e2e/fixtures.ts`) puts it first on `PATH` and runs the built CLI
against throwaway git repos.

Layout: `src/cli.ts` (entry), `src/server` (Fastify + git + gh), `src/web` (React),
`src/shared` (types used by both), `test/` (shared test helpers), `e2e/` (Playwright).
