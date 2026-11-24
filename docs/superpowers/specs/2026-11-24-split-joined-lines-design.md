# A line split into several, or several joined into one (CAR-130)

Status: draft for the owner. Ticket: CAR-130 (test case: CAR-221).
Mockups (approved by the owner 2026-11-24, "It looks good, go ahead"):
https://claude.ai/artifact/1QSM1xcQDKgy93tX1RPosx

## Why

The owner, 2026-11-12: handle a line that split into several, such as a
function definition that changed into one argument per line, or a line
that got split into two; several lines joined into one is the same
problem.

Today each line has at most one partner (step 2, CAR-30:
`alignCluster` in `src/shared/linePairing.ts`, called by `hunkPairs` in
`src/web/files/wordBlocks.ts`). So one new line pairs with the old line
and the rest read as entirely new:

```python
def load(path, retries=3, timeout=30):
```

becomes

```python
def load(
    path,
    retries=3,
    timeout=30,
):
```

and only `def load(` gets marks. CAR-221 is the same shape: a comment
line grew and wrapped onto a second line; the first line's added words
are marked, the second line reads as a plain added line.

## Goal

One old line pairs with the run of new lines it became (or a run of old
lines with the one new line), and only text that really changed is
marked, on whichever line it lands. The owner's rule, 2026-11-24:

> Word-diff the old line against the new lines joined together, ignoring
> line breaks and indentation, and paint the result back onto each line.
> A pure split marks nothing. The reverse for a join.

## Non-goals

- **Moved code** (CAR-31/33). Lines that moved, or swapped, stay as
  today.
- **Extract method** (one new line drawing on two old lines that aren't
  next to each other, with new text between; step 2's case 7). Not the
  same mechanism: a group is one line against a run of adjacent lines
  that together hold its text. Step 2's case 7 looks as it does today.
- **Many to many** (two old lines rewrapped into three new ones). A
  group is always one line on one side. *My call:* rewrapping a
  paragraph is a later step if the real-PR comparison shows it matters.
- **The thread tracer** (`src/shared/tracer/trace.ts`). It keeps
  `alignOrOver` and its own "two lines merged into one" step. *My call.*
- Any change to clusters, keys, +/− counts, progress or what is
  unreviewed. The pairing stays a view.

## Anti-goals

- **A group that hides a change.** Every line of a group stays a changed
  line, unreviewed until the reviewer marks it (principle 2). Any text
  that isn't in the other side is marked (owner, 2026-11-24, on reflow
  punctuation: "Mark it. Any added text should be visible").
- **A confident wrong group.** In doubt, no group: the lines pair as
  today.
- **Making step 2's cases look worse.** Its seven cases and the step 1
  GitHub fixture keep their rows and marks, unless a case is a split or
  join (none of them is).

## Design

### What a group is

A group is one line on one side (the *one line*) and a run of 2 or more
adjacent lines on the other side (the *run*), all inside one stretch
(`hunkPairs`' unit: removed lines then added lines, ended by a context
or `~` row) and inside one run of the view (one cluster, or one since
piece). A split is one removed line and a run of added lines; a join is
a run of removed lines and one added line.

A candidate is a group when all of these hold:

- **Similar:** the one line against the run joined (below) scores at
  least `PAIR_MIN_SIMILARITY` with step 2's `score` (whitespace not
  counted; words only when both have words).
- **Every line holds part of it:** each line of the run shares a
  non-whitespace token with the one line that the lines before it
  haven't already used up. So an added `'gamma'` after `'beta'` →
  `'beta',` (step 2's case 1), or a `}` added after a changed line, is
  never pulled into a group. *My call*; the exact test is the builder's,
  decided with the rows (before marks), and must keep those two cases
  out.
- **Small enough:** at most `GROUP_MAX_LINES` lines in the run (*my
  call:* 20), the joined text under `WORD_DIFF_MAX` (1,024 characters,
  as for a pair), and inside step 2's guards and the hunk's word-step
  budget (below).

### Choosing groups and pairs together

Groups join step 2's non-crossing pairing as one more kind of item: each
line in at most one pair or group, no two items crossing, the most total
similarity. A group replaces the pairs it would cover only when it holds
more of the line's text than they do (*my call*: the weighting is the
builder's, tuned on the fixtures and the real-PR comparison). Ties go to
today's layout.

Equal stretches keep step 1's i-th-with-i-th pairs; groups are only
looked for in unequal ones (*my call*: a split alone always makes a
stretch unequal, and GitHub parity in equal ones stays as step 1
promised).

A group never spans two runs (two clusters, or two since pieces): its
bracket needs adjacent rows. Such lines pair as today. *My call*, the
safe direction.

### The marks

The run is joined into one text: each break, with the next line's
indentation, counts as a gap that matches any whitespace on the one
line, or none. A repeated comment leader at the start of a continuation
line (`//`, `///`, `#`, `*`, `--`, `;`, `%`, the same as the run's
first line starts with) counts as part of the break too, so CAR-221's
second `//` isn't marked, as in the mockups (*my call*; a Markdown `*`
bullet list is read the same way). Then step 1's `wordMarks` runs on the
one line against that text, and the marks are painted back onto each
line, a mark spanning a break cut into one per line. Whitespace
elsewhere is marked as in a pair.

