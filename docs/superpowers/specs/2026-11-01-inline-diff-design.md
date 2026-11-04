# Highlighting what changed inside a line, step 1: GitHub's rules

Status: approved by the owner (2026-11-02), with the tighter marks.

## Why

The owner (2026-10-31): "in github, in general if I get the specific changes
highlighted I'm delighted, I've never seen a word diff that I felt was
unhelpful. so we should start by doing what they do and see if we can't
improve on it by increasing the number of cases we catch." And on pairs
GitHub leaves plain: "I remember it happening many times."

Today carbonless paints a changed line's whole row red or green. The reader
has to find the change inside a pair of lines by eye: a renamed word in a
120-character call, a `>` that became `>=`. GitHub marks those characters.

Two steps, decided by the owner:

1. **This spec: do what GitHub does.** Every pair of lines GitHub marks,
   carbonless marks, on the same characters (with the exceptions this spec
   lists). Pairs GitHub leaves plain stay plain.
2. **Later, its own spec: catch more.** Pair removed and added lines by
   similarity instead of position, and move the rows with it: "if we do
   that, let's [change] the line positions as well. github line matching
   is no good." That replaces GitHub's positional pairing (the side-by-side
   spec's call) and covers the unequal blocks, shifted pairs, splits/joins
   and moved lines below.

## What GitHub does (measured)

Measured on 178 public PRs (1,791 change blocks, 905 pairs) and confirmed on
the gallery case https://github.com/Gilthans/carbonless-gallery/pull/14 (79
case files) signed in, unified and split, Hide whitespace off and on. The
evidence is in the recon report; the observed marks of every PR #14 pair are
the test fixture (below).

- **Blocks.** A block is a run of removed lines directly followed by a run of
  added lines (context ends a block). Only a block with as many added lines
  as removed lines gets marks; its i-th removed line is paired with its i-th
  added line. Any other shape (1/2, 3/1, 2/3…) is entirely plain: 0 of 380
  unequal blocks had a mark. No size limit through 50/50.
