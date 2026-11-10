# Thread agent: a side-bar per GitHub thread

Status: draft, 2026-11-09. Branches from the re-review stack (tip
`rr-markable`, PR #34; spec `docs/superpowers/specs/2026-11-04-re-review-design.md`)
and uses its patch sets, comparisons and thread placement. Builds on review buddy
(`docs/superpowers/specs/2026-11-04-review-buddy-design.md`, merged as PR
#30). Mockups (desktop Overview, desktop Files changed, phone):
https://claude.ai/artifact/LqHZqTLVfFC1E7u1mkPYj1

## Why

Review buddy lets the reviewer ask their own agent about a span of code.
The questions a reviewer has most often during a re-review are about a
**thread**, not a span. The owner's examples, for after the author has
replied:

- "is this resolved?"
- "was this fixed in all places or just here?"
- "where is the fix implemented in the code?"

Each one asks what happened in the code **since the comment**. So the agent
needs the thread, the commit it was opened on, and what the reviewer is
looking at now.

Later (a follow-up, not this slice) the reviewer will send one general
request, such as "go over all threads and tell me which were resolved", and
the agent will answer it in each thread's side-bar. The owner said they will
read every thread anyway. What they want is "to have the response ready as I
open the thread". This slice shapes the data so that follow-up can write
into side-bars without changing the format.

## Goals

1. **One agent conversation per GitHub thread**, private to the reviewer,
   tied to the thread (owner: "it's tied to the thread (they're resolved
   together etc), the context includes the thread contents, and the UI links
   them").
2. **Context:** the agent sees the whole GitHub thread, the commit the
   thread was opened on, the patch set the reviewer is viewing, and the PR's
   current head (owner: "it should see what commit the thread was opened
   on, as well as the current viewed patch set and the head").
3. **Answers point at code:** `path:line` references in an answer are links
   that open those lines in Files changed.
4. **Counters and unread:** each GitHub thread shows its comment count and,
   beside it, a count of the messages in its agent conversation. A marker
   shows when an agent message hasn't been seen yet (owner: "some sort of
   'unread' marker to indicate there's something new there, perhaps a
   counter of agent messages beside the number of total messages").
5. **Ready for agent-started conversations:** the data model and the UI
   handle a conversation the agent started, including the request it came
   from. Nothing in this slice starts one.
6. **The agent may suggest resolving, never resolve** (owner: "Resolving a
   thread is ALWAYS a human action. The agent could suggest resolving, but
   never do it for us").

## Non-goals (this slice)

- The global agent conversation, meaning one request answered across many
  threads (owner: a follow-up): CAR-92.
- The agent drafting a comment, reply or new thread: CAR-83 (the owner's
  2026-11-09 words were added to it).
- Fixing an answer that streams in and pushes the page: CAR-91.
- Unread markers on span (code) agent threads. The data supports them. Only
  thread side-bars show them in this slice (my call: keeps the slice small).
- Pushing conversations to GitHub or to another device: they stay in the
  private agent ref, as review buddy's do.

## Anti-goals

- **The agent never resolves, unresolves, replies to or otherwise writes to
  a GitHub thread.** No server route lets an `ai` event or a runner action
  do it. A test checks that no runner path can call the resolve or reply
  writers.
- **Nothing here changes review coverage** (principle 2). An answer saying
  "resolved" is only text: no thread, line or file changes state because of
  it.
- **No side-bar may hide its thread.** On a narrow screen the conversation
  is a tab inside the thread card, never a layer covering the GitHub
  comments with no way back.

## How it works

### What a thread conversation is

It's an agent thread (review buddy's model) whose anchor is a GitHub thread
instead of a span:

```ts
type AgentAnchor =
  | { subject: "line"; … }   // unchanged
  | { subject: "file"; … }   // unchanged
  | { subject: "thread"; thread: string; path: string; commit: string };
```

- `thread`: the GitHub thread's id (`ReviewThread.id`). A thread whose id
  is `""` (GitHub gave none) gets no side-bar, and its button doesn't show.
- `path` and `commit`: the thread's path and the commit its opening comment
  was made on (`ReviewThread.commit`, possibly `""`), recorded when the
  conversation opens. They're for display and for the prompt, never for
  placement: the conversation is placed with its thread.
- **At most one conversation per GitHub thread.** The fold keeps the first
  `agent-thread-opened` for a given `thread` id and folds the messages of
  any later one into it, so two devices opening the same conversation at
  once can't leave two side-bars. A unit test covers this.
- **Resolved together:** a thread conversation has no resolved state of its
  own. It is resolved exactly when its GitHub thread is resolved, by anyone,
  including on GitHub. It has no Resolve button of its own: the thread
  card's Resolve and Unresolve act on both. `agent-thread-resolved` events
  for a thread conversation are ignored by the fold. (My reading of
  "resolved together". It means a thread resolved on GitHub folds its
  side-bar too.)
- While resolved, the side-bar is collapsed with the thread, still readable,
  and its composer is hidden. Unresolving reopens both.
- A question already waiting when the thread gets resolved is still
  answered (it was asked); no new one can be sent until it's unresolved
  (my call).
- **Orphans:** a conversation whose GitHub thread is gone (deleted, no
  longer listed) stays readable. It shows in the Overview's agent row as
  its own entry with the thread's `path` and a muted "thread gone" icon,
  composer hidden (my call). Its messages are never dropped from view.

### Opening one

- Each GitHub thread card gets an **Ask agent** button: the Overview's
  `ThreadItem` (`OverviewPage.tsx:1459`), Files changed's `ThreadBlock`
  (`ThreadRow.tsx`), and re-review's `UnplacedRow` and not-in-comparison
  rows (`ThreadFate.tsx:391`, `NotInComparison.tsx`), so a thread whose
  line is gone can still be asked about. The button is a sparkle icon with the tooltip "Ask agent",
  following review buddy's icon and the 40px target rule. It's absent in
  `--viewer` and `--as-of` reviews (review buddy does the same), on threads
  with no id, and on deleted threads.
- Pressing it opens the side-bar with an empty composer. Sending the first
  message writes `agent-thread-opened` (`by: "human"`) with the thread
  anchor. As in review buddy, sending works with no agent attached: the
  conversation waits, with the yellow dot.

### Messages in it

Same as review buddy: GFM rendered through the GitHub sanitiser, streamed
text and an activity line, Stop, the "answering…" spinner row, the yellow
waiting dot, the 32 KiB cap. Additions:

- **The comparison a question was asked in.** A human message's event
  gains `view`, the re-review comparison on screen when it was sent:
  `{ target: {patchset: n} | {head: oid}, from: {branch: true} |
  {patchset: m} }` as the web already holds it (`Viewing` and
  `ComparisonBase`, `src/web/files/comparison.ts:17-20`), plus the two
  resolved commits `{ left, right }` the server fills in from its patch set
  list. Sent from Files changed, it is the URL's `ps`/`head`/`from`. Sent
  from the Overview, it is the comparison the Overview places threads
  against (the latest patch set, or the snapshot head when there's none;
  `useSessionPlacements`). The prompt uses it (below), and the side-bar
  shows a small "PS 3" / head chip on the question.
- **Code links.** `path:line` and `path:start-end` in an agent's answer
  (inside inline code or bare) become links to Files changed at that line.
  Agent messages gain a stored `head` (the commit the agent's checkout was
  on for that turn). A link opens Files changed at that exact head, with
  re-review's URL state (`?ps=<n>` when the head is a patch set's,
  else `?head=<oid>`), so it still shows the lines the agent meant after
  newer pushes. A path that isn't in the PR stays plain text. The
  builder chooses the recogniser. Links go through the existing router,
  never `href` text the agent wrote verbatim (sanitisation checklist).
- **Suggest resolving.** The preamble for thread conversations tells the
  agent to end with a line holding exactly `[suggest-resolve]` when it
  judges the thread resolved. The runner strips that line and stores
  `suggests: "resolve"` on the message. The message shows a small "✓
  suggests resolving" chip in `ok` and the thread's Resolve button gets an
  `ok` ring. Nothing else happens. The marker is just a hint, the human
  still clicks. So a hostile PR text that tricks the agent into suggesting
  it costs nothing. (Marker format is my call; the builder may pick
  another, as long as it is stripped and stored as data.)

### Agent-started conversations (data only)

- `agent-thread-opened` with `by: "ai"` and a thread anchor is valid. The
  parser already allows `ai` on this event, but only with an `agent`
  identity and a `text` (the first message): an event without them is
  dropped (`src/server/review/events.ts:565`), so seeded test events carry
  both. It gains an optional
  `origin: { request: string }`: the reviewer's general request, cut to 200
  characters, which the side-bar shows as a chip ("↳ Check every thread")
  over the first message.
- An ai-opened conversation isn't waiting (review buddy's fold rule). It
  counts as unread until seen.
- Tests seed such events directly in the ref. No runner path produces them
  in this slice.

### Context the agent gets

The prompt envelope gets a thread kind:

```ts
interface PromptEnvelope {
  kind: "agent_thread" | "github_thread_conversation";
  review: PromptReview;                 // repo, pr, base/head refs+commits, merge base, tree
  thread: { id: string; anchor: AgentAnchor & { file: string } };
  github?: {                            // kind "github_thread_conversation" only
    url: string;                        // the thread's first comment on GitHub
    path: string;
    line: number | null;                // ReviewThread.line
    openedOn: string;                   // ReviewThread.commit ("" = unknown)
    outdated: boolean;
    resolved: boolean;
    comments: { author: { login: string; role: "reviewer" | "pr_author" | "other" }; at: string; body: string }[];
  };
  view?: { target: string; from: string; left: string; right: string };  // latest question's comparison
  current: string;                      // GitHub's newest head
  patchsets: { number: number; head: string; mergeBase: string; startedAt: string }[];
  placement?: ThreadPlacement;          // on the viewed comparison
  messages: PromptMessage[];            // the side-bar conversation
  …
}
```

- **Three commits, named:**
  - `github.openedOn`: `ReviewThread.commit`, plus the patch set it falls
    in (`openedOn(createdAt, patchsets)`, `src/shared/rereview/openedOn.ts`),
  - `view`: the comparison of the latest question (above), with its
    `left`/`right` commits and patch set numbers,
  - `current`: GitHub's newest head (`SessionInfo.currentHead`). Before a
    thread turn the runner runs `checkHead`, which fetches a new head into
    the cache clone once per head (`session.ts:1751`, `clone.ts:363`). The
    agent's checkout moves to that head for the turn (not to the snapshot
    head, as span threads do), since "is this resolved?" is often answered
    by a push the reviewer hasn't viewed yet. The envelope also lists the
    patch sets (number, head, merge base, started) so the agent can say
    "fixed in PS 4".
  - The thread's **placement** on the viewed comparison (`placeThread`,
    `src/shared/rereview/placement.ts:226`: placed, changed with its old
    and new text, unplaced with its fate, outside) goes in too, so the
    agent starts from what re-review already knows.
