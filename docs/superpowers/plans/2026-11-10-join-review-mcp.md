# Join a review through MCP: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent session carbonless didn't launch joins a review as its buddy through crb's own `/mcp`, after the reviewer approves, and answers waiting and new agent-thread questions while a background `curl` watcher keeps it informed.

**Architecture:** A per-review `JoinBroker` (server memory plus two small files in the review's agent dir) owns join requests, tokens, presence and the "ACP off" flag; `AgentHost` routes status and answers through it and keeps the ACP runner off while a session is joined. `/mcp` is a stateless Streamable HTTP MCP server mounted on Fastify; every tool after `attach` takes the token as an argument. `/mcp/watch/:review` is a long-held GET that is the session's keep-alive. The web shows the pending request as a bar on the review's pages, the joined session on the chip, and a toast when it leaves.

**Tech stack:** Fastify 5, `@modelcontextprotocol/sdk` (new dependency, exact version pinned, published at least 14 days ago), React + TanStack Query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-join-review-mcp-design.md` (approved 2026-11-10). Read it first; this plan only adds the decisions the spec leaves open.

## Global constraints

- Timers (from the spec): join request expiry 10 min; `attach` with `request` waits up to 20 s for an answer; watcher keep-alive byte every 15 s; watcher grace window 60 s; a handed-out thread with no reply and no watcher for 10 min detaches the session; an ACP turn running at Approve gets 30 s, then is cancelled.
- Token: 256-bit random (`randomBytes(32).toString("base64url")`), only its sha256 is stored; compared constant-time.
- Identity strings (`name`, `machine`, `harness`): sanitised with `sanitizeThirdParty` (`src/server/agent/prompt.ts`), capped at 80 chars each; `machine` falls back to the request's remote address.
- Reply text cap 32 KiB, as today (`capText`, `src/server/agent/store.ts`).
- Nothing about a review's inside (threads, code, PR body) reaches a session before Approve; `reviews()` and `attach` are the only tools that work without a token.
- `/mcp` and `/mcp/watch/*` stay behind the access key (`registerAccessKey`, `?key=` works) and the Host check; no exemption.
- No `gh` call from `reviews()` or `attach` beyond what opening a review already does (`registry.get`).
- Joined-session state is never written to git (GitDB 10). Files: `<agentsDir()>/<review-id>/joined.json` (token hash, identity, since) and `<agentsDir()>/<review-id>/acp-off` (empty marker).
- `--viewer` and `--as-of` reviews: `attach` refuses with code `no-agent`; `reviews()` lists them with `joinable: false, reason`.
- UI: principle 5 (360 px, 40 px targets), 6 (icons with tooltip and accessible name, tokens only, `RelativeTime` for times), 8 (no empty-looking loading). New top bar pushes the page down and is sticky (as the find bar); header buttons stay hittable.
- Tests: no wall-clock bounds; fake timers or holds. `pnpm flake-check` on every watcher, timer and gate test.

## Review focus

1. **A watcher that drops mid-delivery** (the line is written but the socket dies before curl reads it): the thread must stay waiting and be delivered again on reconnect. Test in Task 1 (broker) and Task 2 (route).
2. **Two tabs press Approve and Deny at once**: first press wins, the second gets 409 and its bar disappears; never two tokens. Test in Task 1.
3. **crb restarts while a session is joined** (the 4747 deploy): `joined.json` restores the attachment as `reconnecting`, a watcher back within 60 s makes it `listening`, else it leaves as `lost` with a toast. Test in Task 1.
4. **A reviewer reply lands while the session is answering** the same thread: the session's `reply` carries `replyTo` = the human message it was handed, so the newer message still waits (the existing fold rule). Test in Task 2.
5. **A session's `reply` to a thread it wasn't handed, or after it left**: refused (`not-handed` / `unknown-token`), nothing stored. Test in Task 2.

---

### Task 1: Server core: the join broker, status, ACP off

**Files:**
- Create: `src/server/agent/join.ts`, `src/server/agent/join.test.ts`
- Modify: `src/shared/agent.ts` (types), `src/server/agent/host.ts` (`AgentHost` and `reviewAgentHost`), `src/server/agent/runner.ts` (gate on ACP off; a `stop()` that lets the running turn finish up to 30 s), `src/server/app.ts` (three UI routes), `src/server/agent/store.ts` (accept `via`/`machine` on `agent`), `src/server/agent/host.test.ts`, `src/server/agent/runner.test.ts`

**Interfaces (produces):**

```ts
// src/shared/agent.ts
export type AgentState = "off" | "starting" | "ready" | "busy" | "error" | "elsewhere" | "reconnecting";
export interface AgentIdentity { name: string; version: string; via?: "acp" | "mcp"; machine?: string }
export interface JoinIdentity { name: string; machine: string; harness?: string }
export type JoinLeave = "detached" | "disconnected" | "lost" | "replaced";
export interface AgentStatus { /* existing fields */
  via?: "acp" | "mcp";
  joined?: JoinIdentity & { since: string };
  joinRequest?: JoinIdentity & { id: string; at: string };
  left?: JoinIdentity & { why: JoinLeave; at: string };
  acpOff?: boolean;
}
export const JOIN = { expiryMs: 600_000, attachWaitMs: 20_000, keepAliveMs: 15_000, graceMs: 60_000, busyMs: 600_000, acpStopMs: 30_000 } as const;

