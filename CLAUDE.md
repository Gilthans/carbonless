# carbonless

A local tool that helps a human reviewer read and understand the changes between
two git commits, especially large PRs. It does not replace human review with AI
review. AI helps the reviewer put their own eyes on every changed line, and get
through those lines in an order and shape that makes sense to them.

## Design principles

These guide every feature. If a change conflicts with one of them, stop and raise it.

1. **Every AI decision is editable in the UI.** Groupings, line matches, labels,
   summaries: anything the AI produces, the reviewer can correct by hand. The
   corrections are also how the reviewer teaches the tool their preferences over
   time, so keep them as data, not just as a fix to the current view.

2. **No AI decision can make the reviewer miss a change.** Every changed line
   stays unreviewed until the reviewer explicitly marks it reviewed. AI may
   group, reorder, match, collapse or annotate changes, but it can never mark
   anything as reviewed, hide a change, or drop it from the review. The UI must
   always be able to show what is still unreviewed. A bug in AI output (a
   missing line, a bad match, an invented line) must make coverage look
   incomplete, never complete. Enforce this in code and cover it with tests.
   Don't rely on the AI behaving well.

3. **Review data never burdens regular git use.** Review data stored in git
   (`refs/crb/...`) must not slow down everyday git operations (status, log,
   commit, switch, fetch, clone) for anyone, however many reviews pile up. Only
   operations that walk every ref, like `git log --all`, may be affected. Keep
   storage per review small (measure it when the format changes), never fetch
   `refs/crb/*` as a whole, and keep each review isolated: working on one review
   must not get slower as others accumulate. Before changing how anything is
   stored in git, read `docs/gitdb-design-principles.md` and follow it or say
   which principle you're departing from and why. Current design:
   `docs/review-data-storage.md`.

4. **No central carbonless server.** carbonless stays true to git's distributed
   design: there is no carbonless-run service in the middle. It runs on the
   reviewer's machine, stores its data in an ordinary git remote, and shares it
   by pushing and fetching refs. Integrations with hosts like GitHub (through
   `gh`) naturally need those hosts to be reachable, and that's fine. Full
   offline work is not a goal. What matters is that carbonless itself never
   adds a server of its own.

5. **Mobile is supported.** The reviewer also reads PRs on a phone. Every page
   works down to ~360px wide with no horizontal page scroll (diff lines may
   scroll inside their own container), tap targets are at least 40px, and the
   Playwright suite runs in a phone project as well as desktop.

6. **Concise, icon-first UI.** Keep text short. Icons (each with a tooltip and
   an accessible name) and color carry meaning; no disclaimers, legends or
   explanatory sentences that the visuals already convey. Colors come from the
   design tokens only; code-review conventions (green added/reviewed, red
   deleted/failing, yellow pending) beat the brand palette
   (`docs/design/README.md`). Dates are short relative text with the exact
   date and time zone on hover/focus (`src/web/RelativeTime.tsx`).

