# Review threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every review thread shows its full conversation (Overview and Files changed), threads written on the viewed head appear inline in Files changed as highlighted lines plus a bubble, and each thread carries a server-computed attention set and a your-turn dot.

**Architecture:** The server keeps its staged thread read (`OverviewRead`): the summary stage gains the attention set and the thread's anchor; the content read widens from the opening comment to every comment and is served by a new `/api/comments` endpoint that answers from the eager background read or fetches requested ids at once. The web gets one shared conversation component and a comments hook; the Overview card and the Files diff both use them. Placement in the diff is one pure function (the seam for the next item: threads from earlier commits, and the LEFT-side discussion).

**Tech Stack:** Fastify + `gh api graphql` (src/server), React + TanStack Query + Tailwind tokens + `@primer/octicons-react` (src/web), Vitest, Playwright (desktop + phone projects), fake gh (`test/fake-gh`).

**Spec:** `docs/superpowers/specs/2026-10-26-pr-threads-design.md`

## Global Constraints

- Read-only: nothing writes to GitHub. Tests never call real `gh` (fake gh scenarios only).
- Threads never change review state or coverage; opening one changes no progress (principle 2).
- Viewer identity is a slug (`viewerSlug()`, `src/server/slug.ts` `slugify`); compare logins with `slugify` both sides, as `mapOverview` does.
- Bots never join an attention set and never count as the latest comment; pending comments neither join nor count, and are not in `commentCount`; resolved → empty set.
- As-of: only comments published by the cutoff; no pending comments shown; threads never resolved.
- Mobile: works at 360px with no horizontal page scroll; tap targets ≥ 40px; e2e in desktop and phone projects.
- Icon-first, short text; every icon has a tooltip and accessible name; colours from `src/web/index.css` tokens only (resolved = `ok`, your-turn dot = `warn`); new token pairs added to `src/web/theme.test.ts`.
- TanStack Query for every new fetch. Dates via `RelativeTime`. Untrusted HTML only through `GithubHtml`.
- First open is the target: the summary stage (thread list) must not get slower on the real PR; report before/after timings.
- Real-PR check: a real work PR as of (memory `real-pr-check`), read-only, data only in the scratchpad.
- Never one `gh` request per thread: comments are read in batches (≤ 50 threads per query, as `CONTENT_BATCH`).

## Review Focus

1. **A context row carries both an old and a new number.** A RIGHT thread on new line 40 must land on the row whose `newNo` is 40, never on the row whose `oldNo` is 40, and the same the other way for LEFT. Test: `placeThreads` "side picks the number column" (Task 4).
2. **Thread text in the diff table.** The diff table scrolls sideways on long lines, and a thread row inside it must stay at the visible width. Its text wraps to the viewport, and long code or images in comments scroll inside the thread. Test: the phone e2e "opened thread fits the viewport with a 300-char line" (Task 5).
3. **The read goes away (410) while comments are loading,** for example after Refresh. The comments query must follow the new read and never spin forever. Test: `commentsQuery` "a 410 refetches under the new readId" (Task 2).
4. **A thread deleted between the summary and the comment read** shows the "deleted" message, never an endless spinner. Test: server `comments()` maps GONE to `unavailable: "deleted"` (Task 1), and the Overview e2e with `deletedThreads` (Task 3).
5. **Files changed opened first,** from a deep link, before the Overview has ever loaded. Bubbles must still appear. Test: e2e "threads show when /files is the first page" (Task 5).

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | `ThreadComment`, `ThreadComments`, `CommentsView`; `ReviewThread` gains `anchor`, `attention`, `yourTurn` |
| `src/server/attention.ts` (new) | `attentionSet()`, pure |
| `src/server/overview.ts` | `mapThreads` takes a context (PR author, viewer) and fills the new fields; `mapComments()` |
| `src/server/gh.ts` | `latest` gains the author; `CONTENT_FIELDS` reads every comment; paging past 100 for authors and bodies |
| `src/server/overviewRead.ts` | summary awaits the PR author; `comments(ids)` (cache, in-flight dedup, on-demand fetch) |
| `src/server/session.ts`, `src/server/app.ts` | `session.comments(readId, ids)`, `GET /api/comments` |
| `src/web/api.ts` | `commentsQuery`, a batching fetcher |
| `src/web/threads/` (new dir) | `useThreadComments.ts`, `Conversation.tsx`, `ThreadStatus.tsx` (resolved icon, comment count, your-turn dot) |
| `src/web/overview/OverviewPage.tsx` | card uses the shared parts and expands to the conversation |
| `src/web/files/threadPlacement.ts` (new) | `placeThreads()`, pure: the seam |
| `src/web/files/ThreadBubble.tsx`, `ThreadRow.tsx` (new) | bubble + inline opened thread row |
| `src/web/files/DiffBody.tsx`, `FilesPage.tsx` | wire threads in: highlight, bubbles, gap markers, header threads |
| `test/fake-gh/scenario.ts`, `test/fake-gh/gh` | keep reply bodies; serve every comment and `latest.author` |

