# A line split into several, or several joined into one (CAR-130) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One old line pairs with the run of new lines it became (or a run of old lines with the one new line): a *group*, drawn with a gutter bracket, whose word marks show only text that really changed.

**Architecture:** Groups are found after today's pairs, per stretch, inside one run of the view (`src/shared/linePairing.ts` `alignGroups`, `src/shared/hunkPairs.ts` `hunkItems`). `hunkView` carries them as items next to pairs; `orderRun`, `layoutRows` and DiffBody lay them out; `groupMarks` (`wordDiff.ts`) diffs the one line against the run joined with gap tokens; `wordWork.ts` schedules group jobs like pair jobs.

**Tech Stack:** TypeScript, React, Vitest + fast-check, Playwright (desktop + phone).

**Spec:** `docs/superpowers/specs/2026-11-24-split-joined-lines-design.md` (approved by the owner 2026-11-27, "Let's implement"). Mockups: the spec's link. Read the spec before your task; it is the authority.

## Global Constraints

- Coverage untouched (principle 2): groups change no cluster, key, +/− count, progress or review state; every group line stays a changed, unreviewed line.
- In doubt, no group; every pair that exists today still exists unless a group covers its lines. Step 1's GitHub fixture (`wordBlocks.fixture.test.ts`) and step 2's seven cases (`linePairing.test.ts`) keep their rows and marks.
- `GROUP_MAX_LINES = 20` (run lines); joined run text `< WORD_DIFF_MAX` (1,024); group threshold `PAIR_MIN_SIMILARITY` (0.5).
- Equal stretches (as many added as removed lines) never get groups: step 1's i-th-with-i-th pairs.
- A group never spans two runs of the view (two clusters, or two since pieces); `~` rows and context rows end a stretch as today.
- Pairs first: `alignCluster` runs exactly as today, groups score from what is left of the hunk's budget; a stretch whose groups don't fit keeps its pairs.
- Never marked: the break itself (line end, trailing `\r`, next line's indentation, and a comment leader only when both lines are comments with the same leader in a non-Markdown file). Everything else not in the other side is marked (owner: "Any added text should be visible").
- Bracket: no chip, not interactive, `aria-hidden`; its text ("Line 12 split into 12–16", "Lines 7–9 joined into 7", en dash) is in each group row's accessible name and a hover tooltip; on a phone it is reached through the 40px line-number cell. No horizontal page scroll at 360px; hunks without a group don't move.
- Loading: every line of a group pending while its marks are computed (the existing spinner sign, `aria-busy`), failed on every line on failure (principle 8).
- Since view (principle 9): everything works on interdiff hunks exactly as on the full diff.
- The agent's `diff` read (`src/server/agent/reads.ts`) keeps `hunkPairs` as today: pairs only, no groups (Ruling: the page and the agent read differ where a group replaced a pair; adding groups to the agent read is its own ticket if wanted).
- Repo is public: made-up code only in tests, fixtures and the gallery.
- Checks: `pnpm verify:fast` and targeted specs only, never a full `pnpm verify`. Commit with `git commit --only -- <paths>`.

## Review Focus

1. A stretch where a pair and a group compete for the same line (CAR-221 shape: the first new line pairs at 0.55 today): the group wins only when it holds more of the line; neighbouring pairs untouched. Test in Task 1.
2. A run line that is someone's whitespace twin (lone `)`, `}`, blank line) with Ignore whitespace on and off: the group stops at the cut and the far text is marked removed, never a crash or a group across runs. Test in Task 4.
3. Long or many-line inputs at the edge: a 21-line split, a joined text of 1,024 chars, a hunk at the budget's edge: no group, today's pairs, no CPU blow-up. Tests in Task 1.
4. A thread or new-comment box opened on a middle line of a group: the bracket runs past it, the thread stays on its line. Test in Task 5.
5. A whitespace toggle or view toggle on a file with groups: marks are reused (not recomputed, never stuck pending), rows stay adjacent. Tests in Tasks 3 and 5.

---

### Task 1: Finding groups (pairs first)

**Files:**
- Modify: `src/shared/linePairing.ts` (add `GROUP_MAX_LINES`, `alignGroups`)
- Modify: `src/shared/hunkPairs.ts` (add `LineGroup`, `HunkItems`, `hunkItems`; `hunkPairs` unchanged in behaviour)
- Test: `src/web/files/linePairing.test.ts`, `src/web/files/wordBlocks.test.ts` (CPU), new `src/shared/hunkItems.test.ts` if cleaner

**Interfaces:**
- Produces (`src/shared/hunkPairs.ts`):
  ```ts
  /** One line (`one`) and the adjacent run it split into or was joined from. `one.kind === "del"`: a split (run = added lines); `"add"`: a join (run = removed lines). run.length in [2, GROUP_MAX_LINES], in order. */
  export type LineGroup = { one: DiffLine; run: readonly DiffLine[] };
  export type HunkItems = { pairs: LinePair[]; groups: LineGroup[] };
  /** `runs`: the hunk's view runs' rows in git order (hunkView's `git`). Pairs as hunkPairs(runs.flat()) wherever no group replaced them; groups only inside one run. */
  export function hunkItems(runs: readonly (readonly DiffRow[])[], budget?: number): HunkItems;
  ```
- Produces (`src/shared/linePairing.ts`):
  ```ts
  export const GROUP_MAX_LINES = 20;
  /** Groups of one unequal stretch, given today's pairs (index pairs from alignCluster). `runOf[i]`/`runOf[j]`: view-run index of each del/add (a group's lines share one). Returns the chosen items: kept pairs and groups, non-crossing, each line in at most one. */
  export function alignGroups(
    dels: readonly string[], adds: readonly string[],
    pairs: readonly [number, number][],
    runOfDel: readonly number[], runOfAdd: readonly number[],
    budget?: AlignBudget,
  ): { pairs: [number, number][]; groups: { one: "del" | "add"; at: number; from: number; to: number }[] };
  // group: `at` = index of the one line on its side; run = [from, to) on the other side.
  ```

Candidate rules (spec, "What a group is"): one line × run of 2..20 adjacent lines on the other side, same view run; `score(one, joined run)` ≥ 0.5 with step 2's `score` (whitespace not counted; words-only when both sides have words); joined text < 1,024 chars; **every line holds part of it**: walking the run in order with a multiset of the one line's non-whitespace tokens, each run line must remove at least one token still in the multiset (it removes all of its tokens it finds there). Prefilter starts with `overlaps`. Score every run length for a fixed (one, start) by streaming the run's tokens over the one line's masks (Hyyrö LCS keeps state; read the zero count after each line), keeping the words and all-token states both.

Choice: a DP like `alignCluster`'s over items = today's pairs (weight = their similarity) + group candidates (starting weight `g × run.length`; tune on the tests and the fixtures, document the final formula in the doc comment), non-crossing, each line once, best total; ties go to today's pairs. Group cost estimate (Σ over one lines of ⌈tokens/32⌉ × Σ tokens of its candidate windows) must be ≤ `ALIGN_WORD_OPS` per stretch and is taken from the hunk budget left after the pairs; if it doesn't fit, the stretch keeps its pairs and later stretches get no groups.

- [ ] **Step 1: Write failing tests** (made-up code; names as given):
  - `"a pure split is one group of five"`: dels `["def load(path, retries=3, timeout=30):"]`, adds `["def load(", "    path,", "    retries=3,", "    timeout=30,", "):"]` → one group `{one:"del", at:0, from:0, to:5}`, no pairs.
  - `"a wrapped comment groups over today's 0.55 pair"`: CAR-221 shape, e.g. del `"// Scale each row by the factor, matrix rows first"`, adds `["// Scale each row by the factor, matrix", "// rows first, then the columns"]` → group `to:2`, no pair.
  - `"a join is one group"`: dels `["const total = items", "  .map(price)", "  .reduce(sum, 0);"]`, add `["const total = items.map(price).reduce(sum, 1);"]` → `{one:"add", at:0, from:0, to:3}`.
  - `"a split next to a pair"`: a split plus an unrelated edited line in the same stretch → both the group and the pair.
  - Near misses → no group, pairs exactly as `alignCluster`: step 2 case 1 (`'beta'` → `'beta',` + `'gamma'`), and `"if (ready) {"` → `"if (isReady) {"` + `"}"`.
  - Limits → no group: a split into 21 lines; a joined text of 1,024 chars; run lines in two view runs (stops at the boundary: the group is the part inside the one line's run, if ≥ 2 lines and it still scores).
  - `"equal stretches keep i-th with i-th"` via `hunkItems`: 2 dels / 2 adds where one is a split → pairs only.
  - Properties (fast-check, `linePairing.test.ts` style, random stretches over a small vocabulary): items never cross; each line in at most one item; every group's run adjacent, one view run, length 2..20; every run line shares a token with the one line; **`hunkItems(...).pairs` equals `hunkPairs(rows)` minus the pairs whose lines are in a group** (pairs identical with and without groups), including a hunk built so the pairs use the budget's last word steps.
  - CPU (`test/cpu.ts`, `bestCpuRatio`, ratio to step 2's reference workload as in `wordBlocks.test.ts`): the worst stretch inside the guards with groups; a hunk of 40 such stretches in `hunkItems`; scaling: a run 4× as long vs four of a quarter.
- [ ] **Step 2: Run** `pnpm test src/web/files/linePairing.test.ts src/web/files/wordBlocks.test.ts` — expect the new tests to FAIL (not defined).
- [ ] **Step 3: Implement** `alignGroups` and `hunkItems` as above. `hunkPairs` keeps its signature and output (the agent read uses it).
- [ ] **Step 4: Run** the tests again plus `pnpm test src/web/files/wordBlocks.fixture.test.ts` — PASS, the fixture unchanged.
- [ ] **Step 5: Commit** `git commit --only -- src/shared src/web/files/linePairing.test.ts src/web/files/wordBlocks.test.ts -m "Split/join groups: find them after today's pairs (CAR-130)"`

### Task 2: Group word marks

**Files:**
- Modify: `src/web/files/wordDiff.ts` (add `groupMarks`, `commentLeader`)
- Test: `src/web/files/wordDiff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GroupMarkJob = { one: string; run: readonly string[]; oneIsOld: boolean; markdown: boolean };
  /** Marks of the one line and of each run line (bridged per line, never across a break). No marks when one or the joined run is ≥ WORD_DIFF_MAX. */
  export function groupMarks(job: GroupMarkJob): { one: Mark[]; run: Mark[][] };
  ```

Rules (spec, "The marks"): tokenize each run line with `tokenize`; between lines put one **gap token** standing for the line end, the line's trailing `\r` (only when the one line has no trailing `\r` of its own at that place; a CRLF file's breaks absorb every `\r`, a mixed file marks the odd one), the next line's leading spaces/tabs, and — when `!markdown` and the one line (after indentation) and that continuation line both start with the same leader from `///`, `//`, `#`, `--`, `;`, `%`, `*` — the leader and the spaces after it. A gap matches any run of spaces/tabs on the one line, or nothing, and is never marked. Trailing spaces *before* a break are ordinary tokens. Use the same two-pass scheme as `tokenMarks` (words, then gaps between anchors); `bridge` never joins across a gap. Marks are painted back per line; a mark spanning a break is cut per line.

- [ ] **Step 1: Write failing tests:**
  - pure split (the def/load example) → all marks empty.
  - `"timeout=30"` → `"timeout=30,"` split: only the comma marked, on its line.
  - CAR-221 shape: added words marked on both lines; the comma after `matrix` and the second line's `//` plain.
  - join (`oneIsOld: false`): only `0` (on run line 3) and `1` (on the one line) marked.
  - CRLF: every line ends `\r`, pure split → no marks; mixed endings → the odd `\r` marked.
  - Markdown (`markdown: true`): `"* one two"` → `"* one"` + `"* two"` marks the new `*`; `"# A long heading"` → `"# A long"` + `"# heading"` marks the second `#`; same text with `markdown: false` and `//` → plain.
  - a comment split into a non-comment continuation (`"// a b"` → `"// a"` + `"b()"`) → `()` marked.
  - `"foo bar"` vs run `["foo", "bar"]`: no marks; `"foobar"` vs `["foo", "bar"]`: both marked (never fuse).
  - added trailing space `"a.b"` → `["a. ", "b"]`: the space marked.
  - Properties: random line, random breaks at token boundaries with random indentation (drop or keep the space at the break) → no marks either direction (split and join); one random token inserted anywhere in the run → marked, on the line it sits on, and nothing else marked.
- [ ] **Step 2: Run** `pnpm test src/web/files/wordDiff.test.ts` — FAIL.
- [ ] **Step 3: Implement** `groupMarks` in `wordDiff.ts` (reuse `encode`/`flag`/`ranges`/`bridge`).
- [ ] **Step 4: Run** — PASS, existing `wordMarks` tests unchanged.
- [ ] **Step 5: Commit** `"Split/join groups: their word marks (CAR-130)"`.

### Task 3: Scheduling group marks, hidden changes

**Files:**
- Modify: `src/web/files/wordWork.ts`, `src/web/files/wordWorker.ts`, `src/web/files/hiddenLines.ts`
- Test: `src/web/files/wordWork.test.ts`, `src/web/files/hiddenLines.test.ts`

**Interfaces:**
- Consumes: `LineGroup`, `HunkItems` (Task 1); `groupMarks`, `GroupMarkJob` (Task 2).
- Produces:
  ```ts
  // wordWork.ts
  export type MarkJob = readonly [string, string] | GroupMarkJob;
  export type JobMarks = PairMarks | { one: Mark[]; run: Mark[][] };
  export type Runner = (jobs: readonly MarkJob[], wanted: () => boolean) => Promise<JobMarks[]>;
  export const markJobs: (jobs: readonly MarkJob[]) => JobMarks[]; // replaces markPairs
  export type Later = LinePair | LineGroup;
  export interface HunkWords { marks; pending; failed; later: Later[] } // pending/failed hold every group line
  export function hunkWords(items: HunkItems, markdown: boolean): HunkWords;
  export function requestMarks(later: readonly Later[], markdown: boolean, progress: () => void): () => void;
  // hiddenLines.ts
  export function hiddenLines(rows, words, tabWidth, items?: HunkItems): ReadonlySet<DiffLine>;
  ```
- A group's done/waiting key is (one, run[0], run[last]); a view or whitespace toggle reuses it.
- `hiddenLines` partners: one line ↔ run[0]; other run lines none; `noNewline` compared between the one line and run[last]. Break indentation and `\r` never count as hidden (they are never marked).

- [ ] **Step 1: Write failing tests:** with `configureWordWork({ budgetMs: 0, runner })`: a group's every line is in `pending` and the group in `later`; after `requestMarks` and the runner resolves, marks equal `groupMarks`; a runner that throws → every group line in `failed`, none pending; a second `hunkWords` on a fresh `HunkItems` with the same lines (a whitespace toggle) needs no runner call. `hiddenLines`: a CRLF pure split and an indented split flag nothing; a split whose run[0] adds a no-break space flags run[0].
- [ ] **Step 2: Run** `pnpm test src/web/files/wordWork.test.ts src/web/files/hiddenLines.test.ts` — FAIL.
- [ ] **Step 3: Implement**; the worker posts `jobs` and calls `markJobs`. Update callers (`DiffBody.tsx` uses `hunkWords`/`requestMarks`/`hiddenLines`) only as far as needed to typecheck; passing `{ pairs, groups: [] }` and `markdown: false` until Task 4/5 wire the real values.
- [ ] **Step 4: Run** the tests + `pnpm verify:fast` — PASS.
- [ ] **Step 5: Commit** `"Split/join groups: mark them off the render path (CAR-130)"`.

### Task 4: The view: hunkView, unified order, side by side

**Files:**
- Modify: `src/web/files/whitespace.ts` (`HunkView`), `src/web/files/pairOrder.ts`, `src/web/files/sideBySide.ts`, `src/web/files/find/findInPr.ts` (only if it reads `pairs`), `docs/product-rules.md` ("Side by side is a view")
- Create: `src/web/files/groupSpans.ts`
- Test: `src/web/files/pairOrder.test.ts`, `src/web/files/sideBySide.test.ts`, `src/web/files/whitespace.test.ts`, find tests

**Interfaces:**
- Consumes: `hunkItems`, `LineGroup` (Task 1).
- Produces:
  ```ts
  // pairOrder.ts
  export type Partners = ReadonlyMap<DiffLine, LinePair | LineGroup>; // every line of a pair or group → its item
  export const isGroup = (x: LinePair | LineGroup): x is LineGroup => !Array.isArray(x);
  // whitespace.ts HunkView gains `items: HunkItems` (pairs stays = items.pairs); partners as above
  // groupSpans.ts
  export type GroupSpan = { group: LineGroup; at: "first" | "mid" | "last"; label: string };
  /** Each group line's place in its group's rows as shown (unified: the group's row order; side by side: rows of the layout) and the label. */
  export function groupSpans(items: HunkItems): ReadonlyMap<DiffLine, GroupSpan>;
  export function groupLabel(group: LineGroup): string; // "Line 12 split into 12–16" | "Lines 7–9 joined into 7"
  ```
- `orderRun`: a split reads −one, +run…; a join −run…, +one; a group is its own block (never merged with neighbouring pairs), rows adjacent; pairs as today.
- `layoutRows`: a split: `(one, run[0])` then `(—, run[k])` rows; a join: `(run[0], one)` then `(run[k], —)`. New guarantee: a blank cell only once the other side of that gap or group has run out.

- [ ] **Step 1: Write failing tests:** `groupLabel` both shapes (en dash; a 2-line run "12–13"); `orderRun` and `layoutRows` for split, join, split next to a pair; properties in `sideBySide.test.ts` and `pairOrder.test.ts` with random groups (every line once per side, in order, right side; a group's rows adjacent; the changed blank-cell rule); `hunkView` with groups: the same runs, keys, lines and counts as with groups disabled (principle 2); the cut case: a split whose closing `)` has a whitespace twin elsewhere in the hunk, Ignore whitespace off and on → the group stops before the `)`, the one line's `)` marked removed (via `groupMarks`); Ignore whitespace on: a pure split's cluster still counts as changed (same counts as off); since view: `hunkView(lines, false, starts)` with a piece boundary inside the would-be run → no group across it; Find: hits step through a group's rows in shown order.
- [ ] **Step 2: Run** `pnpm test src/web/files/pairOrder.test.ts src/web/files/sideBySide.test.ts src/web/files/whitespace.test.ts` — FAIL.
- [ ] **Step 3: Implement**; `hunkView` builds `items = hunkItems(git.map(r => r.rows))`, partners over pairs and groups. Update `docs/product-rules.md` "Side by side is a view" for the per-gap-or-group blank rule.
- [ ] **Step 4: Run** the tests + find tests + `pnpm verify:fast` — PASS.
- [ ] **Step 5: Commit** `"Split/join groups: unified order and side-by-side layout (CAR-130)"`.

### Task 5: DiffBody: the bracket, names, pending; e2e

**Files:**
- Modify: `src/web/files/DiffBody.tsx` (and a small component file if it grows, e.g. `src/web/files/GroupBracket.tsx`), `scripts/verify-fast.mjs` (`E2E_MAP`: map new files to the new spec)
- Create: `e2e/split-lines.spec.ts`

**Interfaces:**
- Consumes: `HunkView.items`, `Partners`, `groupSpans`, `groupLabel` (Task 4); `hunkWords(items, markdown)`, `requestMarks(later, markdown, …)`, `hiddenLines(…, items)` (Task 3). `markdown`: the file's language is Markdown (the same test the Markdown renderer uses for its path).
- DOM contract (tests rely on it): the bracket piece on each group row and each inserted row inside a group is `data-testid="group-bracket"` with `data-group-at="first|mid|last|through"`, `aria-hidden="true"`, `title` = the label; each group line's line-number cell carries the label in its accessible name and `title`.

- [ ] **Step 1: Write the e2e** (`e2e/split-lines.spec.ts`, throwaway repo via `pr(...)`, made-up code; desktop and phone; unified and side by side): the pure split, the CAR-221 shape and the join: which rows the bracket spans, `first`/`last` placement; the label in the line-number cell's accessible name; the marked text (none for the pure split; the comma; the added words; `0`/`1`); a thread opened on a middle run line stays with its line and the bracket runs past it (`through`); group lines pending while the worker is held (the `inlineDiff.spec.ts` "big rewritten block" pattern: hold `**/assets/wordWorker-*.js`, a fixture of large groups that outlasts the render budget), then marked; the since view: patch set 2 splits a line patch set 1 added → a group since PS1, plain additions against base; Find stepping through a group's rows in shown order; `expectEveryUnitMarkable` on the file; `expectNoPageOverflow` at 360px.
- [ ] **Step 2: Run** `pnpm test:e2e e2e/split-lines.spec.ts` — FAIL.
- [ ] **Step 3: Implement** the bracket (gutter, drawn with the rows, no layout shift in hunks without a group), labels, wiring of `items`/`markdown`, pending/failed on every group line.
- [ ] **Step 4: Run** `pnpm test:e2e e2e/split-lines.spec.ts e2e/linePairing.spec.ts e2e/sideBySide.spec.ts e2e/inlineDiff.spec.ts e2e/markable.spec.ts` (phone included: this is layout) and `pnpm verify:fast` — PASS. `pnpm flake-check e2e/split-lines.spec.ts --runs 5` for the held-worker test.
- [ ] **Step 5: Commit** `"Split/join groups: the bracket in both views (CAR-130)"`.

### Task 6: Docs, real-PR comparison page, gallery

**Files:**
- Modify: `docs/product-rules.md` (new section "A line split or joined pairs as a group": the rule, the bracket, the break incl. `\r`, comment leaders, never Markdown; coverage untouched; cuts end a group; the since view), `docs/faq.md` ("Why are lines in a different order, or marked where GitHub shows none?"), `docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md` (its "one line drawing on two" non-goal points to the CAR-130 spec for splits and joins; extract method stays out), `scripts/pairing-compare.mjs` + `scripts/pairing-compare-lib.ts` (a page of every stretch whose layout groups change, worst first, with fine/bad per row)
- Test: `scripts/pairing-compare-lib.test.ts`
- Gallery: `Gilthans/carbonless-gallery`, branches `base/split-joined-lines`, `case/split-joined-lines`: the pure split, the trailing-comma split, the wrapped comment, the join, a split next to a pair, a CRLF file, a Markdown bullet split, a split cut by a whitespace twin, near misses (list item added, `}` after a changed line, extract method); then a second push splitting a line the first push added; README row and a description of what to look at.

- [ ] **Step 1:** failing test in `pairing-compare-lib.test.ts` for the groups page's rows (a stretch with a group lists it; one without doesn't; order worst first).
- [ ] **Step 2:** implement; docs edits.
- [ ] **Step 3:** run `pnpm test scripts/pairing-compare-lib.test.ts` and `pnpm verify:fast` — PASS.
- [ ] **Step 4:** commit `"Split/join groups: docs and the comparison page (CAR-130)"`; create the gallery PR (allowed repo).
- [ ] **Step 5:** in the report: `Release note (new): A line split into several, or several joined into one, now reads as one group with a bracket, marking only the text that changed.`
