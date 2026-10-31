# Side by side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Side by side" view setting that lays every file's diff out as old-left / new-right pair rows, switchable in place, with the review, threads, whitespace rows and hidden characters all working in both views.

**Architecture:** A pure layout module turns the whitespace module's `DiffRow`s of one cluster run into side-by-side rows (positional pairing between whitespace rows). `DiffBody` renders those rows as one `<tr>` per pair with per-cell paint, keys, bubbles and landing; every row that spans the table takes the view's column count. The setting is a `viewSetting` like the other two; the Files page anchors the reader's row across a setting switch; a `data-selecting` mark keeps a text selection to one side. Nothing server-side changes.

**Tech Stack:** React + TanStack Query + Tailwind (web), Vitest (unit, `src/web/**/*.test.ts(x)` with jsdom), Playwright with the fake gh (`e2e/`), desktop and phone projects.

**Spec:** `docs/superpowers/specs/2026-10-28-side-by-side-diff-design.md`

## Global Constraints

- Principle 2: the layout is pure and property-tested; every removed, added and context line of a hunk is in the rows exactly once per side, in order, on its own side. No AI, no server change, no review-state change on a switch.
- Principle 5: 360px with no horizontal page scroll in either view; the controls column keeps its 40px targets (80px on touch, the two controls side by side as today).
- Principle 6: tokens only (`src/web/index.css` `@theme`); no new colours. The blank cell is `bg-band`.
- Setting key `crb.diff.sideBySide`, label **"Side by side"**, third switch row, off by default.
- Keep on the row: `data-testid="diff-line"`, `data-old-no`, `data-new-no`, `data-reviewed`, `data-landed`, `data-commented`; on the number cells `data-testid="old"` / `"new"`. Unified rendering and its existing tests stay as they are.
- The contract with new threads: every code cell carries `data-side="LEFT" | "RIGHT"`, in both views; a blank cell carries `data-blank` and no side.
- Branch `side-by-side` (worktree `.worktrees/side-by-side`); each task on its own branch from it; `git commit --only -- <paths>`; never push except the gallery repo in Task 5. Merge `m2-threads` into `side-by-side` between tasks (coordinator).

## Review Focus

1. A hunk whose cluster run has whitespace pairs in the middle of plain lines (`-d1 +a1 ~d2/a2 -d3 +a3`) → `[d1|a1] [~d2|~a2] [d3|a3]`, never d3 against a1 (Task 1 composition tests).
2. A file with a four-digit line count opened in side by side on a 360px phone → no page overflow, code still readable (Task 2 phone e2e with a 1,200-line fixture).
3. A thread on the LEFT side of a context line and a landing on it → one bubble in the right cell, both cells painted (Task 2 unit).
4. Switching the view while a thread is open and a whitespace-only cluster is expanded → both stay, and the row under the sticky stack stays where it was (Task 2 e2e for state, Task 3 e2e for the anchor).
5. Drag from the new side across the old, then Ctrl+C → the clipboard holds new-side text only (Task 4 e2e).

---

### Task 1: The layout module and the setting (brief A)

**Files:**
- Create: `src/web/files/sideBySide.ts`, `src/web/files/sideBySide.test.ts`
- Modify: `src/web/viewSettings.ts` (add `sideBySide`), `src/web/Settings.tsx` (third `SwitchRow`), `docs/design/README.md` (Settings paragraph: three rows), `e2e/settings.spec.ts`

**Interfaces (produces, exact):**

```ts
// src/web/files/sideBySide.ts
import type { DiffLine } from "../../shared/types";
import type { DiffRow } from "./whitespace";

/** One row of the side-by-side table: a context line on both sides, or a pair with at least one side. */
export type SideRow =
	| { kind: "context"; line: DiffLine }
	| { kind: "pair"; del?: DiffLine; add?: DiffLine; ws: boolean };

/**
 * One cluster run's (or context run's) rows, laid out side by side: a
 * whitespace row (`ws`) stays one row with each side's own line; the plain
 * removed and added lines between whitespace rows pair by position, the
 * i-th removed against the i-th added, the surplus one-sided.
 */
export function layoutRows(rows: DiffRow[]): SideRow[];

/** Every line of `rows` on its side, in order: what the layout must keep (tests, DiffBody never needs it). */
export function sides(rows: DiffRow[]): { left: DiffLine[]; right: DiffLine[] };
```

```ts
// src/web/viewSettings.ts
/** "Side by side": old left, new right (src/web/files/sideBySide.ts). Off unless turned on. */
export const sideBySide = viewSetting("crb.diff.sideBySide", false);
```

