# To do

In priority order.

## Milestones

- **Milestone 1, PR review view (done 2026-10-26, `master` at `be19451`):**
  Files changed (clusters/lines, invisibles, file status icons), Overview
  (staged loading, thread code from the clone with the snapshot chip,
  suggestions, Timeline), as-of views, git-methodology matrix, mobile.
- **Milestone 2, replace the owner's GitHub review workflow (re-reviews
  later), in order:** review threads in Files changed and the Overview
  (done); view at the commit you last reviewed (`--head reviewed`); instant
  saves; actions from the UI that write to GitHub (comment, reply, resolve,
  approve / request changes: done 2026-11-02, Final Verdict); then carrying threads and progress over from
  earlier snapshots (done 2026-11-08: re-review, below).

## 0. Parity with the GitHub review workflow

Foundation for everything below.

- **PR review view (done):** open a PR, see the overview, review it cluster by cluster
  with progress tracking. Design:
  `docs/superpowers/specs/2026-10-21-pr-review-parity-design.md`.
- **Commenting** from carbonless.
- **LEFT-side thread placement (discuss with the owner right after the
  threads stage):** GitHub records no commit for a comment's LEFT side
  (`commit_id` and `original_commit_id` are both PR heads), so a LEFT line
  can sit on a different old side than the view's merge base. Only
  `diff_hunk` shows what the commenter saw, and it's sometimes empty (2 of
  4 LEFT comments on #99). The threads stage places LEFT threads by line
  number with no check.
- **Threads from earlier commits in Files changed (next):** today Files
  changed shows only the threads whose opening comment was made on the
  viewed head. Place the others too, mapping their lines onto the viewed
  diff in `placeThreads` (`src/web/files/threadPlacement.ts`), the one
  function that decides where a thread goes.
