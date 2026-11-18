# Thread moves: putting a thread back on the line it is about

Status: revised 2026-11-18 after the owner's decisions (CAR-139). Spec
only: no product code in this round. First draft 2026-11-12 (agent
threads only); this revision gives review threads and agent threads one
mechanism. Mockups (desktop and phone):
`docs/superpowers/specs/2026-11-18-thread-placement-mockups.html`.

## Intent

The owner, opening the ticket: "Yes, open these tickets and please get to
work on them." Earlier, on agent threads, they asked for them to behave
"exactly the same" as review threads; the drag handle was left out of that
round because "it needs a new kind of saved record in the git review data",
with a stop-and-ask before any storage change. Answering the first draft
(2026-11-18): "all as recommended, except 8 - let's implement this for
review threads as well. I'd like the two to use the same mechanism."

The tracer follows every thread (a GitHub review thread, or a question to
the reviewer's own agent) from the code it was written on into newer
snapshots. It guesses: on twin lines it can pick the wrong one, and it can
fail to place a thread at all. Principle 1 says every guess made on the
reviewer's behalf is editable, and the correction is kept as data. The
tracer is deterministic rather than AI, but the same rule applies. Today
the reviewer can only drag an unplaced review thread, for one patch set,
with no undo; agent threads can't be corrected at all.

## What exists today (studied 2026-11-18, origin/master fa521f5)

**Kinds of thread** (what this spec has to cover):

| Kind | Where it comes from | Placed by | Movable here |
|---|---|---|---|
| GitHub review thread on lines | GitHub's review threads, open or resolved, outdated or not; including ones the reviewer started in carbonless (they are posted straight to GitHub) | the tracer from its own commit, else from GitHub's current line (`source: "github"`) | yes |
| GitHub review thread on a file | same, `subject: "file"` | its file's lead | no (a path, no line) |
| Agent thread on lines | Ask agent on a span, or the agent's MCP `open` on code | the tracer (`placeAgentThreads`) | yes |
| Agent thread on a file | Ask agent on a file, or `open` on a file | its file's lead | no |
| Thread conversation | an agent conversation on a GitHub thread (`thread` anchor) | goes where its GitHub thread goes | no: it follows its thread, moved or not |
| Review conversation | the whole-review agent drawer (`review` anchor) | nowhere: no code | no |

There is no local review thread today: a comment written in carbonless is
posted to GitHub at once and comes back as a GitHub thread; an unposted
draft (`src/web/threads/drafts.ts`) is not a thread and has its own way of
following the code (`draftMove.ts`). The record below names a thread by
`source` and id, so a future source ("GitHub is one comment source among
several") adds a `source` value and nothing else.

**Placement today:**

- **Review threads**: `GET /placements` → `Session.#placedFor` →
  `ThreadPlacer.place`, the tracer (`placeThread`,
  `src/shared/rereview/placement.ts`) with the reviewer's `thread-placed`
  events (progress ref, per patch set) as `stored` placements. The page
  offers a `DragHandle` (`src/web/files/ThreadFate.tsx`: Grabber, 40×40,
  pointer capture) only on **unplaced** rows, only on the latest patch set
  (`placeOn`), drag only, one line, no undo, no tap or keyboard path,
  written by `POST /threads/:id/placement` (`Session.placeThread`, checked
  with `validAnchor`). The placement holds for its patch set only: the next
  patch set traces from the comment's own line again.
- **Agent threads**: their events live in
  `refs/crb/reviews/<review>/reviewers/<reviewer>/agent/threads`
  (`src/server/agent/store.ts`), private and never pushed. Placement is
  computed on every ask and never stored: `GET /agent/placements` →
  `placeAgentThreads` (`src/server/rereview/threads.ts`), the same tracer
  with no stored placement. One asked on the viewed head isn't traced.
- **The page** shows both alike: on the line; `changed since` with the old
  lines; unplaced under the file (fate, `near N`, Original Reviewed Change);
  or under "Not in this comparison". The Threads tab (CAR-183) lists each
  thread at its shown place (`src/web/files/threadRows.ts`); the Overview's
  cards show the placement chips of the session's snapshot.

## Goals

1. The reviewer can move any traced thread, review or agent, to other
   lines of the viewed snapshot: by drag with a mouse, and by a non-drag
   path (tap, keyboard) that works on a phone.
2. One record, one fold, one UI for both kinds: the same events, the same
   rule for which line a snapshot uses, the same handle, move mode, `moved`
   chip and Undo.
3. A move is kept as data in carbonless's git review data, visibly the
   reviewer's, undoable, and the thread's new truth: later snapshots trace
   from the moved lines.
4. Nothing a move does can hide a thread, touch coverage or counts, or
   write to GitHub (principle 2): a bad stored move leaves the thread
   unplaced with its fate, never gone.
5. The old `thread-placed` events keep working, read as moves.
6. Phones: 40px targets, no horizontal page scroll at 360px, no reliance on
   drag.

## Non-goals

- Moving a thread on GitHub. GitHub's API can't move a review thread, and a
  move is the reviewer's own view: carbonless never writes one to GitHub.
- Moving file threads, thread conversations, the review conversation or
  drafts (table above).
- The agent placing or suggesting placements (decision 9: later, as a
  suggestion only).
- Sharing moves with other reviewers (see "Where it lives").

## The record

### Where it lives: the reviewer's private ref

Every move, of an agent thread or a review thread, goes in the reviewer's
**agent threads ref** (`reviewers/<reviewer>/agent/threads`), which is
never pushed (decision 1, applied to both kinds).

- **A move is the reviewer's view.** Where a GitHub thread sits is
  GitHub's fact, shared with everyone; where the reviewer reads it is
  theirs. A private record matches that: other readers keep GitHub's
  line, and the record never claims otherwise.
- **Privacy.** A move of an agent thread names a private thread; its id in
  a pushed ref would tell other readers that private threads exist and how
  many (GitDB 20). Keeping both kinds in one place means no move needs a
  "which ref?" rule.
- **One read per ask.** The store that folds the agent threads folds every
  move in the same `git log`, cached by tip OID (GitDB 17).
- **Same writer.** Written only by this server on the reviewer's behalf
  (GitDB 3); each review stays isolated (GitDB 16).

**Departure, stated (against `docs/gitdb-design-principles.md`):** today a
review thread's `thread-placed` lives in the progress ref, which will be
pushed once sync exists and was to be "shared through `meta` only when it
was placed or moved by hand" (owner, 2026-11-07). New moves of review
threads go to the private ref instead:

- GitDB 3 ("split refs by writer, not by kind of data") is satisfied
  either way: one writer, the server for the reviewer. Its "reconsider
  when" clause (data most readers never need) is why the agent data has its
  own ref, and the moves follow it: no other reader needs the reviewer's
  view of where a thread sits, and none can use an agent thread's.
- GitDB 20 (assume everything pushed is public) favours the private ref
  for agent-thread moves; for review-thread moves it is neutral.
- What is given up: the 2026-11-07 plan to share hand placements with
  other reviewers once sync exists. Sharing wasn't built (sync doesn't
  exist), so nothing works differently today; if sharing is wanted, it
  becomes a publish step from this record when sync is built (Question 1).
- The ref keeps its name, `agent/threads`, though it now holds moves of
  review threads too: renaming would move every reviewer's existing
  agent threads for no reader's benefit (call C1).
- Reviews without an agent (`--as-of`, `--viewer`) still write moves of
  review threads to this ref: the server opens the ref's store for the
  session whether or not an agent host exists.

No reason was found that review-thread moves can't live there: placement
already reads only the reviewer's own refs, and `GET /placements` adds one
cached read of this ref (measured below).

### Events

| Type | By | Payload |
|---|---|---|
| `thread-moved` | human | `thread`: `{source, id}`, `source` `agent` (`id` the agent thread's lowercase ULID) or `github` (`id` GitHub's thread node id, 1 to 200 characters); `on`: the snapshot it was moved in, `{base, head}` (OIDs) plus `patchset` (a number) when that snapshot is one of the reviewer's patch sets; `anchor`: `{path, startSide, startLine, side, line}` in that snapshot; `engine` (`TRACER_VERSION`) |
| `thread-move-undone` | human | `thread` (as above); `move` (the id of the move it takes back: a `thread-moved`, or a legacy `thread-placed`) |

Example (one commit, as `git log` shows it):

```
crb: moved a thread to src/db/pool.ts:52 on PS3

{"v":1,"id":"01m7…","type":"thread-moved","ts":1795013961606,"by":"human","actor":"dan",
 "thread":{"source":"github","id":"PRRT_kwDO…"},
 "on":{"base":"<oid>","head":"<oid>","patchset":3},
 "anchor":{"path":"src/db/pool.ts","startSide":"RIGHT","startLine":52,"side":"RIGHT","line":52},"engine":1}
```

- `on.base` and `on.head` are filled in by the server from the session's
  snapshot of the target the page names (`{patchset}` or `{head}`), never
  taken from the client. They let a later trace start from exactly the
  snapshot the reviewer looked at. The snapshot id is
  `snapshotId(base, head)`, so it isn't stored.
- Columns are not stored: a move places whole lines.
- **Write rules**, enforced on write and on read (`validateForWrite`,
  `parseEvent`): both types `by: "human"` only (an agent never moves a
  thread; decision 9's suggestion would be its own type); `source` one of
  the two values (a reader skips an unknown one, so a future source never
  breaks an old reader); the anchor parses as `thread-placed`'s does
  (positive integers, sides `LEFT`/`RIGHT`, start not after end on one
  side); `on.base` and `on.head` are OIDs; `move` is a lowercase ULID. A
  reader drops what breaks them, and an old reader skips both types (GitDB
  8): it then shows the tracer's placement, which hides nothing, so no
  version bump.
- **Caps:** an anchor path at most 4 KiB; at most 200 moves per thread are
  folded (later ones are dropped and the thread shows the 200th's
  placement), so a stuck client can't grow the fold without bound.

### The old `thread-placed`: read as moves, never written again

Old `thread-placed` events in people's progress refs are **read as moves**
(not migrated): no write happens on read, so there is no second copy to
keep in step, and a ref an older crb still reads is never touched.

- When placing review threads, the session already reads the progress
  ref. Each `thread-placed` by `human` becomes a move:
  `{id, ts, thread: {source: "github", id: thread}, on: {base, head,
  patchset}, anchor, engine}`, with `base` and `head` from that patch
  set's `patchset-started` (pinned by `patchsets/<n>` and `-base`). One
  naming an unknown patch set is dropped. One `by: "ai"` is ignored:
  nothing ever wrote one, and decision 9 says the agent never moves a
  thread.
- Legacy and new moves are merged in `(ts, id)` order. An Undo of a legacy
  move is a `thread-move-undone` naming its id.
- What changes for those threads: a legacy placement now also anchors
  later patch sets (decision 2) instead of holding for its own patch set
  only. That is the owner's decision applied to old data; it hides nothing
  (each thread still shows exactly once) and the `moved` chip with Undo
  says where it came from.
- `thread-placed` stays in the parser (for reading) and leaves the
  writers: `recordPlacement`, `Session.placeThread`, `POST
  /threads/:id/placement`, `usePlaceThread` and the unplaced-only
  `DragHandle` go, replaced by the routes and handle below. An older crb
  that writes one after a downgrade is read the same way.

### Fold

In the agent store's fold (`(ts, id)` order, deduplicated by id, as now),
plus the legacy moves the session hands in:

- Each thread (keyed `source:id`) gets `moves`: its moves in order, minus
  those named by a `thread-move-undone` of the same thread. An undo naming
  another thread's move, or an unknown id, does nothing.
- An agent-thread move is dropped when its thread was never opened, or is
  a file thread, a thread conversation or the review conversation. A
  GitHub-thread move can't be checked against GitHub in the fold: it is
  kept, and used only for a thread GitHub lists (a move of a thread since
  deleted shows nowhere, as the thread doesn't).
- Two tabs: both writes are compare-and-swap appends (GitDB 13); the later
  `(ts, id)` wins. An undo names one move, so it can't take back a move it
  never saw.

### Which lines a snapshot uses

For a target snapshot `T` (the patch set or head being viewed), a thread's
**effective anchor** is:

1. **A move made on `T` itself** (same snapshot id; the last one): shown
   as placed there, exactly as chosen, once it passes `validAnchor`
   against `T`. Not traced.
2. Else **the last move visible at `T`**, traced from its own snapshot
   (`on.base`, `on.head`) into `T` by the same tracer, with the same
   outcomes as any thread (placed, `changed since`, unplaced with a fate,
   outside). For an earlier patch set `n`, a move is visible when it was
   made before patch set `n+1` started (the rule that already says which
   threads an earlier patch set shows); for the latest patch set or a head,
   every move is.
3. Else **the thread's own anchor**, traced as today: an agent thread from
   where it was asked; a GitHub thread from its own commit, else from
   GitHub's current line (`source: "github"`).

A move that fails rule 1's check is skipped for rule 2 (it can't be placed
in its own snapshot, so nothing is traced from it either) and the next one
down is used: the thread is never dropped.

**What if the move's commits are gone** (a head with no patch set,
force-pushed away and pruned by a manual `git gc`: carbonless's clone has
`gc.auto=0`, so this needs a hand): the trace from it fails and the thread
shows unplaced with fate `rewritten`, the `moved` chip and its Undo. It
does **not** fall back to the tracer's older guess, which the reviewer
already rejected ("Flag uncertainty, never show something wrong as
certain"). A move on a patch set can't lose its commits: `patchsets/<n>`
and `-base` pin them (GitDB 4).

A GitHub thread traced from a move is traced from the move's snapshot: it
no longer needs GitHub's current line, so it is no longer
`source: "github"`.

**Where it is computed:** one pure module,
`src/shared/rereview/moves.ts` (`effectiveAnchor(moves, target,
visibleAt)`), used by both placement paths. `TraceableThread` gains an
optional `ends: {base, head}` that `ThreadPlacer.inputs` uses instead of
`code.endpoints` (rule 2; the thread's own diff for `reverted` is then
the move snapshot's), and rule 1 goes through `placeThread`'s existing
`stored` path. Inputs are keyed by OIDs as now, so a moved thread's
diffs are cached like any other. Both `GET /placements` and `GET
/agent/placements` answer, per thread, the placement plus `moved?: {id,
on: {patchset} | {head}, at}`: which move it stands on, for the chip and
Undo.

### Routes

- `POST /moves`, body `{thread: {source, id}, to: {patchset} | {head},
  anchor}`: writes a `thread-moved` and answers the move's id and the
  thread's placement.
- `DELETE /moves/:id`: writes a `thread-move-undone` for that move (the
  server finds its thread) and answers the thread's placement.

Checks: the thread exists for the reviewer (an agent thread in their
store; a GitHub thread in the session's thread list, with an id and not
deleted; 404 otherwise); it is movable (400 for a file thread, a thread
conversation or the review conversation); the target is the viewed
snapshot's latest patch set or a head that is no earlier patch set (an
earlier patch set is read-only: 409, `ReadOnlyPatchsetError`); the anchor
passes `validAnchor` against that snapshot (400,
`InvalidPlacementError`). An undo of an id that isn't a live move is a 409
that changes nothing. Neither route calls `gh`.

### Size (principle 3, GitDB 22)

Measured 2026-11-18 with a scratch extension of
`scripts/measure-agent-ref.ts` that appends raw move and undo commits
(git 2.53, on this shared machine at load ~15 to 23, so the times are
pessimistic; every move has its own random base and head OIDs, which
compress worse than real moves sharing a patch set's):

| Measure | Value |
|---|---|
| One `thread-moved` commit, GitHub thread | 574 B raw, 397 B deflated |
| One `thread-moved` commit, agent thread | 621 B raw, 416 B deflated |
| One `thread-move-undone` commit | 415 B raw, 308 B deflated |
| Today's heavy agent ref (50 threads × 4 messages of 2 KiB, 100 seen), packed | 153 to 163 KiB |
| Realistic: 2 agent + 5 GitHub threads moved once, 1 undone (8 commits) | +3 KiB packed |
| Heavy, agent only: 50 threads moved on 3 patch sets, every 6th undone (175 commits) | +43 KiB packed (200 KiB) |
| Heavy, mixed: 50 agent + 100 GitHub threads moved on 3 patch sets, every 6th undone (525 commits) | +122 KiB packed (282 KiB) |
| Cold `read()` of the mixed heavy ref, packed (median of 9) | CPU 17 ms + 20 ms git (84 ms wall under load) |

A realistic review moves a handful of threads: a few KiB. Even the mixed
heavy case (every one of 150 threads moved three times) stays inside the
agent ref's bounds (under 300 KiB packed, a cold fold under 200 ms). The
ref is never pushed, so nothing reaches the remote or anyone else's fetch;
everyday git never sees it (GitDB 14). Reading legacy `thread-placed`
costs nothing new: the progress ref is already read for placements. The
build adds moves to `scripts/measure-agent-ref.ts` (`--moves`), a size test
(one move commit under 1 KiB raw and 512 B deflated) and the table to
`docs/review-data-storage.md`.

### Push, fetch, conflicts between reviewers

None: the agent ref is never pushed or fetched, and each reviewer has
their own. If its sync is ever turned on (GitDB 20: the reviewer's
choice), the moves travel in the same ref and merge by union like every
other event; the fold's last-wins and named undos give every machine the
same answer. Two reviewers' moves of the same GitHub thread never meet:
each reads only their own ref.

## How it looks

Mockups: `2026-11-18-thread-placement-mockups.html` (desktop A to E, phone
F to I). A and C are a GitHub review thread, D an agent thread: the
controls are the same.

### The tracer's place and the reviewer's

- **The tracer's** placement looks as it does today: no chip when the line
  is the same, `changed since` (yellow) with the old lines, or the unplaced
  row with its fate.
- **The reviewer's**: a gray chip, pin icon, `moved` (the `opened-on`
  chip's style: a fact, not a state; never the agent's teal). Tooltip:
  "Moved here by you on PS3", or "Moved by you on PS2, followed here" when
  traced forward (rule 2); for a GitHub thread it adds where GitHub shows
  it: "· GitHub: line 88", or "· GitHub: outdated". Beside it, a 40px Undo
  icon button (undo arrow; tooltip and name "Undo move"). On a phone the
  chip and Undo wrap to the card header's second row with the other chips.
- When a moved thread is followed into a later snapshot and its line
  changed, both chips show: `moved` and `changed since` (the old lines being
  the ones it was moved to).
- The Original Reviewed Change box of an unplaced or changed moved thread
  shows the lines it was moved to, in the move's snapshot (decision 7). A
  GitHub thread's own code pane (the code the comment was written on, as on
  the Overview) is unchanged: that is the comment's history.
- The Threads tab lists a moved thread at its moved place, with a pin
  among the row's cues ("moved by you" in its name and tooltip). The
  Overview's cards show the `moved` chip; the handle and Undo live in Files
  changed only (call C4).

### A moved GitHub thread

- GitHub still shows the thread on its own line, to everyone; carbonless
  shows it where the reviewer moved it, with the `moved` chip whose tooltip
  names GitHub's line.
- The header's status keeps GitHub's words: Unresolved/Resolved, and
  "outdated" when GitHub says so. A move doesn't make a thread outdated or
  current; it only says where the reviewer reads it.
- Replying, resolving, editing and deleting work as on any GitHub thread
  and go to that GitHub thread. The composer is unchanged: no notice, no
  line reference added to the text (principle 6; the chip already says it
  is moved). Nothing about the move is ever sent.
- An agent conversation on that thread (thread conversation) goes with it.

### The handle

- Every **traced** line thread's card (on a line, `changed since`,
  unplaced, "Not in this comparison"), review or agent, gets a Grabber
  handle in its header, 40×40, `muted`, `ink` on hover, when the viewed
  target takes writes (the latest patch set or a head; none on an earlier
  patch set, which is read-only). A thread opened on the viewed snapshot
  gets none (decision 4; for a GitHub thread: one written on the viewed
  head sits where its author put it, so there is no guess to correct), nor
  does any kind the table marks unmovable. This replaces the unplaced-only
  `DragHandle`.
