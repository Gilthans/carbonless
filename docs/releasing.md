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

Every change reaches master through a PR merged on the owner's approval (by
the owner, or by their agent on their word for that PR); nobody
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
     master), checks that CI passed on the RC's commit (below), sets the
     version `X.Y.Z` (and the RC's commit as `gitHead`), packs it,
     smoke-tests that very tarball, and **stages**
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
     `docs/changelog.md`. It is merged on the owner's approval like any other; its
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

### What promote checks

CI already ran the whole suite (lint, typecheck, unit tests, the pack
smoke test, Playwright) on the RC's commit: `rc-build` only runs on CI's
success for a push to master. So promote doesn't run it again (a flaky
test can't fail a release that CI passed). It checks what is unique to
the release, in two jobs; an estimate, not measured yet: a few minutes in
all, where the suite took 10–15.
1. **`promote-ci`: CI passed on the RC's commit.** It installs nothing
   and runs no code of the repository before its token step. git finds
   the RC (the tag given, else the newest `vX.Y.Z-rc.N`) and its commit;
   `gh api`, the job's only step with the token (`actions: read`), lists
   `ci.yml`'s runs at that commit; then `node scripts/ci-passed.mjs` (no
   dependencies, no token) requires one for event `push` on `master` of
   this repository at exactly that sha, completed with conclusion
   `success` (every job). A run re-run green counts (GitHub lists each
   run's latest attempt). It fails, saying which, when there is none, it
   failed, or it is still running.
2. **`promote-check`: the release tarball itself** (after `promote-ci`,
   with no token at all). It plans the RC again with `release.ts` (on
   master, not released) and fails unless that is the tag and commit
   `promote-ci` checked. Then the RC packed as `X.Y.Z` (its
   `build-info.json` must say that version and the RC's commit, and its
   sha256 is recorded), and master's `node scripts/pack-smoke.mjs "$TGZ"`
   on that very tarball: installed globally into a temp dir, its `crb
   --version`, `--help` and `crb serve` answering. The manifest is of that
   file, refused if its sha256 changed since the pack, and the stage job
   stages only it. CI runs the smoke test the same way, on a tarball it
   packs first; `pnpm test:pack` (in `pnpm verify`) packs its own.

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
is `npm publish` with staging, the same path). But npm skips it silently
when it can't tell the package is public, so the RC run's last step
fails unless `npm view carbonless-review@X.Y.Z-rc.N dist.attestations`
shows a provenance (retrying for up to ~10 minutes while the registry
catches up). A staged release can't be checked that way: npm shows it
only once approved, and `npm stage view` needs the owner's interactive
login, not CI's OIDC; the owner checks it after approving (setup, step
10). The first release, which the owner publishes from their machine, has
none.

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
- What keeps that to the owner: the ruleset on `master` (only the owner's
  login can update it, and only by merging a PR; no force pushes or deletion),
  the environment `npm` limited
  to `master` (npm checks the repository, the workflow file and the
  environment name, not the branch: the environment's branch rule is the
  only thing that keeps a workflow on another branch from getting npm's
  credential), and the owner's 2FA approval of every staged `latest`.
  Merging only PRs the owner read, on the owner's word, is the rest.
- Only the owner approves a merge: the ruleset's "Restrict updates" lets
  only its bypass list (the owner, as repository admin, for pull requests
  only) update `master`, whatever access a collaborator has. Anyone can
  still open a PR or leave a review; neither moves `master`.
  `.github/CODEOWNERS` only asks for the owner's review on what can
  publish. The owner's agents act through the owner's GitHub login, so to
  GitHub they are the owner: they may merge on the owner's behalf, but only
  on the owner's explicit approval of that PR (`gh pr merge --admin`, the
  bypass; CLAUDE.md, "How we work").
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
  environment, no OIDC. With approval required for all external
  contributors (setup, step 5), a fork's runs wait for the owner unless
  its author is a collaborator.
