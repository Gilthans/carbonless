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
`CRB_TRACE_DIR=<dir> crb serve` measures these on a real server: the page's
own spans (`browser.ui.header`, `browser.ui.threads_code`, Home's
`browser.ui.repo_done`, ...) with the server's requests under them
(`docs/test-profiling.md`, "Browser spans").
The skeletons and spinners follow "Loading never looks empty" below.

Fewer GitHub calls never at the cost of the first paint (the owner,
2026-11-13: "If you can merge queries in a way that keeps the faster
first-load that's fine"). Only reads the first paint waits for together
share a query (the overview's one query: the PR, its description, comments,
reviews and checks, `overviewQuery` in `src/server/gh.ts`). The threads and
the timeline stay their own calls: GitHub answers a merged query about as
slowly as the sum of its heavy parts (threads and timeline together: 1.4 s
more on a real PR; the threads' first and last pages together: 0.24 s
more), so merging them would make the thread list later. The gh login is kept
per server for 10 minutes (`src/server/viewerCache.ts`), and the page's
first head check answers from the open's read when it is under 10 s old
(`HEAD_REUSE_MS`).
Commits the threads sit on that the clone lacks (a force-push dropped them)
come in one `git fetch` for the whole read, not one per commit (CAR-289: five
such commits took 10.7 s one by one on a real PR).

A repo's first open waits on crb's clone of it (`gh repo clone --bare`: 27 s
of a 29 s open on a large repo), which no later open pays. The owner,
2026-11-24: "If the backend is cloning the repo, UI should show a message
[...] so the user knows this is irregular." While the server clones a repo
for the first time (`isCloning`, `src/server/clone.ts`: from the clone's
start to its end, never while an existing clone only fetches), every open
waiting on that repo says "Cloning <owner/repo> for the first time, this
might take a while": under the opening page's spinner (`/pr/...`, where
Home's open box, its rows and a bare number all go), and once on `crb
<pr>`'s stderr. Both poll `GET /api/clones/<owner>/<repo>` while their open
is pending (the page every second, the CLI every half second): the answer
is the repo's, so an open that joined another's, or waits on another
open's clone, says it too, and the open's own request stays one JSON
answer. A clone shorter than a poll goes unsaid. The review page
(`/r/<id>`) never waits on a clone: a review lives in its repo's clone, so
a reopen finds one there.

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
  A thread's agent panel, before the agent threads are first read,
  shows a spinner in place of the messages; a failed read with nothing in
  hand shows "Agent messages couldn't load" with Retry, kept while it reads
  again (a spinner in Retry's slot, never swapped for a full spinner by a
  refetch; the thread's red agent handle likewise stays, a spinner in its
  icon's place); Send to agent waits until the read answers (a conversation may
  exist unseen); an empty conversation only once the answer has none for
  the thread (CAR-124).
- **In place, never moving the page.** A spinner appears in place:
  showing or hiding it never moves anything (owner, 2026-11-02: "Make sure
  spinners appear somewhere static so the UI doesn't jitter"). It takes a
  slot kept whether or not it spins, replaces something of its size, or is
  laid over; tested by comparing bounding boxes before, while and after.
- **A slow wait says what it waits on (CAR-296).** The owner, 2026-11-24:
  "when possible, I'd like the loading to say what it's doing. So that I
  can know what's blocking me if something is slow". Once a load has been
  pending 1.5 s, one short muted line beside its spinner says the step its
  requests are on, with the seconds spent on it: "GitHub: pr view · 4s",
  "git fetch · 12s", "Fetching dropped commits", "GitHub: PR details 3 of
  13". A fast load looks as before: the page asks nothing until then. The
  line sits in a kept slot or is laid over the skeleton (nothing moves),
  in an `aria-live="polite"` region outside the `aria-busy` one; only the
  label is read out (the seconds are `aria-hidden`), and many panes of one
  wait have one live region. A line whose requests are gone for two asks
  in a row clears, though the load is still pending: a step that ended
  never stays. Where: the opening page (under its spinner; the first
  clone keeps its own wording), the overview's frames (over the first
  one), a thread's code still being built (over its frame's foot), and
  Home's repo chips (in the spinner's tooltip and accessible name, every
  repo in the same asks, 16 requests an ask: a chip has no room for a line; the spinner's tap
  target is 40px around it, so a tap opens the tooltip). `crb <pr>`
  prints each new step on stderr once an open has taken 2 s.
  How: every API request of the page (`src/web/loadingStep.ts`) and of
  `crb <pr>` carries an id (`x-crb-req`); the server keeps each tagged
  request's steps while it runs (`src/server/activity.ts`: every gh and
  git call, and named phases); `GET /api/activity?req=<id>,…` (at most 16,
  checked) answers each one's innermost step and never waits. A request
  waiting on work another started (an open, an overview read, a commit
  batch, a Home repo read, the repo lock) shows that work's step; work in
  parts side by side (an overview read's overview, summaries, texts, code
  and timeline; the lock's work beside its holder's other calls) keeps
  each part apart, so a wait shows a part it waits on. A wait whose work
  shows nothing reads "Working…", never another step. The
  labels are crb's words, mapped from the span names
  ([test-profiling.md](test-profiling.md), "Loading steps"): no paths,
  OIDs, branches or logins.
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

## Interdiffs are first-class

Reviewing what changed since an earlier patch set is as natural as
reviewing the whole change (principle 9; owner, 2026-11-22: "I want
interdiff and basediff comparisons to have feature parity as much as
possible"). A feature built for the full diff works in the since view
in the same change, or the since view says why not where the feature
would be; a full-diff-only feature is a gap with a ticket. Numbers the since
view shows on its old side are the compared patch set's: anything stored
or sent (a move, a comment, a link) goes through the full diff's lines,
never the interdiff's own numbers (thread moves: `moveEnd`,
`src/web/files/threadMove.tsx`). Whether a line takes a GitHub comment
is GitHub's diff's call too, never the interdiff's: a line the since view
shows as changed that reads as the base (a later patch set put it back)
isn't in GitHub's diff, so Comment, the agent's Comment on GitHub and a
suggested comment are off there ("Same as the base: GitHub can't take a
comment here"), and the server refuses it before calling GitHub
(`DiffLine.offGithub`, CAR-293). A GitHub refusal of lines that check
out says the PR moved on, with refresh.

## Re-review never hides a change

The since view, the "needs eyes" filter, carried marks, thread placement
and the verdict's since line organise what changed; none of them removes
anything. Every unreviewed cluster stays countable and in the full diff,
one drag of the comparison base away; a reviewed cluster the author
removed shows as `gone`, a file-level one (a mode, a binary file, a
submodule pointer or a rename reverted since) too, with its label and a box of its
own (CAR-297); a thread that can't be placed is listed under its
file or under "Not in this comparison" until it is resolved; a failure
says so where the answer would be. "Nothing to read" and "nothing to
re-read" show only when the engine's answer says so: an identical diff
with no reworked, new or gone cluster. Approving again on an identical
diff posts a review only on the reviewer's press.

A carried thread sits where it is placed now, but shows the code it was
written on (owner, 2026-11-14): a rewritten line's card has its own
patch set's lines in the "Original Reviewed Change" box, never the lines
it sits on now (those are the diff's own row); while that code loads, its
frame.

## A carried thread follows its statement, or says it can't

When the lines a thread was written on were replaced since (a hunk of
the trace's diff removes them and adds others), the thread goes to the
replacing line that resembles it: the side-by-side view's similarity
pairing (`src/shared/linePairing.ts`, whitespace not counted, so a
re-indented line is the same line) of the hunk's removed and added lines,
then of the hunk with its neighbours across a few lines that git cut it
at (a `}`, a blank line, one other line, never a line opening a block such
as a function header). A line the pairing leaves alone still goes to the
replacing line it most resembles between its neighbours' partners, when
that is close (two lines merged into one). It shows as "changed since the
review". Nothing replacing it resembles it: it is listed under its file as
`deleted`, with the nearest line above, never put on whatever line took
its place. When it can't be told, it is `rewritten`, also under its file:
a pairing too large, a text that can't be read, a line with no word (a
`}`, a blank line: its likeness says nothing), or two lines past its own
hunk as like it as each other. A range maps to the span its surviving
lines landed on. Owner, 2026-11-18 (CAR-95): reuse the side-by-side
similarity; measured on a real review's threads with `pnpm score-carry`
(`docs/thread-carry-corpus.md`).

## A thread with nothing to trace from sits on GitHub's line

Thread placement traces each thread from the commit it was written on
(owner, 2026-11-11, CAR-116). When there is nothing of its own to trace
from (GitHub gave no `originalCommit`, the commit can't be fetched, or it
shares no history with the base), it is traced instead from where GitHub
puts it now: its current line on the PR's head GitHub gave in the same
answer (never a head learned later), new side only (one line: GitHub's
current start line isn't kept; an old-side line is numbered against
GitHub's merge base, which can differ from ours, so it is `untraced`).
Only that same text places it, with no chip, as GitHub would show it;
GitHub's line rewritten or gone in the viewed snapshot, or its file out
of the comparison, is `untraced` (never "changed since" or "deleted since
the review": no history was followed). With no line from GitHub either,
it is listed under its file as `outdated` when GitHub says so, else
`untraced`. `rewritten` is only ever a real trace's answer. A placement
from GitHub's line carries `source: "github"` in `GET /placements`.

A review thread on an old-side line is checked against GitHub's
`diff_hunk` (owner, 2026-11-23, CAR-8: "do both"): it is traced from the
old side whose text the hunk shows (the merge base then or now, or the
hunk's own run of lines found once in one of them), and when none holds
it, it is unplaced as `base unknown` under its file, never placed on its
line number. A run found elsewhere moves the line only when it tells
enough (3 rows or more, 2 of them not blank or punctuation alone). A
hunk that couldn't be read (even read again) is `couldn't check`, never
"no hunk". An empty hunk is no evidence either way: the base as it stood
at the comment's time is traced from (unknown after a retarget), with an
`unchecked` mark when that isn't today's merge base; when it can't be
told, today's merge base, as before. While its hunk is on its way the
thread is `pending`: a spinner under its file, on no line. A reviewer's
move wins over all of it.

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
  on its own, nothing is written as a side effect of review progress, and
  no AI-written text is posted without explicit user approval of the exact
  content (the owner's wording, 2026-11-16). Resolving never changes review
  progress. The
  one exception is Comment over the viewer's own standing approval or
  request for changes: that one press makes two writes, the comment and
  then the dismissal of that review, since that is what Comment means
  (below). Its tooltip says so before the press.
- **AI-suggested comments (CAR-83).** The reviewer's agent may suggest a
  review comment as a ```` ```comment ```` block in its answer; crb shows it
  as an editable box with **Reply** when it posts as a reply to a GitHub
  thread, else **Add review comment**. Only the reviewer's press
  posts it, exactly the box's text (their edits included), as the reviewer,
  where the conversation sits: a new thread on its lines or file at the
  snapshot's head (through the conversation's placement there: a changed
  line keeps its lines, not its columns; lines gone leave the button off,
  saying why), or a reply to its GitHub thread. Nothing marks it as the
  agent's: once posted it is the reviewer's comment. It goes through the
  same REST paths as the reviewer's own (escaped tags, the marker), always
  as a retry under the block's own client id
  (`ag.<conversation>.<message>.<block>`), so GitHub is checked first and
  it never posts twice, across reloads and devices. Once a press is out, its
  text is fixed (the box reads only) until GitHub answers: a retry looks for
  exactly what may have landed. Posted shows only after GitHub's answer, and
  is kept in the agent ref (`agent-comment-posted`); until that record is
  written, the browser keeps the post, shows it Posted and writes the record
  on a later load.
  The agent has no tool to post; a refusal is never retried by itself.
  **A posted comment ties the conversation to its thread** (the owner,
  2026-11-22: "I'd like it to be tied together, instead of just another
  github thread over the same line"; CAR-236). Once a block from a
  conversation on lines or a file starts a new GitHub thread, the
  conversation is that thread's: it shows in the thread's agent panel (its
  card opens with it on the press), as one asked with Ask agent there
  would, never as a second thread on the line; its later blocks reply to
  that thread. Two threads started before this: the first posted is the
  one. The thread deleted on GitHub, it shows on its own lines again; while
  GitHub's threads can't be read it shows there too, its blocks and its
  reply box off (it may have a thread: never a second one). A view that
  doesn't list its thread (an earlier patch set) shows it where it was
  asked, its blocks replying to its thread. Until the first post's record
  is in, this browser knows it: another block of the conversation waits
  while one is on its way or in doubt, and replies to the thread one
  started once GitHub took it (its button says Add review comment until
  then, Reply from then on: its header and button always agree).
  **The agent is told where its blocks post** (the owner, 2026-11-22: "a
  suggestion should post as a reply if the agent thread is tied to a
  conversation. Make sure the MCP tells the agent about that, and make sure
  the texts align with that"; CAR-237). Each question's preamble says, as of
  that read, whether a block in this conversation posts as a reply to its
  GitHub thread (write it as a reply to that thread, without restating
  it) or as a new review comment on its lines or file:
  a conversation that joined a thread since its last question replies, one
  whose thread was deleted is back to new comments. While GitHub can't be
  read, a thread conversation or a joined one is still told reply (and a
  joined one's box, off, still shows Reply on a thread). The
  whole-review conversation is told nothing (it posts none).
- **Write / Preview on every box that posts to GitHub (CAR-202).** The
  reply, new-thread, edit and verdict-message boxes and the agent's
  suggested comment each have a pencil/eye toggle (Ctrl/Cmd+Shift+P).
  Preview renders the text the way crb shows a posted comment
  (`escapeTags`, `marked`, then `sanitizeGithubHtml`: `CommentPreview.tsx`),
  in the textarea's place and at least its height. The agent's box opens in
  Preview (markdown the reviewer didn't write: read it first); the
  reviewer's own boxes open in Write. Sending works from either mode and
  posts the same text. No toggle on an empty box or in Ask agent (its text
  never reaches GitHub). The mode isn't saved.
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
  (else 409 `stale`: refresh). A `RIGHT` line outside the snapshot's
  diff (its hunks' lines, within the file) is refused before gh, 400
  `invalid` "Same as the base: GitHub can't take a comment here"
  (CAR-293), but only while GitHub's merge base is the snapshot's
  (`commentLeft`; else GitHub decides). GitHub's 422 "could not be
  resolved" on lines that check passed means its diff moved on since:
  409 `stale`, refresh. Any other line or file GitHub's diff doesn't have
  (that 422 on `LEFT` lines, a file, or unchecked lines) is 404 `gone`;
  a pending review refuses
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

## Whitespace-only runs are clusters; "Ignore whitespace" leaves them out of progress

A whitespace-only change is its own cluster in every view (CAR-156, owner
2026-11-15: "treating whitespace-only change as a separate cluster in all
views sounds like a good idea regardless. Clusters are too big
currently"). The server cuts each git hunk at its whitespace-only runs
(git's `-w`: lines equal once every ASCII whitespace character is
removed). Which lines are whitespace-only is decided once per display
hunk (git hunks up to 6 unchanged lines apart, with 3 lines of context),
by the same matching the view's `~` rows read (`matchDisplayHunk`,
`hunkCuts`, `cutByLines`, `src/shared/whitespace.ts`; CAR-218): the
heaviest order-preserving matching of the display hunk's old side to its
new side, unchanged lines kept matched. A changed line it matched is
whitespace-only; each maximal run of them in a git hunk is a
whitespace-only cluster (`Cluster.whitespaceOnly`), the lines between runs
change clusters. So a cluster is whitespace-only exactly where the view
draws `~` rows. Two changed lines, two re-indented ones and two more
changed lines are three clusters, with the switch on or off. A single
whitespace-only line between two changes counts; a pure addition or
deletion with no twin anywhere in the display hunk never does, an added
blank line included (as `git diff -w` shows it); a blank line paired with
one of only whitespace does. A line moved across others (an unchanged
line, or out of order across a change) stays a change. A block that only
moved one level deeper is whitespace-only all through, even where git cuts
it into several hunks around a line that happens to equal one at the new
depth (that line stays unchanged); a whitespace-only cluster may then have
lines on one side only, its twins being in another git hunk or unchanged
lines. A display hunk of more than 250,000 old × new lines (`SPLIT_CELLS`,
context included), unless both sides are the same keys line for line, is
matched one git hunk at a time instead, rows and clusters alike. The
pieces cover every changed line of the hunk exactly once (checked for any
input, principle 2). Marks made on a hunk before it split carry onto its
pieces (`docs/review-data-storage.md`, "Split carries"); marks on a
cluster the CAR-218 cut re-keyed read unreviewed (no carry, owner
2026-11-22).

Settings' "Ignore whitespace" is the reviewer's own choice of what progress
counts. With it on, whitespace-only clusters are left out of every count
on the Files page (the bar, the tree's file and folder rows, each file's
header and its finished state, the move-on; a file of nothing else counts
nowhere on the bar but keeps its own row and header counts), whatever
their marks. They still show, collapsed to one quiet `~` row, and can
still be ticked and crossed off: the mark is stored as usual and counts
again when the switch is off, which counts everything exactly as before.
While any is left out, the bar shows a `~` whose name and tooltip say how
many ("3 whitespace-only clusters not counted"); so does each file
header that left one out (a file without any never shows it; a header
that reads done because of one always does). The tree's rows count the
same way but show no `~`: the header's is enough (owner 2026-11-18).
This is no AI decision: nothing is marked reviewed, and turning the
switch off shows what is still unreviewed. The Overview's progress, the
verdict (its "You reviewed" line and its meter of what changed since your
verdict) and the since view (its bar, each file's header, chips and dot,
"Nothing to read since", the move-on; `SinceUnit.whitespaceOnly`)
count the same way, with the same `~` (CAR-184). The since view judges
whitespace-only on its own diff, the interdiff (CAR-218): a piece is
whitespace-only when every line is a `~` row there and every line was
read (reviewed or crossed off) at the earlier patch set, or is a base
line that patch set left alone (nothing to read there; the full diff
leaves the same re-indent out: owner 2026-11-23, "Interdiff should
behave similarly to a basediff compare"), or is whitespace only against
the base too (its new side is in a whitespace-only cluster of the viewed
snapshot: the full diff leaves it out, read or not; CAR-319). A line
nobody read there that is a real change against the base (added, or
edited, by that patch set) and that this patch set only re-indented is
still unread. The rest of a cluster
that no piece shows keeps its cluster's flag. A piece collapses by its
own flag, not its cluster's: a real edit since, in a cluster
whitespace-only against the base, stays open. A file is
nothing else when all its since units are whitespace-only (not its
snapshot clusters), and its header then counts them all, with no `~`,
while the bar, its "to read" and the move-on leave it out (the full
diff's bar and move-on do too). The `~` counts a cluster's units as
one and each unit without a cluster on its own. Home doesn't: it never
reads a review's view settings (owner 2026-11-16: "Home shouldn't probe
for specific review settings"), so it counts every cluster.

The view still pairs whitespace-equal lines as quiet `~` rows
(`src/web/files/whitespace.ts`), over the whole display hunk, context
included: a line's twin may be a context line or sit in another cluster
(a one-sided `~` row). It never changes clusters, their keys or the +/−
counts. A whitespace-only cluster (the server's flag) collapses to one
row, keeps its checkbox and cross-off, and stays open while a thread or a
thread link's landing sits on one of its lines; a change cluster whose
lines' twins sit across a context line or in another hunk shows its `~`
rows open, since progress counts it. What the rows guarantee, pure and checked for any
input (principle 2): every line of the hunk is in the rows exactly once,
and dropping the lines shown as added or removed from the two sides leaves
them whitespace-equal, so a block moved across an unchanged line, or a line
that crossed one, is never shown as whitespace-only. It may show more as
changed than `git diff -w` does, never less.

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

A repo's first read shows its rows as they land (owner, 2026-11-24: "as
soon as anything is loaded we show it"): its PRs' facts are read newest
`updatedAt` first, open and closed together, in batches (10, then 20),
and each batch shows once those before it are in, so later rows are older
and land below the ones shown. Until the last batch the repo's chip spins
and Home counts nothing (the same spinners, placeholders and no "none" as
above). A read that fails mid-way keeps the rows so far and says why; the
spinner stops; a retry spins again (never the last read's alert) as its
rows land. A refresh of a repo read before keeps its rows whole until it
is done (`RepoHome.complete`, `progress`; the page's next ask sends
`seen` and the server answers at the next batch). A page that already
shows a whole list (the server restarted, or forgot the repo) asks with
`whole` and gets only a whole answer: a list never shrinks to a batch;
if that read fails, the list stays with the failure on it.

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
- **The agent's env never reaches the page (CAR-59).** It holds tokens.
  `GET /api/config/agent` (and the PUT's answer) gives each env name with
  a mask (`AGENT_ENV_MASK`), never its value. A Save or Check carrying the
  mask, or no `env` at all, keeps the stored value; a mask with nothing
  stored under its name is refused (400), so the mask is never run or
  written to `config.json`. Only for the stored command: another command
  starts with no env, and a mask for it is refused. The agent's own text
  (its stderr tail and JSON-RPC errors, in Check, the status and a failed
  turn's stored stop) has each env value of 8 or more characters masked
  too, except absolute paths (not secrets, and a wrong one is what a
  failed Check must show); its log file keeps them. Env is edited in
  `config.json` by hand.
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
  since" chip and the code it was asked on, an unplaced one in the review
  threads' own unplaced row (fate, "near N", Original Reviewed Change, the
  quiet resolved line). While the placements load, one asked on another head
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
  asks again), retried on failure, computed and never stored; the
  reviewer moves one as a review thread (next rule). Bubbles count
  unresolved agent threads only.
- **A move is the reviewer's view (owner, 2026-11-18, CAR-139).** Any traced
  thread on lines, a GitHub review thread or an agent thread, can be put on
  other lines of the target viewed (the latest patch set or a head; never
  an earlier patch set), in the full diff or the since view alike: drag its handle onto a line
  of its file, or press the handle for move mode (a bar at the top, "Pick a
  line", the line picker, "Place here": a range, any file of the
  comparison). One mechanism for both kinds: `thread-moved` in the
  reviewer's private agent threads ref, undone by `thread-move-undone`;
  old `thread-placed` events read as moves. The move is the thread's new
  truth: later snapshots trace from the moved lines; a move made on the
  viewed snapshot places it as chosen. It shows as a gray `moved` chip
  (pin) whose tooltip says where it was made ("Moved here by you on PS3",
  "Moved by you on PS2, followed here") and, for a GitHub thread, where
  GitHub shows it ("GitHub: line 88", "GitHub: outdated"), with a 40px
  Undo in Files changed; the Threads tab lists it at its moved place with
  a pin cue, the Overview shows the chip only. A move never writes to
  GitHub (a reply goes to the thread as ever, with nothing added), never
  starts a patch set, never touches coverage, counts or bubbles' totals,
  and never hides a thread: every thread keeps exactly one placement, and
  a move that can't be followed (its commits gone) shows the thread
  unplaced as `rewritten`, never the tracer's older guess. A thread opened
  on the viewed snapshot has no handle (no guess to correct), nor does a
  file thread or a conversation; no handle or chip until the placements
  answer. Sharing moves with other reviewers waits for sync. A move always
  stores the target's full-diff lines: in the since view a new or context
  row is the target's line, and a removed row its base line (CAR-217's
  `baseNo`, the same one a comment there posts with); a removed row that
  is no base line (only the earlier patch set had it) is no drop target and Place
  here is off on it, never stored under the interdiff's own number. A
  thread on a removed base line shows on that removed row in the since
  view when it shows one. When it shows none (the compared patch set had
  already deleted the line), the thread stays in the file's header and
  its card says why, never as a tracer fate: "deleted before PSn" (its
  tooltip adds when the file is unchanged since PSn), or "not in this
  comparison" when that can't be told (a removed row's base line isn't
  known, or the two diffs pair twin lines differently); a link opens the
  full diff on its line with its card open (CAR-255). Agent threads the
  same.
- **The agent opens conversations only while answering, and they answer
  nothing (spec 2026-11-15, CAR-80).** While it holds a question `next`
  handed it, the agent may call MCP `open` to put a conversation on the
  PR's code (a changed file, lines or a text range, at the head that
  question showed) or on an open GitHub review thread (continuing its
  conversation when it has one): the very object the reviewer's Ask agent
  makes, never posted to GitHub. Its message records the request it came
  from (`origin`) and shows a Re row pointing back; the request shows
  Started N. `open` writes only that agent-thread event: no reviewed
  state, no resolve (on a thread it may only suggest one, as `reply`
  does), no GitHub write (principle 2), and an origin message
  answers no question, so one waiting on that thread stays waiting
  (principle 8). It is refused with no question held, past the question's
  time limit, on code outside the PR or lines out of range, on a
  resolved, deleted or unknown thread or while GitHub can't be read, on
  the request's own thread, and past 25 from one request. A citation in
  the agent's reply (`crb:c/<id>`) links only a conversation of this
  review, labelled by crb, never with an href the agent wrote.
- **The agent reads the review as the reviewer sees it, and only reads
  (CAR-182).** crb's MCP `diff`, `file`, `progress` and `review` serve
  crb's clone and caches, never the reviewer's working copy, the same for
  a spawned and a joined agent. They write no review mark, agent thread
  or resolved state. One write can happen, the page's own: building a
  patch set's snapshot for a read may run the split carry the page runs
  when it opens that patch set (#carrySplits), which carries the
  reviewer's own marks on a whole hunk onto its pieces and never marks
  anything the reviewer didn't; the agent and the page then see the
  same pieces. `diff` gives the full diff of the review's head, of a
  patch set, or of the PR's head (`to: "head"`, the page's head dot),
  and the since view from a patch set (`"last"`: the newest before the
  compared head, the page's default; `"last"` to `"head"` is what the
  author pushed since the reviewer's last pass, or, with nothing pushed,
  an explicit `nothingPushed` and no files, never the last pass itself), with the page's own
  analysis (whitespace-only lines, paired lines with "Ignore whitespace"
  off; never a second computation) and file-level changes labelled as
  crb labels them (a mode, a binary file; in the since view, what changed
  since). An unchanged file in the since view can still hold lines to
  read (`progress` says). The since view lists every file the
  page's since view shows: one its engine says the author changed (never
  decided from the hunks' count), and one with lines left unreviewed at
  that patch set that nothing carries (CAR-216's "not reviewed in PSn"
  pieces), each file saying `changed` and those lines as
  `notReviewedThen`, so the agent never presents them as new code. crb
  detects no moved blocks yet, and `diff` says so rather than guess.
  Past its budget, the remaining files are named (`omitted`, `unread`,
  with no hunk count or analysis) without being read; a since view crb can't build, or a file it can't read, is
  an error, never an empty diff. `file` reads only commits `review`
  names (base, merge base, head, the PR's head, a patch set's head or
  merge base), paths checked (relative, no `..`, never an option),
  refuses a blob over 4 MiB before reading it, and decodes as the page
  does (UTF-8, else latin1). `review`'s threads each carry `atHead`, the
  page's placement on the review's head, or `unknown` with why (never
  absent); GitHub's line is kept beside it, never offered as where the
  thread is now.
- **A question never waits on the agent to be sent.** Ask agent writes
  the thread at once; it waits (yellow) until an agent answers, whether
  none is set up, it is starting, busy, crashed or elsewhere.
- **The reviewer approves every join.** A session that asks to join
  through crb's `/mcp` (`attach`) gets nothing from inside the review
  (threads, code, PR body) until the reviewer presses Approve in the bar
  on that review's pages; Deny, or no answer within 10 minutes, ends the
  request. The access key alone lets a session list reviews, never join
  one (spec 2026-11-10, `docs/faq.md` "Joining a review from a session").
  For an agent carbonless spawns, pressing Spawn is the approval: its
  join is approved before it asks, for that review and that process only
  (a secret in its session's MCP config), and never shows a bar (spec
  2026-11-13, spawned agent over MCP).
- **No agent starts in a review the reviewer didn't ask for one in.** A
  configured ACP agent runs in a review only while that review's spawn
  flag is set (`acp-on` in its agent dir, kept across restarts; local
  state, never `refs/crb`). Only the reviewer's Spawn (in the setup modal)
  sets it; nothing else does: not opening the review, a status poll, a new
  question, a config save or a crb restart. Detach clears it, stops the
  agent, removes its checkout and releases the review's claim (spec
  2026-11-12, agent setup modal).
- **One buddy per review, and the ACP buddy stays off once replaced.**
  Approving a join clears the spawn flag (before `joined.json` is
  written) and stops the ACP buddy. When the joined session leaves
  (detach, Disconnect, lost, replaced), nothing starts the ACP buddy again
  until the reviewer's Spawn. Questions wait (yellow) meanwhile, and a
  question handed to a session that never replied waits again.

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
  "fixed later, in PS m", and never suggests). A message the agent
  writes with MCP `open` on a GitHub thread (a new conversation, or one
  added to its conversation) may suggest it the same way, on the same rule
  (CAR-265); `open` on code refuses the marker, as code has nothing to
  resolve. An `open` message counts like an answer here: one that
  suggests stands, and one that doesn't withdraws a standing suggestion,
  so an older opinion never outlives a newer one (principle 2). On a
  review-conversation request the agent judges at the head `progress`
  gives (the comparison the reviewer asked in), never `review`'s newest
  head. The suggestion shows, inside the reply,
  "Resolve By Agent Suggestion" and rings Resolve in `ok`; only the
  reviewer's press resolves, through the same GitHub write as Resolve. A
  thread conversation has no resolved state of its own: it folds and
  reopens with its GitHub thread, whoever resolves it, on GitHub too.

## Release notes never gate an update

What's new shows the notes of every version between the running crb and
the one on offer (from the offered version's npm manifest, read by crb's
server). Update works while they load and after they fail: notes are
information, never a condition. A failure is a `warn` notice with its
reason and Retry, never an empty list; notes crb couldn't read are
counted ("1 note couldn't be read"), and an RC's merged changes that
have no note yet show as "N more changes, no notes yet", never hidden.
Note text is plain text from the registry: rendered as React text, links
built by crb from validated PR numbers and versions only.
