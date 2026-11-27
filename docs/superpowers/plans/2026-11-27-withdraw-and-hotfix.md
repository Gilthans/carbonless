# Withdraw and hotfix (CAR-212) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can withdraw a bad npm version with one command; every crb running it shows a red banner and is offered the fix; a hotfix branch off a release tag ships one fix through the usual promote and owner-2FA publish.

**Architecture:** Three PRs, one brief each (CLAUDE.md "How we work"). PR 1: `pnpm release withdraw`, crb's update check learning `deprecated`, and the Withdrawn banner. PR 2: `pnpm release hotfix`, `promote --hotfix`, the workflow changes (master's workflows build the hotfix branch's tree), the master cherry-pick check. PR 3: CLAUDE.md and docs/releasing.md (each PR also updates the docs it makes wrong; PR 3 writes the procedure and runbook once both exist).

**Tech Stack:** TypeScript, Node 24, Vitest, Playwright, Fastify, React + TanStack Query, GitHub Actions, npm CLI (`npm deprecate`, `npm dist-tag`, `npm view`).

**Spec:** `docs/superpowers/specs/2026-11-24-withdraw-and-hotfix-design.md`

## Global Constraints

- The deprecation message prefix is exactly `withdrawn: ` (lower case, colon, one space). A deprecation without it is not a withdrawal.
- Never `npm unpublish`. Never a real npm or registry write in tests; release commands take the existing injected `Io` (`scripts/release-lib.ts`).
- `withdraw` and `publish` are the owner's (npm OTP); agents never run them. `hotfix` and `promote --hotfix` run on the owner's word.
- A hotfix branch starts only at a `vX.Y.Z` release tag's commit: the newest release tag by semver (normally the one `latest` points at; after a withdraw, the withdrawn one), or the newest hotfix tag of that line (`v0.4.1` → `hotfix/0.4.2`). Any other start is refused.
- No RC step for hotfixes; the `npm` environment stays master-only; release.yml / release-finish.yml are dispatched on master and get the hotfix branch as an input.
- The banner: red (failing) tokens only, pushes the page down and stays pinned (never covers the header), can't be dismissed, works at 360px with 40px tap targets, icon with tooltip and accessible name, the reason as escaped plain text.
- Loading never looks empty (principle 8): no banner and no "fix coming" text before the check answered.
- Untrusted text (the deprecation reason, notes, branch names) never reaches a shell, `${{ }}` in `run:`, HTML or markdown unescaped.
- `.github/` and release-script changes: the PR body says so for the owner's review (CODEOWNERS). Ruleset/settings changes for `hotfix/*` are the owner's.

## Review Focus

1. **Registry answers that lie or fail:** a deprecated field that isn't a string, a 404 for the running version (a local or unpublished build), a timeout on the per-version request. Expected: no banner, the offer as before, never a crash or a banner from a bad answer. (Task 3 tests.)
2. **A withdrawn version that is also the newest on both tags, with nothing good left on `rc`:** expected: `rc` falls back to the newest good release, and crb on `rc` is offered that (older-than-running versions are never offered, so it shows "fix coming"). (Task 1 and Task 3 tests.)
3. **A half-done withdraw rerun** (deprecated, but tags not moved; or tags moved, one deprecation missing): expected: finishes only what's missing, says what it skipped. (Task 1 test.)
4. **A reason with markup, newlines or bidi characters:** expected: shown as plain single-line text, no HTML, control and bidi characters replaced (as `pnpm release publish` does for notes). (Task 4 test.)
5. **Hotfix finish while `rc` is newer by semver** (0.5.0-rc.3 on `rc`, hotfix 0.4.1): expected: `rc` stays, `latest` moves, master isn't frozen, no "next" PR. (Task 7 test.)

---

## PR 1: withdraw, the update check, the banner (`car-212-withdraw`)

### Task 1: The withdraw plan (pure)

**Files:**
- Create: `scripts/release-withdraw.ts`, `scripts/release-withdraw.test.ts`
- Modify: `src/shared/update.ts` (the prefix, shared with crb)

**Interfaces:**
- Produces, in `src/shared/update.ts`:
  - `export const WITHDRAWN_PREFIX = "withdrawn: "`
  - `export function withdrawnReason(deprecated: unknown): string | null`: the text after the prefix, single line, control/bidi characters replaced, at most 300 characters; null when not a string or no prefix.
