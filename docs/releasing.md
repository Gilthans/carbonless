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
   push to master. When it passes, `.github/workflows/release.yml` checks
   out exactly that commit and, if it is still master's tip (CI runs can
   finish out of order; the newest push holds the older ones), builds it,
   publishes `X.Y.Z-rc.N` to `rc` through npm's trusted publishing (no
   token) and pushes the tag `vX.Y.Z-rc.N`. `N` is one past
   the highest `X.Y.Z-rc.*` among the tags, npm's versions and the versions
   `package.json` has had on master (the interim RCs before this flow were
   set there by hand, their tags never pushed). Once `X.Y.Z`
   is released, merges publish nothing (a warning says why) until the
   "next" PR below moves master's version on: an `X.Y.Z-rc.N` would sort
   before `X.Y.Z` and move `rc` backwards.
2. **Main moves by itself.** The owner's main follows npm `rc`
   (machine-specific steps: CLAUDE.local.md). The coordinator checks it
   moved and sends the owner the link.
3. **Promote → release**, only on the owner's word, in three steps:
   - `pnpm release promote [<rc tag>] [--next patch|minor|major]` starts
     `.github/workflows/release.yml` (mode `promote`) and prints the run's
     link. It checks out the RC tag (default: the newest; it must be on
     master), runs every check including Playwright, sets the version
     `X.Y.Z` (and the RC's commit as `gitHead`), packs it, and **stages**
     it on npm (`npm stage publish --tag latest`): the version is uploaded
     but hidden, with its dist-tag fixed, until a maintainer approves it
     with two-factor. The run's artifact `release` holds the tarball and a
     manifest (version, RC tag, commit, sha256, npm integrity, stage id);
     its summary shows them.
   - **The owner** approves it: `pnpm release publish [<run-id>]` (default:
     the newest successful promote run of master), on their own machine,
     at a terminal, from a clean checkout of `origin/master` (it refuses
     local changes, or release code and `package.json` that differ from
     `origin/master`). It takes only a successful, dispatched promote run of
     master, downloads its artifact, checks the tarball's sha256 against
     the manifest and its `build-info.json` against the version and the RC
     tag's commit (the tag's commit on GitHub, on master), downloads the
     staged version (`npm stage download`) and checks it is that very
     tarball, shows what it is about to do and asks y/N. Then `npm stage
     approve <id>`: npm asks for the two-factor OTP (with a security key or
     passkey as the second factor, it prints a browser URL to approve
     instead), and the version goes live on `latest`. Before asking, it
     refuses while npm has another staged entry for that version (a second
     promote of the same version stages a second one; CI can't list staged
     versions, npm only lets a logged-in maintainer) and names both ids:
     reject the other first. Approving on npmjs.com (carbonless-review →
     Staged Packages) works too, but approve only the stage id in the
     promote run's summary; then run
     `pnpm release publish <run-id>` anyway (it sees the version is live,
     approves nothing, and goes on), or start release-finish by hand.
     Agents never run it, and never ask for the OTP.
   - It waits until npm shows the version with that tarball (the registry
     can lag by minutes), then starts `.github/workflows/release-finish.yml`
     (version and promote run as inputs), which checks the run again, that
     the manifest's tag is at its commit on master, and that npm has that
     version with that very tarball (waiting up to 5 minutes), tags
     `vX.Y.Z` on the RC's commit, has `release.yml` move `rc` up to it
     (mode `fixup`), and opens the PR **"next: X.Y+1.0"** (or the `--next`
     bump) that sets master's version and adds the release's merged PRs to
     `docs/changelog.md`. The owner merges that PR like any other; its
     merge publishes `X.Y+1.0-rc.1`.
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
hand, or by a machine that follows git) carry the version of the
release they precede, e.g. `0.1.0 (<sha>)`. This
works for any commit, including RC tags whose `build-info.mjs` predates it
(an environment variable read by the build would not). The RC and promote
jobs unpack the tarball they pack and fail unless its
`dist/build-info.json` says this version and this commit; `pnpm release
publish` checks it again before approving.

### The first publish

