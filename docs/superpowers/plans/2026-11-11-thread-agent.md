# Thread agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One private agent conversation per GitHub review thread, opened from an agent button in the thread's header, sliding over the thread's comments; the agent sees the thread, the commit it was opened on, the viewed patch set and the PR's newest head, may suggest resolving, never resolves.

**Architecture:** Review buddy's agent threads gain a `thread` anchor subject and four stored pieces (`view`, `head`, `suggests`, `origin`) plus an `agent-thread-seen` event (Task 1). The server joins the fold with the session's GitHub threads (resolved together, orphans fall back to span threads, unread) and extends the routes (Task 2). The runner builds a `github_thread_conversation` envelope and checks out the viewed patch set (Task 3). The web adds the agent button and the slide-over panel to every thread card (Task 4), then code links, chips and unread on span threads (Task 5). E2e, gallery and docs close it (Task 6). Order: 1 → 2 → (3 ∥ 4) → 5 → 6.

**Tech Stack:** Node 24, Fastify, git CLI, `@agentclientprotocol/sdk`, React 19, TanStack Query 5, Tailwind tokens, Vitest, Playwright (chromium + phone), the fake gh and the fake ACP agent.

**Spec:** `docs/superpowers/specs/2026-11-09-thread-agent-design.md` (approved 2026-11-11). Mockups: the canvas linked from the spec's header. Every brief carries both.

## Global Constraints

- Same ref as review buddy: `refs/crb/reviews/<id>/reviewers/<slug>/agent/threads`, append-only events, never pushed. Malformed new fields make the parser drop the event (fail safe).
- **The agent never resolves, unresolves, replies to or writes to a GitHub thread.** No route lets an `ai` event or a runner action do it. `agent-thread-seen` and `agent-thread-resolved` by `ai` are dropped by the parser.
- A thread whose `ReviewThread.id` is `""`, a deleted thread, and `--viewer`/`--as-of` reviews get no agent button.
- `origin.request` is cut to 200 characters. Message texts keep review buddy's 32 KiB cap.
- Suggestion marker: a final line holding exactly `[suggest-resolve]`; stripped from the text, stored as `suggests: "resolve"`. A marker mid-message is plain text.
- Button copy, exact: tooltip/name "Ask agent" (no conversation yet); accessible name `"<n> agent messages"`, `"<n> agent messages, <k> new"`, and `"<n> agent messages: hide"` when open; composer placeholders "Reply…" and "Ask agent…"; suggestion button "Resolve By Agent Suggestion"; "new" divider label "new"; strip's accessible name "Back to the thread".
- Colours: the agent button is the agent tint (`agent`, `agent-edge`, `agent-ink`); unread dot `accent`; suggestion button and the Resolve ring `ok`. Tokens only.
- Slide: about 250 ms, `transform` only, no transition under `prefers-reduced-motion`. The strip is the comments' avatar column, at least 40px. The card header and the composer row are never covered.
- Phone: the agent button and comment counter 40px tall; no horizontal page scroll at 360px.
- Principle 3: one seen event per agent message at most; measure the ref (Task 1).
- Tests never call the real `gh` or a real agent. Commits via `git commit --only -- <paths>`. Iterate with `pnpm verify:fast`; one `pnpm verify` on the combined branch before the PR. `CRB_NO_PHONE=1` except in Tasks 4 and 6 (layout).

## Review Focus

