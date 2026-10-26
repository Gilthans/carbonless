# PR review parity: design

Status: approved · 2026-10-23

This milestone lets you open a GitHub PR in carbonless and review it cluster by cluster, with clear progress. It's read-only, with no AI.

## Why

The goal is to replace the reviewer's current GitHub PR review workflow with carbonless. The AI features in `docs/todo.md` (grouping changes, moved code, background investigations) all build on a diff view where the reviewer tracks what they have reviewed. This milestone builds that foundation: open a GitHub PR and go through it the way the reviewer does on GitHub today, with better progress tracking and per-cluster review instead of per-file "Viewed" checkboxes.

There is no AI in this milestone.

The reference PR used throughout is `gytpol/active-directory-domain-agent#27` (24 files, +1580 / −8, 39 clusters, 6 CI checks, 12 review threads from a bot). It is work code from a different organization: point the tool at it, never copy any of it into this repo, its tests or its fixtures.

## The reviewer's workflow (what we're matching)

1. Read the author's description of what the PR does.
2. Check whether another human already started reviewing, to avoid wasted or overlapping work.
3. Check the PR is ready for review: CI checks passing, no unresolved or unanswered review threads (from AI bots or humans).
4. Open "Files changed". Scan the file list for the lay of the land. Cross off the easy files (generated, rename-only). Find the most basic change that the rest builds on, review it, then work up the dependency order. Unit tests right after the code they test, integration tests at the end. Load extra context lines around changes often.
5. Watch progress throughout: number of files finished, and ideally lines too.

## Goals

- `crb <PR>` opens a PR in the browser, read-only.
- A **PR overview** answers steps 1–3 at a glance.
- A **Files changed** view shows the diff like GitHub does, with review tracked per **cluster**, prominent progress, and loading more context lines.
- Review state persists across restarts and is pinned to one PR commit; new commits on the PR only raise a warning.

## Non-goals (this milestone)

- Any AI feature.
- Writing to GitHub: no comments, approvals or resolving threads. The reviewer still does those on GitHub.
- Showing existing review comments inside the diff (they appear in the overview's readiness section only).
- Split (side-by-side) diff view. Unified only.
- Splitting a cluster into smaller clusters (planned next, see below).
- Comparison baselines other than GitHub's (merge base → PR head). The reviewer wants to revisit this later.
- Comparing two arbitrary local commits (dropped from the seed for now).
- Hiding whitespace-only changes.
- Syncing review data with the remote: review refs stay in carbonless's private clone.

## Anti-goals

These would make the milestone a failure even if everything else works:

- Any path by which a changed line can be finished without the reviewer explicitly acting on it. See "Coverage invariant".
- Touching the reviewer's own working copies of any repo.
- Exposing PR code or GitHub data to the network without protection.

## Concepts

**Cluster.** Short for change cluster: a maximal run of changed lines with no unchanged line in between: a deletion, an addition, or a deletion directly followed by an addition. These are exactly the hunks of `git diff -U0`. All files' clusters come from one whole-diff `-U0` patch, split by its `diff --git` headers, so renames pair exactly as in the file listing; each file's parsed lines must equal its `--numstat` counts taken with the same options and zero context (git can count a change differently with context, e.g. around blank lines), and every listed file must get exactly one section, or the snapshot fails. A cluster is the unit of review. This is deliberately *not* called a "hunk": a GitHub/git hunk includes 3 lines of context and merges changes up to ~6 lines apart, so one hunk can contain several clusters (`Program.cs` in the reference PR has 4 hunks and 5 clusters). Use "cluster" in the UI and the code.

**File-level clusters.** Some file changes have no changed lines: a pure rename, a mode change, a binary file, an empty file added or removed, a submodule pointer bump. Each of these gets one synthetic cluster (for example "Renamed from `a/x.cs`", "Binary file changed" or "Submodule `lib` moved `abc1234` → `def5678`"), so it can't slip by unacknowledged (confirmed by the reviewer). A renamed file with edits has its line clusters plus the rename cluster. *(Builder's call on exact labels.)*

