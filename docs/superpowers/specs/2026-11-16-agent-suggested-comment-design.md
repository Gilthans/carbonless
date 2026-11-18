# The agent suggests a review comment (CAR-83)

## Why

In an agent conversation, the agent often finds something worth saying to
the PR's author. Today the reviewer copies it, opens a new comment and
pastes. The owner (2026-11-16):

> "On an 'ask agent' thread, I'd like the agent to be able to suggest a
> comment to post. It should have some special markdown, like
> ```suggestion``` in github. It should be rendered like a text box, which I
> can edit, and it should have a 'add review comment' button that I can
> click to create the comment the agent suggestion (with the edits I may
> have made)."

## Owner decisions (2026-11-16)

1. **The block.** The agent writes a fenced ```` ```comment ```` block in its
   message. It is not ```` ```suggestion ````, because on GitHub that means a
   code change to apply.
2. **What it looks like.** crb shows each block as an editable box with an
   **Add review comment** button. Pressing it posts what the box holds,
   including the reviewer's edits, as the reviewer.
3. **Where it posts.**
   - From a conversation on code: a new GitHub thread on that conversation's
     lines, span or file.
   - From a conversation on a GitHub thread: a reply to that thread.
4. **When.** It posts immediately, like every crb write, never into a
   pending review.
5. **Location.** The comment has no location of its own; it always posts
   where its conversation sits. If those lines are gone at the current head,
   the button is disabled, and its tooltip says why.
6. **Several in one message.** Each block gets its own box and button.
7. **After posting.** The box becomes a link to the posted comment. That
   state is saved, so it survives a reload and never posts twice.
8. **Product rule.** In `docs/product-rules.md`, "Writing to GitHub", the
   rule "no AI-written text is posted" becomes the owner's wording: **"No
   AI-written text is posted without explicit user approval of the exact
   content."**

## What the reviewer sees

### The box (in a conversation on code, and in a thread's slide-in panel)

The block appears inside the agent's message, where it was written:

- **The header row:**
  - a comment icon;
  - the target, short: `L41–44` (a span shows `L41:8–44:20`), `File`, or
    `Reply`. Its tooltip holds the full target, e.g. "New thread on
    src/x.ts, lines 41–44, at the latest push";
  - a reset icon button ("Back to the agent's text"), shown only once the
    text differs from the agent's.
- **The box:** a textarea, monospace like the reply box, that grows with its
  content up to about 12 lines and then scrolls. It starts with the agent's
  text and saves edits as a draft, so they survive a reload, the same as
  crb's other reply boxes.
- **The button:** **Add review comment**, in the GitHub-write green and at
  least 40px tall. It is disabled while the box is empty or while sending.
  While sending, it shows the app's spinner.

States:

| State | What shows |
|---|---|
| Ready | The box and the button. |
| Sending | The spinner in the button; the box is read-only. |
| Refused | The box with its text kept; under it, the refusal in red, worded as the new-thread and reply refusals are today (e.g. "GitHub refused: the line is outside the diff"). The button is enabled again. |
| In doubt | As crb's other writes do: "may have landed", then resend on reload. It never posts twice (see "Never twice"). |
| Lines gone | The button is disabled, with a tooltip: "These lines are gone in the latest push". The box stays editable and copyable. |
| Lines changed | The button is enabled, and a yellow icon beside the target has the tooltip "The code here changed since the agent wrote this". It posts on the traced lines, without columns. |
| Thread gone | The button is disabled, with the tooltip "This GitHub thread was deleted". |
| Posted | The box folds to one row: a check in green, "Posted", the relative time, and a link icon to the comment on GitHub. Below it, the posted text, rendered as the review's comments are. The comment also shows in the diff like any thread. |

A block in a conversation with nowhere to post (the whole-review
conversation, CAR-163) shows as a plain read-only quote with a copy button.
The agent is told not to write one there.

### Phone (360px)

- The header row stays on one line, with the target shortened to its line
  numbers.
- The textarea is full width.
- The button is full width and 40px tall.
- There is no horizontal scroll.

## How it works

### Writing it (agent side)

The preambles (`JOINED_PREAMBLE` and the thread preamble in
`src/shared/agent.ts`) and the `reply`/`open` descriptions gain one
sentence:

