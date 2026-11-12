# Inline diff step 2: pairing by similarity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a cluster with a different number of removed and added lines, pair clearly similar lines (never crossing), mark each pair with step 1's word marks, and move the rows so a pair reads together, side by side and unified.

**Architecture:** A pure pairing module (`linePairing.ts`) scores lines over step 1's tokens and aligns a cluster's removed and added lines with a small DP. `hunkPairs` uses it for unequal clusters; a new `hunkView` computes a hunk's runs, its pairs once from git's row order, and reorders each run's rows for unified (option B). Side by side's `layoutRows` takes the pairs and lays out gaps as today. Everything downstream (marks, hidden-change warnings, Find in PR, DiffBody) takes the pairs and rows `hunkView` returns, never re-deriving pairs from reordered rows.

**Tech Stack:** TypeScript, React, Vitest + fast-check, Playwright, diff-match-patch (already used by `wordDiff.ts`).

**Spec:** `docs/superpowers/specs/2026-11-08-inline-diff-step2-design.md` (approved 2026-11-12). Linear: CAR-30. Branch: `car-30-similarity-pairing`.

## Global Constraints

- Equal clusters (n removed = n added) keep step 1's i-th-with-i-th pairs, marks and rows exactly. One-sided clusters are unchanged.
- Pairs never cross; each line has at most one partner; each side keeps its own order; every line shows exactly once (principle 2).
- No allowed pair in a cluster → that cluster's rows and marks are exactly today's.
- A gap (unpaired lines before the first pair, between two pairs, after the last) is laid out as today lays out a cluster: side by side by position, surplus one-sided, no marks; unified, its removed then its added lines.
- Unified B: a pair's removed line sits directly above its added line; consecutive pairs with no gap between form one group (−a −b +a′ +b′).
- Rows never leave their cluster run. A pair whose two lines sit in different runs gets marks but no row move.
- Marks are `wordMarks(old, new)`, unchanged (the 1,024-character cut, hidden characters, bridging).
- No server change; clusters, counts, keys and review state untouched.
- Speed: CPU time (`process.threadCpuUsage`), never wall clock. Step 1's 2,000-pair budget (under 100 ms) still holds.
- Repo is public: no access links, IPs, local paths or work repo names in tracked files, PR text or comments. The owner's two Go cases are approved for the gallery and fixtures verbatim; the extract-method example is not (made-up code of its shape only).
- Commits via `git commit --only -- <paths>`; `pnpm verify:fast` while iterating, `pnpm verify` once before the PR; `CRB_NO_PHONE=1` except for the e2e task.

## Review Focus

1. **Find in PR order after a reorder** — Next/Previous must step through hits in the order the unified rows show, and a hit on a moved line must land on that line. Test in Task 3.
2. **A cluster under Ignore whitespace with `~` rows inside** — `~` rows still end the stretch that pairs; similarity pairing must not pair across a `~` row or move a line past it. Test in Task 3.
3. **Identical-score candidates** (two equally similar added lines for one removed line, e.g. repeated `}` or `return err` lines) — ties go to position pairing, so output is stable and no row moves for no gain. Test in Task 1.
4. **Lines with no word tokens** (`}`, `});`, blank) — they must not pair with everything that shares punctuation. Test in Task 1.
5. **Hidden-change warning (⚠) on a newly paired line** — `hiddenLines` must use the same pairs as the marks, so a step 2 pair whose only change is invisible warns. Test in Task 2.

---

### Task 1: Line similarity and cluster alignment

**Files:**
- Create: `src/web/files/linePairing.ts`
- Test: `src/web/files/linePairing.test.ts`
- Modify: `src/web/files/wordDiff.ts` (export `tokenize` if not already exported; it is)

**Interfaces:**
- Produces:
  - `export const PAIR_MIN_SIMILARITY = 0.5;`
  - `export const ALIGN_CAP = 2500;` (removed × added above this: no pairs)
  - `export function lineSimilarity(oldText: string, newText: string): number` — in [0, 1].
  - `export function alignCluster(dels: readonly string[], adds: readonly string[]): [del: number, add: number][]` — index pairs, increasing in both.

**Similarity rule (decided here):** tokens from `tokenize`; drop whitespace tokens. If both lines have at least one word token (letters, digits, `_`: the `WORD` class), keep only word tokens; otherwise keep all non-whitespace tokens. Score = 2 × LCS(tokens) / (|old| + |new|); two empty token lists score 0. Lines of `WORD_DIFF_MAX` characters or more score 0.