- [ ] **Step 1: Write the failing unit tests** in `src/web/files/sideBySide.test.ts`, with the `del`/`add`/`ctx` helpers and the `trace` style of `whitespace.test.ts` (a trace for `SideRow`: ` o/n` context, `[-o|+n]`, `[-o|]`, `[|+n]`, `[~o|~n]`, `[~o|]`, `[|~n]`):
  - `it("pairs the i-th removed with the i-th added, the surplus one-sided")`: 2 del / 3 add → `[-1|+1] [-2|+2] [|+3]`; 3 / 2 → `[-1|+1] [-2|+2] [-3|]`; 1 / 5; 0 / 3; 3 / 0.
  - `it("shows a context line once on both sides")`: `ctx(4,4)` → `{kind:"context"}`, and `sides` lists it on both.
  - `it("keeps a whitespace pair as one row with each side's own line and pairs the plain lines between")`: rows from `pairHunk` of `-d1 +a1 ~d2/a2 -d3 +a3` (d2, a2 whitespace-equal) → `[-1|+1] [~2|~2] [-3|+3]`; a one-sided ws row `~d/` → `[~o|]`.
  - `it("holds for any input")`: 300 random hunks (lengths 0–12 per side, texts drawn from a 4-word alphabet with random indentation so whitespace twins occur, context lines interleaved; same generator shape as the whitespace property test), for both `rows = run.lines.map(line)` and `rows = pairRun(run.lines, matchHunk(hunk))`: `sides(rows)` equals the del-or-context lines and add-or-context lines of the run in order, and the layout's left cells (del of pairs, line of contexts) and right cells equal them exactly once each; a `pair` row never has `del` with `kind !== "del"` or `add` with `kind !== "add"`; no row has neither side.
- [ ] **Step 2: Run them to see them fail**: `pnpm test src/web/files/sideBySide.test.ts` → fails, module not found.
- [ ] **Step 3: Implement `layoutRows` and `sides`** in `src/web/files/sideBySide.ts`: walk the rows with two pending lists (plain dels, plain adds); on a `ws` row or a context row or the end, flush the pending lists zipped by index into `pair` rows (`ws: false`), then emit the `ws` row as `{kind:"pair", del, add, ws:true}` or the context row.
- [ ] **Step 4: Run them to see them pass**: `pnpm test src/web/files/sideBySide.test.ts` → PASS.
- [ ] **Step 5: The setting**: add `sideBySide` to `viewSettings.ts` (with a `viewSettings.test.ts` case like the whitespace one: default off, remembered, reset), the third `SwitchRow` ("Side by side") in `Settings.tsx`, and the README's Settings paragraph.
- [ ] **Step 6: Settings e2e**: in `e2e/settings.spec.ts`, extend the "Ignore whitespace sits under…" test (or add a sibling) so "Side by side" is the third switch, below "Ignore whitespace" by bounding box, ≥40px tall, off by default, on after a click and after a reload, off again after a second click. Run `pnpm test:e2e e2e/settings.spec.ts --project=chromium` and the phone project → PASS.
- [ ] **Step 7: Commit**: `git commit --only -- src/web/files/sideBySide.ts src/web/files/sideBySide.test.ts src/web/viewSettings.ts src/web/viewSettings.test.ts src/web/Settings.tsx docs/design/README.md e2e/settings.spec.ts -m "web: Side by side setting and the pure side-by-side layout of a run's rows"`.

### Task 2: DiffBody renders side by side (brief B)

**Files:**
- Modify: `src/web/files/DiffBody.tsx` (the whole table), `src/web/files/DiffBody.test.tsx`, `src/web/files/ThreadRow.tsx` (no change if `columns` is already a prop; it is), `src/web/index.css` (cell-level `thread-mark-cell` and `mark-tint-cell` utilities beside the row ones), `docs/product-rules.md` ("Side by side is a view", after the whitespace paragraph, with the invariant), `e2e/files-ui.ts` (helpers), `e2e/sideBySide.spec.ts` (new), `e2e/mobile.spec.ts` (overflow in both views), `e2e/sticky.spec.ts` (one case over a side-by-side cluster)
- Test: as above

