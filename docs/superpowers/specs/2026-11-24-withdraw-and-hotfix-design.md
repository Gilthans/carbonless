# Withdrawing a bad release, and hotfixes (CAR-212)

Status: design, 2026-11-24. Owner decisions are quoted; the coordinator's own
calls are marked **(call)** for the owner to check.

## Why

The owner, 2026-11-22:

> Currently me and a few friends install carbonless. I'm worried of a few
> scenarios: 1) somehow, a malicious actor deploys a version of carbonless
> with a vulnerabilty and I want to make sure no one upgrades to it. 2) A bad
> version with a serious bug gets deployed and I want everyone to get a fast
> fix. What do most installed packages do in this scenario? In SaaS usually
> you'd rollback to the previous version, but I don't know how you would do
> that in case of a deployed software like this

Installed software rolls forward: there is no server to roll back. What we can
do is stop a bad version from spreading, tell everyone running it, and get a
fixed version to them fast. The owner, 2026-11-23: "When we withdraw we'll
follow it up with a quick version", and "Quick version should support a
hotfix, i.e. a branch off of any point in master with a specific hotfix. That
would be the fastest path".

## Goals

1. **Withdraw** one or more published versions (releases or RCs) with one
   owner command: nobody newly installs or updates to them.
2. **Everyone running it knows**, the next time crb checks, and is offered the
   fix as soon as it exists.
3. **A hotfix** ships one fix on top of the release being fixed, without
   master's unreleased work, through the
   same promote and owner-2FA publish as any release.
4. The procedure is written down in CLAUDE.md (owner, 2026-11-24: "Make sure
   the procedure is documented in claude.md in the PR"), and in
   docs/releasing.md.

## Non-goals and anti-goals

- **No automatic rollback inside crb** (owner decision). crb never downgrades
  itself; it only stops offering a bad version and pushes the fix.
- No carbonless server (design principle 4): everything goes through npm and
  GitHub.
- Not `npm unpublish`: it only works for 72 hours, burns the version number,
  and breaks anyone pinned to it. Deprecate and move tags instead.
- A withdrawal must never be possible without the owner's npm 2FA (agents
  never run it, as with `pnpm release publish`).

## 1. Withdraw

`pnpm release withdraw <version>... "<why>"`, run by the owner on their
machine (npm asks for their OTP; agents never run it, never handle the OTP).