**Alignment rule:** maximise total similarity over allowed pairs (score ≥ `PAIR_MIN_SIMILARITY`), non-crossing, one partner each; among equal totals (|Δ| < 1e-9), maximise the number of pairs with `del === add` (position pairs); then prefer the lexicographically earliest. Before scoring, skip cells whose token sets share nothing (a cheap prefilter).

- [ ] **Step 1: Write failing tests** in `linePairing.test.ts`:
  - `lineSimilarity("  const timeout = 30;", "  const timeout = 60;")` ≈ 2/3; `("sendEmail(user);", "queue.push(job);")` = 0; `("  'beta'", "  'beta',")` = 1; `("}", "},")` = 2/3 (no word tokens on either side: all tokens count); `("}", "  return err")` = 0; `("x".repeat(1024), "x".repeat(1024))` = 0.
  - `alignCluster` on the spec's cases: case 1 `["  'beta'"]` × `["  'beta',", "  'gamma'"]` → `[[0, 0]]`; case 2 `["  const timeout = 30;"]` × `["  // seconds (API docs)", "  const timeout = 60;"]` → `[[0, 1]]`; case 3 → `[[0, 0], [2, 1]]`; case 4 → `[]`; case 5 (old comment line vs the 8 added lines from the spec's appendix) → `[[0, 7]]`.
  - Ties: `["}"]` × `["}", "}"]` → `[[0, 0]]`; `["return err", "return err"]` × `["return err"]` → `[[0, 0]]`.
  - Cap: 51 × 50 identical lines → `[]`; 50 × 50 → 50 position pairs.
  - Property (fast-check, random short token lines from a small vocabulary): result increasing in both indices, every pair scores ≥ `PAIR_MIN_SIMILARITY`, no index used twice, and when `dels.length === adds.length` and every position pair is allowed, the result is the identity.
- [ ] **Step 2: Run** `pnpm test src/web/files/linePairing.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `lineSimilarity` (token LCS by a plain DP over the two token lists, or diff-match-patch over one character per token as `wordDiff.ts` does) and `alignCluster` (O(n·m) DP over `[score, positionPairs]` with the tie rule above).
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `linePairing.ts`, its test: "word diff step 2: line similarity and cluster alignment (CAR-30)".

### Task 2: Pairs for unequal clusters, marks and hidden-change warnings from them

**Files:**
- Modify: `src/web/files/wordBlocks.ts`, `src/web/files/hiddenLines.ts`
- Modify: `src/web/files/wordBlocks.test.ts`, `src/web/files/hiddenLines.test.ts`, `src/web/files/wordBlocks.fixture.test.ts`, `test/fixtures/inline-diff/known-differences.json`
- Modify: `docs/superpowers/specs/2026-11-01-inline-diff-design.md` (one line under "Decided by the owner" pointing to step 2's decision that grows the list)

**Interfaces:**
- Consumes: `alignCluster` (Task 1).
- Produces:
  - `export type LinePair = [del: DiffLine, add: DiffLine];`
  - `hunkPairs(rows: readonly DiffRow[]): LinePair[]` — unchanged signature; for a stretch with dels ≠ adds and both > 0, pairs = `alignCluster(dels.map(t), adds.map(t))` mapped to lines; equal stretches unchanged.
  - `export function pairWordMarks(pairs: readonly LinePair[]): Map<DiffLine, readonly Mark[]>` — today's body of `hunkWordMarks`.
  - `hunkWordMarks(rows)` stays as `pairWordMarks(hunkPairs(rows))`.
  - `hiddenLines(rows, words, tabWidth, pairs?: readonly LinePair[])` — uses `pairs` when given, else `hunkPairs(rows)`.

- [ ] **Step 1: Write failing tests:** in `wordBlocks.test.ts`, replace "an unequal block has no marks" expectations with: 1/2 case 2 marks `30`/`60` and leaves the comment unmarked; 3/2 case 3 marks both retries and not `log`; 1/2 case 4 has no marks. In `hiddenLines.test.ts`: a 1/2 cluster whose paired lines differ only by a trailing space (hidden characters off) puts the added line in `hiddenLines(rows, words, 4, pairs)`.
- [ ] **Step 2: Run** `pnpm test src/web/files/wordBlocks.test.ts src/web/files/hiddenLines.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `pnpm test src/web/files/wordBlocks.fixture.test.ts` — it fails where unequal blocks now get marks. For each, add a `known-differences.json` entry with reason `"step 2 pairs unequal clusters by similarity (owner, 2026-11-08: \"This is the point where we start diverging from github\")"`. No equal-block entry may change; if one does, stop and report. Update the fixture test's header comment and step 1's spec line accordingly.
- [ ] **Step 5: Run** the three test files — expect PASS. Commit: "word diff step 2: unequal clusters pair by similarity; marks and warnings from the pairs (CAR-30)".

