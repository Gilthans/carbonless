# To do

In priority order.

## 0. Parity with the GitHub review workflow

Foundation for everything below.

- **PR review view (done):** open a PR, see the overview, review it cluster by cluster
  with progress tracking. Design:
  `docs/superpowers/specs/2026-10-21-pr-review-parity-design.md`.
- **Commenting** from carbonless.
- **Re-review after new pushes:** one of GitHub's weakest spots.
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
- **Attention set:** like Gerrit's, but computed automatically as far as
  possible (whose turn it is on each PR), plus a view of pending review work
  across PRs.
- **Custom agent pre-review actions and instructions:** let the reviewer define
  their own AI steps to run before a review starts (and standing instructions for
  how their agent should help), so each reviewer's workflow is their own.