- A fork's CI completing also starts `release.yml` (`workflow_run` fires
  for any CI on a branch called `master`, a fork's too). Both RC jobs
  check in their own `if` that CI ran for a push of this repository
  (`workflow_run.event == 'push'` and `head_repository == repository`),
  so such a run does nothing.
- The promote and fix-up jobs, and release-finish, run only on a dispatch
  of `master` (`github.ref`), which needs write access; the `npm`
  environment's branch rule is the gate behind that.
- Caches a PR's run writes are scoped to that PR's ref: master's runs never
  restore them.
`scripts/release.test.ts` checks all of this in the workflow files.

All workflows check out with `persist-credentials: false`: the GitHub token
is not in `.git/config` while `pnpm install`, the build or the tests run.
Only the steps that reach origin (the tip check, pushing tags and the
`next/*` branch, the PR, starting the fix-up, listing CI's runs on the
RC's commit in `promote-ci`) get `GITHUB_TOKEN` (git gets
it through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, not
on its command line). Steps that need tags read the checkout's own (a
full-history checkout has every tag). In `release.yml` no job's or the
workflow's `env` holds the token, and a step with it never follows, in its
job, a step that runs code of the repository or its dependencies
(`scripts/release.test.ts` checks both).

### What GITHUB_TOKEN can't do

Tags and PRs created with the workflow's `GITHUB_TOKEN` start no workflows.
So an RC tag starts no CI run (promote relies on CI's run for the push
to master at the RC's commit instead), and the "next" PR shows no CI checks until
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

## Updating an installed crb

`crb serve` tells the reviewer when npm has a newer crb and updates itself
on one click (CAR-108; never automatically). Code: `src/server/update`,
`src/web/UpdateToast.tsx`.

- **Check.** At start and every hour (RCs land several times a day), crb
  asks the registry (`$CRB_NPM_REGISTRY`, default
  `https://registry.npmjs.org`) for `carbonless-review`'s dist-tags and
  takes its channel's tag. Only a version strictly newer by semver counts.
  A failure (offline, a 404 before the first publish, a bad answer) never
  shows a toast; crb keeps when it last checked and why that failed, for
  the Global settings page.
- **Global settings** (`/settings`, the gear's "Global settings" row on
  Home and on a review): the running version and commit (linked to it on
  GitHub), the channel, how crb was installed (npm global, pnpm global, or
  update by hand), when it last checked, and **Check for updates**
  (`POST /api/update/check`: checks now, sharing a check already under
  way, and answers the fresh `/api/update`; the hourly timer keeps its
  times). A newer version shows there with the toast's own Update (or the
  command), a failed check says why with Retry. A build that never checks
  says why instead (local build, `CRB_NO_UPDATE_CHECK`, `updates.check`
  off) and has no Check button.
- **Channel**, durable: an RC install stays on `rc` for good.
  - The first time crb runs a prerelease, it writes `rc` to
    `update-channel` in its state dir. From then on it follows `rc`, also
    once `rc` has moved onto a release `X.Y.Z` and it runs that release:
    it is offered `X.Y.Z+1-rc.N` as they come out, never pushed onto
    `latest`. It is also offered `latest` when that is newer than `rc` (a
    fix released without moving `rc`), and stays on `rc` after it.
  - A crb that never ran a prerelease follows `latest`.
  - `"updates": { "channel": "rc" | "latest" }` in config.json wins over
    both. Set `"rc"` for an install made from `@rc` while `rc` pointed at
    a release (it never ran a prerelease, so nothing is remembered). Set
    `"latest"` to leave `rc`; deleting `update-channel` does too.
  - A restart keeps the channel: the file and the config outlive it.
- **Only builds npm served.** The check runs only when the package crb runs
  from (in some `node_modules`) has a `package.json` whose `gitHead` is the
  build's own clean commit, at the build's version: CI writes `gitHead` into
  every RC and release ("The version in a build" above), while `pnpm
  build`, the dev server, a checkout and `pnpm release local` (what a machine
  following master installs) have none. Off switches: `CRB_NO_UPDATE_CHECK=1`,
  or `"updates": { "check": false }` in config.json.
