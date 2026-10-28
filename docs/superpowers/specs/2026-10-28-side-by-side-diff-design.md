# Side by side: a two-column diff view

Status: draft for the owner's review, 2026-10-28.

Calls the coordinator made (the owner may overrule) are marked **(call)**.

Spec with mockups: https://claude.ai/artifact/Cm7YgrD4BCNak8mPRd1dkP

## Why

The owner asked, as side work next to the threads milestone, for the second diff option after "Ignore whitespace":

> "take a look at the implications of adding a 2-way diff view as an option. I'd like it to be togglable without reloading, like the whitespace change"

Decisions the owner made on the assessment (2026-10-28):

> "Wrap is always better."
>
> "Show it - it might be cramped, but it should be an option" (the switch on a phone)
>
> "branch it after new threads"
>
> "Github-style two way is what I had in mind"

## Goals

- **A side-by-side view of every file's diff**: old file on the left, new on the right, changed lines paired GitHub-style, unchanged lines on both sides.
- **A setting like "Ignore whitespace"**: a switch in Settings, remembered per viewer, taking effect at once in every open file, no reload, nothing lost (open threads, an expanded whitespace-only cluster, the line under the reader).
- **The same review on either view**: clusters, their rails and controls, +/− counts, progress, threads, thread links and landings, hidden characters, "Ignore whitespace" and the coming text selection all work in both views, and switching never changes any review state.
- **Works on a phone** with the view's own limits: cramped, but there.

## Non-goals (this stage)

- Word-level (intra-line) highlighting of what changed inside a pair. The pair rows are where it will hook in; it gets its own spec.
- Smarter pairing than GitHub's (by similarity, by AI, editable by hand). Positional pairing first.
- A per-file or per-PR view choice. One setting for the viewer, like the other two.
- Any change to what the server sends.

## Anti-goals

- **A line that is in the unified view but not in the side-by-side view, or shown twice.** The view is a layout of the hunk's lines, every removed and added line exactly once, each on its own side; the pairing is pure and property-tested like the whitespace one (principle 2).
- **The switch changing review state** (a cluster marked, a thread resolved) or the server's counts.
- **A page that scrolls sideways on a phone** (principle 5). Side by side wraps; it never widens the page.
- **A text selection that mixes the two sides.** Selecting on the new side selects new text only, and copying gives one side.

## The setting

- `viewSetting("crb.diff.sideBySide", false)` in `src/web/viewSettings.ts`, named **"Side by side"**, the third switch row in Settings under "Ignore whitespace", off by default, remembered in localStorage like the other two (storage is a convenience: without it the default holds).
- Shown on every screen size, a phone included (owner's call). It takes effect on a phone too.
- Switching re-renders the open files in place. Nothing reloads and nothing is refetched: the hunks are the same, the rows are laid out again. `HunkRows` already memoizes a hunk's rows per setting; the new setting joins its key.
- **The reader's line stays put (call).** The toggle uses the Files page's scroll anchor (`src/web/files/scrollAnchor.ts`, what the unit switch uses): the first row at the sticky stack before the switch is found again by its numbers after it, and the page scrolls by however far it moved. "Ignore whitespace" gets the same treatment in the same change, since the two settings share the code path.
- State that lives in the rows survives the switch: open thread bubbles (keyed by line, in `DiffBody`), an expanded whitespace-only cluster (its `tbody` keeps its key), a landing highlight in progress.

## The rows

The unit of layout is one row of the table per **pair**: a left cell (old side) and a right cell (new side), each holding a line or nothing.

**Pairing, per cluster run.** The server lays a cluster out as its removed lines, then its added ones (`src/server/diff/hunks.ts`). In side-by-side the i-th removed line sits against the i-th added line; when one side runs out, the remaining lines sit against a blank cell. This is GitHub's rule.

**With "Ignore whitespace" on**, the whitespace pairing (`src/web/files/whitespace.ts`) runs first: a whitespace-equal removed/added pair is already one two-sided row and shows as one `~` row with both sides; a one-sided `~` row (its twin elsewhere) sits against a blank. The removed and added lines left between whitespace rows pair positionally among themselves, in order. So the whitespace view's rows are the input of the side-by-side layout, never the other way round, and the two settings compose without either knowing the other's rules.

**Context lines** show on both sides, the same text, with their old number on the left and new number on the right. Expanded context (gap rows' loaded lines) the same.

**Rows that span both sides, unchanged from unified:** the hunk header, gap rows (the ↑/↓ buttons and "N hidden lines"), the collapsed whitespace-only cluster row, a file-level cluster, a crossed-off note, an opened thread row.

**"No newline at end of file"** shows under the side whose line lacks it, in that side's cell of a row of its own (a pair where both sides lack it shows it on both).

**The invariant**, pure and checked for any input as the whitespace one is: every removed, added and context line of the hunk appears in the rows exactly once (context lines once per side), left cells in old-file order, right cells in new-file order, and a changed line is never in a cell of the wrong side. The layout is a function of the hunk's `DiffRow`s to its side-by-side rows, in `src/web/files/sideBySide.ts` (name is the builder's), with no React in it.

## The table

- Columns: rail, controls, old number, old code, new number, new code. The sign (`+`, `−`, `~`, space) stays inside the code cell as today. The `COLUMNS` constant becomes a per-view value; every spanning row uses it.
- **Equal halves that wrap.** The table is the container's width (no sideways scroll in this view), the two code columns are equal (`table-layout: fixed` or equivalent), and code wraps inside its cell (`white-space: pre-wrap`, breaking anywhere) so a long line grows the row's height on its side while the other side's cell stays aligned with it. Tabs keep their configured width (`CodeLine`'s `tabWidth`). Number cells stay top-aligned, as they are. Unified keeps its sideways scroll as today.
- **Per-side paint.** Every class that is a row class today becomes a cell class on its side: the add/del tint and gutter, the sign color, the reviewed fade (`add-done`/`del-done`), the `thread-mark` stripe and tinted numbers of a commented range, and the landing highlight. The rail and the controls cell are the row's (one cluster spans both sides).
- **A blank cell** (no line on that side) is painted in the `band` tone with no number and no sign **(call)**, so it reads as "nothing here" and not as an empty line.
- **Gutters (call).** Today's columns are fixed: 4px rail, 44px controls (80px on touch: the checkbox and ⊘ each a 40px target, side by side so a mis-tap can't reach the other), 48px per number column (room for four digits). The controls column is the cluster's: its controls sit on the cluster's first row and float over it as the reviewer scrolls, so the column is empty on every other row, which is what reads as dead space in a mockup. That stays. The number columns become as wide as the file's largest line number needs (three digits at least), in both views, which is where side by side can give the code back some width without touching targets.
- **Phone.** The same table at 360px: the controls column keeps its 80px of touch targets, number cells at their digit width, and the two code halves share what is left (about 100px each on a four-digit file), wrapping as needed. Cramped, as the owner accepted. No page overflow at 360px in either view (`e2e/mobile.spec.ts` covers both).

