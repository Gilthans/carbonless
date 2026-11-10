# Find in PR: one search over every file's diff

Status: draft for the owner's review, 2026-11-05.

Calls the coordinator made (the owner may overrule) are marked **(call)**.

Mockups (desktop, phone, the count's states, the marks):
https://claude.ai/artifact/A4qsjo6oA4tnWiWiaq5yAB

## Why

The owner asked for a search across the whole PR, because Files changed
shows one file at a time and the browser's find only sees that one:

> "I want us to implement a search feature. since only one file is open at a
> time, it's hard to find the reference to a function in another file. so we
> need a custom search that searches both the file name list and the diff
> contents"

The moment it bites:

> "mac+f, searched the value, and immediately realized it wouldn't work.
> then i guessed a couple files and searched again"

Decisions the owner made in the conversation (2026-11-05):

> "I'd like it to behave as if searching the file with all files open. that
> is, it should show how many results found, and allow cycling through
> results with a highlight. i don't want a search results modal. it should
> search both diffs and context"
>
> "it should indeed take over cmd+f/ctrl+f, similar to how it works in
> github. there should also be a search button, which is how the phone gets
> there"

And on the recon's proposals (search runs in the browser over prefetched
hunks; "context" is the context the diff view can show, including expanded
ranges, not whole files; the bar lives on Files changed only; a path hit is a
hit on the file's header; stepping into a closed file opens it): "yes,
everything you said sounds correct".

## Goals

- **Browser find, over the whole PR.** A bar (never a modal, never a results
  list) with a text box, a count ("3 of 41"), previous and next. Stepping
  moves through every hit in the PR in reading order, opening whichever file
  holds the hit and scrolling its line into view, with the current hit
  highlighted strongly and the other hits in the open file lightly.
- **Everything the reviewer could read is searched**: file paths (old and
  new), added lines, removed lines, the context lines the diff shows, and any
  context the reviewer has expanded.
- **Cmd+F / Ctrl+F opens it** on Files changed, as on GitHub's PR files
  page; pressing it again with the box focused hands over to the browser's
  own find. A header button opens it too: that is the phone's way in.
- **Works on a phone** (principle 5): the bar fits 360px with the count and
  the arrows beside the box, no horizontal scroll.
- **Fast on a big PR**: hits in paths and changed lines show as you type,
  with nothing fetched; context hits fill in as files' hunks arrive in the
  background, and the count says so while they do.

## Non-goals (this stage)

- Regular expressions or a whole-word toggle. Plain text, like the
  browser's find, with one option: match case (below).
- Searching lines the diff doesn't show (unchanged lines outside the hunks'
  context that nobody expanded). That needs the whole file text and
  auto-expanding context; a later stage if wanted.
- Searching comments, threads, the overview or the timeline.
- Searching on the Overview or Final Verdict pages. Cmd+F there stays the
  browser's.
- Remembering the term across reloads, or putting it in the URL.

## Anti-goals

- **A search that hides anything.** The file tree is never filtered by the
  term and no file or line is collapsed, dropped or reordered by it
  (principle 2). Search adds marks; it takes nothing away.
- **A search that changes review state.** Stepping, opening files, expanding
  a collapsed cluster to show a hit: none of it marks anything reviewed or
  touches the server's review data.
- **A count that looks complete while it isn't** (the loading rule): while
  any file's hunks are still on their way, the count carries a spinner; a
  file whose hunks couldn't be read is reported, never silently skipped.
- **A highlight that reads as review state.** Hit colors are not the green,
  red, yellow or violet of the review conventions (`docs/design/README.md`).
- **Breaking the browser's find.** A second Cmd+F always reaches the browser.

## Where it lives