It takes several versions at once **(call)**: a bad change in 0.4.0 usually
also sits in the 0.5.0-rc.N builds on `rc`, so the command shows every version
published since the first one named, and a named release's other
`X.Y.Z-rc.*` builds, for the owner to add any that carry the same bug. The RC
a named release was promoted from (the `vX.Y.Z-rc.N` tag on the same commit as
`vX.Y.Z`: the same code) is withdrawn with it without being named, and the
plan says so (coordinator, 2026-11-27). An RC user's fix is a new RC from
master (the fix's PR to master), not the hotfix, which is older by semver.

It:

1. Checks the version exists on npm and isn't withdrawn already, and finds the
   newest good version for each dist-tag that points at it: `latest` goes back
   to the newest release before it that isn't deprecated; `rc` goes back to
   the newest non-deprecated version at or below it (an RC or a release), but
   never an `X.Y.Z-rc.*` of a release being withdrawn: right after a release
   `rc` and `latest` are both on X.Y.Z, and its RCs carry the same code, so
   `rc` goes below them (usually the previous release). It refuses a reason
   that is a version (the reason was forgotten). It prints the plan and asks
   y/N.
2. `npm deprecate carbonless-review@X.Y.Z "<why>"`: npm then warns anyone who
   installs it by hand. The message starts with a fixed prefix (e.g.
   `withdrawn: `) so crb can tell a withdrawal from any other deprecation
   **(call)**.
3. `npm dist-tag add carbonless-review@<good> latest` (and `rc`), so a fresh
   `npm i -g carbonless-review` never lands on it.
4. Prints what changed and the next step: "now ship a fix: `pnpm release
   hotfix vX.Y.Z`", with the withdrawn release.

It is idempotent (a rerun after a half-done run finishes the job), and it
refuses when no good version is left for a tag (e.g. withdrawing 0.1.0): it
says so rather than leaving `latest` on the bad one, and does the deprecation
only on `--deprecate-only` **(call)**.

`pnpm release status` shows withdrawn versions.

## 2. What crb shows

crb's update check (`src/server/update/registry.ts`, every hour and from the
page every 10 min) also learns whether the running version is withdrawn, and
whether any candidate it would offer is. It reads npm's per-version metadata
for the running version and the candidate (only `deprecated` matters), not the
whole packument **(call: builder picks the cheapest request that gives it)**.

- **A deprecated version is never offered** as an update, on any channel,
  even when it's the newest; the newest non-deprecated one is offered
  instead (or nothing).
- **Running a withdrawn version:** a red banner across the top of every page
  (it pushes the page down and stays pinned; it never covers the header:
  "Bars push, not cover"), with an alert icon, "Withdrawn" and the owner's
  reason (from the deprecation message, without the prefix, as plain text:
  untrusted, escaped). With a fix on offer it has the Update button (the same
  install flow as the toast, What's new included); without one it says a fix
  is coming and keeps checking. It can't be dismissed **(call)**. By-hand
  installs show the command, as the toast does.
- Works down to 360px, 40px tap targets, design tokens only (red = failing),
  tooltip and accessible name on the icon, loading never looks empty
  (principles 5, 6, 8).

Mockups: the spec artifact (desktop and phone, with and without a fix).

## 3. Hotfix

Commands (agents may run the first two on the owner's word, like `next` and
`promote`; `publish` stays the owner's):

1. `pnpm release hotfix [vX.Y.Z]` (default: the newest release tag by
   semver, normally the one `latest` points at, or after a withdraw the
   withdrawn one, so 0.4.1 is offered to a crb on 0.4.0; only that line is
   accepted, see "Which release lines"): creates `hotfix/X.Y.Z+1` on origin
   at that release tag's commit. It starts from a
   release tag, never another commit (owner, 2026-11-24, choosing release
   tags only: "If it's simpler, let's do (b)"), so a hotfix carries nothing
   but its fix. A second hotfix of the same line starts from the first
   hotfix's tag (`v0.4.1` → `hotfix/0.4.2`).
2. The fix reaches the hotfix branch only as a PR into it, with full CI and
   a release note, like any PR to master; usually a cherry-pick of a fix PR
   to master, or written there first and then brought to master (step 5).
3. `pnpm release promote --hotfix X.Y.Z+1`: promotes the hotfix branch's head
   once CI passed on it. **No RC on the `rc` channel first** **(call: the
   owner asked for the fastest path; the RC step can be added later)**. The
   notes cover only the branch's PRs since the release it starts from.
4. The owner's `pnpm release publish` as today. release-finish tags
   `vX.Y.Z+1` on the hotfix branch's head, moves `latest` to it, moves `rc` only if `rc` is older
   (semver) than it, opens no "next" PR, and does **not** freeze master.
5. **The fix must reach master.** release-finish (or `hotfix` itself) checks
   whether each hotfix PR's change is on master (by ticket or patch-id) and,
   for any that isn't, opens a cherry-pick PR to master (or says which to
   port when it doesn't apply cleanly). `pnpm release status` lists a hotfix
   whose fix master still lacks.

Version numbers: master keeps its next version (e.g. 0.5.0); hotfixes of
0.4.0 are 0.4.1, 0.4.2, ... The next regular release's notes start from the
newest release by semver on master's line (0.4.0), and must not list the
hotfix's PRs again once they are cherry-picked (match by ticket) **(call)**.

### Which tooling runs a hotfix **(call)**

Master's. The promote and finish runs are dispatched on master as today and
take the hotfix branch as an input: master's `release.yml` and `release.ts`
pack and stage the hotfix branch's tree (a branch cut from v0.4.0 has none of
the hotfix support, and its old workflows must never publish). So the `npm`
environment stays master-only. `pnpm release hotfix` only creates the branch
at the release tag's commit (no commit of its own: the version is set at pack time,
as `ci:set-version` does today), so no ruleset exception is needed. PRs into
the branch run the branch's own CI (which tests that tree), plus master's
`release-note` check (`pull_request_target`).

### Which release lines **(call)**

Only the newest release line: a hotfix of the newest release tag by semver
(normally the one `latest` points at; after a withdraw, `latest` has moved
back but the withdrawn release is still the newest, and its hotfix is what
crbs running it are offered). Older lines (0.3.1 while 0.4.0 is out) are out
of scope: they would need per-line dist-tags and a different update check.

### Protection for hotfix branches (security, owner review)

Today only master can publish to npm (the `npm` environment allows master
only; the master rulesets). A hotfix branch can publish, so it needs the same:

- `hotfix/*` covered by both rulesets (`Master`: only the owner's login
  updates it, only through a PR, no force push or deletion; `Master checks`:
  required checks, no bypass). Creating the branch stays open to agents
  (it only points at a commit already on master).
- The `npm` environment and release.yml's master-only conditions stay as
  they are: master's workflows publish the hotfix tree (above).
- docs/releasing.md "Trusted publishing" updated: whoever can change a hotfix
  branch can change what gets published, so the same rules apply.

The owner makes the settings changes (or approves an agent doing them through
the API), as with the ruleset split.

## 4. Documentation

- **CLAUDE.md, "Versions and instances"**: a short "Withdraw and hotfix"
  procedure: when to withdraw (a vulnerability, a serious bug), the owner runs
  `pnpm release withdraw`, then `pnpm release hotfix`, the fix PR into the
  hotfix branch, promote `--hotfix`, the owner publishes, the fix reaches
  master; what agents may and may not run.
- docs/releasing.md: the full procedure, the settings, and a runbook for the
  malicious-version case (rotate what leaked: npm trusted publisher, GitHub
  access; check what else the compromised path published).

## Testing

Unit tests for the withdraw plan (which tag moves where, idempotent rerun, no
good version left), the update check (deprecated never offered; running
withdrawn detected; prefix parsing; untrusted text), hotfix versioning and
notes ranges, the cherry-pick check, and the workflow YAML (environment and
ref conditions; RC publishing never from hotfix branches). Playwright: the
banner (desktop and phone, with and without a fix, Update flow, loading
state) with the fake registry. No real npm writes in tests; the first real
withdraw is a drill on an RC the owner picks **(call)**.

## Left to the builder

The exact registry requests, how release-finish learns it's finishing a
hotfix, the cherry-pick detection, and splitting this into PRs (suggested:
1. withdraw command + crb never offering deprecated versions + banner;
2. hotfix tooling + workflow and settings; 3. docs, if not in each).