So a pure split marks nothing; `timeout=30` → `timeout=30,` marks the
comma; the join of `items` / `.map(price)` / `.reduce(sum, 0);` into one
line marks only `0` → `0.0`.

Marks for a group go through the same runner as a pair's
(`src/web/files/wordWork.ts`): marked on first paint while the render's
budget lasts, else off the render path; pending, done or failed per
group, never plain while pending (principle 8). The hidden-characters
check (`hiddenLines.ts`) reads a group's marks as it reads a pair's.

### Unified

A group reads together, like a pair under unified B: the one line, then
its run (a split: −old, +new…; a join: −old…, +new). *My call:* a group
is always its own block; it never merges with neighbouring pairs into
−a −b +a′ +b′, so its rows stay adjacent. Line numbers don't change; only
the order of rows inside the stretch does, as for pairs today.

### Side by side

The one line shares a row with the first line of its run; the run's
other lines get rows of their own with a blank (hatched) cell opposite
(the mockups' split). A join mirrors it: the old run on the left, the
one new line on the first row on the right, blanks below. The layout's
guarantees (`sideBySide.ts`) hold as they are: every line exactly once
per side, each side in order, never in a cell of the wrong side, and a
blank cell only once the other side of that gap or group has run out.

### The bracket

A bracket in the gutter ties the one line to its run, in unified and
side by side, desktop and phone. Unified, it spans all the group's rows;
side by side, it runs down the run's side. Owner, 2026-11-24: "No chip.
The bracket is sufficient". Its tooltip and accessible name say what it
ties, short: "Line 12 split into 12–16", "Lines 7–9 joined into 7". It
is drawn with the rows (groups are decided with the rows,
synchronously, as pairs are), so it never appears late or moves code.

### Ignore whitespace

A pure split or join is not whitespace-only and keeps counting (owner,
2026-11-24: "Keep counting it"). This needs no new code: clusters and
`whitespaceOnly` come from per-line matching (`matchDisplayHunk`), which
never matches one line with several. A `~` row ends a stretch, so a
line of the run that is some other line's whitespace twin (a lone `)`)
leaves the group; the rest may still group.

### The since view and Find in PR

Groups come from `hunkView`, so the since view gets them on the
interdiff's hunks, cut at its pieces, exactly as the full diff gets them
on its own (principle 9: interdiffs are first-class).
Example: patch set 1 adds `def load(path, retries=3, timeout=30):`,
patch set 2 splits it. Since patch set 1, the old line and its run are
one group; against the base, all five lines are plain additions.

Find in PR reads `hunkView`'s rows (`findInPr.ts`), so its order of hits
follows the group layout with no new work. It draws its own hit marks,
not word marks.

### Threads and line picks

A thread stays on its line's row wherever the row goes
(`threadPlacement.ts`); ranges and picks behave over group rows as they
do over pair rows today.

### Caps and CPU

Group candidates are scored inside step 2's guards (`ALIGN_CAP`,
`ALIGN_CHARS`, `ALIGN_WORD_OPS`) and spend from the same hunk budget
(`HUNK_ALIGN_WORD_OPS`). A stretch whose groups don't fit gets today's
pairs only; past the budget, today's layout. A hint for the builder:
for a fixed one line and run start, the bit-parallel LCS can go on over
the run's next line, so scoring every run length costs about one LCS
over the longest run, not one per length.

### Correcting a pair or a group by hand (second PR)

The mockups say a group "can be unpaired by hand like today's pairs, and
the correction is kept". Today no pair can be corrected by hand: step 2
shipped without it. Principle 1 asks for it for both, so this spec adds
it for pairs and groups alike, as its own PR (`Part of CAR-130`). See
"Questions for the owner".

- **UI:** the reviewer picks lines by their numbers (`linePicks.ts`).
  When the picked lines are exactly a pair or a group, the selection bar
  (`SelectionBar.tsx`) offers an Unpair icon; when they are one line on
  one side and a run on the other in one stretch, a Pair icon. Icons with
  tooltips and accessible names, 40px tap targets; nothing new in the
  rows. Picking the same lines again offers the opposite action (that is
  the undo).
- **Effect:** an unpaired pair or group's lines stay plain in that
  stretch (*my call*: they don't re-pair otherwise; plain is never
  wrong). A hand pair or group is kept even below the threshold; the
  automatic pairing fills around it, never crossing it. A hand item that
  crosses another: the later one wins.
- **Identity:** by content, so a correction holds in every snapshot, in
  the since view and after a push wherever the same lines meet: the
  file's path and, per side, the count and a hash of the lines' texts.
  Applies to each place in the file where the same lines meet (GitDB 9).
