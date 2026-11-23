# Whitespace Across Hunks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide whitespace-only over the whole display hunk, once, so the server's clusters and since units agree with the `~` rows, in the base view and the since view alike (CAR-218).

**Architecture:** One shared matching per display hunk (`matchDisplayHunk`, `src/shared/whitespace.ts`, today's `matchHunk` moved and capped) gives the twins. The view's `~` rows, the snapshot's cut (`cutClusters`) and the since view's pieces (`sincePieces`) all read it. Whitespace-only = a changed line the matching matched; pieces are maximal runs of such lines within a git hunk (or a since run).

**Tech Stack:** TypeScript, Vitest, Playwright, Fastify server (`src/server`), React (`src/web`), shared code (`src/shared`).

**Spec:** `docs/superpowers/specs/2026-11-22-whitespace-across-hunks-design.md` (approved 2026-11-22, no carry).

## Global Constraints

- Every changed line is in exactly one cluster / since piece, in order (principle 2); a bug must make coverage look incomplete, never complete.
- Whitespace equality is `whitespaceKey` (git's `-w`); matching is `matchSides` with unchanged lines as context sides. Don't change `matchSides`, its weights or `whitespaceKey`.
- Cap: `SPLIT_CELLS` = 250,000 old × new lines of the display hunk, context included; over it, today's per-git-hunk cut (`splitHunk`), and the view's rows follow the same result. The wholesale re-indent fast path stays.
- No carry (owner 2026-11-22: "I'm fine with letting the affected clusters reset. It's an error in the correct direction"): re-keyed clusters read unreviewed; no new event type; split carry unchanged.
- Since view parity (owner 2026-11-22: "Interdiff view and base view should have feature parity, whenever plausible"): same rule on the interdiff's display hunks.
- A since piece is whitespace-only only if every line is whitespace-only on the interdiff AND each line's twin on the interdiff's old side (the earlier patch set) held a human mark (reviewed or crossed off) there.
- Speed in CPU time against a reference (`test/cpu.ts`), never wall clock.
- Repo is public: made-up code in tests, gallery and docs; no private repo names.
- Commits: `git commit --only -- <paths>`, message mentions CAR-218, ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Check with `pnpm verify:fast origin/master` (`CRB_NO_PHONE=1` unless a task touches layout) and targeted tests; never full `pnpm verify`.

## Review Focus

1. A display hunk where an accidental byte-equal unchanged line sits inside a re-indented block: whole block whitespace-only, the unchanged line stays unchanged (Task 2 test "re-indent across an accidental unchanged line").
2. A line whose only whitespace twin is across a real change, out of order: stays a change (Task 2 test "a block moved across a change stays a change").
3. A display hunk just over the cap: server and view both fall back per git hunk and still agree (Task 1 test "over the cap the rows follow the per-hunk cut").
4. Since view: patch set 1 changed a line, left unreviewed; patch set 2 only re-indented it: still counts with Ignore whitespace on (Task 3 test "an unread re-indent still counts").
5. A file in the since view whose snapshot clusters are real changes but whose since units are all whitespace-only: its header doesn't read done with Ignore whitespace on unless those units' lines were marked (Task 4 test).

---

### Task 1: One matching per display hunk, shared by the view

**Files:**
- Modify: `src/shared/whitespace.ts` (add `matchDisplayHunk`, `whitespaceLines`)
- Modify: `src/web/files/whitespace.ts` (`matchHunk` delegates; doc comments)
- Test: `src/shared/whitespace.test.ts`, `src/web/files/whitespace.test.ts`

**Interfaces:**
- Produces: `matchDisplayHunk(lines: readonly DiffLine[]): ReadonlyMap<DiffLine, DiffLine>` (removed/added line → its twin, a changed or context line); `whitespaceLines(lines: readonly DiffLine[]): ReadonlySet<DiffLine>` (the changed lines `matchDisplayHunk` matched). Both cached per `lines` array (WeakMap), as `hunkTwins` is today.

- [ ] **Step 1: Failing tests** in `src/shared/whitespace.test.ts`:
  - "within the cap it matches like matchHunk did": for the existing matchHunk cases (move them), same twins.
  - "over the cap the rows follow the per-hunk cut": a display hunk of two git hunks whose old × new lines exceed `SPLIT_CELLS` but each git hunk alone is under it and re-indents its own lines; `whitespaceLines` holds exactly the lines `splitHunk` marks whitespace-only per git hunk, and no twin crosses a hunk.
  - "a pure addition has no twin": an added blank line with no twin is not in `whitespaceLines`.
  - Property (existing style): for random display hunks, every twin pair is `whitespaceKey`-equal and order-preserving; every context line is matched (to itself or a change).
- [ ] **Step 2:** `pnpm test src/shared/whitespace.test.ts` fails (functions missing).
- [ ] **Step 3:** Implement in `src/shared/whitespace.ts`: today's `matchHunk` body, with the cap changed from `PAIR_CAP` per side to old × new > `SPLIT_CELLS` (unless the fast path applies), and the fallback per git hunk (a run of one cluster's lines, `lineRuns`) matching changes only, as `splitHunk` does. `src/web/files/whitespace.ts` `matchHunk` returns `matchDisplayHunk(lines)`; `hunkTwins` uses it. Remove `PAIR_CAP` if nothing else uses it.
- [ ] **Step 4:** Shared and web whitespace tests pass; add a CPU test: `matchDisplayHunk` at the cap against a reference workload, ratio-checked (`test/cpu.ts`).
- [ ] **Step 5:** Commit.

### Task 2: The snapshot's cut over display hunks

**Files:**
- Modify: `src/shared/whitespace.ts` (`cutByLines`), `src/server/diff/clusters.ts` (`splitCluster`), `src/server/diff/snapshot.ts` (`cutClusters` and its caller ~:303)
- Modify docs: `docs/product-rules.md` ("Whitespace-only runs are clusters": drop "Only within a git hunk…", the span is the display hunk), `docs/review-data-storage.md` ("Split carries": the new cut; marks on re-keyed clusters reset, no carry, owner 2026-11-22), `docs/faq.md` if it explains whitespace counts
- Test: `src/shared/whitespace.test.ts`, `src/server/diff/snapshot.test.ts`, `src/server/diff/clusters.test.ts`

**Interfaces:**
- Consumes: `whitespaceLines` (Task 1).
- Produces: `cutByLines(removedWs: readonly boolean[], addedWs: readonly boolean[], pairs: readonly [number, number][]): HunkPiece[]` (pairs = in-hunk twin index pairs, in order); `cutClusters(hunks, keysOf, text: { oldLines: string[]; newLines: string[]; noNewlineAtEnd: boolean })`.

- [ ] **Step 1: Failing tests:**
  - `whitespace.test.ts` "re-indent across an accidental unchanged line": made-up JSX, a block wrapped one level deeper in a new `<Provider>`, where `<div>` at the old depth equals a `<div>` at the new depth byte for byte. Build its display hunk; the cut's change lines are exactly the two Provider lines, everything else whitespace-only; the accidental line stays context.
  - "a block moved across a change stays a change": whitespace twin only reachable by crossing a changed line: change.
  - `cutByLines` cases: in-hunk pairs give two-sided whitespace-only pieces as today; a gap's removed runs come first, then its added runs, each maximal same-flag run its own piece (one-sided whitespace-only pieces allowed); pieces cover every line once, in order (property).
  - `snapshot.test.ts`: the pinned keys stay for hunks that don't span an accidental unchanged line; add one fixed hunk that does and pin its new keys.
  - "reset, no carry": a review with marks on clusters the new cut re-keys opens with those clusters unreviewed and every other mark kept.
- [ ] **Step 2:** The new tests fail.
- [ ] **Step 3:** In `snapshot.ts`, build display hunks (`buildDisplayHunks(oldLines, newLines, <git hunks with temporary keys>, 3, noNewlineAtEnd)`) from the uncut git hunks, take `whitespaceLines` per display hunk, and cut each git hunk with `cutByLines`; `splitCluster` takes the flags and pairs instead of calling `splitHunk`. Number one-sided pieces as git numbers a side with no lines (it starts at the line it follows). `Cluster.split` (whole hunk key, removedAt, addedAt) as today.
- [ ] **Step 4:** Tests pass; `pnpm verify:fast origin/master`.
- [ ] **Step 5:** Update the docs above; commit. Report a release note: `Release note (fixed): A block that only moved deeper is whitespace-only all through, even where git splits it around a line that happens to match; reviews in progress lose marks on those few clusters, which read unreviewed again.`

### Task 3: Since pieces cut at whitespace runs, flagged on the interdiff

**Files:**
- Modify: `src/shared/pieces.ts` (`SincePiece.whitespaceOnly`, `sincePieces`, `sinceUnits`), `src/server/rereview/engine.ts` (`interdiffFileHunks` ~:838–970, the call at ~:952)
- Test: `src/shared/pieces.test.ts`, `src/server/rereview/engine.test.ts` (or the file that tests `interdiffFileHunks`)

**Interfaces:**
- Consumes: `whitespaceLines` (Task 1).
- Produces: `SincePiece.whitespaceOnly?: true`; `sincePieces(hunks, clusters, facts, ws?: { lines: ReadonlySet<DiffLine>; marked: (line: DiffLine) => boolean })`: runs are also cut where membership in `ws.lines` changes; a piece is `whitespaceOnly` when all its lines are in `ws.lines` and `ws.marked(line)` for each. `sinceUnits` takes a piece unit's `whitespaceOnly` from the piece; a rest unit keeps its cluster's flag.

- [ ] **Step 1: Failing tests:**
  - "a re-indent since the last review is whitespace-only": patch set 1 changes a block (marked reviewed); patch set 2 only re-indents it, with an accidental byte-equal line inside; since patch set 1, its pieces are whitespace-only.
  - "an unread re-indent still counts": the same, but patch set 1's lines were never marked: not whitespace-only.
  - "a real edit since counts though its cluster is whitespace-only against the base": piece not whitespace-only.
  - "pieces split at whitespace runs": a since run of mixed lines yields separate pieces; every interdiff changed line in exactly one piece (property over random hunks).
- [ ] **Step 2:** They fail.
- [ ] **Step 3:** In `interdiffFileHunks`, take `whitespaceLines` per interdiff display hunk; `marked(line)`: the line's twin on the interdiff's old side (the earlier patch set's head) held a human mark there, looked up as `sinceLineSources`/`humanMarksOf` look lines up (`traced.lineKeys.old`); a line with no twin there, or no mark, is not marked. Pass both to `sincePieces`.
- [ ] **Step 4:** Tests pass; `pnpm verify:fast origin/master`.
- [ ] **Step 5:** Commit.

### Task 4: Since counts judge whitespace on since units

**Files:**
- Modify: `src/web/files/since.ts` (`countedUnits`, `countedFileUnits`, `clustersOf`, `sinceByFile`), `docs/product-rules.md` (since view: whitespace-only judged on the interdiff; "nothing but whitespace" by since units; what `~` counts)
- Test: `src/web/files/since.test.ts`

**Interfaces:**
- Consumes: `SinceUnit.whitespaceOnly` (Task 3).
- Produces: `countedFileUnits(units, ignoreWhitespace)` (the `clusters` parameter goes: a file is nothing else when all its units are whitespace-only); the left-out count: a cluster's units as one, each unit without a cluster on its own.

- [ ] **Step 1: Failing tests:** "a file of only whitespace-only since units counts them all on its header"; "a file whose snapshot clusters are changes but whose since units are all whitespace-only reads nothing else in the since view"; "units without a cluster each count once in the `~`" (two since-only whitespace-only units in one file → 2).
- [ ] **Step 2:** They fail.
- [ ] **Step 3:** Implement; update callers of `countedFileUnits`.
- [ ] **Step 4:** Tests pass; `pnpm verify:fast origin/master`.
- [ ] **Step 5:** Docs; commit.

### Task 5: End to end in both views, and the gallery case

**Files:**
- Modify: `e2e/whitespace.spec.ts`, `e2e/rereview.spec.ts` (or the spec that covers the since view's Ignore whitespace)
- Gallery: https://github.com/Gilthans/carbonless-gallery, branches `base/ws-across-hunks`, `case/ws-across-hunks`, a README row (writes there are pre-approved)

- [ ] **Step 1: Failing e2e tests:**
  - Base view: the made-up re-indent across an accidental line; with Ignore whitespace on, the whole block reads quiet `~`, its clusters show `~`, and the bar counts only the two Provider lines' clusters; off, everything counts.
  - Since view: patch set 2 only re-indents a block patch set 1 changed and the reviewer marked; since patch set 1 with Ignore whitespace on, the block is quiet, its units leave the since bar, and the `~` says how many; an unmarked variant still counts.
- [ ] **Step 2:** They fail on origin/master.
- [ ] **Step 3:** Fix what the e2e finds (no new behaviour beyond Tasks 1–4).
- [ ] **Step 4:** `pnpm test:e2e e2e/whitespace.spec.ts e2e/rereview.spec.ts --project=chromium` passes; `pnpm flake-check` on the new tests.
- [ ] **Step 5:** Gallery PR: a made-up component wrapped in a new provider with an accidental byte-equal line, plus a second push that only re-indents a block the first changed; PR description says what to look at in both views. Commit tests; report the gallery PR link.
