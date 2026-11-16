# Review conversation: one agent conversation about the whole review

Status: approved by the owner 2026-11-15 ("spec looks good - let's move forward to implementation"), builder-checked; owner answers folded in. Calls the coordinator made (the owner may
overrule) are marked **(call)**.

Mockups (desktop and phone, drawn over screenshots of the live UI): the
"Review conversation mockups" canvas linked from the report.

## Why

The review buddy (#30) answers questions anchored on a span, and the thread
agent (#76) answers questions about one GitHub thread. Some questions span
the whole review and have no line to hang on. The owner:

> "I'd like us to implement a general question/conversation that can be
> triggered from the main AI modal assuming it is setup. it should look
> like the other threads, except it's in a more general context, for
> requests that span the entire review"

The owner's examples:

> "go over all review comments and tell me if they were truly resolved or not"
>
> "go over this pr and highlight me all decisions made in code i might not
> agree with"

Scope, owner:

> "another session is now working on expanding the mcp to allow the agent
> to respond in threads and etc. so the scope here is just allowing for the
> global conversation"

So the agent answers **in this conversation only**. Writing into GitHub
thread conversations or opening span threads (CAR-92, CAR-80) is the other
session's work; nothing here may block it.

## Owner decisions

- **One ongoing conversation per review** ("a single ongoing conversation
  sounds right to me at this stage"). No "start fresh", no clearing: "I'm
  not worried about the conversation size exploding, review sessions are
  rarely so long lived".
- **It lives in a drawer** (mockup option 2A, chosen over a pinned card on
  Overview): it slides in from the right on any tab, so the reviewer reads
  an answer next to the code it points at.
- **The header agent chip opens it**, and stays the connection status
  indicator: "it should replace the existing header chip as the status
  indicator for connection. and then have a button to show the status
  modal". The chip opens the drawer; a button in the drawer opens the Your
  agent modal (status, activity, detach).
- It is only for a set-up agent ("assuming it is setup").
- **No review data in the prompt** (2026-11-15): generic instructions
  that point the agent at crb's MCP tools, which give it the review's
  facts, GitHub threads and progress ("What the agent is given").

## Goals

- **Ask about the whole review.** A single conversation per review,
  answered by the reviewer's agent (the ACP buddy, or a session joined
  over MCP, whichever is attached), with the review as its context.
- **Looks like the other agent conversations.** Same messages (the
  reviewer's in their person wash, the agent's in `agent` wash and
  `agent-edge` border), streaming text, activity line with Stop, the "new"
  rule above unread answers, Markdown through the same sanitiser, code
  links (`path:line`) that jump to the code, the "Ask agent…" composer.
- **The chip is the one entry point** and shows status and unread answers
  at a glance.
- **Never in the way.** The drawer opens only on the reviewer's tap.

## Non-goals

- The agent writing into GitHub thread conversations or suggesting
  resolutions from this conversation (CAR-92). Opening conversations on
  code or GitHub threads while answering *is* in scope since 2026-11-16
  (CAR-80's `open`; below).
- Several conversations, renaming, clearing, archiving.
- Pushing or sharing the conversation: private to the reviewer like every
  agent thread, never pushed (as the review buddy spec).

## Anti-goals (would be a failure even if it works)

- The drawer or the chip ever opening, popping or stealing focus on its own.
- Anything in this conversation marking a line reviewed, resolving a
  thread, hiding or collapsing a change (principle 2). The conversation
  writes only its own messages.
- The chip losing its status meaning: a failing agent must still read as
  failing from across the room.

## UI

### The header chip

Today's chip (`src/web/agent/AgentChip.tsx`) is a fixed 28px icon-only
circle (`CHIP_BOX`) between the logo and the PR title, name in the tooltip
only, with the plug badge on its corner for a joined session.

**It moves to its own column pinned at the header's right edge**,
mirroring the logo pinned at the left, so it is more noticeable (owner,
2026-11-15: "Let's move the chip to be on the right of the PR instead of
on the left, so it's more noticable", then "I want it pinned to the right
in the same way the logo is pinned to the left. It should block out a
section on the right, except it should be smaller than the logo"). The
header row becomes logo | title block | chip: the logo is followed
directly by the title, the chip's column is reserved whether or not the
title is long, and the title wraps inside the space between the two. The
column is 40px wide (the tap target), right-aligned with the content edge
(the toolbar's settings button below it) and vertically centred on the
title block, like the logo. The visible face is a 32px circle, smaller
than the logo. In the compact header shown once the page scrolls (logo,
tabs, title pill), it is likewise the rightmost item **(call)**. It keeps its sparkle, the plug badge, its status
colour (`agentDot`/`agentInk`: grey off/elsewhere, yellow starting/busy,
green ready, red failing) and its tooltip (`agentTip`). It gains:

- the number of the review conversation's **unread answers** (agent
  messages the reviewer has not seen; owner QA 2026-11-16: "only for
  *unread* messages, not a total count"), while there are any, as a small badge on the circle's lower right corner (`agent-ink` on the
  `agent` wash inside `agent-edge`), so the chip keeps its size and
  nothing jumps **(call)**. That is the plug badge's corner today: for a
  joined session the plug moves into the count badge, before the number
  (the plug alone while nothing is unread) **(call)**. The header's reserved place,
  `useAgentChipPlace` and the `agent-chip-pending` placeholder, move with
  the chip to the right column. No name text is added: the
  name stays in the tooltip **(call)**;
- a **pressed** look (the `agent` wash inside `agent-edge`) while the drawer
  is open, and `aria-expanded` / `aria-controls` on the drawer.

Tap:

| Agent | Tap |
|---|---|
| an ACP agent is configured, or a session is joined | toggles the drawer |
| neither (even with a review conversation already there) | opens agent setup |

Owner QA 2026-11-16: "if there's no agent associated, it should open the
setup modal instead of the side bar"; Shift+A does the same. A tap before
the first status read is held (the chip's spinner) and acted on once the
status lands, so the drawer never opens only to be swapped for the setup;
a second tap cancels it and a failed read spends it. Today a joined
session's chip opens a popover with Disconnect (`chipPopover`); the drawer
replaces it, and Disconnect stays one tap away as the modal's Detach, via
the drawer's status button.

The accessible name says both jobs, e.g. "Review conversation · Claude
Code ready · 1 unread" **(call: wording)**, never a total count. Same chip on phone.

### The drawer

- **Desktop**: a panel docked on the right edge, the viewport's full
  height, ~480px wide; the whole page, header included, narrows beside it
  (mockup 2) (builder may tune: min 360, max
  ~40% of the viewport). It **pushes** the page content narrower rather
  than covering it (the owner's "bars push, not cover" rule applied to a
  side panel), so the diff stays fully readable and clickable beside it.
  Its left border is `agent-edge`. Below a breakpoint where pushing would
  leave the content too narrow (builder's choice, around 900px), it
  overlays instead **(call)**.
- **Phone**: a full-screen layer over the page (below nothing; its own
  header), like the agent setup's phone sheet but full height. No
  horizontal scroll at 360px.
- **Header** (`band`): sparkle, the title "Whole review" **(call: title)**,
  the message count, then a **status button** (pulse icon, tooltip and
  accessible name "Agent status") that opens the existing Your agent modal
  (`openAgentSetup()` / `AgentSetupHost`), then Close (×). Both ≥40px.
- **Body**: the messages, oldest first, opening scrolled to the end (to the
  "new" rule if there are unread answers, as the thread panel does). The
  agent's current activity line and the Stop button while it answers
  (reusing what `ThreadAgentPanel` / `AgentThreadCard` render, so the two
  look the same and stay in step).
- **Composer**: "Ask agent…", Enter / send button sends (same composer
  component and draft rules as the thread conversations).
- **Empty state**: just the composer, focused, with its placeholder. No
  explanatory text (principle 6). Only once the agent threads have been
  read: while they load the body shows the shared `Spinner` (`aria-busy`)
  and the chip shows no count rather than 0; a failed read shows an error
  with retry, as the thread panel's failed read does (principle 8).
- **Seen**: the thread panel's rule (`useSeenWriter`, `threadAgent.ts`):
  the conversation is marked seen up to the last message once that answer
  has been visible for `SEEN_AFTER_MS`, not merely on open.
- **Close**: ×, Escape, or the chip again. The drawer's open state survives
  tab switches inside the review (Overview ↔ Files changed) **(call)**, and
  is not kept across reloads **(call)**.
- **Links** in answers: the existing code links (`codeLinks.ts`) jump to
  the code in Files changed and keep the drawer open; on phone, following a
  link closes the full-screen layer so the code is visible **(call)**.
- **Keyboard**: a shortcut toggles the drawer (builder picks a free key in
  `src/web/shortcuts.tsx` and lists it in the shortcuts help) **(call)**.
- **Agent setup modal**: unchanged. It does **not** get a composer
  **(call: the chip replaces the modal as the trigger, so the owner's
  "triggered from the main AI modal" becomes "from the chip"; the modal is
  one tap away in the drawer header)**.

### What doesn't change

- The review conversation never appears among the thread cards, the
  Overview agent rows, the Files tree dots, placements or "unplaced" lists:
  it has no place in the diff. Those lists filter it out by subject.
- The thread agent button on GitHub thread cards, and span agent threads,
  are untouched.

## Data

### Storage

The conversation is one more agent thread in the reviewer's private ref
(`refs/crb/reviews/<review-id>/reviewers/<reviewer>/agent/threads`,
`docs/review-data-storage.md`, "Agent threads ref"), with a new anchor
subject:

```ts
| { subject: "review" }
```

- `agent-thread-opened` with `anchor: {subject: "review"}`, opened by the
  human with their first message; same events after it (`agent-message`,
  `agent-thread-seen`). **(call)** No new event kinds, no new ref: a few
  KB per review, like any agent thread; principle 3 unaffected. Measure
  and note the size in the storage doc as usual.
- **At most one per review.** The server enforces it: opening a second
  `review` thread when one exists is refused on write (409, the client
  then uses the existing one), and on read later openings fold into the
  first (their messages join it), so a race or a hand-edited ref can never
  show two and a racing tab's text is never lost **(call)**.
- **Never resolved.** A resolve on a `review` thread is refused in
  `host.setResolved` (the store's `setResolved` always writes `by:
  "human"`, so the refusal belongs in the host) and ignored in the fold on
  read; the UI has no resolve control. Every "waiting" rule must treat a
  `review` thread as always open (`next`'s hand-out, the status count, the
  wake-up; `host.ts`'s `t.waiting && (thread subject || !resolved)` and
  its copies). Prefer one shared predicate over several edits.
- **Human-opened only (call).** An `agent-thread-opened` by ai with
  `subject: "review"` is rejected: the agent answers in the conversation,
  it doesn't create it. (If the MCP work later wants the agent to start
  it, that's a one-line relaxation.)
- Update `docs/review-data-storage.md`'s event table and write rules in
  the same change.

### API

Reuse the agent thread routes (`src/web/agent/api.ts`, the server's
`/agent/threads`): post messages, mark seen, cancel. Opening needs a new
request shape: `OpenAgentThreadRequest` takes exactly one of `span` or
`thread` today, `app.ts` rebuilds a span as `line`/`file` only and
`host.open` throws without either. Add a third alternative (e.g. `review:
true`) through all three. The web finds the conversation in
`agentThreadsQuery` by `anchor.subject === "review"`.

**Filtered out server-side too**: `host.asked()` feeds placements every
non-`thread` subject; it must skip `review` (it has no path).

### What the agent is given

Owner, 2026-11-15: "I don't want us to have data about the specific review
passed through the prompt. Ideally, the prompt should be generic
instructions to the agent, pointing at the MCP which allows for getting
more information (like which exact commits have been reviewed and etc)".

Since CAR-149 (#105) a spawned agent works through crb's MCP exactly like
a joined session: it is woken, calls `next`, answers with `reply`. The
review conversation uses that path and nothing else:

- **`next` hands out a review-conversation question** like any other
  waiting question: the thread id and `replyTo`, `subject: "review"`, and
  the conversation's own messages (the question and the answers before
  it). It carries **no review data**: no PR title, body or files, no
  GitHub threads, no commits, no diff hunk, no anchored file (today
  `sessionNext` assumes one from `thread.anchor.path`; a review thread
  sends none).
- **Its preamble is generic instructions**: the question is about the
  whole review; find what you need through crb's tools (named, e.g.
  `review`, `threads` and the read tools below) and the checkout; answer
  with `reply`; cite code as `path:line` so the links work; the usual
  expectations (no pushing, no GitHub writes, no review changes). Wording
  is the builder's, kept short like the existing tool texts.
- **Everything about the review comes from MCP tools**, read when the
  agent wants it. The owner's examples need, beyond today's `review`
  (title, body, base/head, files) and `threads` (agent threads):
  - the PR's GitHub review threads with their comments and resolved /
    outdated state, read fresh from GitHub (for "were the comments truly
    resolved"; a stale `resolved` would give a wrong answer), third-party
    text through `sanitizeThirdParty`, an unreadable GitHub said as such,
    never an empty list;
  - the reviewer's progress: the comparison on screen when the question
    was asked, and which commits and lines have been reviewed.
  Owner, 2026-11-15: "We can figure out the details of the MCP exposed
  data as we go." The tools' exact shape is settled during
  implementation, together with the session extending the MCP (step 2 of
  `2026-11-13-spawned-agent-mcp-design.md`): whichever lands first adds a
  tool, the other reuses it. Read-only, scoped to the agent's review,
  like every MCP tool.
- **Settled in implementation (2026-11-16).** CAR-80 (#112) already gives
  `review` the PR's GitHub threads (id, path, line, side, resolved,
  outdated, comments through `sanitizeThirdParty`, an explicit error when
  GitHub can't be read). For an agent's call the read is at most 30 s old
  and `review` says when it was made (`threadsReadAt`); the reviewer's own
  asks and the page keep any read. One new tool, **`progress`** (owner:
  "sure. as long as it's read only"): for the comparison of the question
  the agent holds (else the review conversation's latest human message's
  `view`, else the default), its base and head commits and, per changed
  file, reviewed / unreviewed / crossed-off line ranges per side, the same
  coverage and counts the page shows; an unknown state counts as
  unreviewed, a failure is an explicit error, it writes nothing. And
  **`open`** works from a review question (owner: "yes definitely. that's
  a major goal"): the agent opens conversations on code (pinned to that
  same comparison) or on GitHub threads and cites them in its answer,
  which the drawer shows as links; it can't open another review
  conversation. The preamble names `review`, `threads`, `progress` and
  `open`.
- crb never moves the checkout for this question (CAR-149 decision 8);
  the agent checks out what it needs.

### Which code it answers against

**The comparison on screen when the question was sent.** Owner:
"whatever I'm viewing. the mcp should give it more context if needed and
it can checkout whatever".

- Each human message stores `view` (the comparison on screen) as thread
  conversations' messages do. It is not put in the prompt: the agent
  reads it through MCP (above).
- The view must be the real one. The drawer sits outside Files changed's
  `SendViewProvider` (`FilesPage.tsx`), and `useSendView` falls back to
  "latest patch set vs base branch" outside it. Lift the provider (or what
  it reads) to the review layout so the drawer sends the comparison picked
  on Files changed from either tab **(call: on Overview, the same
  comparison the review is set to; the builder confirms there is one
  per-review choice and uses it)**.

## Principles check

1. **Editable**: the conversation is the reviewer's own; nothing the AI
   decides here becomes review state, so there is nothing to correct.
2. **Coverage**: the conversation writes only `agent-message` events; the
   store's write rule (no ai resolve, no ai seen, no reviewed marks) is
   unchanged and extended to the `review` subject. Test: an ai
   `agent-thread-resolved` / `agent-thread-seen` / review-marking write on
   the review conversation is refused, and coverage is unchanged by any
   conversation traffic.
3. **Git**: one more thread in an existing per-reviewer ref; never pushed.
4. **No server**: unchanged; the reviewer's own agent.
5. **Mobile**: phone layout above; Playwright phone project covers it.
6. **Concise**: icon + count + dot on the chip, icon buttons with
   tooltips, no explanatory text.
7. **Methodology**: no history dependence; the thread list comes from
   GitHub's PR facts.
8. **Loading**: spinner in the drawer and no count on the chip until the
   agent threads are read; empty only after an answer says empty.

## Tests

Unit:
- store: open/answer/seen on a `review` thread; a second `review` open is
  refused; two on read collapse to the first; ai open refused; any resolve
  refused/ignored; a waiting review thread is handed out by `next` and wakes a
  spawned agent.
- `next` for a review question: the thread, `replyTo`, `subject:
  "review"`, the conversation's messages and the generic preamble, and no
  review data (no title, body, files, GitHub threads, commits, hunk or
  anchored file); `reply` stores the answer; spawned and joined agents get
  the same payload.
- the MCP read tools added for it: scoped to the agent's review,
  third-party text sanitised (a hostile comment body is fenced), GitHub
  unreadable said as such, never an empty list.
- web: chip states (not configured → setup; configured → toggles the
  drawer; unread count; pressed; accessible name); the drawer
  (empty state focuses the composer, opens at the end / at "new", marks
  seen, status button opens the modal, Escape closes; while the read is
  held: spinner, no empty composer state, no 0 count); the review thread
  absent from thread lists, Overview agent rows, tree dots and placements.

Playwright (desktop and phone), with the fake ACP agent:
- configured agent: tap chip → drawer → ask → streamed answer → close →
  unread count on the chip after a later answer → reopen at "new";
- a code link in the answer jumps to Files changed with the drawer open
  (desktop) / closed (phone);
- status button opens Your agent; not configured: chip opens setup;
- 360px: no horizontal page scroll, tap targets ≥40px;
- coverage: after a conversation, the unreviewed counts are unchanged.

Gallery: a case PR with several resolved threads, one of them not really
fixed in code, so "were the comments truly resolved" has a real answer to
look at.

## Left to the builder

Drawer width and push/overlay breakpoint, the shortcut key, the exact
preamble wording, the MCP read tools' shape (with the MCP session), how the drawer shares
components with `ThreadAgentPanel` (prefer extracting the conversation
body over copying it).
