# Markdown Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `.md` files are reviewed rendered, with one cluster per rendered block (cut on the server, so the Text view shows the same clusters), a box per cluster on its block, and Text one tap away, in the full diff and in the since view (interdiff) alike.

**Architecture:** A shared block parser (`src/shared/markdownBlocks.ts`) gives each side's blocks as line ranges. The server cuts each `.md` hunk at block boundaries after CAR-156's whitespace cut (`cutClusters`), pairing old and new blocks with the existing line pairing, and keeps `Cluster.split` so marks carry. The web gets a `markdown` renderer on CAR-38's seam that renders the document from both sides' text, tags each block with its index, and puts the clusters' existing review controls on the blocks.

**Tech Stack:** TypeScript, `marked` 18 (lexer + renderer), DOMPurify 3, diff-match-patch, React + TanStack Query, Vitest, Playwright (desktop + phone).

**Spec:** `docs/superpowers/specs/2026-11-18-markdown-renderer-design.md`

## Global Constraints

- The block cut applies to paths ending in `.md` or `.markdown`, case-insensitive, by the **new** path (a deleted file: its old path). Never by the renderer picked.
- Every changed source line is in exactly one cluster; every cluster has its box in both views (principle 2). A render failure shows the block's source with its box; a whole-file failure falls back to Text.
- A cluster stays one contiguous removed range plus one contiguous added range; the cut only splits, never merges (two edits in one block = two clusters, two boxes).
- Pairings never cross, and a new block's old blocks are adjacent; an old block that breaks either becomes a removal-only cluster.
- A piece the block cut leaves whole keeps its key. A CAR-156 whitespace piece split again loses its marks (no chained carry, no `split-carried` format change).
- Size cap: files over the cap (measured; at least 300 KiB, either side) skip the block cut and are not offered Rendered.
- Sanitize: DOMPurify, no `script`/`style`/`iframe`/event handlers, `safeHref` (`src/web/ui.tsx`) on every link; remote images not loaded until clicked; relative images through `blobUrl` (`src/web/api.ts`); raw HTML blocks, front matter, math, Mermaid shown as source.
- UI: tokens only, icon-first, 40px taps, 360px phone with no page scroll, loading never looks empty (`Spinner`/`SkeletonBar`, `aria-busy`).
- No fading of unchanged or removed blocks; colors: green added, red struck removed, amber changed.
- **Interdiff is first class** (owner, 2026-11-22: "everything that works on basediff should work on interdiff as well"): every task that adds behaviour to the full diff adds it to the since view in the same task, with tests in both.
- Tests: CPU guards as ratios (`test/cpu.ts`), never wall-clock; no retries; held answers for loading states.

## Review Focus

1. **CRLF and no-newline-at-end `.md` files**: block line ranges must match git's line numbers exactly; a CRLF file or one ending without a newline cuts the same as its LF twin (Task 1, Task 2 tests).
2. **A rename between `.md` and another extension** (`notes.txt` → `notes.md`, or the reverse): the cut follows the new path; both sides are still parsed as Markdown when the new path is `.md` (Task 3 test).
3. **Ignore whitespace on, in Rendered**: whitespace-only clusters drop out of the rendered view exactly as from the line view, and their block shows no stray box (Task 6 test).
4. **The since view on a file whose compared patch set wasn't Markdown-cut** (a `.md` file renamed since, or over the cap on one patch set): pieces still cover every changed line, and Rendered falls back to Text only when either side is over the cap; read-only earlier patch sets show locked boxes (Task 3b, Task 6 tests).
5. **Nested structures**: a list item with a continuation paragraph, a list inside a blockquote, a table inside a list: every line still lands in exactly one block, and the renderer tags the same blocks the server cut by (Task 1 property test, Task 4 test).

---

### Task 1: Markdown blocks with line ranges (shared)

