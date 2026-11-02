# Releasing

How carbonless reaches npm as `carbonless-review`. Decisions:
`docs/superpowers/specs/2026-10-30-versions-and-distribution-design.md`.

## Channels

| npm dist-tag | Version | Who |
|---|---|---|
| `latest` | `X.Y.Z` | co-workers: `pnpm add -g carbonless-review` |
| `rc` | `X.Y.Z-rc.N` (or the release itself, right after one) | trying the next release; the owner's main, once it follows npm |

`latest` never points at an RC.

## How versions move

Every change reaches master through a PR the owner merges on GitHub; nobody
pushes master or tags by hand. `package.json`'s `version` on master is the
**next release** `X.Y.Z`; no commit ever bumps it to an RC.

1. **Merge → RC.** CI (`.github/workflows/ci.yml`, workflow `CI`) runs on the
   push to master. When it passes, `.github/workflows/publish-rc.yml` checks
   out exactly that commit and, if it is still master's tip (CI runs can
   finish out of order; the newest push holds the older ones), publishes
   `X.Y.Z-rc.N` to `rc` and pushes the tag `vX.Y.Z-rc.N`. `N` is one past
   the highest `X.Y.Z-rc.*` among the tags, npm's versions and the versions
   `package.json` has had on master (the interim RCs before this flow were
   set there by hand, their tags never pushed). Once `X.Y.Z`
   is released, merges publish nothing (a warning says why) until the
   "next" PR below moves master's version on: an `X.Y.Z-rc.N` would sort
   before `X.Y.Z` and move `rc` backwards.
2. **Main moves by itself.** The owner's devbox moves main to master's newest
   build within minutes of a merge, through local setup outside this repo;
   after the first npm publish the owner switches it to follow `rc` instead
   (see "Flipping the switch"). The coordinator checks it moved and sends
   the owner the link.
3. **Promote → release**, only on the owner's word, in three steps:
   - `pnpm release promote [<rc tag>] [--next patch|minor|major]` starts
     `.github/workflows/promote.yml` and prints the run's link. It checks
     out the RC tag (default: the newest; it must be on master), runs every
     check including Playwright, sets the version `X.Y.Z` (and the RC's
     commit as `gitHead`) and packs it. The run's artifact `release` holds
     the tarball and a manifest (version, RC tag, commit, sha256, npm
     integrity); its summary shows them. It publishes nothing and has no
     npm token.
   - **The owner** runs `pnpm release publish [<run-id>]` (default: the
     newest successful promote run) on their own machine. It downloads the
     artifact, checks the tarball's sha256 against the manifest, its
     `build-info.json` against the version and the RC tag's commit (which
     must be the tag's commit on GitHub, and on master), shows what it is
     about to do and asks y/N. Then `npm publish <tarball> --tag latest`
     with the owner's npm login: npm asks for the two-factor OTP. Agents
     never run it, and never ask for the OTP.
   - It then starts `.github/workflows/release-finish.yml` (version and
     promote run as inputs), which checks npm has that version with that
     very tarball, tags `vX.Y.Z` on the RC's commit, moves `rc` up to it
     when `rc` is older, and opens the PR **"next: X.Y+1.0"** (or the
     `--next` bump) that sets master's version and adds the release's
     merged PRs to `docs/changelog.md`. The owner merges that PR like any
     other; its merge publishes `X.Y+1.0-rc.1`.
4. **A different next version** (a fix release instead of a minor, say):
   `pnpm release next <patch|minor|major|X.Y.Z>` opens a PR setting master's
   version (a kind bumps the newest release).

`pnpm release status` shows master's next version, `rc` and `latest` on npm,
the newest tags, and what the next merge will publish.

### The version in a build, without a dirty tree

The workflows set the version only in the runner's checkout
(`tsx scripts/release.ts ci:set-version`), then mark `package.json`
`git update-index --skip-worktree`, so `git status` stays empty and
`scripts/build-info.mjs` records the commit itself, not `<sha>-dirty`. It
also writes the commit as `gitHead` into that `package.json`, which npm
keeps, so an RC or a release is told apart from a build of master with the
same version: between a merge and its release, builds made from master (by
hand, or by the devbox while it follows git) carry the version of the
release they precede, e.g. `0.1.0 (<sha>)`. This
works for any commit, including RC tags whose `build-info.mjs` predates it
(an environment variable read by the build would not). publish-rc and
promote unpack the tarball they pack and fail unless its
`dist/build-info.json` says this version and this commit; `pnpm release
publish` checks it again before publishing.

