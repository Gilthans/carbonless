# carbonless design language

Dark, calm surfaces; color only where it means something; one burst of
brand color in the logo and a few gradient touches. Reference:
[brand-board.jpg](brand-board.jpg) (ignore its tagline and URL: there is none).

## Tokens

All colors live in one place, the `@theme` block of `src/web/index.css`
(Tailwind's own palette is switched off). Use them as Tailwind colors:
`bg-surface`, `text-muted`, `border-line`, `bg-ok/10`. Every pair the UI
uses is checked for WCAG AA in `src/web/theme.test.ts`; add new pairs there.

| Token | Use |
| --- | --- |
| `canvas` `surface` `raised` `overlay` `pressed` | page, cards/header, section and file headers, tooltips/hover, pressed |
| `band` | subsection bands (Human/Bot reviews) and thread card headers: between `surface` and `raised` |
| `line` / `line-strong` / `edge` | decorative dividers / outlines of controls (3:1) / floating layers, scrollbars |
| `ink` `ink-soft` `muted` `faint` | text, strongest to weakest (all 4.5:1 on every surface) |
| `label` | letter-spaced violet capitals for section labels |
| `accent` `link` | focus rings, the pointed-at cluster rail, selected segment, current file; links |
| `add-done` `del-done` | reviewed lines: quieter add/del tints, text at full contrast |
| `ok-wash` | a finished file's header: an opaque green wash on `raised` (it sticks over the diff) |
| `mark-tint` (utility) | `accent` at 8% as an inset shadow over every cell of a row: a thread's commented lines, and a line landed on from a thread link (it fades, instantly with reduced motion). Over add/del/context it keeps all code text at 4.5:1 and green/red apart |
| `person-1`…`person-7`, `person-N-edge` | a person's comments in threads: an opaque wash in place of `raised` inside a border of the same hue (the edge is also their avatar fallback). Blues to violets and a stone grey: at least 40° of hue from the deleted/failing reds and 25° from the add/ok green and warn yellow (no warm hue clears both red and yellow, hence seven); all text at 4.5:1 |
| `span` (`span-mark` utility) | a thread's exact characters (a span comment): an opaque navy of the accent's hue behind them and a 2px `accent` underline, on top of `thread-mark`'s lines. Opaque so every code and syntax color keeps 4.5:1 on any row kind (theme.test.ts) |
| `line-picked` (utility) | lines picked by their numbers in Files changed: the numbers in `ink` on `accent` at 35%, the row under a 10% accent wash; Escape clears |
| `shade`, `shadow-*` | the one shadow color and the shadows built from it |
| `magenta` `orange` `yellow` `teal` `violet` | brand: logo, gradients (`brand-rule`, `cta`), never meaning |

## Color semantics

Code-review conventions win over the brand palette:

- **Added / reviewed / approved / passing** = green (`ok`, `ok-fill`, `add*`), leaning teal to sit with the palette.
- **Deleted / failing / changes requested / conflicts** = red (`bad`, `del*`), leaning magenta.
- **Pending / warning / partly done** = yellow (`warn`, the brand yellow).
- **Merged / crossed off** = violet (`done`, `crossed*`); crossed off is always hatched (`hatch`) or marked ⊘.
- **Unreviewed** = neutral grey (`unreviewed`).
- Accent and links are periwinkle rather than a palette hue: the palette has
  no blue, its violet would read as crossed off, and teal as green; periwinkle
  is the familiar link/focus blue, nudged toward the violet, at 4.5:1+.
- The draft badge is grey in "What it does", as on GitHub.
- Brand gradient only where no convention exists: the active tab's underline, primary actions (`cta`), the header glow, the logo.

Syntax highlighting (`src/web/files/syntaxTheme.ts`) uses lightened brand
hues, each at least 25° of hue from the added and deleted inks (keywords are
orchid, not pink), so it never competes with added and deleted lines. The
contrast test enforces both the 4.5:1 and the hue gap.

Reviewed clusters are not dimmed with opacity (that broke 4.5:1): their
add/del tints fade to `add-done`/`del-done`, with the green rail and checked
box marking them.

## Invisible characters

Code shows what it is made of, Notepad++ style (`src/web/code/`): spaces
as `·` (a lone space between two printing characters stays plain: it is
ordinary spacing; runs of two or more, and a space at either end of the
line or next to another blank, keep their dots, so a trailing space that is
a line's only change still shows), tabs as `\t` padded to the next tab stop (the head's
`.editorconfig` `tab_width`, else a numeric `indent_size`, else 4; a
config over 64 KB is ignored; wide
characters and emoji count two columns), line endings as `\n` / `\r\n`,
all in `faint`. Characters that would print as nothing or as a lookalike
blank (controls, zero widths, BOM, soft hyphen, tags, unusual spaces,
separators, stray variation selectors) show as `\uXXXX`, named in a
tooltip (hover or tap); bidi controls also get a `warn` tint. Settings' "Show
hidden characters" switch hides only spaces, tabs and line endings: escapes
always show (principle 2). Only a short list of invisibles doing their job stays
unescaped, and anything unsure is escaped: ZWJ/ZWNJ after a virama on a
letter of its own script, ZWNJ between joining letters of one
script (IDNA CONTEXTJ, Joining_Type generated from Unicode data by
`scripts/gen-joining-types.mjs`), ZWJ inside an emoji sequence,
VS15/VS16 after an emoji or in a keycap, and the tags of the three RGI
subdivision flags. Ideographic variation selectors are always escaped. Markers are generated content, so a copy gives the
original text. Sources spell such characters as `\u` escapes; a test fails
on any raw one.

Out of scope: homoglyphs (a Cyrillic `а` for a Latin `a` shows as itself),
and the ordinary bidi of natural right-to-left text, which can reorder
neutral punctuation next to it without any override.

## Whitespace-only rows

Settings' "Ignore whitespace" matches a hunk's removed and added lines with
whitespace-equal lines on the other side (`src/web/files/whitespace.ts`,
over the whole hunk, context lines included, since git often splits a
re-indented block over a context line; it may show more as changed than
`git diff -w` does, never less: `docs/product-rules.md`) and draws them as
quiet rows: a
removed line and its added twin in the same cluster as one row with both
line numbers in `faint` (no add/del gutter) and the new side's text; a line
whose twin is a context line or sits in another cluster as a one-sided row
with its one number and its own text. Both carry a `~` sign in `faint`
(accessible name and tooltip "Whitespace only") and a `band` background, so
they read as a change, only a quiet one, never as an unchanged line. A cluster that is all such pairs collapses to one `band` row carrying
the cluster's rail and controls as any cluster, "Whitespace only · N lines"
in `muted` and a chevron in `faint` together as one disclosure button (named
by its visible text, no `aria-label`; 40px tall on touch; tooltip "Show
lines" / "Hide lines"; `aria-expanded`, and `aria-controls` on the rows'
`tbody`) that shows its rows below it, collapsed again whenever the file
opens or the setting turns on. The button gives way to the plain text while
a thread bubble keeps the rows showing, or while a thread link's landing
highlight is on one of them; a landing also opens the cluster, so once the
highlight fades the rows stay under the reviewer and the button is back to
collapse them. A reviewed collapsed row
keeps the green rail and checked box, as any cluster.

## File change kinds

Every file, in its header and in the tree, has a 12px icon before its
path for what happened to it (`src/web/files/changeKind.tsx`), GitHub's
diff octicons, so the shape alone tells them apart: plus in a square
(added, `ok`), minus (deleted, `bad`), dot (modified, `warn`, never green
or red), arrow (renamed, `muted`), slash (type changed, `muted`). Its
accessible name says it ("Added", "Renamed from <old>", "Mode changed:
100644 → 100755"); the header icon shows it on hover, and the path's and
the tree row's tooltips start with it, so touch and keyboard get it too.

## File counts

Every file header and tree row shows `+X −Y` (`ok`/`bad`) and its cluster
count with a stack icon, whatever unit the Lines / Clusters / Files toggle
picks (`ChangeCount`, `src/web/files/status.tsx`). The toggle switches only
progress: the bars and the "3 / 8 lines" style fractions. In the header the
counts sit beside the path, so a phone's second row keeps room for the
actions and the progress; the header's progress summary names them ("3 lines
added, 2 deleted · 2 clusters").

## Finished files

A file the progress counts done (`FileView.done`: every cluster reviewed or
crossed off) is green, so scrolling finds what's left: its header is
`ok-wash` with a 3px `ok-fill` left edge and an `ok-fill/50` section border, open,
closed or stuck; its tree row gets `ok/8` with a 2px `ok-fill` edge (the
current row keeps its accent). Crossed-off files keep their purple cues on
top; the pressed Undo cross-off keeps a `crossed` edge so it shows at 3:1 on
the wash. Unfinished files are unchanged, and an undo drops the tint at once.

## Saving review state

Cluster state actions show at once; the page syncs the server to them in
the background (`src/web/files/stateSync.ts`) and never rolls one back. Unsaved
state shows in one small stack fixed at the bottom of the window
(`SyncNotices`): above the floating Files button while there is one, bottom
right once the file tree is a sidebar (md+), so neither is covered.

- **Delayed** (`role="status"`, `warn`): a clock, "Saving N changes…", why it
  waits (e.g. "Can't reach crb" or the server's message) and the files, once a
  change has waited 5 s (transient failures retry with backoff meanwhile; a
  new change retries at once). It goes away by itself once everything is
  stored.
- **Not saved** (`role="alert"`, `bad`): an alert icon, the changes the server
  refused (the change and file, or a count and the files), the error, and a
  40px Retry that resends every unsaved change. A 400 names the refused
  changes (`keys`), which stay here while the rest are sent again at once (a
  400 without keys is split per file, then in halves); any other refusal
  keeps the whole request here. Everything else keeps syncing. Five
  transient failures in a row for waiting changes also turn the yellow
  notice red (the last error and Retry) while retrying goes on; a stored
  write clears it.

Both are `tone/10` over an opaque `raised` card with a `tone/50` border.
While one shows, the file list's end is padded by how far up the notices
reach (`--sync-notices`), so the last header can scroll clear of them.
Leaving the page with anything unsaved asks first (`beforeunload`).

## Settings

A gear (tooltip "Settings", 40px) at the right of the app bar's last row,
so it stays in the compact sticky header too. It opens a small popover
under it, a bottom sheet on a phone (`<dialog>`; Escape, a click outside or
the backdrop, and Close on the sheet close it, focus back on the gear).
Each setting is a full-width switch row (`role="switch"`, 44px), in this
order: "Show hidden characters" (`crb.code.invisibles`, on by default),
"Ignore whitespace" (`crb.diff.ignoreWhitespace`, off by default) and "Side
by side" (`crb.diff.sideBySide`, off by default; old file left, new right,
`src/web/files/sideBySide.ts`), each a `viewSetting`
(`src/web/viewSettings.ts`) remembered in `localStorage` and taking effect
at once, without a reload.
More rows go into `SettingsList` (`src/web/Settings.tsx`). Below them, on
desktop only, "Keyboard shortcuts" (keyboard icon) opens the shortcuts help.

## Keyboard shortcuts help

`?` (outside a text field) toggles a centred modal `<dialog>` titled
"Keyboard shortcuts", Gmail-like: one section per group (Global, Files
changed, Overview, Threads; empty ones left out), the current page's group
first, each row a short label and its keys as caps (`kbd`, monospace, a
`line-strong` border; Mod shows as Ctrl, or ⌘ on a Mac). Escape, `?`, the
✕ (40px, tooltip "Close", rendered inside the dialog with `TooltipLayer` so the top layer doesn't cover it) or a press on the backdrop close it; Tab stays inside and focus goes back
where it was. Phones don't get it: no Settings entry below `sm`, and no
sheet (`?` from a hardware keyboard still opens the same dialog, within
the viewport).

## Thread cards (Overview)

"Human reviews" / "Bot reviews" each open with a `band` strip across the
section (icon in `label`, title in `ink`, then the unresolved/resolved
two-way choice, a pill of two radios in a `line` outline, the chosen side
filled in its tone: `warn` unresolved, `ok` resolved, `overlay` at 0; then
the Drafts chip), quieter than the section's `raised` title band. Each thread is a
bordered (`edge`) card on `surface`:

1. a `band` header row: status icon (yellow unresolved, green resolved),
   "Unresolved thread by <avatar> <author> · opened <time> · updated <time>"
   (`RelativeTime`; "updated" only when it differs; "Resolved" itself in
   `ok`, so a resolved thread is unmistakable), then on the right
   `ThreadStatus` (`src/web/threads/`): the comment count (comment icon +
   number, named "N comments") and, when the viewer is in the thread's
   attention set (`yourTurn`), a `warn` dot named "Your turn" (never on a
   resolved thread); then the "no reply" / "outdated" chips, then a red (`bad`)
   "different snapshot" chip when the code pane can't be shown to be what the
   commenter saw (`docs/faq.md`; focusable, 40px, its tooltip says which
   commit and when); wraps on a phone. No resolve control here: it's the
   Resolve button inside Show more;
2. path:line in mono `link`, a 40px link to that line in Files changed;
3. the code pane (`code`, commented lines with the accent rail and
   `mark-tint`) beside the first comment, stacked on a phone. The comment
   sits on its author's tint (below): GitHub's text, apart from the card
   and the code. Both are clipped while the card is closed;
4. one 40px "Show more" toggle for the whole thread, centred on its own row (chevron, `link`,
   `aria-expanded`), with "· N replies" (discussion icon) when there are
   any and a `warn` clock for the viewer's pending ones; it shows whenever
   there's more: clipped text or code, a reply, or something the viewer may
   do. Closed at first (open at once on a thread with a draft, and in the
   Drafts filter; focusing into a clipped comment opens it too). Opened:
   the code and the first comment in full, every reply on a `line` rail
   (`ThreadComments`, shared with Files changed), then the reply box with
   the Resolve button beside it (below it on a phone), then "Show less".
   Each reply is its author (20px avatar, bot icon), its published time
   and its text on the author's tint; the viewer's own pending reply has a
   `warn` clock ("Pending, only you see it") instead of a time. A spinner while the comments load
   (they are read in the background from the thread list on, visible
   threads first, so it rarely shows), an error with Retry, "Deleted on
   GitHub" for a thread gone since it was listed, and a `warn` alert with
   "N missing" ("N comments couldn't be loaded") when fewer came than the
   thread counts.

**People.** Every comment's author has a round avatar beside their name
(GitHub's `avatarUrl`, 20px, 16px in a card header; `alt=""`, lazy, fixed
size), or, with none or a broken image, their initial on their
`person-N-edge`. Each person's comments sit on their tint
(`person-N` wash, `person-N-edge` border), the same in every thread of
the PR, Overview and Files changed alike (`src/web/threads/people.tsx`):
tints go out in the order people first spoke anywhere in the PR, so no two
share one until the seven run out (then they start over); the viewer, not
having spoken yet, comes after everyone. Someone new only ever speaks
last, so a new comment never changes anyone else's tint. They are worked
out from what the PR lists now, never stored, so they are stable only
against additions: a deleted comment or thread can shift everyone who
first spoke after it, an as-of view can give the viewer (and anyone who
spoke only after the cutoff) a different tint than the live view, and
someone no thread lists (in a long thread's unlisted middle, past its
first 100 comments) gets a tint from their login, which may be someone
else's.

**Resolve.** A big button (40px, text and icon) beside the reply box,
the bigger action next to Send: "Resolve" (check, `ok` on `ok/10` in an
`ok/60` outline) on an open thread, "Unresolve" (reopen icon,
`ink-soft` in a `line-strong` outline) on a resolved one. It shows where
the viewer may resolve or unresolve, with or without a reply box, and
keeps a focused reply box focused on a mouse click.

A suggested change in a comment (the opener or a reply) is a small `code`
figure: a `band` caption (yellow light bulb, "Suggested change"), then the
commented lines as deleted rows and the suggestion as added rows, drawn like
the code pane.

Lists show five threads, then "Load X more comments out of Y".

## Threads in Files changed

Threads whose opening comment was made on the viewed head sit on the
diff, GitHub style (`placeThreads`, `src/web/files/threadPlacement.ts`,
decides where; nothing else does):

- The commented range (LEFT by old number, RIGHT by new number) is marked
  with `thread-mark`: `mark-tint`'s wash, the old/new numbers tinted 20%
  `accent` (like GitHub's selected line numbers) and a 3px `accent` stripe
  at the code's left edge, so it shows on added and deleted rows and never
  looks like a landed line (tint plus the accent rail). The bubble sits on
  its last row, at the right edge of the visible code (sticky, so it stays
  there as long lines scroll; the cell keeps 48px free at its end).
- The bubble (`ThreadBubble`): a `raised` pill with the comment glyph and
  the total count of the threads ending there; a green check and muted
  text once all are resolved; a `warn` dot when one waits on the viewer.
  Named and tooltipped with where it is: "2 comments on line 16, your
  turn", "3 comments on old line 15, resolved". Toggling closes its tooltip.
  40px wide; a row tall with a mouse, 40px on touch (the row grows, so
  neighbours never overlap). All start closed.
- Opened, the threads show in a row right under the line, on `canvas`,
  kept at the diff's visible width (`--diff-w`) and in view however far
  the code is scrolled sideways. Each thread is an `edge` card: a `band`
  header (green check and "Resolved" in `ok`, or the yellow discussion
  icon and "Unresolved"; `ThreadStatus`; "outdated"), then the
  `Conversation` (spinner, Retry, "N missing", as in the Overview),
  avatars and tints as in the Overview, and the reply box with the
  Resolve button.
  Opening a thread changes no review state. Inside a cluster the thread
  keeps the cluster's rail at its left, and the cluster's floating controls
  stop above it while it passes, then float again below it. After a Refresh the previous read's threads stay until the
  new one's land; threads that couldn't be read show a `warn` "Threads not
  shown" notice under the progress bar, never an empty diff.
- A line in a collapsed gap: the hidden run's row has the bubble ("on
  hidden lines 20–79"); tapping it loads the thread's lines (from the
  nearer loaded edge when it is within 200 lines, else just a few around
  them, leaving hidden runs with their own ↑/↓ above and below), opens the
  thread there and focuses its bubble.
- A closed file's header has one bubble for all its threads ("9 comments
  in this file, your turn"; its hunks aren't read while closed, so the
  alert shows only for a binary or submodule file, and a line past the end
  is flagged once the file opens); tapping it opens the file. The file tree
  shows a dot before the counts (yellow your turn, green all resolved, else
  grey), named like the bubble and in the row's tooltip.
- In an open file, file comments and threads whose line isn't in the diff
  get the header bubble ("on this file"); the latter add a `warn` alert to
  it ("…, line not in this diff") and to the thread's header ("Line not in
  this diff"). Their threads open under the header.

## Starting threads in Files changed

- **Selecting** text in the code (any row kind, across rows and sides,
  within one file) or **picking lines** by their numbers (click; shift-click
  or drag down the numbers; a second tap on touch; Up/Down move between the
  number buttons, one tab stop per file, Shift extends, Enter picks; the
  number cells are 48×20 targets on a phone too, the owner's accepted
  exception to the 40px rule, for line numbers only, so rows keep their
  height) brings
  up the **selection bar**: one 40px icon button per registered action
  (`selectionActions.ts`; Comment now), on `overlay` with `edge` and
  `shadow-float`, just below the selection's end (above it when there's no
  room), never over it; on a phone a bar pinned to the bottom (above the
  safe area) quoting the selection. An action that can't run stays,
  `aria-disabled`, with the reason as its tooltip. Pressing it doesn't take
  the selection; Escape dismisses it until the span changes and clears
  picked lines (`line-picked`). A selection taller than the screen gets the
  bar beside it; on a phone the page pads its end by the bar's height. The
  first Tab after a selection goes to the bar. A new text selection lets
  picked lines go.
- **The composer** opens as a row under the span's last line, like an
  opened thread: an `edge` card whose `band` header quotes the span (its
  exact text on `span-mark`, then "line 4, new" in `faint` mono), a box and
  Cancel / Comment. The span stays painted (`thread-mark` and `span-mark`)
  while it's written. Sending: the text with a `warn` clock; refused: a
  `bad` line saying why above the box, the text kept.
  Refused, the box scrolls clear of the bottom notice; on a phone the
  floating Files button makes way while a box has focus or a write is
  refused. After a Refresh a draft moves to the new head (once its diff
  is in) when every line of its span and up to three lines of its hunk
  around it read the same at the same numbers, and Comment can go there (a
  file comment always moves); else it stays as an orphan, "Written on an
  earlier version".
- **A thread with a span** paints its exact characters with `span-mark` on
  its lines, in Files changed and in the Overview's code pane; when the
  columns don't fit the line any more, only the lines show.
- **Comment on file**: a 40px comment icon in every file header (open or
  closed, any kind of file); its composer shows under the header.

## Timeline (Overview)

The Overview's last section. A vertical rail (`line-strong`, 1px) through
40px round nodes on `raised`, oldest event at the top. A node's icon names
the event kind in its tooltip and carries its colour: commits and review
activity `muted`, force-push and base change `warn`, ready `ok`, reopened
`ok`, closed `bad`, merged `done`. Beside it one wrapping line: a 20px
round avatar and the login (bot icon), "N commits" / "N comments" in
`ink-soft`, the run's verdict icons (`REVIEW_ICON`), the "R of N resolved"
chip (green when all are resolved, else yellow, like the thread lists;
as of a cutoff a grey "N threads" chip, resolution being unknown),
"from X to Y" in `muted` small text, and the chevron toggle at the right.
Opened, the items sit under a 2px `line` rule: short SHA in mono `link`,
path:line in mono `link`, the thread state icon (yellow unresolved, green
resolved) and a link icon to the thread card. Facts name branches and
SHAs in mono on `overlay`. The latest 30 events show first; "Show N
earlier events" (the Load more button's style) sits above the rail.

## Typography

- Atkinson Hyperlegible Next (variable, bundled via
  `@fontsource-variable/atkinson-hyperlegible-next`, no CDN) for all UI text,
  headings (`font-display`) and comment and description bodies. Body text is
  15px with a 1.6 line height, GitHub-rendered Markdown included.
- Outfit (`@fontsource-variable/outfit`, `font-brand`) only for the
  wordmark (ExtraBold).
- Code, file names, paths and SHAs stay in the system monospace stack
  (`font-mono`, `<code>`), in tooltips too (`TooltipPath`).

## Logo

- `src/web/brand/logo.svg`: the full mark (gradient ring, split diff, splashes). 40px and up. The header shows it beside the PR title, on the same line, with no wordmark.
- `src/web/brand/mark.svg`: simplified (ring, diff, handle): favicon, the compact header and the footer.
  PNG fallbacks in `src/web/public` come from `pnpm icons`.
- `Wordmark` (`src/web/brand/Brand.tsx`): "carbonless" in Outfit ExtraBold with a star "o". The name appears only in the footer ("Diff by" mark wordmark, muted, bottom of both pages, with room under it for the floating Files button).

## Changelog

- **Fix round 1.**
  - Paths in tooltips (tree file and folder, file header) and the snapshot SHA are now monospace. This is asserted in FileTree.test and files.spec.
  - The star "o" has fatter, longer arms (r 190, k 0.29), and the desktop wordmark was 28px.
  - Syntax keywords moved from pink to orchid, functions to cyan and types to periwinkle; `invalid` is amber. The test checks that every syntax hue stays at least 25° from the add/del inks.
  - The header glow, selection, CTA glow and shadows are built from tokens with `color-mix`. Tests check the theme-color meta and Shiki's background against their tokens.
  - The contrast test now also covers:
    - the focus ring on overlay, pressed, hunk, add/del, gutters and the current tree row;
    - errors on hunk rows;
    - ink on the CTA count chip;
    - reviewed lines.
  - Reviewed lines no longer use opacity.
  - The compact mark sits in a fixed 28px slot that fades and scales, so the tabs don't shift.
