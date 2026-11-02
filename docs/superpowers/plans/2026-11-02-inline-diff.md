# Inline diff (step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Highlight the changed tokens inside paired removed/added lines, GitHub's way, in unified and side by side.

**Architecture:** Pure web-side code. `wordDiff.ts` turns one pair of lines into marks (token diff); `wordBlocks.ts` finds GitHub's pairs in a hunk's displayed rows and maps each paired `DiffLine` to its marks; `HunkRows` computes that map in its existing per-hunk memo, and `CodeLine` paints the marks as a background tint under the syntax colors. No server change.

**Tech Stack:** TypeScript, React, Tailwind v4 tokens (`src/web/index.css`), `diff-match-patch` (new dependency), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-inline-diff-design.md` (approved 2026-11-02, tighter marks).

## Global Constraints

- Marks only in equal blocks (n removed lines directly followed by n added lines, nothing between), i-th removed with i-th added. Every other block shape: no marks.
- A pair is plain when either line has `length >= 1024` (UTF-16 `length`; the cut is characters, the fixture's 1,023 case is marked). Only that pair.
- Tokens: runs of `[\p{L}\p{M}\p{N}_]`; every other code point is its own token (each space, each punctuation mark, each emoji).
- Diff: diff-match-patch over the token sequence, `Diff_Timeout = 0`, `diff_cleanupEfficiency` with `Diff_EditCost = 3`. Owner, 2026-11-02: "You can go ahead and use the tighter version" — no attempt to copy GitHub's looser folding.
- A trailing `\r` is never marked; a pair differing only by it has no marks.
- Ignore whitespace on: a `~` row ends a block, like a context line.
- Marks computed synchronously during render (principle 8: a pair is never plain while its marks are pending).
- Budget: 2,000 pairs of 120-character lines under 100 ms CPU (`process.threadCpuUsage`).
- Colors only from tokens; every code and syntax color ≥ 4.5:1 on the new tints (`theme.test.ts`).
- Fixtures are the gallery's (our playground), never a real PR's data.
- Unit tests that run git use `GIT_TEST_TIMEOUTS`; no test calls `gh` (the trap in `test/real-gh-trap.ts` fails the run).
- Commits `git commit --only -- <paths>`, messages ending `Co-Authored-By: <your model> <noreply@anthropic.com>`. Agents never push.

## Review Focus

1. A hunk whose block spans two clusters (removed lines in one cluster's run, added in the next): pairs follow the hunk's rows, not runs. → test in Task 2.
2. A pair where one side is empty text (`""` vs `"x"`): the whole other line is marked, no crash, no zero-width marks. → Task 1.
3. Surrogate pairs and combining marks (`👍`, `é`): marks never split a code point. → Task 1.
4. A reviewed cluster's pair: the `-done` tints, not the live ones, and the tint follows the row when its state changes without a remount. → Task 3.
5. A thread span over a word mark: `span-mark` wins on overlap, outside it the word tint shows. → Task 3.

---

## Brief A — the marks (Tasks 1–2)

### Task 1: Token diff of one pair

**Files:**
- Create: `src/web/files/wordDiff.ts`, `src/web/files/wordDiff.test.ts`
- Modify: `package.json` (+ `diff-match-patch`, `@types/diff-match-patch`)

**Interfaces:**
- Consumes: `type Mark = readonly [from: number, to: number]` from `src/web/code/Invisibles.tsx`.
- Produces:
  - `export const WORD_DIFF_MAX = 1024`
  - `export function tokenize(text: string): string[]`
  - `export function wordMarks(oldText: string, newText: string): { old: Mark[]; new: Mark[] }` — sorted, non-overlapping, adjacent ranges merged; `{ old: [], new: [] }` when the pair is plain.

- [ ] **Step 1: Failing tests** in `wordDiff.test.ts`:
  - `tokenize("café_1 + x👍")` → `["café_1", " ", "+", " ", "x", "👍"]`; `tokenize("ét")` is one token.
  - `wordMarks("const userCount = 1;", "const memberCount = 1;")` → `{ old: [[6, 15]], new: [[6, 17]] }`.
  - `wordMarks("a\r", "a")` and `wordMarks("abc", "abc")` → no marks; `wordMarks("a b\r", "a c\r")` marks never include the `\r` index.
  - `wordMarks("", "x y")` → `{ old: [], new: [[0, 3]] }`.
  - `wordMarks("a".repeat(1024), "b")` and `("b", "a".repeat(1024))` → no marks; `"a".repeat(1023)` vs `"b"` → marked.
  - Property (fast-check if the repo has it, else 500 seeded random pairs from a small alphabet incl. space, `_`, `.`, `é`, `👍`): marks in bounds, sorted, non-overlapping, on token boundaries; deleting the old marks' text and the new marks' text gives the same string (marks are exactly a diff).
  - Budget: `process.threadCpuUsage` around 2,000 calls on generated 120-character pairs (about 10% of tokens changed) is `< 100_000` µs; warm up once first.
- [ ] **Step 2:** `pnpm test src/web/files/wordDiff.test.ts` → fails (module missing).
- [ ] **Step 3:** Implement. Strip one trailing `\r` from each line before diffing (it sits at the end, so offsets hold). Encode tokens as one char each (`String.fromCharCode(0x100 + index)` of a shared token→char map) for diff-match-patch, then walk the diffs back to UTF-16 ranges. Reference model, scored against GitHub: `/tmp/claude-1001/-home-dev-carbonless/00250d6e-18f2-4309-a4af-1e942ed0523b/scratchpad/inline-diff/js/model.js` (`dmpModel` with `cleanup === 'efficiency'`; read-only, copy ideas not files).
- [ ] **Step 4:** Tests pass; `pnpm verify:fast` green.
- [ ] **Step 5:** Commit.

### Task 2: GitHub's pairs in a hunk, checked against GitHub

**Files:**
- Create: `src/web/files/wordBlocks.ts`, `src/web/files/wordBlocks.test.ts`, `test/fixtures/inline-diff/` (the 79 base/case file pairs as `base/<path>` and `case/<path>`, `github-marks.json`, `known-differences.json`), `scripts/inline-diff-fixtures.mjs` (rebuilds the folder from a clone of Gilthans/carbonless-gallery, branches `base/inline-diff` and `case/inline-diff`; a clone is at `/tmp/claude-1001/-home-dev-carbonless/00250d6e-18f2-4309-a4af-1e942ed0523b/scratchpad/inline-diff/gallery`; `github-marks.json` is copied from `…/scratchpad/inline-diff/github-marks.json`), `src/web/files/wordBlocks.fixture.test.ts`

**Interfaces:**
- Consumes: `wordMarks`, `WORD_DIFF_MAX` (Task 1); `DiffRow` (`src/web/files/whitespace.ts`), `DiffLine` (`src/shared/types.ts`).
- Produces: `export function hunkWordMarks(rows: readonly DiffRow[]): Map<DiffLine, readonly Mark[]>` — the rows are the whole hunk's displayed rows in order (every run's rows concatenated); a `ws` row or a context line ends a block; only lines with at least one mark are in the map.

- [ ] **Step 1: Failing tests** in `wordBlocks.test.ts`: a 2/2 block marks both pairs i-th to i-th; 1/2, 3/1 and 2/3 blocks: empty map; context between removed and added: two blocks, no pair across; a `ws` row between a removed and an added line ends the block; a 2/2 block whose removed lines carry `clusterKey: "a"` and added `clusterKey: "b"` still pairs (Review Focus 1); a 2/2 block with one 1,024-character pair keeps the other pair's marks.
- [ ] **Step 2: Failing fixture test** `wordBlocks.fixture.test.ts`: for each case file, write base and case into a throwaway repo (`test/git-fixture.ts`), get the hunks the way the server does (`buildDisplayHunks` / `loadFileHunks` in `src/server/diff/`, as `snapshot.ts` calls them), run `hunkWordMarks` over each hunk's rows (Ignore whitespace off; and on, using `matchHunk`/`pairRun` as `HunkRows` does), and compare to `github-marks.json`: which pairs are marked, and each pair's `oldMarks`/`newMarks`. Every mismatch must be listed in `known-differences.json` (`{ file, pair, reason }`); a listed difference that now matches fails too ("may only shrink": remove it from the list). Expected list at the start: the five pairs in `04`, `05`, `06`, `13`, `41` (spec, "Decided by the owner"), plus any block-shape differences git's diff makes, each with its reason in the report.
- [ ] **Step 3:** `pnpm test src/web/files/wordBlocks` → fails.
- [ ] **Step 4:** Implement `hunkWordMarks`, the fixture script and the fixtures.
- [ ] **Step 5:** Tests pass; `pnpm verify:fast` green.
- [ ] **Step 6:** Commit.

---

## Brief B — the paint (Tasks 3–4), after Brief A is on `inline-diff`

### Task 3: Paint the marks in both views

**Files:**
- Modify: `src/web/index.css` (tokens `--color-add-word`, `--color-del-word`, `--color-add-word-done`, `--color-del-word-done`; start from the mockup's `#1e5a43` / `#5c2441` and tune), `src/web/code/Invisibles.tsx` (`CodeLine`, `TextRun`), `src/web/files/DiffBody.tsx` (`HunkRows` memo, `CodeCell`, the row components that pass `marks`), `src/web/theme.test.ts`, `src/web/code/Invisibles.test.tsx`, `src/web/files/DiffBody.test.tsx`