**Interfaces:**
- Consumes: `layoutRows`, `SideRow`, `sideBySide` (Task 1); `pairRun`, `runs`, `matchHunk`, `whitespaceOnly` (whitespace.ts); `placeThreads`, `lineKey` (threadPlacement.ts).
- Produces (the DOM contract Tasks 3 and 4 and the new-threads work rely on):
  - Table: `<table data-view="unified" | "side-by-side">`, `w-full table-fixed` in side by side (no `min-w-full`; the scroller `div` stays but never scrolls in this view).
  - Columns in side by side, in order: rail, controls, old number, old code, new number, new code; `columnsOf(view)` returns 5 or 6 and every `colSpan` in the file uses it (hunk header, gap rows, file-level cluster, no-newline row, crossed-off note, `WhitespaceCluster` row, `ThreadRow columns`).
  - Row: `<tr data-testid="diff-line" data-kind="context" | "pair" ...>` with `data-old-no` / `data-new-no` from its cells' lines, `data-reviewed`, `data-landed` (either cell landed), `data-commented` (either cell commented).
  - Number cell: `data-testid="old"` / `"new"`, plus `data-side`; its text is the number or empty on a blank side.
  - Code cell: `data-testid="code"`, `data-side="LEFT" | "RIGHT"`, `data-kind="context" | "add" | "del" | "ws"`, `data-landed` and `data-commented` when so, `whitespace-pre-wrap [overflow-wrap:anywhere]` in side by side. Blank: `data-testid="code" data-blank` (and the number cell `data-blank`), both `bg-band`, no `data-side`, no sign, no text.
  - Unified rows keep today's markup exactly (the code cell gains `data-testid="code"` and `data-side` only: RIGHT for add and context, LEFT for del, RIGHT for a `ws` pair row since it shows the new text).
  - Number columns: `style={{ width: \`calc(${digits}ch + 1rem)\` }}` on every number cell, `digits = Math.max(3, String(Math.max(newLineCount, largest oldNo in the hunks)).length)`, in both views.
- [ ] **Step 1: Write the failing DiffBody unit tests** in `DiffBody.test.tsx` (render with `sideBySide.set(true)` in `beforeEach`, `reset()` after, as the whitespace tests do with `ignoreWhitespace`):
  - a 2 del / 3 add cluster → three `[data-kind="pair"]` rows; the third's old number cell and old code cell have `data-blank`; the cluster's checkbox (`Mark cluster reviewed`) is in the first pair row; `data-old-no`/`data-new-no` on the rows are `5/5`, `6/6`, `/7`.
  - context row → one row, both code cells `data-side` LEFT and RIGHT with the same text, `data-kind="context"`.
  - per-cell paint: the del cell has `bg-del`, the add cell `bg-add`; with the cluster reviewed, `bg-del-done` / `bg-add-done`, numbers likewise.
  - a thread ending on `RIGHT:6` → the bubble (`getByRole("button", {name: /thread/})`) is inside the right code cell of the row with `data-new-no="6"`; a thread ending on `LEFT:6` (the del of the same pair row) → a second bubble in the left code cell; opening the left one puts a `thread-row` right under the pair row, opening both puts the left one first.
  - a thread ending on the LEFT side of a context line (anchor side LEFT, old number) → one bubble, in the right code cell; both code cells carry `data-commented`.
  - landing on `{old: true, line: 6}` → the left code cell has `data-landed`, the right doesn't; landing on a context line → both cells.
  - `noNewline` on the del of a pair whose add has a newline → a "No newline" row whose text is in the left code cell only; both lacking → both cells.
  - both settings on with the `-d1 +a1 ~d2/a2 -d3 +a3` hunk → rows `pair`, `pair` (ws: `data-kind="ws"` on both code cells, each with its own text), `pair`; a whitespace-only cluster → the `ws-cluster` row with `colSpan` 6 and its rows under it when expanded.
  - every spanning row (`gap-row`, hunk header, `ws-cluster`, `thread-row`) has `colSpan` 6 in side by side and 5 in unified.
  - `digits`: a file with `newLineCount` 1200 → number cells `width: calc(4ch + 1rem)`; 80 → `calc(3ch + 1rem)`.
