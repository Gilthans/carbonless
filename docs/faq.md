# FAQ

## Why do carbonless's line counts differ slightly from GitHub's?

Sometimes carbonless reports a few fewer changed lines than GitHub for the same PR
(for example +2266/−330 where GitHub shows +2268/−332). Nothing is missing: every
change GitHub shows is still in a carbonless cluster. The two tools pair up a few
identical lines differently.

**Where it comes from.** carbonless builds clusters from git's diff with zero
lines of context (`git diff -U0`, and `diff.context=0` for the line counts so both
agree). With zero context, git first trims the lines the two versions share at the
end of the file, then works out the differences. GitHub diffs with the usual 3
lines of context, which skips that trim. Both are valid diffs of the same two
files, but when a change is surrounded by identical lines (most often blank
lines), they can choose different ones to pair as "unchanged". GitHub might show a
blank line as removed and another as added; carbonless shows the blank line as
unchanged.

**Why we keep it.** Treating an unchanged blank line as unchanged is the more
accurate reading of the change: it isn't part of what the author wrote. And
carbonless's clusters will deliberately diverge from GitHub's more over time
(change units, moved-code matching, cluster splitting), so exact parity with
GitHub's counts isn't a goal.

**What is guaranteed.** Every line paired as unchanged is byte-identical on both
sides (checked when hunks are built), every other changed line is in a cluster,
and a mismatch between the diff and the line counts stops the review from opening
rather than hiding anything (CLAUDE.md principle 2).

**Where this matters in code.** Anything that maps GitHub's positions onto
carbonless clusters (review comments, line anchors) must expect small alignment
differences and be covered by tests for them.

## Why does a thread's code look different from GitHub's?

The code beside a review thread on the Overview is the PR's own diff of that
file, at the commit the comment was made on, from carbonless's clone: the
commented lines, marked, and three rows before and after them. GitHub's thread
shows the diff hunk it stored with the comment, which ends at the commented line
and is of whatever view the reviewer commented from. A comment made while
looking at "changes since your last review" or at a single commit stores that
view's hunk, so GitHub may show lines as added that the PR's diff has as
unchanged, or old lines from an earlier commit of the PR.

The commented lines themselves are the same either way. When carbonless can't
build the code for certain (the commit can't be fetched, the path isn't in it,
or the base branch's history doesn't say which old side the commenter saw), it
falls back to GitHub's hunk (`source: "github"` in `/api/threads`). A renamed
file is diffed against its old path, as the Files page pairs them.

### The "different snapshot" chip

A thread whose code can't be shown to be what the commenter saw gets a red
"different snapshot" chip in its header. The rule (`snapshotOf` in
`src/server/codeWindow.ts`, sent as `code.snapshot` in `/api/threads`) fails
closed: the code counts as the commenter's only when

- it is GitHub's own hunk (the fallback above: that is their view), or
- GitHub's hunk is a run of the rows carbonless built, row for row: the same
  kind (added, deleted, context), the same old and new line numbers, the same
  text and end-of-file mark, and it holds both ends of the commented range.
  A CRLF line's CR is kept on both sides (GitHub's hunk has it, as git's
  diff does) and compared as the text without it. GitHub's hunk stops at the
  commented line, so on its last row a missing "\ No newline at end of file"
  marker isn't a difference; elsewhere it is.

Anything else is flagged, with a reason:

- `diff-differs`: the hunk disagrees: another old side (an earlier PR commit
  in "changes since your last review"), lines added in one and context in the
  other, other line numbers, or the range not in it.