### The first publish

A package's first publish gets `latest` even when published with `--tag
rc` (the registry's reported behaviour; not testable here without
publishing), and `latest` can't be removed afterwards, only moved to another
version. The flow doesn't rely on either answer: the first version on npm
is a release. While `carbonless-review` isn't on npm (`npm view` answers
404), publish-rc tags `vX.Y.Z-rc.N` but publishes nothing and says `pnpm
release promote vX.Y.Z-rc.N` in the run's summary. The owner's `pnpm
release publish` of that promote is the first publish (`0.1.0` on
`latest`; release-finish sets `rc` to it too); from then on every merge
publishes RCs.

### pnpm's release-age delay

pnpm 11+ skips versions published less than a day ago (`minimumReleaseAge`,
default 1440 minutes) and quietly installs an older one. Installs of our own
builds exempt `carbonless-review`
(`--config.minimumReleaseAgeExclude=carbonless-review`; `pnpm release local`
does), so a new RC arrives at once. Co-workers running `pnpm add -g
carbonless-review` get a release a day after it is published, or at once with
that same flag.

### Tokens

Releases (`latest`) are published only from the owner's machine, with
their npm login and its two-factor OTP: no workflow can publish one. The CI
token `NPM_TOKEN` (no OTP) is used by publish-rc's `npm publish --tag rc`
and by `npm dist-tag` in publish-rc and release-finish; promote has none.

All workflows check out with `persist-credentials: false`: the write token
is not in `.git/config` while `pnpm install`, the build or the tests run.
Only the steps that reach origin (the tip check, pushing tags and the
`next/*` branch, the PR) get `GITHUB_TOKEN` (git gets it through
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, not on its
command line), and only the npm steps get `NPM_TOKEN`. Steps that need
tags read the checkout's own (a full-history checkout has every tag).

What this does and doesn't stop: the CI token can publish any version
under any tag, and any workflow on any branch can read a repository
secret. So the OTP keeps releases from happening by mistake, or by an agent
that follows the rules (agents never run `pnpm release publish`); it does
not stop a workflow written on purpose to publish with `NPM_TOKEN`. Optional
hardening: take the `workflow` scope off this machine's gh login (`gh auth
refresh --remove-scopes workflow`), so pushes from it can't add or change
workflows.

### What GITHUB_TOKEN can't do

Tags and PRs created with the workflow's `GITHUB_TOKEN` start no workflows.
So an RC tag doesn't run CI's tag-only Playwright job (promote runs it
before releasing instead), and the "next" PR shows no CI checks until
someone pushes to it or closes and reopens it. If the owner makes CI a
required check on master, that PR needs one of those, or the workflows a
token of the owner's.

### Two workflows at once

Each workflow has its own concurrency group: GitHub keeps one pending run
per group and cancels the older, so a shared group could silently drop a
promote. publish-rc runs one at a time (no two pick the same `N`); a pending
one replaced by a newer CI completion is harmless, since only master's tip
publishes. A release and a publish-rc may overlap: publish-rc makes no RC of
a released version, and it and release-finish end with `ci:rc-fixup
[<version this run published>]`: it moves `rc` up to the newer of `latest`
(read with `--prefer-online`) and the version passed in, when `rc` is below
that or missing. The version passed in is the floor because the read can be
stale (a 404 right after the first publish, a `latest` not yet updated, a
read that misses this run's own RC): `rc` is never moved below what the run
itself published. So whichever finishes last leaves `rc` on the newer. At
worst, a publish-rc that checked just before the release lands publishes
`X.Y.Z-rc.N` after `X.Y.Z` (its tag sorts before the release's), and `rc` is
put back on `X.Y.Z` by the same run. Promote and `pnpm release publish`
refuse a release that isn't newer than `latest`, so `latest` never moves
back either.

## Setup (the owner, once)

1. **npm:** an account with two-factor authentication for **authorization
   and writes** (npmjs.com → Account → Two-Factor Authentication): every
   publish from your login asks for the OTP. Log in on your machine
   (`npm login`).
2. **The CI token:** a granular access token (npmjs.com → Access Tokens →
   Generate New Token → Granular): packages and scopes **Read and write**,
   for `carbonless-review` (before the first publish: all packages), with
   **Bypass two-factor authentication** checked (CI can't answer an OTP),
   and an expiry you note down. Only publish-rc (RCs) and the `npm
   dist-tag` steps use it; releases never do.
3. **GitHub, Gilthans/carbonless → Settings:**
   - Secrets and variables → Actions → New repository secret `NPM_TOKEN`,
     the token from step 2 (only you handle it).
   - Actions → General → Workflow permissions: **Read and write
     permissions**, and **Allow GitHub Actions to create and approve pull
     requests** (the "next" PR).
   - No environment is needed.
4. The repo is private, so npm provenance (`--provenance`) is not
   available.

When the CI token expires, publish-rc fails at `npm publish` (and
release-finish at `npm dist-tag`) with a 401: make a new one and replace
the secret.

## Flipping the switch

1. The setup above; then merge the PR that brings these workflows.
2. Its CI run makes publish-rc tag `v0.1.0-rc.N` (N after the interim RCs)
   without publishing (the package isn't on npm yet); the run's summary says
   to promote it.
3. `pnpm release promote` (the newest RC). When its run is green, on your
   machine: `pnpm release publish` (answer y, then the OTP). `0.1.0` goes
   to `latest`; release-finish then tags `v0.1.0`, sets `rc` to it and
   opens the PR "next: 0.2.0".
4. `npm view carbonless-review dist-tags` shows `latest: 0.1.0, rc: 0.1.0`,
   and `npm view carbonless-review@0.1.0 gitHead` the commit of the
   promoted RC. Switch the devbox's local setup to npm mode
   (`echo npm > ~/.config/carbonless-devbox/source`), so main follows `rc`
   from then on; run its follow once (`systemctl --user start crb-follow`)
   and check that `crb --version` says `0.1.0 (<that commit>)`, not a
   master build's commit.
5. Merge "next: 0.2.0": every merge after it publishes `0.2.0-rc.N`.

## When something fails

- **publish-rc failed before `npm publish`:** nothing is published; the next
  merge publishes the next number. To retry the same commit, re-run the job.
  Re-running a publish-rc (or CI) whose RC was already published publishes
  the same commit again as `rc.N+1`: harmless, just a spare number.
- **Published, but the tag push failed:** the next RC's number already
  skips it (npm's versions count); the owner may push the tag by hand
  (`git tag vX.Y.Z-rc.N <sha> && git push origin vX.Y.Z-rc.N`).
- **promote failed:** nothing is published; fix and run it again.
- **`pnpm release publish` failed at `npm publish`** (a wrong OTP, the
  network): nothing else was done; run it again with the same run id.
- **release-finish failed** (after the release is on npm): start it again,
  `gh workflow run release-finish.yml --ref master -f version=X.Y.Z -f
  run=<promote run id>` (or re-run the failed job). Each step skips what is
  done: the tag when origin's already points at the RC's commit, the move
  of `rc` when it isn't behind, the "next" PR once master's version moved
  on (an open one is updated). `pnpm release publish` run again also starts
  it, without publishing twice (npm already has that tarball).
- **`npm dist-tag add ... rc` failed** (`rc` stays behind `latest`): nothing
  else is wrong. The next publish-rc run moves it (any merge; it does so even
  when it publishes no RC), or release-finish run again.

## Later cleanup

- **A release PR instead of a dispatch:** a bot keeps a "release X.Y.Z" PR
  open (changelog and version), and merging it is the release (the
  release-please / changesets pattern); the owner's OTP publish would stay
  the gate.
- **npm trusted publishing (OIDC)** instead of `NPM_TOKEN` for RCs and
  dist-tags, once the package exists: no long-lived token in the repo. It
  needs npm CLI ≥ 11.5.1 (≥ 11.21.0 for `dist-tag`) and allows one trusted
  workflow per package.