### Task 3: Unified order (option B) and one view of a hunk

**Files:**
- Modify: `src/web/files/whitespace.ts` (add `hunkView`, keep `viewRuns` as a wrapper)
- Create: `src/web/files/pairOrder.ts` (`orderRun`)
- Modify: `src/web/files/find/findInPr.ts` (use `hunkView`)
- Test: `src/web/files/pairOrder.test.ts`, `src/web/files/find/findInPr.test.ts`

**Interfaces:**
- Consumes: `hunkPairs`, `LinePair` (Task 2).
- Produces:
  - `export type Partners = ReadonlyMap<DiffLine, DiffLine>;` (both directions)
  - `export function orderRun(rows: readonly DiffRow[], partners: Partners): DiffRow[]` — within each stretch of plain del/add rows (bounded by context or `~` rows, which stay where they are), emit: gap dels, gap adds, then a run of consecutive pairs as its dels then its adds; repeat. A partner outside `rows` counts as unpaired. No partners in a stretch → rows unchanged.
  - `export interface HunkView { runs: ViewRun[]; pairs: LinePair[]; partners: Partners }`
  - `export function hunkView(lines: DiffLine[], ignoreWhitespace: boolean): HunkView` — runs as `viewRuns` builds them today; `pairs = hunkPairs(all rows in git order)`; then each cluster run's `rows = orderRun(rows, partners)`. Cached per `lines` array and setting (WeakMap), like `pairedHunk`.
  - `viewRuns(lines, ignoreWhitespace)` returns `hunkView(...).runs`.

- [ ] **Step 1: Write failing tests** (`pairOrder.test.ts`): case 2 → `+comment −t +t`; case 3 → `−u +u −log −o +o`; case 5 → `+h1…+h7 −c +c`; an equal 2/2 cluster → `−a −b +a′ +b′` (unchanged); a stretch split by a `~` row never moves a line across it; a pair whose partner is in another run leaves both runs' rows unchanged. Property: output is a permutation of input, dels in old order, adds in new order, non-plain rows at their indices. In `findInPr.test.ts`: on case 3, a search for `retry` steps through its hits in the shown order (old 21, new 21, old 23, new 22) and the oracle (`viewRuns`) agrees.
- [ ] **Step 2: Run** `pnpm test src/web/files/pairOrder.test.ts src/web/files/find/findInPr.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `orderRun`, `hunkView`, rewire `viewRuns` and `findInPr`'s `pairedHunk` to `hunkView`.
- [ ] **Step 4: Run** those tests plus `pnpm test src/web/files/whitespace.test.ts` — expect PASS (existing `viewRuns` tests unchanged, since their clusters are equal or whitespace-only).
- [ ] **Step 5: Commit**: "word diff step 2: unified shows a pair together (option B); one hunk view for diff and Find (CAR-30)".

### Task 4: Side by side by pairs

**Files:**
- Modify: `src/web/files/sideBySide.ts`, `src/web/files/sideBySide.test.ts`

**Interfaces:**
- Consumes: `Partners` (Task 3).
- Produces: `layoutRows(rows: DiffRow[], partners?: Partners): SideRow[]` — within each stretch between `~`/context rows: walk pairs in order; before each pair, lay the gap's dels and adds out by position (today's `flush`); then the pair as one row; after the last pair, the final gap. Without `partners`, or with none in the stretch, exactly today's output.

- [ ] **Step 1: Write failing tests:** cases 1–5 traces (e.g. case 2 → `["[|+1]", "[-1|+2]"]`; case 3 → `["[-1|+1]", "[-2|]", "[-3|+2]"]`; case 5 → seven `[|+n]` rows then `[-1|+8]`); a gap with lines on both sides between two pairs shares rows by position (`d1 dX d2` / `a1 aY a2` → `[-d1|+a1] [-dX|+aY] [-d2|+a2]`). Extend the existing `expectLayout` property to run with random non-crossing partners: every line once per side, in order, on its own side; row count ≤ today's.
- [ ] **Step 2: Run** `pnpm test src/web/files/sideBySide.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS. Commit: "word diff step 2: side by side puts a pair on one row (CAR-30)".

### Task 5: Wire it into the diff, e2e, gallery

