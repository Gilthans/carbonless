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
`src/web/files/wordBlocks.ts`). Take:

```python
def load(path, retries=3, timeout=30):
```

becoming

```python
def load(
    path,
    retries=3,
    timeout=30,
):
```

No new line is similar enough to pair (`def load(` scores 0.44, under
`PAIR_MIN_SIMILARITY` 0.5), so all six lines are plain: one removed, five
added. CAR-221 is the other shape: a comment line grew and wrapped onto a
second line. Its first line pairs (0.55) and gets marks; the second reads
as a plain added line.

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
  group always has one line on one side. *My call:* rewrapping a
  paragraph is a later step if the real-PR comparison shows it matters.
- **The thread tracer** (`src/shared/tracer/trace.ts`). It keeps
  `alignOrOver` and its own "two lines merged into one" step. *My call.*
- **Correcting pairs or groups by hand.** A follow-up of its own (see the
  end). *My call.*
- Any change to clusters, keys, +/− counts, progress or what is
  unreviewed. The pairing stays a view.

## Anti-goals

- **A group that hides a change.** Every line of a group stays a changed
  line, unreviewed until the reviewer marks it (principle 2). Any text
  that isn't in the other side is marked (owner, 2026-11-24, on reflow
  punctuation: "Mark it. Any added text should be visible"). The only
  exceptions are the break itself: indentation, a trailing `\r`, and a
  comment leader as defined below.
- **A confident wrong group.** In doubt, no group: the lines pair as
  today.
- **Taking anything from today's pairs.** Every pair that exists today
  still exists, unless a group covers its lines; the step 1 GitHub
  fixture and step 2's seven cases keep their rows and marks.

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
  counted; words only when both sides have words). Words-or-all can flip
  as run lines are added, so a streamed LCS keeps both states.
- **Every line holds part of it:** each line of the run shares a
  non-whitespace token with the one line that the lines before it
  haven't already used up. This rule alone keeps step 2's case 1
  (`'beta'` → `'beta',` + `'gamma'`: the joined text scores 0.67) out,
  and also a `}` added after a changed line. *My call*; the exact test is
  the builder's, decided with the rows (before marks).
- **Small enough:** at most `GROUP_MAX_LINES` lines in the run (*my
  call:* 20), the joined text under `WORD_DIFF_MAX` (1,024 characters,
  as for a pair).

### Choosing groups and pairs

Groups join step 2's non-crossing choice as one more kind of item: each
line in at most one pair or group, no two items crossing, the most total
similarity. A group replaces the pairs it would cover only when it holds
more of the line's text than they do (the weighting is the builder's,
tuned on the fixtures and the real-PR comparison). Ties go to today's
layout.

*My call:* equal stretches keep step 1's i-th-with-i-th pairs; groups are
only looked for in unequal ones. A split alone always makes a stretch
unequal, and step 1 promised GitHub's pairs there.

*My call:* a group never spans two runs (two clusters, or two since
pieces); its rows must be adjacent. `hunkPairs` still pairs one-to-one
across runs as today (marks only), so those lines look as they do now.

### Cuts end a group

The server cuts whitespace-only lines into their own clusters whatever
the setting (CAR-218, `matchDisplayHunk`). So a run line that is some
other line's whitespace twin (a lone `)`, `}` or blank line) is in
another run, with Ignore whitespace on or off, and the group stops
there. The one line's text on the far side (say `);`) is then marked as
removed. *My call:* accepted: it over-marks, the safe way. With the
setting on, the `~` row also ends the stretch, as today.

### The marks

*My call:* a group variant of step 1's `tokenMarks`, not `wordMarks` as
is:

- The run is tokenized per line, with step 1's `tokenize`, and the lines'
  tokens are put together with one **gap token** between lines, so `foo`
  at a line's end and `bar` at the next line's start never fuse into one
  word.
- A gap token stands for the break: the line end, a trailing `\r` (CRLF
  files), and the next line's indentation. It matches any run of spaces
  and tabs on the one line, or nothing. It is never marked.
- A **comment leader** at the start of a continuation line is part of the
  break only when the one line and that continuation line are both
  comments with the same leader (`//`, `///`, `#`, `--`, `;`, `%`, `*`
  inside a block comment), and the file is not Markdown. So CAR-221's
  second `//` stays plain, as in the mockups. *My call:* Markdown bullets
  and headings are never absorbed: a new `*` or `#` there is a new item
  and is marked ("Any added text should be visible", owner 2026-11-24).
- Trailing spaces before a break are not part of it: added ones are
  marked (and flagged as hidden, as on any line). *My call.*
- `bridge` (merging two marks across spaces) never bridges across a gap
  token.
- The marks are painted back on each line; one that spans a break is cut
  into one per line.