- `no-host-diff`: GitHub kept no hunk (or it couldn't be read), so nothing
  vouches for the rebuilt code.

A missing verdict shows the chip too. GitHub's hunk ends at the commented
line, so rows after the range, and rows above the hunk's first line, can't be
checked; their new side is the comment's own commit either way. Whether the
comment's commit was the PR's head at the time isn't checked on its own: the
pane always shows the comment's own commit, so only the diff's old side can
differ, and the hunk shows that. Showing the commenter's own diff instead is
planned with the re-review work (`docs/todo.md`).

## Why is a review comment dated later than GitHub shows it?

carbonless dates a review comment by when it was published: when its review was
submitted, the moment anyone but its author could see it. GitHub's thread shows
when it was written, which for a comment drafted in a pending review can be days
earlier (on one PR, 71 of 209 comments, by up to five days). Thread times, their
order, "no reply", the Timeline (a review's comments land together with it) and
as-of mode all use the publication time, so as of a moment only what was
published by then shows. The viewer's own pending comments aren't shown: nobody
else can see them yet. The code beside a thread is the one exception: it stays
the base branch as the author saw it while writing.

## Which commit does `--head reviewed` pick?

The commit of your latest submitted GitHub review, whatever its verdict
(commented, approved, changes requested, dismissed). Replying to a thread
doesn't count: GitHub makes each reply a "commented" review on the PR's head
of that moment, which says nothing about what you reviewed. So a commented
review with no body whose every comment is a reply is skipped. A body or one
new thread makes it count. If carbonless can't read all of a review's
comments, or your latest review has no commit, it stops with an error rather
than picking an older one. Pending reviews never count.

## Why does "Ignore whitespace" still show whitespace-only changes?

Because they are still changes, and no setting may hide a change from the
review (principle 2). The switch only changes how they read: a line whose
only difference is whitespace becomes one quiet `~` row instead of a red
and a green one, and a cluster that is all whitespace collapses to one row
you can review from, or expand. Clusters, counts and progress stay what
they are with the switch off.

The matching runs over the whole hunk, context lines included, because git
often splits a re-indented block in two with an unchanged-looking `}`
between them; a line whose whitespace-equal twin sits in another cluster,
or is a context line, shows as a one-sided `~` row with its one number.
What the rows guarantee: take away the lines still shown as added or
removed, and the two sides are whitespace-equal, so a line that moves
across an unchanged line stays a change (a loop wrapped in an `if` shows
the `if`, its `}` and the `log` line that crossed the loop's closing brace;
the rest of the body goes quiet). It can show a little more as changed
than `git diff -w` would, never less.

## Why doesn't Find in PR find a line I know is in the file?

Only what the diff can show is searched: file paths, changed lines and the
context lines around them, plus any context you expanded. A line far from
every change isn't shown, so it isn't searched. Expand the gap that holds
it and the hit appears. Comments, threads and the overview aren't searched.
In the since view (base on a patch set) the diff shown is the interdiff, so
that is what is searched: a line changed before that patch set and left
alone since is no changed line there. Move the base to the branch to search
the whole PR.

## Why does Find in PR's count change when I switch to side by side?

With Ignore whitespace on, unified view shows a whitespace-only change as
one `~` row with the new text, so Find counts that row's hits once. Side by
side shows the old and the new text, so it counts both. The current hit
stays on the same row.

## Why does Home show coverage in lines, when the Files page shows files?

Home counts a started review's coverage in changed lines, the finest unit,
so "37 / 120" never looks further along than the review is. When every
changed line is reviewed but clusters without changed lines (a rename, a
mode change) are left, it counts clusters instead, so it never reads as
done early. The Files page's Lines / Clusters / Files choice is a setting
of your browser, which the server that builds Home can't see, so the two
can show different units for the same review.

## Why does gh say "not logged in" when crb runs with its own XDG_CONFIG_HOME?

gh keeps its login in `$XDG_CONFIG_HOME/gh`. Point `XDG_CONFIG_HOME` somewhere
else for crb (a worktree's `.envrc`, `pnpm dev`'s `.crb-dev`, your own
setup) and gh looks there too, finds no login, and every review fails. Set
`GH_CONFIG_DIR` to gh's real config dir as well: `pnpm dev` and
`scripts/agent-worktree.sh` do (`$GH_CONFIG_DIR` if set, else
`${XDG_CONFIG_HOME:-~/.config}/gh` from before the override); by hand,
`export GH_CONFIG_DIR=~/.config/gh` before changing `XDG_CONFIG_HOME`.

## Why does my comment show `\<` in GitHub's edit box?

GitHub's markdown reads `<String>` in `List<String>` (or `<T>`) as an
HTML tag and drops it, so the comment would read `List`. carbonless
posts what you type with a backslash before such a `<`
(`List\<String>`), which GitHub shows as `List<String>`. Edit it in
carbonless and the box shows it as you typed it; GitHub's own edit box
shows the backslash. Code (in backticks or a code block), `a < b` and
the tags GitHub keeps (`<b>`, `<details>`, `<kbd>`, ...) are left as they
are.

## Why does a cluster show as carried?

After the author pushes, the reviewer's marks from the last patch set
come along only where the author's change is exactly the one they
marked: carbonless traces the cluster into the new head (through a
rebase, a merged-in base or a rename) and its removed and added lines are
byte for byte what was reviewed. Such a cluster shows green with a
`carried` chip, and it stays out of the since view, which shows only
what the author changed since. Anything else (a line edited, a cluster
split or grown, a conflict resolved) is `reworked` or `new` and
unreviewed. Only the reviewer's own marks carry, never a carried one by
itself, and unticking a carried cluster is the reviewer's own word: it
stays unticked. Viewing the head carries provisionally; the first mark,
new thread or verdict there stores the carries with the new patch set.
`docs/product-rules.md`, "Marks carry only exact changes".

## Why is a thread under "Not in this comparison"?

Its file isn't in the diff being shown at all: the file was deleted, or
renamed away with the commented line gone, in this patch set or an
earlier one, or the PR no longer changes it (`reverted`). GitHub keeps
such comments as outdated; carbonless keeps them in a trailing group with
the original path and why, on every later patch set until the thread is
resolved, so an unresolved thread never disappears with its file. A
thread whose file is still there but whose lines are gone is listed under
that file's header instead, with its fate and the code it was written on.

## Why does a thread say "outdated" or "untraced" rather than "rewritten"?

carbonless places a thread by tracing it from the commit it was written
on. Some threads have no such commit it can use: GitHub gave none, the
commit was force-pushed away and can't be fetched, or it shares no history
with the base. Those sit on the line GitHub shows them on now. When
GitHub shows them on no line, they are listed under their file:
`outdated` when GitHub marks them so, `untraced` otherwise (also when
GitHub's line isn't the same text in the patch set you are viewing, and
for a line on the old side, which GitHub counts against its own merge
base).
`rewritten` means a real trace found the lines gone.
`docs/product-rules.md`, "A thread with nothing to trace from sits on
GitHub's line".

## Setting up an agent

Ask agent sends your question about a span of the diff to your own coding
agent, which answers in a private thread. carbonless installs and pays for
nothing: it starts the agent you configured, speaking the Agent Client
Protocol over stdio, with your own login. Until you spawn or invite one
in a review, your questions there wait; the chip in the header opens the
setup modal, whose Spawn tab has three steps:

1. **One-time setup:** pick a harness (`src/shared/agentHarnesses.ts`):

   | Harness | Command | Install |
   |---|---|---|
   | Claude Code | `claude-agent-acp` | `npm i -g @agentclientprotocol/claude-agent-acp` (with `CLAUDE_CODE_EXECUTABLE=$(which claude)` in env, so its bundled CLI isn't downloaded twice) |
   | Gemini CLI | `gemini --acp` | |
   | Goose | `goose acp` | |
   | OpenCode | `opencode acp` | |
   | Copilot CLI | `copilot --acp` | |
   | Other | any command speaking ACP | |

2. **Select leash:** Open (the only one so far).
3. **Configure:** command and arguments, then **Spawn**. Spawn runs the
   command once through `initialize`; if that fails it shows why (not
   found on `PATH`, not logged in with the agent's stderr, a protocol
   error) and saves nothing. Otherwise it writes `"agent"` into
   `config.json` and starts the agent in this review.

A configured agent never starts by itself: it starts in a review once
you press Spawn there, and stays on in that review, across crb restarts,
until you press Detach in the Review Agent view. Other reviews stay
without one until you spawn there too. A config saved later restarts it
only in the reviews where it was spawned.

The agent runs with the server's environment minus variables whose name
contains `TOKEN`, `SECRET` or `PASSWORD` or ends in `KEY` (so `GH_TOKEN`
and `ANTHROPIC_API_KEY` are not passed; Claude Code uses its own login
under `HOME`), plus the config's `env`. Its stderr goes to
`<cache>/agents/<review-id>/agent.stderr.log`.

**What `open` allows.** Everything your harness lets the agent do: read,
search, run code ("how does this behave on input X"), edit and commit in
its own throwaway checkout of the PR's head, fetch, and whatever your
harness's own connectors and plugins reach. carbonless answers every
permission request with "allow once" and refuses only a switch into plan
mode. A hostile PR can therefore make the agent do anything your harness
lets it, as your user, with your connectors and network. That is not
confined to its checkout: its shell reaches the rest of your machine, and
the checkout's `objects/info/alternates` names carbonless's cache clone,
so it could even move review refs (`git update-ref`). Nothing in
carbonless's code stops that at `open`; the prompt asks it not to, and the
activity line under each answer shows every tool call and decision. The
expectation not to push or write to GitHub is in the prompt, not a lock.
Your harness's own gate (allow and deny rules, hooks, sandbox) applies as
it does in your terminal. Stricter levels are planned. Decided
(2026-11-08): at `open` your harness setup is trusted, and the prompt asks
the agent to keep out of carbonless's data (`refs/crb`, the cache clone,
config and state), a request, not a protection. An OS sandbox is planned.

**Who can set the agent's command?** Whoever can press Spawn in the
setup modal: it runs the command as the server's user, so that is command
execution. On a bind beyond loopback that is whoever holds the access key
(the owner treats it like an SSH key: a shell login); on loopback with no key, any process on the
machine. Other web sites are refused (the Origin and Host checks).

**Claude Code says "not logged in" though `claude` works in my shell.**
A login made with `claude setup-token` lives in `CLAUDE_CODE_OAUTH_TOKEN`,
and carbonless strips every `…TOKEN` variable from the agent's
environment. Put it in the agent's own `env` in `config.json`
(`"env": { "CLAUDE_CODE_OAUTH_TOKEN": "…" }`), which is passed as written,
or log in with `claude` interactively (the login under `HOME` is used).

**The agent is "not found on PATH" under the service.** A systemd service
gets the `PATH` of its unit, which may lack nvm's global bin where
`npm i -g` put the adapter. Give the command as an absolute path (Other:
`/home/you/.nvm/versions/node/v24…/bin/claude-agent-acp`), or add that
directory to the unit's `PATH`.

**Why does the chip say "elsewhere"?** Another carbonless server on this
machine (another port, e.g. a branch instance) has the same review open
and holds its agent (`<cache>/agents/<review-id>/claim.json`). Your
questions still go in; that server's agent answers them. This one takes
over when the other closes the review, at its next status poll.

**I pressed Detach but the other server's agent still runs.** Detach
clears the review's spawn flag; the server running the agent stops it on
its next status check or poke, so with no page of that server open it
keeps running until one is.

## Joining a review from a session

Instead of an agent carbonless launches, a session you already have (the
coding session, or one with context you want to keep) can be the review's
buddy, from any machine that reaches crb. Spec: the CAR-81 ticket.

**One-time setup per harness and machine.** crb serves MCP over
Streamable HTTP at `/mcp`, on the web UI's address and port, behind the
access key. The setup modal's Invite tab shows the line for this
instance's address and key, with a copy button, one per harness (Claude
Code, Codex, Gemini CLI; Other is the bare MCP URL):

```sh
claude mcp add --scope user --transport http crb "http://<host>:4747/mcp?key=<key>"
```

`--scope user` makes it available to sessions in every directory: without
it, `claude mcp add` writes to the *local* scope, seen only by sessions
started in the directory it ran in. A session that's already running
picks it up with `/reload-plugins` (below); the info icon next to the line
says so.

**Then, in the session:** "join the carbonless review at
`http://<host>:4747/r/<id>`" (step 2 of the tab shows that line too), or "join my
review of the MCP PR": the `reviews` tool lists your reviews (newest
activity first, with repo, PR, title, branches and progress) so the
session can pick one. The tools' replies tell the session every step:

