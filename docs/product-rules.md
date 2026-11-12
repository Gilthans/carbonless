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
The skeletons and spinners follow "Loading never looks empty" below.

## Loading never looks empty

Design principle 8 (`CLAUDE.md`). The owner: "Whenever something is
loading, there should be a visible spinner somewhere relevant. An empty
result should always be easily distinguishable for a still loading result."

- **Where the result goes.** While an answer is on its way, a spinner
  (`Spinner`, `src/web/Spinner.tsx`: the spinning sync icon, a tooltip and
  an accessible name to find it by, `role="status"`) or a skeleton (`SkeletonBar`, grey
  bars where text will be) shows in the place the result will take, and
  the region it fills is `aria-busy`. A whole page's code still loading
  shows a spinner too, never a blank page.
- **Never as empty.** Until the answer says empty, nothing reads as empty:
  no 0 counts or 0%, no empty meter, no "None", "No threads", "No
  activity" or empty list, no outline that means "no comments yet". When a
  part of the page is loaded and another isn't (the diff, then its
  comments), the part still loading says so where its results will show
  (Files changed: "Loading comments" in the progress bar, the file tree and
  the open file's bubble; the Timeline: "Loading threads" on a review run
  and its comments).
- **In place, never moving the page.** A spinner appears in place:
  showing or hiding it never moves anything (owner, 2026-11-02: "Make sure
  spinners appear somewhere static so the UI doesn't jitter"). It takes a
  slot kept whether or not it spins, replaces something of its size, or is
  laid over; tested by comparing bounding boxes before, while and after.
- **Errors are a third state.** A failed read shows its error (red; or a
  `warn` notice where only a part is missing, per "Flag uncertainty", like
  Files changed's "Threads not shown"; with Retry where it can), never the
  empty state and never a spinner that keeps on.
- **Tested by holding the answer.** Each loading state has a test that
  holds the answer (e2e: the fake gh's `hold`; unit: a held fetch from
  `test/loading.ts`), asserts the loading state is visible and the empty
  one absent, releases, and asserts the result (`expectLoadingThen`, in
  `e2e/fixtures.ts` and `test/loading.ts`). Never a timing race.

## A suggestion list never moves a button

A combobox's suggestions float over what follows the input; they never push
anything. The dialog or sheet holding one keeps its top where it is (a
dialog near the top, room kept below for the list; a full-height bottom
sheet on a phone), so the list opening or closing moves nothing. A click
lands only where its press began, and a press on a button blurs the input,
which closes the list: anything the list moved would miss the click (brief
L, 2026-11-02: Add took two clicks while the list was open). Tested by
comparing the buttons' bounding boxes with the list open and closed, then
one click (a tap) with it open.

## Marks carry only exact changes

After a push, a reviewer's mark moves to the new patch set only when the
cluster it was on traces into the new head with the same removed and added
lines, byte for byte (through a rebase, a merged-in base or a rename), and
only a mark the reviewer made by hand: never one carried before by itself,
never across a cluster the reviewer unticked. Everything else the author
touched is reworked or new, and unreviewed. A carry is stored as a
`carried` event when the reviewer first acts on the new patch set, and a
carried event that doesn't check out (an unknown patch set, a source that
isn't reviewed) is ignored, leaving the cluster unreviewed (principle 2).

## Re-review never hides a change

The since view, the "needs eyes" filter, carried marks, thread placement
and the verdict's since line organise what changed; none of them removes
anything. Every unreviewed cluster stays countable and in the full diff,
one drag of the comparison base away; a reviewed cluster the author
removed shows as `gone`; a thread that can't be placed is listed under its
file or under "Not in this comparison" until it is resolved; a failure
says so where the answer would be. "Nothing to read" and "nothing to
re-read" show only when the engine's answer says so: an identical diff
with no reworked, new or gone cluster. Approving again on an identical
diff posts a review only on the reviewer's press.

## Every visible cluster is individually markable

The owner: "every cluster visible in the UI in any view should be
individually markable (mark=either reviewed or crossed off)". In the full
diff and the since view, unified or side by side, whitespace shown or
ignored, on a phone too, every unit the reviewer reads as a change (a
cluster's lines, a since-view piece, a collapsed whitespace-only cluster,
a file-level change) has its own reviewed checkbox and cross-off; using
them changes that unit and nothing else on screen, and the state is there
again after a reload. A disabled control says why (a reviewed cluster is
unticked before it is crossed off). The one exception is an earlier patch
set, read-only by design, with its "read-only" chip and "Back to PS<n>".
Tests read the units the same way in jsdom and on a live page
(`test/markable.ts`, `src/web/files/markable*.test.tsx`,
`expectEveryUnitMarkable` in `e2e/fixtures.ts`, `e2e/markable.spec.ts`);
add every new kind of diff row to them.

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
carbonless takes a browser key only where it offers the same thing over
more (Find in PR over Cmd+F / Ctrl+F on Files changed, which searches every
file), and always leaves the browser's reachable: a second press with the
box focused reaches the browser's find, and in a comment box the key stays
the browser's.
On a phone there's no keyboard: the help isn't offered there.

## Writing to GitHub

carbonless writes to GitHub only on the reviewer's explicit action, as the
`gh` login, through `gh` (no server of its own): replying to a review thread,
starting a new one (on lines, a span inside them, or a file), resolving or
unresolving one, editing or deleting one of the viewer's comments in one,
and submitting the review verdict: Approve, Comment or Request changes,
one submitted review per press (the Final Verdict tab and the end of Files
changed; `src/server/threadWrites.ts`, `src/server/newThreads.ts`,
`src/server/verdict.ts`). Comment over the viewer's own standing Approve or
Request changes also dismisses that review (REST `PUT
…/reviews/{id}/dismissals`, message "Changed to a comment"), as the
owner's tooltip defines Comment: "No approval, but approval by someone
else acceptable". GitHub keeps the latest APPROVED or CHANGES_REQUESTED
review standing through later comments, so without the dismissal the
switch wouldn't happen.

- **Withdrawing an opinion by Comment.** The comment posts first, then the
  dismissal, so a failed dismissal never leaves the reviewer with neither.
  The review dismissed is the viewer's latest opinionated one, from a fresh
  REST read at send time, and only if it predates the comment (never anyone
  else's, never a newer verdict). A dismissal GitHub refuses is still a
  success (the comment is on GitHub): a yellow notice says the opinion still
  stands, with GitHub's message, and nothing goes to "not posted". A resend
  under the same client id never posts again but finishes the dismissal; one
  already dismissed counts as done (GitHub's 422 "Can not dismiss a
  dismissed pull request review", carbonless-scratch 2026-11-01). Reading
  reviews, a dismissed opinion followed by a comment of the same reviewer
  reads as that comment.

- **One explicit action, one write.** Every write is one click (or the send
  shortcut) on one thread. Nothing posts, resolves or retries a refused write
  on its own, nothing is written as a side effect of review progress, and no
  AI-written text is posted. Resolving never changes review progress. The
  one exception is Comment over the viewer's own standing approval or
  request for changes: that one press makes two writes, the comment and
  then the dismissal of that review, since that is what Comment means
  (below). Its tooltip says so before the press.
- **Resolve in Files changed closes the thread to its bubble** (the owner,
  2026-11-09), on the press. Once none of the bubble's threads shows, it
  closes and takes the focus (a bubble above the view comes down to just
  under the headers); while others show, only the resolved one is hidden
  (until it reads unresolved) and the next one takes the focus. Opening the
  bubble shows them all. Any write of the thread GitHub refuses opens it
  again (beside its notice). A thread with unsent text (its reply box, an
  edit) or a reply, edit or delete on its way stays open. Unresolve closes
  nothing (`src/web/files/resolveCollapse.ts`).
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
- **What is posted reads as typed.** GitHub's markdown reads `<String>`
  in `List<String>`, or `<T>`, as an HTML tag and drops it. Every body
  carbonless posts (new thread, reply, edit) has a backslash before each
  `<` that starts a tag GitHub drops (`List\<String>`), outside code
  spans and blocks (a fence closes only in its own container, as on
  GitHub); `a < b`, autolinks, bare links (an escape would land in the
  link: `http(s)://` or `ftp://` after anything but a letter, or a
  word starting `www.`), HTML comments and the tags GitHub keeps stay as they are
  (`src/shared/markdownEscape.ts`, applied on the
  server where the write is built, before the marker). The page gets
  bodies without those escapes, so the edit box shows what was typed and
  the edit, retry and dedupe checks compare the text as posted.
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
  one at a time per review (its session on the server) and are remembered
  by client id there; the page keeps a verdict on its way, and a refused
  one, under that review's own key (`crb:verdict:…@<review id>`,
  `crb:refused:…@<review id>`), so only the review that pressed resends or
  retries it, never another review of the same PR; a retry first
  lists the PR's reviews (REST) for the viewer's one in the event's state
  carrying its marker, or, sent without a message, an empty one on the
  same commit submitted since this server's first attempt (10 s of slack for GitHub's clock;
  after a restart, the client's `attemptedAt` less 2 minutes), and posts
  only if there is none. A verdict that lands drops the kept overview
  and verdict reads, so the next ones read GitHub again.
- **What blocks is read only for the Final Verdict.** `GET /api/r/<id>/verdict`
  is one GraphQL read (`mergeStateStatus`, `reviewDecision`, the
  requested reviewers with `asCodeOwner`, the reviews with their commits,
  the head's checks with `isRequired`; should GitHub refuse that field,
  read again without it, `required` then null) beside the base branch's rule
  (branch, protection and `rules/branches` reads, `src/server/verdict.ts`
  `ruleOf`), never on first open. A rule that can't be read (no admin
  access: protection 403/404 on a protected branch, where an empty rules
  list means unknown, not none; a private repo on a free plan; any
  failed read) is `null`, never an error. Each reviewer counts by their
  latest approval, change request or dismissal (GitHub's
  latestOpinionatedReviews), their latest comment only when they have none:
  a reply after approving leaves the approval standing. As of a cutoff, GitHub's
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
  As soon as GitHub takes a write, what it is known to do (resolved or
  not, the posted or edited comment, the deleted one) goes into the kept
  reads, and the re-read then replaces it: a page loaded meanwhile (a
  reload while the answer is out) shows the write at once, never the
  state before it, and never waits on GitHub. A new thread isn't known
  before GitHub lists it: the page's resend after a reload brings it.
- **One thread, one write at a time.** Replies, resolving, edits and
  deletes on one thread run in the order asked, never at once.
- **Leaving asks only when something would be lost or left unsettled** (owner: "refresh
  should only be dirty if information is lost"; `useUnsavedGuard`). It
  asks for review states not yet stored, for Home's view list not yet
  saved (it retries on its own while the page lasts), for a resolve,
  unresolve or delete not yet on GitHub (a delete in its undo window too:
  nothing is sent yet and no later page sends it), and for any refused
  write until its Retry lands or it is dropped (owner: "Until dropped or
  succeeded, page should still ask"), though the next page lists it again. It never asks for drafts (reply,
  edit, new thread) or for replies, edits and new threads on their way:
  `localStorage` keeps them and the next page resends what was sent. Only
  while storage can't keep them (a private window, blocked site data) do
  they ask.
- **On the page, the verdict is never gated.** Approve,
  Comment and Request changes are always allowed, whatever the review's
  progress, open threads or checks (owner: "approving/requesting changes
  can be done regardless of the state of the review"); progress shows
  beside them as information only. Approve sends at once; a message goes
  only when "Include a message" is ticked and has text. GitHub refuses
  Comment and Request changes without one, so pressing either without
  text ticks the box and focuses it, sending nothing. One verdict is out
  at a time: the buttons wait while it is (a double press posts one
  review). It shows at once as sending ("You approved just now") and is
  kept in `localStorage` (`crb:verdict:<owner>/<repo>#<n>`, with the
  message draft) until GitHub has it: transient failures and a reload
  resend it with the same client id and `retry: true`, so the server
  finds one that landed. A refusal is listed with the other refused
  writes as "Verdict", keeping its event and the message it was sent
  with (or none): its Retry sends exactly that, never what the box holds
  since. Any verdict landing (a Retry, a resend after a reload, a new
  press) settles a listed one, so no Retry can post a second review;
  its message, unless just sent, goes back in the box (never lost). A
  pending review refuses it with the pending-review notice. The Files
  end card reads GitHub's merge facts only once the page's first open
  has settled and the card is on screen. It goes on
  the snapshot's head (`commit`), and the card says so first when that
  is an older commit (a pinned or reviewed head). On the viewer's own PR
  only Comment is offered (GitHub refuses the others); as of a cutoff,
  as another viewer, merged or closed, none.
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

## Home never hides a PR on its own

Home lists PRs; the reviewer decides what to set aside. Only the reviewer's
own snooze or waiting-on hides a row (annotations are `by: "human"` events,
never written by anything automatic). A hidden row stays in its section,
counted in the section's footer ("2 snoozed · 1 waiting", any other reason
as "N hidden"), and one click reveals it with its reason; Wake up is one
of the row's actions (the floating bar with a mouse, the ⋯ sheet on touch). A
long section folds behind "show N more", which only folds: the count is
every row. Nothing automatic, AI or not, hides or drops a PR, and Home
reads review progress but never writes it.

While a view repo's first read is still out, Home never shows a count or
an empty section for it: counts are spinners (footers too) and
placeholder rows stand in until every repo has answered (owner,
2026-11-01: "An empty result should always be easily distinguishable for
a still loading result"). A repo never read successfully is unknown, not
empty: the counts carry an alert naming it, and no section says "none".

## "Side by side" is a view

Settings' "Side by side" (`src/web/files/sideBySide.ts`) lays the same
hunks out as old-left / new-right rows, GitHub-style: the i-th removed line
of a cluster run against the i-th added one, the surplus against a blank,
context on both sides. It changes nothing but the layout: clusters, their
keys, the +/− counts, progress, what is unreviewed, threads and their
places, and the other settings' rows (a whitespace-only pair is one `~`
row with each side's own text; a whitespace-only cluster is still one
collapsed row) are the same in both views, and switching never changes
review state or refetches anything. What it guarantees, pure and checked
for any input (principle 2): every removed, added and context line of the
hunk is in the rows exactly once per side, left cells in old-file order,
right cells in new-file order, a changed line never in a cell of the wrong
side, and a blank cell only once the other side has run out. The sides
never widen the page: code wraps in its cell, on a phone too.

## Agent threads are the reviewer's own

Questions to the reviewer's agent (Ask agent) and its answers are private:
they live in the reviewer's `agent/threads` ref of carbonless's clone,
written only by this server, never pushed, and AI text never reaches
GitHub (a later "suggest a comment" would let the reviewer edit and post
it as theirs). `--viewer` and `--as-of` reviews have no agent: the
question would be on someone else's behalf, or about a past moment.

- **The reviewer's harness is the gate; carbonless states and shows.** At
  the only leash so far, `open`, carbonless allows every permission request
  (`allow_once`), running and editing code in the agent's own checkout
  included; only a switch into plan mode is refused, since nobody could
  approve the plan. The preamble says what the reviewer expects (no push,
  no GitHub, no change to the PR unless asked in the thread); every tool
  call and decision shows in the thread's activity line and is stored with
  the answer. Enforcement beyond that is the harness's own (its allow and
  deny rules, hooks, sandbox), and stricter leash levels come later.
- **The agent is given no way to review state or the reviewer's copies;
  at `open`, nothing in code stops it taking one.** Its checkout is a
  shared clone of carbonless's cache clone with only `refs/heads` and
  `refs/tags`, under `<cache>/agents/<review>/tree`; the session's cwd is
  its parent, so a PR's harness config isn't loaded. carbonless offers it
  no tool or API for review state. But it has a shell, and its checkout's
  `objects/info/alternates` names the cache clone, so a prompt-injected
  agent could `git update-ref` review refs there: principle 2 rests on the
  reviewer's harness and the prompt, not on code, until a stricter leash.
  The user configured their harness; the prompt asks the agent to keep out
  of carbonless's data (a request, not a protection); a sandbox is planned
  (todo).
- **Setting the agent is running a command.** `PUT /api/config/agent` and
  its Check run any command as the server's user, for whoever holds the
  access key (on a loopback bind with no key, any local process).
- **One agent per review per machine.** Another server with the review
  open shows `elsewhere` and leaves the answering to the holder.
- **Agent threads are traced like comments (owner, 2026-11-09).** One
  asked on an earlier head is placed in the viewed patch set or head by
  the same tracer as review threads (`GET /agent/placements`,
  `placeAgentThreads`): on its traced line when it survives, else under
  its file with its fate sentence and the "Original Reviewed Change" box;
  resolved ones after the rest, muted, counted nowhere. It keeps its agent
  bubble and card, and never counts as a GitHub thread; otherwise it shows
  as a review thread does (owner, 2026-11-10): a rewritten line's "changed
  since" chip and old lines, an unplaced one in the review threads' own
  unplaced row (fate, "near N", Original Reviewed Change, the quiet
  resolved line). While the placements load, one asked on another head
  waits: its file's agent bubble and the tree spin, as for comments (never
  outdated first); an answer for another snapshot is asked once more. If
  they fail, the failure shows with a Retry and those threads as
  unknown-fate rows, as review threads. Comment and Ask agent never wait
  on GitHub's threads. One the tracer puts outside the comparison, or on
  a path the diff doesn't have (a file renamed since, still tracing or
  failed), is listed after the files in its own "Not in this comparison"
  group as its agent card (with its fate when known): never gone. An
  earlier patch set shows only those asked before the next one started,
  as review threads, except those asked on its own commit (asked there). Placements are for the viewed snapshot (a moved base
  asks again), retried on failure, computed and never stored: no drag, no
  storage change. Bubbles count unresolved agent threads only.
- **A question never waits on the agent to be sent.** Ask agent writes
  the thread at once; it waits (yellow) until an agent answers, whether
  none is set up, it is starting, busy, crashed or elsewhere.

- **Resolving is always a human action; the agent may only suggest it
  (owner, 2026-11-11: "Resolving a thread is ALWAYS a human action. The
  agent could suggest resolving, but never do it for us").** A GitHub
  thread's agent conversation (the thread agent) never resolves,
  unresolves, replies to or writes to its thread: no route takes such a
  write from an `ai` event or a runner action, and the parser drops an
  `agent-thread-seen` or `agent-thread-resolved` by `ai`. The agent
  suggests with a final `[suggest-resolve]` line, stripped and stored as
  data (`suggests: "resolve"`), and only for a fix in the patch set the
  reviewer is viewing (a fix found only in a later push is said plainly,
  "fixed later, in PS m", and never suggests). The suggestion shows, inside the reply,
  "Resolve By Agent Suggestion" and rings Resolve in `ok`; only the
  reviewer's press resolves, through the same GitHub write as Resolve. A
  thread conversation has no resolved state of its own: it folds and
  reopens with its GitHub thread, whoever resolves it, on GitHub too.
