# Agent setup modal: Setup Review Agent and Status

Owner request, 2026-11-12, branching off the MCP join work (#77, CAR-81).
Mockups (desktop and phone, one interactive board):
https://claude.ai/artifact/42inoWs3XjNJeA4HwCjE9w

## Why

The agent setup modal isn't intuitive. It mixes two ways to get an agent
("Launch an agent", "Join from a session") with config editing (Save,
Remove, Check, Env), and it looks the same whether an agent is already
working on the review or not. The reviewer can't tell at a glance whether
an agent is there, what it's doing, or how to get rid of it.

The new modal has two views, chosen by one fact: **is an agent connected
to this review?**

- **No:** *Setup Review Agent*, a guided, numbered path to get one: Invite
  (MCP) or Spawn (ACP).
- **Yes:** *Review Agent*, the agent's status and activity, with Stop
  current and Detach.

## Owner decisions

- Two views, by whether an agent is connected.
- Setup view: big "Setup Review Agent" title; tabs **Invite** (MCP) and
  **Spawn** (ACP); the selected tab is remembered in local storage.
- Invite: the text "Invite a session you already created to join the
  review."; Step 1 "One-time setup" with a button per supported harness,
  each switching the MCP install command; Step 2 "Invite your agent",
  "Send this instruction to your agent" and the join line as today;
  Step 3 "Approve": "No agent requesting to join", or the approve/decline
  card with the requesting agent's details. This is **in addition to** the
  join request bar shown everywhere else.
- Spawn: the text "Spawn a session to serve as your review agent"; Step 1
  "One-time setup" (pick the harness, get its install command, as today);
  the Env section removed for now; Step 2 "Select leash", only Open, with
  a tooltip: it allows anything the local session allows, and stricter
  leashes will come; Step 3 "Configure": command and arguments, and a
  **Spawn** button. No Check button.
- The setup view's footer has only **Close**: no Save, no Remove.
- **Spawn is per review.** The configuration is still saved, but it no
  longer spawns an agent on its own. A new review has no agent until the
  reviewer chooses Invite or Spawn in it.
- Connected view: a big **Status** section (which agent, when last seen,
  etc.); an **Activity** section (what the agent is doing now:
  "Responding to thread X…" or "Idle", and the count of pending
  questions) with **Stop current**, which stops the current activity; a
  red **Detach** button that detaches the agent from the review and goes
  back to the setup view.
- The owner approved the mockups and the calls listed below as "agreed".

## Goals

- At a glance: is there an agent, which one, is it working, on what.
- One obvious path per way of getting an agent, in numbered steps.
- No agent ever starts in a review the reviewer didn't ask for one in.
- Detach is always one press from the connected view, for both kinds.

## Non-goals

- New leashes (only Open exists; the UI shows one option).
- Editing env in the UI (env already in `config.json` is preserved).
- Changing the join request bar, the toast or the chip's look. (The chip
  keeps its popover. See "Other entry points".)
- Several agents per review. Still one buddy per review.

## Anti-goals

- An agent that spawns in a review without the reviewer's press. That's
  the behaviour this change removes.
- The setup view showing while an agent is connected, or the reverse.
  The view must follow the server's status, never a client-side guess.
- Instructional prose. The steps' titles and the one-line intros are the
  only text (design principle 6).

## The two views

The modal is still a centred dialog on desktop (`min(34rem, 100vw - 2rem)`)
and a bottom sheet on a phone. Escape, the backdrop and Close all close it,
and focus goes back to what opened it, as today.

### Which view

The view follows `AgentStatus` (polled as today). *My call, settled after
the builder check:*

- **Connected:** a joined session (`status.joined`), or this review's ACP
  **spawn flag** set (a new status field, `spawned: true`), whatever the
  runner's state. The flag, not the state, decides, so that:
  - right after Spawn, before the runner takes the claim, the view is
    already Connected (state pill: Starting);
  - an agent that crashed out (`error` after two crashes) stays Connected,
    showing the red Error pill, the error and stderr, and Detach. The
    footer also gets **Restart** (`POST /agent/start` again), so a
    crash never leaves the reviewer without a way out or a way back;
  - a flag whose config is gone shows Error, "No agent configured", and
    Detach.
- **Setup:** neither.

If the status changes while the modal is open, the view switches with it:
an approved join or a Spawn moves to Connected; a Detach, or a joined
session that leaves or is lost, moves back to Setup. While the status is
still loading, a spinner shows, never an empty or "no agent" state
(principle 8).

### Setup Review Agent

