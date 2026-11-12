# Agent thread placement: moving a thread the tracer put on the wrong line

Status: draft 2026-11-12, for the owner's decisions (CAR-139). Spec only:
no product code in this round. Mockups (desktop and phone):
`docs/superpowers/specs/2026-11-12-agent-thread-placement-mockups.html`.

## Intent

The owner, opening the ticket: "Yes, open these tickets and please get to
work on them." Earlier, on agent threads, they asked for them to behave
"exactly the same" as review threads; the drag handle was left out of that
round because "it needs a new kind of saved record in the git review data",
with a stop-and-ask before any storage change. This spec is that ask.

An agent thread (a question to the reviewer's own agent, asked on a span of
the diff) follows its lines into newer snapshots through the tracer, as a
review thread does (`placeAgentThreads`, `src/server/rereview/threads.ts`;
product rule "Agent threads are traced like comments"). When the tracer puts
it on the wrong line, or can't place it, the reviewer has no way to fix
that. Principle 1 says every AI-ish decision is editable and the correction
is kept as data. The tracer is deterministic rather than AI, but its
placement is still a guess on the reviewer's behalf, and the same rule
applies.

## What exists today (studied 2026-11-12, origin/master 3a67d2a)

- **Agent threads** live in
  `refs/crb/reviews/<review>/reviewers/<reviewer>/agent/threads`, written by
  `src/server/agent/store.ts`, private and never pushed
  (`docs/review-data-storage.md`, "Agent threads ref"). Their anchor is
  `{subject: "line", path, commit, side, line, startSide, startLine, cols}`,
  a `file`, or a GitHub `thread`.
- **Their placement** is computed on every ask and never stored:
  `GET /agent/placements?ps=|head=` → `Session.agentPlacements` →
  `placeAgentThreads`, which runs the review threads' tracer
  (`placeThread`, `src/shared/rereview/placement.ts`) with **no stored
  placement** (`new Map()`). A thread asked on the viewed head isn't traced
  at all (`tracedAgentPlaceables`, `src/web/agent/placeable.ts`). A thread
  conversation (`thread` anchor) is never traced: it goes where its GitHub
  thread goes.
- **The page** shows a traced agent thread as a review thread: on its line;
  `changed since` with the old lines (`AgentChanged`, `ThreadRow.tsx`);
  unplaced in `UnplacedShell` with the fate sentence, `near N` and the
  Original Reviewed Change box (`AgentUnplaced`); or in "Not in this
  comparison".
- **Review threads already have half of this.** A `thread-placed` event
  (progress ref, `by` human or ai, per patch set, `engine` = tracer version)
  is written by `POST /threads/:id/placement` (`Session.placeThread`, checked
  with `validAnchor`) and laid over the tracer's answer (`#placedFor`). The
  page offers it as a `DragHandle` (Grabber, 40×40, pointer capture) only on
  **unplaced** rows, only on the latest patch set (`placeOn`), drag only,
  single line, with no undo and no tap or keyboard path. The placement holds
  for its own patch set only: the next patch set traces from the comment's
  original line again, so the correction is lost on every push.

## Goals

1. The reviewer can move any traced agent thread to another line of the
   viewed snapshot: by drag with a mouse, and by a non-drag path (tap,
   keyboard) that works on a phone.
2. The move is kept as data in carbonless's git review data, visibly the
   reviewer's (not the tracer's), and undoable.
3. A move is the thread's new truth: later snapshots trace from the moved
   line, not from where it was asked (see Open question 2).
4. Nothing the move does can hide a thread or touch coverage (principle 2):
   every agent thread still shows exactly once, a bad stored move fails to
   "unplaced, with its fate", never to nowhere.
5. Phones: 40px targets, no horizontal page scroll at 360px, no reliance on
   drag.

## Non-goals

- Moving a thread conversation (an agent conversation on a GitHub thread):
  it always sits with its GitHub thread.
- Writing anything to GitHub. A review thread's line on GitHub can't be
  changed through its API anyway.
- The agent placing or suggesting placements (a later `by: "ai"`
  suggestion, Open question 9).
- Sharing moves with other reviewers: agent threads are private.
- Review threads: recommended as a follow-up with the same interaction
  (Open question 8), not in this ticket's build.

## The record

### Where it lives: the agent threads ref

