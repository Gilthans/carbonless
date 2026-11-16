# Custom renderers, starting with images

Status: design, 2026-11-11. Mockups: the "Image Diff Mockups" artifact
(link in the owner's chat; it includes the owner's comments, all applied).

## Why

A changed image shows in GitHub and in crb as "Binary file changed" (GitHub
renders only PNG, JPG, GIF, SVG and PSD; an installer's `.bmp` gets nothing).
The owner's last case: a WiX installer bitmap changed, and the only evidence
was a screenshot an AI pasted into the PR description. It had no "before",
nothing tied it to the latest push, and it didn't follow later pushes.

The fix is a general one: the text diff becomes one renderer among several,
and crb picks a renderer per file. Images come first. Markdown is the next
one the owner wants (rendered view mapped to source lines, with a
rendered/raw toggle). More unusual ones (GeoJSON, audio, 3D models,
spreadsheets) must not be blocked by the design.

Success: the reviewer sees an image's before and after in crb, compares them
with a slider or a fade, picks which two versions to compare with the
existing patch set graph, comments on the image, and ticks it reviewed.

## Goals (phase 1)

1. A renderer seam in the web app. Today's text diff becomes the default
   renderer behind it, with no change in behavior.
2. An image renderer for `.png .jpg .jpeg .gif .webp .avif .bmp .ico .svg`.
3. Unified view = the renderer's comparison: **Slider** (default) and
   **Fade**.
4. Side-by-side view = two single-version views next to each other.
5. Added and deleted images, size changes, and undecodable images handled
   (below).
6. A per-file renderer switch in the file header.
7. Comments on an image are whole-file comments (exists today).
8. Desktop and phone (360px), both covered by Playwright.

## Non-goals (phase 1, designed for, built later)

- **Changed-pixels view** (grey unchanged pixels, boxes around changed
  areas). The owner didn't like the mocked version, so it needs another
  design round.
- **Per-region review units** (each changed area ticked separately). It
  builds on changed-pixels.
- **Region comments** (drag a box on the image). See "Later: region
  comments" for the format to leave room for.
- **Git LFS images.** Until then, an LFS pointer shows as the small text
  file it is (today's behavior), with an LFS icon.
- **Markdown and other renderers.** The seam must fit them. They aren't
  built.
- Clusters and reworked/reverted labels for images.

## Anti-goals

- **A renderer must never affect coverage (principle 2).** Review units stay
  the server's clusters, computed from the git diff. A renderer that fails,
  shows nothing, or picks the wrong file can only leave a file unreviewed,
  never mark it reviewed or hide it.
- An image that is loading must not look like an empty or blank image
  (principle 8): the shared `Spinner` in a kept slot, `aria-busy` on the
  stage, and tested with a held fetch (`expectLoadingThen`).
- No new server of our own, and no image processing on the server.

## Design

### The renderer seam (web)

A renderer is a module in `src/web/files/renderers/` with:

| Part | What it is |
|---|---|
| `id` | `"text"`, `"image"`, later `"markdown"` and others |
| `claims(file)` | true for the files it can show by default (extension; for images, also not an LFS pointer) |
| `Single` | one version of the file (one side of side-by-side, and the only view of an added or deleted file) |
| `Compare` | two versions in one view (the unified view) |
| `units` | how the reviewer ticks: `"lines"` (today's clusters, partial ticks, carries) or `"whole-file"` (one control that ticks every cluster of the file) |
| `anchors` | comment anchors it offers: `"file"`, `"lines"`, later `"region"` |

Resolution order for a file: the reviewer's override, then the first
renderer that claims the file, then `text`. The text renderer wraps today's
`DiffBody` path as it is. The seam sits where `FileDiff` chooses a body, so
no text-diff code moves in phase 1.

Which two versions are shown comes from the existing comparison
(`src/web/files/comparison.ts`, the patch set graph's markers): the base
(the base branch or an earlier patch set) and the target. Interdiffs between
pushes work with no image-specific code.

**Coverage.** `units` only changes the control, not the data. The server
still builds clusters exactly as today. A binary image has one file-level
cluster ("Binary file changed"). An SVG is text and keeps its line clusters.
Re-review carries work as they do today on the same clusters.

The owner, 2026-11-11: an image "should act precisely as a renamed file
does today". For a binary image that holds with no new code: its one
file-level cluster is ticked, shown in the since view and carried exactly
like a renamed file's or a mode change's (`src/server/rereview/engine.ts`,
file-level since clusters). The rest of this section matters only for an
SVG, which has line clusters.

The owner, 2026-11-15, on SVG: "a tick should cover all changed lines. If
you want to review line by line, you should be doing it on the line diff
view". In Image view, one press covers every changed line the view shows;
ticking line by line happens in Text view.

The image renderer's review box ticks **exactly the units the current view
shows for this file**, through the same write path today's view uses for
them. In the full diff, those are the file's clusters (`/review/states`).
In the since view (`from=n`), they are the file's since pieces
(`sinceUnits`, `src/shared/pieces.ts`), never clusters outside the
interdiff, so a change made before patch set n is never ticked from a view
that didn't show it (principle 2). The box's rules (my call):

- It shows a mixed state when some of those units are reviewed (e.g. SVG
  lines ticked in Text view, or carried).
- A press ticks only the open units and never unticks.
- When all of them are reviewed, a press unticks them all.

If a unit is missing from what the renderer knows, it stays unreviewed,
because coverage is still `buildReviewView` on the server. Tests cover the
full-diff and since-view paths, plus the mixed state.

### Image bytes (server)

New route: `GET /api/r/:id/files/:index/blob?revision=R&side=old|new[&from=n]`.

- The path comes from the file index in the snapshot, never from the request.
  It reads with `git cat-file` in crb's clone.
- **Which blob is "old"** matches what the text view treats as before. In the
  full diff, that's the merge base's blob. With `from=n` (since view), it's
  the interdiff's old side (`src/server/rereview/interdiff.ts`): the virtual
  rebase H1′'s blob, or B2's for a conflicted file. **It is not patch set n's
  own commit**, which would show changes that came in from a moved base as
  the author's. When the interdiff is unavailable, the image does what the
  since view already does for that file. The blob oids come from the same
  code that produces the interdiff, so the two can't drift apart.
- `revision` is the snapshot id, as in the other file routes. A stale tab
  gets the usual `StaleSnapshotError`, and the image shows the same refresh
  path as text.
- `Content-Type` comes from a fixed extension table. For a file whose
  extension isn't in the table, and only on the reviewer's explicit "Show
  as Image", the type comes from the file's leading bytes matched against a
  fixed set of raster signatures (PNG, JPEG, GIF, WebP, BMP, ICO). Nothing
  that matches no signature, and never SVG or HTML, gets an image type: such
  a file is refused, and the view falls back to binary. Every response sends
  `X-Content-Type-Options: nosniff`.
- **SVG** is served with `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; sandbox`, and the web app only ever puts it in
  an `<img>`, so scripts never run (see the input-sanitization checklist).
- `ETag` is the blob oid, with `Cache-Control: private, max-age=31536000,
  immutable` (content by oid never changes).
- A size cap (my call: 10 MB loads automatically; above that, a tap loads
  it; above 50 MB the route refuses, and the file shows today's binary view).
  The file list entry gains the byte size of each side (from `git cat-file
  -s`) so the cap is known before fetching. Byte sizes also show in the
  toolbar.
- It uses the same access key as every other route.

### Unified view: comparison

Mockup section 1. A toolbar under the file header:

- A segmented icon control: **Slider** (default) and **Fade**. The choice is
  remembered per viewer (`viewSettings`, like other view choices).
- Dimensions and byte sizes, before → after (`493×312 → 493×340 · 41 → 44 KB`;
  red before, green after).
- Fit / 1:1 zoom toggle. 1:1 scrolls inside the stage container, never the
  page.

The stage:

- **Slider:** after underneath, before on top, clipped at the handle. Drag
  anywhere on the stage, or use arrow keys (it's an `input[type=range]`
  stretched over the stage, so it's accessible). `touch-action: pan-y`, so a
  vertical swipe still scrolls the page on a phone. "before" and "after" tags
  sit in the top corners.
- **Fade:** before on top with opacity set by a range under the stage
  (before ← → after).
- A checkerboard behind both shows transparency.
- **Size changed (owner's rule):** the stage is the larger width by the
  larger height of the two images, scaled to fit. Each image keeps its own
  size within it, pinned top-left. The checkerboard shows where one image
  doesn't reach. Slider and fade work unchanged.

### Side-by-side view: two single versions

Mockup section 2. It uses the existing Settings switch
(`crb.diff.sideBySide`). Before is on the left with a red edge, after on
the right with a green edge. Each side has a caption with its dimensions and
byte size. On a phone the two sides stack.

### Edge cases

Mockup section 3.

- **Added / deleted:** only the existing side, with a clear "added" (green) or
  "deleted" (red) label above the image and a matching edge. No comparison
  modes. Both unified and side-by-side show this single view.
- **Renamed with no content change:** today's file-level cluster and label.
  The image shows once (single view).
- **Browser can't decode it** (`.tiff`, `.psd`, a corrupt file, or `onerror`):
  falls back to today's binary view with byte sizes. Still one unit, still
  unreviewed until ticked.
- **LFS pointer:** the image renderer doesn't claim it. It shows as text, with
  an LFS icon in the header. The server detects it while building the
  snapshot, and `FileSummary` gains an `lfs?: true` flag. Only non-binary
  files with an image extension are checked, and only when a side is under
  200 bytes (the size read is batched with the byte sizes). Their first line
  must be `version https://git-lfs.github.com/spec/v1`. Opening a review
  with no such files reads nothing extra.
- **Loading:** the shared `Spinner` over a stage with a placeholder aspect
  ratio (dimensions aren't known until load), never a blank box; the
  toolbar's dimensions show a `SkeletonBar` until both images load.

### Renderer switch

The owner, 2026-11-16 (QA of #118): "Instead of having a "show as" button
on top, we should be able to swap into text/binary view if supported
similar to the slider/fade buttons. Just another diff renderer". So the
header chip of mockup section 1 is gone: the view's toolbar starts with one
segmented control of icon buttons (Slider, Fade, then Text or Binary where
offered; one Image button when there is a single version), and Text and
Binary get the same control in a row of their own, so the way back is
always there. The renderers it offers for a file:

- a known image type: Image, Binary;
- an SVG: Image, Text;
- an extension crb doesn't know, that git calls binary: Binary (default),
  Image (works only if the bytes match a raster signature; otherwise it
  falls back to Binary);
- an extension crb doesn't know, that git calls text: Text only, so no chip.

"Text" is never offered for a binary file: the server sends no lines for
one, and adding a binary-as-text diff is out of scope.

The pick is saved per file path for this viewer, in local storage, as data
(path → renderer id), so a later change can learn per-extension preferences
from it (principle 1's spirit; this isn't an AI decision). This is a new
kind of remembered setting, a map rather than one value per key, built on
`viewSettings`' `remembered`. Picking a renderer never changes clusters or
review states.

### Comments

Phase 1: the file header's existing "Comment on file" posts a GitHub file
comment (`subject_type: "file"`), and existing file threads show as today. An
image file has no line comments: for SVG in Image view, line threads show in
Text view. Image view lists them under the file header, as binary files do
today (`noLines`).

### Later: region comments

Mockup section 4, built later. The design to leave room for:

- The reviewer drags a box on either side. On GitHub it's a file comment. The
  existing hidden marker (`src/server/marker.ts`) gains a field:
  `<!-- crb:v1 id=… region=<old|new>@<commit>:<x>,<y>,<w>,<h> -->`, in the
  image's own pixel coordinates.
- crb draws the box on the image. File comments without a region attach to
  the whole image. A box drawn on an older version shows on the newer one at
  the same coordinates, flagged as possibly outdated.
- The marker parser already skips unknown `key=value` words. Phase 1 adds a
  test that pins this down, so a later `region=` can't break older builds.

### Later: Markdown (constraints the seam must meet)

The owner's words: Markdown needs clusters, marking each separately, and
carries. The rendered view maps to source lines, with a rendered/raw toggle.
So `units: "lines"` must be usable by a non-text renderer: a rendered block
shows the review state of its source lines' clusters and can tick them.
Phase 1 doesn't build this, but the `units` and `anchors` shape above must
not assume that "lines" means "the text diff".

## Design system

New tokens in `src/web/index.css` for the checkerboard's two greys (they
sit behind images, not text, so no contrast pair), plus contrast pairs in
`theme.test.ts` for the "added"/"deleted" labels and the stage tags. Note
the image stage in `docs/design/README.md`.

## Tests

- Unit: renderer resolution (override > claim > text), extension table, LFS
  pointer detection, size-changed stage geometry, the blob route
  (content type, nosniff, SVG CSP, path from index only, `from=n`, cap,
  ETag, access key, the since view's old side being H1′ or B2 and not patch
  set n, raster-signature typing refusing SVG/HTML), the `lfs` flag, and
  that the image review box writes exactly the shown units and nothing else,
  in the full diff and in the since view.
- Coverage: a test that a file shown by the image renderer with a forged or
  missing cluster stays unreviewed (principle 2).
- Playwright, desktop and phone: slider drag and keyboard, fade, mode
  remembered, side-by-side stacking on phone, added/deleted labels, size
  changed, undecodable fallback, renderer switch and its persistence,
  review tick, file comment. The fixture git repos (`test/git-fixture.ts`)
  need binary files: add a helper that commits bytes.
- `pnpm flake-check` on any spec with a spinner (image loading).

## Gallery

PRs on the gallery repo, one per case: a changed BMP (the installer case), a
resized PNG (size changed), an added image and a deleted image, an SVG, an
undecodable `.tiff`, and an image changed again in a second push (interdiff).

## Left to the builder

- Component structure inside `renderers/`, and how `FileDiff` hands over.
- Exact cap numbers, if measurement suggests better ones.
- Icon choice for each renderer within Primer octicons (the app's set).
- How the blob route reads the byte sizes (batch `cat-file --batch-check` is
  likely best for first-open performance; it must not slow down opening a
  review with many files).