1. `attach` asks to join. Every page of the review shows a bar with the
   session's name and machine, Approve and Deny, and the session asks you
   to press Approve. Nothing from inside the review reaches it before
   that.
2. Once approved, it gets a token, the review's facts, the number of
   waiting questions and a `watch` command to run in the background.
3. It answers with `next` and `reply`; the answer lands in the thread
   under the session's name (the chip shows a plug and that name).
4. When a question arrives, the watch command prints one line and exits,
   which wakes the session (Claude Code: a background command's exit).

Approving a join stops the ACP buddy (it finishes the turn it is on, or
is cancelled after 30 s) and clears the review's spawn flag, so it stays
off, across crb restarts, until you press Spawn again. A joined session leaving doesn't bring it back.

**Does a session that's already running pick up the server?** Not
through `/mcp`, but `/reload-plugins` does, without a restart. Checked
2026-11-10 with Claude Code 2.1.322, in a scratch directory, against a
probe HTTP MCP server added in the *local* scope (the default). The
setup line's `--scope user` server is expected to behave the same, but
that wasn't checked (it would have meant writing to the user's own
Claude config):

1. Start `claude` in a directory and leave it running.
2. From another shell, in the same directory: `claude mcp add --transport
   http <name> <url>` (`claude mcp list` there shows it connected).