- **The toast**, on every page: the version (linking to its tag,
  `https://github.com/Gilthans/carbonless/releases/tag/v<version>`), Update
  and a dismiss (remembered per version in the browser). Pages poll
  `/api/update` every 10 minutes, every 5 seconds while an update is on
  offer, so every open tab sees an update another one started. Toasts share
  one stack, which sits above the save notices on a phone.
- **Who installs it**, told from where crb runs (its real path):
  - npm: `<prefix>/lib/node_modules/carbonless-review` with the `crb` shim
    in `<prefix>/bin` (Windows: `<prefix>\node_modules\...` and
    `<prefix>\crb.cmd`). The install is `npm install -g --prefix <prefix>`,
    run by the prefix's own npm, else the one beside the running node, else
    PATH's: whichever npm, it goes where crb is.
  - pnpm: `<PNPM_HOME>/global/<vN>/.../.pnpm/.../carbonless-review`. The
    install is `pnpm add -g` (with the release-age exemption above) by
    PNPM_HOME's pnpm (else PATH's), with `PNPM_HOME` set and its bin dir
    first on PATH (pnpm refuses `add -g` otherwise).
  - Anything else (yarn, bun, volta, a project's dependency, npx), or a
    global dir crb can't write (a system node's `/usr/lib/node_modules`):
    the toast shows the command to copy instead of the button.
  - Only a checked version (semver, at most 64 characters) reaches a
    command line; a registry answer over 64 KB is ignored.