// src/server/agent/join.ts
export type AttachOutcome =
  | { state: "pending"; request: string }
  | { state: "denied" | "expired" }
  | { state: "approved"; token: string };
export class JoinBroker {
  constructor(deps: { dir: string; now?: () => number; onApproved: () => Promise<void>; onLeft: (why: JoinLeave) => void });
  restore(): Promise<void>;                       // reads joined.json → presence "reconnecting", starts the grace timer
  request(who: JoinIdentity): { request: string }; // replaces any pending one
  outcome(request: string, waitMs: number): Promise<AttachOutcome>; // resolves early on answer
  answer(request: string, approve: boolean): Promise<void>;          // throws StaleJoinRequestError (409) unless it is the pending one
  check(token: string): boolean;
  handOut(thread: string, asked: string | undefined): void;          // presence → busy
  handedOut(): { thread: string; asked: string | undefined } | null;
  replied(thread: string): void;                                      // clears the hand-out
  watcher(token: string): WatchLease | null;                         // null: bad token
  leave(why: JoinLeave): void;                                        // revokes, closes watchers, clears hand-out, deletes joined.json, records `left`
  view(): Pick<AgentStatus, "via" | "joined" | "joinRequest" | "left"> & { presence?: "listening" | "busy" | "reconnecting" };
  acpOff(): boolean; setAcpOff(off: boolean): Promise<void>;
}
export interface WatchLease { deliver: Promise<void>; close(): void }  // `deliver` resolves when broker.wake() finds a question; close() on socket end
// JoinBroker.wake(): called by AgentHost when a human asks; resolves the open lease's `deliver`.
```

`AgentHost` gains `join: JoinBroker`, and: `status()` overlays `broker.view()` (joined: `state` = `ready` when listening, `busy` when busy, `reconnecting`; `agent` = `{ name, version: harness ?? "", via: "mcp", machine }`); `open`/`message` call `broker.wake()` instead of `runner.asked()` while joined; `startAcp()` clears ACP off and pokes the runner; `disconnect()` = `broker.leave("disconnected")`. `onApproved` = leave any current join as `replaced`, `setAcpOff(true)`, `runner.stop(JOIN.acpStopMs)`. Routes (all under `/api/r/:id/`, writes with the existing Origin/key checks): `POST agent/join/:request` `{approve: boolean}`, `POST agent/disconnect`, `POST agent/start`.

- [ ] **Step 1: Write failing broker tests** in `join.test.ts` (fake timers, temp dir): `request` then `answer(approve)` → `outcome` resolves `approved` with a token that `check` accepts and a different one rejects; a second `request` replaces the first (old id → `answer` throws `StaleJoinRequestError`); `answer` twice → second throws (Review focus 2); expiry after `JOIN.expiryMs` → `expired`; `outcome` resolves `pending` after `waitMs` with no answer, and resolves early when answered while waiting; watcher lease open → `view().presence === "listening"`; `wake()` resolves `deliver`; lease closed without delivery → `reconnecting`, then after `graceMs` `onLeft("lost")` and `left.why === "lost"`; `handOut` then no reply and no watcher for `busyMs` → `lost`; `leave("detached")` clears `handedOut()` and invalidates the token; `restore()` from a `joined.json` → `reconnecting`, a lease within `graceMs` → `listening` (Review focus 3); `acp-off` survives a new broker on the same dir.
- [ ] **Step 2: Run** `pnpm test src/server/agent/join.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `JoinBroker`** in `join.ts`. One pending request, one joined session, at most one open lease (a new lease closes the old one with 409).
- [ ] **Step 4: Run** the broker tests → PASS.
- [ ] **Step 5: Failing host/runner tests:** with a joined session, `status()` shows `via: "mcp"`, `joined`, state `ready`; approving while an ACP turn runs waits for it (held fake ACP) and cancels after `acpStopMs`; with `acp-off` the runner never spawns on status poll, new question, config save or a new runner on the same dir; `startAcp()` spawns again; `left` appears in status after `disconnect()`; a store `agent-message` with `agent.via = "mcp"` and `machine` round-trips through the fold.
- [ ] **Step 6: Implement** the host overlay, `runner.stop(ms)`, the ACP-off gate in `runner.poke`/`status`, the store field, the three routes.
- [ ] **Step 7: Run** `pnpm verify:fast` → green.
- [ ] **Step 8: Commit** (`git commit --only -- <paths>`), message `join: broker, status and ACP off (CAR-81)`.