**Files:**
- Create: `src/shared/markdownBlocks.ts`
- Test: `src/shared/markdownBlocks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MdBlockKind = "paragraph" | "heading" | "hr" | "list-item" | "table-row" | "code" | "front-matter" | "html" | "def";
  export interface MdBlock { kind: MdBlockKind; from: number; to: number; depth: number } // 1-based inclusive source lines; depth = list/quote nesting
  export function markdownBlocks(lines: readonly string[]): MdBlock[]  // in document order, non-overlapping
  export function blockOfLine(blocks: readonly MdBlock[], line: number): number // index; a blank line belongs to the block before it, else the first block; -1 for a file with no blocks
  export const isMarkdownPath: (path: string) => boolean // /\.(md|markdown)$/i
  ```

- [ ] **Step 1: Write the failing tests** — one `it` per row of the spec's Blocks table, asserting exact `{kind, from, to}` lists:
  - two paragraphs and an ATX heading → three blocks; a setext heading spans its two lines;
  - `- a\n- b\n  - c\n- d` → four `list-item` blocks; the parent `b` is `[2,2]`, nested `c` is `[3,3]`, depth 1;
  - a list item with a continuation paragraph (`- a\n\n  more`) → one block `[1,3]`;
  - a 3-row table → header+delimiter `[1,2]`, then one `table-row` per row;
  - a fenced block containing a blank line and `# not heading` → one `code` block;
  - `> p1\n>\n> - x` → `paragraph` `[1,1]` and `list-item` `[3,3]`, depth 1;
  - front matter `---\ntitle: x\n---\n# H` → `front-matter` `[1,3]`, `heading` `[4,4]`;
  - a raw HTML block and a link reference definition each one block;
  - `blockOfLine`: a blank line between blocks 0 and 1 → 0; a blank first line → 0.
  - CRLF: the same document with `\r` kept at line ends gives the same ranges.
  - Property test (fast-check if present in `package.json`, else a seeded generator): for random documents built from the constructs above, blocks are sorted, non-overlapping, and every non-blank line is in exactly one block.

