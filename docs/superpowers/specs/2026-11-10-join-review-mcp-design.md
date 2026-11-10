# Join a review: your own session as the review buddy, through MCP

Status: draft, 2026-11-10. Ticket: CAR-81. Builds on the review buddy
(`2026-11-04-review-buddy-design.md`, "Later: the MCP door"). Calls the
coordinator made (the owner may overrule) are marked **(call)**.

## Why

> "I want us to add an MCP to carbonless. I want it to be an alternative
> way for an agent to become the review buddy on a PR. Currently it can
> only be triggered by acp, but I want to be able to tell my session: 'can
> you join the carbonless review at XXX', and using an MCP it'll get
> everything it needs."

Today the buddy is always a fresh agent carbonless spawns over ACP. It
knows nothing the PR doesn't say. The sessions with the most useful
context are ones the reviewer already has:

> "It can be the coding session, and I want it to join my review prior to
> me sending it to someone else; or it can be a session with some prior
> context I want to continue working with. It can be from any machine that
> can connect to the crb instance ideally. It should of course answer the
> questions already waiting, and also keep listening for new ones until it
> detaches."

> "I'd rather it be able to do other things in the meantime."

> "When an agent tries to attach to a review, the CRB UI must alert and ask
> for approval." … "The MCP attach endpoint should also inform the agent
> that the user must approve this connection, so they should ask them to.
> Which machine/session is enough, the assumption is if you asked the
> session to do it, it's never supposed to surprise you."

> "The 'curl' address should count as a keep-alive, so we know if the agent
> is listening. If that connection is interrupted it means the agent isn't
> listening. ACP should stay off until I ask for it again, but there should
> be a toast that the attached buddy has been detached (either deliberately
> or due to disconnection)."

## Goals

- **Join from a sentence.** In any session that has carbonless's MCP server
  configured, "join the carbonless review at <link>" is enough: the tools
  and their replies tell the agent every step, including asking the
  reviewer to approve.
- **The reviewer approves every join.** An attach is a request; every page
  of that review shows it with the session's machine and name, Approve and Deny.
  Before Approve the session sees only the review list (`reviews()`, below),
  which any access-key holder can see on Home anyway; nothing from inside a
  review (threads, code, PR body) reaches it.
- **Find the review by name.** "Join my review of the MCP PR" works without
  a link: the session lists the reviews and picks one (owner, comment on
  the spec, 2026-11-10).
- **It answers what waits, then keeps listening**, while the session stays
  free for other work: a background watcher wakes it when a question
  arrives.
- **You know whether it is listening.** The watcher's open connection is
  the keep-alive; the status chip shows the joined session, live.
- **Same threads, same storage, same UI.** A joined session's replies land
  in the same agent threads (`refs/crb/.../agent/threads`) as the ACP
  buddy's, marked with who answered.
- **Any machine that reaches crb**, any harness that speaks MCP over HTTP
  and can run a background command.

## Non-goals (this slice)

- Push into the session through Claude Code channels (`--channels`): it is
  Claude-only and needs the flag at launch, so it can't serve a session
  that already exists. Later, as another wake route.
- Waking through walky talky (Collie). Later, as an optional wake address
  on `attach` **(call: the owner suggested it; the watcher covers every
  harness first, walky talky only sessions run under Collie)**.
- Several buddies on one review at once, or a joined session and the ACP
  buddy side by side.
- Streaming a joined session's reply while it writes (the ACP buddy
  streams; MCP has no channel for it). The card shows "answering…" until
  the reply lands **(call)**.
- Agent-opened threads (the MCP `open_thread` tool). The storage accepts
  them; a later slice adds the tool.
- Any write from the session to GitHub or to review state other than its
  replies.

## Anti-goals

- A join the reviewer didn't approve, or that shares anything before
  approval.
- A buddy that looks connected when it isn't listening, or a question that
  looks answered when it isn't (principle 2: a question handed to a session
  that never replies stays waiting).
- A session stuck in a blocking loop, unusable for anything else.
- A central service, a relay, or anything other than the reviewer's own
  crb instance (principle 4).
- The ACP buddy coming back on its own after a joined session leaves.

## How it works

### One-time setup per harness