- **No similarity threshold.** Every pair of an equal block is marked, down
  to 10% similar; very different lines get long marks, not none. (The
  owner's "% match" guess: the measure found none.)
- **Length.** A pair is plain when either line is 1,024 characters or longer
  (1,023 is marked; characters, not bytes). Only that pair goes plain; the
  block's other pairs keep their marks.
- **Tokens.** Marks cover whole tokens: a token is a run of Unicode letters,
  digits and `_` (`café`, a CJK run, `recieve` → `receive` all whole); every
  other character is a token of its own (each space, each punctuation
  mark, each emoji). camelCase is not split.
- **The diff in a pair** is a token diff that folds small unchanged pieces
  between changes into one mark: `const area = width * height` →
  `const area  =  width*height` marks `= width * ` / ` =  width*` (the
  unchanged `width` folded in), while separate changes far apart stay
  separate marks. Carbonless aligns words first and folds nothing (see
  **What** under **The marks**).
- **Whitespace.** Indentation and inner spaces are tokens like any other: a
  re-indent is marked, an added indent after the kept one. A pair that
  differs only by `\r\n` vs `\n` shows no marks (carbonless marks that
  `\r`: see **What**). With Hide whitespace on,
  whitespace-only pairs are gone; every other pair keeps the same marks,
  whitespace marks included.
- **Split = unified.** Split view marks exactly the characters unified does
  (13,836 lines compared).

## What carbonless does

### The marks

- **Where:** in a removed line and an added line that form a pair under the
  rules above, in both views. In unified the pair is the block's i-th
  removed and i-th added line (rows apart); in side by side it is the pair
  row's two halves (the side-by-side layout already pairs GitHub's way, so
  an equal block's pair rows are exactly the marked pairs; an unequal
  block's pair rows stay plain).
- **What:** the changed tokens, computed by two token diffs of the two
  lines (diff-match-patch over one character per token, no time limit, so
  exact):
  1. **Words first:** the non-whitespace tokens alone. Their equal tokens
     are anchors, so a shared word is never traded for a shared space
     (case `06`: only the changed spaces are marked, never `width`).
  2. **Then the gaps:** each run between two anchors (and before the
     first, after the last) is diffed token by token, spaces included.

  A token is marked when a diff says it changed, and nothing else is:
  no cleanup folds unchanged tokens into a mark (owner, 2026-11-04: "I'd
  rather for the punctuation to be marked separately, instead of the
  entire token"). Adjacent changed tokens merge into one mark, so a run
  of changed words reads as one mark per word with the unchanged spaces
  between them plain. A trailing `\r` both lines end in is never marked;
  one only one line ends in is a changed token and is marked (owner,
  2026-11-04, case `22`). On PR #14 this gives GitHub's exact marks on 143
  of 166 pairs (the 899 public pairs not re-measured). The 23 PR #14
  differences: GitHub folds the unchanged spaces and punctuation between
  changes into one mark (`06`, `11`, `13`, `21`, `30-*`, `31-*`, `41`,
  `46`, `47`), and GitHub doesn't mark a lone `\r` (`22`, `23`); see
  **Decided by the owner**.
- **Look** (mockups in the published page): a stronger tint of the line's own color behind the marked
  characters: new tokens `add-word` / `del-word` (and `add-word-done` /
  `del-word-done` on reviewed lines, the same step up from `add-done` /
  `del-done` as the live marks from their rows). They are GitHub-bright
  (`#1e5a43` / `#5c2441`), the owner's choice over 4.5:1 for every color
  (see **Decided by the owner**): some code colors read under 4.5:1 on
  them, the faint dots and comments most. `theme.test.ts` pins each
  color's contrast on each mark, under no wash, a thread's and a pick's,
  at its value when chosen (it may rise, never drop), and checks the
  add/del hues. No underline, no box: GitHub's convention. Mockups below.
- **With the rest of a line:** syntax colors stay on top of the tint.
  Invisibles (`·`, `\t`, line endings, escapes) inside a marked range are
  marked with it, so a changed indent shows as tinted dots. A thread's
  span (`span-mark`, opaque) wins over a word mark where they overlap; a
  thread's lines (`mark-tint`) and picked lines (`line-picked`) are washes
  over the row and keep showing over word marks.
- **Copy:** marks are background only; a copy gives the code.
- **Accessibility:** marks are visual, as on GitHub; the line's sign and
  its row's accessible name already say it changed. Nothing is announced
  per word. (Call.)

### Ignore whitespace

With "Ignore whitespace" on, a whitespace-only pair is a `~` row (today's
design): no marks. Blocks are formed over the rows as shown, a `~` row
ending a block like a context line, as GitHub's Hide whitespace does. Pairs
that remain keep their whitespace marks, as GitHub does.

### Speed

Marks are computed in the browser from the hunk the page already has: no
server change, nothing new to fetch. A pair is diffed when its row first
renders and memoized with the hunk's rows (the `HunkRows` key already holds
the view settings). The 1,024-character cut bounds the cost per pair.
Marks are computed synchronously, as part of the row's render: a pair is
never shown plain while its marks are pending, since a plain pair already
means "GitHub would mark nothing here" (the owner's loading rule,
2026-11-01: "An empty result should always be easily distinguishable for a
still loading result"). If the budget below ever forces them off the main
thread, a pending pair shows the shared `Spinner` (`src/web/Spinner.tsx`,
design principle 8) in a fixed slot of its rows, never bare plain lines, and
its test holds the work and asserts the spinner (`test/loading.ts`).
Budget (call): computing the marks of 2,000 pairs of 120-character lines
(an equal block, the worst case DiffBody meets, since it renders a file's
rows at once) takes under 100 ms of CPU time (`process.threadCpuUsage`, a
unit test, so it holds on a loaded machine). The first-open and switch times
of a 2,000-line equal-block fixture are measured before and after and put
in the report, not gated (wall clock is too noisy for a 10% gate).

## Non-goals (step 1)

- Marks GitHub doesn't make: unequal blocks, splits/joins, moved lines,
  lines of 1,024+ characters. They are step 2's.
- Pairing by similarity, or changing which lines share a row (step 2).
- A setting to turn marks off (GitHub has none; ask if wanted).
- Any change to what the server sends.

## Anti-goals

- **A mark that hides or replaces anything.** Marks are a tint on
  characters that are already shown; no line, character or invisible
  disappears, and review state never depends on them (principle 2).
- **A mark on an unchanged line or an unchanged token GitHub wouldn't
  mark,** or a context line marked. Marks live only inside removed/added
  lines of a pair.
- **A mark less readable than the owner chose** (any color's contrast
  on it below its pinned floor), or that reads as a different meaning
  than add/del.
- **Slower first opens** beyond the budget.

## Tests

- **Unit, the GitHub fixture:** the gallery PR's 79 base/case file pairs
  (our own playground data, not a real PR's) and GitHub's observed marks
  for them (166 pairs; `[start, end)` in string indices, unequal blocks
  listed with no marks) committed under `test/fixtures/inline-diff/`, with
  the script that rebuilds the files. The test runs the files through
  carbonless's own diff (as the server does) and the marks code, then
  compares: carbonless's blocks are the truth for shape, and every
  difference from GitHub, in which pairs are marked (block shape, length
  cut, Ignore whitespace on and off) or in which characters, is on a
  known-differences list with its reason. The list may only shrink.
- **Unit, properties:** marks are within the line, sorted, non-overlapping,
  on token boundaries; unmarking every mark gives back both lines' common
  tokens in order (the marks are exactly a diff); the unmarked
  non-whitespace tokens are a longest common subsequence of the lines'
  non-whitespace tokens, and between two of them the unmarked tokens are
  a longest common subsequence of that gap (words first, nothing folds);
  an equal pair has no marks; a pair over the cut and every unequal block
  have none; a `\r` only one line ends in is marked.
- **Unit, render:** a marked token renders with the word tint over its
  syntax color; invisibles inside a mark are marked; a span mark wins;
  reviewed rows use the `-done` tokens.
- **e2e** (desktop and phone, unified and side by side): open the gallery
  fixture's equivalent (a throwaway repo with a handful of PR #14's cases),
  check the marked text of a renamed word, a changed operator, a re-indent,
  an unequal block (no marks), a 1,024-character pair (no marks); Ignore
  whitespace on hides the whitespace-only pair's marks; a screenshot per
  view for the design shots.
- **Contrast:** `theme.test.ts` on the new tokens with every code and
  syntax color, under no wash, accent/8 and accent/10: each pinned at its
  contrast when chosen; the rows at 4.5:1 under the same washes (the
  added row's pick-wash gap, from before, pinned).

## Decided by the owner

- **Tighter marks, not GitHub's folding** (2026-11-02): "You can go ahead
  and use the tighter version. I'm not 100% it's strictly better, but I'm
  not sure it's an interesting edge case anyway, so let's do what's
  easier." Superseded by the next three (2026-11-04).
- **Unchanged words are never marked** (2026-11-04, QA of PR #13, case
  `06`): "Number (6) highlights the "width" token despite it not being
  changed (only whitespace changed)". Words are aligned first (**What**).
- **No folding** (2026-11-04, case `13`): "I'd rather for the punctuation
  to be marked separately, instead of the entire token". No
  `diff_cleanupEfficiency`; very different lines get one mark per changed
  word.
- **A lone `\r` is marked** (2026-11-04, case `22`): "it's very confusing
  to see there's a diff despite having nothing visibly change. Also, when
  hidden characters are shown, the \r is not highlighted - it should be."
  A CRLF-only pair is no longer plain.
- **Bright marks over 4.5:1** (2026-11-02, after comparing four tint
  options in screenshots: as built at 4.5:1, a darker green well, the
  mockup's bright marks, quieter rows with compliant marks): "(d) seems
  much less visible than (c). Let's go with (c) please". The marks are
  the mockup's `#1e5a43` / `#5c2441`; on the green one the faint dots
  read at 2.81:1 and several syntax colors at 3.9–4.1:1.

## Calls made here (the owner may overrule)

- Marks computed in the browser, per pair, lazily.
- Unequal blocks stay plain in step 1, even though the side-by-side rows
  pair them; step 2 is where they change.
- Nothing announced to screen readers per word.
- `~` rows end a block under Ignore whitespace.
- The speed budget is a CPU-time unit test (2,000 pairs under 100 ms);
  page times are measured and reported, not gated.
- The gallery's case files and GitHub's observed marks are committed as
  test fixtures; carbonless's own diff decides block shape, and any
  difference from GitHub is a listed known difference.
- The reviewed marks' values (`#25493b` / `#492840`, the live marks'
  step from their rows applied to the reviewed rows).