**Interfaces:**
- Consumes: `hunkWordMarks` (Task 2).
- Produces: `CodeLine` prop `words?: { marks: readonly Mark[]; tone: "add" | "del" | "add-done" | "del-done" }`. DOM contract for tests: every marked run is an element with `data-word=""` and class `bg-<tone>-word` (e.g. `bg-add-word-done`); a marked invisible's marker sits inside such an element.

- [ ] **Step 1: Failing tests:**
  - `theme.test.ts` "word marks keep every code and syntax color at 4.5:1 and stay add/del": `code-ink`, `faint`, `add-ink`, `del-ink` and every `SYNTAX` color ≥ 4.5 on each of the four tokens; each word token is further from the other kind's row color than from its own (hue kept).
  - `Invisibles.test.tsx`: `CodeLine` with `words` renders `[data-word]` covering exactly the marked text, syntax color spans inside it; an indent marked as `··` is inside `[data-word]`; with a `marks` (thread span) overlapping, the overlapped part is `span-mark` and not `[data-word]`, the rest stays `[data-word]` (Review Focus 5); copying the line gives the original text.
  - `DiffBody.test.tsx`: a 1/1 pair in unified and side by side shows the renamed word in `[data-word]` on both lines; a 1/2 block has no `[data-word]`; a reviewed cluster's pair uses `bg-add-word-done`/`bg-del-word-done`, and after marking it reviewed in place (no remount) the class follows (Review Focus 4); Ignore whitespace on: the `~` row has none.
