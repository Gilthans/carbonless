# Markdown renderer (CAR-167)

Status: design, 2026-11-18. Builds on CAR-38's renderer seam
(`docs/superpowers/specs/2026-11-11-custom-renderers-design.md`, merged as
PR #118).

## Intent

A `.md` file in a PR reads best rendered: headings, lists, tables, links,
as the people who'll read the file will see it. Today crb shows it only as a
line diff. The reviewer should be able to review a Markdown file in its
rendered form, ticking each change, with nothing lost against the line view.

The owner's words:

- 2026-11-11: "md does need to support clusters and marking each one
  separately, as well as carry overs. It's easier there, since the rendered
  view can be easily mapped to the 'code' lines. The md view would need to
  have a toggle between the rendered view and the raw view."
- 2026-11-18, choosing one review box per rendered block: "Ideally, the
  cluster would be split according to the rendered blocks, and not
  according to the line changes, so I'd rather the line view align with the
  rendered view in this case."
- 2026-11-18, on blocks reshaped between versions (one old paragraph
  rewritten as two): pair each old block with its closest new block, "We can
  always improve the pairing."
- 2026-11-18, on comments: a comment on a block goes "on all the changed
  lines in the last cluster of the block".
- 2026-11-22, on a block with two separate edits (unchanged lines between
  them): "Definitely show two separate edits whenever possible", so each
  edit keeps its own cluster and box.

Prior art: plannotator's plan diff (MIT/Apache-2.0,
github.com/backnotprop/plannotator, `packages/ui/utils/planDiffEngine.ts`,
`packages/ui/components/plan-diff/`). We borrow its ideas, not its code:
diffing source lines so every block keeps exact line ranges, a colored bar
per changed block, words marked inline in a changed block, code fences and
links treated as one token, and a fold row that names the headings it hides.
We don't borrow its fading of unchanged and removed blocks (too close to
hiding a change).

## Goals

1. **Clusters of a Markdown file follow its rendered blocks**, in every view.
   The server cuts each hunk of a `.md` file at Markdown block boundaries;
   each piece is its own cluster. The line view, the rendered view, the file
   tree's counts and progress all see the same clusters.
2. **A Rendered view** for `.md` files: the whole document rendered, each
   changed block with a review box per cluster in it (usually one; a block
   with two separate edits has two), a colored bar, and its changes marked.
3. **Rendered and Text** switch with the view buttons CAR-38 added. A `.md`
   file opens in Rendered; the pick per file is remembered like images'.
4. **Carries, re-review and comments work as for any cluster.** Ticks made
   before this change carry onto the new pieces; nothing resets.

## Non-goals

- Moved sections or reordered list items shown as moves. A move reads as a
  removal and an addition (as today in the line view).
- Rendering raw HTML blocks, front matter, math or Mermaid. They show as
  source inside the rendered page.
- Other Markdown-like formats (`.mdx`, `.rst`, AsciiDoc): later, CAR-168.
- A better pairing of reshaped blocks than the line pairing gives: later.
- Comments on a selected span of rendered text.

## Anti-goals (a failure even if it works)

- **The rendered view can never hide a change (principle 2).** Every changed
  source line is in exactly one cluster, and every cluster has its box in
  both views. A block the renderer fails to render, or can't place, shows its
  source with its box; a whole-file render failure falls back to Text. No
  fading of unchanged or removed blocks.
- **Clusters never depend on the view.** The cut depends only on the file
  being Markdown (by extension), never on the renderer the reviewer picked.
  Switching views never changes what's ticked.
- **No XSS from PR content.** The PR's Markdown is untrusted.

## Constraints

- CLAUDE.md principles 2 (coverage server-side), 5 (360px phone, 40px taps),
  6 (icon-first, tokens only), 8 (loading never looks empty).
- Cluster identity: the cut is part of cluster identity (CAR-156,
  `docs/review-data-storage.md`). The new cut must keep keys stable for an
  unchanged file across snapshots, and carry marks made on the uncut hunk
  onto its pieces through the existing split carry
  (`src/server/review/splitCarry.ts`, `Cluster.split`).
- Sanitize per the review checklist: rendered HTML through the existing
  DOMPurify path (`src/web/sanitizeGithubHtml.ts` is the model), `safeHref`
  for links, with a test that fails without it.

