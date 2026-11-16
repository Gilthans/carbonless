# Review Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo each task becomes a brief (`.superpowers/sdd/review-conversation/<n>-brief.md`) for one implementer in its own worktree, branched from `review-conversation` (CLAUDE.md, "How we work").

**Goal:** One agent conversation per review about the whole review, in a drawer opened from the header agent chip, answered by the reviewer's agent through crb's MCP.

**Architecture:** A new agent-thread anchor subject `{subject: "review"}` in the existing private agent-threads ref (at most one per review, never resolved, human-opened). Since CAR-149 (#105) every agent answers through MCP `next`/`reply`; a review question is handed out by `next` with only its conversation and a generic preamble, and the agent reads everything else through MCP tools. The web moves the chip into a right-pinned header column and adds a drawer that reuses the agent conversation components.

**Tech Stack:** Fastify + git CLI (`src/server`), MCP SDK (`src/server/mcp`), React + TanStack Query + Tailwind (`src/web`), Vitest, Playwright with the fake gh and fake ACP agent.

**Spec:** `docs/superpowers/specs/2026-11-13-review-conversation-design.md` (approved by the owner 2026-11-15). Mockups: the "Review conversation mockups" canvas linked from the spec. Executors read both.

## Global Constraints

- The conversation writes only `agent-thread-opened` (human), `agent-message`, `agent-thread-seen` (human): never a reviewed mark, never a resolve (principle 2).
- No review data in what `next` returns for a review question: no PR title, body, files, GitHub threads, commits, `hunk` or `anchoredFile` (owner, 2026-11-15).
- crb never moves the agent's checkout for it (CAR-149 decision 8).
- The drawer and chip never open, pop or take focus on their own.
- Loading never looks empty (principle 8): spinner in the drawer, no count on the chip until `agentThreadsQuery` answers (`Spinner`, `src/web/Spinner.tsx`; `expectLoadingThen`).
- Tap targets ≥ 40px; no horizontal page scroll at 360px; the phone Playwright project runs for every web task (layout).
- Colours from tokens only: `agent`, `agent-edge`, `agent-ink`, `accent` (unread), `line-strong`, `raised`.
- Agent text renders only through `AgentMarkdown` (sanitised); a code link only through `useCodeLinks`.
- Storage doc (`docs/review-data-storage.md`, "Agent threads ref") updated in the same change as the format.
- Commits: `git commit --only -- <paths>`; checks with `pnpm verify:fast` and targeted specs; the full `pnpm verify` runs once on the combined branch.

## Review Focus

1. **No agent attached, conversation exists**: the chip still opens the drawer (spec tap table); a question asked then stays visibly waiting (yellow, "waiting" row), and is handed out once an agent attaches. Test in Task 6.
2. **Two tabs send the first message at once**: one conversation, both messages in it (409 → the client posts its text as a message to the existing thread). Test in Task 4.
3. **Hostile agent answer**: `<script>`, raw HTML, `javascript:` links and `../` paths in `path:line` refs render inert and never navigate outside the review. Test in Task 6.
4. **As-of or another reviewer's view** (no agent host): the chip column keeps its place, but no drawer opens and nothing posts. Test in Task 5.
5. **A code link tapped on the phone** closes the full-screen drawer and lands on the line; on desktop the drawer stays open. Test in Task 6.

---

### Task 1: The `review` subject in storage, host and routes

**Files:**
- Modify: `src/shared/agent.ts` (`AgentAnchor` :65, `OpenAgentThreadRequest` :194; new `isAgentQuestion`)
- Modify: `src/server/review/events.ts` (`parseAnchor` :773)
- Modify: `src/server/agent/store.ts` (`foldWithAliases` :118, `open` :320)
- Modify: `src/server/agent/host.ts` (`asked` :405, `open` :417, `setResolved` :481, `isQuestion` :875, `sessionNext` :635, `#view` :862, `anchoredFile` :1330, `anchorHunk` :1361)
- Modify: `src/server/agent/runner.ts` (status count :421-425, `#waitingCount` :1137, `#waiting` :1148)
- Modify: `src/server/agent/prompt.ts` (`anchorFor` :125), `src/server/agent/githubJoin.ts` (:40-66), `src/server/rereview/threads.ts` (:86, :115)
- Modify: `src/server/app.ts` (`parseAgentOpen` :1155)
- Modify: `docs/review-data-storage.md` (:269, :493)
- Test: `src/server/review/events.test.ts`, `src/server/agent/store.test.ts`, `src/server/agent/host.test.ts`, `src/server/app.test.ts`

**Interfaces:**
- Produces: `AgentAnchor` gains `| { subject: "review" }`. `OpenAgentThreadRequest` gains `review?: true` (exactly one of `span`, `thread`, `review`). `export function isAgentQuestion(t: Pick<AgentThread, "waiting" | "resolved" | "anchor">): boolean` in `src/shared/agent.ts`: `t.waiting && (subject is "thread" or "review" || !t.resolved)`. `POST /api/r/:id/agent/threads` with `{clientId, text, review: true, view?}` returns the new `AgentThread`, or 409 `{error, thread: <existing id>}` when one exists.

- [ ] **Step 1: Write failing tests**
  - events.test.ts `"parses and writes a review-subject opening"`: `parseEvent` of an `agent-thread-opened` with `anchor: {subject: "review"}` returns it unchanged; extra keys on the anchor are dropped.
  - store.test.ts `"two review openings fold into the first"`: two `agent-thread-opened` review events (different ids, second later); `foldAgentThreads` returns one review thread holding both openings' messages, id of the first. `"a resolve on a review thread is ignored on read"`: resolved event → `resolved === false`, and a later human message makes `waiting === true`.
  - host.test.ts `"opens the review conversation once"`: `host.open({clientId:"c1", text:"q", review:true})` → anchor `{subject:"review"}`, `openedBy:"human"`; a second open with `clientId:"c2"` rejects with `AgentConflictError` whose `thread` is the first id; resend with `"c1"` returns the first. `"refuses resolving the review conversation"`: `setResolved(id, true)` rejects with `AgentConflictError`. `"asked() leaves the review conversation out"`. `"an ai review opening is refused"`: `store.open({anchor:{subject:"review"}, by:"ai", ...})` rejects. `"a waiting review thread counts as waiting"`: runner status `waiting === 1` and `sessionWaiting() === 1` after the human message, also after a forced resolved event.
  - app.test.ts `"POST agent/threads takes review: true"` → 200 with the review anchor; `{review:true, span}` → 400; second open → 409 with `thread`.

- [ ] **Step 2: Run them, expect FAIL**

  Run: `pnpm test src/server/review/events.test.ts src/server/agent/store.test.ts src/server/agent/host.test.ts src/server/app.test.ts`
  Expected: the new tests fail (anchor parse returns null, no `review` in the request).

- [ ] **Step 3: Implement**
  - `parseAnchor`: a `review` branch returning `{subject: "review"}`.
  - Fold: a `byReview` slot beside `byGithub`; later review openings alias into the first kept one (events are sorted by `(ts, id)`); skip `agent-thread-resolved` for review threads.
  - Store `open`: under `#serial`, refuse an ai review opening and a second review opening (throw the store error host maps to `AgentConflictError(…, existingId)`).
  - Host: `open` takes `req.review` (anchor `{subject:"review"}`), message `"A span, a thread or the review, one of them"` otherwise; `setResolved` refuses review; `asked`, `#view`, `anchoredFile`, `anchorHunk`, `anchorFor`, `joinGithub`/`joinRead`, `agentTraceable`, `placeAgentThreads` treat review as path-less (skip / pass through). Replace host :635, :876 and runner :421-425, :1137, :1148 with `isAgentQuestion` (keep the runner's `#fenced` check). Note the runner count today excludes resolved thread conversations; with the shared predicate it counts them as `isQuestion` does: say so in the report.
  - `parseAgentOpen`: `review: true` as the third alternative.
  - Storage doc: the `review` subject, one per review (first kept on read), never resolved, human-opened; measured size of a 20-message conversation.

- [ ] **Step 4: Run tests, expect PASS** (same command), then `pnpm verify:fast`.

- [ ] **Step 5: Commit**: `git commit --only -m "agent: a review-subject conversation, one per review, never resolved" -- <files>`

### Task 2: `next` hands out a review question with a generic preamble

**Files:**
- Modify: `src/shared/agent.ts` (new `REVIEW_PREAMBLE` beside `JOINED_PREAMBLE` :258)
- Modify: `src/server/agent/prompt.ts` (`PromptEnvelope.kind` :68)
- Modify: `src/server/agent/host.ts` (`sessionNext` :624-701, `sessionReply` :728)
- Test: `src/server/agent/host.test.ts`, `src/server/agent/prompt.test.ts`, `src/server/mcp/routes.test.ts`

**Interfaces:**
- Consumes: Task 1's `{subject:"review"}` and `isAgentQuestion`.
- Produces: for a review thread, `sessionNext` returns `SessionQuestion` with `preamble: REVIEW_PREAMBLE`, `envelope: {kind: "review_conversation", thread: {id, anchor: {subject:"review"}}, messages}`, `anchoredFile: null`, `hunk: null`. `PromptEnvelope.kind` gains `"review_conversation"`.

- [ ] **Step 1: Write failing tests**
  - host.test.ts `"next hands out a review question with no review data"`: open a review conversation, approve a joined session, `sessionNext(token)`: `envelope.kind === "review_conversation"`, `envelope.messages.at(-1).text === "q"`, `anchoredFile === null`, `hunk === null`, `preamble === REVIEW_PREAMBLE`, and `JSON.stringify(result)` contains none of the stub facts' title, body, a file path, a GitHub thread id, base or head OID. Same assertions for a spawned session (`spawnedHolds`).
  - `"reply answers the review question"`: `sessionReply` stores an ai `agent-message` with `replyTo`; `waiting` becomes false; no `suggests` parsing.
  - routes.test.ts `"a review question goes through next and reply over MCP"`: `ask` with `review: true`, `next`, `reply`, then `GET agent/threads` shows the answer.
  - prompt.test.ts: `sanitizeEnvelope` keeps a `review_conversation` envelope's messages and fences nothing it doesn't own.

- [ ] **Step 2: Run, expect FAIL**: `pnpm test src/server/agent/host.test.ts src/server/agent/prompt.test.ts src/server/mcp/routes.test.ts`

- [ ] **Step 3: Implement** a `sessionReviewTurn` beside `sessionSpanTurn` that builds only the envelope above. `REVIEW_PREAMBLE`: generic, short like `JOINED_PREAMBLE`, saying the question is about the whole review; find what you need with crb's tools (name `review`, `threads` and Task 3's tools) and your checkout; answer with `reply`; cite code as `path:line`; no pushing, no GitHub writes, no review changes. The wording is the implementer's.

- [ ] **Step 4: Run, expect PASS**, then `pnpm verify:fast`.

- [ ] **Step 5: Commit**: `"agent: next hands out the review conversation with generic instructions"`

### Task 3: MCP read tools for the review's GitHub threads and progress

The owner (2026-11-15): "We can figure out the details of the MCP exposed data as we go." Before writing code, the coordinator checks whether the session extending the MCP (step 2 of `2026-11-13-spawned-agent-mcp-design.md`) has added or designed these; reuse theirs if so. Otherwise this task proposes the two tools' input/output to the owner in one short message, then builds them.

**Files:**
- Modify: `src/server/mcp/server.ts` (register after `review` :393)
- Modify: `src/server/agent/host.ts` (session methods behind them; `ReviewAgentSource` :1079)
- Modify: `src/server/session.ts` (`#makeAgent` :345: a fresh GitHub read of every thread with comments, `OverviewRead.threads` / `comments`)
- Modify: `test/fake-acp/agent.mjs` tool list; `src/server/mcp/routes.test.ts:148-170` tool names
- Test: `src/server/mcp/routes.test.ts`, `src/server/agent/host.test.ts`

**Interfaces:**
- Produces (names provisional until the owner agrees): `github_threads` → every PR review thread: id, url, path, line span, commit, `resolved`, `outdated`, and comments (author, role, date, body through `sanitizeThirdParty`), read fresh, `{unavailable: true}` when GitHub can't be read (never `[]`). `progress` → the comparison on screen with the review conversation's latest human message (`view`), and what the reviewer has marked reviewed.

- [ ] **Step 1: Write failing tests**: each tool refuses a bad token (`unknown-token`); returns only this review's data; `github_threads` with a held/failed fake gh read returns `unavailable`, never an empty list; a comment body `"<script>…"` / an injected instruction comes back fenced by `sanitizeThirdParty`; `resolved` reflects a change made on GitHub after the session's last read; `progress` returns the `view` the drawer sent.
- [ ] **Step 2: Run, expect FAIL**: `pnpm test src/server/mcp/routes.test.ts src/server/agent/host.test.ts`
- [ ] **Step 3: Implement** with the `registerTool` / `tokenHost` / `run` pattern; descriptions short like the existing tools'. Add both names to `REVIEW_PREAMBLE`.
- [ ] **Step 4: Run, expect PASS**, then `pnpm verify:fast`.
- [ ] **Step 5: Commit**: `"mcp: read the PR's GitHub threads and the reviewer's progress"`

### Task 4: Web data: the review conversation hook, the write, and keeping it out of every list

**Files:**
- Create: `src/web/agent/reviewConversation.ts`
- Modify: `src/web/agent/agentWrites.ts` (beside `askAgentOnThread` :201)
- Modify: `src/web/agent/placeable.ts` (`shownAgentPlaceables` :150, `agentPlaceable` :12), `src/web/agent/AgentOverviewRow.tsx` (:47-48), `src/web/agent/AgentBubble.tsx` (:17), `src/web/files/FilesPage.tsx` (`agentIds` :1100), `src/web/agent/setup/StatusView.tsx` (`Activity` :311, shows the drawer's thread as "Whole review")
- Test: `src/web/agent/reviewConversation.test.ts`, existing tests of the touched files

**Interfaces:**
- Consumes: Task 1's route and anchor.
- Produces: `export function reviewConversation(list: AgentThread[]): AgentThread | undefined` (the one with `anchor.subject === "review"`); `export function useReviewConversation(): {thread: AgentThread | undefined; loading: boolean; failed: boolean}` (from `agentThreadsQuery`); `export function askReview(client: QueryClient, text: string, clientId: string, view?: SendView): Promise<AgentThread>`: posts `{review: true}`, on 409 posts the text as a message to the returned `thread` id and returns that thread.

- [ ] **Step 1: Write failing tests**: `reviewConversation` picks the review thread out of a mixed list; `askReview` on 409 sends one `postAgentMessage` to the existing id with the same `clientId` (two tabs → one conversation, Review Focus 2); `shownAgentPlaceables`, `AgentOverviewRow` counts, `agentBubbleLabel` and FilesPage's placement ids ignore a review thread (it never reaches `/agent/placements`).
- [ ] **Step 2: Run, expect FAIL**: `pnpm test src/web/agent`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, then `pnpm verify:fast`.
- [ ] **Step 5: Commit**: `"web: the review conversation's data; it stays out of thread lists and counts"`

### Task 5: The chip in its own right-pinned header column

**Files:**
- Modify: `src/web/App.tsx` (header :437-716: `agent-chip-slot` :470-476 moves to a right column after `header-title`; `agent-chip-row-slot` :575-581 moves after Settings in the compact row; `useChipDock` :207, `ChipSpace` :272)
- Modify: `src/web/agent/AgentChip.tsx` (`CHIP_BOX` :221, `CHIP_FACE` :228, click :359-362, `ChipPanel` popover :136-204 and :398-432 removed, `useAgentChipPlace` :237)
- Create: `src/web/agent/drawerStore.ts`
- Test: `src/web/agent/AgentChip.test.tsx`, `e2e/mobile.spec.ts`, `e2e/agent.spec.ts` (chip assertions that change)

**Interfaces:**
- Consumes: Task 4's `useReviewConversation`.
- Produces: `drawerStore.ts`: `openReviewDrawer()`, `closeReviewDrawer()`, `toggleReviewDrawer()`, `useReviewDrawerOpen(): boolean` (module store like `setupStore.ts`, not persisted). The chip has `aria-expanded` and `aria-controls="review-conversation"`.

Layout (spec "The header chip", mockup artboards 1 and 4): header row = logo | title block | chip column. Column `w-10` (40px), always reserved, right edge aligned with the content edge, vertically centred on the title block like the logo; the title wraps between. Face: 32px circle (`h-8 w-8 rounded-full border`), `border-line-strong bg-raised`; pressed while the drawer is open: `border-agent-edge bg-agent`. Count badge on the lower-right corner (`agent-ink` on `bg-agent`, `border-agent-edge`, ~16px tall) once the conversation has messages; for a joined session the plug sits inside the badge before the number (the plug alone with no messages). Unread dot top-right (`bg-accent`, 10px) while an agent message is unseen. In the compact scrolled row the chip is the rightmost item. Status colour, sparkle and `agentTip` unchanged; the accessible name adds "N messages" and "unread".

Tap: an agent configured, a session joined, or a review conversation existing → `toggleReviewDrawer()`; otherwise `openAgentSetup()`. The Disconnect popover goes (Detach stays in the status modal).

- [ ] **Step 1: Write failing tests**: AgentChip.test.tsx: each tap-table row; count badge text and absence before messages; unread dot; plug inside the badge when joined; pressed classes and `aria-expanded` with the drawer open; while `agentThreadsQuery` is held: no badge, no "0"; as-of (`asOf`): column reserved, tap does nothing that opens the drawer (Review Focus 4). Playwright (desktop + phone): the chip's box is right of the `#number` and its right edge within 1px of the Settings button's right edge (desktop); at 360px no horizontal page scroll and the chip ≥ 40px.
- [ ] **Step 2: Run, expect FAIL**: `pnpm test src/web/agent/AgentChip.test.tsx` and `pnpm test:e2e e2e/mobile.spec.ts e2e/agent.spec.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, then `pnpm verify:fast` (phone project on).
- [ ] **Step 5: Commit**: `"web: the agent chip gets a right-pinned column, a count badge and an unread dot"`

### Task 6: The drawer

**Files:**
- Create: `src/web/agent/ReviewConversationDrawer.tsx`
- Modify: `src/web/App.tsx` (mount the drawer; the page, header included, narrows by the drawer's width on wide desktop; lift `SendViewProvider` around `<main>` and the drawer)
- Modify: `src/web/files/FilesPage.tsx` (:1334-1342: publish the comparison to the lifted provider instead of providing it locally), `src/web/agent/threadAgent.ts` (`SendViewProvider` :150 gains a setter)
- Modify: `src/web/agent/AgentThreadCard.tsx` (reuse `AgentMessageItems` :643 as is; extract nothing unless needed)
- Create: `e2e/review-conversation.spec.ts`; map it in `scripts/verify-fast.mjs` `E2E_MAP` (:79-91) for `src/web/agent/` and `src/server/agent/`
- Test: `src/web/agent/ReviewConversationDrawer.test.tsx`, `e2e/review-conversation.spec.ts`

**Interfaces:**
- Consumes: `useReviewDrawerOpen`/`closeReviewDrawer` (Task 5), `useReviewConversation`/`askReview` (Task 4), `AgentMessageItems`, `useSeenWriter`, `AgentMarkdown`, `postAgentCancel`, `openAgentSetup`.
- Produces: `<ReviewConversationDrawer />` with `id="review-conversation"`, `role="dialog"` on phone / `complementary` on desktop, `aria-label="Whole review conversation"`.

Layout (artboards 2 and 5): desktop ≥ the builder's breakpoint: fixed full height on the right, ~480px, the page narrows (pushes, never covers: memory rule "bars push, not cover"); narrower desktop: overlays; phone: full screen. Header: sparkle, "Whole review", count, status button (pulse icon, `aria-label="Agent status"`, `openAgentSetup()`), close (`aria-label="Close"`). Body: `AgentMessageItems` with the "new" rule, activity line and Stop; opens scrolled to "new" or the end; seen via `useSeenWriter`. Empty conversation: composer focused, no message list. Composer "Ask agent…", Ctrl/Cmd+Enter sends, sends `useSendView()`. Escape and the close button close it; focus returns to the chip. Loading: `Spinner` with `aria-busy`, no empty state. A keyboard shortcut toggles it (key is the builder's; listed in the shortcuts help if there is one).

- [ ] **Step 1: Write failing tests**
  - Drawer unit: while held: spinner, no composer-empty state; empty: composer focused; with messages: scrolled to "new"; status button calls `openAgentSetup`; Escape closes and focuses the chip; the message sent carries the lifted `view` from Files changed when asked from Overview.
  - e2e (fake ACP, desktop + phone): tap chip → drawer → ask → answer shown with the spawned chip and activity → close → a later answer gives the unread dot → reopen at "new". No agent attached (detached): the drawer still opens and the asked question shows waiting; spawn → it is answered (Review Focus 1). A fake answer with `<script>`, `<img onerror>`, `[x](javascript:…)` and `../../etc/passwd:1` renders inert, no navigation outside `/r/<id>` (Review Focus 3). A `src/calc.ts:3` link: desktop → Files changed at the line, drawer open; phone → drawer closed, at the line (Review Focus 5). Coverage counts unchanged after the conversation. 360px: no horizontal scroll.
- [ ] **Step 2: Run, expect FAIL**: `pnpm test src/web/agent/ReviewConversationDrawer.test.tsx` and `pnpm test:e2e e2e/review-conversation.spec.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; `pnpm flake-check e2e/review-conversation.spec.ts` (timing and held reads); `pnpm verify:fast`.
- [ ] **Step 5: Commit**: `"web: the review conversation drawer"`

### Task 7: Gallery case

**Files:** Gilthans/carbonless-gallery: branches `base/review-conversation`, `case/review-conversation`, a PR, a README row.

- [ ] **Step 1:** A small PR with four review threads: three resolved, one of them resolved but not fixed in code, and one unresolved that the code already addresses. The description says what to ask ("go over all review comments and tell me if they were truly resolved or not") and what a right answer names.
- [ ] **Step 2:** Open it in a branch instance and check the drawer, chip and answer by hand; link it in the ready report.

---

Order: Task 1 → Tasks 2, 3, 4 (parallel) → Task 5 → Task 6 → Task 7. Tasks 5 and 6 both touch `App.tsx`; 6 rebases on 5.