- The preamble for this kind says what each commit is, and that "since the
  comment" means `openedOn..current`. Every commit's objects reach the
  checkout through alternates (`checkout.ts:26`); the cache clone keeps
  fetched objects (`gc.auto=0`, `clone.ts:306`). A commit the clone never
  fetched (a comment made on a head that was force-pushed away before
  carbonless saw it) is named in `notice` as missing.
- The GitHub comments go in as third-party data. `sanitizeEnvelope` cleans
  only ref names, the anchor path and PR text today (`prompt.ts:147`), so
  it is extended to the comment bodies, logins and the thread path, with a
  test. Comment roles need the PR author's login wired into `authorOf`
  (`host.ts:173` never returns `pr_author`; this fixes CAR-58 on the way).
- The code window at `openedOn` is attached as review buddy attaches the
  anchored hunk. The builder may reuse the thread's `code` window.
- The envelope is rebuilt every turn, so a follow-up after a new push sees
  the new head and any new GitHub comments. The runner reads the GitHub
  thread (comments, resolved) from the session's current read at the start
  of each turn; it is not in the agent ref. (This avoids CAR-53's stale
  merge base for this kind. Fixing CAR-53 for span threads stays separate.)

### Unread

- **Seen marks** are events in the same private ref:
  `agent-thread-seen { thread, upTo: <message event id> }`, `by: "human"`.
  The web writes one when a side-bar with unseen agent messages is open and
  visible (the builder picks the visibility rule, e.g. in view for 1 s). It
  never writes one when nothing is unseen, so there's at most one per agent
  message (principle 3: bounded by the message count).