- [ ] **Step 2: Run them to see them fail**: `pnpm test src/web/files/DiffBody.test.tsx` → the new cases fail.
- [ ] **Step 3: Implement** in `DiffBody.tsx`: read `sideBySide.use()` next to `ignoreWhitespace.use()`; `HunkRows` memo key gains it and maps each run's `rows` through `layoutRows` when on; extract from `LineRow` a `NumberCell` and a `CodeCell` (both views use them; the code cell's bubble, sign, `CodeLine`, `data-*` and paint live there) and add a `PairRow` that renders one `<tr>` from a `SideRow` with the keys of each cell (`lineKey("LEFT", del)`, `lineKey("RIGHT", add)`; a context row's right cell gets both keys, its left cell none), the thread rows after it (left side's first), and the no-newline row; `WhitespaceCluster`'s `pinned` check walks the `SideRow`s' cells. Add the two cell utilities to `index.css` (`thread-mark-cell`: the cell's own wash, stripe on a code cell; `mark-tint-cell`: the wash) and keep the row-level rail accent on a landed row.
- [ ] **Step 4: Run the unit tests**: `pnpm test src/web/files` → PASS, including every existing DiffBody, FileDiff and whitespace test unchanged.
- [ ] **Step 5: Write the e2e** `e2e/sideBySide.spec.ts` (fixture: `src/greet.ts` with a 2/3 cluster whose third added line is 300 characters, `src/mixed.ts` from the whitespace fixture, `src/long.ts` with 1,200 lines and a one-line change at line 1,150; a `sideBySide(page, on)` helper beside `ignoreWhitespace` in `files-ui.ts`), desktop and phone:
  - switching on shows `[data-view="side-by-side"]` without a navigation (`page.url()` unchanged) and without a refetch (count `/hunks` requests before and after: equal); the 2/3 cluster has three pair rows, the third with a blank left; marking the cluster reviewed fades both cells (`bg-add-done` on the add cell).
  - the 300-character line wraps: the code cell's `scrollWidth <= clientWidth`, the scroller's too, and the row is taller than one line.
  - with a thread open and (both settings on) a whitespace-only cluster expanded, switching off and on keeps the thread row visible and the cluster expanded.
  - a thread link landing (`?file=…&side=RIGHT&line=…` as `files-threads.spec.ts` does) on a pair row → `[data-landed]` on exactly one code cell.
  - phone: `src/long.ts` at 360px, no page overflow (`expectNoPageOverflow` from `mobile.spec.ts`), the code cells at least 90px wide.
  - `DESIGN_SHOTS` screenshots `side-by-side-{desktop,phone}.png` like the whitespace spec.
- [ ] **Step 6: Extend `e2e/mobile.spec.ts`** (overflow check also with side by side on) and `e2e/sticky.spec.ts` (controls float over a side-by-side cluster: the existing floating assertion repeated with the setting on).
- [ ] **Step 7: Run**: `pnpm test:e2e e2e/sideBySide.spec.ts e2e/mobile.spec.ts e2e/sticky.spec.ts e2e/whitespace.spec.ts e2e/files.spec.ts e2e/files-threads.spec.ts` on both projects → PASS.
- [ ] **Step 8: Docs**: the "Side by side is a view" paragraph in `docs/product-rules.md`.
- [ ] **Step 9: Commit** (one commit, or two: cells and pair rows; e2e and docs).

### Task 3: The reader's row stays put across a setting switch (brief C)

**Files:**
- Modify: `src/web/viewSettings.ts` (`subscribe` becomes public), `src/web/files/scrollAnchor.ts` (`selectors`), `src/web/files/scrollAnchor.test.ts`, `src/web/files/FilesPage.tsx` (capture on either setting's change, restore after), `e2e/sideBySide.spec.ts` (one test, Task 2 owns the file; add it after Task 2 lands), `e2e/whitespace.spec.ts` (the same assertion for the whitespace switch)

**Interfaces:**
- Consumes: `captureAnchor`, `restoreAnchor`, `ScrollAnchor` (scrollAnchor.ts); `sideBySide`, `ignoreWhitespace` (viewSettings.ts); the row DOM contract of Task 2.
- Produces:
  ```ts
  // viewSettings.ts
  export interface ViewSetting { …; /** Runs synchronously inside set(), before React re-renders. */ subscribe(onChange: () => void): () => void }
  // scrollAnchor.ts
  export type ScrollAnchor = { el: Element; /** Tried in order: exact numbers, then old alone, then new alone. */ selectors: string[]; top: number };
  ```
- [ ] **Step 1: Failing unit tests** in `scrollAnchor.test.ts`: `selectors` of a del row (`old=5`) is `[exact, by old]`; of a context row `[exact, by old, by new]`; `restoreAnchor` finds a pair row `[data-old-no="5"][data-new-no="5"]` from an anchor taken on a unified del row `old=5` (and the reverse), and scrolls by the delta.
- [ ] **Step 2: Run to fail**: `pnpm test src/web/files/scrollAnchor.test.ts`.
- [ ] **Step 3: Implement**: `selectorOf` → `selectorsOf`; `restoreAnchor` tries them in order; `viewSettings.ts` exposes `subscribe`; `FilesPage.tsx`: a `useEffect` subscribing to both settings that stores `captureAnchor(diffs.current, appHeader + pageSticky)` in a ref (the same math as the unit switch at lines ~268–280), and a `useLayoutEffect` on `[sideBySide.use(), ignoreWhitespace.use()]` that restores it.
- [ ] **Step 4: Run to pass**: unit, then e2e: a test in `sideBySide.spec.ts` that scrolls `src/long.ts` to line 1,150, switches the view, and asserts that row's `getBoundingClientRect().top` moved by less than 2px; the same in `whitespace.spec.ts` for the whitespace switch on `src/reindent.ts`.
- [ ] **Step 5: Commit**: `web: a view-setting switch keeps the reader's row where it was`.

### Task 4: A text selection stays on one side (brief D)

**Files:**
- Modify: `src/web/files/DiffBody.tsx` (the mark), `src/web/files/DiffBody.test.tsx`, `src/web/index.css` (the `user-select` rule), `e2e/sideBySide.spec.ts`

**Interfaces:**
- Consumes: Task 2's `data-side` code cells and `data-view` table.
- Produces: `table[data-selecting="old" | "new"]` while a selection exists on that side; CSS `table[data-selecting="old"] td[data-side="RIGHT"], table[data-selecting="new"] td[data-side="LEFT"] { user-select: none }`.
- [ ] **Step 1: Failing unit tests**: `pointerdown` on a RIGHT code cell sets `data-selecting="new"` on the table; a `selectionchange` with a collapsed selection (jsdom: `window.getSelection().removeAllRanges()`) clears it; a `selectionchange` with a range inside a LEFT cell sets `old`; in unified the attribute is never set.
- [ ] **Step 2: Run to fail**: `pnpm test src/web/files/DiffBody.test.tsx`.
- [ ] **Step 3: Implement**: `onPointerDown` on the table (target `closest("td[data-side]")`) sets the mark in side by side; a document `selectionchange` listener (registered while the file is open) sets it from the selection's anchor cell or clears it when the selection is collapsed or outside this table.
- [ ] **Step 4: Run to pass**, then e2e in `sideBySide.spec.ts` (desktop project only, the phone project is Chromium too but native touch selection isn't scriptable): drag with the mouse from the right code cell of row 1 to the left code cell of row 3, press `Control+C`, read the clipboard via `page.evaluate(() => navigator.clipboard.readText())` (grant `clipboard-read` in the test's context) → the text equals the right side's three lines and contains no old-side-only text.
- [ ] **Step 5: Commit**: `web: a side-by-side text selection stays on one side`.

### Task 5: Gallery PR, measurements, real-PR check (brief E)

**Files:**
- Create in the gallery repo (`Gilthans/carbonless-gallery`): branches `base/side-by-side` and `case/side-by-side`, a PR, a README row.
- Modify here: `docs/faq.md` only if the check raises a question; the implementation report (scratchpad).
- [ ] **Step 1: The gallery case**: files for each spec case: a cluster with 2 removed / 5 added and one 5 / 2; one line against five; a 400-character line against a short one; a tab-indented file; a lost final newline on one side; a whitespace-only cluster and a mixed one; a context line with threads on both sides (two review comments on the PR, one `LEFT` and one `RIGHT`, on the same context line). Push both branches, open the PR with a description of what to look at, add the README row.
- [ ] **Step 2: Measure** with `pnpm build && node dist/cli.js <gallery PR>` and a Playwright script in the scratchpad: time from the switch click to `[data-view="side-by-side"]` present and painted (`requestAnimationFrame` twice) on the gallery's biggest file and on a 2,000-line-hunk fixture, both ways, desktop; and first open of that file in each view. Report the numbers; if the switch exceeds 100ms on the biggest file, say so (lazy layout is a follow-up, not this task).
- [ ] **Step 3: Compare** the pairs with GitHub's split view on the gallery PR and on the real PR (read-only, `real-pr-check` memory): any pair that differs is written up with the hunk.
- [ ] **Step 4: Report** to the coordinator; nothing to commit here unless `docs/faq.md` changed.

### Coordinator steps (not a brief)

- After Task 1: merge `m2-threads` into `side-by-side`, `pnpm verify`, then start Task 2 (B) and Task 3 (C) in parallel; C's e2e test lands after B.
- After Task 2: merge `m2-threads` again (the new-threads work touches `DiffBody`; resolve against the cell contract), `pnpm verify`, then Tasks 4 and 5 in parallel.
- After every merge: restart the owner's instance and send the link (memory `owner-crb-instance`).
