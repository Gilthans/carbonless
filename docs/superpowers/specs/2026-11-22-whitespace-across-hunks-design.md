# Whitespace-only across git hunks (CAR-218)

Status: draft, 2026-11-22. Ticket: CAR-218.

## Why

The owner reported (2026-11-20) that a block that only moved one level
deeper reads inconsistently: some of it collapses as whitespace-only, the
rest shows as real changes. On 2026-11-22 they asked to fix it now.

The cause: after a one-level shift, a few lines of the block match a
*different* line at the new depth byte for byte (a lone `<div>`, a `}`).
Git keeps those as unchanged lines, so it cuts the block into several
hunks, and inside each hunk the removed and added lines no longer line up.
The server decides what is whitespace-only one git hunk at a time
(`splitHunk`), so it misses the pairs whose twin sits across one of those
accidental lines. The view already matches over the whole display hunk,
context included (`matchHunk`), so it draws most of the block as quiet `~`
rows while the clusters behind them still count as changes. That's the
inconsistency: the rows say "whitespace", the cluster's controls and the
progress bar say "change".

Measured on the reported file (a React page, ~65 lines wrapped in a new
provider): `git diff -w` says 18 added and 5 removed lines changed. Today
the server finds 28 whitespace-only lines and 131 changes in 13 hunks;
the view shows 122 `~` rows. Matching over the display hunk, as the view
does, finds 136 whitespace-only lines and exactly 23 changes, the same as
`git diff -w`.

## Goal

A cluster is whitespace-only exactly when the view draws every one of its
lines as a `~` row. The server's cut and the view's rows come from one
matching over the same span, so they can't disagree.

## Non-goals

- No change to the line diff itself (still Myers, `--indent-heuristic`).
  The accidental unchanged lines stay unchanged lines: they're not
  reviewable, as today.
- No change to what "Ignore whitespace" does with whitespace-only
  clusters (CAR-156, CAR-184): it leaves them out of progress, collapsed
  to a `~` row, still markable.
- No difference between the base view and the since view: both decide
  whitespace-only the same way, each on its own diff.
- No moved-code detection (CAR-31/33). A line whose whitespace twin is
  across a *change* line out of order stays a change, as `git diff -w`
  shows it.

## Anti-goals

- A real change counted as whitespace-only (principle 2). The matching is
  order-preserving and keeps every unchanged line matched (`matchSides`'
  context weight), so the result is a valid `git diff -w` edit script:
  nothing it calls whitespace-only differs from its twin in more than
  whitespace.
- The server cut and the view drifting apart again.

## Design

### One matching per display hunk

The span is the display hunk (`buildDisplayHunks`: git hunks up to 6
unchanged lines apart share one, with 3 lines of context around). For
each display hunk, `matchSides` runs once over its old-side lines and
new-side lines, unchanged lines as context sides, exactly as `matchHunk`
does today. Both the server's cut and the view's rows read that one
result: the matching moves into `src/shared/whitespace.ts` as a function
of the display hunk's lines, and `matchHunk` becomes its caller. The
server builds display hunks already; it now cuts after building them.

### The cut

Each git hunk is still cut into pieces of its own lines, in order, every
line exactly once (whitespace.test.ts keeps checking it for any input).
What changes is which lines count as whitespace-only:

- a changed line is whitespace-only when the display hunk's matching
  matched it (to a changed line of the same git hunk, of another git
  hunk, or to an unchanged line);
- a maximal run of consecutive whitespace-only lines of a git hunk is one
  whitespace-only piece; when its removed and added lines pair with each
  other they read as two-sided `~` rows, as today; otherwise the piece
  has lines on one side only (their twins are elsewhere), which is new:
  a removed-only or added-only whitespace-only cluster;
- everything else is a change piece, as today.

A pure deletion or addition with no twin anywhere in the display hunk
stays a change (an added blank line included), as today.

### Caps

`SPLIT_CELLS` (removed × added lines, 250,000) now bounds the display
hunk's old × new lines, context included. Over it, the server falls back
to today's cut, one git hunk at a time (a git hunk over the cap stays one
change, the safe direction, as today). The wholesale re-indent fast path
stays. *My call:* the view computes the same function with the same cap
locally (no API change), so it draws `~` rows only where the cut says
whitespace-only. The price: a display hunk between 500 × 500 and the
view's current 2,000 × 2,000 (`PAIR_CAP`) loses the cross-hunk `~` rows it
shows today; in those rare hunks rows and controls agree on "change"
instead of disagreeing.

### Reviews in progress