- **Re-review after new pushes (done 2026-11-08):** one of GitHub's
  weakest spots. Patch sets, the patch set graph and the toast, the since
  view with carried marks, thread placement with fates, "since your
  verdict" on the Final Verdict tab. Design:
  `docs/superpowers/specs/2026-11-04-re-review-design.md`; demo: the
  gallery's re-review showcase. Still open:
  - Show a thread's code as the commenter saw it: diff its commit against
    the base of the view the comment was made in ("changes since your last
    review", a single commit), not the PR's merge base, then drop the
    Overview's "different snapshot" chip (`CodeWindow.snapshot`,
    `docs/faq.md`).
  - Until then: the chip is over-cautious on some threads whose rows all
    match GitHub's hunk (3 of 26 on the real-PR check as of its cutoff, 7 of
    105 overall; `pnpm compare-threads` lists them). Find out why the verdict
    says "different" there.
  - Stacked PRs: let the patch set graph have more than one comparison base
    (the parent PR's head besides the base branch), so a child PR can be read
    since the parent landed (owner, 2026-11-07). The gallery's `rr-stacked`
    shows today's behaviour.
  - Per-line review states (parked in the design: first measure how often
    clusters split between patch sets).
  - Which commit changed what (owner, 2026-11-07: deferred everywhere): a
    fate's commit ("rewritten in `c0ffee1`"), the patch set that deleted a
    file in "Not in this comparison", landmarks (heads others commented or
    gave a verdict on) as since points.
- **Store review state in git refs** (`refs/crb/...`). Design:
  `docs/review-data-storage.md`. Carry-over after pushes is deferred to the
  re-review item above (ideas so far: Gerrit-style change kinds and
  `copyCondition`, carries recorded as events, pinned patch set heads).
- **Sync review refs with the remote:** squash before push, narrow fetches,
  "who else started" from other reviewers' refs. Left out of the PR review view
  milestone, which keeps refs local. See "Sync with the remote" in
  `docs/review-data-storage.md`.
- **Compact a review when its PR is merged:** rewrite each of the review's refs
  to a single commit holding all its events, so git can garbage-collect the old
  commits. Triggered when the PR is merged or closed. No event may be lost;
  clients that see a compacted ref replace their copy instead of merging it.
  See "Compaction" in `docs/review-data-storage.md`.

## 1. Split a change into review groups

PRs often do several things at once. Splitting them into smaller PRs is the
author's job, but which split is easiest to read is up to the reviewer. AI groups
the changes into a few logical groups that the reviewer reviews one at a time.
For example, a PR adding a backend endpoint might split into "migrating old
data", "changing data consumption" and "changing data ingestion".

- There's more than one valid split. The reviewer builds up their preferred way
  of splitting over time, together with the AI.
- The reviewer can edit groups in the UI: move changes between groups, rename,
  merge, split.
- Every changed line belongs to the review. A change the AI didn't put in any
  group still shows up and still needs reviewing.

## 2. Make moved code reviewable

When a function is extracted or moved between modules, a plain diff shows one big
deletion and one big addition, so you can't tell whether the logic changed.

- AI suggests which removed code matches which added code, as a better starting
  point than the diff algorithm.
- The reviewer can match lines by hand where the automatic diff and the AI get it
  wrong.
- Matched code shows only the real differences between the old and new versions.

## 3. Send AI to investigate while reviewing

Reviewing raises questions that need a look at other code, or a test run on the
PR's branch. Doing that in a separate session loses the PR's context and the line
you were looking at.

- Ask a question from a specific line or change, and AI investigates in the
  background (reads code, runs tests on the branch).
- The answer comes back next to the line it was asked about.
- Keep track of open and answered questions across the review.

## Future plans

Not scheduled yet; after everything above.

- **Renderers for different file types:** show Markdown rendered, images as
  images (with before/after for changed images), and so on, alongside the diff.
- **Review context beyond the repo:** bring in artifacts that aren't part of the
  git repo — design docs, ad-hoc conversations, design decisions — and show them
  with the change they explain.
- **Change Unit:** the name for a group of clusters (the review groups in item 1).
  Use it in the UI and the code.
- **Edit history:** clicking a comment's "edited" shows its edit history
  (owner, 2026-10-27; GitHub's `userContentEdits`).
- **carbonless's own threads in git:** spans and other review data that GitHub
  can't hold (comments on a custom left side such as a commit range or an
  interdiff, notes, Ask Claude conversations) stored in `refs/crb`, probably
  along the lines of git-appraise (owner, 2026-10-28). Until then a span rides
  in a hidden marker in the GitHub comment
  (`docs/superpowers/specs/2026-10-27-new-threads-design.md`).
- **Search across the PR:** Files changed shows one file at a time, so the
  browser's find can't reach the others; add a search over every changed
  file (and threads) that jumps to each match (owner, 2026-11-01; not for
  milestone 2).
- **Install as a web app:** a PWA (manifest, icons, a service worker that
  only caches the app shell) so carbonless can be added to the phone's home
  screen and the desktop's app list (owner, 2026-11-01).
- **More keyboard shortcuts** for existing actions (next/previous file, mark
  reviewed, next unreviewed…), each in the `?` help (owner, 2026-10-28).
- **Bots in human threads:** decide how bot comments (review bots, CI
  bots replying in a human thread) should count in a thread's attention set.
  For now (2026-10-26) bots never join it and a bot's comment never counts as
  the latest one (`docs/superpowers/specs/2026-10-26-pr-threads-design.md`).
- **Attention set:** like Gerrit's, but computed automatically as far as
  possible (whose turn it is on each PR), plus a view of pending review work
  across PRs.
- **`<` inside raw HTML lines of a comment:** escapeTags leaves lines in an
  HTML block GitHub keeps as they are (`<img …>` alone on a line followed
  by `List<T> here`, `<br>` then `List<T>`, `<details><summary>List<T></summary>`),
  so GitHub still drops `<T>` there. A backslash shows literally in raw
  HTML, but `&lt;` renders as `<` (probed 2026-11-01): escape those `<` as
  `&lt;`, with unescapeTags undoing it in those lines only
  (`src/shared/markdownEscape.ts`; review of brief A, finding 4).
- **`<` next to links, two leftovers (escapeTags):** `>www.x.com/a<T>` (a quote
  with no space) still gets its `\` swallowed by the link: skip `>` at a
  word's start like `*_~(`. And a scheme inside `<https://…>`, `[d](https://…)`
  or an `href` marks the whole word a URL, so a `<T>` glued after it is left
  for GitHub to drop (as before escaping existed).
- **Custom agent pre-review actions and instructions:** let the reviewer define
  their own AI steps to run before a review starts (and standing instructions for
  how their agent should help), so each reviewer's workflow is their own.

## Invisible characters: parked

- ZWJ between emoji that aren't a known emoji sequence, and a redundant VS16, stay unescaped
  outside word marks (inside one they show as `\u200D` / `\uFE0F` labels, or warn with
  hidden characters off): on a context line, an added file, or a line without a pair.
- `rangeText` (copy) adds no line breaks at `<p>`, `<div>` or `<br>`, only between table rows.
- Some UAX #11 wide ranges are missing from the tab-stop width table.
- No keyboard path reaches the escape markers (their tooltips open on hover and tap only).

## Files view: parked

- Keyboard focus into a stuck file header ("Collapse file", "Mark remaining
  reviewed") lets focus-scroll chase the header back to the file's start; give
  those controls a negative `scroll-margin-top` of the header's own height and
  cover it with an e2e test that tabs into a stuck header.
- Unit-switch scroll fixes are tested on Chromium only; check iOS Safari.
- A text selection made in a line just before its highlighting arrives is
  dropped (the highlighted spans replace the line's text nodes), and the
  selection bar hides; keep the text nodes across the swap, or put the
  selection back (found by the flake hunt, 2026-10-30).
- First open after a reload: a card's edit box (an edit draft) waits for the
  overview, then the threads, then the card's comments, three round trips in
  a row; reading them in parallel would open it sooner (`docs/product-rules.md`,
  first-open performance; found by the flake hunt, 2026-10-30).

## Final Verdict: parked

- A verdict resent with `retry: false` after a 502 (the answer lost, the
  review landed) posts a second review; only `retry: true` looks for the
  landed one first (server review of brief V, L1).
- Rulesets readable while branch protection is hidden (403) are dropped:
  `rule` reads null instead of the rulesets' values (brief V, L5).
- Fake gh gaps: it never sets `reviewDecision` APPROVED once enough
  approvals are in (that depends on the repo's required count), and its
  GraphQL and REST answers for rulesets and protection cover only the
  shapes the tests use (briefs V L4, X L2).
- Withdrawing an opinion by Comment, on real GitHub: the refusal text for a
  reviewer without write access is unchecked (the owner is admin on both
  playground repos; tests assume 403 "Resource not accessible by
  integration"). A dismissal that times out may have gone through, yet the
  notice says the opinion still stands and nothing retries it; the next read
  corrects the card (brief X, L4).
- The Files end card reads `/api/verdict` on a short PR during the first
  visit to Files changed, right after that visit's own reads settle (the
  card is on screen at once). Within the spirit of "never on first open of
  another tab", not its letter.

## Small UI leftovers (2026-11-01)

- The `?` help list doesn't scroll with the keyboard.
- Phone: the floating Files button can cover a reply box, and stays aside
  while refusals are listed.
- On a merged PR, a LEFT thread's code shows GitHub's hunk.

- Big changed files are slow (measured 2026-11-02 on master, not caused by
  word marks): a 2,000-line changed file takes 3–7 s to open and 8–30 s of
  main-thread CPU to switch unified/side by side. Virtualize the rows
  (TanStack Virtual; the owner: "interesting", later).
- Inline diff step 2 (owner, 2026-10-31): pair removed and added lines by
  similarity, moving the rows ("github line matching is no good"), so
  unequal blocks, shifted pairs, splits/joins get word marks
  (`docs/superpowers/specs/2026-11-01-inline-diff-design.md`, non-goals).

## Housekeeping

- `scripts/queue.mjs`: a SIGKILL to the queue's process group kills both
  `queue.mjs` processes and frees the lock, but the test run keeps going
  outside the queue with nobody reading it (measured; TERM, INT and HUP are
  handled). Run the child in its own group and kill it when the waiter dies,
  or hold the lock in the child.
- `e2e/keepalive.spec.ts:367` ("a diff scrolled sideways…") failed once in a
  full verify (2026-11-02, chromium): it sets `scrollLeft` right after
  expanding and read back 0. Passed 20/20 in flake-check; find the race.
- Two unit tests failed once each under heavy load (2026-11-04, load ~19 on
  4 cores) and passed flake-check after: `highlight.test.ts` "colors code in
  a known language" (10/10), and `wordDiff.test.ts`'s 100 ms CPU budget for
  similar pairs (5/5; isolated runs take 51–89 ms, so little headroom).
- Old agent worktrees under `.worktrees/` and stray processes (e.g. old
  `threads-c` instances on test-automation#99) pile up; prune them.

## Final Verdict and Home

- A verdict that lands shows on Home only at Home's next refresh (about a
  minute): the review's server could tell Home to re-read that PR, and the
  open Home page then show it (merge of master into Final Verdict, 2026-11-02).
- Two reviews of the same PR (one pinned to a head, say) share reply
  drafts and thread-write refusals, which are keyed per PR, as on master
  (a verdict's draft, pending send and refusal are per review since the
  merge).