- A conversation is **unread** when it has an `ai` message after its last
  `upTo`. Kept in the ref, not `localStorage`, so the phone and the desktop
  agree (the owner reads on both, through the same server).
- The **"new" divider** in the side-bar sits above the first unseen message.
  It stays until the side-bar closes.

### In the UI (see the mockups)

- **Counters on the thread card header** (Overview row, Files changed card)
  and on the Files changed **thread bubble**: the existing comment pill,
  then a teal `agent` pill with the sparkle and the count of the agent's
  messages in the conversation (owner: "a counter of agent messages"). An **unread** conversation adds a dot in `accent` (periwinkle) on
  that pill. Yellow stays "your turn" / "waiting", green the resolved
  check. (Accent for unread is my call. The design README says agent teal
  is never a state colour, and yellow and green are taken.) The accessible
  name says it: "3 agent messages, 1 new".
- **The file tree** gets the agent dot it already shows for span threads,
  plus the accent dot while something under it is unread.
- **Desktop side-bar:** a panel to the right of the thread card, joined to
  it by a teal connector at the header, `agent-edge` border. Header: the
  sparkle, the thread's `path:line`, Close. Body: messages, the origin chip
  when agent-started, the "new" divider. Footer: the composer. In Files
  changed it sits in a column to the right of the diff, level with its
  thread, and the diff narrows while one is open. One side-bar open at a
  time (my call: opening another closes the first).
