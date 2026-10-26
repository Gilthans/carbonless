# Thread replies and resolving, written to GitHub

Status: draft, for the owner's approval.

Calls the coordinator made (the owner may overrule): instant UI and notices as for saves; REST for replies, refusing on a pending review; Overview cards stay in place on resolve; writing off in as-of and `--viewer` views; implementing agents may write to GitHub only on the scratch PR.

## Why

Milestone 2's goal is to replace the owner's GitHub review workflow (re-reviews later). carbonless already shows every thread, in Files changed and the Overview, with the attention set. Answering a thread still means switching to GitHub. This stage is carbonless's first write to GitHub: reply to a thread, and resolve or unresolve it, from wherever the thread appears.

The order after this, by the owner: editing and deleting your own comments, then starting new threads in Files changed. Approve / request changes comes later in the milestone.

## Goals

- **Reply** to any thread, from every place a thread appears: an Overview card and an opened thread in Files changed (`Conversation`, wherever it is rendered).
- **Resolve and unresolve** any thread from the same places.
- **Immediate only** (owner): a reply is posted to GitHub right away, as the `gh` login, the way the owner works today. No pending review, no batching ("maybe we'll support it later, undecided").
- **Instant UI**, the same rule as review-state saves (owner, for saves; applied here as the coordinator's call): the action shows at once; after 5 s a yellow notice says it's waiting and why; transient errors retry automatically with backoff; after 5 transient failures in a row, or on any other error, a red notice says what failed, with the message and Retry. The UI keeps its own state; a reload shows what GitHub has.
- **Nothing typed is ever lost.** A draft survives closing the thread, switching files and switching pages within the session, until it's sent. A failed reply keeps its text.

## Non-goals (this stage)

- Pending reviews, "Start a review", batching replies.
- Editing or deleting comments (next stage).
- New threads, file comments, PR-level comments (the stage after).
- Approve / request changes.
- Reactions, suggestions UI, Markdown preview (owner: "plain text mostly … I rarely preview it"; GitHub renders the Markdown).
- Writing anywhere other than the PR being viewed.

## Anti-goals

- **Writing anything the reviewer didn't explicitly send.** No automatic posts, no resolving as a side effect of review progress, no AI-written text. Every write is one explicit click (or the send shortcut) on one thread.
- **A reply landing somewhere other than where it shows.** A reply must go to the thread it's typed in, posted immediately and visible to others; it must never silently join a pending review (see "Pending reviews on GitHub").
- **Posting twice.** A retry after an ambiguous failure must not create a duplicate comment.
- **Losing text.** See goals.

## Replying

- Every thread gets a reply box under its comments, shown when the thread is open (Overview: when the card's replies are open; Files changed: the opened thread row). Resolved threads can be replied to as on GitHub.
- The box is a plain textarea, one line until focused, growing with its content, with a Send icon button (tooltip and accessible name, ≥40px). Ctrl/Cmd+Enter sends; Escape blurs without discarding. Empty or whitespace-only text can't be sent.
- On send, the reply appears at once at the end of the thread as the viewer's comment, marked as sending (clock, like pending comments today) until GitHub confirms; then it becomes the real comment from GitHub's answer. The box clears on send; on a final failure the text goes back into the box (or stays with the failed comment, the builder's choice) with the red notice's Retry.
- After a confirmed reply, the thread's comment count, the latest comment and the attention set update: the viewer wrote the latest comment, so they leave the set and the your-turn dot goes away. The server is the source for the set (spec `2026-10-26-pr-threads-design.md`), so it recomputes from the new comment list; the client may show the expected result while waiting.
- Drafts are per thread, kept in memory for the session (surviving the kept-alive page switch). Persisting drafts across reloads is the builder's call (`localStorage` is fine); the leave-page confirmation covers unsent and unconfirmed replies either way.

## Resolving

- One icon toggle per thread, next to its status: resolve (check) on an open thread, unresolve on a resolved one, with tooltips and accessible names, ≥40px.
- It flips at once in place (the resolved look from the threads stage: green check plus "Resolved") and syncs through the same queue and notices. Files changed's bubble and highlight follow the state; resolving clears the attention set (existing rule).
- In the Overview a card keeps its place when resolved or unresolved, so it doesn't jump from under the finger or an undo; it moves to the other group on the next refresh or reload (coordinator's call).
- Resolving never changes review progress or cluster state (principle 2): it's a GitHub action on a thread, not a review mark.

## Sync and notices

- Thread writes share the notice stack and the timing rules with review-state saves (5 s yellow with the reason, backoff 1, 2, 4, 8, 15, then 30 s, red after 5 transient failures in a row while retrying continues, red with Retry on any other error). Reuse that machinery where it fits; whether thread writes share the state queue or have their own is the builder's call, as long as each thread's writes stay in order.
- Writes to one thread go in order (a reply then a resolve lands as reply, then resolve). Writes to different threads may run in parallel, bounded.
- Notices name the thread (file and line, or "PR comment" for none) and the action ("Reply", "Resolve").
- **No duplicate replies.** A reply whose request failed ambiguously (timeout, connection dropped after sending, 5xx) is checked against the thread's comments on GitHub before it's posted again; a matching comment by the viewer made after the attempt counts as sent. The builder picks the matching rule and documents it.
- Resolve/unresolve is idempotent; retrying is safe.
- The leave-page confirmation covers any unsent or unconfirmed thread write.

## Pending reviews on GitHub

Checked on the scratch PR (2026-10-26) with a pending review open:
- REST `POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies` refuses with 422, "user_id can only have one pending review per pull request".
- GraphQL `addPullRequestReviewThreadReply` succeeds but puts the reply *into* the pending review (`state: PENDING`), where nobody else sees it.

So replies use the REST endpoint (coordinator's call), never the GraphQL mutation. That 422 is shown as a red notice ("You have a pending review on GitHub; submit or discard it there first"), with the draft kept and Retry; it is not retried automatically. Resolve/unresolve (GraphQL `resolveReviewThread` / `unresolveReviewThread`) isn't affected by a pending review.

## Where writing is off

- As-of views (`--as-of`): no reply boxes, no resolve toggles.
- `--viewer` other than the `gh` login: same.
- PRs that are merged or closed: allowed, as on GitHub.
- `--head` (a pinned commit): allowed; threads are live there.
- If `gh` lacks permission (e.g. no write access to the repo), the first write fails with GitHub's message in the red notice; nothing else is gated up front.

## Server and data

- The server does the writes through `gh` (principle 4: no carbonless server; `gh` already holds the reviewer's credentials). New endpoints, e.g. `POST /api/threads/:id/replies` and `POST /api/threads/:id/resolved`, return the updated thread (its comments, resolved state, attention set).
- The cached overview read and the comments cache (`/api/comments`, the client's `commentsQuery`) are updated from the answer so a later read doesn't resurrect the old state; a Refresh shows GitHub's truth.
- Docs: update `CLAUDE.md` ("only reads from GitHub" becomes "writes to GitHub only on the reviewer's explicit action") and `docs/product-rules.md` with the write rules above.

## Tests

- Fake gh (`test/fake-gh`) gains the write calls with state: a reply appends to the scenario's thread, resolve flips it; it can be told to fail, delay, or fail ambiguously after "posting".
- Unit: drafts kept per thread; send shows the sending comment and clears the box; confirmed reply replaces it; attention set after the viewer's reply; resolve/unresolve; ordering within a thread; retry after an ambiguous failure doesn't duplicate; red after 5 transient failures; refusal on a pending review; writing off in as-of and `--viewer`.
- Playwright, desktop and phone: reply from an Overview card and from Files changed, the reply shows at once and survives a reload (read back from the fake gh); resolve and unresolve from both places; a failing reply keeps its text with Retry; no reply box as of a cutoff.
- **Real-GitHub check, writes only on the scratch PR** (the owner made the scratch repo for this; implementing agents may push to it, open and discard pending reviews, reply, resolve and unresolve there, and nowhere else) https://github.com/Gilthans/carbonless-scratch/pull/1 (private, owner's account; add commits and threads as needed). Reply, resolve, unresolve there from the built CLI, the pending-review case, and confirm on GitHub. Everything else stays read-only. Report what was posted.

## Left to the builder

The visual details of the box and toggle within the design tokens and principles 5–6; the endpoint shapes; whether thread writes share the states queue; the duplicate-match rule; draft persistence across reloads; REST vs GraphQL for each write.
