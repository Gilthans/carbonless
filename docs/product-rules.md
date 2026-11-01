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

## Frequent actions get keyboard shortcuts

Every frequent action gets a keyboard shortcut where it makes sense,
registered in one place (`useShortcut` in `src/web/shortcuts.tsx`) so it
shows in the `?` help; keys a field handles itself (Ctrl/Cmd+Enter, Escape)
are listed with `useShortcutHelp`. A shortcut never fires while typing in a
field, with Ctrl/Cmd/Alt held unless its keys say so (the browser's own,
like Ctrl/Cmd+C, stay the browser's), or while another modal dialog is open.
On a phone there's no keyboard: the help isn't offered there.

## Writing to GitHub

carbonless writes to GitHub only on the reviewer's explicit action, as the
`gh` login, through `gh` (no server of its own): replying to a review thread,
starting a new one (on lines, a span inside them, or a file), resolving or
unresolving one, editing or deleting one of the viewer's comments in one,
and the review verdict (`src/server/threadWrites.ts`,
`src/server/newThreads.ts`, `src/server/verdict.ts`).

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
- **New threads are REST too, on GitHub's exact lines.** A new thread is
  `POST /repos/{o}/{r}/pulls/{n}/comments` with `commit_id` the snapshot's
  head: one line as `line` + `side` only, a range adding `start_line` +
  `start_side` (from either side to either, across hunks too: GitHub
  takes any whose start comes before its end in the diff and refuses the
  rest with its 422), a file as `subject_type: "file"` (GitHub then
  reports line 1; carbonless shows none). A range's start is read from
  GitHub's `originalStartLine`: its current `startLine` gives a `LEFT`
  context line's new number. Never GraphQL's `addPullRequestReviewThread`,
  which puts the comment into the viewer's pending review. What is sent is
  what the thread then reads back: the answer is the thread as GitHub's
  GraphQL lists it, mapped like any other. Only on the head the page shows
  (else 409 `stale`: refresh). A line or file GitHub's diff doesn't have
  (its 422 "could not be resolved") is 404 `gone`; a pending review refuses
  it as it refuses replies (409 `pending-review`). `LEFT` lines take
  comments only when GitHub's merge base for the snapshot's head (REST
  compare of the PR's base commit, `baseRefOid`, and the head: what GitHub
  resolves a `LEFT` line against; a merged PR's stays where it was) is
  the snapshot's left side (`PrOverview.commentLeft`); otherwise they are
  refused (400), as GitHub would put them on other lines. They differ when
  the base moved on past what the snapshot shows (a pinned head, a started
  patch set). One compare per snapshot, asked lazily and never
  waited for by the overview (true until GitHub says); a write waits for
  it.
- **A hidden marker carries what GitHub can't.** A new thread's opening
  comment ends in an HTML comment GitHub doesn't render,
  `<!-- crb:v1 id=<clientId> -->`, with `span=<startLine>:<startCol>-<line>:<endCol>`
  for a span inside the lines (`src/server/marker.ts`). The server strips
  a trailing crb marker from every comment body it sends; the page never
  sees it. The opener's `anchor.startCol`/`endCol` come from it only when
  its lines are the thread's own, else the thread is on whole lines (moved
  on, or the marker edited on GitHub). An edit (and blanking to
  `[deleted]`) puts the comment's marker back on the new text, and edits
  compare bodies without it. Only a `crb:v1` marker carrying a well-formed
  id is carbonless's: stripped (a garbled span then reads as none) and
  carried through edits; anything else that merely looks like one is the
  author's own text, shown and kept as it is. A marker edited away on
  GitHub can't be found by a retry: a thread whose answer got lost, then
  had its marker removed before the retry, is posted again (accepted: the
  marker is the only id GitHub keeps for it).
- **Edits and deletes are REST, one comment each.** An edit is
  `PATCH /repos/{o}/{r}/pulls/comments/{id}`, a delete
  `DELETE /repos/{o}/{r}/pulls/comments/{id}` (the comment's REST id,
  GraphQL's `databaseId`, which only the server sees). A pending review
  blocks neither. Comments in the viewer's pending review are refused
  (403); PR conversation comments and review bodies aren't edited or
  deleted here. A reply this session just posted that GitHub's GraphQL
  doesn't list yet is edited or deleted all the same (by the REST id its
  post answered).
- **A delete asks first, then waits out an undo window.** Delete opens a
  confirmation by the button ("Delete this comment?", with "It stays as
  [deleted] in the thread." for an opener that published comments follow,
  the server's rule below), Cancel focused; Escape, a click outside or
  leaving the page cancels (owner: "add a confirmation when
  deleting a comment, in addition to the undo"). Confirmed, the comment
  collapses to "Deleted · Undo" and goes after `DELETE_UNDO_MS`; Undo
  within the window sends nothing.
- **Deleting an opener with replies blanks it.** Deleting the first comment
  of a thread that has published comments after it (the viewer's pending
  ones don't count) edits its body to `[deleted]` instead (owner: "it
  should instead be edited to say [deleted]"), so the thread keeps its
  opener, place and code. Such an opener (body exactly `[deleted]`,
  trimmed) is `ThreadComment.deleted`, and shows like any other comment of
  the viewer's: "[deleted]" as its text, with Edit, which writes it back
  (owner: "it should look like a regular comment, and not like a deleted
  one, allowing for me to edit it back if I want"). Delete is off on it
  while published comments follow it (nothing more to do); deleting it
  again is answered as done (a retry that landed). Once no published
  comment follows it, the viewer may delete it, and then it really goes.
  Deleting any other comment deletes it; deleting a thread's last
  published comment removes the thread (`ThreadGone`), and it leaves the
  session's kept reads.
  Whether published comments follow is GitHub's fresh list reconciled
  with this session's own writes: a reply it just posted counts even
  before GraphQL lists it, a comment it deleted doesn't count (and stays
  out of every answer) even while GraphQL still lists it; in doubt, the
  opener is blanked rather than deleted.
- **An edit never overwrites a newer version unseen.** The server reads the
  comment's body fresh by REST first (GraphQL may lag a write): if it already is the new text (line ends and
  trailing whitespace aside) the edit is done, nothing sent (a retry that
  landed); if it isn't the body the edit started from (`from`) any more,
  it is refused (409 `changed`, with the comment as GitHub has it now)
  unless the reviewer chose "Save anyway" (`force`). A delete of a comment
  already gone (GitHub's 404 when a REST read of it is 404 too, or listed
  by neither the fresh nor a kept read) is done; a 404 for one REST still
  has is a refusal.
- **A pending review refuses replies.** While the viewer has an unsubmitted
  review on the PR, GitHub refuses REST replies (422, "can only have one
  pending review"). carbonless shows that as a refusal (409 `pending-review`)
  with a link to the PR's files page on GitHub, where the review can be
  submitted or discarded, keeps the draft, and never retries it on its own.
  The Overview warns up front (`PrOverview.pendingReview`, from the reviews
  it reads).
- **Never twice.** The server runs one write per thread at a time, so a
  resend waits for the attempt still running. Each reply carries a
  client-made id (`clientId`, the same on every resend, a reload's too), and
  the server remembers the replies it posted by it: a resend of one is
  answered with it, never posted again. A resend after a failed or unknown
  attempt (`retry: true`) also looks among the thread's comments on GitHub
  (crb may have restarted): one by the viewer with the same body (line ends
  and trailing whitespace aside) that the client didn't know when it first
  sent the reply (not in `knownCommentIds`), and that isn't another reply
  this session posted, counts as sent; a retry with no known ids is
  refused (a thread always has its opener). After an attempt whose outcome
  is unknown (it may have landed), its retry reads the thread again a few
  times before posting, as GitHub may not list the reply yet. No clocks are
  compared: the phone's may be off. Resolving is idempotent. New threads
  run one at a time per PR and are remembered by their client id the same
  way; a retry of one first lists the PR's review comments (REST, no lag)
  for the viewer's opener whose marker carries that id, and posts only if
  there is none. A thread posted but not yet listed by GitHub's GraphQL is
  looked for a few times, then answered 502: its resend finds it, never
  posting again.
- **Refused means refused.** When GitHub answers a write with an error, it
  is refused for good, with GitHub's message (401/403 forbidden, 404 gone,
  anything else invalid), and nothing sends it again on its own. Every
  refused write stays listed in one place on both pages (`RefusedWrites`)
  until the reviewer's Retry lands (refused again, it stays with the new
  message) or they drop it, after a confirmation (owner: "an always on
  thing that allows to either retry or drop which requires confirmation").
  A dropped reply, edit or new comment loses its text; a dropped resolve or
  delete leaves GitHub as it is. Typing the reply again and sending it,
  saving or cancelling the edit, or discarding the new comment settles it
  too. Refusals are kept in `localStorage` beside the drafts
  (`crb:refused:<owner>/<repo>#<n>`, `src/web/threads/refusals.ts`), so a
  reload lists them all again. A Retry with nothing to send (a cleared box,
  an edit back as it was, a draft gone, sent from another tab) is off,
  saying so, and never settles it: only Drop does. "Show theirs" on an edit
  changed on GitHub keeps it listed until the edit is saved or dropped. A
  resolve or delete Retry already on its way when the page reloads still
  goes to GitHub (the crb server sends it); the next page lists the
  refusal again, and dropping it then can't call that back. Only
  GitHub's own trouble is transient (502 to the page, which retries): HTTP
  408, 429 or 5xx, a rate limit (a rate-limit 403 too), a timeout or no
  answer at all. A 404 for a thread GitHub still has is a refusal, not
  "gone".
- **Posted is posted.** A reply that landed is answered as posted, even
  when GitHub doesn't list it yet (it is added to the thread from GitHub's
  answer to the post) or the thread was deleted right after. Posting a
  reply clears the pending-review warning (finding one by the dedupe
  doesn't), and a pending-review refusal sets it.
- **The verdict is one submitted review.** Approve, Comment or Request
  changes is REST `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event`,
  `commit_id` the snapshot's head (an older commit on `--head` or a
  started patch set: what was reviewed; any other is 409 `stale`) and no
  `comments`; a `body` only when the reviewer typed a message, ending in
  the hidden `crb:v1` marker with the client id (no span), stripped from
  every body the server sends. Comment and Request changes need a message
  (400 otherwise, as GitHub refuses them). It is never gated on review
  progress, open threads or checks. A pending review of the viewer's
  refuses it (GitHub's 422, "User can only have one pending review per
  pull request": 409 `pending-review`, nothing sent, never joined or
  submitted); approving or requesting changes on one's own PR is 403
  `forbidden` with GitHub's message. One press, one review: verdicts run
  one at a time per PR and are remembered by client id; a retry first
  lists the PR's reviews (REST) for the viewer's one in the event's state
  carrying its marker, or, sent without a message, an empty one submitted
  since this server's first attempt (10 s of slack for GitHub's clock;
  after a restart, the client's `attemptedAt` less 2 minutes), and posts
  only if there is none. A verdict that lands drops the kept overview
  and verdict reads, so the next ones read GitHub again.
- **What blocks is read only for the Final Verdict.** `GET /api/verdict`
  is one GraphQL read (`mergeStateStatus`, `reviewDecision`, the
  requested reviewers with `asCodeOwner`, the reviews with their commits,
  the head's checks with `isRequired`) beside the base branch's rule
  (branch, protection and `rules/branches` reads, `src/server/verdict.ts`
  `ruleOf`), never on first open. A rule that can't be read (no admin
  access: protection 403/404 on a protected branch, where an empty rules
  list means unknown, not none; a private repo on a free plan; any
  failed read) is `null`, never an error. As of a cutoff, GitHub's
  present-only facts (merge state, decision, rule, required flags,
  code-owner requests) are null, never today's; on a merged or closed PR
  the merge state, decision and rule are.
- **Off where it can't be the reviewer's.** No writes as of a cutoff
  (`--as-of`) or as `--viewer` someone other than the `gh` login
  (`PrOverview.writes`); merged, closed and `--head` views write as GitHub
  allows. What the viewer may do comes from GitHub (`viewerCanReply`,
  `viewerCanResolve`, `viewerCanUnresolve`; per comment `viewerCanUpdate`,
  `viewerCanDelete`, off for a pending comment), and a 403 passes GitHub's
  message on. carbonless offers edit and delete only on the viewer's own
  comments, even where GitHub allows more (maintainers).
- **Only this PR.** A write goes to a thread of the PR being viewed; a
  thread id of another PR is refused as gone.
- **Later reads agree.** A write's answer is the thread re-read from GitHub,
  and it replaces the thread in the session's kept reads, so the page doesn't
  go back to the old state before a Refresh (which shows GitHub's truth).
  GitHub's GraphQL may lag a REST write: the re-read is tried again a few
  times, then the answer shows the write anyway (the reply added, the new
  text, the deleted comment left out).
- **One thread, one write at a time.** Replies, resolving, edits and
  deletes on one thread run in the order asked, never at once.
- **Leaving asks only when something would be lost or left unsettled** (owner: "refresh
  should only be dirty if information is lost"; `useUnsavedGuard`). It
  asks for review states not yet stored, for a resolve, unresolve or
  delete not yet on GitHub (a delete in its undo window too: nothing is
  sent yet and no later page sends it), and for any refused write until
  its Retry lands or it is dropped (owner: "Until dropped or succeeded,
  page should still ask"), though the next page lists it again. It never asks for drafts (reply,
  edit, new thread) or for replies, edits and new threads on their way:
  `localStorage` keeps them and the next page resends what was sent. Only
  while storage can't keep them (a private window, blocked site data) do
  they ask.
- **Tests write only to the fake gh.** Real writes happen only on the
  owner's scratch PR (see `CLAUDE.md`).

## A file is crossed off only when all of it is

In the files unit (the progress bar, the file list) a file whose clusters
are all crossed off counts as crossed off; a done file with any reviewed
cluster counts as reviewed, however many of the rest were crossed off
(owner: "A file should only be considered crossed off in the progress bar
if all clusters are crossed off. Otherwise it should count as reviewed").
A file with any unreviewed cluster is neither. The rule is one function
(`fileFlags`, `src/shared/progress.ts`), used by the server and the page.

## "Ignore whitespace" is a view

Settings' "Ignore whitespace" (`src/web/files/whitespace.ts`, git's `-w`:
lines equal once every ASCII whitespace character is removed) only changes
how the diff reads. It never changes clusters, their keys, the +/− counts,
progress, or what is unreviewed: the hunks the server sends are the ones
shown, and a whitespace-only pair is still a change, drawn as one quiet
row. A cluster that is all whitespace-only collapses to one row, but keeps
its checkbox and cross-off and still has to be reviewed, and it stays open
while a thread or a thread link's landing sits on one of its lines. The
matching runs over the whole hunk (a line's twin may be a context line or
sit in another cluster: a one-sided `~` row). What it guarantees, pure and
checked for any input (principle 2): every line of the hunk is in the rows
exactly once, and dropping the lines shown as added or removed from the two
sides leaves them whitespace-equal, so a block moved across an unchanged
line, or a line that crossed one, is never shown as whitespace-only. It may
show more as changed than `git diff -w` does, never less.