**Files:**
- Modify: `src/web/files/DiffBody.tsx` (HunkRows' `useMemo` near the `viewRuns` call; the comment "a block may span two clusters")
- Modify: `e2e/inlineDiff.spec.ts` (or a new `e2e/linePairing.spec.ts`, mapped in `scripts/verify-fast.mjs`'s `E2E_MAP`)
- Gallery: `Gilthans/carbonless-gallery`, branches `base/similarity-pairing` and `case/similarity-pairing`, a PR and a README row

**Interfaces:**
- Consumes: `hunkView` (Task 3), `pairWordMarks` and `hiddenLines(…, pairs)` (Task 2), `layoutRows(rows, partners)` (Task 4).

- [ ] **Step 1: Wire** HunkRows: `const view = hunkView(hunk.lines, ignoreWhitespace)`; `side: layoutRows(run.rows, view.partners)`; `words: pairWordMarks(view.pairs)`; `hiddenLines(…, view.pairs)`. Rewrite the comment to say rows never leave their run and a cross-run pair gets marks only.
- [ ] **Step 2: Write failing e2e tests** (desktop and phone, unified and side by side) on a throwaway repo with cases 2, 3 and 5 (5 verbatim from the spec's appendix): which lines share a row (side by side), the unified order of rows, the marked text (`30`/`60`; `3`/`5`; `IsCacheSkippedForDomain`/`SkipsCacheFor`); a thread on old line 11 of case 2 shows under that line in its moved row.
- [ ] **Step 3: Run** `pnpm test:e2e e2e/<spec> ` (phone included: this is layout) — expect PASS after Step 1; `pnpm flake-check e2e/<spec>`.
- [ ] **Step 4: Gallery PR** with all seven cases (cases 1–4 as in the spec; 5 and 6 verbatim from the appendix; 7 a made-up extract-method of the same shape: one new line combining a variable from one old line and a constructor call from another, four old lines unpaired). Description says what to look at per case; README row. No probes left behind.
- [ ] **Step 5: Commit** DiffBody, e2e: "word diff step 2: the diff shows similarity pairs (CAR-30)".

### Task 6: CPU budget

**Files:**
- Modify: `src/web/files/linePairing.test.ts` (or the CPU test file CAR-123 adds for `hunkPairs`, if it has landed on master: extend it, don't duplicate)

- [ ] **Step 1: Write the test:** `alignCluster` on a 50 × 50 cluster of distinct 120-character lines sharing half their words (the worst case inside `ALIGN_CAP`), plus `pairWordMarks` on its pairs, under 100 ms of CPU time (`process.threadCpuUsage`), in the style of `wordDiff.test.ts`'s CPU test. Step 1's 2,000-pair test unchanged and passing.
- [ ] **Step 2: Run**; if over budget, lower `ALIGN_CAP` (and Task 1's cap tests) until it passes, and record the value. `pnpm flake-check` the test.
- [ ] **Step 3: Measure** first-open time of a file of 200 unequal 3/2 clusters before and after (built CLI, branch instance), for the report; not gated.
- [ ] **Step 4: Commit**: "word diff step 2: CPU budget for pairing (CAR-30)".

### Task 7: Real-PR comparison page (owner QA, gates the merge)

**Files:**
- Create: `scripts/pairing-compare.mjs` (tracked; reads a corpus directory, writes an HTML page; no corpus data in the repo)

**Interfaces:**
- Consumes: `hunkView` and `hunkPairs` through the built web modules or a tsx entry (builder's choice).

- [ ] **Step 1:** Build a corpus outside the repo: ~150 recent public PRs from popular repos across languages (TS, Go, Python, Java, C#, Rust), fetched read-only with `gh api` (base and head file contents of changed files), diffed with carbonless's own `DIFF_ARGS`.
- [ ] **Step 2:** `node scripts/pairing-compare.mjs <corpus dir> <out.html>`: every unequal cluster where step 2's layout differs from today's, today's side-by-side rows next to step 2's, with the pair scores; sorted worst-first: lowest passing score, then farthest row move, then cluster size. Header counts: clusters seen, unequal, changed by step 2.
- [ ] **Step 3:** Publish the page as a private artifact for the owner and send the link in chat. The owner marks cases fine or bad. Each bad one becomes a test (Task 1 or 4) and, if it is a new shape, a gallery case; a threshold change re-runs the page.
- [ ] **Step 4: Commit** the script: "word diff step 2: a page comparing step 2's pairs to today's on real PRs (CAR-30)".

### Wrap-up

- [ ] Update `docs/faq.md` if it says unequal blocks are never marked; update the step 2 spec only if a call changed (dated).
- [ ] `pnpm verify` (background), push `car-30-similarity-pairing`, open the PR ("Fixes CAR-30"; what to QA with the gallery PR link; edge cases), start the branch instance, send the owner its link in chat, and ask for a merge only after the owner's pass over Task 7's page.