### Task 2: The MCP door and the watcher

Depends on Task 1.

**Files:**
- Create: `src/server/mcp/server.ts` (tool definitions), `src/server/mcp/routes.ts` (Fastify mounting, watch route), `src/server/mcp/reviews.ts` (`listJoinable`), `src/server/mcp/*.test.ts`
- Modify: `src/server/agent/prompt.ts` (shared envelope builder, `JOINED_PREAMBLE`), `src/server/agent/runner.ts` (use the shared builder), `src/shared/agent.ts` (`JOINED_PREAMBLE` next to `PREAMBLE`), `src/server/app.ts` (register), `package.json`

**Interfaces:**
- Consumes: Task 1's `AgentHost.join`, `JoinBroker`, `JOIN`, `AgentIdentity.via/machine`.
- Produces:

```ts
// prompt.ts
export async function threadEnvelope(facts: RunnerFacts, thread: AgentThreadFold, opts: { viewer?: string; withPr: boolean; notice?: string; tree: boolean }): Promise<PromptEnvelope>;
// mcp/reviews.ts
export interface JoinableReview { link: string; repo: string; pr: number; title?: string; author?: string; branch?: { head: string; base: string }; state?: "open" | "draft" | "merged" | "closed"; lastActivity: string; progress: { reviewed: number; total: number } | null; buddy: "none" | "acp" | "joined" | "pending"; joinable: boolean; reason?: string }
export function listJoinable(origin: string, query?: string): Promise<JoinableReview[]>; // newest lastActivity first, cap 50
// mcp/routes.ts
export function registerMcp(app: FastifyInstance, deps: { registry: SessionRegistry; reviews: typeof listJoinable }): void;
```

Tools (names and argument names are the contract the docs and e2e use): `reviews({query?})`, `attach({review, name, machine?, harness?, request?})`, `next({token})`, `reply({token, thread, replyTo, text})`, `threads({token})`, `review({token})`, `detach({token})`. Every tool description states its next step (`attach`: "The reviewer must approve; tell them to open the link and press Approve, then call attach again with `request`"; approved reply: "Run `watch` in the background; when it exits, call `next`, answer with `reply`, then run `watch` again"). The approved `attach` result carries `watch`: the shell loop from the spec with the review's `/mcp/watch/<id>?key=<key>` URL on the origin the request came in on (the key from the request's own `?key=` or cookie; none on loopback), and `instructions`.

`next` returns the oldest waiting unresolved thread as `{ preamble: JOINED_PREAMBLE, envelope, anchoredFile: {path, commit, text} | null, hunk: string | null }` (`tree: false`, `withPr` on the first `next` of an attachment), and hands it out; while one is handed out, `next` returns the same one. Title/branch/state in `reviews()` come from the Home service's cached PR facts when present, omitted otherwise (never a fresh `gh` call). The MCP transport is stateless (`sessionIdGenerator: undefined`), so a crb restart needs no MCP re-initialise. A server that doesn't hold the review's agent claim (`claim.ts`) refuses `attach` with code `elsewhere` and the holder's port in the message.