crb serves MCP over Streamable HTTP at `/mcp` on the same address and port
as the web UI. The reviewer adds it once per harness and machine, for
example `claude mcp add --transport http crb http://<host>:4747/mcp`. The
setup modal (`AgentSetup.tsx`) gets a second tab, "Join from a session",
that shows that line for this instance's address with a copy button
**(call)**.

**Builder verifies (spike):** whether a Claude Code session that is already
running picks up a server added mid-session (`/mcp` reconnect), and records
the steps in `docs/faq.md`. If it can't, the FAQ says to add the server
before starting long-lived sessions.

### Access

`/mcp` sits behind the access key like every other route (owner,
2026-11-10: "Yes it should include the access key"). The one-time setup
line carries it: `claude mcp add --scope user --transport http crb
"http://<host>:4747/mcp?key=<key>"`, as the setup modal shows it (user
scope, so sessions in every directory see it; its info icon names
`/reload-plugins` for a session already running); the
link `crb <pr>` prints carries it too. On loopback with no key, the Host
check applies as for the API. The Origin and Sec-Fetch-Site checks apply,
so a web page can't drive `/mcp` from a browser.

On top of the key, every join still needs the reviewer's Approve:

- Before approval the only tool that works is `attach`.
- One pending request per review at a time; a second replaces the first
  (the alert updates).
- Approval issues a token for this review only (256-bit random, stored
  hashed). Every other tool, and the watcher, needs it.

### Finding the review

`reviews()` (owner, 2026-11-10: "add an endpoint that lists reviews, so the
agent can easily find a review I'm asking for. It should list reviews by
last activity, with the repo they're in, the branch, the PR number and
title, etc") lists the reviewer's started reviews, newest activity first
(the order of Home's `RowReview`s), each with:

`{ link, repo: "owner/name", pr, title, author, branch: { head, base }, state: "open" | "draft" | "merged" | "closed", lastActivity, progress: { reviewed, total }, buddy: "none" | "acp" | "joined" | "pending", joinable }`

- It works with the access key alone, before any approval **(call: a key
  holder already sees all of this on Home)**.
- `joinable` is false for `--viewer` and `--as-of` reviews, with a reason.
- Read from crb's local data (the cache and review refs), never a fresh
  `gh` call, so it answers at once **(call)**.
- Builder picks a cap (50 suggested) and an optional `query` filter on
  repo, title and branch.

### Attaching

`attach({ review, name, machine?, harness? })`:

- `review` is the review's link (`http://<host>:4747/r/<id>`, as `crb
  <pr>` prints it, the browser shows it, or `reviews()` lists it; a
  `?key=` on it is ignored). Any review `reviews()` lists can be attached;
  if its session isn't open in the registry, the attach opens it as the
  page would **(call: behind the access key this is no new power)**.
- `name` is how the session names itself (for Claude Code, e.g. its
  working directory and branch); `machine` its hostname; `harness` its
  name and version. All shown to the reviewer as given, sanitised, capped
  at 80 chars each. `machine` falls back to the request's remote address.
- First call returns at once:
  `{ state: "pending", request: "<id>", message: "The reviewer must approve this connection in carbonless. Ask them to open <link> and press Approve, then call attach again with request <id>." }`.
  The tool's description also says so, so the agent tells the reviewer in
  its own words.
- Called again with `request`, it returns `pending`, `denied`, `expired`
  (10 minutes with no answer **(call)**), or, after Approve:
  `{ state: "approved", token, review: <facts>, waiting: <count>, watch: <command>, instructions }`.
  It waits up to 20 s for an answer before returning `pending`
  **(call)**, so a session that calls again while the reviewer is pressing
  Approve doesn't need a third call.
- `--viewer` and `--as-of` reviews refuse attach (`no-agent`), as they have
  no ACP buddy.

### Approval in the UI

- **The request bar** is a full-width strip at the top of the review page,
  in flow, pushing the page down and sticky (as the find bar; never
  covering the header): a plug icon, the session name and machine
  ("carbonless · devbox"), the harness in the tooltip, Deny and Approve.
  On phone the same strip, with the name truncated and both buttons 40 px.
- **It is a push alert on every page of that review** (owner, 2026-11-10:
  "On any page. It's a push alert", then: "on every page *of that
  review*. Not for other reviews"): Overview, Files changed, every open tab
  of it; not Home, not other reviews. The pending request rides on the
  review's agent status (`GET /api/r/:id/agent`, `joinRequest`), which
  every page of the review already polls, so no new endpoint. A hidden
  tab of that review gets a "⏚ " title prefix while a request is pending,
  so it shows in the tab strip **(call)**. Browser notifications need a
  secure context (the Tailscale address is plain HTTP), so they are later,
  with HTTPS.
- Nothing else surfaces the request, so the `attach` reply's message
  ("open <link> and press Approve") is the reviewer's pointer to it: it
  always carries the review's link.
- The first press wins; the other tabs' bars go away on the next poll.
- **Approve with an ACP buddy running:** the bar's Approve tooltip says it
  replaces the running agent. On Approve, crb lets the ACP buddy finish
  the turn it is on (or cancels it after 30 s), then closes it and marks
  the review's ACP buddy off. The ACP buddy stays off until the reviewer
  starts it again from the chip.
- Deny returns `denied` to the session; nothing else is stored.

### Listening: the watcher

The `watch` command `attach` returns is a one-line shell command the
session runs in the background (Claude Code: `run_in_background`; its exit
wakes the session). It is plain `curl` in a retry loop, so the session's
machine needs nothing of crb's (POSIX `sh`, one line in practice):

```sh
n=0; while :; do
  r=$({ curl -sfN -H 'Authorization: Bearer <token>' 'http://<host>:4747/mcp/watch/<review-id>?key=<key>'; echo "crb-exit $?"; } | grep -m1 -E '^(carbonless:|crb-exit )')
  case $r in
    carbonless:*) printf '%s\n' "$r"; exit 0;;     # crb's line: a question, or you left
    'crb-exit 22') exit 3;;                         # HTTP 4xx: detached, token revoked
    'crb-exit 7'|'crb-exit 28') n=$((n+1));;       # refused / timed out: count it
    *) n=0;;                                        # dropped stream (crb restart): retry
  esac
  [ "$n" -ge 60 ] && exit 4; sleep 5                # 60 refused connects in a row: give up