**Cluster state.** Each cluster is in exactly one state:

- *unreviewed*: the default, and the only state a cluster ever starts in.
- *reviewed*: the reviewer checked it.
- *crossed off*: the reviewer chose not to review it. A short reason is optional (the UI no longer asks for one; see `2026-10-24-files-view-ux-and-mobile.md`).

A file is *done* when every one of its clusters is reviewed or crossed off. Only an explicit reviewer action changes a cluster's state. Actions on several clusters at once ("Mark remaining reviewed", "Cross off file…") are allowed because the reviewer explicitly takes them.

## Coverage invariant

From CLAUDE.md principle 2, enforced in code and tests:

- The set of clusters is computed only from the git diff, never from anything else.
- Everything that shows progress or "done" is computed from that set plus the stored states, joined so that **any cluster without a stored state counts as unreviewed**. No code path counts a stored state that has no matching cluster.
- Tests cover at least: a stored state for a cluster that no longer exists is ignored; renames, binary, mode-only, empty file add/delete and submodule bumps each produce a cluster.

## Opening a PR

```
crb https://github.com/<owner>/<repo>/pull/<n>
crb <owner>/<repo>#<n>
crb <n>                        # inside a clone; repo taken from its GitHub remote
```

- All GitHub access goes through the `gh` CLI using the reviewer's existing login. carbonless never stores a token. If `gh` is missing or logged out, fail with a clear message.
- The seed's local two-commit mode (`carbonless [repo] [base] [head]`) is **removed** to keep this milestone minimal (reviewer's decision). PRs are the only input for now.

### Private clones

carbonless keeps its own clone of each repo and never touches the reviewer's working copies.

- Location: `$XDG_CACHE_HOME/carbonless/repos/<owner>/<repo>.git` (default `~/.cache/...`). Bare clones: nothing is checked out.
- First open: `gh repo clone <owner>/<repo> <path> -- --bare` (or equivalent). Later opens: fetch only.
- Each open fetches the PR's base branch and `refs/pull/<n>/head`, and uses the PR head by commit ID. Once a review has a snapshot, its `patchsets/<n>` ref keeps that commit alive. Without a ref, nothing would point at the old commit after a force-push, and `git gc` could delete it. The PR ref also works for PRs from forks.
- The comparison is merge base of (base branch, PR head) → PR head, the same as GitHub's "Files changed".
- Worktrees are not needed in this milestone (reading a diff only needs history). When later features need files on disk, they go under `$XDG_CACHE_HOME/carbonless/worktrees/`.
- Concurrency: two carbonless processes opening the same repo must not corrupt the clone. A simple lock file around clone/fetch is enough.

### Pinned commit and PR updates

