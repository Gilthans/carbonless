# Files changed view: UX revisions and mobile support

Status: approved in chat · 2026-10-24 · round 3 approved 2026-10-25

Follow-up to `2026-10-21-pr-review-parity-design.md` after the reviewer used the
tool on a real PR. Everything not mentioned here stays as it is.

## Progress: one bar, selectable unit

- One compact progress bar replaces the two side-by-side bars.
- Tabs above or beside it choose the unit: **Lines**, **Clusters**, **Files**.
- The selected unit is remembered in `localStorage` (per-viewer convenience;
  reads and writes wrapped in try/catch, default **Lines** when unavailable).
- All counts on the page follow the selected unit: the bar, its numbers and
  percentage, the file tree's per-file progress, and the file headers' progress.
  With Files selected, a file is done or not done (e.g. "done" / "0 / 1").
- How much a file changes follows the unit too, in the tree and the file
  header: Lines → "+X −Y"; Clusters → the file's cluster count with a cluster
  glyph (tooltip and accessible name "3 clusters"); Files → hidden.
- On phones the bar sits beside the unit picker ("0%  4 / 607", the meter
  under them); the unit word is left to the picker.
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

## File tree

- Each row: status icon, name (struck through and tagged when crossed off),
  the change count, then a mini progress bar at the right edge in the page
  bar's style (green reviewed, hatched crossed off), so the bars line up. Same
  cap as the page: never full while anything in the file is unreviewed. The
  exact numbers are its tooltip and accessible value ("1 of 2 clusters
  reviewed"); there is no "X / Y" text.
- Picking a file opens it, closes every other file, and scrolls so its header
  sits right below the sticky page bar (from the sidebar or the phone sheet).

## Opening files

- One file is open at a time (for now): opening a file closes the one that
  was open. Opening or closing by a header keeps that header where it was on
  screen. A new snapshot starts with every file closed.
- The open file's header sticks right below the sticky page progress bar (no
  gap, no overlap) while its diff scrolls, so it can be closed from anywhere.
  Closing it from deep inside keeps the header in view.

## File header

- The path sits in its own horizontal scroll container that starts scrolled
  fully right, so the file name is visible; scrolling left reveals the rest of
  the path.
- The file's progress section has a fixed width and height and is pinned to the
  right of the header, so headers line up down the page.
- The file actions are outlined icon buttons, always inline, with a short
  tooltip that doesn't repeat the name: ⊘ "Mark all unreviewed clusters as
  not needing review" crosses off the file's unreviewed clusters; once none are
  unreviewed and some are crossed off, the same button turns into a pressed
  "Undo cross-off" ("Set crossed-off clusters back to unreviewed") that sets
  exactly the crossed-off clusters back to unreviewed; with nothing unreviewed
  or crossed off it is disabled ("Nothing unreviewed"). ✓ "Mark all unreviewed
  clusters as reviewed" is disabled when none are unreviewed ("Nothing
  unreviewed"). A file without clusters disables both ("No clusters in this
  file") and has no undo.
- Wide headers are one row. Narrow headers (phones) are two: the path across
  the full width, then the collapse toggle, status, progress and ⊘ ✓ as 40px
  icon buttons (the change count joins them where it fits).

## Mobile

- Mobile support is a project goal (added to CLAUDE.md principles).
- Every page is responsive down to ~360px wide; no horizontal page scroll
  (diff lines may scroll inside their own container).
- On narrow screens the file tree is hidden and opens from a floating button,
  like the GitHub mobile app: a sheet over the diffs, closed by picking a file,
  a close button, or Escape.
- Header actions stay usable on touch (tap targets ≥ 40px), inline: the
  header wraps to a second row rather than hiding them in a menu.
- Playwright runs the whole e2e suite in a phone project (e.g. iPhone 13) in
  addition to desktop Chromium, plus mobile-specific tests for the floating
  tree button, the path scroll, the two-row header and the compact sticky bars.
