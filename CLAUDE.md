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
   Playwright suite has a phone project next to desktop, run before every PR
   and while iterating on layout ("Development").

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
   empty, and an error is distinct from both. A spinner appears in place:
   showing or hiding it never moves anything (a kept slot, an icon it
   replaces, or laid over). Use the shared `Spinner` and
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
  tarball into a temp dir, runs its `crb`). It takes the machine for ~20
  minutes after a queue, so it is rare: once, right before finalizing a PR
  (the coordinator, on the combined branch, before opening or updating the
  PR). Everything before that uses `pnpm verify:fast` (below): implementing,
  committing, fix rounds, reviews, and an implementer's "done".
- The phone project (Playwright's `phone`) doubles an e2e run. The final
  pre-PR `pnpm verify` always includes it. Before that, run it only when a
  change touches layout: CSS or Tailwind classes that size, place or wrap
  things, breakpoints and `useMedia`/`isMobile` code, sticky or scrolling
  behaviour, touch targets, or anything in `e2e/mobile.spec.ts`'s ground.
  Otherwise set `CRB_NO_PHONE=1`, which drops the phone project from any
  Playwright run (`verify:fast`, `test:e2e`, `flake-check`). When unsure,
  include the phone.
- Test queue (for a machine shared by several agents): when
  `~/.config/carbonless/queue.json` exists (`{"slots": 2}`), every Vitest and
  Playwright run (`pnpm test`, `test:changed`, `test:e2e` with or without
  spec files, `verify:fast`'s test steps, `pnpm verify`, `pnpm flake-check`)
  waits for one of `slots` (default 1) machine-wide locks
  (`scripts/queue.mjs`, `flock` on `~/.cache/carbonless-verify.lock*`),
  printing whose runs it waits for, so runs never overload the machine
  together, and `vitest.config.ts`/`playwright.config.ts`
  refuse a run outside it (`scripts/queue-guard.mjs`): use the package
  scripts, or wrap a direct call as `node scripts/queue.mjs pnpm exec
  playwright test ...`. The file is read on every run and while waiting: a
  change applies at once, no restart. Interactive `pnpm test:watch` never
  queues. Waiting can take longer than a foreground command may: run tests
  in the background (`run_in_background`); a signal ends the wait. A run in
  a slot gets the cores divided by `slots` as workers. `CRB_NO_QUEUE=1`
  skips the queue for one command. No file (CI, a machine of one's own):
  nothing queues.
- A tree's `dist` lock (`scripts/dist-lock.mjs`, `flock` on
  `node_modules/.crb-dist.lock`) keeps any build (`pnpm build`, so prepack,
  `test:pack`) from changing a `dist` that a Playwright run in the same tree
  is serving: a build waits for those runs, printing so and the lock's path.
  An e2e run (`scripts/e2e.mjs`: `test:e2e`, `verify:fast`, `flake-check`)
  builds, then holds the lock shared from its turn in the queue to its end;
  `test:e2e` and `verify:fast` build before their turn (overlapping the
  wait), `flake-check` and `pnpm verify` inside the slot they already hold.
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
- The owner's main instance and branch instances: "Versions and instances" below.
- Tests never call the real `gh`: `test/fake-gh/gh` serves a scenario
  (`test/fake-gh/scenario.ts`) via `$CRB_FAKE_GH`. It is a bash shim that
  forwards each call to the test process's fake gh server (`fakeGhEnv()`
  puts both on the env; a Node process per call without one), with a gh
  process's semantics. The e2e harness
  (`e2e/fixtures.ts`) wires it onto `PATH` and drives the built CLI. In
  unit tests a trap `gh` sits on `PATH` behind the fake
  (`test/real-gh-trap.ts`) and fails the run, naming the test, when a call
  gets past the fake: prepend a fake gh to `PATH`, never replace `PATH`,
  and `await settleGh()` (`test/settle-gh.ts`) before restoring the env.
- A Playwright worker's e2e tests share one `crb serve`; each test has its
  own repo and PR (`ownerRepo`, `prNumber`, `p.number`: never hard-code
  `acme/widget#7`), and a reset plus leak checks after it fail the test
  that leaked. A test that stops or restarts crb, writes config, reads the
  server's files or runs `runCli(workdir, …)` against it takes
  `test.use({ crbServer: "own" })`. What each leak message means:
  `docs/test-profiling.md`, "One server for many tests".
- Tests must pass on a loaded machine (several suites often run at once). A
  test of a loading state holds the fake gh's answer (scenario `hold`, then
  `release()` once it has seen the spinner) rather than racing a `…DelayMs`;
  "X doesn't wait for Y" is X resolving while Y is held, not a time bound.
  Gate hazards (`test/fake-gh/scenario.ts`): an unheld gh write saves the
  scenario it read at its start, so don't release while one is out; a held
  write, once released, drops test edits made while it waited.
  Unit tests that run git and the fake gh use `GIT_TEST_TIMEOUTS`. A speed
  property is measured in CPU time (`process.threadCpuUsage`), or as "doesn't
  wait" (a timeout of 0, a hold), never as wall-clock time. A test that
  needs an app timer to elapse (a fade, an undo window, a delayed-save
  hint, a poll) moves the page's clock (`installClock`, `e2e/fixtures.ts`,
  then `page.clock.fastForward` or `runFor`), never waits it out or sleeps
  (no `page.waitForTimeout`); to prove something doesn't happen, it moves
  past the window and checks what was sent (`p.ghLog()`). No automatic
  retries (Playwright `retries`, Vitest `retry`): a flaky test fails visibly
  and gets fixed. Playwright's expects wait 10 s (a reload's chained reads);
  a test that needs longer says why.