- **Storage** (`docs/gitdb-design-principles.md` followed): a
  `pairing-corrected` event, `by: "human"` only, with `path`, `action`
  (`pair` or `unpair`), `old` and `new` (`{ lines, hash }`). *My call:*
  in the reviewer's private agent threads ref, beside thread moves (the
  owner's 2026-11-18 decision for "the reviewer's view" data): one
  writer (GitDB 3), never pushed. The last event for the same path and
  sides wins (`(ts, id)`, GitDB 11). An older reader skips the type
  (GitDB 8) and shows the computed pairing, which hides nothing: no
  version bump. The format gains one event type; measure a correction
  commit's size as thread moves were (a test keeps it under 1 KiB raw).
- **Loading:** corrections are read with the review, in parallel with the
  hunks; a hunk is laid out once both are in, so a correction never
  moves rows after first paint. A failed read shows the computed pairing
  and says so with an alert icon, distinct from "no corrections".

## Docs to update in the same change

- `docs/product-rules.md`: a short section "A line split or joined pairs
  as a group": the rule, the bracket, that coverage is untouched, the
  Ignore whitespace call, the since view; with the second PR, hand
  corrections.
- `docs/faq.md`, "Why are lines in a different order, or marked where
  GitHub shows none?": a split or join reads as one group with a bracket.
- `docs/review-data-storage.md` (second PR): the `pairing-corrected`
  event, its write rules and size.
- `2026-11-08-inline-diff-step2-design.md`: its non-goal "one line
  drawing on two" points here for splits and joins; extract method
  stays out.

## Tests

- **Unit, cases:** the pure split (no marks, five lines in the group);
  the split with a new trailing comma (only the comma); the CAR-221
  shape, made-up code (the added words on both lines, the second `//`
  plain); the join (`0` → `0.0` only); a split next to an ordinary pair
  in the same stretch; step 2's seven cases unchanged (case 1, list item
  added, and a `}` added after a changed line: no group).
- **Unit, properties** (random stretches, `linePairing.test.ts` style):
  items never cross; each line in at most one item; every group's run
  adjacent, inside one run of the view, at most `GROUP_MAX_LINES`; every
  group's lines each share text with the one line; with groups, the same
  clusters, keys and counts as without (principle 2). Layout: the
  existing `sideBySide.test.ts` and `pairOrder.test.ts` properties over
  stretches with groups; every group's rows adjacent in unified.
- **Unit, marks:** a pure split or join of random lines (random breaks,
  random indentation) gives no marks; any token inserted anywhere in the
  run is marked, on the line it sits on.
- **Ignore whitespace:** a pure split keeps its cluster counted with the
  switch on.
- **CPU** (`test/cpu.ts`): the worst stretch inside the guards, with
  groups, against step 2's reference workload (plain word steps); a hunk
  of 40 such stretches within the hunk budget, in `hunkPairs` and in
  Find; a scaling check on run length (a run 4x as long against four of
  a quarter).
- **e2e** (desktop and phone, unified and side by side): the split, the
  CAR-221 shape and the join from a throwaway repo: which rows the
  bracket spans, the bracket's accessible name, the marked text, a
  thread on a group line staying with it; the since view's split from
  patch set 2; Find stepping through a group's rows in shown order;
  `expectEveryUnitMarkable` on a file with groups. Groups add no new row
  kind.
- **Second PR:** event write and read rules (`validateForWrite`,
  `parseEvent`, a human only); the fold (last wins, unknown type
  skipped); a correction made on patch set 1 holding on patch set 2 and
  in the since view; e2e: unpair a group and a pair, pair a missed
  group, reload, undo; the held read (`expectLoadingThen`) shows the
  hunk's loading state, never computed rows that then move.
- **Real-PR comparison** (before merge, not CI, part of the owner's QA):
  `scripts/pairing-compare.mjs` grows a page of every stretch whose
  layout groups change, worst first; the owner marks each fine or bad.

## Gallery

One PR, `base/split-joined-lines` and `case/split-joined-lines`, made-up
code: the pure split, the trailing-comma split, the wrapped comment
(CAR-221's shape), the join, a split next to a pair, and the near misses
(list item added, `}` after a changed line, extract method); then a
second push that splits a line the first push added, for the since view.
A README row and a description of what to look at.

## Left to the builder

The group weighting against pairs and the "every line holds part of it"
test (within the constraints above); `GROUP_MAX_LINES` if the CPU tests
say otherwise; where the bracket sits in the gutter (no horizontal page
scroll at 360px, no code moved in hunks without a group); the
correction endpoint's shape and hash function (stable, computed the same
in every browser); the selection bar's icons.

## Questions for the owner

1. The mockups said a group can be unpaired "like today's pairs", but
   today no pair can be corrected by hand. This spec adds hand
   unpair/pair for pairs and groups as CAR-130's second PR, stored in the
   reviewer's private ref beside thread moves. Keep it in CAR-130, or
   give it its own ticket?