A package's first publish gets `latest` even when published with `--tag
rc` (the registry's reported behaviour; not testable here without
publishing), and `latest` can't be removed afterwards, only moved to another
version. And npm's trusted publishers can only be added to a package that
exists. So the first version on npm is a release, published by the owner:
while `carbonless-review` isn't on npm (`npm view` answers 404), the RC run
tags `vX.Y.Z-rc.N` but publishes nothing and says `pnpm release promote
vX.Y.Z-rc.N` in its summary; that promote run checks and packs but stages
nothing (its summary says so), and the owner's `pnpm release publish`
publishes it with `npm publish` and their OTP (`0.1.0` on `latest`;
release-finish then sets `rc` to it too). From then on every merge
publishes an RC and every promote stages a release.

### Third-party notices

Every build writes `dist/THIRD-PARTY-NOTICES.md`
(`scripts/third-party-notices.mjs`): the licenses of what the web page
bundles, so every tarball carries them.
Promote only an RC built after it was added (an older RC's tarball has no
notices file); the first release, 0.1.0, is from such an RC anyway.

### pnpm's release-age delay

pnpm 11+ skips versions published less than a day ago (`minimumReleaseAge`,
default 1440 minutes) and quietly installs an older one. Installs of our own
builds exempt `carbonless-review`
(`--config.minimumReleaseAgeExclude=carbonless-review`; `pnpm release local`
does), so a new RC arrives at once. Co-workers running `pnpm add -g
carbonless-review` get a release a day after it is published, or at once with
that same flag.

### Trusted publishing

No npm token exists anywhere: not in the repo's secrets, not on this
machine. The workflow `release.yml` is registered on npmjs.com as a trusted
publisher of `carbonless-review` (GitHub Actions, `Gilthans/carbonless`,
`release.yml`, environment `npm`, publish and dist-tag allowed; staging is
always allowed), and npm hands its jobs a short-lived credential through
OIDC. One registered file on purpose: a new trusted-publisher entry
expires unless it publishes within 2 days, and every RC keeps this one in
use. npm CLI 12.2.1 is installed in those jobs (trusted publishing needs
≥ 11.5.1, `dist-tag` ≥ 11.21.0 or ≥ 12.2.0, staging ≥ 11.15.0).

**Provenance:** the repository is public, so npm signs a provenance
statement (which repository, workflow run and commit built the version)
for every RC and every staged release, with no flag: with trusted
publishing from GitHub Actions npm turns it on when the OIDC token says
the repository is public and the package is public (`npm stage publish`
is `npm publish` with staging, the same path). The first release, which
the owner publishes from their machine, has none.

Only three jobs get `id-token: write` (`rc-publish`, `promote-stage`,
`fixup`), each in the GitHub environment `npm`, which only `master` may
use, and each runs node, npm and git only: no `pnpm install`, no
dependency code (the rc fix-up is `scripts/rc-fixup.mjs`, which imports
nothing), and every action pinned to a commit. Before `npm publish` or
`npm stage publish` they read the tarball's own `package/package.json`
(what npm actually publishes) and refuse anything but `carbonless-review`
at exactly the expected version with no `publishConfig`: the tarball was
built in a job that runs dependency code. The jobs that build and test
have no npm credential at all. release-finish has none either: it starts
`release.yml`'s fix-up.

**Master is the real gate.** npm can't limit a trusted publisher to some
dist-tags: an entry allowed to publish and move dist-tags can do both for
any version and any tag, `latest` included. So:
- Releases normally go live only with the owner's two-factor: CI stages
  them, and approving a staged version needs a maintainer's 2FA.
- But any code that runs in those three jobs on `master` can publish any
  version, or point `latest` at any version, with no 2FA: a change to
  `release.yml` (or to `scripts/rc-fixup.mjs`) merged into master, or a
  compromised action or npm release used there. Whoever can change master
  can publish.
- What keeps that to the owner, on GitHub: a ruleset on `master` (PRs
  required, CI green, no direct or force pushes, no bypass), `CODEOWNERS`
  (the release workflows and scripts are the owner's) with code owners'
  review required, and the environment `npm` limited to `master` (npm
  checks the repository, the workflow file and the environment name, not
  the branch: the environment's branch rule is the only thing that keeps
  a workflow on another branch from getting npm's credential). Merging
  only PRs the owner read, on the owner's word, is the rest.
- With "Require two-factor authentication and disallow tokens" set on the
  package, no npm token can publish it; the trusted publisher still can.
- On the owner's machine the OTP approves whatever the code that asks for
  it approves, and agents run as the same user there. So run `pnpm release
  publish` from a clean checkout at `origin/master` (it refuses anything
  else) and read its summary. Optional hardening: take the `workflow` scope
  off this machine's gh login (`gh auth refresh --remove-scopes workflow`),
  so pushes from it can't change workflows.

**Fork pull requests** (the repository is public): anyone can open one,
and none of it reaches a credential.
- A PR runs only CI (`pull_request`, never `pull_request_target`): a
  read-only `GITHUB_TOKEN`, no secrets (no workflow uses any), no
  environment, no OIDC. With approval required for outside contributors'
  workflows (setup, step 5), a fork's first runs wait for the owner.
- A fork's CI completing also starts `release.yml` (`workflow_run` fires
  for any CI on a branch called `master`, a fork's too). Both RC jobs
  check in their own `if` that CI ran for a push of this repository
  (`workflow_run.event == 'push'` and `head_repository == repository`),
  so such a run does nothing.
- The promote and fix-up jobs run only on a dispatch of `master`
  (`github.ref`), which needs write access; the `npm` environment's
  branch rule is the gate behind that.
- Caches a PR's run writes are scoped to that PR's ref: master's runs never
  restore them.
`scripts/release.test.ts` checks all of this in the workflow files.

All workflows check out with `persist-credentials: false`: the GitHub token
is not in `.git/config` while `pnpm install`, the build or the tests run.
Only the steps that reach origin (the tip check, pushing tags and the
`next/*` branch, the PR, starting the fix-up) get `GITHUB_TOKEN` (git gets
it through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, not
on its command line). Steps that need tags read the checkout's own (a
full-history checkout has every tag).

### What GITHUB_TOKEN can't do

Tags and PRs created with the workflow's `GITHUB_TOKEN` start no workflows.
So an RC tag doesn't run CI's tag-only Playwright job (promote runs it
before releasing instead), and the "next" PR shows no CI checks until
someone pushes to it or closes and reopens it (a rerun of release-finish
leaves such pushes alone). CI is a required check on master, so that PR
needs one of those before it can merge (or the workflows a token of the
owner's).

### Two workflows at once

Each kind of `release.yml` run (RC, promote, fix-up) has its own
concurrency group: GitHub keeps one pending run per group and cancels the
older, so a shared group could silently drop a promote. RC runs go one at a
time (no two pick the same `N`); a pending one replaced by a newer CI
completion is harmless, since only master's tip publishes. A release and an
RC run may overlap: no RC is made of a released version, and the RC run
and the fix-up end with `scripts/rc-fixup.mjs [<version this run
published>]`: it moves `rc` up to the newer of `latest`
(read with `--prefer-online`) and the version passed in, when `rc` is below
that or missing. The version passed in is the floor because the read can be
stale (a 404 right after the first publish, a `latest` not yet updated, a
read that misses this run's own RC): `rc` is never moved below what the run
itself published. So whichever finishes last leaves `rc` on the newer. At
worst, an RC run that checked just before the release lands publishes
`X.Y.Z-rc.N` after `X.Y.Z` (its tag sorts before the release's), and `rc` is
put back on `X.Y.Z` by the same run. Promote and `pnpm release publish`
refuse a release that isn't newer than `latest`, so `latest` never moves
back either.

## Setup (the owner)

In this order. Before any of it: npm two-factor on the account `gilthans`
for **authorization and writes** (done), and `npm login` on the owner's
machine.

1. **Make Gilthans/carbonless public** (done).
2. **Environment `npm`**, Settings → Environments → New environment
   **`npm`**: Deployment branches and tags → Selected → `master`. No
   reviewers, no secrets. Check the environment's page shows that rule: a
   job that names a missing environment makes GitHub create it with **no**
   rule, which would let any branch's workflow get npm's credential.
3. **A ruleset on `master`**, Settings → Rules → Rulesets: pull request
   required, status check `checks` (CI) required, require review from code
   owners (`.github/CODEOWNERS` makes `.github/` and the release scripts
   the owner's), no direct pushes, no force pushes, no deletion, no
   bypass.
4. **Actions may create PRs**, Settings → Actions → General → Allow GitHub
   Actions to create and approve pull requests (the "next" PR). The
   default workflow permissions stay read-only: every workflow asks for
   what it needs.
5. **Approval for fork PRs' workflows**, Settings → Actions → General →
   Approval for running fork pull request workflows from contributors:
   require approval for first-time contributors (or, stricter, for all
   outside contributors).
6. **Merge the PR that brings these workflows.** Its CI run makes
   `release.yml` tag `v0.1.0-rc.N` (N after the interim RCs) without
   publishing (the package isn't on npm yet); the summary says to promote
   it.
7. **Promote, and the first publish with the OTP:** `pnpm release promote`
   (the newest RC). When its run is green, on the owner's machine: `pnpm
   release publish` (answer y, then the OTP). This first one is published,
   not staged: `0.1.0` goes to `latest`; release-finish tags `v0.1.0`,
   opens "next: 0.2.0", and asks `release.yml` to move `rc` (that fix-up
   fails until step 8: no trusted publisher yet; harmless).
8. **Trusted publisher.** Check once more that Settings → Environments →
   `npm` shows Deployment branches: `master`. Then npmjs.com →
   carbonless-review → Settings → Trusted publishing: add GitHub Actions,
   organization or user `Gilthans`, repository `carbonless`, workflow
   filename `release.yml`, environment `npm`; allow `npm publish` and `npm
   dist-tag` (staging is always allowed). It expires unless used within 2
   days (step 10).
9. **npmjs.com → carbonless-review → Settings → Publishing access:**
   "Require two-factor authentication and disallow tokens".
10. **Merge "next: 0.2.0" within 2 days of step 8**: the trusted publisher
    publishes `0.2.0-rc.1` to `rc` (with provenance). Check `npm view
    carbonless-review dist-tags` (`latest: 0.1.0, rc: 0.2.0-rc.1`) and `npm
    view carbonless-review@0.1.0 gitHead` (the promoted RC's commit). The
    "next" PR shows no CI checks until someone pushes to it or closes and
    reopens it ("What GITHUB_TOKEN can't do"). From here the owner's main
    follows npm `rc` (machine-specific steps: CLAUDE.local.md).

From then on a release is: `pnpm release promote` (CI stages it), then
`pnpm release publish` (the owner approves it with the OTP). Promoting the
same version twice leaves two staged entries on npmjs.com's Staged Packages
tab: `pnpm release publish` refuses until the extra one is rejected, and on
the website, approve only the stage id in the promote run's summary.

## When something fails

- **The RC run failed before `npm publish`:** nothing is published; the next
  merge publishes the next number. To retry the same commit, re-run the
  failed jobs. Re-running an RC run (or CI) whose RC was already published
  publishes the same commit again as `rc.N+1`: harmless, a spare number.
- **Published, but the tag push failed:** the next RC's number already
  skips it (npm's versions count); the owner may push the tag by hand
  (`git tag vX.Y.Z-rc.N <sha> && git push origin vX.Y.Z-rc.N`).
- **`npm publish` or `npm dist-tag` fails with a 401/403:** the trusted
  publisher doesn't match (file name `release.yml`, environment `npm`,
  repository) or expired (unused for 2 days after it was added): fix or
  re-add it on npmjs.com, then re-run.
- **promote failed:** nothing is live; fix and run it again. A version
  staged by a failed run stays staged until rejected (its stage id is in
  the run's summary; `pnpm release publish` refuses while two entries of
  one version are staged): `npm stage list carbonless-review`, then `npm
  stage reject <id>` (2FA). The tag of a
  staged version can't be changed: reject and stage again.
- **`pnpm release publish` failed at `npm stage approve`** (a wrong OTP,
  the network): nothing else was done; run it again with the same run id.
- **release-finish failed** (after the release is live): start it again,
  `gh workflow run release-finish.yml --ref master -f version=X.Y.Z -f
  run=<promote run id>` (or re-run the failed job). Each step skips what is
  done: the tag when origin's already points at the RC's commit, the move
  of `rc` when it isn't behind, the "next" PR once master's version moved
  on (an existing `next/X.Y.Z` branch is left as it is; only its PR is
  opened if missing). It needs the promote run's artifact, which GitHub
  keeps for 30 days: after that, tag and open the "next" PR by hand
  (`pnpm release next`). `pnpm release publish` run again also starts it,
  without approving twice (npm already has that tarball).
- **`rc` stays behind `latest`** (the fix-up failed): nothing else is
  wrong. The next RC run moves it (any merge; it does so even when it
  publishes no RC), or `gh workflow run release.yml --ref master -f
  mode=fixup -f version=X.Y.Z`.

## Later cleanup

- **A release PR instead of a dispatch:** a bot keeps a "release X.Y.Z" PR
  open (changelog and version), and merging it is the release (the
  release-please / changesets pattern); staging with the owner's approval
  would stay the gate.
