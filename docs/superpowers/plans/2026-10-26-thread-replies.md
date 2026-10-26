# Thread replies and resolving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reply to review threads and resolve/unresolve them from carbonless, posted to GitHub immediately through `gh`.

**Architecture:** The server gains two write endpoints that call `gh` (REST for replies, GraphQL for resolve), refuse in as-of and `--viewer` sessions, dedupe retried replies, and update its cached read so later reads agree. The client gains a per-thread write queue that reuses the saves' timing and notice stack, a draft store in `localStorage`, a reply box and a resolve toggle inside `Conversation`, a Drafts filter, a fade-then-move for resolved Overview cards, and two warnings in "who's reviewing".

**Tech Stack:** Fastify + `gh` (server), React + TanStack Query + Tailwind (web), Vitest, Playwright with fake gh.

**Spec:** `docs/superpowers/specs/2026-10-26-thread-replies-design.md`

## Global Constraints

- Every write is one explicit reviewer action on one thread. Nothing posts, resolves or retries a refused write on its own.
- Replies use REST `POST /repos/{o}/{r}/pulls/{n}/comments/{commentId}/replies`, never GraphQL `addPullRequestReviewThreadReply` (it joins a pending review).
- Timing reused from `src/web/files/stateSync.ts`: `DELAYED_MS` 5000, `RETRY_DELAYS_MS` [1000, 2000, 4000, 8000, 15000, 30000], `STALL_ATTEMPTS` 5.
- Principles 5 and 6: 360px with no horizontal page scroll, ≥40px tap targets, icon-first with tooltip and accessible name, token colours only.
- Tests use fake gh only. Real writes only on https://github.com/Gilthans/carbonless-scratch/pull/1 (CLAUDE.md exception).
- `git commit --only -- <paths>`; never push except to the scratch repo; never port 4747.

## Review Focus

1. A reply retried after a timeout whose first attempt did land → exactly one comment on GitHub (Task 1 dedupe test; Task 2 resend-after-reload test).
2. The viewer has a pending review → the reply is refused with the link, the draft stays, and nothing is posted (Task 1 fake-gh 422 test; Task 2 e2e).
3. A thread deleted on GitHub while a reply is queued → 404 shown red with the draft kept, no retry loop (Task 1 404 test; Task 2 unit).
4. Reply then resolve on the same thread while the reply is slow → they land in that order (Task 2 ordering test).
5. A reload with a sent-but-unconfirmed reply → it's resent with `retry: true` and appears once (Task 2 unit + e2e).

---

### Task 1: Server writes, fake gh, docs (brief F)

**Files:**
- Create: `src/server/threadWrites.ts`, `src/server/threadWrites.test.ts`
- Modify: `src/server/gh.ts` (permission fields in the threads query; pending-review flag from the reviews read), `src/server/overview.ts`/`overviewRead.ts` (map new fields; update the cached read after a write), `src/server/app.ts` (routes), `src/shared/types.ts`, `test/fake-gh/gh`, `test/fake-gh/scenario.ts`, `CLAUDE.md` ("only reads from GitHub" line), `docs/product-rules.md`
- Test: `src/server/threadWrites.test.ts`, `src/server/app.test.ts`, `src/server/fake-gh.test.ts`

**Interfaces (produces, exact):**

```ts
// src/shared/types.ts
interface ReviewThread { /* existing */ viewerCan: { reply: boolean; resolve: boolean; unresolve: boolean } }
interface PrOverview {
  /* existing */
  /** "on", or why this session can't write: an as-of view, or --viewer someone other than the gh login. */
  writes: "on" | "as-of" | "viewer";
  /** The viewer has an unsubmitted review on this PR: replies can't be posted. `url` = `${pr.url}/files`. */
  pendingReview: { url: string } | null;
}
/** What a thread write answers with: the thread's new state. */
interface ThreadUpdate {
  threadId: string;
  resolved: boolean;
  commentCount: number;
  lastActivityAt: string;
  attention: string[];
  yourTurn: boolean;
  viewerCan: ReviewThread["viewerCan"];
  comments: ThreadComments;
  /** Reply only: the comment that holds the reply (posted now, or found by the dedupe). */
  comment?: ThreadComment;
}
interface ReplyRequest { body: string; /** ISO time of the first attempt. */ attemptedAt: string; /** A resend after a failed or unknown attempt: dedupe first. */ retry: boolean }
interface ResolveRequest { resolved: boolean }
interface WriteError { error: string; code: "pending-review" | "writes-off" | "forbidden" | "gone" | "invalid"; url?: string }
```

