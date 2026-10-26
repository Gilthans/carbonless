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