- Produces, in `scripts/release-withdraw.ts`:
  - `interface RegistryState { versions: string[]; deprecated: Record<string, string>; distTags: Record<string, string> }`
  - `interface WithdrawPlan { deprecate: { version: string; message: string }[]; tags: { tag: string; from: string; to: string }[]; skipped: string[]; refused: string | null }`
  - `planWithdraw(state: RegistryState, versions: string[], why: string, opts: { deprecateOnly: boolean }): WithdrawPlan`
  - `laterVersions(state: RegistryState, first: string): string[]`: every published version newer than `first` (semver), for the "add any that carry the same bug" list.

- [ ] **Step 1: Write the failing tests** in `scripts/release-withdraw.test.ts`:
  - `latest` on 0.4.0, withdraw 0.4.0 → `tags` has `{tag:"latest", from:"0.4.0", to:"0.3.0"}`; deprecate message `"withdrawn: <why>"`.
  - `rc` on 0.5.0-rc.2, withdraw 0.4.0 and 0.5.0-rc.1, 0.5.0-rc.2 → `rc` goes to the newest non-deprecated version at or below it (0.5.0-rc.0 if good, else 0.3.0).
  - An already deprecated version among the targets (with the prefix) → in `skipped`, not in `deprecate`; a tag already moved → no tag entry (idempotent rerun).
  - Withdrawing the only release → `refused` names the tag; with `deprecateOnly`, `refused` null, `tags` empty, `deprecate` filled.
  - A version not on npm → `refused`.
  - `laterVersions(state, "0.4.0")` lists 0.4.1?, 0.5.0-rc.N in semver order.
  - `withdrawnReason`: `"withdrawn: bad\nthing\u202e"` → `"bad thing�"` (or the project's replacement character); `"deprecated for other reasons"` → null; `42` → null.
- [ ] **Step 2: Run** `pnpm test scripts/release-withdraw.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with `parseVersion`/`compareVersions` from `release-lib.ts` (semver order, prereleases below their release).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** (`git commit --only`).

### Task 2: `pnpm release withdraw` and `status`

**Files:**
- Modify: `scripts/release.ts` (case `"withdraw"`), `scripts/release-lib.ts` (`status`), `scripts/release.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `withdraw(io: Io, args: { versions: string[]; why: string; deprecateOnly: boolean }): Promise<void>`; CLI `pnpm release withdraw <version>... "<why>" [--deprecate-only]` (the last positional is the reason).

- [ ] **Step 1: Failing tests** with a fake `Io`: reads the registry state (`npm view carbonless-review versions dist-tags --json` plus the `deprecated` field per version: builder picks the `npm view` call), prints the later versions and the plan, asks y/N; on "n" runs nothing; on "y" runs `npm deprecate carbonless-review@X "withdrawn: <why>"` per version then `npm dist-tag add carbonless-review@<to> <tag>` per tag, then prints `pnpm release hotfix vX.Y.Z` as the next step. A refused plan exits non-zero before asking. `why` empty → refused. The reason reaches npm as one argv entry (never a shell string). `status` lists withdrawn versions with their reason.
- [ ] **Step 2: Run** `pnpm test scripts/release.test.ts -t withdraw` → FAIL.
- [ ] **Step 3: Implement.** npm asks the owner for the OTP itself (inherit stdio); never read or pass one. Check npm ≥ `MIN_NPM` as `publish` does.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 3: The update check learns `deprecated`

**Files:**
- Modify: `src/server/update/registry.ts`, `src/server/update/updater.ts`, `src/shared/update.ts` (`UpdateInfo`), `src/server/update/registry.test.ts`, `src/server/update/updater.test.ts`, `src/server/update/routes.test.ts`

**Interfaces:**
- Consumes: `withdrawnReason` (Task 1).
- Produces:
  - `checkRegistry(current, opts): Promise<RegistryAnswer>` where `interface RegistryAnswer { newer: string | null; withdrawn: string | null }` (`withdrawn`: the reason, when the running version is withdrawn). `newerOnRegistry` keeps returning `answer.newer`.
  - `UpdateInfo.withdrawn: { reason: string } | null` (null while unknown and when not withdrawn; the page tells "unknown" by `lastChecked === null`).
  - `UpdaterOptions.check` returns `RegistryAnswer`.
- Requests: dist-tags as today, then `GET {registry}/carbonless-review/{version}` for the running version and for each candidate (only `deprecated` read; same `readCapped` cap and timeout). A deprecated candidate is skipped and the other tag's candidate considered; none left → `newer: null`. A failed per-version request for a candidate → that candidate is not offered this round; for the running version → `withdrawn` stays what the last good check said.

- [ ] **Step 1: Failing tests** in `registry.test.ts` (fake fetch): deprecated `latest` never offered; on `rc`, a deprecated `rc` falls to a good newer `latest`; running version deprecated with the prefix → `withdrawn` = reason; without the prefix → null; non-string `deprecated` → null; 404 for the running version → null, no throw; per-version timeout → candidate not offered, no throw. In `updater.test.ts`: `withdrawn` reaches `info()`; an earlier offer of a now-deprecated version is dropped (today a failed check keeps `#available`: a deprecated answer must clear it).
- [ ] **Step 2: Run** `pnpm test src/server/update` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

### Task 4: The Withdrawn banner

**Files:**
- Create: `src/web/WithdrawnBanner.tsx`, `src/web/WithdrawnBanner.test.tsx`
- Modify: the app shell that holds top bars (where other pinned bars mount; follow "Bars push, not cover"), `src/web/UpdateToast.tsx` (export its install action for reuse), `e2e/update.spec.ts` (and its fake registry: per-version answers with `deprecated`), `scripts/verify-fast.mjs` `E2E_MAP` if needed

**Interfaces:**
- Consumes: `UpdateInfo.withdrawn`, `UPDATE_KEY`/`fetchUpdate` from `UpdateToast.tsx`, the toast's Update flow and What's new, `Command` for by-hand installs.
- Produces: `<WithdrawnBanner />`, rendered on every page.

Copy (concise, icon-first): `AlertIcon` (tooltip and accessible name "Withdrawn version"), the word **Withdrawn**, the reason; then either the Update button (with `available`) or "Fix coming" (without). By hand: the `Command` instead of the button. While an update installs: the toast's states.

- [ ] **Step 1: Failing unit tests**: renders nothing while `/api/update` is pending and when `withdrawn` is null; with a fix shows Update; without shows "Fix coming"; no dismiss control; a reason `<img src=x onerror=alert(1)>` renders as text.
- [ ] **Step 2: Failing Playwright tests** (desktop and phone; phone run required, this is layout): banner pinned above the header and pushing it down (header buttons clickable at 360px, no horizontal scroll, tap targets ≥ 40px); Update installs the offered version via the fake registry; loading: hold `/api/update`, no banner and no "Fix coming" text, release, banner (`expectLoadingThen`); the toast doesn't also offer the same update twice (banner wins).
- [ ] **Step 3: Run** `pnpm test src/web/WithdrawnBanner.test.tsx` and `pnpm test:e2e e2e/update.spec.ts` → FAIL.
- [ ] **Step 4: Implement** with design tokens only (`docs/design/README.md`), matching the spec artifact's mockups.
- [ ] **Step 5: Run** both → PASS; `pnpm flake-check e2e/update.spec.ts -g Withdrawn`.
- [ ] **Step 6: Commit.**

PR 1 body: `Part of CAR-212`, release note `new: A version the maintainer withdraws shows a red banner with the reason, and offers the fix as soon as it's out.`, CODEOWNERS note (release scripts).

---

## PR 2: hotfixes (`car-212-hotfix`, after PR 1 merges)

### Task 5: `pnpm release hotfix`

**Files:** Modify `scripts/release.ts`, `scripts/release-lib.ts`, `scripts/release.test.ts`

**Interfaces:**
- Produces: `hotfixStart(io: Io, from?: string): Promise<{ branch: string; version: string; sha: string }>`; `hotfixVersion(fromTag: string, tags: string[]): string` (the next patch of the line not yet tagged).

- [ ] **Step 1: Failing tests**: default start = the newest release tag by semver (normally npm `latest`'s; after a withdraw, `latest` on 0.3.0 and `v0.4.0` withdrawn → `hotfix/0.4.1` from `v0.4.0`); `v0.4.0` with `v0.4.1` existing → refuses (start from `v0.4.1`); `v0.4.1` → `hotfix/0.4.2` at `v0.4.1`'s commit; a non-tag, an RC tag, or a release older than the newest release line → refused with the reason; the branch already on origin at the same commit → no-op; at another commit → refused. Pushes only `refs/heads/hotfix/X.Y.Z` (never master, never a tag).
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit.**

### Task 6: `promote --hotfix` and the promote run

**Files:** Modify `scripts/release.ts`, `scripts/release-lib.ts` (`promote`, `resolvePromote`), `scripts/release-notes.ts` (range), `.github/workflows/release.yml`, `scripts/release.test.ts`, `scripts/release-notes.test.ts`

**Interfaces:**
- Produces: `pnpm release promote --hotfix X.Y.Z`; workflow_dispatch input `hotfix` (the branch name, validated `^hotfix/\d+\.\d+\.\d+$` in a step via env, never `${{ }}` in `run:`).
- The run: dispatched on master (all jobs keep `github.ref == 'refs/heads/master'`); checks CI passed on the hotfix branch's head; checks the head descends from the start tag and the branch name's version is that tag's next patch; packs the **hotfix branch's tree** with **master's** scripts (`ci:set-version` with `X.Y.Z`, notes from the input); smoke-tests and stages as today. RC publishing (`rc-build`/`rc-publish`) never runs for `hotfix/*` pushes.
- Notes range: start tag .. branch head (only the branch's PRs).

- [ ] **Step 1: Failing tests**: promote refuses when CI didn't pass on the head, when the head isn't on top of the start tag, when a PR in the range has no note; dispatches with `hotfix` and notes covering exactly the branch's PRs. Workflow YAML tests (`scripts/release.test.ts`): every job with `environment: npm` still requires `refs/heads/master`; the hotfix input reaches `run:` only via env; `rc-*` jobs skip `hotfix/*`.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit.**

### Task 7: Finishing a hotfix

**Files:** Modify `.github/workflows/release-finish.yml`, `scripts/release-lib.ts` (`finishPlan`), `scripts/release.test.ts`

**Interfaces:**
- Consumes: the staged package's manifest says it's a hotfix (builder's choice: a `crbHotfix` package.json field from `ci:set-version`, or the version not matching master's line).
- `finishPlan` for a hotfix: tag `vX.Y.Z` on the hotfix branch head; `latest` → X.Y.Z; `rc` → X.Y.Z only if `rc` is older by semver; no "next" PR; no freeze; the GitHub release and changelog section from the published notes as today; the changelog lands on master through the cherry-pick PR (Task 8), not a "next" PR.

- [ ] **Step 1: Failing tests** for `finishPlan`: hotfix 0.4.1 with `rc` on 0.5.0-rc.3 → `rc` untouched, no next PR, no freeze; with `rc` on 0.4.0 → `rc` moves; a regular release unchanged (regression).
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit.**

### Task 8: The fix reaches master

**Files:** Modify `scripts/release-lib.ts`, `scripts/release-notes.ts`, `.github/workflows/release-finish.yml`, tests

**Interfaces:**
- Produces: `missingOnMaster(io: Io, hotfixTag: string): Promise<{ pr: number; ticket: string | null; applies: boolean }[]>`: each hotfix PR whose change master lacks, matched by ticket (`CAR-N` in the merge title) or `git patch-id`.
- release-finish opens one cherry-pick PR to master (`hotfix-port/X.Y.Z`) for the PRs that apply cleanly, plus the changelog section; lists the others in the run summary. `pnpm release status` lists hotfixes with PRs missing on master.
- The next regular release's notes: PRs whose ticket already appears in a hotfix's published notes are left out (match by ticket).

- [ ] **Step 1: Failing tests** (git fixtures, `test/git-fixture.ts`): a fix already on master by ticket → not missing; by patch-id with another title → not missing; absent → missing, `applies` true; conflicting → `applies` false; next-release notes skip a hotfixed ticket.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit.**

PR 2 body: `Part of CAR-212`, release note `none (release tooling)`, CODEOWNERS note, and the owner's settings step: add `hotfix/*` to both rulesets (`Master`, `Master checks`).

---

## PR 3: the procedure (`car-212-docs`, may ride on PR 2)

### Task 9: CLAUDE.md and docs/releasing.md

**Files:** Modify `CLAUDE.md` ("Versions and instances": a "Withdraw and hotfix" procedure), `docs/releasing.md` (full procedure, settings, "Trusted publishing" on hotfix branches, the malicious-version runbook)

- [ ] **Step 1:** CLAUDE.md: when to withdraw; the owner runs `pnpm release withdraw`; `pnpm release hotfix` on the owner's word; the fix PR into `hotfix/X.Y.Z`; `promote --hotfix`; the owner publishes; the port PR to master; what agents may and may not run. Under 25 lines.
- [ ] **Step 2:** docs/releasing.md: the same in full, the ruleset settings, the runbook (rotate the npm trusted publisher and GitHub access; check what else the compromised path published; withdraw; hotfix).
- [ ] **Step 3:** `pnpm verify:fast` (lint covers markdown links), commit.

Fixes CAR-212 goes on the last PR to merge.
