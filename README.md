# carbonless

A local, AI-assisted tool for reviewing GitHub pull requests.

## Install

Needs Node 24, git, and the GitHub CLI (`gh`) logged in (`gh auth login`).

```sh
pnpm add -g carbonless-review      # or: npm install -g carbonless-review
pnpm add -g carbonless-review@latest   # upgrade
```

Until the package is on npm, install from a tarball built from this repo:

```sh
pnpm install && pnpm pack          # makes carbonless-review-0.1.0.tgz
pnpm add -g ./carbonless-review-0.1.0.tgz
```

## Usage

```sh
crb https://github.com/<owner>/<repo>/pull/<n>
crb <owner>/<repo>#<n>
crb <n>        # a PR of the GitHub repo in the current directory
```

`crb <pr>` asks this machine's
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
(`refs/crb/...`) in crb's private clone, so it survives restarts. crb writes
to GitHub only when you act: replies, new comments, resolving threads, and
editing or deleting your own comments.

## Remote machine

An always-on `crb serve` on a machine you open from other devices (e.g. over
Tailscale):

1. Bind it there, in `~/.config/carbonless/config.json`:
   `{ "serve": { "host": "<the machine's Tailscale IP>", "port": 4747 } }`.
   Off loopback, pages need the access key (`~/.local/state/carbonless/key`);
   the printed link carries it as `?key=`. To replace it, delete that file and
   restart the service (by hand: `crb serve --new-key`).
2. Run it as a systemd user service, from a checkout of this repo:
   `scripts/devbox/install [<tarball | version>]`
   (checks Node 24, `gh`'s login and linger, writes
   `~/.config/systemd/user/crb.service`, starts it and prints the link).
   For it to start at boot: `sudo loginctl enable-linger $USER`.
3. Update it: `scripts/devbox/update <tarball | rc | latest | version>`
   (installs, restarts, prints the version it moved from and to, and the link).
4. Logs: `journalctl --user -u crb`.

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
| `pnpm test:pack` | Pack, install the tarball into a temp dir and run its `crb` |
| `pnpm verify` | All of the above |

Tests never call the real `gh`: `test/fake-gh/gh` answers from a scenario JSON
(`$CRB_FAKE_GH`, optional call log in `$CRB_FAKE_GH_LOG`). The Playwright
harness (`e2e/fixtures.ts`) puts it first on `PATH` and runs the built CLI
against throwaway git repos.

Layout: `src/cli.ts` (entry), `src/server` (Fastify + git + gh), `src/web` (React),
`src/shared` (types used by both), `test/` (shared test helpers), `e2e/` (Playwright).