- [ ] **Step 2:** Run them → fail.
- [ ] **Step 3:** Implement. Compute `hunkWordMarks(hunkRuns.flatMap(r => r.rows))` inside `HunkRows`'s existing `hunkRuns` memo (same deps); each code cell looks up its own `DiffLine` (both views, so a side-by-side pair row's halves get their own lines' marks); tone from the line kind and the row's reviewed state (as `REVIEWED_ROW_BG` picks). Syntax colors stay on top; tint is background only.
- [ ] **Step 4:** Tests pass; `pnpm verify:fast` green.
- [ ] **Step 5:** Commit.

### Task 4: e2e, speed numbers, gallery

**Files:**
- Create: `e2e/inlineDiff.spec.ts`; map it in `E2E_MAP` (`scripts/verify-fast.mjs`) for `wordDiff`, `wordBlocks`, `Invisibles.tsx`.
- Modify (outside the repo, approved playground): Gilthans/carbonless-gallery README row for `inline-diff` (#14) if missing, and PR #14's description (what to look at).

- [ ] **Step 1: Failing e2e**, desktop and phone, unified and side by side, on a throwaway repo with a handful of the fixture's cases (01 rename, an operator change, a re-indent, an unequal 1/2 block, a 1,024-character pair, a whitespace-only pair): the `[data-word]` text of each marked line equals the expected token text; the 1/2 block and the 1,024 pair have none; Ignore whitespace on: the whitespace-only pair has none, others unchanged; no horizontal page scroll at 360px; one screenshot per view into the report folder.
- [ ] **Step 2:** `pnpm test:e2e e2e/inlineDiff.spec.ts` → fails before Task 3's build, passes after.
- [ ] **Step 3: Speed numbers:** first open and Side by side toggle of a 2,000-line equal-block file, before (`master`) and after, 3 runs each, into the report (not gated).
- [ ] **Step 4:** Gallery README and PR #14 description.
- [ ] **Step 5:** `pnpm verify:fast` green; commit.

---

## Integration (coordinator)

Cherry-pick each reviewed brief onto `inline-diff`; full `pnpm verify` (background); branch instance on port 4751 (`node scripts/crb-private-env.mjs "$PWD" 4751`, `source .envrc`, `crb serve --host 100.78.32.127 --port 4751`), gallery PR #14 link to the owner; push `inline-diff` to Gilthans/carbonless and open a PR (what changed, what to QA with links, edge cases, attribution); CI green; merge only on the owner's word for that PR.