Routes:
- `POST /api/threads/:threadId/replies` with `ReplyRequest` → 200 `ThreadUpdate`.
- `POST /api/threads/:threadId/resolved` with `ResolveRequest` → 200 `ThreadUpdate`.
- Errors: 400 `invalid` (blank body; body over 65536 chars; bad JSON); 403 `writes-off` (as-of or viewer session); 403 `forbidden` (GitHub 403, message passed on); 404 `gone` (thread or its first comment no longer exists); 409 `pending-review` with `url` (GitHub's 422 "one pending review"); 502 for other `gh` failures (the client treats it as transient).

- [ ] **Step 1: Fake gh writes.** Extend the scenario: threads get `viewerCanReply/Resolve/Unresolve` (default true), the viewer's reviews may include one `PENDING`, and the fake gh serves the REST reply (appending a comment by the viewer with a new id and `publishedAt` now; 422 with GitHub's exact message when the scenario has a pending review by the viewer), `resolveReviewThread`/`unresolveReviewThread`, and failure hooks: `failNext: { op: "reply" | "resolve"; status: number; afterWrite?: boolean }` (`afterWrite` stores the comment, then fails, for the ambiguous case). State persists across calls within a test. Test in `fake-gh.test.ts`: a reply then a threads read shows it; resolve flips `isResolved`; the 422; `afterWrite`.
- [ ] **Step 2: Failing tests for `src/server/threadWrites.ts`:**
  - `reply posts via REST to the thread's first comment and returns the new comment and attention`: viewer `alice`, PR author `bob`, thread opened by `alice` with bob's reply → after alice's reply, `attention` = `["bob"]`, `yourTurn` false, `commentCount` +1.
  - `a retried reply that already landed is not posted again`: `failNext afterWrite`, then `retry: true` with the same body and `attemptedAt` → one comment in the fake's store, the answer's `comment.id` is that comment. Matching rule: a comment by the viewer, body equal after trimming trailing whitespace, `publishedAt >= attemptedAt − 60 s`.
  - `a retry whose first attempt didn't land posts it`.
  - `pending review → 409 pending-review with url ending /files`, nothing stored.
  - `resolve and unresolve flip resolved; resolved empties attention`.
  - `deleted thread → 404 gone`; `GitHub 403 → 403 forbidden with GitHub's message`.
  - `as-of session → 403 writes-off`; `--viewer other → 403 writes-off`, no `gh` write call made.