A review is pinned to one snapshot of the PR (a patch set, see "Review state storage"), fixed at the reviewer's first check-off. Until then it shows the PR's current head. carbonless checks whether the PR moved when the server starts, when the reviewer presses Refresh, and every 5 minutes while the page is open *(Claude's call on timing)*. If the head moved past the snapshot, a warning banner says so and links to the PR. Nothing else changes: the diff, clusters and progress stay on the snapshot. There is no way to move to the new head in this milestone. Refresh also reloads the PR overview data (checks, reviews, threads).

## PR overview page

Shown first. Read-only. Data from `gh` (`gh pr view --json …` and `gh api graphql` for review threads, which is the only way to get `isResolved`).

The page never waits for the review threads, the slow part of a read (`src/server/overviewRead.ts`). A read of GitHub starts with crb (and on Refresh) and comes in parts: the overview (`GET /api/overview`: the PR, description, reviews, comments, checks; a few calls at once, well under a second), then the threads (`GET /api/threads?read=<readId>&stage=…`): every thread's summary first (all a list needs: grouping, order, exact counts, each card's header and anchor; about 1.5 s for 100), then the opening comments' text by thread id (`nodes(ids:)`, 50 a query, all at once), the threads each list shows first and one "Load more" page ahead (`THREADS_FIRST`), then the rest, and each thread's code from the clone, those first ahead. The page asks for every stage (`summary`, `first`, `firstCode`, `full`) at once and shows the furthest in: until the summaries are in, each thread list shows its frame; a card whose text or code is still on its way shows grey bars in its place (`loaded`, code `source: "pending"`). Counts are the summaries', so "Load X more … out of Y" is exact from the start; a card loaded past them shows its frame until its text arrives. A stage that fails says so in the list, keeping what came. Threads read in pages of 100 have their first and last pages read together; they are joined only when they overlap (same ids), so up to 199 threads take one round trip. The server keeps its last read (`?maxAge=<ms>` asks for one at most that old, counted from when its overview came in) and a few before it, so a page still showing an older read gets its threads (a read it no longer keeps answers 410 and the page reads the overview again). Each answer carries the server's `servedAt` beside `fetchedAt`, so the page judges age by the server's clock: one older than 15 s is read again meanwhile, whole (overview and threads), the header's Refresh icon spinning while it stays pressable; pressing it cancels the re-read and reads anew (never as of a cutoff, where nothing changes). Every gh read has a 60 s limit. While the overview's first read runs, the sections show their frames. A thread GitHub no longer has when its text is read (deleted since the list was read: GitHub answers with data and a NOT_FOUND error, and gh exits 1, which carbonless takes as the answer) says "Deleted on GitHub" on its card; one GitHub gave no usable id says "Couldn't be read from GitHub", and the list says how many; neither stays a frame. After a Refresh the previous read's threads stay in place, marked busy, until the new read's summaries land. A frame tells screen readers "Loading…". Closing a session (crb's shutdown) stops its background gh and git calls and waits until none runs.