- One control, two ways (name: "Move thread"; tooltip: "Drag to a line, or
  press to pick one"):
  - **Drag** (pointer capture; a mouse, or a finger where it works): the
    card stays put, dimmed; a slim ghost (the author's avatar or the
    sparkle, first words) follows the pointer, and the line under it is
    outlined in `accent` (the existing `data-drop-line`). Release on a line
    places the thread there (one line, decision 5). Release elsewhere, or
    Escape, cancels. The diff scrolls when the pointer nears the viewport's
    top or bottom edge. Drop targets are the rows of the thread's file only
    (decision 6).
  - **Press** (click, tap, Enter or Space without a drag): **move mode**.

### Move mode (the non-drag path)

- A bar pushes in at the top of the page, under the find bar's slot,
  pinned while it shows (it pushes the page down, never covers the
  header's buttons): pin icon, "Pick a line", the thread's first words
  (truncated), and a 40px ✕ Cancel. The card being moved gets an `accent`
  outline.
- Lines are picked with the existing line picker: tap or click a line
  number (shift-click or drag down the numbers for a range), Up/Down
  between lines with the keyboard. Numbers in every file of the comparison
  are targets, so a thread can go to another file (decision 6).
- The selection bar offers one 40px pin button, "Place here", in place of
  its usual actions while move mode is on. It places the thread on the
  picked lines (decision 5) and leaves move mode. Escape, ✕ or navigating
  away leaves it with nothing written.
- After a place (either way), the page scrolls the card into view on its
  new line with the landing highlight (`mark-tint`, fading), and keyboard
  focus goes to its Undo.

### Writes

- Optimistic, as `usePlaceThread` is today, on whichever placements query
  holds the thread (`placements` for review threads, `agent/placements` for
  agent threads); rolled back on a refusal (400, 404, 409) with the refusal
  under the card in `bad` and a 40px Retry where it can be retried
  ("Saving review state" rules). Undo the same way.
- While the placements are loading, there's no handle: the card waits
  where it is, with the spinner rules as now (principle 8).
- A move never writes to GitHub, never starts a patch set (decision 3),
  never touches cluster states, progress, bubbles' totals or the
  unresolved count. A moved thread counts on the bubble of the line it is
  shown on, as any placed thread does.

### Interaction rules in short

| | Desktop | Phone |
|---|---|---|
| Handle | Grabber, card header, 40×40 | same, header's first row |
| Drag | yes, within the file | works where the browser allows; never needed |
| Tap / Enter | move mode | move mode |
| Pick | click a number, shift-click or drag numbers for a range, Up/Down | tap a number, drag numbers for a range |
| Place | "Place here" in the selection bar | same, 40px |
| Cancel | Escape, ✕ | ✕ |
| Undo | 40px icon beside the `moved` chip | same |

### When the chosen line later disappears

The move is the thread's anchor from then on, so the next push treats it as
it treats any thread (rule 2): the line rewritten → `changed since` with
the moved-to lines as the old ones; the line deleted → unplaced, with its
fate sentence, `near N` (the closest surviving line) and the Original box
holding the moved-to lines; the file gone → "Not in this comparison". The
`moved` chip and Undo stay in each case, and the handle offers another
move. Undo goes back one move: to the move before it, or to the tracer's
trace from the thread's own anchor.

## Principle checks

1. **Editable, kept as data:** the move is an event in git, undoable by
   another event, and becomes the anchor later traces learn from.
2. **No change missed:** threads aren't changes; moving one never marks,
   hides or counts anything, and coverage code never reads moves. Every
   thread still has exactly one placement whatever the moves (a property
   test), and a move that doesn't check out leaves the thread placed by the
   next move down, or unplaced with a fate, never gone. The routes never
   call `gh`.
3. **Git stays fast:** a few hundred bytes per move in a ref that is never
   pushed; nothing per review elsewhere; measured above.
4. **No server:** local git refs only.
5. **Mobile:** move mode needs no drag; every new control is 40px; the bar
   and chips wrap at 360px with no horizontal scroll.
6. **Icon-first:** grabber, pin, undo; the only words are "moved", "Pick a
   line" and "Place here", with tooltips and accessible names.
7. **Methodology:** a move records its snapshot's base and head, and the
   trace from it uses only diffs between commits, as the tracer always
   does. It goes in the matrix (below).
8. **Loading never looks empty:** no handle and no chip until the
   placements answer; the card's chip slot spins as now.

## Tests

- **Shared unit** (`src/shared/rereview/moves.test.ts`, new pure module):
  rules 1 to 3; an earlier patch set's visibility rule; a failed rule-1
  check skipping to the next move; legacy and new moves merged in `(ts,
  id)` order; an undo of a legacy move. A property test over random review
  and agent threads, moves (valid, out of range, of unknown threads, of
  unmovable kinds), undos and targets: every thread has exactly one
  placement, the set of ids in equals the set out, and the unresolved count
  is the same with and without the moves.
- **Server unit:** `parseEvent`/`validateForWrite` for both types (each
  write rule refused on write and dropped on read; `by: "ai"` dropped; an
  unknown `source` skipped; an unknown type skipped by an old reader); the
  fold (order, dedupe, an undo of another thread's move or an unknown id
  ignored, an agent move of a thread conversation, file thread or the
  review conversation dropped, the 200 cap); **legacy:** a progress ref
  with `thread-placed` events (human on PS2, ai on PS2, one on an unknown
  patch set) reads as one move on PS2, is followed into PS3, undone by a
  `thread-move-undone` naming its id, and no read writes anything; the
  routes (404 unknown thread, 400 file thread or thread conversation, 400
  anchor outside the file, 409 on an earlier patch set, 409 undo of a dead
  move; `on` filled in from the session, never from the body; no `gh`
  call: the fake gh's log is empty after a move and an undo); a GitHub
  thread moved, then traced from the move and no longer `source:
  "github"`; a move whose head is pruned shows `rewritten`, not the older
  trace; two tabs moving at once both land, last wins; an `--as-of` review
  (no agent host) moves a review thread.
- **Storage:** one move commit's size (bounds above); the measure script's
  new rows; a default clone and a fetch of the review's shared refs never
  carry the agent ref.
- **Web unit** (jsdom): the handle shows only on traced, movable threads
  and only where writes go, for review and agent cards alike; press opens
  move mode, Escape and ✕ leave it with no write; the `moved` chip's
  tooltip on the move's own snapshot, when followed, and with GitHub's line
  or "outdated"; a moved GitHub thread's reply goes to its thread id
  unchanged; Undo's optimistic update and its rollback on a 409; the
  Threads tab row at the moved line with its cue; every new control 40px
  and named.
- **e2e, desktop and phone** (`e2e/thread-move.spec.ts`, on the re-review
  fixture with three pushes): the tracer misplaces a GitHub thread and an
  agent thread (twin lines); the reviewer moves each (mouse drag on
  desktop; tap the handle, tap a number, Place here on phone; keyboard on
  desktop too), the chip shows, a reload keeps it, Undo brings back the
  tracer's place; at the next push each is followed from the moved line;
  the moved-to line deleted in the push after that → unplaced with fate and
  `near N`; a reply on the moved GitHub thread reaches the fake gh as a
  reply to that thread and nothing else is sent; a fixture whose progress
  ref holds a legacy `thread-placed` shows the thread moved, with Undo; no
  horizontal scroll at 360px with move mode open; `expectEveryUnitMarkable`
  unchanged. A held placements answer gates the "no handle while loading"
  state (`expectLoadingThen`).
- **Methodology matrix:** one assertion per permutation in
  `test/methodology-matrix.ts`: a review thread and an agent thread made on
  the opened stage, moved to `a.txt` line 2 at the opened stage, are
  followed from line 2 to the updated stage, with each update kind's
  expected outcome written in the matrix (for `base-absorbs`, line 2 is the
  base's by then, and the expectation says how that shows), and survive
  `gc --prune=now` when moved on a patch set.
- **Gallery:** a `case/thread-move` PR in the gallery repo where the
  tracer picks the wrong twin of a repeated line for a review thread, with
  a README row.
- **Docs in the same change:** `docs/review-data-storage.md` (the events,
  write rules, legacy reading, the size table; `thread-placed` marked read
  only; the "Deferred" item on sharing it updated per Question 1),
  `docs/product-rules.md` ("Agent threads are traced like comments": drop
  "no drag, no storage change"; a new rule "A move is the reviewer's view"
  with the rules above), `docs/design/README.md` (the handle, move mode,
  `moved` chip).

## Decided

The owner, 2026-11-18: "all as recommended, except 8 - let's implement this
for review threads as well. I'd like the two to use the same mechanism."

1. **Where the record lives:** the private agent threads ref, never
   pushed; for review threads too (see "Where it lives").
2. **A move anchors the next trace:** yes; later snapshots trace from the
   moved lines.
3. **Moving on a head that is no patch set yet:** allowed, without
   starting a patch set; a head force-pushed away and pruned by hand shows
   the thread as `rewritten`.
4. **Threads opened on the viewed snapshot:** no handle.
5. **Range:** drag places on one line; move mode places on the picked
   range.
6. **Another file:** drag within the thread's file; move mode across every
   file of the comparison.
7. **The Original Reviewed Change box after a move:** the moved-to lines.
8. **Review threads:** in this ticket, through the same mechanism (this
   revision).
9. **The agent suggesting a move:** later, as a suggestion only, never a
   move by itself.

## Calls made by the spec author

- **C1. Keep the ref's name** `agent/threads` though it now holds moves of
  review threads: renaming means moving every reviewer's existing agent
  threads, and nobody reads the name but carbonless.
- **C2. Old `thread-placed` read as moves, not migrated:** no write on
  read, one source of truth, and an older crb's view of its progress ref
  is untouched. Old placements now carry forward (decision 2 applied to
  old data).
- **C3. One event pair for both kinds** (`thread-moved`,
  `thread-move-undone`, with `thread: {source, id}`) rather than an agent
  pair and a review pair: the owner asked for one mechanism, and a future
  comment source adds a `source` value only.
- **C4. Handle and Undo in Files changed only;** the Overview and the
  Threads tab show that a thread is moved, not the controls: a move picks
  lines, and only Files changed has them.
- **C5. File threads aren't movable** (no handle): their place is a path,
  not lines, and a lost file thread already shows under "Not in this
  comparison".
- **C6. Two routes for both kinds** (`POST /moves`, `DELETE /moves/:id`);
  the two placements endpoints stay as they are and both answer `moved`.
- **C7. `snapshotId` not stored** in `on`: it is derived from `base` and
  `head`, saving 80 bytes a move.

## Questions

1. **Sharing hand placements later.** On 2026-11-07 you said hand
   placements would be shared with other reviewers through `meta` once
   sync exists. With moves in the private ref, they are never shared
   unless the reviewer turns on sync of their agent ref. Recommend: drop
   the deferred item (a move is the reviewer's own view; others keep
   GitHub's line). The alternative: keep it, as a publish step from this
   record built with sync.