> To suggest a comment the reviewer could post where this conversation sits,
> put its exact text in a ```` ```comment ```` block (use four backticks if
> it holds a fence). Only the reviewer can post it. Write at most a few per
> message, and none in the whole-review conversation.

The thread preamble's "Never resolve, unresolve, reply to or write to this
thread" stays true: the agent still writes nothing; the reviewer posts.

### Parsing

- `agentParts()` in `AgentMarkdown.tsx` gains a `comment` part, for a fenced
  code token whose info string is exactly `comment`. Its text is the
  token's raw body.
- Blocks are numbered by order in the message: block 0, 1, … This index,
  with the message id, names the block.
- A `comment` block nested inside a list or a quote isn't a top-level
  token. It renders as ordinary code. This is my call: it keeps parsing
  simple, and the agent is told to write blocks at the top level.

### Posting

- **The client id is deterministic:**
  `ag.<agentThreadId>.<messageId>.<blockIndex>`, which fits `MARKER_ID`. The
  same block always has the same id, on every device and after a reload.
- **On code:** it goes through the existing new-thread path
  (`ThreadWrites.createThread` / `POST /api/threads`) with:
  - `commit` = the snapshot's head;
  - the lines from the agent conversation's placement on that head:
    - `placed` keeps lines and columns;
    - `changed` keeps lines, not columns;
    - `file` posts a file comment;
    - `unplaced` or `outside` disables the button.
  - An anchor already on the head is used as it is. `side` comes from the
    anchor (LEFT stays LEFT).
- **On a GitHub thread:** it goes through the existing reply path
  (`ThreadWrites.reply` / `POST /api/threads/:id/replies`), with the same
  client id.
- **Body:** exactly the box's text. The server's `escapeTags` and the crb
  marker apply as they do for the reviewer's own comments. Nothing is added
  that says the text came from an agent: it is the reviewer's comment once
  they post it (owner rule, item 8).

### Never twice

- **New threads:** `startThread` already dedupes by client id. It checks
  its own record first, then on a retry it scans the viewer's comments for
  the marker id. The deterministic id makes that hold across reloads and
  devices.
- **Replies:** `replyToThread` dedupes by the posted record, then on a retry
  by body. The deterministic id makes the posted record match across
  reloads.
- **The saved state** is a new human-only event in the reviewer's agent
  ref:

  ```
  agent-comment-posted { thread, message, block, clientId, github: { thread, comment, url }, at }
  ```

  It folds onto the message as `posted: { block, url, at }[]`.
- **Order:** crb posts first, then writes the event. If the event write
  fails, the box still shows Posted for this session. A press after a
  reload goes through the dedupe above and finds the comment instead of
  posting again (my call: no new marker on replies).

### What the agent learns

Each message in the envelope (`PromptMessage`) and in `threads` gains
`posted?: { block, text }[]`. `text` is what the reviewer posted, which may
be edited. This lets the agent see which suggestions were taken, and how
(my call; it's small).

## Principles

- **Principle 2.** Posting writes a GitHub comment and one agent-ref event.
  It never marks anything reviewed or changes progress.
- **Principle 8.** "Posted" shows only after GitHub's answer, never on the
  press. An unread placement shows a spinner on the button, never
  "Lines gone".
- **Writing to GitHub.** One press posts one comment, of exactly the text in
  the box. Nothing posts on its own or retries a refusal, and the agent
  can't post.
- **Sanitization:**
  - The box is a textarea value, never HTML.
  - The posted text goes through `escapeTags`, as the reviewer's own
    comments do.
  - The Posted row renders through the comment renderer used for GitHub
    comments.

## Out of scope

- The agent choosing a different location for the comment.
- Pending reviews.
- Posting from the whole-review conversation.
- Suggested code changes (GitHub's ```` ```suggestion ````) inside the
  comment. They pass through as text, and GitHub renders them as usual.

## Tests

**Unit:**
- Parsing: top-level only, a 4-backtick fence, several blocks, and their
  block indexes.
- Fold of `agent-comment-posted`: human-only, an unknown message ignored,
  folded onto `posted`.
- Client id format.
- Placement to target:
  - `placed` keeps columns;
  - `changed` drops them;
  - `file`;
  - `unplaced` and `outside` disable the button;
  - LEFT stays LEFT.

**Each needs a test that fails without its fix:**
- The textarea shows raw agent text (`<img onerror>`) as text.
- The posted body is escaped.
- A second press after a reload posts nothing.

**e2e** (desktop and phone, fake gh and fake agent):
- The agent replies with a comment block on a line conversation. The
  reviewer edits it and presses Add review comment. The fake gh receives a
  new thread on those lines with the edited text. The box shows Posted,
  which survives a reload.
- The same flow on a GitHub-thread conversation posts a reply.
- Lines gone on a new push: the button is disabled and has its tooltip.
- A refusal keeps the text, and the button is enabled again.
- 360px: no horizontal scroll, and the button is at least 40px tall.

## Docs to update

- `docs/product-rules.md`: the rule wording (item 8), and AI-suggested
  comments under "Writing to GitHub".
- `docs/faq.md`: "Can the agent post comments?" No. It suggests; you post.
- The review-buddy spec's format notes.