3. In the running session, `/mcp` doesn't list it, `/mcp reconnect
   <name>` says `MCP server "<name>" not found`, and `/mcp reconnect all`
   doesn't add it either.
4. `/reload-plugins` in the session: it connects (the server sees the
   session's requests), `/mcp` lists it under "Local MCPs", and the
   session calls its tools.

Restarting with `claude --continue` (or `--resume`) also loads it and
keeps the conversation.

**What carbonless doesn't enforce on a joined session.** It runs with its
own permissions, on its own machine, under its own harness's gate;
carbonless controls none of that. Its only write is `reply`, into this
review's agent threads; no tool reaches progress, verdicts or GitHub. The
preamble on every question (the PR's text is data, not instructions; no
push and no GitHub writes unless you ask in the thread; keep out of
carbonless's data) is a request, as at the ACP buddy's `open` leash. The
token is in the session's transcript and on the watch command's line: the
same trust as the session itself. Disconnect in the chip's popover revokes
it.

**The watch command's exit codes.** It is a POSIX `sh` loop around
`curl`, so the session's machine needs nothing of crb's.

| Exit | Means | The session |
|---|---|---|
| 0 | crb's one line: a question is waiting; or you are no longer joined (detached, disconnected, lost, replaced); or a newer watcher took over | reads the line; on a question, `next` and `reply`, then runs the watch again |
| 3 | crb answered an HTTP error (any status from 400 up; a 4xx: the token is revoked or unknown here) | stops; `attach` again if asked |
| 4 | 60 refused or timed-out connects in a row, 5 s apart, each giving up after 10 s (crb unreachable for 5 to 15 minutes) | stops; run the watch again once crb is back, or `attach` again |

A dropped stream (crb restarting, the network) isn't counted: the loop
retries every 5 s.

**Presence.** While the watcher is connected the chip is green
(listening). Once it has delivered a question the chip is yellow
(answering) until the session replies or runs the watch again; with
neither for 10 minutes the session is detached as lost. Any other drop
turns the chip yellow (reconnecting) at once; with no watcher back within
60 s the session is detached (a "… disconnected" toast). A question it was
handed but didn't answer goes back to waiting.

**Restarts.** The approval survives a crb restart (`joined.json` in
`<cache>/agents/<review-id>/`, with the token's hash only): the watch loop
reconnects, and a session back within the 60 s window stays joined with
the same token. A new session (a restart on the session's side without
`--continue`) needs a new `attach` and a new Approve.
