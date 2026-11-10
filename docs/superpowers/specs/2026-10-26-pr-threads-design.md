# Review threads: full conversations, Files changed bubbles, attention set

Status: approved by the owner · 2026-10-26

First stage of milestone 2 ("replace my review workflow, re-reviews aside").
The milestone goes on to write, reply to and resolve comments, approve or
request changes from carbonless, show threads from earlier commits in Files
changed, and let the reviewer add or remove themself from a thread's attention
set by hand. None of that is in this stage. This stage is read-only: it never
writes to GitHub.

## Why

The reviewer reads PRs in carbonless but still has to switch to GitHub to see
what's been said on the lines they're reading. They want GitHub's code review
experience, the commented lines highlighted and a bubble that opens the
conversation, inside Files changed. They also want to see at a glance which
threads are waiting on them. Today the Overview shows only each thread's
opening comment, which the owner didn't know. That gets fixed in the same stage.

## Goals

1. **Full conversations everywhere.** A thread shows its comment count, and
   opening it shows every comment in it, in the Overview and in Files changed.
2. **Threads inline in Files changed** for threads written on the commit being
   viewed: highlighted lines, plus a bubble that opens the thread under them.
3. **Status at a glance.** Resolved is unmistakable, and a notification dot
   shows when the viewer is in the thread's attention set.
4. **Fast.** Comments load lazily but eagerly. Nothing waits on them, and they
   are usually in before anyone opens a thread.

## Non-goals (this stage)

- Writing anything: new comments, replies, resolve/unresolve, reviews.
  The data model and UI shouldn't make those harder to add next.
- Threads written on earlier commits in Files changed. That's the next item.
  Leave a clear seam for it: one function decides which threads belong to the
  viewed diff, and where on it they sit.
- Changing the attention set by hand. That comes later in the milestone and
  will make the set stored state (in `refs/crb`). For now it's computed on
  every read.
- Re-review and the snapshot chip.

## Anti-goals

- A thread marks anything reviewed, or opening one changes coverage. Threads
  are annotations only (principle 2).
- A thread on the viewed commit isn't reachable in Files changed: its line
  sits in a collapsed gap, it's a file-level comment, or its line can't be
  placed. Every such thread must still appear somewhere in its file.
- Comment loading blocks the thread list, the bubbles, the counts or the dots.
- Hammering `gh` with one request per thread on a 100-thread PR.

## Attention set (stateless)

The owner's definition: a thread's attention set is **everyone who commented on
it, plus the PR author, minus whoever wrote the latest comment.** The viewer
sees the dot only when they're in the set.

- Owner's examples: one reviewer comment → {author}. The author replies →
  {reviewer}. A third party replies → {author, reviewer}. The reviewer replies
  → {author, third party}.
