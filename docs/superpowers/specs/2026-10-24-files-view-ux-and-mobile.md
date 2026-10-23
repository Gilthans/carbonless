# Files changed view: UX revisions and mobile support

Status: approved in chat · 2026-10-24

Follow-up to `2026-10-21-pr-review-parity-design.md` after the reviewer used the
tool on a real PR. Everything not mentioned here stays as it is.

## Progress: one bar, selectable unit

- One compact progress bar replaces the two side-by-side bars.
- Tabs above or beside it choose the unit: **Lines**, **Clusters**, **Files**.
- The selected unit is remembered in `localStorage` (per-viewer convenience;
  reads and writes wrapped in try/catch, default **Lines** when unavailable).
- All counts on the page follow the selected unit: the bar, its numbers and
  percentage, the file tree's per-file counts, and the file headers' progress.
  With Files selected, a file is done or not done (e.g. "done" / "0 / 1").
- Crossed-off work stays visible as the hatched segment at the right end of the
  bar and still doesn't count toward the percentage
  (`reviewed ÷ (total − crossed off)`, floor, 0/0 → 100%).
- Remove the "Crossed off, not reviewed: …" legend line.

## Crossing off

- "Cross off file" crosses off immediately: no dialog, no reason. It still
  skips clusters already reviewed.
- Every cluster gets its own cross-off control next to its checkbox; undo stays
  available (posts `unreviewed`).
- The reason is optional end to end: the UI no longer asks for one; the API
  accepts crossed-off without a reason; the coverage join counts a reasonless
  cross-off as crossed off (it used to treat it as unreviewed). Stored events
  with a reason keep it. This replaces the earlier fail-safe; principle 2 still
  holds because crossed off never counts as reviewed.

## File header

- The path sits in its own horizontal scroll container that starts scrolled
  fully right, so the file name is visible; scrolling left reveals the rest of
  the path.
- The file's progress section has a fixed width and height and is pinned to the
  right of the header, so headers line up down the page.

## Mobile

- Mobile support is a project goal (added to CLAUDE.md principles).
- Every page is responsive down to ~360px wide; no horizontal page scroll
  (diff lines may scroll inside their own container).
- On narrow screens the file tree is hidden and opens from a floating button,
  like the GitHub mobile app: a sheet over the diffs, closed by picking a file,
  a close button, or Escape.
- Header actions stay usable on touch (tap targets ≥ 40px); collapse to a
  compact menu where they don't fit.
- Playwright runs the whole e2e suite in a phone project (e.g. iPhone 13) in
  addition to desktop Chromium, plus mobile-specific tests for the floating
  tree button and the path scroll.
