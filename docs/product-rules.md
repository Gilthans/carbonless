# Product rules

Rules learned while building carbonless, on top of the design principles in
`CLAUDE.md`. Follow them when they apply; if a change conflicts with one, raise it.

## GitHub is one comment source among several

Comments will also come from other sources (other hosts, AI, the reviewer's own
notes). Keep shared types provider-neutral (`CodeAnchor`, `CodeWindow` in
`src/shared/types.ts`) and put host-specific mapping in an adapter. Build what
the reviewer sees from carbonless's own data (the clone) wherever possible; data
taken from the host is a fallback, and is marked as such in the data
(`source: "github"`), not only in the UI.

## Flag uncertainty, never show something wrong as certain

When carbonless can't confirm that what it shows is what really happened, it
says so visibly (e.g. the red "different snapshot" chip on a thread whose code
may not be the diff the commenter saw), with a tooltip saying why. The rule
behind a flag fails closed: no verdict means flagged. Fixing the cause comes
later; hiding the doubt is never the interim answer.

## Show what was visible at the time

Times are when something became visible to others, not when it was drafted:
review comments are dated by when they were published (their review's
submission). As-of views show exactly what had been published by the cutoff. A
reviewer's own unsubmitted comments are not part of the PR's history.

## First open is the performance target

The reviewer usually opens a PR once and rarely reloads. Measure and optimise
the first page view (time to header, to the first visible items, to complete),
both right after `crb` starts and when it has been running a while. Never block
a page on slow data: render what is ready, show skeletons per section, and load
long lists in stages (what's visible plus one "load more" page first). Caching
for reloads is secondary.

## Verify against a real PR, not only fixtures

Synthetic fixtures prove behaviour; a real PR proves the assumptions about the
host. For changes to what carbonless derives from GitHub (thread positions,
code panes, dates, timelines), also run the change read-only against a real PR
and compare with GitHub's own answer (`pnpm compare-threads` for thread code).
Real-PR data never enters the repo, tests or fixtures.

## Writing to GitHub

carbonless writes to GitHub only on the reviewer's explicit action, as the
`gh` login, through `gh` (no server of its own): replying to a review thread
and resolving or unresolving one (`src/server/threadWrites.ts`).

- **One explicit action, one write.** Every write is one click (or the send
  shortcut) on one thread. Nothing posts, resolves or retries a refused write
  on its own, nothing is written as a side effect of review progress, and no
  AI-written text is posted. Resolving never changes review progress.
- **Immediate, never into a pending review.** Replies use REST
  `POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies` (to the
  thread's first comment), never GraphQL `addPullRequestReviewThreadReply`,
  which puts the reply into the viewer's pending review where nobody else
  sees it. Resolving uses GraphQL `resolveReviewThread` /
  `unresolveReviewThread`, which a pending review doesn't affect.
- **A pending review refuses replies.** While the viewer has an unsubmitted
  review on the PR, GitHub refuses REST replies (422, "can only have one
  pending review"). carbonless shows that as a refusal (409 `pending-review`)
  with a link to the PR's files page on GitHub, where the review can be
  submitted or discarded, keeps the draft, and never retries it on its own.
  The Overview warns up front (`PrOverview.pendingReview`, from the reviews
  it reads).
- **Never twice.** A reply resent after a failed or unknown attempt
  (`retry: true`) is first looked for among the thread's comments: one by
  the viewer with the same body (line ends and trailing whitespace aside),
  dated no earlier than 60 s before the first attempt (`attemptedAt`),
  counts as sent. Resolving is idempotent.
- **Off where it can't be the reviewer's.** No writes as of a cutoff
  (`--as-of`) or as `--viewer` someone other than the `gh` login
  (`PrOverview.writes`); merged, closed and `--head` views write as GitHub
  allows. What the viewer may do comes from GitHub (`viewerCanReply`,
  `viewerCanResolve`, `viewerCanUnresolve`), and a 403 passes GitHub's
  message on.
- **Only this PR.** A write goes to a thread of the PR being viewed; a
  thread id of another PR is refused as gone.
- **Later reads agree.** A write's answer is the thread re-read from GitHub,
  and it replaces the thread in the session's kept reads, so the page doesn't
  go back to the old state before a Refresh (which shows GitHub's truth).
- **Tests write only to the fake gh.** Real writes happen only on the
  owner's scratch PR (see `CLAUDE.md`).