- `pnpm flake-check <files…> [--runs N] [--load L] [-g title] [--project p]`
  runs unit files or e2e specs N times (default 5), in the queue. `--load L`
  adds L busy loops (default none: the devbox is loaded enough by other
  agents, and the loops slow their runs too). Run it on every test you add
  or change that involves timing, concurrency, a spinner or a gate, and on
  a test you saw fail once.
- Every test run traces itself (spans per test, setup phase, crb request,
  git and gh call) into `~/.cache/carbonless/test-traces/<run>/`, kept 7
  days. `pnpm test-profile [run|latest] [--compare <run>] [--jaeger]`
  says where the time goes (CI uploads its runs as `test-traces-*`
  artifacts; `docs/test-profiling.md`).
- If `nvm use` fails (e.g. in a sandbox), put `~/.nvm/versions/node/v24*/bin`
  first on `PATH`.
- `pnpm compare-threads <pr> [--as-of <iso>] [--placed-from <iso>] [--out <dir>]`
  checks every thread's code pane against GitHub's REST comments (read-only);
  exits 1 on a mismatch. `--placed-from` adds where re-review places each
  thread of a first round against GitHub's `line` (listed, never failed).
- Planned work and milestones live in Linear (see "Tickets" below).
  `docs/todo.md` is being retired: everything in it is already in Linear,
  so add nothing new there.
- Core design docs, kept current (update them in the same change that alters
  what they describe):
  - `docs/review-data-storage.md`: how review data is stored in git.
  - `docs/gitdb-design-principles.md`: the principles behind storing data in git.
  - `docs/faq.md`: answers to questions people ask (e.g. why line counts differ from GitHub).
  - `docs/git-methodology.md`: git-methodology independence, merged handling
    and the methodology test matrix.
  - `docs/product-rules.md`: product rules beyond the design principles.

## Tickets (Linear)

Work is tracked in the owner's Linear workspace `carbonless`, team `CAR`
(issues `CAR-123`). The owner doesn't use Linear's UI: bots read and write it
for them.

- Use the `linear` MCP server only (an API key, set up for every session on
  this machine). Never the claude.ai Linear connector, which is the owner's
  other account. Scripts can use the same key (`~/.config/linear/api-key`)
  against Linear's GraphQL API.