- **Resolved threads have an empty set** (owner's decision): no dot.
- **Bots (my call, the owner agreed to it for now):** bots never join the set,
  and a bot's comment doesn't count as the latest one. The latest *human*
  comment decides who is left out. A follow-up todo item covers rethinking bots
  in human threads.
- "The viewer" is the `gh` login, or the `--viewer` login in as-of views. As-of
  views use only the comments published by the cutoff ("Show what was visible
  at the time"). As-of threads are never resolved, as today.
- **Pending comments (my call):** a reviewer's unsubmitted comments aren't
  part of the PR's history (product rules), so they neither join the set nor
  count as the latest comment, and aren't in `commentCount`. The viewer still
  sees their own pending replies in an opened thread, as on GitHub, marked
  pending (icon plus tooltip). `ThreadComment` carries that state now
  because the next stage creates such drafts. As-of views don't show them.
- **Threads past 100 comments (my call):** the set must be exact. For the
  rare thread past 100 comments, the summary stage pages through the rest
  of its comment authors. Measure it, and the thread list must not regress
  on the real PR.
- The set is computed **on the server** from the thread summary, which already
  lists every comment's author and time. The latest comment's author must be
  added to the summary query for threads past 100 comments. So the dot is right
  as soon as the thread list arrives, without waiting for comment bodies.
  Expose the set itself (logins), not only a boolean: the UI will show it
  later, and manual add/remove will build on it.

## Threads in Files changed

**Which threads:** those whose opening comment's original commit is the head
commit of the diff being viewed (the session's snapshot head, live or as-of).
Other threads aren't shown in Files changed in this stage.

**Where:**
- A line comment highlights its range (`startLine`..`line`, or the single
  line) on its side: LEFT on the deleted/old side, RIGHT on the new side. Use
  the original lines on the original commit, which equal the viewed head here.
- The bubble sits at the end of the range, like GitHub. Several threads ending
  on the same line share one bubble, with a count. Opening it shows each
  thread.
- File-level comments (`subjectType: FILE`) get a bubble in the file header.
- A commented line in a collapsed gap stays reachable: the gap shows a bubble
  marker, and opening the thread expands the gap or shows the thread at the
  gap. The builder picks which, and it's tested.
- **LEFT-side threads (owner's decision: not handled in this stage):** they
  are placed by line number, the same as RIGHT ones, with no extra flag or
  check. GitHub doesn't record which commit a LEFT line was on. Both
  `commit_id` and `original_commit_id` are PR head commits; only
  `diff_hunk` shows the old side the commenter saw. So a LEFT line can be
  on a different old side than Files changed's, for example after a
  single-commit view or a retarget. On PR #99, 2 of the 4 LEFT comments
  matched the merge base and 2 had an empty hunk. The owner wants to
  discuss this right after this stage, because placing threads on the
  right spot is crucial. Keep placement in the one seam function, so
  whatever comes out of that discussion changes only that function.
- A thread whose line can't be placed in the viewed diff (should not happen
  for this commit, but AI and data bugs happen) shows in the file header
  like a file comment, flagged with a tooltip saying its line couldn't be
  placed ("Flag uncertainty"). It's never dropped.
- A thread on a file the view doesn't show (filtered, or not in the diff) is
  out of scope for Files changed. It's still in the Overview.

**Bubble:** icon-first. A comment glyph with the comment count, a muted style
plus a check icon when resolved, and a notification dot when the viewer is in
the attention set. It has a tooltip and an accessible name (e.g. "3 comments,
resolved", "2 comments, your turn"). It's a ≥40px tap target. All threads
start closed.

**Opened thread:** shows inline under the range's last line (on a phone, full
width under the line, with no horizontal page scroll; the diff's own scroll
container is fine). It shows each comment's author, relative time
(`RelativeTime`) and rendered body (the existing `GithubHtml` path, untrusted
HTML handling as today), plus suggested changes the way the Overview renders
them. Its header shows resolved and outdated status and the attention set's dot
state. While its comments are still loading it shows a small spinner, not an
empty thread. Closing it returns to the bubble, and the scroll position stays.

## Overview

- Each thread card keeps its header and opening comment as today, and gains
  the comment count (icon plus number).
  *My reading of the owner:* the card shows the opener, and opening it reveals
  the replies. The owner's words were "mention how many comments there are in
  each thread, and only show them when you open the thread". If the builder
  check or the owner reads it as "hide the opener too", follow that.
- Opening a card shows the full conversation (same rendering as Files
  changed), including suggestions in replies. This retires the todo item
  "suggestions in replies" once it's covered by tests.
- Resolved is unmistakable on the card: a resolved icon plus color in the
  header, not only a muted style. The existing resolved/unresolved grouping
  stays.
- The attention dot shows on the card header too.

## Loading: lazy but eager

- The thread list (summary stage) has everything needed to draw lists, cards,
  bubbles, counts, resolved state and dots. Comment bodies come separately.
- Once the summary is in, the client requests comments in the background for
  the threads that are on screen or about to be. That means the Overview's
  listed threads (its existing staged pages), and Files changed's threads in
  the open file and the files near it. Threads further away are fetched as they
  come near, or in a low-priority tail after that, so all of them are usually
  in before anyone opens one. Requests are batched (the current content read
  does 50 threads per query, about 1 s) and run in a few at once, not one per
  thread.
- An opened thread whose comments aren't in yet bumps its own fetch to the
  front of the queue.
- Threads with more than 100 comments page through them. No published comment is
  dropped, and the count always matches the published comments shown once
  loaded (the viewer's own pending ones show in addition, marked). A comment
  that fails to load shows as an error with a retry, never silently missing.
- Use TanStack Query for the per-batch or per-thread comment queries, as the
  rest of the web app does.
- Measure the first page view before and after (time to thread list, to the
  first visible thread's comments) on the real PR, per "First open is the
  performance target". Thread list time must not regress.

## Data shape (guidance; the builder owns the details)

- Keep types provider-neutral ("GitHub is one comment source among
  several"): a `ThreadComment` (id, author, bot, publishedAt, html, body,
  plain text) in `src/shared/types.ts`, GitHub mapping in `gh.ts`.
- `ReviewThread` gains the original commit oid, the original start/end lines
  and side (enough to place it in Files changed), and the attention set.
  `commentCount` stays the published (as-of: visible) count.
- A new endpoint, or a new stage, serves comments by thread id for a read
  (`readId`). The thread list endpoint stays fast.

## Tests

- Unit: the attention set for each of the owner's examples, plus resolved,
  bots (as the latest comment, and as a participant), pending comments, as-of
  cutoffs, the PR author commenting last, and a viewer who is the PR author.
- Unit: placement. Single-line and multi-line, LEFT and RIGHT, a file comment,
  a line in a gap, a line that can't be placed (it lands in the header,
  flagged), a thread on another commit (not placed), several threads on one
  line.
- Unit/server: paging past 100 comments, a comment read that fails (error and
  retry, never a shorter thread), batching (no per-thread `gh` calls).
- Fake gh: the scenario (`test/fake-gh/scenario.ts`) gains replies with
  bodies, bots, a resolved thread, a file comment, a thread on an older commit
  and a multi-line LEFT-side comment.
- Playwright (desktop and phone): the bubble shows on the commented line with
  the right count, dot and resolved state. Opening it shows every comment.
  A slowed comment response shows the spinner, then the comments. Opening a
  thread doesn't change review progress. No horizontal page scroll at 360px.
  The Overview card shows the count and expands to the replies.
- Real PR (a real work PR as of, read-only, data only in the
  scratchpad): every thread on the viewed head lands on the line GitHub shows
  it on, comment counts match GitHub, and timings are reported.

## Left to the builder

Exact visuals within the design tokens, the gap behavior choice, the batching
and prefetch window sizes, the endpoint shape, and how the opened thread is
laid out inside the diff's scroll container.