- [ ] **Step 3: Implement** `replyToThread(session, threadId, req): Promise<ThreadUpdate>` and `setResolved(session, threadId, resolved): Promise<ThreadUpdate>` in `threadWrites.ts`. The reply target is the thread's first comment's REST `databaseId` (read it in the threads query if it isn't already there). After a write, re-read that thread's comments, recompute `attention` with `attentionSet`, and write the result into the session's latest kept read (threads list and the comments cache served by `/api/comments`) so later reads agree until the next Refresh.
- [ ] **Step 4: Map the new fields:** `viewerCan` from the threads query (all false when `writes !== "on"`), `writes` from the session options (`--viewer` differing from `viewerSlug()` → `"viewer"`), `pendingReview` from the reviews read (viewer's review with state `PENDING`). Tests in `overview.test.ts`.
- [ ] **Step 5: Routes in `app.ts`** with the status mapping above; `app.test.ts` covers each status.
- [ ] **Step 6: Docs.** `CLAUDE.md`: "It clones … and only reads from GitHub." becomes "… reads from GitHub, and writes to it only on the reviewer's explicit action (replies, resolving)." `docs/product-rules.md`: a "Writing to GitHub" section with the global constraints above and the pending-review rule.
- [ ] **Step 7: Real-GitHub check on the scratch PR only**: built CLI on a free port with a scratch `XDG_CACHE_HOME`, `curl` a reply and a resolve/unresolve to thread `PRRT_kwDOVYfDzs6wd7Y1`, open a pending review via `gh api` and confirm the 409, then discard it. Report what was posted.
- [ ] **Step 8: `pnpm verify` green; commit.**

### Task 2: Web: reply box, resolve toggle, write queue, drafts, warnings (brief G)

Runs in parallel with Task 1 against the interfaces above, mocking `fetch` in unit tests; its e2e step waits for Task 1 to be merged into `m2-threads` and then rebases.

**Files:**
- Create: `src/web/threads/threadWrites.ts` (queue) + test, `src/web/threads/drafts.ts` + test, `src/web/threads/ReplyBox.tsx`, `src/web/threads/ResolveToggle.tsx`, `src/web/overview/WriteWarnings.tsx`, `e2e/thread-writes.spec.ts`
- Modify: `src/web/threads/Conversation.tsx` (box + toggle), `src/web/threads/ThreadStatus.tsx`, `src/web/files/SyncNotices.tsx` (also show thread writes), `src/web/files/ThreadRow.tsx`, `src/web/overview/*` (Drafts filter, fade, warnings in who's reviewing), `src/web/api.ts`, the leave-page guard, `scripts/verify-fast.mjs` (`E2E_MAP`)

**Interfaces:**
- Consumes: Task 1's types and routes, exactly.
- Produces:
```ts
// src/web/threads/drafts.ts — per PR, in localStorage key `crb:drafts:${owner}/${repo}#${number}` (try/catch; memory fallback)
interface Draft { threadId: string; text: string; /** Sent, not yet confirmed. */ sending?: { attemptedAt: string; sentOnce: boolean } }
function useDraft(threadId: string): [text: string, setText: (t: string) => void];
function useDrafts(): Draft[];               // every draft or unconfirmed reply, for the Drafts filter and the leave guard
// src/web/threads/threadWrites.ts
class ThreadWrites { reply(threadId: string, text: string): void; setResolved(threadId: string, resolved: boolean): void; retry(threadId: string): void; state(): ThreadWritesState }
function useThreadWrites(): ThreadWritesState;  // pending/stalled/failed per thread, for notices and per-thread UI
const FADE_MS = 4000;
```

- [ ] **Step 1: Failing unit tests for the queue (fake timers, mocked fetch):** writes to one thread go in order (reply held, resolve queued behind it, lands second); different threads run in parallel, at most 4 in flight; yellow after `DELAYED_MS`; transient (unreachable, 408, 429, 5xx, 502) retries on `RETRY_DELAYS_MS`; red after `STALL_ATTEMPTS` with retrying continuing; 400/403/404/409 red at once, never retried automatically; every resend of a reply after a failed or unknown attempt carries `retry: true` and the first `attemptedAt`; a `ThreadUpdate` answer updates the thread in the threads and comments caches (`commentsQuery`) so the card, the bubble and the dot change.
- [ ] **Step 2: Implement the queue**, sharing the timing constants and the `isTransient` rule with `stateSync.ts` (import them; don't copy). Notices: extend `SyncNotices` with thread writes, naming the thread (`path:line`, or the path for a file comment) and the action ("Reply" / "Resolve" / "Unresolve"); the pending-review 409 notice says "A pending review on GitHub blocks replies" with a link to `url` ("Open on GitHub").
- [ ] **Step 3: Failing tests for drafts:** text survives unmount and remount; survives a reload (`localStorage`); a sent reply is kept with `sending` until confirmed, then removed; on load, drafts with `sending` are resent through the queue with `retry: true`; `localStorage` throwing falls back to memory.
- [ ] **Step 4: Implement drafts and the leave-page guard:** `beforeunload` asks when any draft has text or `sending`, as well as for unsaved review states.
- [ ] **Step 5: `ReplyBox` and `ResolveToggle` in `Conversation`.** Box: textarea, one line until focused, growing; Send icon button (`PaperAirplaneIcon` or the project's equivalent; tooltip "Reply", ≥40px); Ctrl/Cmd+Enter sends; Escape blurs; blank can't send; hidden when `!thread.viewerCan.reply` or `writes !== "on"`. On send: the reply shows at once at the end of the thread as the viewer's comment with the pending clock, the box clears; on a final failure the text returns to the box. Toggle: `CheckCircleIcon` "Resolve" / its unresolve counterpart "Unresolve", flips at once, hidden when not allowed. Unit tests in `Conversation.test.tsx` for each, including hidden-when-not-allowed.
- [ ] **Step 6: Overview.**
  - **Fade then move:** a card resolved or unresolved stays in place and fades over `FADE_MS` with the toggle still there; undoing during the fade cancels it; then it moves to the other group. With `prefers-reduced-motion`, a still "Moving…" state for the same time instead.
  - **Drafts filter:** next to unresolved/resolved, shown with its count when `useDrafts()` isn't empty.
  - **`WriteWarnings` in who's reviewing:** a warn banner when `pendingReview` ("Pending review on GitHub: replies can't be posted until it's submitted or discarded", link "Open on GitHub"), also shown after a 409; and one when any thread disallows reply or resolve, saying which ("You can't reply in this repo" / "You can't resolve threads in this repo"). Unit tests for each.
- [ ] **Step 7: e2e (`e2e/thread-writes.spec.ts`, desktop and phone),** after rebasing on Task 1: reply from an Overview card and from Files changed, shown at once, still there after a reload; resolve and unresolve from both places, with the fade; a failing reply keeps its text with Retry; a pending review shows the banner and refuses with the link; no box or toggle as of a cutoff; reload with an unconfirmed reply posts it once; the Drafts filter lists a draft. Add to `E2E_MAP`.
- [ ] **Step 8: Real-GitHub check on the scratch PR only**, through the UI of the built CLI: reply, resolve, unresolve, confirm on GitHub. Desktop and 360px screenshots.
- [ ] **Step 9: `pnpm verify` green; commit.**