done
```

The keep-alive newlines stay inside the command substitution, so the
harness sees only crb's one line; curl's status travels as the
`crb-exit` line, so no `pipefail` is needed. A failure the watcher should
retry (the review can't open right now) gets no HTTP status: crb drops
the connection, since curl turns any 4xx or 5xx into 22.

- `GET /mcp/watch/:review` holds the connection open. It writes a
  keep-alive byte every 15 s (so a dead peer is noticed on write), and
  when a question is waiting for this session it writes one line and
  closes:
  `carbonless: a question is waiting on <owner>/<repo>#<n>. Call crb's next tool, answer with reply, then run this watch command again.`
  So curl exits 0 and the harness wakes the session.
- If a question is already waiting when the watcher connects, it answers
  at once.
- **Presence (owner: the connection is the keep-alive).**
  - A watcher connected: `listening` (green).
  - The watcher closed by crb because it delivered a question: `busy`
    (yellow) until the session replies or opens a new watcher. That isn't
    an interruption. A session that takes `next` and then neither replies
    nor reconnects within 10 minutes is detached **(call)**.
  - The connection dropped any other way: the chip turns yellow
    "reconnecting" at once, and if no watcher is back within 60 s
    **(call: a grace window so a crb restart, the 4747 deploy timer, or a
    Wi-Fi blip doesn't detach)**, the session is detached
    ("disconnected").
- A watcher answer is never the question itself: the session reads it
  through `next`, with its token, so nothing about the review travels in
  the background command's output beyond the PR name.

### The tools after approval

All take the token as a `token` argument (MCP tools can't set headers: the
client's headers are fixed when the server is configured); all are scoped
to the one review. The token is in the session's transcript and in the
watcher's command line on the session's machine: the same trust as the
session itself. It is revocable (Disconnect) and dies with the attachment
**(call)**.

| Tool | Does |
|---|---|
| `next()` | The oldest waiting thread, as the envelope below, or `{ none: true }`. Marks it handed to this session (the chip says "answering"). |
| `reply({ thread, replyTo, text })` | Stores the answer as an `agent-message` (by `ai`) answering `replyTo`, capped at 32 KiB as today. |
| `threads()` | Every thread on the review, folded (so the session can reread one, or see what it said before). |
| `review()` | The review facts again (head may have moved; see below). |
| `detach()` | Ends the attachment: token revoked, watcher closed, toast "left". |

- **The envelope** is the ACP prompt's (`src/server/agent/prompt.ts`), as
  JSON tool output with the fixed preamble first, adapted to a session
  that has its own checkout: no `review.tree` (crb makes no checkout for a
  joined session, wherever it runs **(call)**); instead the envelope adds
  the anchored file's text at the anchor's commit (the window the ACP
  prompt sends as a `resource` block) and the diff hunk, so the session
  can answer without fetching, and the commits so it can look in its own
  copy.
- **The preamble** keeps the data-not-instructions rule; the "your own
  throwaway checkout" sentence becomes "if you have this repository
  checked out, the commits above locate the code".
  The joined session runs with its own permissions; carbonless enforces
  nothing on it (as at the ACP `open` leash). FAQ entry.
- **Head moves.** If the PR's head changes while attached, the next
  envelope carries the new commits and a `notice` saying so, as the ACP
  runner does.
- **One question at a time.** `next` hands out one thread; a second `next`
  before its `reply` returns the same thread **(call)**, so a session that
  lost track can recover.

### Leaving

- **Detach** (the `detach` tool), **disconnect** (the reviewer presses
  Disconnect in the chip's popover), **lost** (the watcher grace window
  passed), or **replaced** (a new join approved) all end the attachment:
  the token is revoked, an open watcher gets crb's final line ("you are
  no longer joined…") and ends (curl exits 0, so the loop does; its 200
  was sent when it connected), a later reconnect gets 410 (exit 3),
  a thread handed out but not answered goes back to waiting.
- **A toast** on every open tab of the review, in the agent tint with the
  plug icon: "carbonless · devbox left" or "… disconnected", 6 s, with the
  exact time on hover (owner). There is no toast component today; the
  builder adds a small one (aria-live polite, no layout shift) that the
  sync notices can share later.
- The review then has no buddy: waiting questions show the yellow "waiting
  for an agent" dot; the ACP buddy stays off until the reviewer starts it
  from the chip (owner).
- **"ACP off" is new state, per review, persisted** in
  `<cache>/agents/<review-id>/acp-off` so a crb restart or a 4747 deploy
  doesn't bring the ACP buddy back **(call)**. Approving a join sets it;
  only Start in the chip (a new control: with a config and `acp-off`,
  the popover shows Start) clears it. Saving the setup modal doesn't clear
  it. Today the runner pokes the ACP agent on every status poll and new
  question while a config exists (`runner.ts`); it must check `acp-off`
  first.

### Status and the chip

`AgentStatus` grows:

```ts
type AgentState = … | "listening" | "reconnecting" | "pending-join";
interface AgentStatus {
  …;
  via?: "acp" | "mcp";
  joined?: { name: string; machine: string; harness?: string; since: string };
  joinRequest?: { id: string; name: string; machine: string; harness?: string; at: string };
  left?: { name: string; machine: string; why: "detached" | "disconnected" | "lost" | "replaced"; at: string };
}
```

(`left` is the latest leave, kept in memory until the next join, so a tab
that was hidden when it happened still sees it on return. A tab toasts it
once, when `at` is newer than the tab's load and it hasn't toasted that
`at` yet **(call)**.) The builder may fold `listening` into `ready` with `via`; the
chip's colors keep the code-review conventions: green listening, yellow
busy/reconnecting/pending, red error.

- **The chip** shows a plug badge on the agent icon when `via` is `mcp`,
  the session's name instead of the ACP agent's, and a popover with
  "since", the machine, and Disconnect. With nothing attached and the ACP
  buddy off, the popover offers Start (the ACP buddy) and the join line.
- Attachments live in server memory and in `<cache>/agents/<review-id>/joined.json`
  (token hash, identity, since) so a crb restart keeps the approval and the
  watcher's retry reconnects inside the grace window **(call)**. Never in
  git (GitDB 10: presence is not review data).
- **One buddy per review per machine.** The existing claim
  (`<cache>/agents/<review-id>/claim`) also covers a joined session: the
  server holding the claim takes attaches; another server answers
  `elsewhere` with the holder's port, and the tool's message says which
  address to use.

### Storage

Unchanged ref and event types. `agent-message` and `agent-thread-opened`
by `ai` carry `agent: { name, version }` today; a joined session's reply
sets `name` to the session's name, `version` to its harness string, and
adds an optional `via: "mcp"` and `machine` **(call)**. The parser keeps
dropping unknown fields on older readers. The builder follows
`docs/gitdb-design-principles.md` and records the field in
`docs/review-data-storage.md`; no size change worth measuring beyond a
note.

## Security summary

| Threat | Where it is stopped |
|---|---|
| Someone on the network joins a review | `/mcp` needs the access key, and every join needs the reviewer's Approve on top |
| A key holder floods requests | One pending request per review (the newest), expiry after 10 minutes; a key holder already has a shell (spec 2026-11-04) |
| A stolen token | Scoped to one review, revoked on any leave, never in URLs or server logs (a tool argument and a curl header), stored hashed; Disconnect in the chip |
| A web page drives `/mcp` | Origin and Sec-Fetch-Site checks as for other writes |
| PR content instructs the joined session | The fixed preamble; the session's own harness gate. carbonless enforces nothing on a joined session (FAQ) |
| A session writes review state | Its only write is `reply` into the agent threads ref; no tool reaches progress, verdicts or GitHub |
| A question looks answered when the session dropped it | A thread handed out but unanswered goes back to waiting on any leave (unit test) |

## UI mockups

See the published artifact (desktop and phone): the join request bar, the
chip while listening and its popover, the "left" toast, the setup modal's
"Join from a session" tab.

## Tests

Unit (Vitest):
- `/mcp` before approval: tools other than `reviews` and `attach` refuse
  without a token.
- `reviews()`: newest activity first; fields as listed; `--viewer`/`--as-of`
  reviews not joinable; no `gh` call (the fake gh sees none).
- Approve, Deny, expiry, replace; `attach` with `request` waits ≤ 20 s for
  the answer (hold, not a time bound: resolved while held).
- Watcher: delivers at once when a question waits; delivers when one
  arrives; keep-alive bytes; a final line on revoke, 410 on reconnect; presence moves listening →
  busy → listening; drop → reconnecting → lost after the grace window
  (fake clock, not wall time).
- `next`/`reply`: oldest first; same thread until replied; `replyTo`
  respected; reply to an unknown thread refused; cap at 32 KiB.
- A handed-out, unanswered thread is waiting again after detach,
  disconnect, lost and replaced (principle 2).
- Approving a join closes a running ACP buddy after its turn and leaves it
  off; nothing restarts it until Start, not a status poll, a new question,
  a config save or a crb restart (`acp-off` persisted).
- The envelope: no `tree`; file text and hunk; preamble present;
  sanitised identity strings.
- Restart: `joined.json` restores the attachment; a watcher reconnecting
  within the window keeps it.

Playwright (desktop and phone), with a fake MCP client in the test
(`@modelcontextprotocol/sdk` client against the built CLI):
- Attach → the request bar shows machine and name → Approve → the client
  gets the facts and the waiting question → it replies → the card shows
  the answer under the session's name.
- Deny; Disconnect from the chip → toast "disconnected", waiting dot back,
  ACP buddy off.
- The bar pushes the header down and leaves its buttons hittable
  (`elementFromPoint`), on phone at 360 px.

Run `pnpm flake-check` on the watcher and gate tests.

## Docs to update in the same change

- `docs/faq.md`: joining from a session, the one-time setup, what carbonless
  does and doesn't enforce on a joined session, restart behaviour.
- `docs/review-data-storage.md`: `via` and `machine` on ai events.
- `docs/product-rules.md`: approval before any join; the ACP buddy stays
  off after a joined session leaves.
- The review-buddy spec's "Later": point at this spec.

## Left to the builder

- The MCP server library (`@modelcontextprotocol/sdk` suggested) and how
  it mounts on Fastify; tool schemas and descriptions (they must tell the
  agent each next step: ask for approval, run the watcher, call `next`).
- The watcher's exact shell loop and give-up behaviour; Windows sessions
  may get a PowerShell variant later.
- Icons (an octicon plug suggested) and the toast's look, from the tokens.

## Owner answers (2026-11-10)

1. `/mcp` is behind the access key: "Yes it should include the access key".
2. A pending join is a push alert on every page of that review: "On any
   page. It's a push alert", clarified: "on every page *of that review*.
   Not for other reviews".
3. A `reviews()` tool lists reviews so the agent can find the one asked
   for (comment on the spec).
