# Releasing

How carbonless reaches npm as `carbonless-review`. Decisions:
`docs/superpowers/specs/2026-10-30-versions-and-distribution-design.md`.

## Channels

| npm dist-tag | Version | Who |
|---|---|---|
| `latest` | `X.Y.Z` | co-workers: `pnpm add -g carbonless-review` |
| `rc` | `X.Y.Z-rc.N` (or the release itself, right after one) | the owner's main on the devbox |

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
   the highest `X.Y.Z-rc.*` among the tags and npm's versions. Once `X.Y.Z`
   is released, merges publish nothing (a warning says why) until the
   "next" PR below moves master's version on: an `X.Y.Z-rc.N` would sort
   before `X.Y.Z` and move `rc` backwards.
2. **Main follows `rc`.** The coordinator runs `scripts/devbox/update rc` and
   sends the owner the link.
3. **Promote → release**, only on the owner's word: `pnpm release promote
   [<rc tag>] [--next patch|minor|major]` starts `.github/workflows/promote.yml`
   and prints the run's link. It checks out the RC tag (default: the newest),
   runs every check including Playwright, publishes that commit again as
   `X.Y.Z` on `latest` (and moves `rc` to it when `rc` is older), tags
   `vX.Y.Z` on the RC's commit, and opens the PR **"next: X.Y+1.0"** (or
   the `--next` bump) that sets master's version and adds the release's
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
`scripts/build-info.mjs` records the commit itself, not `<sha>-dirty`. This
works for any commit, including RC tags whose `build-info.mjs` predates it
(an environment variable read by the build would not). Both workflows unpack
the tarball they are about to publish and fail unless its
`dist/build-info.json` says this version and this commit.

### The first publish

A package's first publish gets `latest` even when published with `--tag
rc` (the registry's reported behaviour; not testable here without
publishing), and `latest` can't be removed afterwards, only moved to another
version. The workflows don't rely on either answer: the first version on npm
is a release. While `carbonless-review` isn't on npm (`npm view` answers
404), publish-rc tags `vX.Y.Z-rc.N` but publishes nothing and says `pnpm
release promote vX.Y.Z-rc.N` in the run's summary. That promote is the
first publish (`0.1.0` on `latest`, `rc` set to it too); from then on every
merge publishes RCs.

### pnpm's release-age delay

pnpm 11+ skips versions published less than a day ago (`minimumReleaseAge`,
default 1440 minutes) and quietly installs an older one. `scripts/devbox/update`
and `install` exempt `carbonless-review`
(`--config.minimumReleaseAgeExclude=carbonless-review`), so main gets a new RC
at once. Co-workers running `pnpm add -g carbonless-review` get a release a
day after it is published, or at once with that same flag.

### Tokens

Both workflows check out with `persist-credentials: false`: the write token
is not in `.git/config` while `pnpm install`, the build or the tests run.
Only the steps that reach origin (the tip check, pushing tags and the
`next/*` branch, the PR) get `GITHUB_TOKEN`, and only the `npm publish` and
`npm dist-tag` steps get `NPM_TOKEN`. Steps that need tags read the
checkout's own (a full-history checkout has every tag).

### What GITHUB_TOKEN can't do

Tags and PRs created with the workflow's `GITHUB_TOKEN` start no workflows.
So an RC tag doesn't run CI's tag-only Playwright job (promote runs it
before releasing instead), and the "next" PR shows no CI checks until
someone pushes to it or closes and reopens it. If the owner makes CI a
required check on master, that PR needs one of those, or the workflows a
token of the owner's.

## Setup (the owner, once)

1. **npm:** an account with two-factor authentication. Create a granular
   access token (npmjs.com → Access Tokens → Generate New Token → Granular):
   packages and scopes **Read and write**, for `carbonless-review` (before
   the first publish: all packages), with **Bypass two-factor
   authentication** checked (CI can't answer 2FA), and an expiry you note
   down.
2. **GitHub, Gilthans/carbonless → Settings:**
   - Secrets and variables → Actions → New repository secret `NPM_TOKEN`,
     the token from step 1. Only the owner handles it.
   - Actions → General → Workflow permissions: **Read and write
     permissions**, and **Allow GitHub Actions to create and approve pull
     requests** (the "next" PR).
3. The repo is private, so npm provenance (`--provenance`) is not
   available; the workflows publish with the token alone.

When the token expires, publish-rc and promote fail at `npm publish` with a
401: make a new one and replace the secret.

### Two workflows at once

Each workflow has its own concurrency group: GitHub keeps one pending run
per group and cancels the older, so a shared group could silently drop a
promote. publish-rc runs one at a time (no two pick the same `N`); a
pending one replaced by a newer CI completion is harmless, since only
master's tip publishes. A promote and a publish-rc may overlap: publish-rc
makes no RC of a released version, and both end by moving `rc` to `latest`
when `rc` is behind (`ci:rc-fixup`, reading npm with `--prefer-online`), so
whichever finishes last leaves `rc` on the newer. At worst, a publish-rc that
checked just before the release lands publishes `X.Y.Z-rc.N` after `X.Y.Z`
(its tag sorts before the release's), and `rc` is put back on `X.Y.Z` by the
same run.

## When something fails

- **publish-rc failed before `npm publish`:** nothing is published; the next
  merge publishes the next number. To retry the same commit, re-run the job.
  Re-running a publish-rc (or CI) whose RC was already published publishes
  the same commit again as `rc.N+1`: harmless, just a spare number.
- **Published, but the tag push failed:** push the tag by hand on the owner's
  word (`git tag vX.Y.Z-rc.N <sha> && git push origin vX.Y.Z-rc.N`); the next
  RC's number already skips it (npm's versions count).
- **promote failed after publishing:** the release is on npm. Push the
  missing `vX.Y.Z` tag on the RC's commit and run `pnpm release next minor`
  for the next-version PR; promoting again refuses an existing release.
  That PR changes only the version: `docs/changelog.md` gets no entry for
  the release; add it by hand in the same PR if wanted.
- **`npm dist-tag add ... rc` failed** (`rc` stays behind `latest`): nothing
  else is wrong. The next publish-rc run moves it (any merge; it does so even
  when it publishes no RC), or on the owner's word: `npm dist-tag add
  carbonless-review@X.Y.Z rc`.
