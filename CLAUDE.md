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

8. **Loading never looks empty.** Whenever something is loading, a visible
   spinner or skeleton shows where the result will appear (the owner:
   "Whenever something is loading, there should be a visible spinner
   somewhere relevant"). A result still on its way never reads as an empty
   one: no 0 counts, empty lists, "none" or "no X" text, blank meters or 0%
   while it is pending; the empty state shows only once the answer says
   empty, and an error is distinct from both. Use the shared `Spinner` and
   `SkeletonBar` (`src/web/Spinner.tsx`), with an accessible name and
   `aria-busy` on the region. Enforce it in tests: hold the answer (the fake
   gh's `hold`, or a held fetch), assert the loading state and the absence
   of the empty one, release, assert the result (`expectLoadingThen` in
   `e2e/fixtures.ts` and `test/loading.ts`). More: `docs/product-rules.md`.

More product rules learned while building (GitHub as one comment source among
several, flagging uncertainty, dating by visibility, first-open performance,
loading never looking empty, checking against a real PR):
`docs/product-rules.md`.

## Development

- Node 24 (`nvm use`), pnpm. Stack: Fastify server + git CLI (`src/server`),
  React + Vite + TanStack Query + Tailwind (`src/web`), shared types (`src/shared`).
- `pnpm verify` runs lint (Biome), typecheck, unit tests (Vitest), Playwright
  tests and the package smoke test (`pnpm test:pack`: packs, installs the
  tarball into a temp dir, runs its `crb`). Run it right before committing
  and before saying work is done; use `pnpm verify:fast` (below) until then.
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
  temp dirs and `XDG_CACHE_HOME`/`XDG_STATE_HOME`/`XDG_CONFIG_HOME`, so
  `pnpm verify` runs in parallel worktrees; for `pnpm dev` in two at once, set
  `CRB_API_PORT`. Before running `crb` by hand in a worktree, `source` its
  `.envrc` (the script writes it): a private state and config dir, so its
  `crb <pr>` never finds or starts a server in the owner's.
- New features get unit tests and, when they change what the user sees or does,
  Playwright tests. Playwright tests run the built CLI against throwaway git repos
  (`test/git-fixture.ts`, `e2e/fixtures.ts`).
- Run it on a PR: `pnpm build && node dist/cli.js <pr>` (`crb <pr>` when
  installed) prints the review's link (`/r/<id>`), from this machine's
  `crb serve` (one server for every review; started in the background when
  none runs; host and port from `~/.config/carbonless/config.json`, else
  127.0.0.1:4747, which is the owner's: agents use their `.envrc` and another
  port). `--open` also opens the browser. `CRB_PR=<pr> pnpm dev` for watch
  mode (crb serve on `CRB_API_PORT`, default 4858, state in `.crb-dev/`).
  `crb --version` must match the server's, or `crb <pr>` refuses. It clones into its own
  cache (`~/.cache/carbonless`), never into the reviewer's working copies. It
  reads from GitHub, and writes to it only on the reviewer's explicit action
  (replies, new comments, resolving, editing and deleting your own comments,
  the review verdict: approve, comment, request changes, and Comment
  dismissing your own standing approval or change request):
  `docs/product-rules.md`, "Writing to GitHub".
- Main on the devbox and branch instances: "Versions and instances" below.
- Tests never call the real `gh`: `test/fake-gh/gh` serves a scenario
  (`test/fake-gh/scenario.ts`) via `$CRB_FAKE_GH`. The e2e harness
  (`e2e/fixtures.ts`) wires it onto `PATH` and drives the built CLI. In
  unit tests a trap `gh` sits on `PATH` behind the fake
  (`test/real-gh-trap.ts`) and fails the run, naming the test, when a call
  gets past the fake: prepend a fake gh to `PATH`, never replace `PATH`,
  and `await settleGh()` (`test/settle-gh.ts`) before restoring the env.
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

## Versions and instances

The owner's main is the globally installed package (`carbonless-review`),
run as `crb serve` by the systemd user service `crb.service` on port 4747,
the owner's, with a stable key:
`http://100.78.32.127:4747/?key=$(cat ~/.local/state/carbonless/key)`.
It never runs a worktree's `dist`, and nothing else binds 4747. Setup and
the scripts: README, "Remote machine". Logs: `journalctl --user -u crb`.

**Branch instance (ad hoc):** whenever a branch has something the owner
should see before it reaches master: a coordinator's "ready" report, a fix
to QA, or the owner asking. One per branch, in that branch's worktree, never
in the main checkout:
1. `node scripts/crb-private-env.mjs "$PWD" <port>` (once; worktrees from
   `scripts/agent-worktree.sh` already have `.envrc`), then
   `source .envrc`. The port is fixed per branch, so its links survive
   restarts: a free one from 4748–4799 (`ss -ltn`), never 4747.
2. `pnpm build`, then `nohup node dist/cli.js serve --host 100.78.32.127
   --port <port> > .crb-dev/serve.log 2>&1 &` and keep `$!`.
3. `node dist/cli.js <pr>` prints the review's link; send that (Tailscale
   IP, with the key).
4. After a rebuild, stop it by its pid (or `pgrep -f "cli.js serve.*--port
   <port>"`, never every cli.js) and start it again: the version handshake
   refuses a `crb` whose build differs from the server's. Stop it, and say
   so, when the branch merges or is dropped.

**RC: every merge to master is a new RC** (the owner: merging a PR to main
implies a new RC version). When the owner asks to merge:
1. On the feature branch, bump `package.json` with a commit of its own
   (`release: <version>`): from `X.Y.Z-rc.N` to `X.Y.Z-rc.N+1`; from a
   release `X.Y.Z` to `X.Y+1.0-rc.1` (`X.Y.Z+1-rc.1` when the owner calls
   it a fix). `0.1.0` was never released, so the first RC is `0.1.0-rc.1`.
2. `pnpm verify` green, fast-forward `master`, tag `v<version>` (local
   only until pushing tags is allowed).
3. Pack from a clean tree at the tag, so the build's commit is the tag's
   and not `-dirty`: `git worktree add --detach .worktrees/release
   v<version>` (or `git -C .worktrees/release checkout --detach
   v<version>`), `pnpm install --frozen-lockfile`, `pnpm pack
   --pack-destination ~/.local/share/carbonless/releases`.
4. `scripts/devbox/update ~/.local/share/carbonless/releases/carbonless-review-<version>.tgz`
   (with Node 24 and `~/.local/share/pnpm/bin` on `PATH`): it waits for the
   new build and prints `<from> -> <to>` and the link. Send the owner the
   link and what is new since the last RC.
5. Stop the instances of branches that just merged.

**Release:** only when the owner asks ("release", "promote"). The RC the
owner tried becomes `X.Y.Z`: a `release: X.Y.Z` commit on master that
changes only the version, then steps 2–4 above. Before the first publish
to npm, remind the owner that the license is still `UNLICENSED`. Until M2
(`docs/superpowers/specs/2026-10-30-versions-and-distribution-design.md`)
nothing is published: co-workers get the tarball, and `update rc|latest`
has nothing to install. M2 replaces steps 1–3 with `pnpm release
<rc|promote|patch|minor>` and CI publishing on a pushed tag.

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
- Review checklist (every reviewer brief carries it, on top of the brief's own):
  - **Input sanitization.** Text from the reviewer, a PR, GitHub or git
    (bodies, titles, names, paths, refs) is escaped or sanitized wherever it
    reaches HTML (`innerHTML`, `dangerouslySetInnerHTML`, `DOMParser`, server
    meta), markdown posted to GitHub (`escapeTags`,
    `src/shared/markdownEscape.ts`), argv, URLs or hrefs (`safeHref`) and git
    args (checked OIDs and refs, paths after `--`), with a test that fails
    without it.
- The coordinator cherry-picks reviewed commits onto the feature branch (or has
  the agent rebase when they conflict), runs `pnpm verify` on the combined
  branch, (re)starts the branch's instance and sends its link ("Versions and
  instances"). Main changes only through an RC.
- Every change reaches `master` through a PR on Gilthans/carbonless. Agents
  may push any branch there except `master` (`--force-with-lease` only on
  their own branch, after a rebase), and open a PR after a green local
  `pnpm verify`: a title, and a body with what changed, what to QA (with
  links), edge cases, and the attribution line. CI
  (`.github/workflows/ci.yml`) must be green before asking the owner to
  merge. A PR is merged only on the owner's explicit word for that PR (by
  the owner on GitHub, or by an agent with `gh pr merge`). Never push
  `master` or `v*` tags.
- Commits only via `git commit --only -- <paths>` in a shared tree; never a bare
  `git stash`. On Gilthans/carbonless, GitHub writes are limited to the
  above: pushing branches, opening, updating and merging PRs, and commenting
  on our own PRs. Never write to any other repo on GitHub, with one
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
