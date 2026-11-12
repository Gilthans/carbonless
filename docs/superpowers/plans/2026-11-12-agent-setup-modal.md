# Agent Setup Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent modal shows either *Setup Review Agent* (Invite / Spawn
tabs, numbered steps) or *Review Agent* (Status, Activity, Stop current,
Detach), and a configured ACP agent only runs in a review after Spawn there.

**Architecture:** The server swaps the per-review `acp-off` file for an
opt-in `acp-on` spawn flag, adds Detach, and reports `spawned`, `seen`, and
a joined session's handed thread. The web replaces `AgentSetup.tsx` with a
dialog shell that picks a view from the status (`agentView`), plus one file
per tab or view. The e2e suite spawns explicitly wherever it relied on the
auto-start.

**Tech Stack:** Fastify, React, TanStack Query, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-agent-setup-modal-design.md`
(read it in full; the mockups it links are the visual reference).

## Global Constraints

- The branch is `agent-setup-modal`, from `master` (#77 merged as b0e2033).
  Each task branches from it.
- Design principles 5, 6 and 8 (CLAUDE.md) apply:
  - Every page works at 360px with no horizontal page scroll.
  - Targets are ≥40px.
  - Icons have a tooltip and an accessible name.
  - Colours come from tokens only: yellow means pending, red means
    Detach or an error, green means Ready.
  - Loading always shows a spinner, never an empty state.
- Copy, verbatim:
  - Titles: "Setup Review Agent" and "Review Agent".
  - Tabs: "Invite" and "Spawn".
  - Invite intro: "Invite a session you already created to join the review."
  - Spawn intro: "Spawn a session to serve as your review agent".
  - Steps: "One-time setup", "Invite your agent", "Approve", "Select leash"
    and "Configure".
  - Step 2 line: "Send this instruction to your agent".
  - Empty Approve step: "No agent requesting to join".
  - Buttons: "Spawn", "Stop current", "Detach", "Restart" and "Close".
- Local storage keys: `crb.agentSetup.tab` (`"invite" | "spawn"`, default
  `"invite"`) and `crb.agentSetup.mcpHarness`. Every read and write is
  wrapped in try/catch.
- No test uses wall-clock waits. Use the existing gates and holds.
  `pnpm flake-check` covers every new spec that waits on a status change.
- Use `pnpm verify:fast` only. The coordinator runs `pnpm verify` once on
  the combined branch.

## Review Focus

1. **A review whose flag is set while the agent is `off`, `error` or
   `elsewhere` must still show Status with Detach.** That covers a
   crashed-out agent, a config that's gone, and the gap right after Spawn.
   Tested in Task 2 (`agentView`) and Task 1 (status reports `spawned`
   while off).
2. **Saving the config in one review must not start an agent in another
   review, or in this one before Spawn.** Tested in Task 1 (runner) and
   Task 3 (e2e).
3. **A Spawn whose check fails must save nothing and start nothing.**
   Tested in Task 2 (spy asserts `putAgentConfig` and `postAgentStart`
   are never called).
4. **Approving a join while the flag is set clears it before `joined.json`
   is written.** A crash between the two must never restore a join next to
   a running ACP buddy. Tested in Task 1.
5. **`localStorage` throwing (private mode) must not break the modal.**
   Tested in Task 2.

---

### Task 1: Server: per-review spawn flag, Detach, and status fields

**Files:**
- Modify: `src/server/agent/join.ts` (lines 126 and 280–300: `ACP_OFF_FILE`,
  `acpOff`, `setAcpOff`, and the approve path)
- Modify: `src/server/agent/runner.ts` (new `detach()`, `seen` tracking)
- Modify: `src/server/agent/host.ts` (`status()` at about line 133,
  `startAcp()`, new `detach()`, and the runner wiring at about line 488)
- Modify: `src/server/app.ts` (new route next to `/agent/disconnect`)
- Modify: `src/server/mcp/reviews.ts:69,106` and `src/server/mcp/routes.ts:250`
- Modify: `src/shared/agent.ts` (`AgentStatus`)
- Modify: the e2e helper in `e2e/agent-ui.ts`, so existing specs spawn
  explicitly
- Modify: docs that describe the auto-start (the spec's "Docs to update")
- Tests: `src/server/agent/{join,runner,host}.test.ts`, `src/server/app.test.ts`,
  `src/server/mcp/reviews.test.ts`

**Interfaces:**
- Produces: these exact `AgentStatus` changes in `src/shared/agent.ts`.
  Task 2 adds the same lines.
  ```ts
  // remove: acpOff?: boolean;
  /** This review's ACP spawn flag is set (Spawn pressed; cleared by Detach or an approved join). */
  spawned?: boolean;
  /** When carbonless last heard from the agent (ISO): an ACP message, an MCP tool call or watcher. */
  seen?: string;
  ```
- Produces: for a joined session holding a thread from `next`,
  `status.answering = { thread, text: "", activity: [], asked }`, built
  from `join.handedOut()`.
- Produces: `POST /api/r/:id/agent/detach` → `{ ok: true }`.
- Produces, in `JoinBroker` (`join.ts`): `spawned(): boolean` and
  `setSpawned(on: boolean): Promise<void>`. These are backed by the file
  `acp-on` in the review's agent dir. `acp-off` is no longer read.
- Produces, in `AgentRunner`: `detach(): Promise<void>`. It cancels the
  turn under way and stops the process. It then removes the checkout and
  releases the claim, and the state becomes `off`. The runner stays usable,
  unlike `close()`.
- Produces, in the review agent host: `detach(): Promise<void>`. With a
  joined session it calls `join.leave("disconnected")`. Otherwise it calls
  `setSpawned(false)` and then `runner.detach()`.
- The runner's `acpOff` dependency becomes
  `() => !join.spawned() || join.isJoined()`.
- `startAcp()` calls `setSpawned(true)` instead of `setAcpOff(false)`.
- `listJoinable`'s `deps.acpOff(id)` becomes `deps.spawned(id)`, which
  checks for `acp-on`. `buddyOf` returns `"acp"` only when
  `acp && deps.spawned(id)`.

- [ ] **Step 1: Write the failing tests.**
  - `runner.test.ts`, "a configured runner never spawns without the
    spawn flag": with a config and the flag unset, `status()` and `poke()`
    spawn nothing. A config save (bump `saves`) spawns nothing, and the
    state stays `off`.
  - `host.test.ts`, "startAcp sets the flag and spawns": after
    `startAcp()`, `status().spawned === true` and the fake agent gets
    spawned.
  - `host.test.ts`, "detach clears the flag, stops the process, releases
    the claim": after `detach()`, `spawned` is falsy, the state is `off`,
    the process is gone, and the checkout dir is gone.
  - `host.test.ts`, "detach with a joined session disconnects it":
    `status().joined` is undefined and `left.why === "disconnected"`.
  - `host.test.ts`, "status reports spawned while off": set the flag with
    no config. Expect `state === "off"` and `spawned === true`.
  - `join.test.ts`, "approving clears the spawn flag before joined.json":
    set the flag, then approve, with a filesystem spy recording the order.
    `acp-on` must be removed before `joined.json` is written.
  - `host.test.ts`, "a joined session's handed thread is answering": after
    the session's `next` hands thread T, `status().answering?.thread === T`.
  - `host.test.ts`, "seen moves": `seen` is set after an ACP message and
    after an MCP tool call, and while the ACP process is alive and idle it
    equals the status time.
  - `app.test.ts`, "POST /agent/detach answers ok and the status says off".
  - `reviews.test.ts`: `buddy` is `"acp"` only with `acp-on` present.
- [ ] **Step 2: Run them and see them fail.**
  `pnpm test src/server/agent src/server/mcp src/server/app.test.ts`.
  The new tests fail.
- [ ] **Step 3: Implement the interfaces above.**
  - Replace every use of `acpOff` and `setAcpOff`, and update the existing
    tests that asserted the old file.
  - `seen`: the runner records `now()` on every message from the ACP
    connection. The join broker records it on every tool call and watcher
    contact. `host.status()` reports the later of the two.
  - Ignore a leftover `acp-off` file. Don't delete it.
- [ ] **Step 4: Update `e2e/agent-ui.ts`.** Wherever a spec relied on the
  auto-start, it now posts `/agent/start` after opening the review, in a
  helper `spawnAgent(page)`. Run `pnpm test:e2e e2e/agent.spec.ts
  --project=chromium`. It passes.
- [ ] **Step 5: Update the docs.** The review-buddy spec's current
  behaviour, the MCP join spec's "ACP stays off until Start", and
  `docs/faq.md` if it mentions it. Confirm that `acp-on` is local review
  state, not `refs/crb`. No change to `docs/review-data-storage.md` is
  expected.
- [ ] **Step 6: Run `pnpm verify:fast` and commit.**

### Task 2: Web: the two-view modal

**Files:**
- Create: `src/web/agent/setup/AgentSetup.tsx`. The dialog shell: focus,
  Escape, backdrop, sheet on a phone (moved from today's file), and the
  view switch.
- Create: `src/web/agent/setup/agentView.ts`, which exports `agentView`.
- Create: `src/web/agent/setup/InviteTab.tsx`, `SpawnTab.tsx`,
  `StatusView.tsx`, and `parts.tsx` (`CopyRow`, `Step`, buttons, moved
  from today's file).
- Delete: `src/web/agent/AgentSetup.tsx`. Move its test to
  `src/web/agent/setup/AgentSetup.test.tsx` and rewrite it.
- Modify: `src/web/agent/setupStore.ts`, `src/web/agent/api.ts`,
  `src/web/agent/AgentChip.tsx` (lines 52 and 105), `src/shared/agentHarnesses.ts`,
  and `src/shared/agent.ts` (the same lines as Task 1).
- Tests: `src/web/agent/setup/*.test.tsx`, `AgentChip.test.tsx`,
  `JoinToast.test.tsx` (replace `acpOff` with `spawned`)

**Interfaces:**
- Consumes: Task 1's `AgentStatus.spawned`, `seen`, the joined
  `answering`, and `POST /agent/detach`.
- Produces:
  - `agentView(status: AgentStatus | undefined): "loading" | "setup" | "connected"`.
    It returns `"connected"` iff `status.joined || status.spawned`, and
    `"loading"` while `status` is undefined.
  - In `api.ts`: `postAgentDetach(): Promise<void>`, and
    `mcpLine(h: McpHarness["id"], origin: string, key: string | null): string`.
    `mcpLine` replaces `mcpAddLine`, and `"claude-code"` gives exactly
    today's `mcpAddLine` output.
  - In `agentHarnesses.ts`: `MCP_HARNESSES: readonly McpHarness[]`, with
    `McpHarness = { id: "claude-code" | "codex" | "gemini" | "other"; label: string; line(url: string): string }`.
    `"other"` returns the URL. Verify the Codex and Gemini syntax against
    their current docs, and drop either one that can't add an HTTP MCP
    server by command.
  - In `setupStore.ts`: `SetupTab = "invite" | "spawn"`.
    - `openAgentSetup()` opens on the stored tab.
    - `openInviteSetup()` and `openSpawnSetup()` open that tab and store it.
    - `setAgentSetupTab(tab)` stores it.
    - The old `openJoinSetup` callers move to `openInviteSetup`.
  - The `AgentSetup` props are unchanged except for the tab type.
    `AgentSetupHost` stays the page's mount point.
- The chip:
  - `chipPopover` is `Boolean(status?.joined || status?.spawned)`.
  - The `"off"` label is `status.configured ? "No agent · spawn or invite" : "No agent · set one up"`.

- [ ] **Step 1: Write the failing tests.**
  - `agentView.test.ts`: undefined → `"loading"`. `{state:"off"}` →
    `"setup"`. `{state:"off", spawned:true}` → `"connected"`.
    `{state:"error", spawned:true}` → `"connected"`.
    `{state:"elsewhere", spawned:true}` → `"connected"`.
    `{joined:{…}}` → `"connected"`. `{state:"ready"}` with no flag and no
    join → `"setup"`.
  - `AgentSetup.test.tsx`:
    - The title is "Setup Review Agent" for the setup view and "Review
      Agent" for the connected one.
    - A held status shows a spinner and no "No agent requesting to join".
    - The tab persists across unmount and remount through
      `crb.agentSetup.tab`.
    - With `localStorage.getItem` and `setItem` throwing, the modal
      renders on Invite and switching tabs works.
    - Pressing Codex changes the setup line to Task 2's `mcpLine("codex", …)`.
    - A `joinRequest` shows the card with name, harness and machine, and
      Approve and Decline call `answerJoin` with the request id.
    - Spawn with a check that answers `{ok:false, error, stderr}` shows
      both, and `putAgentConfig` and `postAgentStart` are never called.
    - Spawn with an ok check calls `putAgentConfig` (keeping the stored env
      for the same command), then `postAgentStart`, in that order.
    - The Leash info button's accessible name contains "anything the local
      session allows".
    - There's no Save, Remove or Check button, and no Env field.
    - Connected:
      - Stop current is disabled when there's no `answering`.
      - Stop current is disabled for `via:"mcp"`, with the tooltip "Stop it
        in the session".
      - Stop current calls `postAgentCancel` for ACP while busy.
      - Detach calls `postAgentDetach`.
      - `state:"error"` with the flag set shows Restart, which calls
        `postAgentStart`.
      - The waiting count excludes the answered thread.
      - The thread link closes the modal.
- [ ] **Step 2: Run `pnpm test src/web/agent`.** The new tests fail.
- [ ] **Step 3: Implement the files above.**
  - Follow the spec's "The two views" and the mockups.
  - Dates use `RelativeTime`.
  - The thread link reuses whatever opens a thread from the Overview
    today.
  - Spawn's sequence is check → `putAgentConfig` → `postAgentStart`.
    After that, invalidate `agentStatusQuery` and `agentConfigQuery`. The
    view switches once the status says `spawned`.
- [ ] **Step 4: Run `pnpm test src/web/agent`.** All tests pass.
- [ ] **Step 5: Run `pnpm verify:fast` and commit.**

### Task 3: E2E: setup and status flows on desktop and phone

**Files:**
- Modify: `e2e/agent-setup.spec.ts` (rewrite for the new modal),
  `e2e/agent-join.spec.ts` (Approve from step 3, Detach), `e2e/agent-ui.ts`
- Modify: `scripts/verify-fast.mjs` `E2E_MAP` if `src/web/agent/setup/`
  isn't mapped by a prefix

**Interfaces:**
- Consumes: Task 1's routes and Task 2's UI, by accessible names
  (role and name) and the test ids kept from today (`agent-setup`,
  `join-setup-line`, `join-line`).

- [ ] **Step 1: Write the specs.**
  - "a new review opens on Setup Review Agent": open the modal, see the
    title and the Invite tab, and see no agent process started (the fake
    ACP agent logs no spawn).
  - "Spawn shows the Review Agent status, Detach returns to setup": pick
    Other with the fake agent's command, press Spawn, and see "Spawned ·
    ACP" and Ready. Press Detach and see "Setup Review Agent".
  - "a failed Spawn shows the error and saves nothing": `config.json`
    stays unchanged.
  - "a config saved in one review doesn't start the agent in another":
    Spawn in review A, open review B, and B's chip says "No agent · spawn
    or invite".
  - "a join request shows in step 3 and in the bar; Approve in the modal
    connects": see "Invited · MCP" in the modal, and the bar is gone.
  - "the tab is remembered across reloads".
  - Specs that write config or read the server's files take
    `test.use({ crbServer: "own" })` (the shared-server rule in CLAUDE.md).
  - Every spec above runs in both projects. At 360px there's no
    horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`)
    on both views.
- [ ] **Step 2: Run them.**
  `pnpm test:e2e e2e/agent-setup.spec.ts e2e/agent-join.spec.ts e2e/agent.spec.ts`
  in both projects. All pass.
- [ ] **Step 3: Run `pnpm flake-check e2e/agent-setup.spec.ts e2e/agent-join.spec.ts`.**
  All 5 runs pass in both projects.
- [ ] **Step 4: Run `pnpm verify:fast` and commit.**

## Order

Tasks 1 and 2 run in parallel, and both add the same `AgentStatus` lines.
Task 3 runs on the branch once both are integrated.