The cut is part of cluster identity (docs/review-data-storage.md, "Split
carries"): wherever a cut moves, the pieces get new keys and marks on the
old pieces stop matching. They fail safe, reading unreviewed, but the
reviewer loses them. On this repo's last 506 merges, the new cut differs
in 36 of 4,656 changed files (0.8%), 144 of 18,896 git hunks. It adds
1,958 whitespace-only lines and takes 31 back to changes (lines whose
pair inside the hunk gives way to a better one across it; the safe
direction).

**Owner decision:** carry marks from the old pieces onto the new ones
(recommended), or let them read unreviewed with a release note. Carrying
generalizes the split carry: today it maps a whole hunk's key onto its
pieces; here an old piece's mark goes onto each new piece by line (a new
piece wholly inside a marked old piece takes its mark; one only partly
inside takes line marks for the lines it shares), once, with the same
fold guard (applied only while the old key still holds that mark).
*My call:* a mark is carried only onto lines that stay whitespace-only or
become whitespace-only, never onto the lines that go back to being a
change: the reviewer may have marked them collapsed, as a `~` row, without
reading them (principle 2). The carry needs the old cut alongside the new
one to rebuild the old keys, and a new shape for the carry event (today's
names only a whole hunk's key), so it goes through
`docs/gitdb-design-principles.md`. Without the carry the change is the
cut, the docs and a release note.

### The since view (interdiff), with the same rule

The owner, 2026-11-22: "I don't want us to skip interdiff view. Interdiff
view and base view should have feature parity, whenever plausible. I want
interdiff to be a first class citizen". So the since view gets the same
rule, on its own diff.

Today the since view builds display hunks from the interdiff
(`src/server/rereview/engine.ts`, `buildDisplayHunks` over the interdiff's
clusters), draws `~` rows with `matchHunk` over them, but takes each unit's
`whitespaceOnly` from the viewed snapshot's cluster
(`src/shared/pieces.ts` `sinceUnits`). Those disagree twice over: across
hunks, as in the base view; and in what is compared, since a piece can be
a re-indent *since the last review* inside a cluster that's a real change
against the base (the reviewer read its content in the earlier patch set),
or the other way round.

The rule, the same as the base view's, on the diff the reader is looking
at:

- the same shared matching runs once per interdiff display hunk; it gives
  both the since view's `~` rows and which of the interdiff's changed
  lines are whitespace-only;
- a since piece (the lines it shows) is whitespace-only when every one of
  its lines is; `SinceUnit.whitespaceOnly` comes from that, not from the
  snapshot's cluster;
- a unit that is the rest of a cluster no piece shows (only the full diff
  has those lines) keeps its cluster's flag, as today, because those lines
  are read against the base;
- with "Ignore whitespace" on, the since bar, file headers, chips and
  move-on leave whitespace-only units out, with the same `~` count, as
  CAR-184 already does for them.

Since marks are stored by line ranges (`since-lines-state`), not by
cluster key, so the since view's own marks don't move. The same caps apply
(the interdiff display hunk's old × new lines; over the cap, a piece is
whitespace-only only if its own lines pair within one git hunk, and the
rows follow).

## Docs to update in the same change

- `docs/product-rules.md`, "Whitespace-only runs are clusters": drop
  "Only within a git hunk: a re-indented block whose two sides git puts
  in two hunks stays two changes", say the span is the display hunk.
- `docs/review-data-storage.md`, "Split carries": the new cut, and the
  carry if chosen.
- `docs/product-rules.md`, the since view's "Ignore whitespace" counts:
  whitespace-only is judged on the interdiff.
- `docs/faq.md`, if it explains why whitespace-only counts differ from
  GitHub.

## Tests

- Unit: the reported shape, made up: a block wrapped one level deeper
  where a lone `<div>` and a `}` match lines at the new depth. Assert
  the clusters are exactly `git diff -w`'s changes plus whitespace-only
  pieces, and that the view's `~` rows cover exactly the whitespace-only
  clusters' lines.
- Property (whitespace.test.ts style): for random display hunks, every
  changed line in exactly one piece; every whitespace-only piece's lines
  matched; every line the view draws as `~` in a whitespace-only cluster
  and vice versa.
- Keys: `snapshot.test.ts`'s pinned keys move only for hunks that span an
  accidental unchanged line.
- Carry (if chosen): a review marked under the old cut opens under the
  new one with its marks on the new pieces; a forged or stale entry
  changes nothing.
- CPU: the cut's cost per display hunk against a reference workload
  (`test/cpu.ts`), the cap's worst case included.
- e2e: on the gallery case, with Ignore whitespace on, the whole block
  reads quiet and the progress bar counts only the real changes.
- Since view, unit and e2e: patch set 2 only re-indents a block patch set
  1 changed (with an accidental byte-equal line inside); since patch set 1
  with Ignore whitespace on, the block reads quiet, its units leave the
  since bar, and the `~` count says how many. And the reverse: a real edit
  since patch set 1 inside a cluster that's whitespace-only against the
  base counts.
- Property: in the since view too, every `~` row's line is in a
  whitespace-only unit and every whitespace-only unit's lines are `~`
  rows.

## Gallery

An edge-case PR: a made-up component wrapped one level deeper in a new
provider, with an accidental byte-equal line inside, before and after;
then a second push that re-indents a block the first push changed, for
the since view.

## Left to the builder

The shared function's name and shape; whether the server keeps the
display hunks it built for the cut or rebuilds them; how a one-sided
whitespace-only piece is numbered (as git numbers a side with no lines:
it starts at the line it follows).