1. **What it does:** title, number, author, base ← head branches, draft badge, created/updated times, link to GitHub, and the description rendered as GitHub-flavored Markdown. Sanitize the rendered HTML: the description is untrusted.
2. **Who's on it:** requested reviewers (users and teams); submitted reviews with reviewer, state (approved / changes requested / commented) and time, latest per reviewer first; and recent commenters. Make it obvious at a glance whether any human already started. The reviewer's own activity (logged-in user from `gh api user`) is shown separately as "you" and doesn't count as someone else having started. *(Claude's call.)*
3. **Is it ready:** one "Checks" row of chips, each with a tooltip:
   - "Draft" when the PR is a draft;
   - merge conflicts: "No conflicts" (green), "Conflicts" (red) or "Conflicts unknown" (grey);
   - CI: "6/6 passing" when all pass, else separate "1 failing" (red), "2 pending" (yellow) and "3 passing" (green) chips. Pressing any CI chip opens the list of checks, failing first, then pending, then passing, each linking (http(s) only) to its details.
   - More readiness items join this row later.
   - Below the checks, **Human reviews** and **Bot reviews** subsections (a thread belongs to the group of its opening comment's author, `__typename == "Bot"` for bots). Each shows "N unresolved" and an "N resolved" toggle (`aria-pressed`) that swaps the list between the group's unresolved and resolved threads; it is disabled (still focusable for its tooltip) when it would lead to an empty list, and an empty list says so. Threads are sorted by last activity (latest comment), most recent first; review comments are dated by when they were published (GitHub's `publishedAt`, its review's submission), not written (`createdAt`, which a comment drafted in a pending review gets days earlier), so "opened", "updated", the order, "no reply" and as-of mode follow what others could see and when. A pending comment (the viewer's unsubmitted review: no `publishedAt`, `state` PENDING) isn't counted, and a thread it opens isn't listed; a submitted comment GitHub gives no `publishedAt` is dated by when it was written (`src/server/commentTime.ts`). The code pane alone stays at the writing time (the base branch as the author saw it). Threads are listed five at a time with a "Load X more comments out of Y" button (Y: threads not listed yet; X: the next five or fewer); the toggle starts the count over. Each subsection opens with a band (icon, title, chips). Each thread is a bordered card (layout in docs/design/README.md): a tinted header row "Unresolved thread by <author> · opened <time> · updated <time>" with its comment count, a "no reply" chip when nobody but the opener commented (unresolved threads only) and "outdated" when it is; then file:line (the line where it was written when GitHub has no current one, e.g. outdated), a link to that line in Files changed; then two panes, stacked on a phone: left, the code the first comment was written on, from carbonless's own clone: the comment's anchor (a source-neutral `CodeAnchor`: path, the commit the comment was made on, its range's sides and lines, its time; GitHub's original pair is one adapter, `src/server/overview.ts`) gives the PR's diff of that file at that commit (fetched by OID when a force-push dropped it) against its merge base with the snapshot's base, windowed (`CodeWindow`) to the range, marked, plus three rows before and after it, fewer at the file's edges; old/new line numbers; Shiki-highlighted; mono. The old side must be the one the comment saw: the merge base with the base branch as it stood at the comment's time (its last first-parent commit by then) must be the same commit (`docs/git-methodology.md`). Paths are taken literally (`--literal-pathspecs`), and it fails closed: any git failure, no merge base, an old side that isn't certain, a diff that isn't exactly one file (a renamed file is diffed against its old path, paired as the whole diff pairs it), a comment on a rename's old path alone, a range whose start or end isn't there, or an empty diff where the blobs differ means no code from the clone. Then GitHub's own `diffHunk` is the fallback, marked `source: "github"` (it ends at the commented line: rows before the range only; a range it doesn't hold marks its last line). GitHub sometimes keeps no hunk for a line comment; with neither, a range wholly on the new side takes the snapshot's merge base alone, else there is no code pane. A comment made in GitHub's "changes since" or single-commit view carries that view's hunk; the pane still shows the PR's diff, so its context can differ from GitHub's while the commented lines match. Such a pane has a red "different snapshot" chip in the card header: `CodeWindow.snapshot` (`snapshotOf`, `docs/faq.md`) is `same` only when GitHub's hunk is a run of the rebuilt diff, row for row, holding the range, or the pane is that hunk itself; anything else, no hunk included, is flagged, and the code then waits for the comment's text (its hunk) before it is sent. Everything git answers is cached for the session (commits, merge bases and diffs don't change; a Refresh only retries what failed), eight threads at a time. right, the first comment as GitHub renders it (sanitized), clipped to about six lines with a fade. One show more / show less toggle opens both panes: the code then wraps, up to about 24 lines tall (it scrolls inside itself, never the window, to the commented range, which stays marked: centred, or its start at the top when it is longer than the pane; clipped, seven rows show). file:line is the marked line's number (the code is of the commit the comment was made on), else the current line; a tooltip says where a carried-forward comment is now. The commented range is marked by an accent rail and a soft accent tint across each row. The file:line link (`/files?path=&line=&side=`, `files/landing.ts`) opens that file alone in Files changed, scrolls the line (the old file's number for `LEFT`) just below the sticky headers and highlights it with the same tint, which fades. The line is only trusted when it was numbered on the snapshot's head (the code's own commit is the head, or GitHub's current line with the snapshot at the PR's head, not outdated, not as of a cutoff); otherwise (`moved`), or when the line isn't shown in the diff, or the file isn't in it, the file opens at its top with a short hint (icon, text, tooltip), never silently. File-level comments (GitHub's `subjectType: FILE`) show the path only, no code pane. Suggested changes (```suggestion blocks) in the comment show as a "Suggested change" mini diff in the code pane's rendering (Shiki, invisibles, add/del tokens): the thread's commented lines on its side as deleted rows, numbered, and the suggestion's lines as added rows (none for an empty suggestion, which deletes the lines); several blocks per comment each in place. The text comes from the raw markdown (GraphQL `body`, exact), the placement from GitHub's `bodyHTML` (its `js-suggested-changes-blob` blocks). Anything that doesn't line up (block counts, a block nested in a quote or list, row counts, GitHub replacing other lines than the thread's) falls back to GitHub's HTML for the whole comment: nothing is dropped. Read-only: no "apply". Only the opening comment is shown, so a suggestion in a reply shows on GitHub only; outdated and as-of threads use the code the comment was written on.

4. **Timeline:** the PR's history, oldest at the top, like GitHub's conversation view: a rail with a node per event (its kind's icon, named in a tooltip). Read with each overview read as its own part, at once with the rest (`GET /api/timeline?read=<readId>`): one GraphQL `timelineItems` query (commits, reviews with their review comments, conversation comments, force-pushes, base changes, ready for review / draft, merged, closed, reopened), 100 a page; the first page gives the count (`filteredCount`) and the rest are read at once by position (`skip`). The pages must agree on the count, or they are read again; a second disagreement is an error, never a timeline with a hole. Pages that agree but list fewer items than counted are kept, with a gap saying so (GitHub lists at most 250 of a PR's commits; its `filteredCount` was seen to count only what it lists). A Refresh's background re-read doesn't wait for the timeline: the previous one stays, busy, until the new one lands. It has its own skeleton and error, never holds back the header or the threads, and stops with the session (60 s gh limit). Grouping (`src/server/timeline.ts`): every item by its own time (a commit's push time if GitHub knows it, else its commit time; a review comment's publication, i.e. its review's submission (else, unreported, its writing), as the threads count it, so a review's comments land together with it; a review's submission), equal times and undated items in GitHub's order. Consecutive commits by one author make one run; consecutive review activity by one person (submitted reviews with a verdict or text, review comments, replies, conversation comments) makes another; another person or the other kind starts a new run. Bots are actors like anyone. A plain reply (a COMMENTED review with no text) is its comment alone; a pending (unsubmitted) review isn't shown. History facts stand alone. Each event: avatar and login (bot icon), "N commits" / "N comments", a review run's verdicts (approved green, changes requested red, dismissed), "from X to Y" (both relative times, the exact time on hover or focus; one time for a single item), and a 40px chevron ("Show N commits" / "Show N comments", `aria-expanded`) opening its items: a commit's short SHA (linking to it in the PR on GitHub: carbonless shows the snapshot's diff, not single commits), headline and time; a review comment's thread state, file:line (into Files changed, as on its thread card), first line and time, and "Go to the thread", which opens the right list (resolved or not), enough of it, and scrolls to and focuses the card; a review or conversation comment's first line, time and GitHub link. A review run also shows "R of N resolved": the distinct threads its comments are in (opener and replies count once) that are resolved now (as of a cutoff resolution isn't known: a neutral grey "N threads" chip instead, its tooltip saying so, and the opened comments' thread icons neutral too); comments whose thread isn't among those read don't count. The review comments' threads come from comment ids in the thread summaries. Runs start closed; past 30 events, the latest 30 show under a "Show N earlier events" button. What GitHub doesn't list in full (a PR's commits past 250, a review's comments past 100) is said above the rail. As of a cutoff, only items at or before it.

Section headings are centered, letter-spaced labels on a raised band.
5. A clear way into "Files changed", with the overall progress shown, centered at the bottom.

### As-of mode (hidden dev flags)

`crb <pr> --as-of <ISO time with zone> [--viewer <login>]` shows the PR as it was at a past moment, for testing the overview against a real PR's history. Neither flag is in `crb -h`.

- `--viewer` replaces the gh login for "you" detection on the overview, so the reviewer's own reviews show as a third party's. Review refs still use the gh login's slug.
- **Head:** the commit of the latest event at or before the cutoff, where events are the PR's reviews (`submittedAt`, with the commit they were made on) and its commits (`pushedDate`, else `committedDate`; GitHub no longer reports pushes, so `committedDate` stands in for the push time). On a tie the review wins, so a cutoff equal to a review's time gives the commit that review was on. It is fetched by OID when `refs/pull/<n>/head` has moved past it or force-pushed it away; if GitHub can't serve it, crb fails clearly.
- **Base:** merge-base(base tip at the cutoff, head), where the base tip at the cutoff is `git rev-list -1 --first-parent --before=<cutoff> origin/<base>`.
- **Overview:** reviews, comments and threads made (review comments: published) at or before the cutoff only, so a comment drafted before it in a review submitted after it isn't shown (a thread counts if its first comment does; only comments by then count toward its comment count and reply detection). GitHub keeps no resolution history, so every included thread shows unresolved and the resolved count is 0, with a tooltip saying resolution history is unknown; threads sort by their last comment by then; mergeability is unknown; the PR shows open; "updated" is the last activity by then. Checks are the snapshot head's `statusCheckRollup`: contexts started after the cutoff are left out, those finished after it show pending. The timeline shows only items at or before the cutoff; a review run shows a neutral "N threads" chip in place of "R of N resolved". The header shows "as of <date>" with a tooltip saying what can't be known.
- No "already merged" refusal, no "new commits" banner, and Refresh / the head check never move the snapshot.
- **Isolation:** the review's lookup key gets `@<cutoff>` (see `docs/review-data-storage.md`), so as-of mode has its own review and patch set refs and never touches the PR's real review.

## Files changed view

> Revised by `2026-10-24-files-view-ux-and-mobile.md`: one progress bar with a
> Lines / Clusters / Files unit selector, no crossed-off legend line, cross off
> without a reason (per file or per cluster), and mobile layout. In files, a
> file counts as reviewed only when all its clusters are reviewed; a done file
> with any crossed-off cluster counts as crossed off.

### Layout

- **Progress bar across the top** (mockup option A, revised):
  - Two bars side by side: **Clusters** and **Lines** (lines = added + deleted lines in the cluster).
  - Reviewed fills from the left (green). Crossed off sits at the right end (hatched purple). The space between is what's left.
  - The percentage is `reviewed ÷ (total − crossed off)`. Crossing off shrinks the work left, but never counts as reviewing.
  - Legend line: what's left (clusters, lines, files) and what was crossed off without review (clusters, lines, files).
  - The bar stays visible while scrolling.
- **File list on the left**, as a folder tree like GitHub's. Each file shows its status (not started / partly done / done / crossed off, where crossed-off names are struck through with the reason as a tag), clusters done out of total, and +/− counts. Clicking a file scrolls to it. The file currently in view is highlighted.
- **Diffs on the right**, one after another in GitHub's file order. Each file header shows: path (old → new for renames), +/−, "N of M clusters reviewed", "Cross off file…", "Mark remaining reviewed", and collapse/expand. Every file starts collapsed and the reviewer opens each one, which keeps very large PRs (especially with generated files) manageable. Collapsing is only a view setting and never changes review state.

### Diff rendering

- Unified diff with old and new line numbers, add/delete backgrounds, `@@` hunk header rows, and 3 context lines like GitHub.
- Syntax highlighting per file language. The reference PR needs C#, XML (`.wxs`, `.wxl`, `.csproj`), PowerShell and Markdown. Unknown types (like `.sln`) render as plain text. *(Library: Shiki, confirmed by the reviewer.)*
- **Cluster marking**: a colored rail down the left of each cluster (grey unreviewed, green reviewed, purple crossed off, blue for the cluster in focus) with a checkbox on its first line. Reviewed clusters are dimmed, never hidden.
- **Loading more lines**, as on GitHub: the row between two hunks has ↓ (20 lines below the previous hunk) and ↑ (20 lines above the next), or a single ↕ that fills the gap when it's ≤ 20 lines. Similar ↑ at the top and ↓ at the bottom of each file. Lines come from the server (`git show <sha>:<path>`). Loaded lines are context only. They don't change clusters or progress.
- Very large files: no special handling, since every file starts collapsed. Virtualization only if performance turns out to need it (the reviewer expects it won't).

### Review state storage

Review state is stored as append-only events in git refs under `refs/crb/`, inside carbonless's private clone. The full design is `docs/review-data-storage.md`, with the principles behind it in `docs/gitdb-design-principles.md`. This milestone builds the subset below.

**In this milestone:**

- **Refs per review:** `meta` (review created or closed), `reviewers/<slug>/progress` (the reviewer's patch sets and cluster states), `reviewers/<slug>/patchsets/<n>` (keeps each patch set's head commit alive, so `git gc` can't delete it after a force-push), plus `refs/crb/lookup/github-pr/<hash>` to find a PR's review by its PR number (reviewer's decision). Each review records its source, so other sources (such as ad hoc reviews without `gh`) can be added later without changing the format.
- **Patch set:** the snapshot a review is on. It's fixed at the reviewer's first check-off. Until then, the review shows the PR's current head (reviewer's decision).
- **Events:** one JSON object per action. Each commit has the empty tree and a message made of a short human summary line, then one JSON event per line. Types: `review-created`, `review-closed`, `patchset-started`, `cluster-state`. Only `by: "human"` events can set a cluster's state.
- **Writing:** one commit per event, written right away. Refs are updated with compare-and-swap. Author and committer are set explicitly to the reviewer's slug and a fixed tool identity, never the reviewer's real email.
- **Reading:** replay the reviewer's own progress ref (drop duplicate IDs, sort by time, the last event per cluster wins), cached by the ref's tip.

**Not in this milestone** (reviewer's decision): syncing with the remote. Nothing is pushed, so there's no squash before push, no fetching of review refs, no "who else started" check from refs, and no compaction. The format stays ready for sync.

**Cluster identity** is the key of `cluster-state` events: the file path, the exact removed and added lines, and the 3 unchanged lines directly above and below (fewer at the start or end of a file), plus the rename, mode, binary or submodule details for file-level clusters. If two clusters in the same snapshot share an identity, an occurrence number (1st, 2nd, in file order) is added so each has its own key.

## Server and network

- Fastify server as in the seed. New API routes for the PR overview, the file and cluster list, context lines, review state reads and writes, and refresh. *(Builder's call on route shapes.)*
- Default bind is `127.0.0.1`. The reviewer often works on a remote dev box and views it from another device over Tailscale, so `--host <addr>` is supported. When bound to anything other than loopback, require a random per-launch access key in the URL (set as a cookie after the first load). Every API route checks it. The printed URL includes the key.

## Testing

- Unit tests (Vitest): cluster extraction from diffs (adds, deletes, replacements, adjacent vs separated changes, renames, mode changes, binary, file add/delete, no trailing newline); progress math including the crossed-off rule; the coverage invariant cases above; GitHub data mapping (from recorded `gh` JSON that is **synthetic**, not copied from the work repo); access-key check; review storage as listed under Testing in docs/review-data-storage.md, minus sync and compaction.
- Playwright: against the built CLI with throwaway git repos. GitHub isn't reachable in tests, so `gh` is replaced by a fake executable on `PATH` that returns canned JSON and "clones" from a local fixture repo. Cover: overview sections render; checking a cluster updates file and overall progress; cross off with a reason; mark remaining reviewed; loading more lines; state persists across a restart; after a new commit on the PR head, a warning shows and the review stays on its snapshot; opening a PR without checking anything off creates no snapshot.
- Manual check before calling it done: open the reference PR and confirm 24 files, 39 clusters, and 1,588 changed lines.

## Next, not now

- Commenting from carbonless (the reviewer's next priority after this milestone), including showing existing review comments inline in the diff.
- Re-review after new pushes, a weak spot in GitHub (the priority after commenting). This milestone pins a review to one commit and only warns about new ones.
- Splitting a contiguous cluster into several clusters (reviewer-driven, then AI).
- Ordering files and clusters by dependency (base logic first, unit tests after their code, integration tests last). Likely part of task 1 in `docs/todo.md`.
- Other comparison baselines.
- Approving from carbonless.
- Syncing review refs with the remote, and compacting finished reviews.

## Decided by Claude, confirmed by the reviewer

- Storage locations (`~/.cache` for clones; review state lives in git refs inside the clone).
- Access key when bound off loopback.
- The reviewer's own GitHub activity shown separately as "you".
- Existing review comments only in the overview, not inline in the diff.
- Unified view only. No split view, no hide-whitespace.