- **Update** asks first when the page has unsaved work (what leaving the
  page asks about). When crb is back on the new version, a page with
  nothing unsaved reloads; one with unsaved work (typed while crb was down,
  or in a tab whose reviewer didn't click Update) shows "Updated" with a
  Reload button instead, and leaving asks as it always does. A failure
  shows the install's output and the command, with Retry; dismissing it
  keeps the offer. No answer within 5 minutes is a failure too.
- **Restart in place** (no service manager). crb answers "restarting" for
  6 seconds (so every tab sees it), then exits, freeing its port. A helper,
  copied to a temp dir of its own (never run from the package being
  replaced) and started detached with node from the temp dir above it,
  waits for crb's pid to exit, runs the install, leaves the outcome in the
  state dir (`update-result.json`, 0600), and starts crb again: node (with
  crb's node flags) on the new version's `cli.js`, found where the install
  put it (npm: in place; pnpm: a new dir in its global dir per install),
  else the old one; the same arguments (on the port it listened on,
  without `--new-key`), directory and environment. No shell for the
  restart; on Windows, `npm.cmd`/`pnpm.cmd` go through cmd.exe with every
  part quoted. The helper logs to `update.log` in the cache dir (0600);
  the restarted crb logs to `serve.log` in the state dir, as when `crb
  <pr>` starts it. The helper's config holds crb's environment: 0600,
  deleted once read, and its dir is removed at the end (or if it never
  starts).
- **Under a service manager** that starts crb again, crb installs while it
  still serves (killed after 10 minutes), then exits for the manager to
  start the new version (the manager would kill a helper left in its unit,
  or start crb while the install runs):
  - systemd, when crb is its unit's main process: exit 75 for
    `Restart=always`/`on-failure`, 0 for `on-success`, the command for any
    other. A crb inside a systemd service that isn't its main process (a
    wrapper script, a shell the unit runs; use `exec`), or one systemctl
    can't tell about, gets the command, never a helper systemd would kill.
  - pm2, and anything that sets `CRB_SERVICE=1` in crb's environment
    (launchd, a Windows service wrapper such as NSSM or WinSW, a
    container's restart policy): exit 75.
  - PID 1 without `CRB_SERVICE` (a container that ends with crb): the
    command.
  - A failed install leaves crb running and shows the output. The unit's
    `PATH` must reach the package manager.
  - ExecStart must run the `crb` shim (`$PNPM_HOME/bin/crb`, npm's
    `<prefix>/bin/crb`), never a versioned `.../cli.js`: pnpm puts each
    version in a new directory and rewrites the shim, so a unit pointing at
    the old `cli.js` would restart the old version (and be offered the same
    update again). The shims `exec` node, so crb stays the unit's main
    process.
  - An rc install under systemd (`crb.service`, `Restart=on-failure`):
    installs the new RC with the install's own npm or pnpm, exits 75, and
    systemd starts the new version; the channel keeps it on `rc`. Example,
    a user unit after `pnpm add -g carbonless-review@rc
    --config.minimumReleaseAgeExclude=carbonless-review`:

    ```ini
    # ~/.config/systemd/user/crb.service
    [Unit]
    Description=carbonless review server (crb serve)
    StartLimitIntervalSec=0

    [Service]
    Type=simple
    # Node 24's bin dir (yours) and the pnpm bin dir: crb's shim runs
    # node, and the update runs pnpm.
    Environment="PATH=/path/to/node-24/bin:%h/.local/share/pnpm/bin:/usr/bin:/bin"
    ExecStart=%h/.local/share/pnpm/bin/crb serve
    Restart=on-failure
    RestartSec=5

    [Install]
    WantedBy=default.target
    ```

    and in `~/.config/carbonless/config.json` (rc for good, even when the
    first version installed from `@rc` is a release):

    ```json
    { "updates": { "channel": "rc" } }
    ```

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
3. **A ruleset on `master`**, Settings → Rules → Rulesets → New branch
   ruleset `master`, Active, target the default branch. Bypass list: the
   Repository admin role, mode "For pull requests only". Rules: Restrict
   updates (only the bypass list updates `master`: the owner, or their
   agents on the owner's approval, nobody else, whatever their access), Restrict deletions, Block force
   pushes, Require a pull request before merging (0 approvals: only the
   owner's login can merge anyway), Require status checks to pass (`checks`,
   `windows-agent`, `e2e`). Not "Require review from Code Owners": with
   Restrict updates it adds nothing. Nobody pushes straight to `master`,
   the owner included; the owner can merge any PR, with or without an
   approval or green checks (GitHub's "bypass rules" box).
4. **Actions may create PRs**, Settings → Actions → General → Allow GitHub
   Actions to create and approve pull requests (the "next" PR). The
   default workflow permissions stay read-only: every workflow asks for
   what it needs.
5. **Approval for fork PRs' workflows**, Settings → Actions → General →
   Approval for running fork pull request workflows from contributors:
   require approval for all external contributors. Only people the owner
   has vetted (added as collaborators) run CI without the owner's
   approval; everyone else's runs wait for it, every time.
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
    view carbonless-review@0.1.0 gitHead` (the promoted RC's commit), and
    that `npm view carbonless-review@0.2.0-rc.1 dist.attestations` shows a
    `provenance` (the run checks it too). The "next" PR shows no CI checks
    until someone pushes to it or closes and reopens it ("What
    GITHUB_TOKEN can't do"). From here the owner's main follows npm `rc`
    (machine-specific steps: CLAUDE.local.md). On the first staged release
    (0.2.0), after approving it: `npm view carbonless-review@0.2.0
    dist.attestations` shows a `provenance` too.

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
- **promote failed:** nothing is live. "CI has no run / did not pass /
  is still running on <sha>": wait for CI, or re-run its failed jobs on
  GitHub, then promote again (or promote a newer RC). "planned … but
  promote-ci checked …": the RC changed between the two jobs; promote
  again. A failed smoke test or build-info check is a packaging bug: fix
  it on master and promote the next RC. The smoke test is master's: on an
  older RC it can fail because master's script expects newer behaviour
  (its `--help` text, the server's log line); promote the newest RC. Otherwise fix and run it again. A version
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
