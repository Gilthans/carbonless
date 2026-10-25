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

## Development

- Node 24 (`nvm use`), pnpm. Stack: Fastify server + git CLI (`src/server`),
  React + Vite + TanStack Query + Tailwind (`src/web`), shared types (`src/shared`).
- `pnpm verify` runs lint (Biome), typecheck, unit tests (Vitest) and Playwright
  tests. Run it before saying work is done.
- New features get unit tests and, when they change what the user sees or does,
  Playwright tests. Playwright tests run the built CLI against throwaway git repos
  (`test/git-fixture.ts`, `e2e/fixtures.ts`).
- Run it on a PR: `pnpm build && node dist/cli.js <pr>` (`crb <pr>` when
  installed), or `CRB_PR=<pr> pnpm dev` for watch mode. It clones into its own
  cache (`~/.cache/carbonless`), never into the reviewer's working copies, and
  only reads from GitHub.
- Tests never call the real `gh`: `test/fake-gh/gh` serves a scenario
  (`test/fake-gh/scenario.ts`) via `$CRB_FAKE_GH`. The e2e harness
  (`e2e/fixtures.ts`) wires it onto `PATH` and drives the built CLI.
- Planned work lives in `docs/todo.md`.
- Core design docs, kept current (update them in the same change that alters
  what they describe):
  - `docs/review-data-storage.md`: how review data is stored in git.
  - `docs/gitdb-design-principles.md`: the principles behind storing data in git.
