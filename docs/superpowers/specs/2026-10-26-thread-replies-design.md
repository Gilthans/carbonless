# Thread replies and resolving, written to GitHub

Status: approved by the owner 2026-10-26, with their doc comments folded in.

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
- **Drafts are findable** (owner): "There should be a way to see all your drafts, in case you're unsure what's blocking you from leaving the page": a Drafts filter in the Overview's thread list next to unresolved/resolved, listing every thread with an unsent draft or an unconfirmed reply.

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

- Every thread gets a reply box under its comments, shown when the thread is open (Overview: when the card's one "Show more" is open, after every reply; Files changed: the opened thread row). Resolved threads can be replied to as on GitHub.
- The box is a plain textarea, one line until focused, growing with its content, with a Send icon button (tooltip and accessible name, ≥40px). Ctrl/Cmd+Enter sends; Escape blurs without discarding. Empty or whitespace-only text can't be sent.
- On send, the reply appears at once at the end of the thread as the viewer's comment, marked as sending (clock, like pending comments today) until GitHub confirms; then it becomes the real comment from GitHub's answer. The box clears on send; on a final failure the text goes back into the box (or stays with the failed comment, the builder's choice) with the red notice's Retry.
- After a confirmed reply, the thread's comment count, the latest comment and the attention set update: the viewer wrote the latest comment, so they leave the set and the your-turn dot goes away. The server is the source for the set (the PR threads spec, Linear, M2 project documents), so it recomputes from the new comment list; the client may show the expected result while waiting.
- Drafts are per thread, kept for the session (surviving the kept-alive page switch).
- Leaving or reloading the page with an unsent draft asks first (owner: "it should warn you before refreshing since it will go away"). Superseded once drafts survived a reload (owner, later: "refresh should only be dirty if information is lost"): only a draft storage can't keep asks (`docs/product-rules.md`, "Leaving asks only when something would be lost").
- A reply that was sent but not yet confirmed by GitHub should survive a reload and keep syncing (owner: "ideally it should survive a refresh, but if that's complex let's defer"). Coordinator's call: keep sent-unconfirmed replies, and drafts too, in `localStorage` per PR, and resend after a reload through the duplicate check below. If that turns out complex, the builder defers it and says so; the leave-page warning covers it meanwhile.

## Resolving

- A big "Resolve" / "Unresolve" button (text and icon, ≥40px) beside each thread's reply box (below it on a phone); in the Overview inside the card's one "Show more" (owner, 2026-10-27: it was first an icon toggle in the header).
- It flips at once in place (the resolved look from the threads stage: green check plus "Resolved") and syncs through the same queue and notices. Files changed's bubble and highlight follow the state; resolving clears the attention set (existing rule).
- In the Overview a card resolved or unresolved fades away where it is over a few seconds (owner: "so there's a little time to undo the action but it's clear that it's going away"), with the toggle still there to undo; then it moves to the other group. Undo during the fade keeps it in place. Switching lists (Unresolved, Resolved, Drafts) ends every fade at once (owner: "it should skip the fade out animation and move it immediately"): the card is already in its new list, and a card fading out because its last comment was deleted is gone. The fade respects `prefers-reduced-motion` (a plain countdown state instead).
- Resolving never changes review progress or cluster state (principle 2): it's a GitHub action on a thread, not a review mark.

## Sync and notices

- Thread writes share the notice stack and the timing rules with review-state saves (5 s yellow with the reason, backoff 1, 2, 4, 8, 15, then 30 s, red after 5 transient failures in a row while retrying continues, red with Retry on any other error). Reuse that machinery where it fits; whether thread writes share the state queue or have their own is the builder's call, as long as each thread's writes stay in order.
- Writes to one thread go in order (a reply then a resolve lands as reply, then resolve). Writes to different threads may run in parallel, bounded.
- Notices name the thread (file and line, or "PR comment" for none) and the action ("Reply", "Resolve").
- **No duplicate replies.** A reply whose request failed ambiguously (timeout, connection dropped after sending, 5xx) is checked against the thread's comments on GitHub before it's posted again; a matching comment by the viewer made after the attempt counts as sent. The builder picks the matching rule and documents it.
- Resolve/unresolve is idempotent; retrying is safe.
- The leave-page confirmation covers any thread write a reload would lose (now: resolves, unresolves and deletes not yet on GitHub; replies are kept and resent).

## Pending reviews on GitHub

Checked on the scratch PR (2026-10-26) with a pending review open:
- REST `POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies` refuses with 422, "user_id can only have one pending review per pull request".
- GraphQL `addPullRequestReviewThreadReply` succeeds but puts the reply *into* the pending review (`state: PENDING`), where nobody else sees it.

So replies use the REST endpoint (coordinator's call), never the GraphQL mutation. Replies are refused (owner), never posted into the pending review:
- That 422 is shown as a red notice saying a pending review on GitHub blocks replies, with a link to the PR's Files changed page on GitHub where the review can be submitted or discarded, the draft kept, and Retry. It is not retried automatically.
- The Overview's "who's reviewing" section shows a prominent warning while the viewer has a pending review on the PR (owner): replies can't be posted while it's pending, with the same link. The server finds it from the reviews it already reads (the viewer's review in state `PENDING`); a Refresh rechecks it, and a 422 also turns it on. Resolve/unresolve (GraphQL `resolveReviewThread` / `unresolveReviewThread`) isn't affected by a pending review.

## Where writing is off

- As-of views (`--as-of`): no reply boxes, no resolve toggles.
- `--viewer` other than the `gh` login: same.
- PRs that are merged or closed: allowed, as on GitHub.
- `--head` (a pinned commit): allowed; threads are live there.
- **Permissions are shown up front** (owner): "a clear warning banner that you don't have permissions for review in this repo, in the 'who's reviewing' section". GitHub's threads carry `viewerCanReply` and `viewerCanResolve` / `viewerCanUnresolve`; the server passes them on, the UI hides the box or the toggle a thread doesn't allow, and the banner says what the viewer can't do in this repo when any thread disallows it. A write refused anyway (403) shows GitHub's message in the red notice.

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

The visual details of the box and toggle within the design tokens and principles 5–6; the endpoint shapes; whether thread writes share the states queue; the duplicate-match rule; draft persistence across reloads; REST vs GraphQL for resolve and unresolve (replies are REST, above).