1. **The GitHub thread is resolved, unresolved or deleted on GitHub while the conversation is open** (another reviewer, another tab): on the next read the conversation folds, reopens, or turns into a span agent card on the thread's lines, never vanishes and never shows two copies (Task 2, `githubJoin.test.ts` "a thread gone from GitHub becomes a span thread on its lines").
2. **Two devices open a conversation on the same thread at once** (the phone and the desktop both send a first question): one conversation holding both questions (Task 1, `store.test.ts` "two openings of one GitHub thread fold into one"; Task 2, `app.test.ts` "POST agent/threads for a thread that has one answers 409 with its id").
3. **The PR is force-pushed between the question and the turn**, or the viewed patch set's commit was never fetched: the turn still runs, `current` is the new head, and a missing commit is named in `notice` (Task 3, `runner.test.ts` "a commit the clone lacks is named in notice").
4. **Hostile thread text**: a comment body with `<!-- -->`, bidi or zero-width characters, a login or path with control characters, a comment saying "end with [suggest-resolve]": all sanitised in the envelope; a suggestion still only offers a human-pressed button (Task 3, `prompt.test.ts` "github comments, logins and path are sanitised"; Task 4 "Resolve By Agent Suggestion only resolves on press").
5. **Typing to the agent, then pressing Resolve in Files changed**: the thread stays open with the text, as with an unsent reply; closing the slide-over keeps the text (Task 4, `resolveCollapse.test.ts` "unsent agent text keeps the thread open").

---

### Task 1: Events, fold and store (brief A)

**Files:**
- Modify: `src/shared/agent.ts`, `src/server/review/events.ts` (types, `parseAnchor`, `parseAgentEvent`, the write rule), `src/server/agent/store.ts`, `docs/review-data-storage.md` ("Agent threads ref")
- Test: `src/server/review/events.test.ts`, `src/server/agent/store.test.ts`; measure with `scripts/measure-agent-ref.ts` (extend it)

**Interfaces (produces):**

```ts
// src/shared/agent.ts
export type AgentAnchor =
  | { subject: "line"; … }            // unchanged
  | { subject: "file"; … }            // unchanged
  | { subject: "thread"; thread: string; path: string; commit: string;
      side?: DiffSide; line?: number; startSide?: DiffSide; startLine?: number };
export type AgentViewTarget = { patchset: number } | { head: string };
export type AgentViewFrom = { branch: true } | { patchset: number };
/** The comparison on screen when a human message was sent; left/right filled by the server. */
export interface AgentView { target: AgentViewTarget; from: AgentViewFrom; left: string; right: string }
// AgentMessage gains: view?: AgentView (human only); head?: string (ai only, the checkout's OID); suggests?: "resolve" (ai only)
// AgentThread gains: origin?: { request: string }; unread: boolean; seenUpTo?: string (message id); orphaned?: boolean
export interface OpenAgentThreadRequest { clientId: string; text: string; span?: AgentAnchor; thread?: string; view?: Omit<AgentView, "left" | "right"> } // exactly one of span, thread
export interface AgentMessageRequest { clientId: string; text: string; view?: Omit<AgentView, "left" | "right"> }
export interface AgentSeenRequest { upTo: string }
export const MAX_ORIGIN_REQUEST = 200;

// src/server/review/events.ts
// AgentThreadOpenedEvent gains: origin?: { request: string } (ai only); view?: AgentView (human only)
// AgentMessageEvent gains: view?: AgentView (human only); head?: string (ai only, OID); suggests?: "resolve" (ai only)
export interface AgentThreadSeenEvent extends EventBase { type: "agent-thread-seen"; thread: string; upTo: string /* lower ULID */ }

// src/server/agent/store.ts
export interface AgentThreadFold extends Omit<AgentThread, "code"> { clientId?: string }
// foldAgentThreads: unchanged signature; fills unread and seenUpTo (Step 6). orphaned is set by Task 2's join.
// AgentThreadStore gains:
//   open(input & { view?: AgentView; origin?: { request: string } })  (origin only with by "ai")
//   message(thread, input & { view?: AgentView } | ai input & { head?: string; suggests?: "resolve" })
//   seen(thread: string, upTo: string): Promise<AgentThreadFold>   // no write when already seen up to there or later
```