- [ ] **Step 2: Run** `pnpm test src/shared/markdownBlocks.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement** with `marked.lexer` on `lines.join("\n")`: walk tokens in order, advancing a line counter by the newlines in each token's `raw`; descend into `list` → `list_item` (the item's own lines up to its first nested `list` token are its block), `blockquote` → its tokens, `table` → header+align rows then one per row. Front matter is detected before lexing (`---` on line 1 through the next `---`/`...`) and the rest lexed with the offset. Must run in Node and the browser (no DOM).

- [ ] **Step 4: Run** the test file — expected PASS. `pnpm verify:fast` lint/typecheck clean.

- [ ] **Step 5: Commit** `git commit --only -- src/shared/markdownBlocks.ts src/shared/markdownBlocks.test.ts -m "Markdown blocks with exact line ranges (CAR-167)"`

---

### Task 2: The block cut of one cluster (server)

**Files:**
- Create: `src/shared/blockCut.ts` (shared: the server's cut and the since view's pieces use it)
- Test: `src/shared/blockCut.test.ts`

**Interfaces:**
- Consumes: `MdBlock`, `blockOfLine` (Task 1); `alignCluster`, `AlignBudget` (`src/shared/linePairing.ts`). `HunkPart` and `LineCluster` move from `src/server/diff/clusters.ts` to `src/shared/` (re-exported there) so the shared module can name them.
- Produces:
  ```ts
  /** The block cut's grouping, shared with the since view's pieces (Task 3b). Index ranges into removed/added, in order. */
  export interface BlockGroup { removed: [from: number, to: number]; added: [from: number, to: number] }
  export function groupByBlocks(
    removed: readonly string[], added: readonly string[],
    oldBlockOf: (i: number) => number, newBlockOf: (i: number) => number,
    budget?: AlignBudget,
  ): BlockGroup[] // one group = nothing cuts
  export function cutAtBlocks<C extends LineCluster>(
    c: C,
    oldBlocks: readonly MdBlock[],
    newBlocks: readonly MdBlock[],
    budget?: AlignBudget,
  ): HunkPart<C>[] // removedAt/addedAt relative to `c`; [{cluster: c, removedAt: 0, addedAt: 0}] when nothing cuts
  ```

- [ ] **Step 1: Write the failing tests** (hand-made old/new texts; assert each piece's `oldStart/oldCount/newStart/newCount` and `removed`/`added`):
  - a word change in item 3 of a five-item list → the cluster is untouched (one block each side);
  - one hunk spanning items 2 and 4 changed with item 3 changed too → three pieces, one per item, each old item paired with its new item;
  - a paragraph split in two (old P → new P1, P2) → one piece holding old P + the new block most of its lines pair with, and an add-only piece for the other;
  - a deleted section (heading + paragraph removed) → two removal-only pieces;
  - a table row changed beside an added row → a changed piece and an add-only piece;
  - a change inside a code fence of 10 lines (one hunk) → one piece;
  - crossing: old A,B rewritten so A pairs best with new B' and B with new A' → the later one becomes removal-only, no crossing pieces;
  - no pairs, same block count → position pairing; different counts → removal-only + add-only;
  - pieces keep `noNewlineOld/New` only on the piece holding the last line (as `splitCluster`);
  - Property: over random Markdown edits, the pieces' removed lines concatenate to `c.removed`, added to `c.added`, in order; each piece's lines lie in one block per side; removed ranges and added ranges are each non-decreasing.

- [ ] **Step 2: Run** `pnpm test src/shared/blockCut.test.ts` — expected FAIL.

- [ ] **Step 3: Implement** `groupByBlocks`, then `cutAtBlocks` as a thin wrapper numbering the groups' pieces. Group removed lines by old block (`blockOfLine` on `oldStart + i`), added by new block. One group each side → return `c` whole. Else `alignCluster(removed, added, budget)`; each old group's target is the new group holding most of its pairs (ties: the earlier). No pairs at all: position if counts match, else none. Then enforce order and contiguity:
  ```
  last = -1; prevTarget = undefined
  for each old group g in order:
    t = target(g)
    if t === undefined || t < last || (t === last && prevTarget !== t): target(g) = none
    else last = t
    prevTarget = target(g)
  ```
  Emit one piece per new group (with its assigned old groups) and one per unassigned old group, ordered by position in the hunk (removal-only before the new group that follows it). Numbering as `splitCluster` (a side with no lines starts at the line it follows).

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `git commit --only -- src/shared/blockCut.ts src/shared/blockCut.test.ts -m "Block cut: one cluster per Markdown block, pairing in order (CAR-167)"`

---

### Task 3: Wire the cut into snapshots, carries and docs

**Files:**
- Modify: `src/server/diff/snapshot.ts` (`cutClusters`, its caller near line 303)
- Modify: `src/shared/types.ts` (`FileSummary`)
- Modify: `docs/review-data-storage.md` ("Split carries")
- Test: `src/server/diff/snapshot.test.ts`, `src/server/review/splitCarry.test.ts`

**Interfaces:**
- Consumes: `cutAtBlocks` (Task 2), `markdownBlocks`, `isMarkdownPath` (Task 1).
- Produces:
  ```ts
  export function cutClusters(
    hunks: Omit<Cluster, "key">[],
    keysOf: (clusters: Omit<Cluster, "key">[]) => string[],
    markdown?: { oldLines: string[]; newLines: string[] }, // given only for a Markdown path under the cap
  ): Cluster[]
  // FileSummary gains:
  /** The clusters are cut at Markdown blocks (CAR-167): the Rendered view is offered. */
  markdownBlocks?: true;
  export const MARKDOWN_CUT_MAX_BYTES: number // measured, >= 300 * 1024
  ```

- [ ] **Step 1: Write the failing tests:**
  - `snapshot.test.ts`: a `.md` file with one hunk across two list items gets two clusters and `markdownBlocks: true`; the same content as `.txt` gets one cluster and no flag; `notes.txt` → `notes.md` rename is cut; a `.md` over `MARKDOWN_CUT_MAX_BYTES` is not cut and not flagged; an unchanged-elsewhere `.md` across two snapshots keeps every key; a hunk the block cut leaves whole has the key it had before this change.
  - `splitCarry.test.ts`: a mark on the uncut git hunk carries onto its block pieces (reviewed, crossed-off, partly reviewed lines); a whitespace piece (CAR-156) that the block cut splits again comes back unreviewed; a whitespace piece left whole keeps its mark.
  - CPU: cutting a 300 KiB Markdown file costs at most 4× four cuts of its quarter (`test/cpu.ts` scaling check).

- [ ] **Step 2: Run** `pnpm test src/server/diff/snapshot.test.ts src/server/review/splitCarry.test.ts` — expected FAIL.

- [ ] **Step 3: Implement.** In `cutClusters`, after `splitCluster`, when `markdown` is given run `cutAtBlocks` on each piece (blocks parsed once per side, one `AlignBudget` of `HUNK_ALIGN_WORD_OPS` per file), composing `removedAt/addedAt` so `split` still points at the **git hunk** key with positions in it. In the caller, pass `markdown` when `isMarkdownPath(file.path)` (old path for a deleted file), the file is text, and both sides are under the cap; set `markdownBlocks: true` then. Measure the cap on the devbox (a generated 300 KiB and 1 MiB README) and set the constant with a comment saying what was measured. Update `docs/review-data-storage.md`: the cut now includes Markdown blocks, keys of whole pieces unchanged, whitespace pieces split again reset.

- [ ] **Step 4: Run** — PASS; `pnpm verify:fast` clean (methodology and coverage tests in its map).

- [ ] **Step 5: Commit** the five paths with `git commit --only -- …` "Markdown files: clusters cut at blocks on the server (CAR-167)".

---

### Task 3b: Since view pieces cut at Markdown blocks

**Files:**
- Modify: `src/shared/pieces.ts` (`sincePieces`)
- Modify: `src/server/rereview/engine.ts:952` (passes the blocks)
- Modify: `src/shared/types.ts` (the since answer's file entry: `markdownBlocks?: true`)
- Test: `src/shared/pieces.test.ts`, `src/server/rereview/engine.test.ts` (or the since-view test file that covers `sincePieces` from the engine)

**Interfaces:**
- Consumes: `groupByBlocks` (Task 2), `markdownBlocks`, `isMarkdownPath`, `MARKDOWN_CUT_MAX_BYTES` (Tasks 1, 3).
- Produces:
  ```ts
  export function sincePieces(
    hunks, clusters, facts?,
    blocks?: { old: readonly MdBlock[]; new: readonly MdBlock[] }, // the since view's two sides, for a Markdown file under the cap
  ): SincePiece[]
  ```

- [ ] **Step 1: Write the failing tests:** in `pieces.test.ts`, a since hunk whose one run spans two list items (one cluster) gives two pieces, each owning only its item's lines; a run across a whitespace-only change inside a paragraph keeps one piece per cluster as before; without `blocks`, output is unchanged (every existing test still passes); every changed line of the hunks is in exactly one piece (property, random Markdown edits on both patch sets). In the engine test, a `.md` file's since answer has block-cut pieces and `markdownBlocks: true`; a `.txt` file's doesn't.

- [ ] **Step 2: Run** `pnpm test src/shared/pieces.test.ts` and the engine test — FAIL.

- [ ] **Step 3: Implement:** in `sincePieces`, after a run is formed, split it with `groupByBlocks` (the run's del lines by old-side block, add lines by new-side block); each group a piece with its own `owns`, `old`, `new`. The engine reads both sides' texts it already has for the interdiff and passes their blocks when the path is Markdown and both are under the cap.

- [ ] **Step 4: Run** — PASS; `pnpm verify:fast` (re-review and methodology specs are in its map).

- [ ] **Step 5: Commit** "Since view: pieces of a Markdown file cut at its blocks (CAR-167)".

---

### Task 4: Rendering blocks, sanitized

**Files:**
- Create: `src/web/files/renderers/markdown/renderBlocks.ts`
- Test: `src/web/files/renderers/markdown/renderBlocks.test.ts`

**Interfaces:**
- Consumes: `markdownBlocks`, `MdBlock` (Task 1); `safeHref`; `blobUrl`.
- Produces:
  ```ts
  export interface RenderedBlock { index: number; html: string } // sanitized HTML for one block
  export function renderBlocks(
    lines: readonly string[],
    blocks: readonly MdBlock[],
    opts: { image: (src: string) => string | null }, // relative src → blob URL; null = remote (placeholder)
  ): RenderedBlock[]
  export function renderSource(src: string, opts: { image: (src: string) => string | null }): string // a block's (or merged) source → sanitized HTML
  ```

- [ ] **Step 1: Write the failing tests:**
  - every block in Task 1's fixtures yields one `RenderedBlock`, and a list item's HTML is an `<li>` (wrapped as needed to stay valid), a table row a `<tr>` inside its table;
  - front matter, raw HTML and math (`$$…$$`) render as `<pre>` source, escaped;
  - sanitizing, each failing without DOMPurify/`safeHref`: `<script>` gone; `[x](javascript:alert(1))` has no `href`; `<img src=x onerror=alert(1)>` (inline HTML in a paragraph) has no `onerror`; `![a](https://evil.example/p.png)` renders a placeholder button showing the URL, no `<img src>`; `![a](img/p.png)` gets the `image()` URL;
  - a block whose render throws gives its escaped source in `<pre>` (never drops the block).

- [ ] **Step 2: Run** `pnpm test src/web/files/renderers/markdown/renderBlocks.test.ts` — FAIL.

- [ ] **Step 3: Implement** with `marked.parse` per block source (list items wrapped in `<ul>`/`<ol start>`, table rows parsed with their header then the row extracted), DOMPurify with an allow-list modelled on `src/web/sanitizeGithubHtml.ts` (`uponSanitizeElement` hook for images, `safeHref` on `a`).

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** "Markdown renderer: blocks rendered and sanitized (CAR-167)".

---

### Task 5: Word marks in a changed block

**Files:**
- Create: `src/web/files/renderers/markdown/wordMarks.ts`
- Test: `src/web/files/renderers/markdown/wordMarks.test.ts`

**Interfaces:**
- Consumes: `tokenize` (`src/shared/tokenize.ts`), `MdBlock`.
- Produces:
  ```ts
  /** One source with removed words as <del> and added as <ins>, or null when the block can't take inline marks. */
  export function mergedSource(oldSrc: string, newSrc: string, kind: MdBlockKind): string | null
  ```

- [ ] **Step 1: Write the failing tests:** `"the quick fox"` → `"the <del>quick</del><ins>slow</ins> fox"`-shaped output; an inline code span, a link `[a](b)` and `**bold**` change as one token each (never a `<del>` inside the link's URL); `code`, `table-row` with a different cell count, and a `heading` whose level changed → `null`; identical sources → the source unchanged.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** with diff-match-patch over token-encoded strings (as the line view's word diff does), Markdown spans collapsed to single tokens by sentinel substitution before diffing and restored after.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** "Markdown renderer: changed words marked inline (CAR-167)".

---

### Task 6: The Rendered view with boxes, folds and view buttons

**Files:**
- Create: `src/web/files/ClusterControls.tsx` (moved out of `DiffBody.tsx:1845`, exported; DiffBody imports it)
- Create: `src/web/files/renderers/markdown/MarkdownView.tsx`, `MarkdownView.test.tsx`
- Modify: `src/web/files/renderers/index.ts` (`RendererId` adds `"markdown"`; `RENDERERS`; `rendererChoices`; `rendererPicks` allowed ids)
- Modify: `src/web/files/renderers/ViewSwitch.tsx` (Rendered/Text buttons, icon + tooltip)
- Modify: `src/web/files/FileDiff.tsx` (render `MarkdownView` when the renderer is `markdown`)
- Test: `src/web/files/renderers/resolve.test.ts`, `e2e/markdown-renderer.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5; `FileSummary.markdownBlocks` (Task 3); `blobUrl`; `hunksQuery`; `ClusterView`, `DiffBody`'s `onToggle`/`onCrossOff`.
- Produces:
  ```ts
  export function MarkdownView(props: {
    file: FileView; revision: string; sideBySide: boolean; readOnly?: boolean;
    onToggle: (c: ClusterView) => void; onCrossOff: (c: ClusterView) => void;
    threads?: DiffThreads; find?: DiffFind; landing?: Landing;
    view: ReactNode; // the view switch
    onShowText: () => void; // whole-file failure, or a find hit not rendered
  }): JSX.Element
  // MarkdownView also takes the since view's: from?: number; kinds?: Map<string, KindEntry>; onSinceMark?; sinceMarks? (as DiffBody)
  // renderers: markdown claims files with `markdownBlocks` (and not binary/lfs/submodule); choices ["markdown","text"], in the full diff and the since view alike.
  ```

- [ ] **Step 1: Write the failing tests:**
  - `resolve.test.ts`: a `README.md` with `markdownBlocks` resolves to `markdown`, choices `["markdown","text"]`; without the flag (over the cap) → `text` only; a pick of `text` is kept per path; in the since view `markdown` is offered when the since answer's file has `markdownBlocks`.
  - `MarkdownView.test.tsx` (fake hunks + texts): each cluster's box sits on the block(s) holding its lines (`data-block`), one box per cluster, a block with two clusters shows two boxes in source order; an added block has the green bar, a removal-only block red and struck where it was, a changed block amber with `<ins>/<del>`; a code fence change shows old struck above new; a run of more than 3 unchanged blocks folds into a row naming its headings and expands in place; a fold never holds a changed block; whitespace-only clusters show a small extra box with the `~` mark, and none with Ignore whitespace on; read-only shows locked boxes; a whole-file render failure calls `onShowText`.
  - an added file renders its new side with every block green and boxed; a deleted file its old side, red and struck;
  - since view: texts read with `from`; one box per since piece on its block (`onToggle(cluster, piece)`); kind chips (reworked/new) as the line view's; a reverted or removed piece shows struck, red, with its since-only box (`onSinceMark`); ticking a piece in Rendered ticks the same piece in Text.
  - **Coverage invariant:** for every fixture, the set of cluster keys with a box equals `file.clusters` keys (minus whitespace-only ones under Ignore whitespace).
  - e2e (desktop + phone, `e2e/markdown-renderer.spec.ts`): opens in Rendered; tick a block's box, switch to Text, the same cluster is ticked; switch back keeps it; a reload keeps the Text pick for that path only; the same tick-and-switch check in the since view of a second patch set (`e2e/rereview` helpers); loading shows the skeleton while the hunks are held (`expectLoadingThen`), never an empty document; at 360px no page scroll and boxes are 40px.

- [ ] **Step 2: Run** `pnpm test src/web/files/renderers` and `pnpm test:e2e e2e/markdown-renderer.spec.ts` — FAIL.

- [ ] **Step 3: Implement.** One component for both diffs: units are `file.clusters` in the full diff, `hunks.data.pieces` in the since view. Texts of both sides through `blobUrl(revision, index, side, from)` (as the image renderer's `useImageSide`), hunks through `hunksQuery`. Unified: the new document's blocks in order, with removal-only blocks inserted before the new block that follows their old position; side-by-side on desktop shows old and new columns, stacked under 640px (`NOT_PHONE`). Fold threshold: more than 3 unchanged blocks. Boxes are `ClusterControls` with the same callbacks as DiffBody, on a bar colored from tokens (`--added`, `--removed`, `--pending`-family as `docs/design/README.md` names them).

- [ ] **Step 4: Run** — PASS; `pnpm verify:fast` (with the phone project: this is layout).

- [ ] **Step 5: Commit** "Markdown renderer: Rendered view with a box per cluster on its block (CAR-167)".

---

### Task 7: Threads, block comments and find in the Rendered view

**Files:**
- Modify: `src/web/files/renderers/markdown/MarkdownView.tsx`
- Test: `src/web/files/renderers/markdown/MarkdownView.test.tsx`, `e2e/markdown-renderer.spec.ts`, the coverage pin test that CAR-38 added for renderer state (find it with `grep -rn "buildReviewView" src --include=*.test.ts`)

**Interfaces:**
- Consumes: DiffBody's thread placement (`placeThreads`), `ThreadBubble`, `NewThread`, `useThreadWriter`; `useLineTargetText` in FileDiff (generalise its `textable` to markdown).
- Produces: `export function blockCommentSpan(block: number, clusters: ClusterView[]): SpanRange | null` — the block's last cluster's changed lines (`startLine..line`, side RIGHT; LEFT for a removal-only block); a whitespace-only cluster is last only if the block has no other; null for an unchanged block.

- [ ] **Step 1: Write the failing tests:**
  - `blockCommentSpan`: a block with one cluster of added lines 12–14 → `{startSide:"RIGHT",startLine:12,side:"RIGHT",line:14}`; a block with a cluster then a whitespace-only cluster → the first; a removal-only block on old 30–31 → LEFT 30–31; unchanged → null.
  - Threads: a line thread on new line 13 shows under the block holding line 13; in Text it shows on line 13.
  - Find: stepping to a hit in a rendered block scrolls to that block; a hit inside a link URL switches the view to Text (`useLineTargetText`), the stored pick unchanged.
  - Coverage pin: renderer state (`rendererPicks`, `markdown`) never reaches `buildReviewView` (extend CAR-38's pin with `"markdown"`).
  - since view: `blockCommentSpan` over pieces; a comment on a removal-only block posts on its base line (CAR-217's mapping), as the since line view does; threads show under their block in the since view.
  - e2e: a comment on a block posts `start_line..line` to the fake gh (`p.ghLog()` shows `start_line: 12, line: 14, side: "RIGHT"`); an unchanged block has no comment button; the file comment stays in the header.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**, reusing the thread placement result keyed by line and mapping lines to blocks with `blockOfLine`.

- [ ] **Step 4: Run** — PASS; `pnpm flake-check e2e/markdown-renderer.spec.ts` (5 runs).

- [ ] **Step 5: Commit** "Markdown renderer: threads under their block, block comments, find (CAR-167)".

---

### Task 8: Gallery case, release note, PR

**Files:**
- carbonless-gallery: `base/markdown-readme` and `case/markdown-readme` branches, a README row
- Modify: nothing in the repo beyond earlier tasks

- [ ] **Step 1:** Push the gallery case: a README with list item edits, a table row change, a split paragraph, a code fence change, a deleted section, a paragraph with two separate edits, a whitespace-only change, a relative and a remote image; then a second push reworking two of those blocks, so the since view has something to show. Open its PR with what to look at.
- [ ] **Step 2:** Run `crb` on it from a branch instance and check every case in Rendered and Text, in the full diff and the since view (screenshots desktop + phone to the scratchpad).
- [ ] **Step 3:** Draft the release note in the report: `Release note (new): Markdown files open rendered, with a review box on each changed block; Text is one tap away.`
- [ ] **Step 4:** Open the PR on Gilthans/carbonless (`Fixes CAR-167`), what to QA with gallery links, edge cases; CI green.
