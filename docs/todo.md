# To do

In priority order.

## Milestones

- **Milestone 1, PR review view (done 2026-10-26, `master` at `be19451`):**
  Files changed (clusters/lines, invisibles, file status icons), Overview
  (staged loading, thread code from the clone with the snapshot chip,
  suggestions, Timeline), as-of views, git-methodology matrix, mobile.
- **Next:** to be chosen with the owner from the items below; candidates are
  re-review after new pushes (retires the snapshot chip), commenting,
  review groups / Change Units (1), moved code (2), AI investigation (3).

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
- **Suggestions in replies:** the Overview shows only a thread's opening
  comment, so a suggested change made in a reply isn't drawn there yet.
- **Re-review after new pushes:** one of GitHub's weakest spots.
  - Show a thread's code as the commenter saw it: diff its commit against
    the base of the view the comment was made in ("changes since your last
    review", a single commit), not the PR's merge base, then drop the
    Overview's "different snapshot" chip (`CodeWindow.snapshot`,
    `docs/faq.md`).
  - Until then: the chip is over-cautious on some threads whose rows all
    match GitHub's hunk (3 of 26 on the real-PR check as of its cutoff, 7 of
    105 overall; `pnpm compare-threads` lists them). Find out why the verdict
    says "different" there.
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
- **Bots in human threads:** decide how bot comments (review bots, CI
  bots replying in a human thread) should count in a thread's attention set.
  For now (2026-10-26) bots never join it and a bot's comment never counts as
  the latest one (`docs/superpowers/specs/2026-10-26-pr-threads-design.md`).
- **Attention set:** like Gerrit's, but computed automatically as far as
  possible (whose turn it is on each PR), plus a view of pending review work
  across PRs.
- **Custom agent pre-review actions and instructions:** let the reviewer define
  their own AI steps to run before a review starts (and standing instructions for
  how their agent should help), so each reviewer's workflow is their own.

## Invisible characters: parked

- ZWJ between emoji that aren't a known emoji sequence, and a redundant VS16, stay unescaped.
- `rangeText` (copy) adds no line breaks at `<p>`, `<div>` or `<br>`, only between table rows.
- Some UAX #11 wide ranges are missing from the tab-stop width table.
- No keyboard path reaches the escape markers (their tooltips open on hover and tap only).

## Files view: parked

- Keyboard focus into a stuck file header ("Collapse file", "Mark remaining
  reviewed") lets focus-scroll chase the header back to the file's start; give
  those controls a negative `scroll-margin-top` of the header's own height and
  cover it with an e2e test that tabs into a stuck header.
- Unit-switch scroll fixes are tested on Chromium only; check iOS Safari.