So a pure split marks nothing. `timeout=30` → `timeout=30,` marks the
comma. Joining `items` / `.map(price)` / `.reduce(sum, 0);` into
`items.map(price).reduce(sum, 1);` marks only `0` and `1`. In the
CAR-221 shape, the added words are marked on both lines; the comma after
`matrix` is in the old line too, so it stays plain (the mockup marks it;
that is wrong).

### Where today's helpers change

- `hunkPairs` returns pairs and groups (an item: one line, its run, which
  side is which).
- `Partners` (`pairOrder.ts`) is one-to-one today; it becomes a map from
  each line to its item, read by `orderRun`, `layoutRows`, `HunkView` and
  `DiffBody`.
- `wordWork.ts` and `wordWorker.ts`: a new job shape (one text and the
  run's texts), keyed by the one line and its run, with done, pending and
  failed kept over every line of the group. Marked on first paint while
  the render's budget lasts, else off the render path, as pairs are.
- `hiddenLines.ts`: `hiddenChange` takes one `partner`. *My call:* in a
  group, the one line's partner is the run's first line and the first
  line's partner is the one line; other run lines have no partner (no
  look-alike or swapped-indent check). The break's indentation and `\r`
  never count as hidden changes. `noNewline` (no newline at end of file)
  is compared between the one line and the run's last line.

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
one new line on the first row on the right, blanks below.

*My call:* the layout's guarantee changes from "a blank cell only once
the other side has run out" to "a blank cell only once the other side
of that gap or group has run out". `docs/product-rules.md` ("Side by
side is a view") and `sideBySide.test.ts`'s property change with it. The
rest holds: every line exactly once per side, each side in order, never
in a cell of the wrong side.

### The bracket

A bracket in the gutter ties the one line to its run, in unified and
side by side, desktop and phone. Unified, it spans all the group's rows;
side by side, it runs down the run's side. Owner, 2026-11-24: "No chip.
The bracket is sufficient". It is drawn with the rows (groups are
decided with the rows, synchronously, as pairs are), so it never appears
late or moves code.

- *My call:* rows inserted inside a group (a thread, a new-comment box)
  don't break it: the bracket runs on past them.
- *My call:* the bracket itself is not interactive. Its text ("Line 12
  split into 12–16", "Lines 7–9 joined into 7") is the accessible name of
  each group row and a tooltip on hover; on a phone it is reached through
  the line-number cell (a 40px target), not the 14px bracket.

### Loading

*My call:* while a group's marks are computed, every line of the group
shows pending (the same treatment as a pending pair, `aria-busy`), never
plain; a failure shows failed on every line (principle 8).

### The since view and Find in PR

Groups come from `hunkView`, so the since view gets them on the
interdiff's hunks, cut at its pieces, exactly as the full diff gets them
on its own (principle 9: interdiffs are first-class). Example: patch set
1 adds `def load(path, retries=3, timeout=30):`, patch set 2 splits it.
Since patch set 1, the old line and its run are one group; against the
base, all five lines are plain additions.

Find in PR reads `hunkView`'s rows (`findInPr.ts`), so its order of hits
follows the group layout with no new work. It draws its own hit marks,
not word marks.

### Threads and line picks

A thread stays on its line's row wherever the row goes
(`threadPlacement.ts`); ranges and picks behave over group rows as they
do over pair rows today.

### Caps and CPU

*My call:* groups never take budget from pairs. Pairs are chosen first,
inside step 2's guards and `HUNK_ALIGN_WORD_OPS`, exactly as today;
groups are scored from what that leaves of the hunk's budget, and a
stretch whose groups don't fit keeps its pairs. A test checks that a
hunk's pairs are identical with and without groups wherever no group
replaced them. `ALIGN_WORD_OPS` stays the per-stretch guard for pairs;
group scoring has the same guard on its own estimate. Hint: for a fixed
one line and run start, the bit-parallel LCS can stream the run's lines
over the one line's masks, so every run length costs about one LCS over
the longest run.

### Known limit

A split that changes behaviour by its line break alone (`return` / `x` in
JavaScript, a break inside a string literal) is a pure split by the
owner's rule, so nothing is marked. Its lines are still green, changed
and unreviewed until marked (principle 2 holds). *My call:* stated, no
change.

## Docs to update in the same change

- `docs/product-rules.md`: a short section "A line split or joined pairs
  as a group": the rule, the bracket, the break (indentation, `\r`,
  comment leaders, never Markdown), that coverage is untouched, that
  cuts end a group, the since view. And "Side by side is a view": the
  blank-cell guarantee per gap or group.
- `docs/faq.md`, "Why are lines in a different order, or marked where
  GitHub shows none?": a split or join reads as one group with a bracket.
