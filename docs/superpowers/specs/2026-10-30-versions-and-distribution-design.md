# Versions and distribution

Status: approved by the owner, 2026-10-30 ("it looks good … your
recommendations are sound"), with their comments folded in. Commentable copy:
https://claude.ai/artifact/GEpdshwY1qaE2D26tKwwKE (daniel.o@ account). This
file is the source of truth.

## Why

> "Ideally, I'd like to be able to install crb globally using a package
> manager (like pnpm), with versioning, so I can just send someone a simple
> command for them to install this locally and another for them to upgrade.
> Then I'd like to have an always running instance on the devbox that I use
> for day-to-day, with an option to update it to an RC candidate, and another
> command to publish the RC as a new version. Branches that are in progress
> can open their own instance of crb for me to inspect without interfering
> with the main instance running."

The early milestone is the always-on main instance.

## Decisions

- **Registry: public npm** (owner: "public npm is excellent"). Only the
  built package is public; the repo, https://github.com/Gilthans/carbonless,
  stays private.
- **Package name: `carbonless-review`**, command `crb` (owner: "I don't like
  this ambiguity. We may need a different name", then "i like carbonless
  review"). `carbonless` on npm is someone else's empty 2019 placeholder and
  `crb` an unrelated Azure SDK beta; the install command names our package,
  so nobody lands on those.
- **Channels:** npm dist-tags `latest` (co-workers) and `rc` (the devbox).
  An RC is `X.Y.Z-rc.N` on `rc`; `@latest` never resolves to a prerelease.
- **Promote by republishing:** `pnpm release promote` publishes the current
  RC's commit again as `X.Y.Z` on `latest`, so nobody runs a version called
  "rc".
- **Main tracks `rc`** between releases; it is the RC's test.
- **Port 4747 belongs to the service**; demo and trial instances use other
  ports.
- **A `CLAUDE.md` exception** for this repo's `master` and `v*` tags (needed
  from M2, when releases push tags).
- **Install docs:** the README's install part includes a "Remote machine"
  section (owner's comment): an always-on server reached from other devices,
  `serve` host and port in `config.json`, the access key, the systemd
  service.
- **Update notice in the page:** later.

## What Home already provides (branch `home-server`, 2026-10-30)

`crb serve` (foreground; host and port from `serve` in
`$XDG_CONFIG_HOME/carbonless/config.json`, default `127.0.0.1:4747`), a
stable access key in `$XDG_STATE_HOME/carbonless/key`, `server.json` and
auto-start from `crb <pr>`, private state and config folders for `pnpm dev`
and agent worktrees (with `GH_CONFIG_DIR` pinned), and the version
handshake: `crb --version` prints `<package.json version> (<short commit>)`,
`GET /api/version` returns `{ version, commit }`, the build bakes the commit
into `dist/build-info.json` (`-dirty` for a dirty tree), and the server
refuses a client whose version or commit differs.

## Milestones

1. **M1, always-on main from an installed version** (no registry needed).
   - The package is publishable as `carbonless-review` `0.1.0`: no
     `private`, `files: ["dist"]`, `prepack` builds.
   - `scripts/devbox/`: a `crb.service` systemd user unit running the
     globally installed `crb serve` (Node 24 pinned; `XDG_CONFIG_HOME` left
     unset so `gh` keeps its login), `install`, and `update <tarball |
     channel>` (install, restart, print the link).
     (2026-11-02: superseded by `pnpm release local` and a local setup
     outside the repo; the README keeps a short unit snippet.)
   - README install part with the "Remote machine" section.
   - A smoke test that packs, installs into a temp prefix and runs the
     installed `crb`.
   - On the devbox: `serve` set to the Tailscale IP and 4747, the first
     tarball installed, the service started, hand-started instances retired,
     `CLAUDE.md` and notes on restarting main updated.
   - Done when main restarts by itself after a reboot and its link survives
     an upgrade.
2. **M2, publish and channels.** GitHub Actions on the repo: `pnpm verify`
   on push; on a `v*` tag, verify and `pnpm publish --provenance` with an npm
   token secret, `-rc.N` versions to the `rc` tag. `pnpm release
   <patch|minor|rc|promote>` bumps, writes `docs/changelog.md`, commits and
   tags. `scripts/devbox/update` takes `rc` and `latest`. Done when a
   co-worker installs with one command and main moves to `rc` and back.
   As built (2026-11-01; `docs/releasing.md`): pushes reach master only
   through PRs, so master's version is the next release and every push
   whose CI passes publishes `X.Y.Z-rc.N` (workflow `publish-rc`); `pnpm
   release promote` runs workflow `promote` (republish as `X.Y.Z` once the
   owner approves its `npm-release` environment, then a "next" PR with the
   changelog); `pnpm release next` sets another next
   version. The repo is private, so no `--provenance`: an `NPM_TOKEN`
   secret. License: MIT.
3. **M3, co-worker polish, on demand.** `crb doctor` (git, gh login, Node,
   cache dir), issues on the repo, the update notice, maybe `crb
   self-update`.

## Branch instances

Home's private state folders and the version handshake keep `pnpm dev`,
agent worktrees and branch builds away from main; main running from the
global install means no worktree build replaces its files. Cache clones and
review refs stay shared and safe (compare-and-swap writes, versioned events);
a branch that changes the storage format runs with its own `XDG_CACHE_HOME`.

## Anti-goals

- A carbonless-run server or update service (principle 4). Co-workers run
  their own `crb serve`.
- Pushing anywhere but the owner's repo, or publishing without the owner's
  say-so.
- A main instance that runs a worktree's `dist`.