New events go in the reviewer's **agent threads ref**, beside the threads
they move, not in the progress ref beside review threads' `thread-placed`:

- **Privacy.** The agent ref is never pushed; the progress ref will be once
  sync exists. A move of a private thread is just as private, and its ids
  in a pushed ref would tell other readers that private threads exist and
  how many (GitDB 20).
- **One read.** The store that folds the threads folds their moves in the
  same `git log`, cached by tip OID (GitDB 17). No second ref is read per
  placement ask.
- **Same writer.** Both are written only by this server on the reviewer's
  behalf (GitDB 3), and each review stays isolated (GitDB 16).
- **Departure, stated:** review threads keep `thread-placed` in progress.
  GitDB 3 ("split refs by writer, not by kind of data") points to one ref
  either way; its "reconsider when" clause (data most readers never need)
  is why the agent data already has its own ref, and the moves follow it.

### Events

| Type | By | Payload |
|---|---|---|
| `agent-thread-placed` | human | `thread` (the agent thread's ULID); `on`: the snapshot it was placed in, `{revision, base, head}` plus `patchset` (a number) when that snapshot is one of the reviewer's patch sets; `anchor`: `{path, startSide, startLine, side, line}` in that snapshot; `engine` (the tracer's version, `TRACER_VERSION`) |
| `agent-thread-placement-undone` | human | `thread`; `placement` (the id of the `agent-thread-placed` it takes back) |

Example (one commit, as `git log` shows it):

```
crb: moved a thread to src/db/pool.ts:52 on PS3

{"v":1,"id":"01k…","type":"agent-thread-placed","ts":1762950000000,"by":"human","actor":"dan",
 "thread":"01k…","on":{"revision":"…","base":"<oid>","head":"<oid>","patchset":3},
 "anchor":{"path":"src/db/pool.ts","startSide":"RIGHT","startLine":52,"side":"RIGHT","line":52},"engine":3}
```

- `on.base` and `on.head` are filled in by the server from the session's
  snapshot of the target the page names (`{patchset}` or `{head}`), never
  taken from the client. They let a later trace start from exactly the
  snapshot the reviewer looked at, with no guess about the merge base (an
  asked anchor goes through `ThreadCodeSource.endpoints`, which has to
  reconstruct it).
- Columns are not stored: a move places whole lines. A span's characters
  (`startCol`, `endCol`) stay only on the asked anchor.
- **Write rules**, enforced on write and on read (`validateForWrite`,
  `parseEvent`, as for every agent event): both types `by: "human"` only;
  the anchor parses as `thread-placed`'s does (positive integers, sides
  `LEFT`/`RIGHT`, start not after end on one side); `on.base` and `on.head`
  are OIDs; `placement` is a lowercase ULID. A reader drops what breaks
  them, and an old reader skips both types (GitDB 8): it then shows the
  tracer's placement, which hides nothing, so no version bump.
- **Server checks** (`POST /agent/threads/:tid/placement`, body
  `{to: {patchset} | {head}, anchor}`, and
  `DELETE /agent/threads/:tid/placement/:id` for undo): the thread exists
  and is the reviewer's (404 otherwise); it isn't a thread conversation
  (400); the target is the viewed snapshot's latest patch set or a head
  that is no earlier patch set (an earlier patch set is read-only: 409, as
  `ReadOnlyPatchsetError`); the anchor passes `validAnchor` against that
  snapshot (400, as `InvalidPlacementError`). Undo of an id that isn't a
  live move of that thread is a 409 that changes nothing.
- **Caps:** an anchor path at most 4 KiB; at most 200 moves per thread are
  folded (later ones are dropped and the thread shows the 200th's
  placement), so a stuck client can't grow the fold without bound.

### Fold

In the agent store's fold (`(ts, id)` order, deduplicated by id, as now):

- Each thread gets `moves`: its `agent-thread-placed` events in order,
  minus those named by an `agent-thread-placement-undone` of the same
  thread. An undo naming another thread's move, or an unknown id, does
  nothing. A move or undo of a thread never opened, or of a thread
  conversation, is dropped.
- Two tabs: both writes are compare-and-swap appends (GitDB 13); the later
  `(ts, id)` wins. An undo names one move, so it can't take back a move it
  never saw.

### Which anchor a target uses

For a target snapshot `T` (the patch set or head being viewed), the
thread's **effective anchor** is:

1. **A move made on `T` itself** (same `on.revision`; the last one): shown
   as placed there, exactly as chosen, once it passes `validAnchor`
   against `T`. Not traced.
2. Else **the last move visible at `T`**, traced from its own snapshot
   (`on.base`, `on.head`) into `T` by the same tracer, with the same three
   outcomes as any thread (placed, `changed since`, unplaced with a fate).
   For an earlier patch set `n`, a move is visible when it was made before
   patch set `n+1` started (the rule that already says which agent threads
   an earlier patch set shows); for the latest patch set or a head, every
   move is.
3. Else **the asked anchor**, traced as today.

A move that fails rule 1's check is skipped for rule 2 (it can't be placed
in its own snapshot, so nothing is traced from it either) and the next one
down is used: the thread is never dropped.