7. **Independent of git methodology.** carbonless behaves the same however a
   team uses git: rebasing a PR branch onto the base or merging the base into
   it, landing by merge commit, squash or rebase-and-merge, force-pushes, a
   base that moves on. Behaviour depends on GitHub's PR facts (state, head,
   base) and the three-dot comparison, never on the shape of history (e.g.
   "merged" is GitHub's PR state, not ancestry). The methodology matrix
   (`docs/git-methodology.md`) proves it; history-sensitive changes extend it.

More product rules learned while building (GitHub as one comment source among
several, flagging uncertainty, dating by visibility, first-open performance,
checking against a real PR): `docs/product-rules.md`.

## Development

- Node 24 (`nvm use`), pnpm. Stack: Fastify server + git CLI (`src/server`),
  React + Vite + TanStack Query + Tailwind (`src/web`), shared types (`src/shared`).
- `pnpm verify` runs lint (Biome), typecheck, unit tests (Vitest) and Playwright
  tests. Run it right before committing and before saying work is done; use
  `pnpm verify:fast` (below) until then.
- Full test runs take turns: `pnpm verify`'s unit and e2e stages, `pnpm
  test:e2e` without spec files, `-g` or `--last-failed`, an all-specs
  `verify:fast` and `pnpm flake-check` wait for a machine-wide lock
  (`scripts/queue.mjs`, `flock` on `~/.cache/carbonless-verify.lock`),
  printing whose run they wait for, so they never overload the machine (or
  share a tree's `dist`) together. Waiting can take longer than a foreground
  command may: run `pnpm verify` in the background (`run_in_background`);
  a signal ends the wait. A queued run takes turns with the other full runs,
  so Playwright takes a worker per core. `CRB_NO_QUEUE=1` skips the queue.
- While iterating, run only what a change touches:
  - `pnpm verify:fast [base]`: lint, typecheck, the unit tests related to files
    changed since `base`, and the e2e specs mapped to them (`E2E_MAP` in
    `scripts/verify-fast.mjs`; unmapped source runs all). `base` defaults to
    `$CRB_BASE`, else the local branch this one forked from. `--dry-run` shows
    the plan; other `--` flags go to Playwright (`--project=chromium`).
  - `pnpm test:changed [ref]`: Vitest on files related to changes since `ref`
    (uncommitted ones without it). `pnpm test <path or name>` for one file.
  - `pnpm test:e2e e2e/files.spec.ts -g "<title>" --project=chromium`: builds,
    then runs the given specs only.
- Agent worktrees: `scripts/agent-worktree.sh <name> [base]` makes
  `.worktrees/<name>` on branch `<name>` and installs from the shared pnpm
  store. Playwright browsers are global. Tests take random ports and their own
  temp dirs and `XDG_CACHE_HOME`, so `pnpm verify` runs in parallel worktrees;
  for `pnpm dev` in two at once, set `CRB_API_PORT`.
- New features get unit tests and, when they change what the user sees or does,
  Playwright tests. Playwright tests run the built CLI against throwaway git repos
  (`test/git-fixture.ts`, `e2e/fixtures.ts`).
- Run it on a PR: `pnpm build && node dist/cli.js <pr>` (`crb <pr>` when
  installed), or `CRB_PR=<pr> pnpm dev` for watch mode. It clones into its own
  cache (`~/.cache/carbonless`), never into the reviewer's working copies. It
  reads from GitHub, and writes to it only on the reviewer's explicit action
  (replies, new comments, resolving, editing and deleting your own comments,
  the review verdict):
  `docs/product-rules.md`, "Writing to GitHub".
- Tests never call the real `gh`: `test/fake-gh/gh` serves a scenario
  (`test/fake-gh/scenario.ts`) via `$CRB_FAKE_GH`. The e2e harness
  (`e2e/fixtures.ts`) wires it onto `PATH` and drives the built CLI.
- Tests must pass on a loaded machine (several suites often run at once). A
  test of a loading state holds the fake gh's answer (scenario `hold`, then
  `release()` once it has seen the spinner) rather than racing a `…DelayMs`;
  "X doesn't wait for Y" is X resolving while Y is held, not a time bound.
  Gate hazards (`test/fake-gh/scenario.ts`): an unheld gh write saves the
  scenario it read at its start, so don't release while one is out; a held
  write, once released, drops test edits made while it waited.
  Unit tests that run git and the fake gh use `GIT_TEST_TIMEOUTS`. A speed
  property is measured in CPU time (`process.threadCpuUsage`), or as "doesn't
  wait" (a timeout of 0, a hold), never as wall-clock time. No automatic
  retries (Playwright `retries`, Vitest `retry`): a flaky test fails visibly
  and gets fixed. Playwright's expects wait 10 s (a reload's chained reads);
  a test that needs longer says why.
- `pnpm flake-check <files…> [--runs N] [--load L] [-g title] [--project p]`
  runs unit files or e2e specs N times (default 5) next to L busy loops
  (default one per core), which load the whole machine, other agents'
  unqueued runs too. Run it on every test you add or change that involves
  timing, concurrency, a spinner or a gate, and on a test you saw fail once.
- If `nvm use` fails (e.g. in a sandbox), put `~/.nvm/versions/node/v24*/bin`
  first on `PATH`.
- `pnpm compare-threads <pr> [--as-of <iso>] [--out <dir>]` checks every
  thread's code pane against GitHub's REST comments (read-only); exits 1 on a mismatch.
- Planned work and milestones live in `docs/todo.md`.
- Core design docs, kept current (update them in the same change that alters
  what they describe):
  - `docs/review-data-storage.md`: how review data is stored in git.
  - `docs/gitdb-design-principles.md`: the principles behind storing data in git.
  - `docs/faq.md`: answers to questions people ask (e.g. why line counts differ from GitHub).
  - `docs/git-methodology.md`: git-methodology independence, merged handling
    and the methodology test matrix.
  - `docs/product-rules.md`: product rules beyond the design principles.

## How we work

- Work is split into briefs (`.superpowers/sdd/<plan>/*-brief.md`, git-ignored):
  the owner's words quoted, the requirements, the constraints, the tests. The
  session that coordinates writes briefs, reviews and integrates; it doesn't
  implement features itself.
- One implementing agent per brief, each in its own git worktree (Agent
  `isolation: "worktree"`, or `scripts/agent-worktree.sh`), on a branch from the
  feature branch. Agents don't spawn agents. Agents in worktrees can't write to
  the main checkout's `.superpowers/`: they write reports to the session
  scratchpad, and the coordinator copies them over.
- Every change gets a fresh reviewer with the brief, the report and the diff
  (`git log --stat` + `git diff -U10` of the range, saved to a file). Findings
  go back to the same implementer as fix rounds, then a scoped re-review; small
  fixes with tests that fail without them may skip the re-review.
- The coordinator cherry-picks reviewed commits onto the feature branch (or has
  the agent rebase when they conflict), runs `pnpm verify` on the combined
  branch, restarts the owner's running instance and sends the link.
- Commits only via `git commit --only -- <paths>` in a shared tree; never a bare
  `git stash`. Merging to `master` only when the owner asks, as a fast-forward
  after a green `pnpm verify`. Never push, and never write to GitHub, with one
  exception: the owner's two playground repos, where any git or GitHub
  write is approved (commit, push, force-push, PRs, comments, reviews,
  deletes): https://github.com/Gilthans/carbonless-scratch (PR #1 is for
  testing carbonless's GitHub writes) and
  https://github.com/Gilthans/carbonless-gallery (one PR per case study,
  regular and edge cases, to look at in carbonless). Clean up probes so
  the cases stay readable. Nowhere else.
- Every edge case we find or fix gets a gallery PR (its own `base/<case>`
  and `case/<case>` branches, a description of what to look at, a row in
  the gallery README).
- Report to the owner concisely: what changed, measured results, what is
  still open, and questions that are theirs to decide.
