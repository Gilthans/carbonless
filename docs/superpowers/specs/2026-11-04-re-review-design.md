# Re-review after new pushes: design

2026-11-04. Commentable copy: https://claude.ai/artifact/M74PoxCz754YzTV7Nabwvd (the doc is the working copy; this file mirrors it). Mockups: https://claude.ai/artifact/WixND7ZrR3EMTAHAqMR7iL. Earlier copies under another account: doc https://claude.ai/artifact/AhZDkCdqR4dyayMnFdsAqr, mockups https://claude.ai/artifact/EP31yvNhgGwQEfdgMmDXuD

## Intent

A reviewer who comes back to a PR after the author pushed should re-read only what the author changed, with every comment and every review mark where it belongs, and should be able to go back to any earlier patch set exactly as they reviewed it. This closes the last gap before the owner reviews exclusively in carbonless (end of milestone 2). The scenarios, the survey of other tools and the decisions behind this design are in [Re-review after new pushes: scenarios and prior art](https://claude.ai/artifact/NSJ9cTzqqRV1BiMqFBLLYE); scenario ids below (S4b, C5, P3, I5, X2) refer to its tables.

### Goals

- Moving to a new snapshot carries every review mark whose change is provably the same, and places every unresolved thread, or says why it can't.
- The interdiff shows the author's own changes since the reviewer's patch set, in every shape of history: appended commits, a base merged in, a rebase with or without conflicts, a squash, a stacked parent landed.
- Any earlier patch set opens exactly as it was reviewed: its diff, its marks, its threads as placed then.
- Everything stays inside Files changed; the Overview and the Final Verdict tab say what changed since the reviewer's verdict.
- Every carry and placement is data the reviewer can see and undo (principle 1); a wrong or missing one can only make coverage look incomplete (principle 2).

### Non-goals

- No AI in this round. Later: associating changes with comments, confirming a comment was addressed, helping associate clusters, as editable suggestions.
- No per-line review states (parked; first measure how often clusters split).
- No attention set or "what happened since my last visit" activity feed (todo).
- No change to how threads are written to GitHub.

### Anti-goals

- A carry that marks a cluster the reviewer never saw as reviewed, in any shape of history. A bug here is worse than no carry.
- A thread hidden or dropped because it couldn't be placed (GitHub's "outdated" collapse).
- An interdiff that shows the base's changes as the author's (GitHub, GitLab, Review Board after a rebase).
- A heavier git: no extra refs that regular git operations see, no growth of a review with the number of other reviews (principle 3).

## Vocabulary

- **Snapshot**: one PR state, the pair (merge base `B`, head `H`), and its three-dot diff. One per push the tool has seen. The current one is `R = (B2, H2)`. The storage doc's "revision" is renamed to this.
- **Patch set (PS)**, the owner's "changeset": a snapshot the reviewer took a lasting action on: marked or crossed off a cluster, opened a thread, gave a verdict (a reply, resolve or unresolve acts on a thread, not on the snapshot). Identified by its snapshot id; numbered per reviewer in start order (PS1, PS2); pinned by refs so its head and merge base outlive force-pushes and base rewrites. The reviewer's latest is `PS1 = (B1, H1)` in formulas.
- **Landmark** (deferred, owner 2026-11-04): a head someone else commented or gave a verdict on, derived from GitHub, usable as a since/to point. Not in this round; nothing here depends on it.
- **Shape**: how `R` relates to `PS1` (S1 appended, S3 base merged in, S4a trivial rebase, S4b rebase with conflicts, S4c rework, S5 squash, S6 backwards, S7 retargeted, S8 stacked parent landed, S9 revert), detected per move and recorded.
- **Virtual rebase `H1'`**: `git merge-tree --write-tree B2 H1`: the old head as if rebased onto the new base, built without touching any branch.
- **Interdiff**: `diff(H1', H2)`, the author's own changes since `PS1`; the diff of the two patches with the base's changes folded out. For S1 it equals `diff(H1, H2)`.
- **Carry**: a cluster state of `PS1` moved to its cluster in `R` by the engine, recorded as an `auto` event naming source and rule.
- **Placement**: where a thread sits in a snapshot: placed, placed but changed, or unplaced with a fate. Computed by the engine, stored only when discretion decided it.
- **Since view**: Files changed filtered to what needs the reviewer's eyes in `R`: reworked and new clusters, changed and unplaced threads; carried clusters collapse with a carried mark.
- **Base view**: Files changed showing `R`'s whole diff to its merge base, with carried marks. Same state as the since view; two projections of one patch set, chosen by where the base marker sits.
- **Patch set graph**: the rail in the Files changed header: the base-branch dot, one dot per patch set, and a hollow head dot when the head is newer than the last patch set; a viewed marker and a base marker on it set the comparison (owner, 2026-11-04).
- **Viewing the head**: putting the viewed marker on the head dot shows the since view computed by the engine, with provisional carried marks. Nothing is written until the first lasting action, which starts the patch set.