## Approaches considered

1. **Cut clusters at block boundaries on the server, for every view
   (picked).** One set of clusters; the rendered view's box per block is
   simply a cluster's box. Reuses CAR-156's cut and carry.
2. **Group clusters by block only in the rendered view.** The line view keeps
   today's clusters; a block's box ticks every cluster under it. Dropped:
   the owner wants the line view to line up with the rendered view, and a
   cluster spanning two blocks would show in both.
3. **Cut only while the rendered view is open.** Dropped: ticks would depend
   on the view used, breaking principle 2's "coverage is server-side" and the
   anti-goal above.

For blocks reshaped between versions, two options were considered: (1) cut
by the new blocks and pair each old block with its closest new block
(picked); (2) keep a reshaped stretch as one cluster covering several
blocks (dropped: one box would span several blocks).

## Design

### Blocks

A block is the smallest rendered unit a reviewer ticks:

| Markdown | Block |
|---|---|
| paragraph, heading, thematic break | one each |
| list item | one per item; a nested item is its own block, apart from its parent's own lines |
| table | one per row (the header row and its delimiter row together) |
| fenced or indented code | the whole fence, never split by the block cut |
| blockquote | each block inside it, as above |
| front matter (`---` at the top), raw HTML block, link reference definitions | one each, shown as source |

Blank lines belong to no block. A changed blank line goes with the block it
follows (or the next block, at the top of the file).

Block boundaries come from a Markdown block parse of each side's text, with
line numbers. `marked`'s lexer (already a dependency) gives tokens with
`raw`, from which line ranges follow; the builder may pick another
CommonMark/GFM parser if line ranges are more reliable. The parse runs on
the server (it cuts clusters) and its rules are shared with the web
renderer, so both agree on what a block is.

### The cut (server)

`cutClusters` (`src/server/diff/snapshot.ts`) gains a second cut for files
whose path ends in `.md` or `.markdown` (case-insensitive), after the
whitespace cut (CAR-156) and on its pieces:

1. Parse the old and new text into blocks (line ranges).
2. For each line cluster, split its added lines by the new blocks they fall
   in, and its removed lines by the old blocks they fall in.
3. Pair each old block's removed lines with a new block's added lines: the
   new block holding the most of its lines' pairs under the line pairing
   (`src/web/files/linePairing.ts`, moved to `src/shared` so the server can
   use it; `PAIR_MIN_SIMILARITY` and the caps as there). Where no line pairs,
   an old block pairs with the new block at the same position in the hunk if
   both sides have the same number of blocks, else with none.
   **The pairing keeps order and contiguity** (coordinator's call,
   2026-11-18): a cluster stays one contiguous removed range plus one
   contiguous added range, as `Cluster`, `ClusterSplit` and the
   `split-carried` event assume today. So pairings may not cross (old 1 →
   new B with old 2 → new A) and a new block's old blocks must be adjacent;
   an old block that would break either becomes a removal-only cluster.
   This keeps the change a cut, not a storage format change. A better
   pairing later (the owner: "We can always improve the pairing") may lift
   it with a format change.
4. Each new block with its paired old blocks is one cluster. An old block
   paired with none is a removal-only cluster.
5. Pieces are numbered and keyed as the whitespace cut's are, with `split`
   pointing at the uncut hunk's key, so marks on the hunk carry.