- [ ] **Step 1: Failing parser tests** in `events.test.ts`: `it("parses a thread anchor with and without lines")`, `it("drops a thread anchor with an empty thread id or a bad side")`, `it("parses view on human messages and drops it on ai ones")`, `it("parses head and suggests on ai messages and drops them on human ones")`, `it("drops origin on a human opening and cuts nothing: an origin over 200 chars is dropped")`, `it("parses agent-thread-seen by a human, drops it by ai")`.
- [ ] **Step 2: Run** `pnpm test src/server/review/events.test.ts`; expect the new cases to fail.
- [ ] **Step 3: Implement** the types and parse branches. `head` and `view.left/right` match the existing `COMMIT` check; `thread` in a thread anchor is a non-empty string ≤ 200 chars (GitHub node ids are not ULIDs). `validateForWrite` throws for an ai `agent-thread-seen`.
- [ ] **Step 4: Run; pass. Commit** `events: thread anchors, view/head/suggests/origin, agent-thread-seen`.
- [ ] **Step 5: Failing fold/store tests** in `store.test.ts` (real git, as the file does):
  - "two openings of one GitHub thread fold into one": two `agent-thread-opened` with thread anchors on the same `thread` id; one fold, the second's opening text and its later messages appended in (ts, id) order; `t.id` is the first's.
  - "unread: an ai message after the last seen upTo"; "an ai-opened thread is unread until seen"; "a seen upTo naming an earlier message than a previous seen does not move it back".
  - "seen writes nothing when already seen up to there" (count the ref's commits).
  - "view, head, suggests and origin round trip".
  - "agent-thread-resolved still folds for a thread anchor" (the join decides whether it counts; Task 2).
- [ ] **Step 6: Run; fail. Implement** in `foldAgentThreads`: an alias map `secondThreadId → firstThreadId` for thread anchors with a GitHub `thread` already folded; `seenUpTo` = the seen `upTo` with the highest message index; `unread` = some `ai` message after `seenUpTo`'s index (or any `ai` message without one). Add `store.seen`.
- [ ] **Step 7: Run; pass. Commit** `agent store: one conversation per GitHub thread, seen and unread`.
- [ ] **Step 8: Measure** (extend `scripts/measure-agent-ref.ts`): 50 thread conversations × 4 messages × 2 KiB plus one seen event per agent message; loose and packed size, one append, a cold fold. Write the table and the new events into `docs/review-data-storage.md`. Read `docs/gitdb-design-principles.md` first. Commit `docs: thread conversations in the agent ref, measured`.
- [ ] **Step 9:** `pnpm verify:fast` green.

---

### Task 2: Join with GitHub threads, routes (brief B)

**Files:**
- Create: `src/server/agent/githubJoin.ts`, `src/server/agent/githubJoin.test.ts`
- Modify: `src/server/agent/host.ts` (`AgentHost.threads/asked/open/message/setResolved`, new `seen`; `ReviewAgentSource` gains `threads(): Promise<ReviewThread[]>`, `patchsets()`, `currentHead()`), `src/server/session.ts` (supply them where it builds the source, ~`session.ts:340`), `src/server/app.ts` (routes, `parseAgentOpen`, `parseAgentMessage`), `src/server/rereview/threads.ts` (`placeAgentThreads`: it receives only what `asked()` returns, so no change is expected; add a test that a thread anchor never reaches it)
- Test: `src/server/app.test.ts` (agent routes block), `githubJoin.test.ts`

**Interfaces:**
- Consumes: Task 1's types and `AgentThreadStore`.
- Produces:

```ts
// src/server/agent/githubJoin.ts
/** The folds as the page and the runner see them: live thread conversations take GitHub's resolved; orphans become span threads. */
export function joinGithub(folds: readonly AgentThreadFold[], threads: readonly ReviewThread[]): AgentThreadFold[];
/** The span anchor an orphan falls back to: line anchor on the recorded lines at `commit`, else a file anchor. */
export function orphanAnchor(a: Extract<AgentAnchor, { subject: "thread" }>): AgentAnchor;
/** left/right of a view, from the session's patch sets and snapshot head; null for a patch set that isn't one. */
export function resolveView(view: Omit<AgentView, "left" | "right">, patchsets: readonly { number: number; head: string; mergeBase: string }[], base: string): AgentView | null;
// AgentHost gains: seen(thread: string, upTo: string): Promise<AgentThread>
```

Rules: a thread anchor whose `thread` is in `threads` → `resolved = rt.resolved`, own `agent-thread-resolved` ignored. Not in `threads` → `orphaned: true`, `anchor = orphanAnchor(...)` (a file anchor when no lines or `commit === ""`), `resolved` from its own events. `asked()` (what placement reads) returns live thread conversations **not at all** and orphans with their span anchor.

- [ ] **Step 1: Failing tests** in `githubJoin.test.ts`: "resolved follows the GitHub thread, not agent-thread-resolved", "a thread gone from GitHub becomes a span thread on its lines", "an orphan without lines or commit is a file anchor", "an orphan resolves with agent-thread-resolved", "span threads pass through unchanged", "resolveView fills left/right for a patch set and for {head}", "resolveView is null for an unknown patch set".
- [ ] **Step 2: Run; fail. Implement** `githubJoin.ts`. **Run; pass. Commit** `agent: join thread conversations with GitHub threads`.
- [ ] **Step 3: Failing route tests** in `app.test.ts`:
  - "POST agent/threads with thread opens a thread conversation" (the anchor records the review thread's path, commit, side, line, startSide, startLine; the human message stores `view` with `left`/`right` filled).
  - "POST agent/threads for a thread that has one answers 409 with its id" (body `{ thread: <agent thread id> }`).
  - "POST agent/threads with an unknown, empty or deleted thread id answers 400".
  - "POST agent/threads/:tid/messages stores view".
  - "POST agent/threads/:tid/seen marks seen; a second identical call writes nothing".
  - "POST agent/threads/:tid/resolved answers 409 for a live thread conversation and works for an orphan".
  - "GET agent/threads returns unread on span and thread conversations, and orphans as span threads".
  - "GET agent/placements leaves live thread conversations out and traces orphans".
  - "--viewer and --as-of reviews refuse a thread open" (as review buddy refuses span opens).
  - "POST agent/threads/:tid/messages answers 409 while the GitHub thread is resolved" (no new question until unresolved; one already waiting is still answered, Task 3).
- [ ] **Step 4: Run; fail. Implement** the routes and host methods. **Run; pass. Commit** `agent routes: open on a GitHub thread, view, seen; thread conversations resolve with GitHub`.
- [ ] **Step 5:** `pnpm verify:fast` green.

---

### Task 3: Prompt and runner for thread conversations (brief C; parallel with Task 4)

**Files:**
- Modify: `src/shared/agent.ts` (a `THREAD_PREAMBLE` addendum), `src/server/agent/prompt.ts` (`PromptEnvelope`, `sanitizeEnvelope`, `buildPrompt`), `src/server/agent/runner.ts` (`#drain`, `#turn`, `#store`; `RunnerFacts` gains `github(thread: string)`, `views()`, `checkHead()`), `src/server/agent/host.ts` (facts, `authorOf` with `pr_author`), `src/server/agent/checkout.ts` only if `moveTo` needs an object fetch
- Test: `src/server/agent/prompt.test.ts`, `src/server/agent/runner.test.ts`, `src/server/agent/host.test.ts`

**Interfaces:**
- Consumes: Task 1 types; Task 2's `joinGithub`, `resolveView`.
- Produces:

```ts
// prompt.ts
export interface PromptEnvelope {
  kind: "agent_thread" | "github_thread_conversation";
  review: PromptReview;
  thread: { id: string; anchor: AgentAnchor & { file: string } };
  github?: { url: string; path: string; startLine: number | null; line: number | null;
             startCol?: number; endCol?: number; openedOn: string; openedOnPatchset?: number;
             outdated: boolean; resolved: boolean;
             comments: { author: { login: string; role: "reviewer" | "pr_author" | "other" }; at: string; body: string }[] };
  view?: AgentView & { targetPatchset?: number; fromPatchset?: number };   // thread kind only
  current?: string;
  patchsets?: { number: number; head: string; mergeBase: string; startedAt: string }[];
  placement?: ThreadPlacement;
  messages: PromptMessage[];
  notice?: string;
  pr?: { title: string; body: string; files: string[] };
}
/** The answer's text without a final `[suggest-resolve]` line, and whether it had one. */
export function takeSuggestion(text: string): { text: string; suggests: boolean };
```

`THREAD_PREAMBLE` (appended to `PREAMBLE` for the thread kind) says, in this order: the conversation is about the GitHub review thread in `github`; `github.openedOn` is the commit it was opened on, `view.right` the patch set the reviewer is viewing, `current` the PR's newest head; "since the comment" is checked first in `openedOn..view.right`, and only if the answer isn't there and `current` differs, in `view.right..current`, and a fix found only there is said plainly at the start ("not in PS n; fixed later, in PS m"); the checkout starts at `view.right` and the agent may check out `current`; end the answer with a line holding exactly `[suggest-resolve]` only when the thread is resolved in `view.right`, never for a fix only in a later commit; never resolve, reply to or write to the thread. For an orphan the envelope has no `github` block and `notice` says the GitHub thread is gone.

- [ ] **Step 1: Failing prompt tests**: "a thread envelope names openedOn, view and current and lists the patch sets", "github comments, logins and path are sanitised" (HTML comment, bidi, zero-width, C0 in each), "startCol/endCol pass through from the thread's anchor, absent without them", "the thread preamble states the two-step check and the suggestion rule" (assert the substrings `openedOn..view.right`, `view.right..current`, `[suggest-resolve]`), "takeSuggestion strips a final marker line and ignores one mid-text".
- [ ] **Step 2: Run; fail. Implement** `prompt.ts` and `THREAD_PREAMBLE`. **Run; pass. Commit** `prompt: the github_thread_conversation envelope`.
- [ ] **Step 3: Failing runner tests** (fake ACP agent, fake gh scenario that moves the head):
  - "a thread turn runs checkHead and the envelope's current follows the new head while the snapshot stays".
  - "the checkout is at view.right for the turn and current's objects are reachable" (`git cat-file -e <current>` in the tree).
  - "view is the one sent with the turn's last human message; an ai-opened conversation uses the latest patch set (the snapshot head without patch sets)".
  - "the stored head is the checkout's commit when the answer ends" (the fake agent runs `git checkout <current>`; stored `head` is `current`).
  - "a final [suggest-resolve] is stripped and stored as suggests; one mid-message is not".
  - "a question waiting on a resolved GitHub thread is still answered".
  - "a commit the clone lacks is named in notice".
  - "no runner path calls the GitHub resolve or reply writers" (the runner's deps expose none; assert by spying on the session's `setThreadResolved` / reply writer across a full turn including a suggestion).
  - `host.test.ts`: "authorOf names the PR author pr_author" (fixes CAR-58).
- [ ] **Step 4: Run; fail. Implement**: `#drain` picks `waiting && (thread anchor || !resolved)` on the joined threads; `#turn` builds the thread envelope from `facts.github(id)` (the session's current read: comments, resolved, url, placement via `placeThread`), runs `facts.checkHead()` before the turn, moves the checkout to `view.right`; attaches the code window at `openedOn` as review buddy attaches the anchored hunk (the thread's `code` window may be reused); `#store` reads the checkout's HEAD for `head` and applies `takeSuggestion`. **Run; pass. Commit** `runner: thread turns at the viewed patch set, suggest-resolve, pr_author`.
- [ ] **Step 5:** `pnpm verify:fast` green; `pnpm flake-check src/server/agent/runner.test.ts` (timing and gates).

---

### Task 4: Agent button and slide-over panel (brief D; parallel with Task 3)

**Files:**
- Create: `src/web/agent/ThreadAgentButton.tsx`, `src/web/agent/ThreadAgentPanel.tsx`, `src/web/agent/threadAgent.ts` (per-card open state hook, seen writer), tests beside them
- Modify: `src/web/agent/api.ts` (`postAgentSeen`, open with `thread`, `view` on sends), `src/web/agent/agentWrites.ts` (askAgent/replyAgent carry `view`), `src/web/threads/Conversation.tsx` (`ThreadActions`: the composer switches between `ReplyBox` and the agent composer; Resolve ring), `src/web/threads/ReplyBox.tsx` (placeholder crossfade), `src/web/overview/OverviewPage.tsx` (`ThreadItem`, ~1459), `src/web/files/ThreadRow.tsx` (`ThreadBlock`), `src/web/files/ThreadFate.tsx` (`UnplacedRow`, ~407), `src/web/files/NotInComparison.tsx`, `src/web/files/resolveCollapse.ts` (unsent agent text), `src/web/files/FileTree.tsx` (unread dot), `src/web/agent/AgentOverviewRow.tsx`
- Test: `src/web/agent/ThreadAgentPanel.test.tsx`, `src/web/agent/ThreadAgentButton.test.tsx`, `src/web/files/resolveCollapse.test.ts`, `src/web/agent/AgentOverviewRow.test.tsx`

**Interfaces:**
- Consumes: Task 2's routes and types (`AgentThread.unread`, `seenUpTo`, `orphaned`, messages' `suggests`).
- Produces:

```tsx
export function ThreadAgentButton(props: { thread: ReviewThread; conversation: AgentThread | undefined; open: boolean; onToggle: () => void }): JSX.Element | null;
export function ThreadAgentPanel(props: { thread: ReviewThread; conversation: AgentThread | undefined; open: boolean; onClose: () => void; stripWidth: number }): JSX.Element;
/** The conversation for a GitHub thread id, from agentThreadsQuery. */
export function useThreadConversation(threadId: string): AgentThread | undefined;
/** The view to send: Files changed's URL comparison, or the Overview's placements comparison. */
export function useSendView(): Omit<AgentView, "left" | "right">;
```

- [ ] **Step 1: Failing component tests**:
  - Button: "dashed sparkle named Ask agent with no conversation", "count and accessible name with a conversation; accent dot and ', 1 new' when unread", "absent for an id-less, deleted, --viewer or --as-of thread", "pressed state when open".
  - Panel: "opens scrolled to its end", "the strip, the comment counter and the agent button each close it", "placeholder reads Ask agent… when open and Reply… when closed", "the card header and the composer row are outside the panel", "a 'new' divider above the first unseen message", "writes one seen when an unseen agent message is visible, none when nothing is unseen", "Resolve By Agent Suggestion shows on the latest suggesting message of an unresolved thread, resolves the GitHub thread on press (the same write as Resolve) and hides once resolved; absent on an orphan", "Resolve gets the ok ring while a suggestion stands", "sending posts the current view", "while the GitHub thread is resolved the conversation folds with it, stays readable and hides its composer".
  - `src/web/files/FileTree.test.tsx`: "the accent dot shows on a file and its folders while a conversation under them is unread".
  - `resolveCollapse.test.ts`: "unsent agent text keeps the thread open".
  - `AgentOverviewRow.test.tsx`: "counts thread conversations with span threads; unread links to the first unread".
- [ ] **Step 2: Run; fail. Implement.** The panel is absolutely positioned inside the comments' box (`inset-y-0 right-0`, `width: calc(100% - <strip>)`), `translate-x` animated with `motion-reduce:transition-none`, its list `flex-col-reverse` so it opens at the end. Reuse `AgentThreadCard`'s message list, streaming row, Stop and markdown. Open state is component state per card, not stored. Focus: the composer on open, the agent button on close.
- [ ] **Step 3: Run; pass. Commit** `web: the thread agent button and slide-over conversation`.
- [ ] **Step 4:** `pnpm verify:fast` with the phone project (layout change).

---

### Task 5: Code links, chips, unread on span threads (brief E)

**Files:**
- Modify: `src/web/agent/AgentMarkdown.tsx` (code links), `src/web/agent/AgentThreadCard.tsx` (unread dot, seen writer, the `view` chip "PS n" / short head on human messages, the `origin` chip "↳ <request>"), `src/web/files/AgentBubble.tsx` or `src/web/agent/AgentBubble.tsx` (unread dot)
- Test: `src/web/agent/AgentMarkdown.test.tsx`, `src/web/agent/AgentThreadCard.test.tsx`, `src/web/agent/AgentBubble.test.tsx`

**Interfaces:**
- Consumes: Task 4's `threadAgent.ts` seen writer; the PR's file list (`snapshot().files`) and patch sets from the session query.
- Produces: `export function codeLinkTarget(ref: { path: string; start: number; end: number }, head: string | undefined, files: ReadonlySet<string>, patchsets: readonly { number: number; head: string }[]): string | null` — the Files changed URL (`?ps=<n>` when `head` is a patch set's, else `?head=<oid>`, plus the file and line hash the router already reads), or null for a path not in the PR. Without `head` (older messages) the link opens the current view (the spec's fallback).

- [ ] **Step 1: Failing tests**: "path:line and path:start-end in inline code and bare text become router links", "a path not in the PR stays text", "a javascript: link written by the agent is dropped", "the link opens the answer's head: ps when it is a patch set's, head otherwise", "a span agent card shows the unread dot and writes seen when viewed", "an agent bubble shows the dot while a thread under it is unread", "the view chip shows PS 3 on a human message; the origin chip shows over an ai-opened first message, cut to 200".
- [ ] **Step 2: Run; fail. Implement** (the recogniser is the builder's choice; links go through the existing router, never an `href` from the agent's text). **Run; pass. Commit** `web: code links in answers, view and origin chips, unread on span agent threads`.
- [ ] **Step 3:** `pnpm verify:fast` green.

---

### Task 6: End to end, gallery, docs (brief F)

**Files:**
- Create: `e2e/thread-agent.spec.ts`; add it to `E2E_MAP` in `scripts/verify-fast.mjs` for `src/web/agent/**` and `src/server/agent/**`
- Modify: `docs/product-rules.md` (resolving is always a human action; the agent may only suggest it), `docs/design/README.md` (accent dot = unread on agent pills), `test/fake-acp/*` only if a scenario needs a final-line marker or a checkout switch
- Gallery: `case/thread-agent` and `base/thread-agent` on Gilthans/carbonless-gallery, a README row

- [ ] **Step 1: Write the e2e** (chromium and phone): "open a conversation from an Overview thread, get an answer, see the counter", "the same from Files changed", "opens scrolled to its end; closes from the strip, the comment counter and the agent button", "resolving the GitHub thread folds the conversation", "Resolve By Agent Suggestion resolves the GitHub thread (the fake gh records the write) and hides", "an unread dot appears for an answer that lands while closed and clears after viewing", "no horizontal page scroll at 360px with the panel open". Loading states with holds, never timers.
- [ ] **Step 2: Run** `pnpm test:e2e e2e/thread-agent.spec.ts`; fix until green; `pnpm flake-check e2e/thread-agent.spec.ts`.
- [ ] **Step 3: Docs.** Commit `docs: resolving stays human; unread accent on agent pills`.
- [ ] **Step 4: Gallery PR**: a thread fixed in one place but not another (the owner's "all places or just here"), then a re-push that fixes the other place, so the two-step check and the later-commit call-out can be QA'd. Description says what to look at.
- [ ] **Step 5 (coordinator):** `pnpm verify` on the combined branch (background), then the PR with `Part of`/`Fixes` lines for the Linear ticket, the branch instance and the ready report.

## Coordinator's notes (not briefs)

- Merge `origin/master` into `thread-agent` before Task 1 starts (two commits behind at plan time).
- Find or propose the Linear ticket for this slice before the first brief (ask the owner before opening one); move it to Implementation when Task 1 starts.
- After Task 4, update the mockup canvas's chip to the "Resolve By Agent Suggestion" button only if the owner asks.