- **Narrow screens (phone, and desktop below the builder's breakpoint):**
  the thread card gets two tabs, "Thread N" and "✦ Agent N", with the
  unread dot on the agent tab. The composer and Resolve stay at the bottom
  of the card. Principle 5: no horizontal page scroll at 360px, 40px
  targets, and a Playwright phone test.
- **Resolve** stays on the thread card (the GitHub action), and is shared
  with the side-bar on narrow screens.
- **The Overview's agent row** (`AgentOverviewRow`) counts thread
  conversations with span threads, and its unread count links to the first
  unread one.

### Storage

- Same ref: `refs/crb/reviews/<id>/reviewers/<slug>/agent/threads`. New
  pieces: the `thread` anchor subject, `view` on human messages,
  `suggests` on ai messages, `origin` on ai-opened threads, and the
  `agent-thread-seen` event. The parser drops malformed ones (fail safe).
  `agent-thread-seen` by `ai` is dropped: only a human sees.
- Update `docs/review-data-storage.md` ("Agent threads ref") and measure:
  50 thread conversations × 4 messages × 2 KiB plus one seen event per agent
  message, loose and packed, one append and a cold fold. Read
  `docs/gitdb-design-principles.md` first.

### API

Reuses review buddy's routes (`/api/r/:id/agent/threads…`). Additions:

| Route | Does |
|---|---|
| `POST agent/threads` | also accepts `{ clientId, text, thread: <github thread id>, view }` in place of `span`; 409 if a conversation for that thread exists (the client then posts a message to it) |
| `POST agent/threads/:tid/messages` | accepts `view` |
| `POST agent/threads/:tid/seen` | `{ upTo }`; no-op if already seen up to there |
| `POST agent/threads/:tid/resolved` | 409 for a thread conversation (resolve the GitHub thread instead) |

`GET agent/threads` returns thread conversations with `unread: boolean`,
`suggests`, `origin`, and each human message's `view`.

## Tests (beyond what review buddy has)

- Fold: one conversation per GitHub thread despite two opens; resolved
  follows the GitHub thread, not `agent-thread-resolved`; unread follows
  `agent-thread-seen`; ai-opened thread with `origin`; `ai`-by seen event
  dropped; malformed new fields dropped.
- Prompt: the envelope names the three commits, carries the comments
  sanitised, the `notice` for a missing commit, and the rebuilt head on a
  follow-up after a push (fake gh scenario that moves the head).
- Runner: a thread turn runs `checkHead` and checks out GitHub's current
  head (fake gh moves the head; the envelope's `current` and the checkout
  follow, while the snapshot stays); `[suggest-resolve]` stripped and stored; a reply text that
  *contains* it mid-message isn't a suggestion; no runner path calls the
  GitHub resolve or reply writers.
- Web: links in answers land on the line, non-PR paths stay text, a
  `javascript:` link from the agent is dropped; the unread dot appears and
  clears after viewing (fake ACP answer while the side-bar is closed); one
  side-bar at a time; the Ask agent button is absent on id-less, deleted,
  `--viewer` and `--as-of` threads.
- Playwright, desktop and phone: open a conversation from an Overview
  thread and from Files changed, get an answer, see the counter; resolve the
  GitHub thread and see the side-bar fold; phone tabs at 360px.
- Gallery: a `case/thread-agent` PR with a thread fixed in one place but not
  another (the owner's "all places or just here" case), plus a re-push, for
  QA.

## Docs to update in the same change

`docs/review-data-storage.md`, `docs/product-rules.md` (resolving is always
a human action; the agent may only suggest it), `docs/design/README.md`
(accent dot = unread on agent pills).

## Left to the builder

The breakpoint for the side-bar vs tabs; the code-link recogniser; the seen
visibility rule; component structure (reuse `AgentThreadCard` pieces in a
`ThreadSidebar`); icons for Close and Send; where the composer keeps focus.

## Calls I made (for the owner to check)

- Resolved state is derived from the GitHub thread, so a thread resolved on
  GitHub by someone else folds its side-bar.
- Unread uses `accent` (periwinkle), not yellow.
- Seen marks live in the private ref, so phone and desktop agree.
- One side-bar open at a time on desktop.
- Unread markers only on thread conversations this slice.
- `[suggest-resolve]` line as the suggestion marker.
- A question waiting when the thread is resolved is still answered.
- Orphaned conversations live in the Overview's agent row.
- Code links open the head the answer was written on (`?ps=` / `?head=`).
- The agent's checkout for a thread turn is GitHub's current head, not the
  snapshot.