- Structure: initiatives are themes (Improved Diff, Review Prioritization,
  AI Conversation, Review Tools). Projects are releases (M2 now, M3 next,
  scope set with the owner), and M2's project milestones are its ordered
  steps. A parent issue is an epic. An issue is one change: one brief, one
  branch, one PR. Issues not yet scheduled have no project.
- Labels: every issue has exactly one label from the `Initiative` group
  (tooling has none), at most one from `Area`, a type (Bug, Feature,
  Improvement), and flags: `minor fix` (a small, low-risk change: one short PR,
  no design call, nothing that could break the UI), `owner-decision`,
  `edge-case` (needs a gallery PR), `flaky-test`, `from-review`, `mobile`,
  `perf`.
- **Ask the owner before opening a ticket.** Propose its title, initiative,
  project and labels, and open it only after a yes. Updating existing tickets
  needs no ask and is encouraged: sharpen the scope as it becomes clearer,
  move the status as work progresses, comment what was found or decided.
- **Keep every ticket's status true.** Whoever moves the work moves the
  ticket in the same step, so the owner can read where everything stands
  from Linear alone:
  - Backlog: not being worked on. (There's no queue: once the owner decides
    to do something, it goes to an agent at once.)
  - Design: brainstorming, spec, mockups or owner decisions under way.
  - Implementation: the work is with an agent (a brief, a branch, a PR in
    review or fix rounds, owner QA), until the owner approves it.
  - Awaiting merge: approved by the owner; only final fixes, CI or the merge
    are left.
  - Done: merged to master. Canceled or Duplicate (say why in a comment).
  The GitHub integration moves a linked ticket on PR events (a branch or PR
  → Implementation, an approved PR → Awaiting merge, merged → Done), but
  check it landed where the list above says. Before a report to the owner,
  check that the statuses of the tickets it covers match.
- Closed tickets (Done, Canceled, Duplicate) are archived a month after
  closing; to find past work, search with archived issues included. The free
  plan caps open (unarchived) issues at 250: if creating a ticket fails on
  that limit, archive every ticket closed more than 2 days ago with
  `~/.local/bin/linear-archive-done` (`--dry-run` lists them first).
- Search before proposing (`list_issues` with a query, then by label or
  project); extend an existing ticket rather than propose a near-duplicate.
- Titles state the problem or outcome. Descriptions start with the human
  part (the owner's words quoted and dated, then what's wanted). File paths,
  line refs and logs go in a collapsible `+++ Agent notes` section.
- Name branches after the issue (`car-123-short-name`) and write
  `Fixes CAR-123` in the PR description (`Part of CAR-123` for one piece of
  a stack): the GitHub integration then links the PR and moves the issue.
- A review finding fixed in the same fix round is not a ticket. Only
  leftovers are proposed, labelled `from-review`.
- When a release finishes, the coordinator posts a project update (what
  shipped, what's left, what was decided).
- Specs stay in the repo or as artifacts; tickets link to them, not copy them.

## Versions and instances

The owner's main is the globally installed package (`carbonless-review`),
run as `crb serve` on port 4747 with a stable key, and it moves to the
newest RC by itself within minutes of a merge. It
never runs a worktree's `dist`, and nothing else binds 4747. Setup:
`docs/remote-machine.md`. The owner's machine-specific details (address,
service and timer names, logs, how to pause it) live in the untracked
`CLAUDE.local.md`; never write them into tracked files.

**Branch instance (ad hoc):** whenever a branch has something the owner
should see before it reaches master: a coordinator's "ready" report, a fix
to QA, or the owner asking. One per branch, in that branch's worktree, never
in the main checkout:
1. `node scripts/crb-private-env.mjs "$PWD" <port>` (once; worktrees from
   `scripts/agent-worktree.sh` already have `.envrc`), then
   `source .envrc`. The port is fixed per branch, so its links survive
   restarts: a free one from 4748–4799 (`ss -ltn`), never 4747.
2. `pnpm build`, then `nohup node dist/cli.js serve --host "$(tailscale ip -4)"
   --port <port> > .crb-dev/serve.log 2>&1 &` and keep `$!`.