Briefs: Task 1–2 = brief A (server + client data), Task 3 = brief B (Overview), Task 4–5 = brief C (Files changed). These run in order, A → B → C, because B and C build on A's types and C reuses B's `Conversation`.

---

### Task 1: Server — attention set, anchor, every comment

**Files:**
- Create: `src/server/attention.ts`, `src/server/attention.test.ts`
- Modify: `src/shared/types.ts`, `src/server/gh.ts:371-389,884`, `src/server/overview.ts:184-314`, `src/server/overviewRead.ts`, `src/server/session.ts`, `src/server/app.ts`, `test/fake-gh/scenario.ts`, `test/fake-gh/gh`
- Test: `src/server/attention.test.ts`, `src/server/overview.test.ts`, `src/server/app.test.ts`, `src/server/fake-gh.test.ts`, `src/server/gh.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
  ```ts
  export interface ThreadComment {
    id: string; author: string; bot: boolean;
    /** Published time; null for the viewer's own pending comment. */
    publishedAt: string | null;
    pending: boolean;
    html: string; body: string; text: string;
  }
  export interface ThreadComments {
    threadId: string;
    /** Oldest first; published (as-of: by the cutoff), plus the viewer's pending ones (not as-of). */
    comments: ThreadComment[];
    unavailable?: "deleted" | "unreadable";
  }
  export interface CommentsView { threads: ThreadComments[] }
  // ReviewThread gains:
  anchor: CodeAnchor | null;   // null for a file comment; present from the summary stage
  attention: string[];         // logins as GitHub spells them
  yourTurn: boolean;           // the viewer (slug) is in `attention`
  ```
- Produces (server): `attentionSet(input: { comments: { login: string; bot: boolean }[]; prAuthor: string; resolved: boolean }): string[]` (comments = published ones, oldest first); `mapThreads(nodes: unknown[], ctx: { asOf?: string; prAuthor: string; viewer: string }): ReviewThread[]`; `OverviewRead.comments(ids: string[]): Promise<CommentsView>`; `Session.comments(readId: string, ids: string[]): Promise<CommentsView>`; `GET /api/comments?read=<readId>&ids=<id,id,…>` → `CommentsView` (400 on missing read or more than 50 ids, 410 for an unknown read, like `/api/threads`).

- [ ] **Step 1: Write the failing attention tests** in `src/server/attention.test.ts`, one per spec row, with `prAuthor: "author"`:
  - `[rev]` gives `["author"]`
  - `[rev, author]` gives `["rev"]`
  - `[rev, author, third]` gives `["rev", "author"]` (order doesn't matter, so compare sorted)
  - `[rev, author, third, rev]` gives `["author", "third"]`
  - resolved gives `[]`
  - `[rev, bot]` gives `["author"]`: the bot is neither in the set nor the latest
  - `[bot]` gives `["author"]`
  - author last, `[author]` alone: `[]`
  - logins that differ only in case or `_`/`-` are one person (compare with `slugify`)
- [ ] **Step 2: Run** `pnpm test src/server/attention.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `attentionSet`** in `src/server/attention.ts`. The result is the human participants plus `prAuthor`, minus the latest human commenter, deduplicated by slug, keeping the first spelling seen.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Write the failing mapping tests** in `src/server/overview.test.ts`, calling `mapThreads(nodes, { prAuthor, viewer })`:
  - a pending reply is ignored by the set
  - as-of drops comments after the cutoff from the set
  - `yourTurn` is true for the viewer slug `octo-cat` against the login `Octo_Cat`
  - a file comment has `anchor: null`
  - a line comment's `anchor` equals the `CodeAnchor` today's `threadCode` builds (commit = opener's `originalCommit.oid`, side/startSide/line/startLine from the original fields)
  - a thread with `totalCount: 150` uses the authors of all 150 comments (fixture with a paged-in author list, Step 7)
- [ ] **Step 6: Implement.**
  - `mapThreads` takes the context object (update its callers).
  - `latest: comments(last: 1)` in `THREAD_FIELDS` gains `${AUTHOR}`.
  - Build `anchor` from the summary fields, not from content.
  - `attention` comes from the cutoff-filtered, non-pending comments.
  - `OverviewRead`'s summary stage awaits `this.overview` for `author` (the PR author) as well as the summaries.
- [ ] **Step 7: Page past 100.** In `gh.ts` add `fetchThreadCommentPages(threadIds: string[], fields: string, read?: ReadSignal): Promise<Map<string, unknown[]>>`. It pages `node(id) { ... on PullRequestReviewThread { comments(first: 100, after: $c) { nodes { … } pageInfo { … } } } }` for threads whose `totalCount` exceeds the listed nodes.
  - The summary stage uses it for authors and times, and only for those threads.
  - The content read uses it for bodies.
  - Test it in `gh.test.ts` against a fake that pages.
- [ ] **Step 8: Write the failing comments tests.**
  - In `overview.test.ts`, `mapComments(summary, content, asOf?)` gives `ThreadComment[]`: oldest first; the pending one kept with `pending: true` outside as-of and dropped in as-of; a bot flagged.
  - In `app.test.ts`, `/api/comments`:
    - 400 for a missing `read`
    - 400 for 51 ids
    - 410 for an unknown read
    - `unavailable: "deleted"` for a thread GONE since the summary
    - `unavailable: "unreadable"` for an id that fails `NODE_ID`
    - a request for ids still in the background queue is answered after one `gh` call, not two (count calls on the fake)
- [ ] **Step 9: Implement.**
  - `CONTENT_FIELDS` becomes `id comments(first: 100) { totalCount nodes { id author{…} createdAt publishedAt state body bodyText bodyHTML diffHunk } }`.
  - Keep `withContent` and `hasContent` working for the opener (the Overview stages and code panes still read `first`), so the existing overview tests pass unchanged.
  - In `OverviewRead.comments(ids)`, serve ids whose content is cached. Join ids already in flight. Fetch the rest at once, in batches of 50, and cache the results for the stages.
  - Wire it through `Session.comments` and the route.
- [ ] **Step 10: Fake gh.**
  - `reviewThread()` keeps each comment's text fields in `comments.nodes`.
  - The fake's `nodes(ids:)` handler serves every comment's body fields when the query asks for `comments(first: 100)`.
  - `latest.nodes` carries `author`.
  - Add a scenario knob, `commentsDelayMs`.
  - Extend `fake-gh.test.ts`.
- [ ] **Step 11: Run** `pnpm verify:fast`. Expected: lint, typecheck and the related unit tests pass; the existing overview e2e is unchanged and green.
- [ ] **Step 12: Real-PR timing.** Before and after this task, run `CRB_PR=…`, as in the memory `real-pr-check`. Record the time to the summary stage and to `full` in the report. The summary stage must not regress by more than noise (±10%).
- [ ] **Step 13: Commit** with `git commit --only -- <paths>`, message `threads: every comment, attention set and anchor on the server`.

### Task 2: Web data — comments query with batching

**Files:**
- Create: `src/web/threads/useThreadComments.ts`, `src/web/threads/useThreadComments.test.ts`
- Modify: `src/web/api.ts`

**Interfaces:**
- Consumes: `CommentsView`, `ThreadComments`, `GET /api/comments` (Task 1).
- Produces:
  - `commentsQuery(readId: string, threadId: string)`: TanStack options with key `["comments", readId, threadId]` and `staleTime: Infinity`. The fetch goes through a batcher that gathers the ids asked for in one tick (≤ 50 per request) into one `/api/comments` call and resolves each id's query.
  - `useThreadComments(readId: string | undefined, threadId: string, opts?: { enabled?: boolean }): UseQueryResult<ThreadComments>`.
  - `usePrefetchComments(readId: string | undefined, threadIds: string[]): void` prefetches in order of the list. At most 2 batch requests run at once. The rest are queued.

- [ ] **Step 1: Write the failing tests** with a mocked `fetch`:
  - 7 hooks mounted in one tick make one request with 7 ids
  - 60 prefetched ids make 2 requests (50 + 10), never more than 2 at once
  - an id already prefetched and then opened makes no new request
  - an opened id that is still queued is sent in the next request, ahead of the queue
  - a 410 invalidates `["overview"]`, and the hook refetches under the new readId, as `threadsQuery` does
  - a 500 gives the query an error state (no partial thread)
- [ ] **Step 2: Run** `pnpm test src/web/threads/useThreadComments.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `src/web/api.ts` (fetcher and batcher) and `useThreadComments.ts` (hooks).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `threads: batched comments query`.

### Task 3: Overview — count, conversation, resolved, dot

**Files:**
- Create: `src/web/threads/Conversation.tsx`, `src/web/threads/ThreadStatus.tsx`, `src/web/threads/Conversation.test.tsx`
- Modify: `src/web/overview/OverviewPage.tsx` (`ThreadItem` :1034, `CommentBody` :1548, `ThreadGroup` :822), `docs/design/README.md` ("Thread cards"), `docs/todo.md` (retire "Suggestions in replies"), `e2e/overview.spec.ts`, `e2e/mobile.spec.ts`
- Test: `src/web/threads/Conversation.test.tsx`, e2e as listed

**Interfaces:**
- Consumes: `useThreadComments`, `usePrefetchComments` (Task 2); `ReviewThread.attention/yourTurn` (Task 1).
- Produces:
  - `Conversation(props: { readId: string; thread: ReviewThread; skipFirst?: boolean })` renders the comments oldest first. Each comment shows its author, `BotIcon` for a bot, `RelativeTime` and its body through today's `CommentBody` logic. That logic moves here and takes `{ html, body }` instead of a thread, so suggestions render in replies too.
    - A pending comment shows a pending icon (tooltip "Pending, only you see it").
    - While the comments load it shows a spinner (`role="status"`, name "Loading comments").
    - On an error it shows a retry button that refetches.
    - For `unavailable` it shows today's text.
  - `ThreadStatus(props: { thread: ReviewThread })` renders the resolved mark (`CheckCircleIcon text-ok`, name "Resolved"), the comment count (`CommentIcon` + number, name "N comments") and the your-turn dot (a `warn` dot, name and tooltip "Your turn", only when `thread.yourTurn`).

- [ ] **Step 1: Write the failing component tests** in `Conversation.test.tsx`:
  - 3 comments render in order
  - a reply with a ```suggestion block renders a `SuggestedChange`
  - a pending comment has the pending mark
  - the spinner shows while loading, then the comments replace it
  - an error shows Retry, and clicking it refetches
  - `ThreadStatus` shows the dot only when `yourTurn`, and never on a resolved thread (the server already empties the set; assert the rendered output)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `Conversation` and `ThreadStatus`.
- [ ] **Step 4: Wire the card.**
  - `ThreadItem` keeps the header and the opening comment.
  - Its header uses `ThreadStatus`. Resolved now shows as an icon plus the `ok` colour in the header, as well as the muted style.
  - A toggle, `CommentDiscussionIcon` + "N replies", ≥ 40px, `aria-expanded`, opens `<Conversation skipFirst />` under the opener. Cards start closed.
  - `ThreadGroup` calls `usePrefetchComments(readId, <the ids it lists, in order>)` once the summary is in, then the ids of the next page.
- [ ] **Step 5: Run** `pnpm test src/web/threads`. Expected: PASS.
- [ ] **Step 6: Write the e2e tests** in `e2e/overview.spec.ts`. The scenario has a thread with 3 comments (one a bot), a resolved thread, a thread where the viewer `Octo_Cat` commented and the author `octo-author` replied last, and `commentsDelayMs: 1500`.
  - "card shows the comment count and opens to every reply"
  - "your turn dot shows only where the viewer is in the attention set"
  - "resolved thread is marked resolved in its header"
  - "slow comments show a spinner, then the replies"
  - "a deleted thread shows deleted, not a spinner" (`deletedThreads`)
  - In `e2e/mobile.spec.ts`: the opened card has no horizontal page scroll at 360px, and the toggle is ≥ 40px.
- [ ] **Step 7: Run** `pnpm verify:fast`. Expected: PASS in both projects.
- [ ] **Step 8: Docs.** Update `docs/design/README.md` "Thread cards" for the count, the dot, resolved and the toggle. Remove the "Suggestions in replies" todo item.
- [ ] **Step 9: Commit** with the message `overview: full thread conversations, resolved mark, your-turn dot`.

### Task 4: Placement — the seam

**Files:**
- Create: `src/web/files/threadPlacement.ts`, `src/web/files/threadPlacement.test.ts`

**Interfaces:**
- Consumes: `ReviewThread.anchor` (Task 1), `FileHunks`, `DiffLine`, `Gap` (`src/web/files/gaps.ts`).
- Produces:
  ```ts
  export type LineKey = `${DiffSide}:${number}`;
  export interface FilePlacement {
    /** Threads whose range ends on a shown line, by that line. */
    end: Map<LineKey, ReviewThread[]>;
    /** Every line a placed thread's range covers (the highlight). */
    covered: Set<LineKey>;
    /** Threads whose end line sits in gap `index` (collapsed context). */
    gaps: Map<number, ReviewThread[]>;
    /** File comments ("file") and lines that couldn't be placed ("unplaced"). */
    header: { thread: ReviewThread; reason: "file" | "unplaced" }[];
  }
  /** Which threads belong to this file's viewed diff, and where. Threads on other commits are left out. */
  export function placeThreads(args: {
    threads: ReviewThread[]; path: string; snapshotHead: string;
    hunks: FileHunks; loadedContext: DiffLine[];
  }): FilePlacement;
  /** The row a line key names: RIGHT matches `newNo`, LEFT matches `oldNo`. */
  export function lineKey(side: DiffSide, line: DiffLine): LineKey | null;
  ```
  The gap rule: a line lies in a gap when it isn't in any hunk and isn't in the loaded context. Its gap is the one whose new-side range holds it. For LEFT, map it through the context offset of the hunk above.

- [ ] **Step 1: Write the failing tests:**
  - a single line RIGHT
  - multi-line RIGHT: `covered` holds every line, `end` holds the last line only
  - LEFT on a deleted line
  - "side picks the number column": on a context row with `oldNo 40, newNo 45`, a RIGHT 40 doesn't match it
  - a file comment goes to `header` with `"file"`
  - a line beyond the file goes to `header` with `"unplaced"`
  - an `anchor.commit` other than the head is absent from every bucket
  - two threads on one end line share one `end` entry
  - a RIGHT line inside gap 1 goes to `gaps.get(1)`
  - the same line already in the loaded context goes to `end`
  - a LEFT line in a gap is mapped to the correct gap
  - a thread on another path is ignored
  - a range that starts in a gap and ends in a hunk: `end` gets it, and `covered` holds the shown lines only
- [ ] **Step 2: Run** `pnpm test src/web/files/threadPlacement.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `files: thread placement`.

### Task 5: Files changed — highlight, bubble, inline thread

**Files:**
- Create: `src/web/files/ThreadBubble.tsx`, `src/web/files/ThreadRow.tsx`, `e2e/files-threads.spec.ts`
- Modify: `src/web/files/DiffBody.tsx` (`LineRow` :79, `HunkRows` :621, gap rows), `src/web/files/FilesPage.tsx`, `src/web/files/FileDiff.tsx` (header threads), `src/web/index.css` (no new colours; `mark-tint` for the highlight), `scripts/verify-fast.mjs` (`E2E_MAP`: map `src/web/files/` and `src/web/threads/` to `files-threads`), `docs/design/README.md`
- Test: `e2e/files-threads.spec.ts`, `e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: `placeThreads`, `lineKey` (Task 4); `Conversation`, `ThreadStatus` (Task 3); `usePrefetchComments` (Task 2); `overviewQuery` (for `readId`), `threadsQuery(readId, "summary")`, and `sessionQuery` (for `snapshotHead`) from `src/web/api.ts`.
- Produces:
  - `ThreadBubble(props: { threads: ReviewThread[]; open: boolean; onToggle(): void })` is a ≥ 40px button with `aria-expanded`, the comment glyph and the total count, muted plus a check when every thread is resolved, and the dot when any thread has `yourTurn`. Its name is built from the counts ("2 comments, your turn", "3 comments, resolved").
  - `ThreadRow(props: { readId: string; threads: ReviewThread[] })` is a `<tr>` with `<Rail/>` + `<td colSpan={COLUMNS - 1}>`, one `Conversation` per thread, and a header per thread with `ThreadStatus` and the outdated badge.

- [ ] **Step 1: Write the failing e2e tests** in `e2e/files-threads.spec.ts`. The scenario's head is the fixture's head. It has a RIGHT single-line thread, a RIGHT multi-line thread, a LEFT thread on a deleted line, a file comment, a thread on an older commit, a thread on a line inside a collapsed gap and a resolved thread.
  - "bubble on the commented line with count, dot and resolved state"
  - "multi-line range is highlighted, the bubble sits on its last line"
  - "opening the bubble shows every comment, closing keeps the scroll position"
  - "a thread on an older commit is not shown"
  - "file comment opens from the file header"
  - "a thread in a collapsed gap is reachable" (the gap shows a bubble; opening it shows the thread)
  - "opening a thread doesn't change review progress"
  - "threads show when /files is the first page"
  - "slow comments: spinner, then comments" (`commentsDelayMs`)
  - In `e2e/mobile.spec.ts`: "opened thread fits the viewport with a 300-char line". The page has no horizontal scroll, the thread's left edge is in view after the code is scrolled sideways, and the bubble is ≥ 40px.
- [ ] **Step 2: Run** `pnpm test:e2e e2e/files-threads.spec.ts --project=chromium`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `FilesPage` reads `readId`, the `summary` threads and `snapshotHead`, and passes the threads down to `DiffBody`.
  - `DiffBody` calls `placeThreads` once per render of its file.
  - `LineRow` gets `highlight` (the `mark-tint` utility) and an optional bubble in the code cell's trailing edge.
  - The open bubble's `ThreadRow` goes right after that row.
  - Gap rows show a bubble for `gaps`. Opening it expands the gap to the thread's lines, or shows the thread at the gap. Pick one and make "a thread in a collapsed gap is reachable" pass.
  - The `FileDiff` header shows a bubble for `header`. An `"unplaced"` thread is shown flagged with `AlertIcon` and the tooltip "Line not in this diff".
  - Prefetch comments for the open file's threads first, then the threads in the other files in file order.
  - The thread row is sticky-left at the container's visible width (Review Focus 2).
- [ ] **Step 4: Run** the e2e again in both projects (`pnpm test:e2e e2e/files-threads.spec.ts e2e/mobile.spec.ts`). Expected: PASS.
- [ ] **Step 5: Real-PR check.** On #99 as of, every thread whose `originalCommit` is the viewed head lands on the line GitHub shows. Compare against `pnpm compare-threads` output or the REST `original_line`/`side`. Comment counts match GitHub. Report the number of threads checked, the mismatches, and the time to the first bubble and to the first opened thread's comments.
- [ ] **Step 6: Docs and verify.** Update `docs/design/README.md` with the Files changed threads. Run `pnpm verify`. Expected: all green.
- [ ] **Step 7: Commit** with the message `files: inline review threads`.