**What if the move's commits are gone** (a head with no patch set, force-
pushed away and pruned by a manual `git gc`: carbonless's clone has
`gc.auto=0`, so this needs a hand): the trace from it fails and the thread
shows unplaced with fate `rewritten`, the "moved" chip and its Undo. It
does **not** fall back to the tracer's older guess, which the reviewer
already rejected ("Flag uncertainty, never show something wrong as
certain"). A move on a patch set can't lose its commits: `patchsets/<n>`
and `-base` pin them (GitDB 4).

This is computed server-side in `placeAgentThreads`: `AgentAsked` gains the
thread's moves, `agentTraceable` takes the effective anchor and, for a
move, its `{base, head}` as the thread's own endpoints (a new optional
`ends` on `TraceableThread` that `ThreadPlacer.inputs` uses instead of
`code.endpoints`), and rule 1 goes through `placeThread`'s existing
`stored` path. `GET /agent/placements` answers, per thread, the placement
plus `moved?: {id, on: {patchset?} | {head}, at}`: which move it stands on,
for the chip and Undo.

### Size (principle 3, GitDB 22)

Measured 2026-11-12 with a copy of `scripts/measure-agent-ref.ts` extended
with raw move and undo commits (git 2.53, on this shared machine at load
~20):

| Measure | Value |
|---|---|
| One `agent-thread-placed` commit | 624 B raw, 388 B deflated |
| One `agent-thread-placement-undone` commit | 408 B raw, 274 B deflated |
| Today's heavy agent ref (50 threads × 4 messages of 2 KiB, 100 seen), packed | 154 KiB |
| The same plus 175 commits (each of the 50 threads moved on 3 patch sets, 25 undone), packed | 185 KiB (+31 KiB, about 180 B per event) |
| Cold `read()` of that ref, packed (median of 9) | 19.9 ms wall; CPU 9.8 ms + 10 ms git |

A realistic review moves a handful of threads: well under 2 KiB. Even the
heavy case stays inside the agent ref's bound (under 300 KiB packed, a cold
fold under 200 ms). The ref is never pushed, so nothing reaches the remote
or anyone else's fetch; everyday git never sees it (GitDB 14). The build
adds moves to `scripts/measure-agent-ref.ts` and a size test (one move
commit under 1 KiB raw and 512 B deflated) and updates the table in
`docs/review-data-storage.md`.

### Push, fetch, conflicts between reviewers

None today: the agent ref is never pushed or fetched, and each reviewer has
their own. If agent sync is ever turned on (GitDB 20: the reviewer's
choice), the moves travel with their threads in the same ref and merge by
union like every other event; the fold's last-wins and named undos give
every machine the same answer. Two reviewers never share an agent thread,
so they can't conflict over one.

## How it looks

Mockups: `2026-11-12-agent-thread-placement-mockups.html` (desktop A to D,
phone E to H).

### The tracer's place and the reviewer's

- **The tracer's** placement looks as it does today: no chip when the line
  is the same, `changed since` (yellow) with the old lines, or the unplaced
  row with its fate.