## Threads

- A thread's bubble sits in the cell of its side: a thread ending on a removed line in the left cell of its pair row, on an added line in the right cell. A context row carries one bubble, in the right (new) cell, for threads ending on either side of that line **(call)**.
- Opening a bubble opens a thread row under the pair row, spanning both sides (the `ThreadRow` of today with the view's column count). A pair row whose two cells both have bubbles has two toggles and may open both threads' rows, one under the other, left side first.
- `rowKeys`/`LineKey` stay as they are (`LEFT:n`, `RIGHT:n`); what changes is that a pair row has two cells with one key each instead of one row with up to two keys. Open-bubble state keeps its keys across the switch.
- A thread link's landing finds its row by the side's number as today (`tr[data-old-no]` / `tr[data-new-no]`), scrolls to it and highlights **only the cell of that side**. A landing on a whitespace-only cluster's line still pins it open.
- **A context line is one line shown twice (call).** Its commented mark and a landing on it paint both cells, whichever side the thread names; its one bubble is in the right cell; selecting it in either cell maps to `RIGHT`, as the new-threads spec says context rows do. Removed and added lines are the only ones whose cell decides the side.
- **The contract with new threads (call):** every code cell carries `data-side="LEFT" | "RIGHT"` in both views (unified has one code cell per row, so this is a no-op there), and the selection-to-span mapping reads the side from that cell and the line from the row's number on that side. The new-threads spec (`docs/superpowers/specs/2026-10-27-new-threads-design.md`) is amended to say the side comes from the cell, so its mapping is side-aware from the start and side by side needs no rework of it. The owner's order is new threads first, then this; the builder check noted the cheaper order would be this row-to-cell refactor first, so new threads is written once against cells. That is the owner's call.
- A thread's commented range is a set of line keys (`FilePlacement.covered`); in side by side a cell is marked when its own key is in it. So a range across sides (a GitHub `start_side: LEFT` to `side: RIGHT` comment, or one made in the unified view) paints the old-side cells of its old lines and the new-side cells of its new lines, with no new rule.

## Text selection

- A pointer or touch that starts a selection in one side's code cells marks the table (`data-selecting="old" | "new"`) for as long as a selection exists there (not only until the pointer lifts: Ctrl+C after the drag must still give one side); while marked, the other side's code cells are `user-select: none`. Dragging across the table selects one side only, and Copy gives that side's lines, as GitHub does. A drag takes a row's text on the selected side only once the pointer is over that side's cell; while it is over the other side, the selection ends with the previous row (the browser resolves a point over unselectable text to the nearest selectable position before it, as in GitHub's split view).
- **Selecting by line numbers may cross sides (call):** clicking an old number and shift-clicking a new one picks the rows between them, in diff order, exactly as the new-threads spec allows ("a range across sides"), and the comment goes to GitHub as `start_side: LEFT` … `side: RIGHT`. The one-side rule is for text selection only, where mixing sides would produce interleaved text.
- Line numbers and signs stay `select-none`, so the copy fix for hidden characters (`src/web/code/Invisibles.tsx`) works unchanged.
- Keyboard selection (Shift+arrows) inside one cell is unaffected.