## Data model and storage

Everything below extends `docs/review-data-storage.md` without changing what exists; that doc is updated in the same change, and its "revision" becomes "snapshot".

### What starts a patch set

Any lasting reviewer action on a snapshot: marking or crossing off a cluster (today), opening a new thread, submitting a verdict (new): each names a head. A reply, a resolve or an unresolve acts on a thread, not on a snapshot: they never start a patch set and are allowed from anywhere (the Overview after a push, an old patch set). A patch set is identified by its snapshot id, the number being a display label: viewing a head whose snapshot already is one of the reviewer's patch sets shows that patch set with its own states (a force-push back to an earlier head, S6, brings PS2's marks back), so two patch sets never share a snapshot id and `cluster-state` keeps its format. With no patch set yet, the first action starts PS1 on the viewed head with no `since`; the since view needs a patch set, so the last-seen head only feeds the toast. Viewing the head (the head dot of the graph, or the toast's View) writes nothing: the page shows the since view from the engine's answer, carried marks provisional (owner, 2026-11-04). The first such action on a snapshot that isn't yet a patch set writes `patchset-started` and the pin refs in one `update-ref --stdin` transaction, before the action's own event or GitHub write. Opening the PR alone never starts one: the server keeps a last-seen head per review in its own state directory (not in git: it is UI state, private to this crb instance), so the toast can say "3 new commits since you last looked" even before a patch set exists.

### Refs

```
refs/crb/reviews/<id>/reviewers/<r>/patchsets/<n>        head (exists today)
refs/crb/reviews/<id>/reviewers/<r>/patchsets/<n>-base   merge base (new)
```

The `-base` ref keeps the merge base alive if the base branch is rewritten, which closes the last gap in "any patch set opens exactly as reviewed". Reads treat a missing `-base` ref as "unpinned" (patch sets started before this change) and fall back to the recorded merge base OID, which is still almost always reachable. Pinning adds one ref per patch set per reviewer: a review with 3 reviewers and 5 patch sets each has 30 patch set refs; principle 3's measurements (300k refs on the remote, no effect on everyday git) cover this with room.

### Events (progress ref)

| Type | By | Payload | New? |
| --- | --- | --- | --- |
| `patchset-started` | human | `n`, snapshot id, `mergeBase`, `head`; `details.since` = previous patch set `n` or none, `details.shape` = the detected shape, `details.baseBranch` = GitHub's base branch name then (for S7), `details.interdiff` = `available` or `unavailable` with a reason | extended |
| `cluster-state` | human | as today; a human event after a carry overrides it (last event wins) | as is |
| `carried` | auto | `from` (patch set `n`), `to` (patch set `n`), `rule` (`exact` or `rename`), `states`: a list of `{key, fromKey, state}` for every cluster carried under that rule | new |
| `thread-placed` | human, later ai | thread id, patch set `n`, anchor (`path`, `startSide`, `startLine`, `side`, `line`), `engine` (the tracer's version), `details.reason` | new |

`carried` holds many clusters in one event, so a move costs one event per rule, not one per cluster: 200 clusters at 32 hex characters of key each is about 7 KiB raw, and the squash before push keeps it. Measured when the format lands, as principle 3 asks.

Write rules, enforced in code and tested:

- `by: auto` may appear only on `carried`; `cluster-state` stays `by: human`; `by: ai` can never change a state (as today).
- A `carried` entry is written only by the engine, and only when the source cluster's folded state in `from` is a human state and the target cluster in `to` traces exactly (The engine). The fold checks the first half again on read: a carried entry whose source state is not a human `reviewed` or `crossed-off` is ignored. The second half is the engine's own correctness, covered by its tests and the methodology matrix, the same trust as cluster computation itself.
- A `thread-placed` anchor is validated against the patch set's snapshot before use: a path or line that isn't there makes the thread unplaced, never placed somewhere else.
- Nothing in `details` affects folding or coverage.

### Folding

State per (patch set, cluster) is the last event by `(ts, id)` among `cluster-state` events for that patch set and the entries of `carried` events into it. Coverage is computed against the patch set's own snapshot exactly as today: a state whose key isn't in the diff is ignored, and anything ambiguous stays unreviewed.

### GitDB principles

Append-only events, one commit per event, compare-and-swap, squash before push, empty tree, no state in trees: all unchanged. Each review's cost still depends only on its own size. `thread-placed` lives in the reviewer's own progress ref for now (no sync exists yet); once sync lands it is shared through `meta` (owner, 2026-11-07), which is exactly the manual placements and moves, since computed placements are never written. Not a format change (readers skip unknown refs and types).

## The engine

Five pieces, each with its own tests. Only shape detection and the interdiff run git, through the existing server helpers; the tracer, carry and thread placement are pure: they take hunks, rename pairs and states and return results, with no git and no I/O (owner, 2026-11-07: every piece that can be pure should be). A thin server module wires the two kinds together: git produces the diffs, the pure pieces consume them.

### Shape detection (`src/server/rereview/shape.ts`)

Inputs: `PS1 = (B1, H1)`, `R = (B2, H2)`. Queries: is `H1` an ancestor of `H2`; is `H2` an ancestor of `H1`; `B1 == B2`; GitHub's base branch name then and now; `merge-tree --write-tree B2 H1` succeeded, and if so is `H1'`'s tree equal to `H2`'s. Output: the shape code and, when the virtual rebase failed, the reason (`conflict` with the file list, `unrelated`, `shallow`, `error`). The shape is recorded on `patchset-started` and shown in the graph's connector card; it never changes what carries.

### The tracer (`src/shared/tracer/`, pure)

GitLab's three-diff trace, in TypeScript, over the shared hunk format already produced by the server (`DiffHunk`). No git, no I/O, no knowledge of threads or clusters.

- `LineMapper(hunks)`: `oldToNew(n)` and `newToOld(n)` for one file's diff; `null` for a line the diff removed or added; identity for an untouched file.
- `tracePosition(pos, { ac, bd, cd })` where `pos` is `(side, line)` in the old snapshot and the three diffs are old base to new base, old head to new head, and the new snapshot's own diff, each as a per-file mapper with the file's path mapping (renames). Returns one of: `placed(side, line)`, `changed(side, line, oldText)` when the line's content differs but its place is known, `unplaced(reason, nearest)` with the nearest surviving line above. The decision table is the one from the discussion doc's GitLab section: an added line maps through `bd` then `cd`; a removed line through `ac` then `cd`; a context line through both.
- `traceRange(range, …)` traces both ends; if their order breaks, the range collapses to its end line and is marked changed.
- `traceSpan(span, oldLineText, newLineText)` re-finds a span's text inside its traced line; not found, the thread falls back to whole lines and says so.
- Never assumes the new commits descend from the old ones; never searches by text across lines (duplicate lines pair by position).
- Version constant `TRACER_VERSION`, recorded on stored placements.

### The interdiff (`src/server/rereview/interdiff.ts`)

`H1' = merge-tree --write-tree B2 H1`; the interdiff is `git diff -M H1' H2` with the same flags as the snapshot's diff (zero context for clusters, rename detection), parsed into the shared hunk format. Shape S1 short-cuts to `diff -M H1 H2`. A file the merge-tree could not rebase is in the interdiff as its full new diff (what the author committed), flagged `conflict`, and that is all: no conflict markers are kept or shown (owner, 2026-11-07: a git conflict rarely reaches a review, so the minimum). When the virtual rebase can't be built at all, the interdiff is `unavailable` and the since view shows the whole snapshot as new. The interdiff is computed once per (reviewer, PS1, R), cached by those OIDs; it never blocks the first open of the page nor the graph (the connector's card and the since view fill when it is done).

### Carry (`src/shared/rereview/carry.ts`, pure)

For every cluster of `PS1` with a human `reviewed` or `crossed-off` state: map its path through the interdiff's rename pairs; trace its added lines through `bd` (`diff(H1, H2)` per file) into `H2` and its removed lines through `ac` (`diff(B1, B2)`) into `B2`; find the cluster of `R` whose added lines are exactly the traced new-side range and whose removed lines are exactly the traced old-side range (a pure deletion has only the second, a pure addition only the first). Carry when that cluster's removed and added lines equal the source cluster's, byte for byte. Context lines play no part. The inputs are the clusters and human states of each earlier patch set, the three diffs per file and the rename pairs; the server fetches them, the function only computes. Anything else, including a cluster whose lines traced but whose run of changes is now longer, shorter or reordered, is not carried. Old clusters with no image in `R` are listed as gone (the since view shows them as removals). Rule names: `exact`, `rename` (same, through a rename pair). Carry consults earlier patch sets too: a cluster not carried from `PS1` is tried against `PS0`'s human states and so on back (P8), with `from` recording which. The walk back stops at the first patch set that has any human state for that cluster, `unreviewed` included: an untick in PS1 is never undone by PS0.

### Thread placement (`src/shared/rereview/placement.ts`, pure)

For every unresolved thread of the PR (resolved ones are skipped; unresolving later places them, since placement is computed at read time from the current resolved state): the thread's own snapshot `(Bx, Hx)` comes from `threadCode.ts` as today and the server gathers its three diffs; the tracer runs with `ac = diff(Bx, B2)`, `bd = diff(Hx, H2)`, `cd = R`'s diff, per file with rename pairs. Output per thread: the placement, and for unplaced ones a fate: `deleted`, `rewritten`, `file-gone`, `moved` (candidate only when the interdiff's rename detection says so), `reverted`. Which commit did it is not computed this round (owner, 2026-11-07: deferred). A stored `thread-placed` for this patch set overrides the computed one after validation. `placeThreads` in the page (`src/web/files/threadPlacement.ts`) receives already-traced anchors and stays the one place that decides where a thread shows.

### What each piece may never do

- The engine never writes `cluster-state`; it writes `carried` only.
- No carry without a byte-identical change at a traced position. No carry across an unavailable interdiff.
- No placement by text search; no placement that lands on a line whose text differs without `changed`.
- No hiding: every cluster of `R` is in the full diff, and every thread is reachable from either view (placed, listed under its file, or in the trailing group of threads outside the comparison).
- Determinism: same inputs, same output, for the same `TRACER_VERSION`; results are cached by OIDs and version.

## Server

Built on what exists: `Session` (`src/server/session.ts`) owns the snapshot and the progress; `ReviewService` (`src/server/review/reviews.ts`) writes events; `buildSnapshot` (`src/server/diff/snapshot.ts`) computes clusters and keys; `GET /head` already polls for a moved head every 5 minutes and on focus.

### What changes in the store

- `#startPatchset` hard-codes patch set 1 and `foldProgress` keeps only the latest `patchset-started`. Both become per patch set: `ProgressState` holds every patch set (number, snapshot id, merge base, head, `since`, `shape`) and a state map per snapshot id, since `cluster-state.patchset` already is the snapshot id. `buildReviewView` applies the map of the snapshot it is given, so an old patch set folds like the current one.
- `checkRevision` (409 `StaleSnapshotError`) stays the guard for writes against the current patch set; a write against an old patch set is refused the same way (read-only history), and a write against a newer snapshot is refused until Move has run.
- New thread and verdict call the same start-if-needed path as `recordStates` before their GitHub write, in one transaction with the `-base` ref; replies, resolves and unresolves don't.
- The last-seen head is a small JSON file per review under the server's state directory (`XDG_STATE_HOME/carbonless/seen/<review-id>.json`), written on every open.

### Routes (`/api/r/:id/`)

| Route | Answer | Notes |
| --- | --- | --- |
| `GET /session` (exists) | adds `patchsets[]` (number, head, merge base, started, shape, since), `lastSeen` | What the graph and the toast read; cheap, no engine work. |
| `GET /rereview?from=<ps>&to=<head>` | `{ shape, interdiff: available or unavailable+reason, files: [{ index, path, clusters: [{ key, kind: carried or reworked or new or gone, from? }] }], threads: [{ id, placement }] }` | The engine's answer for one pair, computed in the background on first ask and cached by `(from snapshot id, to head, TRACER_VERSION)`. Never awaited by the first page load: the page shows PS1 and polls this for the head connector's card and the to-read count. |
| First lasting action on a viewed head (states, a new thread, a verdict) | the new `ReviewView` | Not a route of its own: the action's route starts the patch set (n+1, since, shape), writes the two pin refs and the `carried` events, then the action's own event, in one transaction after the engine ran; a later action finds the patch set. |
| `GET /review?patchset=<n>` | `ReviewView` of that patch set | Old patch sets are read-only; the snapshot is rebuilt from the pinned OIDs (cached by snapshot id, as today). `GET /review?head=<oid>` is the viewed head before it is a patch set: no stored state, the engine's provisional carries overlaid by the page. |
| `GET /files/:index/hunks?revision=` (exists) | gains `from=<ps>` | With `from`, the hunks of the interdiff (`H1'` to `H2`), old lines as deletions, numbered on both sides; without it, the full diff as today. The since view is those hunks and nothing more. |
| `POST /threads/:id/placement { patchset, anchor }` | the thread re-placed | Writes `thread-placed`; validated against the patch set's snapshot first (400 otherwise). |

### Performance

- First open never waits for the engine. The head dot, its connector's commit count and the toast come from `GET /head` and git alone; the connector's card and the to-read count arrive when `GET /rereview` finishes, with a spinner in their slots until then (loading state, never an empty answer that reads as nothing changed). Everything loads in layers, each shown as soon as it is ready and none waiting for the next: the page and the rail's dots from the session alone; the head dot, the commit counts and the toast from git; the connector's card, the since view's hunks, the carried marks and the thread placements from the engine, each behind its own spinner. The interdiff never holds up the graph (owner, 2026-11-07).
- The engine runs one `merge-tree`, one `diff -M` for the interdiff and one `diff` per touched file for `bd`, `ac` and the threads' own `(Bx, Hx)` pairs; all through the existing `runGit` helpers, results cached in memory by OIDs and on disk beside the snapshot cache so a restart doesn't recompute.
- `GET /head` keeps its cadence but compares the triple (base branch name, merge base, head) instead of the head alone, so a retarget (S7) or a stacked parent landing (S8) shows the head dot and the toast while a base that merely moved on (S2) doesn't; the merge base is one local `merge-base` after the fetch the check already does. A change invalidates nothing already computed (keys are OIDs).
- Target: a 200-file PR's `rereview` answer within 2 s CPU on this machine, measured in a unit test with `process.threadCpuUsage` on the methodology fixture scaled up.

## UI

Everything lives in Files changed and the Final Verdict tab; the Overview is untouched except that thread cards there show the same changed chip and fate line, and a chip with the patch set the thread was opened on when it is known ("PS2": the patch set in whose window the thread was published, from its start to the next one's; older than PS1 counts as PS1; owner, 2026-11-07, deferrable to the end of step 5 if it costs more than that). Concise and icon-first: every chip and icon has a tooltip and an accessible name; colors are the existing tokens (green carried, yellow reworked or changed, red gone or conflict, violet for the comparison base marker). Mockups: next section. There is no banner any more: the graph and a toast carry what it said (owner, 2026-11-05).

### Patch set graph (replaces the banner, the switcher and the since/base toggle)

A horizontal rail in the Files changed header (owner, 2026-11-04): the base-branch dot first, labelled with the branch name and static even when the base moves later; one dot per patch set of the reviewer; then a last slot that is always present at one width: the text "up to date" when the head is the newest patch set, otherwise a dashed connector and a hollow, dashed head dot. Two markers sit on the rail: **viewing** (accent ring, label "viewing") and **comparison base** (violet ring, label "comparison base"; "comp. base" where a phone has no room), the base always left of the viewing one. The diff shown is always comparison base → viewing: on the branch dot the full diff, on an earlier patch set the interdiff from it (any earlier one, not only the previous). Nothing else labels what is compared: the markers say it. A stacked PR with more than one comparison base (the parent's head besides the base branch) is a later item (todo, owner 2026-11-07).

- **Connector label**: the commit count only ("3 commits"; the bare number on a phone).
- **Dot details** (hover; tap on a phone): the head commit and when it was made, the merge base it was reviewed against, when the review started, progress, the verdict given on it.
- **Connector details** (hover; tap): what happened between the two, from shape detection: commits and days, merges from the base, rebased or force-pushed, conflicts, retargeted, and the files and clusters to read once the engine has answered (a spinner in that slot until then). One line by shape, the former banner's: "3 new commits · 2 files, 5 clusters to read", "Rebased, nothing new", "Rebased, 2 files had conflicts", "Base merged in, nothing new", "Squashed, nothing new", "Head moved back: 4 reviewed clusters gone", "Retargeted to `main`". The dashed connector takes the shape's color: yellow for something to read, green for nothing new, red for conflicts or removals.
- **Moving the markers**: drag (on a phone too; tap is details, drag is move). Keyboard: qualified keys only, so a marker never moves by accident (owner, 2026-11-07): Ctrl+`[` and Ctrl+`]` move the viewing marker, with Shift added the comparison base.
- **Comparison base rule when the viewing marker moves**: on the branch dot it stays; on the previous patch set it follows by one (it stays "the previous"); anywhere else it is remembered as that patch set.
- **Viewing the head** (drag the viewing marker onto the head dot, or its details card's View, or the toast's View) shows the since view at once, computed by the engine, with provisional carried marks and the progress bar counting them; nothing is stored. The first mark, new thread or verdict starts the patch set, and the head dot becomes a patch set dot.
- **An old patch set** opens read-only with an "as reviewed" chip; marks are locked, replies still send. Its threads are those published before the next patch set started (the as-of machinery, cutoff = the next `patchset-started` time; the current patch set has no cutoff), all of them placed, resolved ones with a resolved chip, since GitHub keeps no history of resolved state. Files changed stops filtering threads to the viewed head (`threadsOnHead`): placement replaces it, which also closes the todo item on threads from earlier commits.
- **Phone**: the rail scrolls sideways if it must; dots and markers are 40px targets; details open as a bottom sheet with View and Compare from here as a fallback for drag.

### New commits arriving (replaces `HeadBanner.tsx`)

When `GET /head` reports a newer head, exactly two things change: the rail's last slot swaps "up to date" for the dashed connector and the head dot (same width, so nothing below the rail moves and the reviewer's place in the diff holds), and a toast at the bottom says "3 new commits · `f9e8d7c`" with View (puts the viewing marker on the head dot) and a dismiss; it goes by itself after a while and never takes focus. The commit count comes from git at once; the connector's card fills when `GET /rereview` finishes. `--head` pinned views and a PR GitHub reports merged or closed show neither the head dot nor the toast (today's banner rules move here; a landed head's three-dot diff is empty, not a removal; `docs/git-methodology.md`).

### Since view and full diff

The diff shown is comparison base → viewing, plain, like any diff: old lines red, new lines green, both sides numbered (for an interdiff, `H1'` and `H2`). No band of old lines, no "from PS1" labels, no collapsed rows: the markers already say what is compared with what (owner, 2026-11-05). Chips say what happened to each cluster, and that is all:

- **Reworked cluster** (in the interdiff): its change was reviewed on PS1 and the author changed it; grey rail, unreviewed, chip "reworked".
- **New cluster** (in the interdiff): not in PS1; grey rail, chip "new".
- **Gone cluster**: a red-railed deletion block with chip "gone", not countable, not markable (it is not in the viewed patch set's diff), so vanished work is noticed.
- **Carried cluster**: not in the interdiff at all (the change is identical on both sides). In the full diff it is marked, green rail, chip "carried". Unticking it is a human `cluster-state` event, as any.
- **Conflicted file**: header chip "conflict" (tooltip: git could not rebase this file, so all of it is new to read), and nothing more: no conflict markers kept or shown (owner, 2026-11-07: a git conflict rarely reaches a review, so the minimum).
- **File header chips**: "1 reworked · 1 new · 4 carried" with the file's progress in the shown view; the file tree shows a yellow dot on files with anything to read and green on fully carried ones; a filter "needs eyes" in the tree hides fully carried files (never clusters).
- Empty since view: one line, "Nothing to read since PS1 · 41 carried".
- The progress bar counts the current patch set, in whichever unit; "needs eyes" is shown as a second number ("5 to read").

### Threads

`placeThreads` receives traced anchors (`anchor` already in the current snapshot's lines) and a `placement` per thread: `placed`, `changed`, `unplaced(fate)`. A changed thread's card shows a yellow "changed since" chip, the old lines from its own snapshot inside the card above the new ones (its existing code pane, cut to the range), and a fate line, "Line rewritten since PS1", with "See on PS1" (not "rewritten in `c0ffee1` · \<commit subject>": which commit did it is deferred, owner 2026-11-07, here and elsewhere). Unplaced threads whose file is in the comparison list under that file's header, fate first (deleted, with no `<sha>` this round, rewritten, moved? to `<path>`, reverted), every row showing the commented lines inline, highlighted, with two lines of context either side from the thread's patch set, labelled with that patch set, path and line numbers (the thread is readable without opening it; mockup 4), and a "near line N" link to the nearest surviving line. Unplaced threads whose file is not in the comparison at all (deleted, or renamed away with the line gone, in this or any earlier patch set) list in a trailing group, "Not in this comparison", with the original path and "file deleted" (neither the commit nor the patch set that removed it: deferred); the group exists on every later patch set until the thread is resolved, like GitHub's outdated comments, so an unresolved thread never disappears with its file. A rename with the line intact carries the thread to the new path like any move. Resolved threads are not placed; unresolving on GitHub places them on the next read.

### Final Verdict

Above the buttons: "You approved `a1b2c3d` (PS1), 2 days ago" and "Since then: 3 commits · 2 files · 1 reworked, 1 new cluster" with PS2's progress meter; the verdict goes on the current patch set's head as today. For an identical diff after a rebase or squash: "Rebased, same diff · nothing to re-read" and "Approve again on `0c1d2e3`". Nothing is gated.

### Keyboard and phone

`m` views the new head: dropped (owner, 2026-11-07: too destructive to happen by accident); the head is reached with Ctrl+] past the newest patch set, the same deliberate move as dragging there, and Ctrl+[ brings you back. Qualified keys only: Ctrl+`[` and `]` move the viewing marker, Ctrl+Shift+`[` and Ctrl+Shift+`]` the comparison base; all in the `?` help. On a phone the toast spans the bottom with a 40px View, dot and connector details are a sheet, chips wrap under the path in the file header, and every row is 40px.

## Mockups

[Re-review Mockups](https://claude.ai/artifact/WixND7ZrR3EMTAHAqMR7iL): six slices of Files changed, desktop and phone, in the app's own tokens.

1. **Patch set graph**: the rail with the base dot, your patch sets and the head dot; the viewing and comparison base markers; connectors with their commit count; a connector's hover card; the phone version (tap for details, drag to move).
2. **New commits arrive**: the rail's last slot saying "up to date", then the same rail after a push with the head dot in that slot and the toast; the dots do not move.
3. **Since view**: one file as the plain interdiff from PS1, a reworked cluster and a new one, each with its chip; header chips; notes on the empty view, gone clusters, conflicts and the full diff.
4. **Threads**: a changed thread's card with old and new lines and its fate line; the unplaced list under a file header with fates (deleted, moved?); the trailing "Not in this comparison" group for a thread whose file was deleted two patch sets earlier.
5. **Final Verdict**: what you approved and what changed since, with PS2's meter; the identical-diff case with "Approve again".
6. **Going back**: PS1 opened read-only as reviewed, marks locked, "Back to PS2".

## Flows

### Returning after a push (S1)

1. The reviewer opens the PR. The page loads on `PS1` as today (first open stays fast: nothing new is computed before the page shows). The rail shows PS1 with the viewing marker and, in its last slot, a dashed "3 commits" connector to the head dot; a toast says "3 new commits" when the head moved since the reviewer last looked; the server starts computing the shape, the interdiff and the placements in the background, and the connector's card fills when it is done.
2. View (the toast's, or dragging the viewing marker onto the head dot): the page lands on the since view of the head, the comparison base on PS1, computed by the engine, carried marks provisional, nothing written. The first mark (or new thread, or verdict) starts PS2: the server writes `patchset-started` (since PS1, shape S1), the pin refs, one `carried` event per rule and the mark, in one transaction. The since view: the interdiff's clusters with their reworked and new chips, changed and unplaced threads listed. The progress bar counts PS2.
3. The reviewer reads the delta, marks what they read, replies where needed, and gives a verdict on PS2's head.

### A trivial rebase (S4a) or squash (S5)

The head connector's card says "rebased, nothing new" (or "squashed, nothing new") and the connector is green; viewing the head shows an empty since view with a line saying so (everything carries, provisionally until the first action); the full diff is one drag of the comparison base away. The verdict tab offers to re-approve on the new head, saying the diff is identical.

### A rebase with conflicts (S4b)

The head connector is red and its card says "rebased, 2 files had conflicts". After viewing the head, those files are open in the since view, each cluster of the author's resolution new; the thread cards of threads in those files show their code as commented plus the fate. Clusters outside the conflicted files carry as usual.

### Going back

The graph shows the base dot, PS1, PS2 and the head dot when newer. Dragging the viewed marker to PS1 opens it read-only as reviewed: its diff, its marks, its threads placed as then (stored placements of PS1 apply; computed ones are recomputed from the same inputs, which are pinned, so they come out the same). Marks can't be changed on an old patch set; a reply can still be sent (it is a reply on GitHub, not a mark).

### Several patch sets

On PS3 the comparison base, having been on the previous patch set, follows to PS2; dragging it to PS1 gives "since PS1" (the interdiff `H1'` to `H3`), onto the branch dot the full diff. Carry on starting PS3 consulted PS2 first, then PS1, so a cluster reverted to PS1's content (P8) arrives carried with `from: 1`.

### Threads

A thread opened on PS1 whose line the author edited shows on PS2 at the new line with a "changed" chip; its card shows the old lines beside the new ones (X2). A thread whose line was deleted is listed under its file's header with "deleted in `a1b2c3`" and a link to the nearest surviving line (X1). Resolving it on GitHub removes it from placement on the next read; unresolving brings it back. A thread on a file deleted in PS2 is listed under "Not in this comparison" on PS3, PS4 and every later patch set, in both views, until it is resolved: the file is absent from the diff, so there is no header to hang it under, and the comparison base being PS3 does not make the deletion a change of this comparison.

## Tests and gallery

Each fails without the feature; timing-sensitive ones go through `pnpm flake-check`.

### Unit

- **Tracer** (`src/shared/tracer/*.test.ts`): one case per C1 to C19 with hand-written hunks; a property test with fast-check over random edit scripts: every traced position is a line of the new text with the same content, or `changed` with the old content, or `unplaced` with a reason; a position is never silently dropped and never lands on different text unmarked; `LineMapper` round-trips `oldToNew` and `newToOld` on untouched lines.
- **Shape** (`shape.test.ts`): S1 to S9 on throwaway repos (`test/git-fixture.ts`), plus merge-tree failures (unrelated histories, a shallow clone).
- **Interdiff** (`interdiff.test.ts`): I1 to I10 on the same repos; the two probes of 2026-11-02 become tests.
- **Carry** (`carry.test.ts`): P1 to P12; the fail-closed property: for random edits between two snapshots, every carried cluster's removed and added lines equal the source's; a corrupted `carried` event (wrong key, non-human source, missing source) never marks anything; crossed off carries by the same rule.
- **Store** (`events.test.ts`, `fold.test.ts`, `reviews.test.ts`): `carried` and `thread-placed` parse and validate; `by: auto` refused on `cluster-state`; folding several patch sets; old patch sets read-only; the `-base` ref written in the same transaction and read back after `gc --prune=now` with the base branch rewritten; a new thread and a verdict each start a patch set, a reply, resolve or unresolve never does; viewing an earlier patch set's head shows it; the storage size of a 200-cluster move measured and asserted under a budget.
- **Placement** (`placement.test.ts`): threads on `Hx` with every fate, resolved threads skipped, a stored `thread-placed` overriding and a stale one failing closed.
- **Methodology matrix** (`test/methodology-fixture.ts`): `UPDATES` grows `rebase-amend`, `merge-base-in-conflict` and `stacked-squash` (a parent PR squashed into the base, the child rebased); every permutation asserts the shape, the interdiff and the carry through `Session.open`, Move and a fresh open; `e2e/methodology.spec.ts` follows.

### End to end (`e2e/rereview.spec.ts`, desktop and phone)

The fixtures gain `forceHead(commit)` beside `moveHead` (rewrites `refs/pull/<n>/head` to a non-descendant and adds the force-push event to the scenario). Specs: a newer head puts the head dot in the rail's last slot and shows the toast without moving any element below the rail (positions asserted before and after) and without taking focus; the connector card's shapes and its loading state (the engine held, then released); View from the toast and dragging the viewing marker onto the head dot both land on the since view with exactly the reworked and new clusters, carried ones absent from it and marked in the full diff, writing nothing; the first mark starts the patch set with the carries; unticking a carried cluster; a reworked cluster's old lines as deletions; a gone cluster; dragging the viewing marker to PS1 opens it read-only with its marks and placements; the comparison base's follow and stay rules; the full diff and the since view share state; changed and unplaced threads with fates; a thread of a file deleted two patch sets earlier listed under "Not in this comparison"; resolve then unresolve; the verdict tab's since line and re-approve; `--head` views show neither the head dot nor the toast.

### Gallery (Gilthans/carbonless-gallery)

The five cases from the discussion doc (`rr-append`, `rr-rebase`, `rr-merge-in`, `rr-moves`, `rr-stacked`), each with a README row, a description of what to look at per patch set, and a seeding script (`scripts/gallery/rr-<case>.sh`) that opens the PR pinned on the first head, marks and crosses off the listed clusters, posts the listed comments through carbonless, then pushes the next head. Comments by a second account (C10) stay test-only unless the owner has one.

### Real PR

`pnpm compare-threads` on gytpol/active-directory-domain-agent#48, the PR the owner reviewed most recently there (owner, 2026-11-07), read-only. They reviewed it in two rounds on two heads (`8dcc4b2` on 2026-11-04, `6321536` on 2026-11-05; 14 commits, 30 files, 38 line comments), so it is a real re-review: open it as of the end of the first round, then as of the second, and compare every placed thread's line with GitHub's `line`, listing disagreements (C19). Its code and data stay in the scratchpad, never in the repo.

## Delivery

One PR per step on Gilthans/carbonless, each with its brief, a fresh review and `pnpm verify` green. The owner is stopped only for something visual (owner, 2026-11-07): steps 1 to 3 have no UI and merge after the fresh review and a green verify without waiting; steps 4 to 6 each end with a branch instance and a demo to look at, and the owner's word merges them. The demo is the gallery: the five rr-* cases seeded with patch sets, plus one showcase PR that goes through append, rebase and merge-in in order, with comments and marks at each step, so there is always a good re-review to walk through.

1. **Tracer library** (`src/shared/tracer/`): mappers, trace, ranges, spans, the C1 to C19 table tests and the property test. No server or UI change.
2. **Storage**: a new thread and a verdict start a patch set; `-base` pin refs; `carried` and `thread-placed` events with their write rules and fold; last-seen head; storage doc updated and the size measured.
3. **Shape, interdiff and carry** on the server, with the methodology matrix grown by rebase-with-amend, conflicting merge-base-in and stacked-squash shapes, asserting I1 to I10 and P1 to P12. The start-on-first-action path, with no UI yet.
4. **Files changed: the patch set graph with its up-to-date slot and the toast, carried marks, the since view** (desktop and phone), gallery cases `rr-append` and `rr-rebase`.
5. **Thread placement**: the engine's placements through `placeThreads`, changed and unplaced threads with fates, the unplaced list, resolved-only skipping; gallery cases `rr-merge-in` and `rr-moves`.
6. **Verdict tab**: what changed since your verdict, re-approve on an identical diff; gallery case `rr-stacked`; the real-PR check.

### Builder's calls

- Exact route shapes and cache keys, within the rules in Server.
- How the interdiff's hunks reach the page (the `from` parameter on the hunks route as written, or a route of its own), within the rules in Server.
- The wording of the connector cards and the toast, within the concise, icon-first rule; how long the toast stays.

### Open questions (owner)

- [x] Landmarks for other people's comment heads: deferred to a later round (owner, 2026-11-04).
- [x] Should an old patch set allow new marks (editing history) or stay read-only, as designed here? Read-only (owner, 2026-11-07: acceptable at this phase).
- [x] Calls made after the builder check, say if any is wrong: a reply, resolve or unresolve never starts a patch set (only a new thread, a verdict or a mark does); viewing an earlier patch set's head shows that patch set; an untick is never undone by an older patch set's mark; an old patch set shows the threads published before the next one started, resolved ones included; no Move on a merged or closed PR; the head poll also watches the base branch name and the merge base.
- [x] Once sync lands, should `thread-placed` be shared through `meta` so other reviewers see a dragged thread where you put it? Yes, and only manual placements and moves (owner, 2026-11-07), which is exactly what the event holds: computed placements are never written.