The header has the sparkle icon and the title "Setup Review Agent"
(larger than today's "Your agent": 20px, bold), plus the X close button.

The tabs are **Invite** (plug icon) and **Spawn** (sparkle icon), with the
existing tablist keyboard behaviour. The tab is remembered in
`localStorage` (`crb.agentSetup.tab`, wrapped in try/catch, with Invite as
the default). An opener that asks for a specific tab, like the chip's
"Join" entry, opens that tab and also stores it. The store's tab ids are
renamed to `invite` and `spawn`.

Each step is a numbered circle and a short title. There's no other
explanatory text beyond the one-line intro under each tab.

#### Invite

1. **One-time setup.** A row of harness buttons (pressed state, ≥40px):
   Claude Code, Codex, Gemini CLI and Other. Each one switches the copyable
   line below them:
   - Claude Code: `claude mcp add --scope user --transport http crb '<origin>/mcp?key=…'`
     (today's line, with today's reload info icon).
   - Codex: its CLI command for adding a streamable-HTTP MCP server.
   - Gemini CLI: its CLI command for the same.
   - Other: just the MCP URL, with the key.

   The builder checks the Codex and Gemini syntax against their current
   docs. A harness that can't add an HTTP MCP server by command gets left
   out rather than given a guessed line. The harness list lives in one
   shared table, like `AGENT_HARNESSES`. The last harness picked is
   remembered in local storage (*my call*).
2. **Invite your agent.** "Send this instruction to your agent" above the
   copyable join line, as today.
3. **Approve.**
   - No request: a dashed row with a hollow dot and "No agent requesting to
     join".
   - A request (`status.joinRequest`): a card with a yellow (pending) edge.
     It shows the session's name, harness, machine and when it asked
     (relative time, `RelativeTime`), plus **Decline** and **Approve**.
     These use the same mutations as the join request bar, so answering in
     either one clears the other. If the request replaces a joined session,
     the card says whom it replaces, like the bar's tooltip does.
   - On Approve, the status gets `joined` and the modal switches to the
     connected view.

#### Spawn

1. **One-time setup.** The harness grid from today (Claude Code, Gemini
   CLI, Goose, OpenCode, Copilot CLI, Other), with the copyable install
   line when the harness has one. The Env section is removed.
2. **Select leash.** A single selected option, Open, with its green dot. It
   has a tooltip and accessible description: "Allows anything the local
   session allows. Stricter leashes are coming." (the owner's wording is
   the content; the exact phrasing is the builder's). The tooltip opens on
   hover, focus and tap, through the existing `Tooltip` (an info icon next
   to the option, as in the mockup).
3. **Configure.** Command and Arguments, read-only for a preset and
   editable for Other, as today. Then a **Spawn** button (the agent-colour
   CTA).

   Spawn, agreed:
   1. The button shows a spinner and "Spawning…". The other controls stay
      usable, but a second press does nothing.
   2. The config is checked (today's `POST /api/config/agent/check`).
   3. If the check fails, the error and its stderr show under the button
      (today's check error UI), **nothing is saved**, and no agent starts.
   4. If it passes, the config is saved (`PUT /api/config/agent`, keeping
      any env the stored config has for the same command, as today), then
      this review's ACP buddy is started (`POST /api/r/:id/agent/start`).
      The modal switches to the connected view once the status says so.
   5. The form opens prefilled from the saved config, as today.

The footer has only **Close**.

### Review Agent (connected)

The header has the sparkle icon and the title "Review Agent", plus X.

#### Status

A card with an agent-coloured edge. It shows:

- **Identity:** the avatar circle, the agent's name (the joined session's
  name, or the ACP agent's name and version) and how it came:
  "Invited · MCP" or "Spawned · ACP".
- **State pill:**
  - Ready: green.
  - Busy: agent colour.
  - Starting: spinner.
  - Reconnecting: yellow.
  - Error: red, with the error text (and the stderr, if any) under the card.
  - Elsewhere: "Running in another carbonless" with its port.
- **Facts**, a two-column grid that wraps to one column at phone width:
  - **Connected:** since when (`joined.since`, or the ACP buddy's start).
  - **Last seen:** the last time carbonless heard from the agent, as
    relative time, with the exact time on hover. A joined session counts
    any tool call or its watcher. An ACP agent counts any message from the
    process, and counts as "now" while the process is alive and idle.
    This needs a new `AgentStatus.seen` field (ISO time).
  - **Machine and harness** for a joined session, or the **command** for
    an ACP agent.
  - **Leash:** open.

#### Activity

The section heading shows the pending count, "N waiting": yellow when it's
more than 0, neutral at 0. It counts `status.waiting` threads, excluding
the one being answered now.

- **Busy:** a spinner, "Responding to" and a link to the thread. The link
  is its anchor (`path:line`), with the question's first line as muted
  text. Clicking it closes the modal and scrolls to the thread, as other
  thread links do.
  - ACP: the live tool-activity list from `answering.activity`, the same
    entries the thread card shows.
  - Joined session: the thread the session was handed by `next` (the
    broker's `handedOut`, which has to be added to the status). There's no
    tool list, because the session doesn't report one.
- **Idle:** a grey dot and "Idle".
- **Stop current:** cancels the current reply only (`POST /agent/cancel`
  for ACP). It's disabled while idle. Questions still waiting stay queued,
  and the agent moves on to the next one (*agreed*). For a joined session
  it is **disabled** (owner, 2026-11-12): carbonless can't interrupt a
  session's turn. Its tooltip says to stop it in the session itself.

The footer has a red **Detach** on the left and **Close** on the right.

Detach (*agreed*):
- **Joined session:** today's Disconnect (`POST /agent/disconnect`). The
  session's token ends and its watcher is dropped.
- **ACP:** a new route turns this review's ACP buddy off. Any reply under
  way is cancelled, the process stops, and the review's spawn flag is
  cleared, so it stays off across restarts until the next Spawn. Unlike
  today's off path (which keeps them for a join to come), Detach also
  releases the review's claim and removes its checkout: nothing is coming
  (*my call*).
- **Elsewhere** (another carbonless server holds this review's agent):
  Detach is allowed. Clearing the flag is review-wide, so the other server
  stops its agent on its next status poll or poke; the modal says
  "Detaching…" until the status agrees (*my call*: the flag belongs to the
  review, not the server).
- Either way, the modal goes back to the setup view once the status
  agrees. No confirm dialog (*my call*: it's easy to undo by spawning or
  inviting again, and nothing is lost: the threads stay).

## Server: no automatic spawn

Today a configured ACP agent starts in every review unless that review's
`acp-off` file is there. Approving a join creates the file, and Start
removes it. This change flips the default:

- A review's ACP buddy runs only while its per-review **spawn flag** is
  set: a file in the review's agent dir, e.g. `acp-on`, read from the file
  each time as `acp-off` is today. The flag replaces `acp-off`, and the
  old file is ignored.
- `POST /agent/start` (Spawn, and the chip's Start) sets the flag, then
  does what Start does today: a joined session leaves, and the runner is
  poked.
- **Approving a join** clears the flag. A restored join never sits beside
  a running ACP buddy. Keep today's ordering: clear the flag before
  writing `joined.json`.
- **Detach (ACP)** clears the flag, cancels the reply under way, stops
  the process, releases the claim and removes the checkout.
- **Saving the config** (`PUT /api/config/agent`) no longer starts or
  restarts anything in a review whose flag isn't set. In a review that
  has the flag, a config change restarts that review's agent, as today.
- `status.configured` keeps its meaning (a config exists).
  `status.acpOff` becomes obsolete; it is replaced by `status.spawned`
  (this review's spawn flag), which picks the view.
- Existing reviews: none has the flag, so after the upgrade none spawns on
  its own. That's the intended behaviour.

Before changing these files, check `docs/review-data-storage.md` and
`docs/gitdb-design-principles.md`. The flag lives in local review state,
not in `refs/crb`. Just confirm it.

## Other entry points

- **The chip popover** keeps Disconnect and Start. Start means Spawn with
  the saved config, one press. Its "set up" and "join" links open the
  modal on the right tab.
- **The Overview row and a waiting thread's button** open the modal. It
  shows whichever view the status says.
- **The join request bar and toast** don't change.

## Accessibility and layout

- Every button is ≥40px, and the icon-only ones have an accessible name
  and a tooltip.
- The tabs keep their tablist semantics. The step titles are `h3`. The
  approve card's buttons are real buttons.
- At 360px there's no horizontal page scroll:
  - The harness buttons wrap.
  - The Spawn harness grid goes to two columns.
  - The Command and Arguments fields stack.
  - The facts grid goes to one column.
- Colours come from the design tokens only. Yellow means pending (the
  request card, the waiting count), red is Detach and errors, and green is
  Ready.

## Tests

- **Unit, web (`AgentSetup.test.tsx`):**
  - The view follows the status in each state (`off`, `joined`,
    `joinRequest`, ACP `starting`, `ready`, `busy`, `error`, `elsewhere`).
  - The tab is remembered across openings (local storage, with a throwing
    `localStorage` too).
  - The harness buttons switch the MCP line.
  - Approve and Decline call the join mutations.
  - Spawn: a failing check saves nothing and starts nothing. A passing
    check saves, then starts.
  - Stop current is disabled while idle.
  - Detach calls the right route for each kind.
  - The leash tooltip has its accessible description.
- **Unit, server:**
  - Without the flag, a configured runner never spawns. This includes
    after a config save and after a restart.
  - Start sets the flag and spawns.
  - Detach clears it and stops the process.
  - Approving a join clears it before `joined.json`.
  - `seen` moves with ACP messages and with MCP tool calls or the watcher.
  - The handed thread shows in the status.
- **E2E (`e2e/agent-join.spec.ts`, plus a spawn spec), desktop and phone:**
  - Open a review: the setup view shows.
  - Spawn (with the fake ACP agent): the connected view shows, and Detach
    goes back to setup.
  - Invite: the request shows in step 3 and in the bar, and Approve from
    the modal leads to the connected view.
  - A config saved in one review doesn't start an agent in another.
  - Run `pnpm flake-check` on each new spec that waits on a status change.
- Update every existing test that relies on the auto-start.

## Docs to update in the same change

Anything that says a configured agent starts by itself: the review-buddy
spec's current-behaviour notes, `docs/faq.md` if it mentions it, and the
MCP join spec's "ACP stays off until Start" wording.

## Left to the builder

- Exact copy for the tooltips and the error lines.
- How `seen` is tracked internally.
- The new route's name.
- Whether to split `AgentSetup.tsx` into files per view or tab. It's 765
  lines today, so splitting is encouraged.
- The Codex and Gemini command syntax (verified against their docs).