## Performance

- Context lines render twice (two `CodeLine`s per context line), so the DOM for context roughly doubles; changed lines don't. Hidden characters and syntax tokens are computed per line as today.
- Measured on first open (`docs/product-rules.md`, "First open is the performance target") on the gallery's biggest file and on a 2,000-line hunk, in both views, before and after the switch. The numbers go in the implementation report; if the switch takes longer than a blink on the biggest file, the rows of files outside the viewport are laid out lazily, which the builder decides.

## Docs, branch, gallery

- `docs/design/README.md` (Settings paragraph: three rows), `docs/product-rules.md` (a sibling of "Ignore whitespace is a view": "Side by side is a view", with the invariant), `docs/faq.md` if a question comes up on the real PR.
- Branch `side-by-side` from `m2-threads` **after the new-threads work lands** (owner), merged on the owner's word after a green `pnpm verify`.
- Gallery PR (`Gilthans/carbonless-gallery`, per CLAUDE.md): one case for side by side with what the layout must get right: a cluster with more removed than added lines and one the other way; a cluster of one line against five; a long line that wraps against a short one; tabs; a lost final newline on one side; a whitespace-only cluster and a mixed one (for the composition with "Ignore whitespace"); a context line with threads on both sides. The whitespace gallery PR #1 is reused for the composition cases where it already has them.

## Tests

- Unit (Vitest):
  - the layout's invariant for any input (property test, like `whitespace.test.ts`): every line exactly once per side, in order, on its own side, blanks only where one side is shorter;
  - GitHub-style cases: 2 removed / 3 added, 3 / 2, 1 / 5, 0 / n, n / 0; a run of context only; a hunk with several clusters;
  - composition with the whitespace rows: a `~` pair stays one row, a one-sided `~` faces a blank, the lines between pair positionally;
  - "No newline" on one side, on both;
  - `DiffBody`: per-cell classes (tint, reviewed fade, thread mark, landing) land on the right cell; a blank cell has no number, sign or key; a context row's bubble is in the right cell; a pair row with bubbles on both sides opens both; the column count on every spanning row;
  - the selection mark: the other side is `select-none` while one side is being selected;
  - the scroll anchor on the switch (the anchor row is found by its numbers after the layout changes).
- Playwright (desktop and phone):
  - Settings: "Side by side" is the third row, off by default, remembered across a reload (`e2e/settings.spec.ts`);
  - the switch lays the open file out again without a reload (no navigation, no refetch), keeps the row under the sticky stack where it was, keeps an open thread open and an expanded whitespace-only cluster expanded;
  - a 2/3 cluster shows two pair rows and one row with a blank left cell; the cluster's checkbox and rail are on the first pair row; marking it reviewed fades both sides;
  - a thread link lands on a pair row and highlights one cell;
  - a long line wraps and the table does not scroll sideways; at 360px no page overflow in either view;
  - selecting across both sides copies one side only;
  - with both settings on, a whitespace-only cluster is one collapsed row and a mixed cluster shows `~` pairs between positional pairs;
  - sticky cluster controls float over a side-by-side cluster (`e2e/sticky.spec.ts`).
- Real PR, read-only: open the gallery PR and the real PR of `docs/product-rules.md` in both views and compare the pairs with GitHub's split view.

## Left to the builder

- The layout module's shape and the per-cell data attributes the tests and `scrollAnchor` use (keep `data-testid="diff-line"`, `data-old-no` and `data-new-no` on the row; the `old`/`new` test ids on the number cells).
- How the selection mark is set and cleared (pointer events on the table, `selectionchange`, or both), as long as the phone's native selection gets the same treatment.
- Where the "No newline at end of file" note row goes when the two sides' last lines sit in different pair rows (under each side's own row is fine).
- `scrollAnchor`'s row selector, which today matches a row by "has this number and not the other"; a pair row has both.
- Whether the two touch controls can stack in a 40px column on a phone in side by side without their targets reaching neighbouring rows (a one-line cluster is 20px tall); if not, the 80px column stays.
- Whether the blank cell carries a hatch or stays plain `band`, within the tokens.
- Lazy layout of off-screen files, only if the measurements call for it.