**Carries from the whitespace cut** (coordinator's call, 2026-11-18): a
piece the block cut leaves whole keeps its key, so its marks stay. A
whitespace piece (CAR-156) that the block cut splits again loses its marks
(it reads unreviewed: the safe direction) rather than a chained carry that
would change the `split-carried` format. This reaches only `.md` files
marked in the few days since CAR-156 merged (2026-11-15).

**A block with two separate edits keeps two clusters** (the owner,
2026-11-22: "show two separate edits whenever possible"). When unchanged
lines lie between two edits in one block (a long paragraph, a code fence),
git gives two hunks; the cut only splits, never merges, so the block gets
one cluster per edit, each with its own box, in both views. The block
renders once with both edits marked, its boxes stacked on its bar in
source order.

A cluster still never mixes lines of two new blocks. A whitespace-only run
inside a block stays its own cluster (CAR-156 runs first); in the rendered
view it shows with its block (see below). Above the line pairing's caps, no
lines pair, so step 3 falls back to position or none: a wrong pairing only
affects how words are marked, never coverage.

Files over a size cap the builder sets (measured; at least plannotator's
300 KiB) skip the block cut and keep today's clusters; the rendered view is
then not offered for them.

### The Rendered view (web)

A renderer `markdown` on the seam (`src/web/files/renderers/`):

- `claims`: `.md` / `.markdown`. View buttons: Rendered (default), Text.
  `units: "lines"`, `anchors: ["file", "lines"]`.
- **Compare** (unified view): the new document rendered top to bottom, with
  removal-only blocks placed where they were. Each block of a cluster gets:
  - a left bar and box: green (added), red with the text struck through
    (removed), amber (changed);
  - in a changed block, changed words marked inline (green tint for added,
    red struck for removed), from the same word diff the line view uses,
    with inline code, links and emphasis spans as single tokens;
  - a block the word diff can't apply to (a table row whose cells changed
    shape, a code fence, a heading whose level changed): old rendered and
    struck above the new;
  - the box is the cluster's existing review control, with its carry and
    reworked/reverted labels as in the line view.
- **Unchanged blocks** render at full strength. Runs of more than a few
  unchanged blocks fold into a row like the line view's context folds,
  naming the headings it hides; it expands in place. The fold row never
  hides a changed block.
- **Single** (side-by-side, an added or deleted file): each side rendered;
  in side-by-side, the old and new documents side by side on desktop,
  stacked on a phone, with boxes on the new side (removal-only clusters on
  the old).
- **Whitespace-only clusters** in a block (CAR-156): each keeps its own
  box, a small extra box on the same bar with the `~` mark CAR-184 uses.
  With Ignore whitespace on, it is left out as in the line view.
- **Threads**: a line thread shows under the block that holds its line.
  Switching to Text shows it on its exact line.
- **Comments**: a block's comment button posts a GitHub comment on all the
  changed lines of the block's last cluster, as the owner asked
  (`start_line`..`line`, on the new side; a removal-only block's on the old
  side). A whitespace-only cluster counts as last only when the block has
  no other (coordinator's call). An unchanged block has no comment
  button (GitHub takes line comments only inside the diff); the file comment
  stays in the header as for images.
- **Find** stepping to a line in Rendered view lands on its block; a hit in
  source that isn't rendered (a link's URL) switches to Text for the view,
  as CAR-38's `useLineTargetText` does for SVG.
- **Loading**: as the Text view (principle 8).

### Sanitizing

`marked` renders to HTML; DOMPurify sanitizes it with an allow-list
(no `script`, `style`, `iframe`, event handlers; `safeHref` on every link).
Images: relative images resolve to the blob route at the same revision
(CAR-38's `blobUrl`), remote images are not loaded by default (a placeholder
showing the URL, click to load) because loading them would tell a third party
the review is open. Raw HTML blocks show as source.

## Left to the builder

- The parser (marked's lexer or another), as long as line ranges are exact
  and the server and web agree.
- The size cap for the block cut (measured, see above), and the CPU guard for
  the cut's pairing (as `ALIGN_*` caps, a ratio test per CLAUDE.md).
- Exact styles, from the tokens; the fold threshold.
- Whether removal-only blocks in the unified view sit before or after their
  neighbour when position is ambiguous.

## Tests that must exist

- Unit: the cut on hand-made Markdown pairs (a word change in one list item
  of five; a paragraph split in two; a deleted section; a table row change;
  a change inside a code fence; a whitespace-only change in a paragraph).
  Every changed line in exactly one cluster (a property test over random
  Markdown edits).
- Unit: carry: marks on an uncut hunk carry onto its block pieces.
- Unit: sanitizing (script, `javascript:` link, `onerror`, remote image)
  fails without the sanitizer.
- e2e (desktop + phone): Rendered by default; tick a block, the same cluster
  is ticked in Text; a comment on a block posts start_line..line; fold row;
  switching views keeps ticks; loading state.
- Coverage pin: renderer state never feeds `buildReviewView` (as CAR-38).
- Gallery PR: a Markdown case (README edits: list items, a table row, a
  split paragraph, a code fence, a deleted section).

## Mockups

Desktop and phone mockups: linked from the CAR-167 ticket.