- [ ] **Step 1: Failing tests** (Fastify `inject` + the SDK's client over an in-process HTTP server): without a key on a keyed server → 401; `reviews()` lists started reviews newest first with `link` on the request's origin, an as-of review `joinable: false`, and the fake gh records no call; `next` without a valid token → error `unknown-token`; full flow: `attach` → `pending` with the link in `message` → host `answer(approve)` → `attach({request})` → `approved` with `token` and `watch`; `next` → envelope with no `tree`, `anchoredFile` text at the anchor commit, `hunk`; `reply` stores an `ai` message with `replyTo`, `agent.via: "mcp"`, `machine`; a human message added after `next` stays waiting after `reply` (Review focus 4); `reply` to another thread → `not-handed` (Review focus 5); `detach` → token dead, status `left.why: "detached"`; watcher: connects → `listening`; a waiting question → one line then close (exit 0 shape); keep-alive byte after 15 s (fake timers); revoked token → 410; socket destroyed after the line → thread still waiting and redelivered on reconnect (Review focus 1).
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Add the dependency** (`pnpm add @modelcontextprotocol/sdk@<exact>`), extract `threadEnvelope` from `runner.#turn` (runner tests stay green), add `JOINED_PREAMBLE` (the spec's wording change), implement `listJoinable`, the tools and the routes (`reply.hijack()` then `transport.handleRequest(request.raw, reply.raw, request.body)`).
- [ ] **Step 4: Run** `pnpm verify:fast` → green; `pnpm flake-check src/server/mcp/routes.test.ts`.
- [ ] **Step 5: Commit**, message `join: the MCP door and the watcher (CAR-81)`.

### Task 3: Web: request bar, chip, toast, setup tab

Depends on Task 1 (status shape and routes). Parallel with Task 2.

**Files:**
- Create: `src/web/agent/JoinBar.tsx`, `src/web/agent/JoinToast.tsx`, tests next to them
- Modify: `src/web/agent/api.ts` (approve/deny/disconnect/start mutations), `src/web/agent/AgentChip.tsx` (plug badge, joined popover with Disconnect, Start when `acpOff`), `src/web/agent/AgentSetup.tsx` ("Join from a session" tab), `src/web/App.tsx` (mount bar and toast on every review page; title prefix), `src/web/index.css` only if a token is missing, `e2e/agent-join.spec.ts` (new), `scripts/verify-fast.mjs` (`E2E_MAP`)

**Interfaces:** Consumes `AgentStatus.joinRequest/joined/left/acpOff/via` and the three routes from Task 1. Copy (exact): bar `"{name}"` + `"{machine}"`, buttons Deny / Approve (Approve tooltip `Replaces {agent.name}` when an ACP agent is running); toast `"{name} left"` (detached, disconnected by you), `"{name} disconnected"` (lost), `"{name} replaced"`; title prefix `"⏚ "`; setup tab label "Join from a session" with two copy rows: `claude mcp add --transport http crb "<origin>/mcp?key=<key>"` and `join the carbonless review at <origin>/r/<id>`. Icon: octicon plug (as the repo imports octicons), with tooltip and accessible name.

- [ ] **Step 1: Failing component tests:** bar renders from `joinRequest`, Approve/Deny post once per press and hide on 409; toast fires once per `left.at` per tab, including a `left` seen on the first poll after the tab was hidden if `at` is newer than the tab's load; chip shows the plug badge and the session name when `via === "mcp"`, popover Disconnect posts; Start shows only with `acpOff` and a config; title prefix while `joinRequest` and the tab is hidden.
- [ ] **Step 2: Implement** the components and wiring.
- [ ] **Step 3: Failing e2e** (`e2e/agent-join.spec.ts`, desktop and phone, driving `/mcp` with the SDK client from the test): attach → bar shows name and machine on Files changed and Overview → Approve → chip shows the session; Disconnect → toast "… left", waiting dot back, ACP not restarted; bar pushes the header down and header buttons stay hittable (`elementFromPoint`) at 360 px. Use holds, not timing.
- [ ] **Step 4: Run** `pnpm verify:fast` (with the phone project: layout change) and `pnpm flake-check e2e/agent-join.spec.ts`.
- [ ] **Step 5: Commit**, message `join: request bar, chip, toast and setup tab (CAR-81)`.

### Task 4: End to end, docs, and the mid-session check

Depends on Tasks 2 and 3.

**Files:** `e2e/agent-join.spec.ts` (extend), `docs/faq.md`, `docs/review-data-storage.md`, `docs/product-rules.md`, `docs/superpowers/specs/2026-11-04-review-buddy-design.md` ("Later" → this spec), `README.md` if it lists MCP setup.

- [ ] **Step 1: e2e, full loop:** a test MCP client attaches, the test approves in the page, the client runs the returned watch URL with `fetch` (stream), a question asked in the page wakes it, `next`/`reply` lands the answer in the card under the session's name; the client drops the watcher → chip `reconnecting`, then (fake server clock via an env hook, or a test-only short grace through an env var read once at start) `disconnected` toast.
- [ ] **Step 2: Mid-session check:** in a scratch dir, start a Claude Code session, run `claude mcp add` from another shell, and record whether `/mcp` in the running session picks up the server without a restart. Write the answer and the steps in `docs/faq.md`.
- [ ] **Step 3: Docs** per the spec's "Docs to update" (FAQ: joining, setup line, what carbonless doesn't enforce on a joined session, restart behaviour; storage: `via`, `machine`; product rules: approval before any join, ACP stays off after a joined session leaves).
- [ ] **Step 4: Run** `pnpm verify:fast`; the coordinator runs the full `pnpm verify` before the PR.
- [ ] **Step 5: Commit**, message `join: end-to-end test and docs (CAR-81)`.

## Execution

Coordinator flow per CLAUDE.md: one brief per task, one implementing agent per brief in its own worktree branched from `car-81-mcp-buddy`, a fresh reviewer per change, fix rounds, cherry-pick onto `car-81-mcp-buddy`. Tasks 2 and 3 run in parallel once Task 1 is merged into the branch.