- `2026-11-08-inline-diff-step2-design.md`: its non-goal "one line
  drawing on two" points here for splits and joins; extract method
  stays out.

## Tests

- **Unit, cases:** the pure split (no marks, five lines in the group);
  the split with a new trailing comma (only the comma); the CAR-221
  shape, made-up code (the added words on both lines, the comma after
  `matrix` and the second `//` plain); the join (`0` and `1` only); a
  split next to an ordinary pair in the same stretch.
- **Unit, near misses (hard tests):** step 2's case 1 (list item added)
  and a `}` added after a changed line: no group. Step 2's seven cases
  and the step 1 GitHub fixture unchanged.
- **Unit, the break:** a CRLF file's pure split marks nothing and flags
  nothing hidden; a mixed-ending split marks the odd `\r`. A Markdown
  bullet or heading split into two marks the new `*` or `#`; a code
  comment split keeps its leader plain; a comment split into a
  non-comment line marks it. `foo` / `bar` across a break never read as
  one word.
- **Unit, properties** (random stretches, `linePairing.test.ts` style):
  items never cross; each line in at most one item; every group's run
  adjacent, inside one run of the view, at most `GROUP_MAX_LINES`; every
  run line shares text with the one line; with groups, the same
  clusters, keys and counts as without (principle 2). Marks: a pure
  split or join of random lines (random breaks, random indentation)
  gives no marks; any token inserted anywhere in the run is marked, on
  the line it sits on. Layout: `sideBySide.test.ts` (the changed blank
  rule) and `pairOrder.test.ts` over stretches with groups; every group's
  rows adjacent in unified.
- **Unit, budget:** a hunk's pairs are identical with and without groups
  wherever no group replaced them, including a hunk at the budget's edge.
- **Cuts:** a split whose closing `)` has a whitespace twin elsewhere in
  the hunk, with Ignore whitespace off and on: the group stops at the
  cut and the far text is marked removed.
- **Ignore whitespace:** a pure split keeps its cluster counted with the
  switch on.
- **CPU** (`test/cpu.ts`): the worst stretch inside the guards, with
  groups, against step 2's reference workload (plain word steps); a hunk
  of 40 such stretches, in `hunkPairs` and in Find; a scaling check on
  run length (a run 4x as long against four of a quarter).
- **e2e** (desktop and phone, unified and side by side): the split, the
  CAR-221 shape and the join from a throwaway repo: which rows the
  bracket spans (also across a thread inside the group), the rows'
  accessible name, the marked text, a thread on a group line staying
  with it; group lines pending while their marks are held, then marked;
  the since view's split from patch set 2; Find stepping through a
  group's rows in shown order; `expectEveryUnitMarkable` on a file with
  groups. Groups add no new row kind.
- **Real-PR comparison** (before merge, not CI, part of the owner's QA):
  `scripts/pairing-compare.mjs` grows a page of every stretch whose
  layout groups change, worst first; the owner marks each fine or bad.

## Gallery

One PR, `base/split-joined-lines` and `case/split-joined-lines`, made-up
code: the pure split, the trailing-comma split, the wrapped comment
(CAR-221's shape), the join, a split next to a pair, a CRLF file, a
Markdown bullet split, a split cut by a whitespace twin, and the near
misses (list item added, `}` after a changed line, extract method); then
a second push that splits a line the first push added, for the since
view. A README row and a description of what to look at. (Mockup 1 holds
both the pure split and the comma; the gallery keeps them apart.)

## Left to the builder

The group weighting against pairs and the "every line holds part of it"
test (within the constraints above); `GROUP_MAX_LINES` if the CPU tests
say otherwise; where the bracket sits in the gutter (no horizontal page
scroll at 360px, no code moved in hunks without a group); the exact
comment-leader list per language.

## Follow-up (separate ticket, pending owner)

Correcting pairs and groups by hand (principle 1). The mockups said a
group "can be unpaired by hand like today's pairs", but today no pair
can be corrected by hand. Problems found while drafting, for that
ticket's own design:

- Picking: `pickRange` (`linePicks.ts`) extends a pick in GitHub's order
  (all removed lines, then all added), so a group or pair is usually not
  a contiguous pick; the selection bar alone can't offer Pair/Unpair.
- Undo needs its own event (as `thread-move-undone`), not the opposite
  action, which would pin a hand pairing forever.
- Learning: per review (matched by content within it), or carried to
  other PRs as the reviewer's preferences?
- Loading: corrections must come from a local read (the hunks response,
  or a local-only endpoint), never gate the diff on anything slow.

## Questions for the owner

1. Open a separate ticket for correcting pairs and groups by hand (the
   follow-up above)? The mockups promised it "like today's pairs", but
   no pair can be corrected today.