- **Files changed only.** The bar stays put, like the browser's find
  (owner's QA, 2026-11-07: "The search bar should 'hover' on top of the
  page, like the browser find. It should stick to the top always, so if I
  click the 'next' button its position should never change"): typing and
  stepping never move it on screen. It is a strip across the very top of
  the page, above the app header, in the page's flow (App's slot,
  `data-find-slot`, which Files changed's bar portals into: `FindSlot`),
  `position: sticky; top: 0`. It pushes the page down by its own height,
  so nothing is covered at the top; once scrolled it stays at the top and
  the sticky stack sticks right under it: the stack's top
  (`--app-header` on the root, `AppHeaderHeight`) is the bar's height
  plus, on desktop, the header's stuck row. A step lands its hit below the
  bar and the stack (`scrollUnderStack`), and focus scrolling clears them
  (`scroll-padding-top`). Settings' popover is in the top layer.
- **Desktop: the bar pushes the header down** (owner's QA, 2026-11-09: "on
  desktop it shouldn't hide the the top bar buttons, it should push them
  down"). The header, with Find in PR, Refresh and Settings, starts right
  under the bar and sticks under it (`top` is the bar's height less its
  last row's offset). The strip is full width, `surface` with a `line`
  border, one row; its controls (28rem) sit at its right, within the
  page's width, under where the header's buttons are. Closing puts the
  header back at the top.
- **Phone: the bar takes the app header's place, pushing the page down**
  (owner's QA, 2026-11-07: "While the search box is open on the phone, it
  should hide the top bar entirely. Closing it restores"; 2026-11-08: "I
  didnt mean it should replace the top bar. just that it should hide it
  ... perhaps the search should push the rest of the page down? so it
  should appear at the very top, but without hiding anything - just pushing
  it down?"). While it is open the header is out of the layout (`hidden`,
  so it takes no room; its tabs, Refresh and Settings go with it) and
  main's top padding goes, so the files bar, tree and diffs follow right
  under the bar, nothing covered and no blank band. The bar is just as
  tall as its two rows (the box at full width; the count, ↑, ↓ and ✕).
  The header leaves only once the bar is on screen (`findFloat`): while
  Files changed's review is still read, or if the read failed, the header,
  its tabs and its Find in PR button stay, so there is always a way out.
  Closing (✕, Escape) shows the header again and puts focus on its Find in
  PR button.
- **The soft keyboard doesn't take the bar away** (owner's QA, 2026-11-09:
  "on phone, if I open search and scroll down a little it disappears. I'd
  rather it stay until I close it"). Opening the bar focuses its box, so
  the phone's keyboard comes up. By default it shortens only the visual
  viewport; a scroll then pans the visual viewport down first, and
  anything stuck at the layout viewport's top (`top: 0`) is left above
  what's seen. Android: the viewport meta's
  `interactive-widget=resizes-content` makes the keyboard shrink the layout
  viewport instead, so native sticky holds. iOS ignores it: while the bar
  shows, App follows `visualViewport.offsetTop` (read once a frame, written
  only when changed) as `--vv-top` (`visualTop`): the slot sticks at that
  top and the stack's top (`--app-header`, Files changed's in-view
  tracking) adds it. A known limit on iOS: the pan is followed from the
  main thread, so the bar can lag a frame behind a fast scroll. A pinch
  zoom (`visualViewport.scale` over 1.01) isn't followed: the bar stays at
  the page's top, like the rest of the page.
- **Opening and closing keep the reading place.** Scrolled down, App notes
  the element mid-window before the swap and scrolls by however far it
  moved (`readingPlace.ts`), on desktop and phone; at the top of the page
  the swap shows. Resizing between phone and desktop widths with the bar
  open doesn't keep the reading place (accepted).
- **The term lives only while the bar is open on this page** (owner's QA:
  "Don't store the search term. Leaving the page or doing almost anything
  should clear the search box"). Closing clears it. Leaving Files changed
  (another tab, another review, Home) closes the bar and clears it, and a
  reload starts closed. A Refresh to a new revision while the bar is open
  keeps it (the same page, the reviewer mid-search). Match case stays
  remembered.
- **The search button** is in the app header row, beside Refresh and
  Settings: a magnifying glass (`SearchIcon`), 40px tap target, tooltip "Find
  in PR" with the key, `aria-label="Find in PR"`, `aria-expanded` while the
  bar is open. On Files changed it opens the bar (and focuses the box), or
  closes it when open. On the other pages it goes to Files changed and opens
  the bar there **(call)**: "find in PR" means the diff from anywhere.
- **Keys** (registered with `useShortcut`, listed in the `?` help under
  "Files changed"):
  - `Mod+f`: open the bar, focus the box, select its text. Not while typing
    in a field (`useShortcut`'s rule): with the box itself focused the browser
    gets the key, which is GitHub's "second Cmd+F" behaviour for free; in a
    comment box it stays the browser's too.
  - In the box: `Enter` next, `Shift+Enter` previous, `Escape` close
    (`useShortcutHelp` entries).
  - Outside the box, while the bar is open: `Mod+g` next, `Shift+Mod+g`
    previous **(call)**: the browser's own find-next keys, so the hands don't
    have to go back to the box after reading.
- **Closing** (Escape in the box, the ✕, the header button) clears every
  highlight, the tree's counts and the term, and puts focus on the header
  button. Reopening starts empty.

## The bar

```
┌──────────────── [saveDraft______ Aa] 3 of 41 ◌ ↑ ↓ ✕ ┐  ← the bar, sticky at
├ app header: Overview · Files changed · Verdict  🔍 ↻ ⚙ ┤     the top, pushing
│ ■■■■■■■■□□□□□ 61% · 12/20 files                       │     the header down
│ src/web/files/FileDiff.tsx                            │  ← progress bar,
│   12 + const x = …                                    │     file header
```

Phone (360px): two rows, in the header's place (hidden while it shows):

```
┌[saveDraft____________________ Aa]┐
│ 3/41 ◌                  ↑  ↓  ✕  │
├ ■■■■■□□□ 61% · 12/20 files ───────┤
```

- The box: `<input type="search">` (a typing target, so single-key shortcuts
  like `w`, `s`, `c` don't fire while typing), placeholder "Find in PR",
  `aria-label` the same, `autocomplete="off"`, `spellcheck={false}`, at
  least 40px tall.
- The count: "3 of 41" in `text-muted`, `aria-live="polite"` so a screen
  reader hears it change. "0 of 0" for no hits. A spinner after it
  (`Spinner`, label "Searching files…") while hunks are still arriving. A
  `warn` icon with tooltip "N files couldn't be searched · Retry" when a
  batch failed; pressing it retries those files.
- ↑ ↓ ✕: icon buttons (`ChevronUpIcon`, `ChevronDownIcon`, `XIcon`), 40px,
  tooltips "Previous (Shift+Enter)", "Next (Enter)", "Close (Esc)",
  `aria-label` the same. Disabled while there are no hits.
- **Match case** (owner's decision, 2026-11-05: "Should be a toggle"):
  an "Aa" toggle at the right end of the box, 40px, `aria-pressed`,
  tooltip "Match case". Off by default (case-insensitive, like the
  browser's find); on, the term matches exactly. Remembered per viewer like
  the other view settings (`viewSetting("crb.find.matchCase", false)`)
  **(call)**. Flipping it recomputes the hits; the caret rule applies as if
  the term had been retyped.
- Empty box: no hits, no count, no marks, no spinner (nothing is being
  searched). The hunk prefetch still runs once the bar is open.

Phone (≤ 640px): the bar takes the full width in the header's place, the
box shrinks, the count collapses to "3/41", the arrows and ✕ stay 40px.

```
│ [🔍 saveDraft________________ Aa] │
│ 3/41 ◌                   ↑  ↓  ✕  │
```

## What is searched, and in what order

A **hit** is one occurrence of the term, as the browser's find counts them:
plain text, case-insensitive unless Match case is on, non-overlapping, left
to right within a line.
The term is matched as typed (spaces included) against the **raw text** of
the line, not against the hidden-character markers the view draws (`·`,
`\t`, `\n`): a search for two spaces finds two spaces. A highlight covers
exactly the matched characters; the builder handles case folding that
changes a string's length (keep the original indexes, never paint by the
folded string's).

The PR's hits, in **reading order**, are, for each file in the tree's order
(`treeOrder`, the page's one order):

1. **The path** (`FileView.path`), then for a rename the old path
   (`oldPath`): each occurrence is a hit on the file's header. Binary files,
   submodules and mode-only changes have only these.
2. **The lines**, in the order the diff shows them: the file's hunks in
   order, each hunk's lines in hunk order (context, removed, added, as the
   server lays them out), with any **expanded context** the reviewer loaded
   (the file's `contextQuery` ranges) in its place by line number. A line's
   hits are in column order. A removed line and an added line are two lines
   with their own hits, whatever row pairs them: the search is over the
   hunks' lines, never over the rendered rows. One exception (CAR-103, owner
   2026-11-10, "count once"): in unified view with Ignore whitespace on, a
   whitespace-only pair is one `~` row showing its new text, so its removed
   line's hits aren't counted or stepped through. Side by side shows both
   texts and counts both, so the count may change with the view. In that
   view (unified, Ignore whitespace on) a hunk's hits also follow its rows
   as rendered (`viewRuns`), not hunk order: a `~` row's hits are where the
   row sits on screen. A current hit on a pair's old side moves to the
   row's new-side hit of the same order, and that move stays (owner,
   2026-11-10): switching back to side by side or turning Ignore whitespace
   off keeps it on the row's new side. A move off the row (the new side has
   no such hit, e.g. a term whose whitespace differs between the sides)
   doesn't stay: the old side's hit is current again once it shows.

**Two line sources, one order.** Changed lines come from the review view
and are searched at once; a file's context lines join when its hunks are in,
and expanded ranges when they are loaded. The hits of a file are ordered
by position (hunk, line, column; in unified view with Ignore whitespace,
a hunk's lines by its rendered rows), so context hits slot in between the
changed-line hits already found. The **current hit is a position** (file,
side, line number, column), never an index: when context hits arrive, "n of
m" may change on both sides while the mark stays on the same characters. The
integrity test asserts this (the current hit survives a file's hunks
arriving; the count equals the hits of both sources, none twice).

**Expanded context survives closing a file (owner's decision,
2026-11-05).** The expanded ranges of a file are kept per file for the
snapshot (page-level state keyed by revision and index, with a long `gcTime`
on `contextQuery`), so reopening a file shows the context it had expanded,
and the search sees it whether the file is open or closed. Today a closed
file forgets its expansions; this changes that for the page as a whole:

> "I think remembering expansions per file makes sense. It's a nice surprise
> for it to work this way, even if not crucial."

A Playwright test covers it: expand, close, reopen, the rows are there.

**Typing never moves the page (owner's decision, 2026-11-05).** As the
term changes, the bar marks and counts; nothing scrolls and no other file
opens until Enter, Shift+Enter, an arrow or Mod+g is pressed:

> "When starting to search or typing, don't jump to the first result until
> one of the buttons is clicked. First result caret should always be first
> match in the current open file, and only jump to another file if there
> aren't any matches in current file"

So the **caret** (the current hit) when the term changes is the first hit
in the open file, painted `find-current` where it is, on screen or not; when
the open file has none, it is the first hit after the open file in reading
order (wrapping), shown only by the count ("1 of 41") and the tree's chip,
its file not yet opened. A caret placed by typing is **not yet shown**: the
first step (Enter, ↓, Mod+g, and also Shift+Enter, ↑) shows it, scrolling to
it and opening its file if needed; the steps after that move to the next or
previous hit. **Unless it is already in view** (owner's QA, 2026-11-07:
"The first time I click enter keeps me on the match I already saw. It
should move on to the next"): when the caret's characters are in the open
file, on screen, below the sticky stack and clear of the bar, the first
step moves on to the next (Shift+Enter: previous) hit. A caret in a closed
file, off screen or under the stack is gone to first, as before. Next and previous wrap around at both ends, as the browser's
do. Deleting the term and typing it again starts over by the same rule. With
no file open, the caret is the first hit in the PR, unshown until a step.

## Stepping to a hit

Moving the current hit (Enter, ↓, ↑, Mod+g, Shift+Mod+g):

- **A hit in a closed file** opens that file alone, as picking it in the
  tree does (`select`: the open file closes, the tree marks and reveals the
  new one, folded folders holding it unfold). Nothing else changes.
- **A line hit** scrolls its row under the sticky stack with a few lines of
  context above (what a thread link's landing does: `useLanding`'s
  `scrollTo(row, 60)`), and makes the row current. A hit in a collapsed
  cluster (a whitespace-only one) opens the cluster first, the way a landing
  line does (`LandingLine`).
- **A path hit** scrolls the file's header to the top of the stack, as a
  tree pick does, and highlights the path in the header and in the tree.
- A hit in a file whose hunks are still loading: the file opens and the step
  completes once the hunks are in (the file's own `DiffBody` is waiting on
  the same query).

Scroll-linked motion respects reduced motion as the rest of the page does.

## Highlights

- **Every hit in the open file** (lines) and every path hit (file headers
  and tree names) is painted on its matched characters with a new `find-mark`
  utility.
- **The current hit** is painted with `find-current` on its characters and
  its row carries `mark-tint` (the landing's wash) for as long as it is
  current, so the eye finds the row and then the characters.
- Hits in closed files aren't rendered; the tree says where they are (below).
- Colors **(call)**: `find-mark` is an opaque fill of the accent's hue, the
  way `span-mark` is, and `find-current` an opaque fill of the brand orange
  with `canvas` text (`ink` on the orange is only 2.42:1, `canvas` 7.11:1):
  the browser's own convention for "the match you're on",
  the one place a brand hue carries meaning, and only while the bar is open.
  Both opaque so every syntax color keeps 4.5:1 on any row kind, checked in
  `theme.test.ts` like `span-mark`. Must stay apart from `span-mark` (a
  thread's exact characters): the builder picks tones and the test checks
  the contrast; `find-mark` under a `span-mark` shows the find (it is the
  thing in hand).
- Painting goes through the span mechanism code lines already have
  (`Mark`s over characters, `CodeLine` in `src/web/code/Invisibles.tsx`),
  so marks line up with hidden-character rendering, tabs and wrapped lines
  in side by side.

## The file tree

While the box has a term, each file with hits shows its count in a small
chip after its name, `find-mark` colored, `aria-label="N matches"`; a
folded folder shows the sum of its files'. Files without hits are left
exactly as they are (no dimming, no hiding). A file whose hunks are still
loading shows the count it has so far (path and changed-line hits), with the
bar's spinner standing for the rest (no per-file spinner). Picking a file in
the tree still opens it as today; it doesn't move the current hit.

## Loading the hunks

Hits in paths and changed lines come from the review view the page already
has (`FileView.clusters[].removed/added`). Context hits need each file's
hunks (`FileHunks`, 3 lines of context around each cluster), which today are
fetched one file at a time when it opens.

- **A batched endpoint** beside the single-file one, under the review's
  prefix: `GET /api/r/:id/files/hunks?revision=<r>&indexes=1,2,3` returning
  `{ files: { index: number; hunks?: FileHunks; error?: string }[] }`, at
  most `HUNKS_BATCH` (25) indexes per request, 400 on more or on a bad
  index, 409 `stale` on a revision the session has moved off, like the
  single-file route. A file whose text can't be read fails on its own
  (`error`), never the whole batch **(call)**. It reuses `loadFileHunks`;
  blobs are cached on the server, so a batch costs the hunk builds.
- **The prefetch** starts when the bar opens (not on page load: first open
  is the performance target, and search isn't part of it) and runs in tree
  order, the open file's neighbours first, `HUNKS_BATCH` files per request,
  two requests in flight, skipping files whose hunks are cached or already
  on their way (a file just opened) and files with no lines (binary,
  submodule). Each file's answer lands in that file's
  own `hunksQuery` cache entry, so opening it later is instant and `DiffBody`
  reads the same data. Prefetched entries must outlive React Query's default
  garbage collection for unobserved queries (set a long `gcTime` on
  `hunksQuery`, or keep the search observing them while the bar is open);
  without that the search would refetch files five minutes after the bar
  closed.
- A new snapshot (Refresh) changes the revision: the search recomputes on
  the new review view and the prefetch starts over for the new revision if
  the bar is open. The old revision's hunks are left to the cache.
- Failures: a batch that fails marks its files "couldn't be searched" (the
  `warn` icon and Retry above); the count never pretends they were.

Search itself is a pure function `findInPr(term, files, hunksOf, contextOf)
→ Hit[]`, recomputed in a memo as the term or the data change. A 200-file,
20k-line PR is a few milliseconds of substring scanning per keystroke; no
debounce unless measured to need one.

## Interactions with what's there

- **Side by side / ignore whitespace / hidden characters**: views over the
  same lines. A hit is found by its line's number and side in whatever rows
  are rendered (`tr[data-new-no]` / `tr[data-old-no]`, the landing's way),
  and painted on that line's cell. Switching a view keeps the current hit and
  repaints (the count may change: unified with ignore whitespace counts a
  `~` pair once, §reading order, CAR-103; a current hit on the pair's old
  side moves to the row's new side).
- **Thread marks and picks**: a find mark over a `span-mark` shows the find;
  a current row under a `thread-mark` or `line-picked` row shows both washes
  (they are all accent tints; the characters are what differ).
- **Landings from thread links** still work while the bar is open; a landing
  doesn't move the current hit.
- **Writing a comment**: `Mod+f` in a textarea stays the browser's; the bar
  and its highlights stay as they are.
- **The files sheet on a phone**: a step that opens a file closes the sheet
  as a pick does.

## Docs, branch, gallery

- Branch `search`, worktree `.worktrees/search`, from `master`; PR on
  Gilthans/carbonless when ready.
- `docs/product-rules.md`: the "Frequent actions get keyboard shortcuts"
  rule gets the Cmd+F exception: carbonless takes a browser key only where
  it offers the same thing over more (find), and always leaves the browser's
  reachable (a second press).
- `docs/faq.md`: "Why doesn't the search find a line I know is in the file?"
  (only the context the diff shows is searched; expand it to search more).
- Gallery (Gilthans/carbonless-gallery): a `find-in-pr` case: a function
  renamed and called from several files, one call only in context lines,
  one in a file path, a match that differs only in case, one in a binary
  file's path, a whitespace-only cluster holding a match; README row.

## Tests

Unit (Vitest):

- `findInPr`: occurrences per line (non-overlapping, column order), case
  folding (with a string whose folded length differs) and Match case on,
  paths and old paths,
  binary files (path hits only), order across files (tree order), expanded
  context in line order, the caret rule (first hit in the open file, else
  the first after it in reading order, else the PR's first; the first step
  shows it unless it is already seen, later steps move; wrap).
- **Integrity** (the principle-2 habit): for random files and terms, the
  count equals the hits painted in the open file plus the tree's counts of
  the closed files; every painted mark is a real occurrence; no line of the
  hunks is searched twice or not at all (property test, like
  `whitespace.test.ts`).
- The bar: count and spinner while a hunks query is held, "couldn't be
  searched" on a failed batch, Retry, "0 of 0", closing clears the term,
  leaving the page closes the bar, the header button on another page
  navigates, the bar sits in App's slot above the header, out of the
  progress bar's sticky stack, a phone's header is hidden while it is open.
- Server: the batched route (limits, bad index, stale revision, binary files
  come back empty, the answer equals the single-file route's).
- `theme.test.ts`: `find-mark` and `find-current` under every syntax color
  and on every row kind.

Playwright (desktop and phone projects):

- Cmd+F / Ctrl+F opens the bar focused; typing a term shows "n of m" and
  the marks; opening keeps the line read in place and typing doesn't
  scroll; the first Enter moves on from the open file's first hit
  when it is in view, or goes to it when it isn't; the next Enter steps
  into another file, which opens, with the row in view
  below the sticky stack and the current mark on the matched characters;
  Shift+Enter goes back; stepping past the end wraps. A term with no hit in
  the open file: the count says "1 of m", no file opens until Enter.
- The header button opens and closes the bar (phone: the only way in).
- A path hit opens the file at its header with the path highlighted; the
  tree chips show counts; folded folders show sums.
- Context: a term only in context lines is counted once the prefetch lands
  (the spinner shows meanwhile: assert its presence before the count
  settles, never a time bound).
- Unified with ignore whitespace counts a `~` pair once and every step
  paints a mark; side by side counts both; the current hit is kept across
  the switch.
- Match case: the count changes when toggled; the setting survives a
  reload.
- Escape closes and clears marks; reopening starts empty. Leaving Files
  changed (another tab, a reload) clears the search.
- The bar stays put: its box is the same after opening, three steps and
  steps across files. Phone: the app header is hidden while the bar is
  open and back after ✕, rows stepped to land below the bar.
- Shortcuts help lists the new keys under Files changed.
- `pnpm flake-check` on every new spec (spinners and gates are involved).

## Left to the builder

- The exact tones of `find-mark` and `find-current`, within the color
  constraints above and the contrast test.
- (Decided, owner 2026-11-10, CAR-103.) Hits in a `ws` row (ignore
  whitespace pairing two whitespace-equal lines): unified counts and steps
  only the text the row shows (the new side's); side by side counts both.
- The batcher's shape (a small class like `CommentsBatcher`, or a query per
  batch), and how "couldn't be searched" is kept per file.
- Where `findInPr` and the bar's state live (a small store like
  `viewSettings`', or a context), so the header's button, the tree, the file
  headers and the diff bodies read one source.
- How `find-mark` and `find-current` join `CodeLine`'s `Mark`s (a kind on
  the mark, so they layer under or over `span-mark` as the spec says).
- Which tree entry of a renamed file carries its old path's hits.
- The search-button placement details in the compact header row at 360px
  (it shares the row with the tabs, the title pill, Refresh and Settings;
  the title pill gives way first, as it does today).