3. `node dist/cli.js <pr>` prints the review's link; send that (Tailscale
   IP, with the key).
4. After a rebuild, stop it by its pid (or `pgrep -f "cli.js serve.*--port
   <port>"`, never every cli.js) and start it again: the version handshake
   refuses a `crb` whose build differs from the server's. Stop it, and say
   so, when the branch merges or is dropped.

**RC: every merge to master is a new RC**, published by GitHub Actions,
never from this machine (`docs/releasing.md`). master's `package.json`
version is the next release `X.Y.Z`; nobody bumps it to an RC. Changes
reach master only as PRs ("How we work"). After one merges:
1. The `Publish RC` run on that merge (`gh run list --workflow
   release.yml`) publishes `X.Y.Z-rc.N` to npm's `rc` (trusted publishing,
   no token) and tags `vX.Y.Z-rc.N`; until the first release it only tags. A run that says
   "master moved on" skipped a commit a newer merge holds.
2. The owner's main follows npm `rc` (machine-specific steps:
   CLAUDE.local.md): check it moved to the new build (`crb --version`
   shows the commit). If it didn't, tell the owner; don't install by
   hand.
3. Send the owner the link and what is new since the last RC.
4. Stop the instances of branches that just merged.

`pnpm release status` shows master's next version, `rc` and `latest` on npm
and in tags, and what the next merge publishes.

**By hand** (another machine, or main's follow paused): in a clean tree of the
commit (`git worktree add --detach .worktrees/release <ref>`, `pnpm install
--frozen-lockfile`), `pnpm release local` builds, packs into
`~/.local/share/carbonless/releases` (its last line is the tarball) and
installs the global `crb`; then `systemctl --user restart crb`.

**Release:** only on the owner's word ("release", "promote"):
1. `pnpm release promote [<rc tag>] [--next patch|minor|major]` (default:
   the newest RC, then minor) starts the promote run of `release.yml` and
   prints its link. It checks CI passed on the RC's commit (it doesn't run
   the suite again), packs `X.Y.Z`, smoke-tests that tarball and stages it
   on npm: hidden until the owner approves it with their two-factor.
2. When the run is green, send the owner its link and summary. **The owner**
   runs `pnpm release publish` on their machine: it checks the staged
   tarball is the one promote checked, approves it (`npm stage approve`;
   npm asks for their OTP; the very first release, 0.1.0, is published
   that way instead, as nothing could be staged yet) and starts
   release-finish (the `vX.Y.Z` tag, `rc`, the "next: X.Y+1.0" PR with the
   changelog). Agents never run `pnpm release publish`, never approve a
   staged version, and never ask for, or handle, the OTP.
3. The "next" PR merges on the owner's approval like any other. For another next
   version (a fix release): `pnpm release next <patch|minor|major|X.Y.Z>`
   opens that PR.
After the first release (0.1.0) the owner adds the trusted publisher
(`docs/releasing.md`, "Setup").

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
  Implementers, fix rounds and reviewers check with `pnpm verify:fast` and
  targeted specs, never a full `pnpm verify`: that runs once, at the end
  (below).
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
  the owner on GitHub, or on their behalf by an agent with `gh pr merge
  --admin`, the ruleset's bypass for the owner's login). Never push
  `master` or `v*` tags.
- On the owner's word only: `pnpm release promote` (starts the promote run,
  which checks, packs and stages; nothing goes live) and `pnpm release
  next` (pushes a `next/*` branch, opens its PR) on Gilthans/carbonless.
  `pnpm release status` only reads. `pnpm release publish` (approving a
  staged release, or the first publish) is the owner's alone (their npm
  OTP): agents never run it, never run `npm stage approve`, and never ask
  for the OTP. Code in master's release workflows can publish to npm
  without that 2FA (`docs/releasing.md`, "Trusted publishing"): a PR that
  touches `.github/` or the release scripts (`.github/CODEOWNERS`) says so
  in its body, for the owner's review.
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
