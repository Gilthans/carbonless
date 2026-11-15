# Image renderer (CAR-38 phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo that means CLAUDE.md's "How we work": one brief per task, one implementing agent per brief in its own worktree off `car-38-custom-renderers`, a fresh reviewer per change.

**Goal:** Changed images in a PR show as images in crb: before/after with a slider or a fade, side by side, with added/deleted/size-changed/undecodable handled, a per-file "Show as" switch, and review and comments exactly as for any other file.

**Architecture:** The server gains byte sizes and an LFS flag on `FileSummary`, and one read-only route that serves a side's blob bytes for a file index (old side = merge base, or the interdiff's old side with `from=n`). The web app gains a renderer seam in `FileDiff`: today's `DiffBody` is the `text` and `binary` renderers unchanged; a new `image` renderer draws the stage and leaves review rows and threads to `DiffBody` with its lines hidden. Coverage is untouched: review units stay the server's clusters, and the image view's review control is the existing header action.

**Tech Stack:** Fastify + git CLI, React + TanStack Query + Tailwind, `@primer/octicons-react`, Vitest, Playwright (desktop + phone).

**Spec:** `docs/superpowers/specs/2026-11-11-custom-renderers-design.md` (read it with this plan; mockups: the spec page's "Mockups" link, sent by the coordinator).

## Global Constraints

- Principle 2: a renderer never writes a review state on its own, never hides a cluster, never changes `buildReviewView`. A renderer that fails leaves the file unreviewed.
- Principle 8: an image that is loading shows the shared `Spinner` (`src/web/Spinner.tsx`) in a kept slot with `aria-busy`, never a blank stage; dimensions show `SkeletonBar` until both sides load. Tested with a held fetch (`expectLoadingThen`).
- Principle 5: works at 360px with no page-level horizontal scroll; 1:1 zoom scrolls inside the stage; tap targets ≥ 40px.
- Principle 6: icon-first, `@primer/octicons-react` icons with tooltip + accessible name; colors only from tokens in `src/web/index.css`.
- No image processing on the server; no new crb service.
- Image extensions: `.png .jpg .jpeg .gif .webp .avif .bmp .ico .svg`.
- Caps: auto-load ≤ 10 MB (10 × 1024 × 1024 bytes); tap to load above that; the route refuses above 50 MB.
- Blob route headers: `X-Content-Type-Options: nosniff` always; `ETag` = blob oid; `Cache-Control: private, max-age=31536000, immutable`; SVG adds `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- Raster signatures (only for an explicit "Show as Image" on an unknown extension): PNG, JPEG, GIF, WebP, BMP, ICO. Never SVG or HTML by sniffing.
- LFS pointer: non-binary, image extension, a side under 200 bytes, first line exactly `version https://git-lfs.github.com/spec/v1`.
- Settings keys follow `crb.<area>.<name>`: `crb.image.mode` ("slider" | "fade", default "slider"), `crb.files.renderer` (map path → renderer id).
- No repo-tracked private links, IPs or local paths (the repo is public).
- Test commands: `pnpm verify:fast` while iterating; `CRB_NO_PHONE=1` unless the task touches layout (Tasks 3–5 do: include the phone project). `pnpm flake-check` on every spec with a spinner or a hold. The full `pnpm verify` runs once, by the coordinator, on the combined branch.

## Review Focus

1. **A renamed and modified image.** The old side must be read at `oldPath`, not `path`. Test in Task 2 (`blob: renamed file reads old side at oldPath`).
2. **A stale tab.** The review moved on while an image loads: the route answers 409, and an `<img>` can't see statuses. The view must show the usual refresh path, not "undecodable". Test in Task 4 (`stale image shows refresh, not binary fallback`), which uses the HEAD probe described there.
3. **The base moved between pushes (since view).** The old side is H1′'s blob, not patch set n's. Test in Task 2 (`since: old side is the virtual rebase's blob`).
4. **An SVG with no intrinsic size** (no `width`/`height`, `naturalWidth` 0). It must render fit-to-width without "0×0" dims or a collapsed stage. Test in Task 4 (`svg without intrinsic size`).
5. **A 2000px-wide image on a phone.** Fit by default with no page overflow; 1:1 scrolls inside the stage. Test in Task 4 (`expectNoPageOverflow` on phone for a wide image).

---

### Task 1: Server: byte sizes, LFS flag, image type table, marker pin

**Files:**
- Create: `src/shared/imageTypes.ts`, `src/shared/imageTypes.test.ts`
- Modify: `src/shared/types.ts:69-86` (`FileSummary`)
- Modify: `src/server/diff/snapshot.ts` (`buildSnapshot`, ~177–233)
- Test: `src/server/diff/snapshot.test.ts`, `src/server/marker.test.ts`

**Interfaces:**
- Produces:
  - `FileSummary` gains `oldSize?: number; newSize?: number; lfs?: true`. A size is absent for a missing side (added/deleted) and for submodules.
  - `src/shared/imageTypes.ts`:
    - `IMAGE_TYPES: Readonly<Record<string, string>>`: extension (lowercase, no dot) → MIME. Entries: `png image/png`, `jpg`/`jpeg image/jpeg`, `gif image/gif`, `webp image/webp`, `avif image/avif`, `bmp image/bmp`, `ico image/x-icon`, `svg image/svg+xml`.
    - `imageTypeOf(path: string): string | null`.
    - `isImagePath(path: string): boolean`.
    - `sniffRaster(head: Uint8Array): string | null`: PNG/JPEG/GIF/WebP/BMP/ICO only.
  - `IMAGE_AUTO_LOAD_BYTES = 10 * 1024 * 1024` and `IMAGE_MAX_BYTES = 50 * 1024 * 1024`, also in `imageTypes.ts`.

- [ ] **Step 1: Write failing tests.**
  - `imageTypes.test.ts`:
    - `imageTypeOf("a/B.PNG") === "image/png"`; `imageTypeOf("x.svg") === "image/svg+xml"`; `imageTypeOf("x.tiff") === null`.
    - `sniffRaster` returns the right type for each signature's leading bytes (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF????WEBP`, BMP `BM`, ICO `00 00 01 00`).
    - `sniffRaster` returns `null` for `<svg`, `<?xml`, `<!DOCTYPE html`, `<html` and random bytes.
  - `snapshot.test.ts`, `"file sizes and the LFS flag"`. Fixture with `binary` (`createGitFixture`):
    - A modified PNG has `oldSize`/`newSize` equal to the byte lengths.
    - An added PNG has no `oldSize`.
    - A text `.png` whose content is `version https://git-lfs.github.com/spec/v1\noid sha256:…\nsize 12345\n` has `lfs: true`.
    - The same pointer text in `notes.txt` has no `lfs`.
    - A 300-byte text `.png` that starts with that line has no `lfs` (both sides ≥ 200).
  - `marker.test.ts`: `it("skips unknown key=value words, so later fields can't break this build")`, asserting that `parseMarker("x\n\n<!-- crb:v1 id=c-1 region=new@abc:1,2,3,4 -->")` equals `{ id: "c-1", span: null }`.
- [ ] **Step 2: Run them and confirm the new ones fail** (the marker test may already pass: that's the point of pinning it). Run: `pnpm test src/shared/imageTypes.test.ts src/server/diff/snapshot.test.ts src/server/marker.test.ts`.
- [ ] **Step 3: Implement.**
  - Sizes come from one `git cat-file --batch-check='%(objectname) %(objectsize)'` over every non-zero `oldOid`/`newOid` of `ChangedFile`. It runs in parallel with the existing `readBlobs`, so opening a review gets no slower.
  - LFS: decide from the text blobs `readBlobs` already returns (only non-binary files with an image path and a side under 200 bytes). No extra git call.
- [ ] **Step 4: Run the tests and confirm they pass.** Run: `pnpm verify:fast`.
- [ ] **Step 5: Commit.** `git commit --only -- <paths> -m "image renderer: file sizes, LFS flag, image type table (CAR-38)"`

### Task 2: Server: the blob route

**Files:**
- Modify: `src/server/rereview/engine.ts` (new export next to `interdiffFileAt`, ~630)
- Modify: `src/server/session.ts` (new method next to `interdiffHunks`, ~1004)
- Modify: `src/server/diff/snapshot.ts` (export `resolveBlobs`, ~136)
- Modify: `src/server/app.ts` (route inside the review plugin, next to `/files/:index/hunks`, ~600)
- Test: `src/server/app.test.ts`, `src/server/session.test.ts`, `src/server/rereview/engine.test.ts`

**Interfaces:**
- Consumes: `IMAGE_TYPES`, `imageTypeOf`, `sniffRaster` and `IMAGE_MAX_BYTES` from Task 1.
- Produces:
  - `export function interdiffBlobName(traced: Traced, answer: RereviewAnswer, index: number, side: "old" | "new"): string | null` in `engine.ts`. It returns a `<treeish>:<path>` name:
    - Clean file: old = `${virtualHead}:${oldPath ?? path}`.
    - Conflicted file: old = `${mergeBase of the target}:${oldPath ?? path}`.
    - new = `${head}:${path}`.
    - An added file's old side, or a deleted file's new side, is `null`.
    - A file the interdiff doesn't list: both sides are the head's.
    - Interdiff unavailable: `null` for old.
  - `Session.blob(revision: string, index: number, side: "old" | "new", from?: number): Promise<{ oid: string; path: string; size: number } | null>`. It resolves the name with `resolveBlobs`; it does not read the bytes.
  - `GET /api/r/:id/files/:index/blob?revision=R&side=old|new[&from=n][&sniff=1]` (and HEAD, Fastify's default). Answers:
    - 200 with the bytes.
    - 304 when `If-None-Match` matches.
    - 404 for no such side.
    - 409 `{error:"stale"}`.
    - 413 when larger than `IMAGE_MAX_BYTES`.
    - 415 when the type can't be decided.

- [ ] **Step 1: Write failing tests** in `app.test.ts`, `describe("blob route")`:
  - `serves a modified PNG's old and new bytes with type, nosniff, ETag and immutable cache`: bytes equal the fixture's; headers as in Global Constraints.
  - `blob: renamed file reads old side at oldPath`.
  - `svg gets the sandbox CSP` (and the CSP replaces the app-wide `frame-ancestors` one, not doubles it).
  - `unknown extension: 415 without sniff=1; with sniff=1 a PNG signature serves image/png; an SVG or HTML body is 415 even with sniff=1`.
  - `If-None-Match with the oid answers 304 with no body`.
  - `stale revision answers 409 {error:"stale"}`.
  - `no old side for an added file is 404`; `bad side is 400`.
  - `over IMAGE_MAX_BYTES is 413`. Lower the cap through a test hook rather than committing 50 MB; the coordinator approves the hook's shape, which follows `src/server/testHooks.ts`.
  - `the path is never read from the request`: `?path=../x` is ignored, and the bytes are file N's.
  - With an access key, the route answers 401 without the cookie (the existing `buildApp(registry, { accessKey })` pattern).
- [ ] **Step 2: Write failing tests** in `session.test.ts` (style of the `interdiffHunks` tests near 1495):
  - `since: old side is the virtual rebase's blob`: the base moves and the image changes on the base and in the PR. `blob(rev, i, "old", 1)` is H1′'s blob, not patch set 1's.
  - `since: a conflicted image's old side is the target's merge base blob`.
  - `since: interdiff unavailable gives no old side` (a shallow or unrelated fixture, whichever the existing tests use).
- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm test src/server/app.test.ts src/server/session.test.ts -t blob`.
- [ ] **Step 4: Implement.**
  - Read bytes with `runGitBuffer(repo, ["cat-file", "blob", oid])`. Never use `readBlobs`/`BlobCache`, which would push text blobs out of the 32 MiB cache.
  - Check the size before reading, from `Session.blob`'s `size`.
  - Type: `imageTypeOf(path)`, else `sniffRaster` of the first 16 bytes when `sniff=1`, else 415.
- [ ] **Step 5: Run the tests and confirm they pass.** Run: `pnpm verify:fast`.
- [ ] **Step 6: Commit.** `"image renderer: blob route (CAR-38)"`

### Task 3: Web: renderer seam, settings, "Show as" switch

**Files:**
- Create: `src/web/files/renderers/index.ts`, `src/web/files/renderers/resolve.test.ts`, `src/web/files/renderers/RendererChip.tsx`
- Modify: `src/web/viewSettings.ts` (export `remembered`/`Codec`, or add `choiceSetting` + `mapSetting` beside `viewSetting`)
- Modify: `src/web/files/FileDiff.tsx` (body at ~1237; chip in the header's right-hand group at ~1170)
- Modify: `src/web/files/DiffBody.tsx` (new prop `linesHidden`)
- Test: `src/web/viewSettings.test.ts`, `src/web/files/FileDiff.test.tsx`, `e2e/image-renderer.spec.ts` (new), `scripts/verify-fast.mjs` (map the spec to `^src\/web\/files\/renderers\/|^src\/shared\/imageTypes`)

**Interfaces:**
- Consumes: `FileSummary.lfs` and `isImagePath` from Task 1.
- Produces:
  - `type RendererId = "text" | "binary" | "image"`.
  - `interface Renderer { id: RendererId; claims(file: FileSummary): boolean; units: "lines" | "whole-file"; anchors: readonly ("file" | "lines" | "region")[] }`. `Single`/`Compare` are Task 4's components, registered on the image entry.
  - `rendererChoices(file: FileSummary): RendererId[]`, matching the spec's menu:
    - image (binary): `["image","binary"]`.
    - SVG: `["image","text"]`.
    - unknown binary: `["binary","image"]`.
    - unknown text: `["text"]` (no chip).
    - Never `"text"` for a binary file. An LFS-flagged file: `["text"]`.
  - `resolveRenderer(file: FileSummary, pick: RendererId | undefined): RendererId`. Order: a pick that is in `rendererChoices`, then the first claim, then `file.binary ? "binary" : "text"`.
  - `rendererPicks: MapSetting<RendererId>` (key `crb.files.renderer`, path → id), with `get(path)`, `set(path, id)`, `use(path)`.
  - `imageMode: ChoiceSetting<"slider" | "fade">` (key `crb.image.mode`, default `"slider"`).
  - `DiffBody` prop `linesHidden?: boolean`: no hunks query; the file-level cluster rows and file threads render as for a binary file today; line threads list as `noLines`.

- [ ] **Step 1: Write failing tests.**
  - `resolve.test.ts`: one `it.each` row per menu case above. Also:
    - The pick wins over the claim.
    - A pick not in the choices is ignored (a stale `"text"` on a binary file).
    - LFS gives `"text"`.
    - An unknown text extension has one choice.
  - `viewSettings.test.ts`: map setting round trip; a corrupt stored value falls back to empty; the choice setting rejects unknown values.
  - `FileDiff.test.tsx`:
    - `the chip shows for a PNG and not for a .ts`.
    - `picking Binary on a PNG renders today's binary rows and persists per path`.
    - `DiffBody linesHidden fetches no hunks and keeps the file-level checkbox`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test src/web/files/renderers src/web/viewSettings.test.ts src/web/files/FileDiff.test.tsx`.
- [ ] **Step 3: Implement.**
  - In `FileDiff`, `resolveRenderer(file, rendererPicks.use(file.path))` picks the body:
    - `"text"`/`"binary"`: today's `DiffBody`, unchanged.
    - `"image"`: Task 4's `ImageView` followed by `DiffBody linesHidden`. Until Task 4 lands, it renders `DiffBody linesHidden` alone.
  - Chip: an `@primer/octicons-react` icon button showing the current renderer (`FileMediaIcon`/`FileCodeIcon`/`FileBinaryIcon`), with tooltip "Show as…" and a menu of `rendererChoices`. It is hidden when there is one choice.
  - Picking a renderer never calls `useSetStates`.
  - LFS: a file with `lfs: true` gets an icon next to the path in the header, with the tooltip "Git LFS pointer" and the same accessible name. Test: `FileDiff.test.tsx` `an LFS pointer shows the LFS icon and no chip`.
- [ ] **Step 4: Add the e2e test** in `e2e/image-renderer.spec.ts`, with a PR using `baseBinary`/`binary` PNG and BMP files:
  - `renderer switch: Image ↔ Binary persists across reload; a .ts file has no chip`.
  - Run desktop and phone.
- [ ] **Step 5: Run the tests and confirm they pass.** Run: `pnpm verify:fast` and `pnpm test:e2e e2e/image-renderer.spec.ts`.
- [ ] **Step 6: Commit.** `"image renderer: renderer seam and Show-as switch (CAR-38)"`

### Task 4: Web: the image views

**Files:**
- Create: `src/web/files/renderers/image/ImageView.tsx`, `ImageCompare.tsx`, `ImageSingle.tsx`, `ImageToolbar.tsx`, `stage.ts`, `stage.test.ts`, `useImageSide.ts`, `useImageSide.test.tsx`
- Modify: `src/web/api.ts` (`blobUrl`), `src/web/files/FileDiff.tsx` (render `ImageView`), `src/web/index.css` (tokens `checker-a`, `checker-b`), `src/web/theme.test.ts`, `docs/design/README.md` (new section "Image files")
- Test: the unit files above, `e2e/image-renderer.spec.ts`

**Interfaces:**
- Consumes: `blob` route (Task 2); `Renderer`, `imageMode`, `linesHidden` (Task 3); `IMAGE_AUTO_LOAD_BYTES`, `FileSummary.oldSize/newSize` (Task 1).
- Produces:
  - `blobUrl(revision: string, index: number, side: "old" | "new", from?: number, sniff?: boolean): string` in `api.ts`, built on `reviewApiPath`.
  - `stageGeometry(before: Size | null, after: Size | null, box: number): { w: number; h: number; scale: number; before?: Rect; after?: Rect }`.
    - `Size = {w,h}`; `Rect = {x:0,y:0,w,h}` in stage pixels.
    - The stage is max w × max h, scaled to fit `box` width (never above 1 at Fit).
    - Each image keeps its own size, pinned top-left.
  - `useImageSide(url: string, bytes: number | undefined, auto: boolean): { state: "waiting-tap" | "loading" | "ready" | "stale" | "too-big" | "undecodable"; size?: Size; load(): void; onLoad; onError }`.
    - On `<img>` error it probes the same URL with `fetch(url, { method: "HEAD" })`.
    - 409 means `"stale"`, 413 means `"too-big"`, anything else means `"undecodable"`.
  - `ImageView(props: { file: FileView; revision: string; from?: number; sideBySide: boolean })`.

- [ ] **Step 1: Write failing unit tests.**
  - `stage.test.ts`:
    - Same size gives one rect equal to the stage.
    - 493×312 → 493×340 gives a stage of 493×340, before = 493×312 at 0,0.
    - 440×340 vs 493×312 gives a stage of 493×340.
    - Fit in a 320px box scales both by 320/493.
    - One side `null` (added/deleted) gives the other side's size.
    - A `{w:0,h:0}` size (SVG with no intrinsic size) gives a stage of the box width with a 4:3 placeholder ratio and no dims.
  - `useImageSide.test.tsx` (held fetch via `test/loading.ts`):
    - Error then HEAD 409 gives `"stale"`; error then HEAD 200 gives `"undecodable"`.
    - Bytes > 10 MB with `auto` gives `"waiting-tap"` and no request until `load()`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm test src/web/files/renderers/image`.
- [ ] **Step 3: Implement**, following spec sections "Unified view", "Side-by-side view", "Edge cases" and the mockups.
  - **Compare (unified)**, with mode from `imageMode`:
    - Slider: after underneath and before clipped on top. An `input[type=range]` stretched over the stage carries the accessible name "Before/after split" and `touch-action: pan-y`. "before"/"after" tags sit in the top corners.
    - Fade: a range under the stage sets the before image's opacity.
  - **Toolbar:**
    - A segmented Slider/Fade control.
    - Dims and sizes, `493×312 → 493×340 · 41 → 44 KB`, before in `del-ink` and after in `add-ink`, with a `SkeletonBar` until loaded.
    - A Fit/1:1 toggle; 1:1 scrolls inside the stage.
  - **Side-by-side** (`sideBySide.use()`): two `ImageSingle` with red/green edges and captions; they stack on phone.
  - **Added/deleted:** a single view with an "added" (green) or "deleted" (red) label and edge in both layouts. No modes.
  - **Renamed without a content change:** a single view.
  - **States:**
    - `"undecodable"` and `"too-big"`: render nothing; `DiffBody linesHidden` below already shows the binary rows, and the toolbar shows byte sizes.
    - `"stale"`: the same refresh path a 409 on hunks shows today. Find how `DiffBody` surfaces `ApiError` 409 and reuse it.
    - `"waiting-tap"`: a "Load image (N MB)" button.
  - **Unknown extension shown as Image:** request with `sniff=1`. A 415 answer counts as `"undecodable"`.
  - **Loading:** `Spinner label="Loading image"` over a placeholder-ratio stage with `aria-busy`.
  - **Tokens:** `--color-checker-a`/`--color-checker-b`. Add `theme.test.ts` pairs for the label/tag text on their backgrounds (≥ 4.5).
- [ ] **Step 4: Add e2e tests**, desktop and phone:
  - `slider drags and moves with arrow keys`.
  - `fade`.
  - `mode is remembered across reload`.
  - `side-by-side stacks on phone`.
  - `added and deleted labels`.
  - `size changed: stage is max w × max h, images top-left`: compare boxes via `boundingBox`.
  - `undecodable .tiff with Show as Image falls back to binary rows`.
  - `loading shows a spinner, never a blank stage`: hold the blob with `page.route`, then `expectLoadingThen`.
  - `stale image shows refresh, not binary fallback`.
  - `svg without intrinsic size`.
  - `wide image on phone: no page overflow` (`expectNoPageOverflow`).
- [ ] **Step 5: Run the tests and confirm they pass**; `pnpm flake-check e2e/image-renderer.spec.ts`.
- [ ] **Step 6: Commit.** `"image renderer: slider, fade, side-by-side and edge cases (CAR-38)"`

### Task 5: Review and comments in the image view, coverage guard

**Files:**
- Modify: `src/web/files/FileDiff.tsx` (only if a test below needs it)
- Test: `src/web/files/FileDiff.test.tsx`, `src/server/review/coverage.test.ts`, `e2e/image-renderer.spec.ts`

**Interfaces:**
- Consumes: everything above. Nothing new is produced.

Plan decision (coordinator's call, to confirm with the owner when reporting): the spec's "review box" is the header's existing whole-file action, "Mark remaining reviewed" / "Unmark reviewed" (`FileMarkActions`, `markAll`/`resetOf`). It already ticks only open units, never unticks while anything is left, unticks all once all are reviewed, and in the since view covers exactly the shown units and pieces (`sinceChange`). A binary image also keeps its file-level cluster row from `DiffBody linesHidden`. Phase 1 adds no new write path, so no new way to mark something unseen.

- [ ] **Step 1: Write tests**, failing where behavior is missing:
  - `FileDiff.test.tsx`:
    - `SVG in Image view: Mark remaining reviewed ticks every shown line cluster, and nothing else`.
    - `SVG with some clusters ticked in Text view: the header shows the mixed state and a press ticks only the open ones`.
    - `since view: an image's header action writes the since units only` (the `sincePieces` fixture style of `sinceView.test.tsx`).
  - `coverage.test.ts`: `a file with a forged or missing cluster stays unreviewed whatever the renderer` (the review view is computed without a renderer; pin that nothing renderer-side feeds `buildReviewView`).
  - e2e:
    - `review tick on a BMP marks the file reviewed and survives reload`.
    - `comment on file from the image view posts a file comment` (fake gh log shows `subject_type: "file"`).
    - `SVG line threads show under the header in Image view and on lines in Text view`.
- [ ] **Step 2: Run them**; fix only what fails. Run: `pnpm verify:fast`, then `pnpm test:e2e e2e/image-renderer.spec.ts`.
- [ ] **Step 3: Commit.** `"image renderer: review and comments in the image view (CAR-38)"`

### Task 6 (coordinator): gallery PRs, integration, report

- [ ] Gallery PRs on Gilthans/carbonless-gallery, one per case, each with `base/<case>` and `case/<case>` branches, a description and a README row:
  - a changed BMP (the installer case);
  - a resized PNG;
  - an added and a deleted image;
  - an SVG;
  - an undecodable `.tiff`;
  - an image changed again in a second push.
- [ ] `pnpm verify` on the combined branch. Then start the branch instance, open the PR (`Fixes CAR-38`), move CAR-38 to Implementation, and send the owner the ready report with links to the gallery cases.