- **The reviewer's**: a gray chip, pin icon, `moved` (the `opened-on` chip's
  style: a fact, not a state, so no state colour and not the agent's teal,
  which is the agent's). Tooltip: "Moved here by you on PS3", or "Moved by
  you on PS2, followed here" when traced forward (rule 2). Beside it, a 40px
  Undo icon button (undo arrow; tooltip and name "Back to the tracer's
  place"). On a phone the chip and Undo wrap to the card header's second
  row with the other chips.
- When a moved thread is followed into a later snapshot and its line
  changed, both chips show: `moved` and `changed since` (the old lines being
  the ones it was moved to).
- The Original Reviewed Change box of an unplaced moved thread shows the
  lines it was moved to, in the move's snapshot (Open question 7).

### The handle

- Every traced agent thread card (on a line, `changed since`, unplaced,
  "Not in this comparison") gets a Grabber handle in its header, 40×40, in
  `muted`, `ink` on hover, when the viewed target takes writes (the latest
  patch set or a head; none on an earlier patch set, which is read-only).
  An agent thread asked on the viewed snapshot gets none (Open question 4),
  nor does a thread conversation.
- One control, two ways (name: "Move thread"; tooltip: "Drag to a line, or
  press to pick one"):
  - **Drag** (pointer capture; a mouse, or a finger where it works): the
    card stays put, a slim ghost (sparkle, first words) follows the
    pointer, and the line under it is outlined in `accent` (the existing
    `data-drop-line`). Release on a line places the thread there (one line:
    the range's end). Release elsewhere, or Escape, cancels. The diff
    scrolls when the pointer nears the viewport's top or bottom edge.
    Drop targets are the rows of the thread's file only.
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
  are targets, so a thread can go to another file (Open question 6).
- The selection bar, next to the picked numbers, offers one 40px pin
  button, "Place here". It places the thread on the picked lines and leaves
  move mode. Escape, ✕ or navigating away leaves it with nothing written.
- After a place (either way), the page scrolls the card into view on its
  new line with the landing highlight (`mark-tint`, fading), and keyboard
  focus goes to its Undo.

### Writes

- Optimistic, as review threads' `usePlaceThread`: the placement shows at
  once on the agent placements query, and is rolled back on a refusal
  (400, 404, 409) with the refusal under the card in `bad` and a 40px
  Retry where it can be retried ("Saving review state" rules). The undo the
  same way.
- While the agent placements are loading, there's no handle: the card is
  where it was asked, waiting (the spinner rules as now).
- A move never writes to GitHub, never starts a patch set (Open question
  3), never touches cluster states, progress, bubbles' counts or the
  unresolved count.

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
move. Undo goes back one move: to the move before it, or to the asked
anchor's trace.

## Principle checks

1. **Editable, kept as data:** the move is an event in git, undoable by
   another event, and becomes the anchor later traces learn from.
2. **No change missed:** agent threads aren't changes; moving one never
   marks, hides, or counts anything. Every agent thread still has exactly
   one placement whatever the moves (a property test), and a move that
   doesn't check out leaves the thread unplaced with a fate, never gone.
3. **Git stays fast:** a few hundred bytes per move in a ref that is never
   pushed; nothing per review elsewhere; measured above.
4. **No server:** local git refs only.
5. **Mobile:** the move mode path needs no drag; every new control is 40px;
   the bar and chips wrap at 360px with no horizontal scroll.
6. **Icon-first:** grabber, pin, undo; the only words are "moved", "Pick a
   line" and "Place here", with tooltips and accessible names.
7. **Methodology:** a move records its snapshot's base and head, and the
   trace from it uses only diffs between commits, as the tracer always
   does. It goes in the matrix (below).

## Review threads

GitHub owns a review thread's line, and its API can't move one. Today's
`thread-placed` is a local display override, unplaced rows only, drag only,
per patch set. Recommendation (Open question 8): give review threads the
same interaction in a follow-up ticket, still local only and never written
to GitHub: the handle on every traced review thread, move mode, the `moved`
chip, Undo (a new `thread-placement-undone` in the progress ref), and
forward anchoring (a patch set's placement anchoring later patch sets'
traces; patch sets are pinned, so the snapshot is known by number). Their
storage stays in the progress ref: when sync arrives it is shared through
`meta` for moves made by hand (owner, 2026-11-07). A thread conversation
follows its GitHub thread, moved or not.

## Tests

- **Shared unit** (`src/shared/rereview/agentMoves.test.ts`, new pure
  module): the effective-anchor rules 1 to 3, an earlier patch set's
  visibility rule, a failed rule-1 check skipping to the next move; a
  property test over random threads, moves, undos and targets: every
  thread has exactly one placement and the set of ids in equals the set
  out.
- **Server unit:** `parseEvent`/`validateForWrite` for both types (each
  write rule refused on write and dropped on read; `by: "ai"` dropped; an
  unknown type skipped by an old reader); the store's fold (order, dedupe,
  undo of another thread's move or an unknown id ignored, a thread
  conversation's move dropped, the 200 cap); the routes (404 unknown
  thread, 400 thread conversation, 400 anchor outside the file, 409 on an
  earlier patch set, 409 undo of a dead move; `on` filled in from the
  session, never from the body); `placeAgentThreads` traces a move from
  its own `{base, head}`; a move whose head is pruned shows `rewritten`,
  not the older trace; two tabs moving at once both land, last wins.
- **Storage:** one move commit's size (raw and deflated bounds above); the
  measure script's new rows; a default clone and a fetch of the review's
  shared refs never carry the agent ref.
- **Web unit** (jsdom): the handle shows only where writes go and only on
  traced threads; press opens move mode, Escape and ✕ leave it with no
  write; the `moved` chip's tooltip on the move's own snapshot and when
  followed; Undo's optimistic update and its rollback on a 409; every new
  control 40px and named.
- **e2e, desktop and phone** (`e2e/agent-move.spec.ts`, on the re-review
  fixture with three pushes): the tracer misplaces a thread (twin lines),
  the reviewer moves it (mouse drag on desktop; tap the handle, tap a
  number, Place here on phone; keyboard on desktop too), the chip shows,
  a reload keeps it, Undo brings back the tracer's place; at the next push
  it is followed from the moved line; the moved-to line deleted in the push
  after that → unplaced with fate and `near N`; no horizontal scroll at
  360px with move mode open; `expectEveryUnitMarkable` unchanged. Gate on
  a held placements answer for the "no handle while loading" state.
- **Methodology matrix:** one assertion per permutation in
  `test/methodology-matrix.ts`: an agent thread asked on the opened stage,
  moved to `a.txt` line 2 at the opened stage, is followed from line 2 to
  the updated stage, with each update kind's expected outcome written in
  the matrix (line 2's text survives every update; for `base-absorbs` it
  is the base's line by then, so the expectation says how that shows), and
  survives `gc --prune=now` when moved on a patch set.
- **Gallery:** a `case/agent-thread-move` PR in the gallery repo where the
  tracer picks the wrong twin of a repeated line, with a README row.
- **Docs in the same change:** `docs/review-data-storage.md` (the events,
  write rules, the size table), `docs/product-rules.md` ("Agent threads are
  traced like comments": drop "no drag, no storage change"; add the
  move rules).

## Open questions for the owner

1. **Where the record lives.** Recommend the agent threads ref (private,
   one read, never pushed). The alternative is the progress ref's existing
   `thread-placed`, which would be pushed once sync exists.
2. **Does a move anchor the next trace?** Recommend yes: a correction made
   on PS2 should still hold on PS5; otherwise every push brings the wrong
   line back. The alternative, a move for its own snapshot only, is what
   review threads do today.
3. **Moving on a head that is no patch set yet.** Recommend allowed,
   without starting a patch set (agent threads don't start one either). The
   cost: a head that is force-pushed away and pruned by hand loses the
   move's starting point, shown as `rewritten`. The alternative is moves
   only on the latest patch set, as review threads.
4. **Threads asked on the viewed snapshot.** Recommend no handle: the
   reviewer chose those lines just now, and the ticket is about the
   tracer's mistakes. Allowing it would also re-anchor a fresh question.
5. **Range.** Recommend: drag places on one line; move mode places on the
   picked range (one line or more).
6. **Another file.** Recommend: drag within the thread's file; move mode
   across every file of the comparison (the tracer can lose a thread to a
   rename it didn't pair).
7. **The Original Reviewed Change box after a move.** Recommend the
   moved-to lines (the reviewer's latest word about where the question is);
   the alternative is the lines it was asked on.
8. **Review threads.** Recommend the same interaction (handle everywhere,
   move mode, `moved` chip, Undo, forward anchoring) in a follow-up ticket,
   local only, never on GitHub. The alternative is to leave them as they
   are (drag on unplaced rows only).
9. **The agent suggesting a move.** Recommend later, as a suggestion only
   ("Place by agent suggestion", like Resolve's), never a move by itself.
