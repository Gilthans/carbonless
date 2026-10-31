# Home and the always-on server

Status: approved by the owner in conversation, 2026-10-28, with the
builder check's questions answered below.

Calls the coordinator made (the owner may overrule) are marked **(call)**.

Mockups (desktop and phone Home, the search stages, the row actions, the
view's repo settings): https://claude.ai/artifact/NDHGwsuuCfFphmvqB3vDTT

## Why

The owner wants carbonless open on anything they're looking at with as
little friction as possible:

> "I want an easy way to be able to open carbonless on any PR I'm looking
> at, any change Claude made that I want to review, etc. I want it to be
> something completely generic that I can trigger, with as little friction
> as possible; either by asking Claude to "open a crb diff for this", or by
> opening a link that allows me to open any PR."

> "I thought maybe we can have local server always running, and Claude can
> MCP it to create an ad-hoc review, and it can also browse repos/PRs that
> I can open and look at."

That turned out to be four projects. The owner chose this one first:

> "Does it make sense to do "Always-on + Home" first? It feels like less
> work for the most value"

The roadmap, in the order agreed (each part gets its own design):

1. **This part: the always-on server and Home.** One long-lived server,
   `crb` as a thin client, a Home page listing the PRs that matter, open
   any PR by URL or search, per-PR snooze, waiting-on and notes.
2. **Ad-hoc sources.** Reviews of a commit range in a local checkout and of
   a working-tree snapshot (pinned, local-only, with "commit this" to turn
   a snapshot into a range). Owner's decisions already taken: snapshots
   never leave the machine; a clear local-only warning; carry-over to a
   changed tree is part of the follow-up-reviews roadmap, not this.
3. **Several reviews per change**, each with its own history ("one for me
   with my Claude and one for me with my code reviewer").
4. **Local comments**, git-appraise style, so a review no longer depends on
   GitHub to hold its comments. GitHub threads stay one source among
   several for PR-coupled reviews.

Cross-device sync of review state stays a goal for after these; everything
here is stored so it can sync, nothing here implements it.

Owner's decisions on this part (2026-10-28):

> "Let's skip the MCP and keep the CLI then. A link is enough, no need to
> open the browser (unless I asked)."

> "I'd like for the current review page to have a "Home" button that
> returns me to a place where I can see all active reviews. It's important
> that these are not stored in memory, and not "owned" by the process, in
> the sense that we must assume other such instances may be running on
> other devices."

> "Ideally, it would start by showing all the PRs I'm in the attention-set
> of. But we haven't established the attention-set of PRs yet and it's
> complicated, so let's start with every PR I'm the author or reviewer of."

> "First question is which repos are checked. This should be configurable -
> I don't want all my visible repos to be there. I might want several views,
> with multiple repos in each one. Let's start with one view, with a
> configurable list of repos."

> "For each of those repos, I should have multiple sections: PRs I'm the
> author of; PRs I'm reviewing or have been asked to review; PRs looking for
> a reviewer (ready for review but not taken yet); All other open PRs"

> "maybe snooze a PR for a few days so it's hidden behind a "X hidden PRs"
> section, mark some of them as pending until something happens (wait for
> reviewer to comment or author to reply), add some metadata of my own
> ("awaiting Tomer's decision" or something)"

> "Attention sets I like because it's a way to communicate to all parties
> if you know you're supposed to be working on this or not, which is better
> than the static review state github has."

> "If a URL is posted it should work even if not fetched (no reason not
> to). It should have autocomplete as I start typing, both for repos and
> after I completed the repo it should list latest activity PRs"

> "it should simultaneously search repos and PR titles. When selecting a
> repo, it should auto-complete the suggestion and open a list of searchable
> PRs. When selecting a PR, it should take me directly to that PR. The
> syntax should be able to free-text search a PR title inside a specific
> repo, and when selecting a repo it should land on that syntax so I can
> select the repo and then type the parts of the title I remember"

> "The split isn't the best - something based on turns makes more sense
> like you said, but for now we need something that can be static."

> "Snooze should always have a date, and optionally can be unsnoozed by
> activity (default to true)"

> "Hidden shouldn't be a section of its own - each of the existing section
> should have a "X hidden · Y snoozed" text at the end, which on click
> reveals the hidden PRs"

> "Opening a PR doesn't count, it should only appear if I started doing an
> action on it (like marking files as reviewed)"

> "Let's leave snooze and comments to the Home page - the decision on what
> PRs to open is separate from the process of reviewing a specific one."

## Goals

- **One server per machine that stays up**, serving any number of reviews,
  with the owner's current instance (port 4747 over Tailscale) becoming it.
- **`crb` as a thin client**: `crb <pr>` asks the running server for the
  review and prints its link; no running server means it starts one. Claude
  Code, or anyone, gets a link by running it.
- **Home** at the server root: the view's PRs in four static sections,
  recently closed ones, the PRs you've started reviewing anywhere, each row
  with GitHub's facts, whose turn it looks like, and your coverage once
  you've started.
- **Open any PR** from one box: paste a URL, type `owner/repo#n`, or search
  repos and titles at once, in or outside the view.
- **Per-PR annotations that are yours**: snooze to a date (waking on
  activity by default), waiting on someone, a note. Hidden rows stay
  counted at the foot of their section and one click reveals them.
- **Refresh from GitHub on its own**, so the page is current when opened and
  while it stays open.
- **Nothing lives only in a process.** Reviews and annotations are in git
  refs; the view's config is a file; two servers (or a restart) see the same
  state.

## Non-goals (this part)

- The automatic attention set. The "turn" column uses a fixed rule table
  over GitHub's facts; the manual annotations are its override hooks.
- Several views, view sharing, custom sections or filters. The config shape
  allows several views; the UI shows one.
- Ad-hoc sources, several reviews per change, local comments (parts 2–4).
- Sync of annotations or progress between devices.
- An MCP server. The CLI is the integration.
- Snooze, waiting-on or notes from inside the review page.
- Notifications of any kind.

## Anti-goals

- **A central carbonless service.** The server runs on the reviewer's own
  machine (principle 4). A second device runs its own; they share state
  through git refs, later.
- **Home hiding a PR by itself.** Only the reviewer's own snooze or
  waiting-on hides a row, the footer always counts hidden rows, and a hidden
  row is one click away. Nothing AI-made or automatic hides or drops a PR
  (principle 2's spirit, applied to the list).
- **Home touching review state.** Coverage on a row is read from the
  reviewer's progress ref; Home never writes it.
- **Everyday git getting slower.** New refs follow
  `docs/gitdb-design-principles.md` (principle 3) and live in carbonless's
  cache clones only.
- **A refresh loop that burns GitHub rate limit** or hangs the page when
  GitHub is slow or unreachable.
- **Dependence on history shape.** Sections and turns come from GitHub's PR
  facts only (principle 7).

## The server

- **`crb serve [--host <h>] [--port <n>]`** runs the server in the
  foreground (for a terminal, tmux, or a user service). Default port 4747
  **(call)**, default host 127.0.0.1 as today; any other host requires the
  access key as today. Serving all of a machine's reviews, it replaces
  today's one-process-per-PR model.
- **Where it binds is config, not a flag you must remember (call).**
  `config.json` (below) holds `serve: { host, port }`; `crb serve` and the
  CLI's auto-start both use it, and `--host`/`--port` on `crb serve`
  override it for one run. Defaults when absent: 127.0.0.1 and 4747. The
  owner sets the Tailscale IP once, and a server started by `crb <pr>` on a
  quiet machine is the same server the phone can reach.
- **State file (call):** `$XDG_STATE_HOME/carbonless/server.json`
  (default `~/.local/state/carbonless/server.json`, mode 0600): host, port,
  pid, started-at. Written on start, removed on clean shutdown. The CLI
  reads it to find the server; a pid that's gone means no server, and a
  stale file is replaced. A second `crb serve` on the same port fails as
  today ("already in use") and leaves the file alone.
- **A stable access key (call).** Today's key is random per start, so every
  restart breaks the phone's bookmark. The key lives in its own file,
  `$XDG_STATE_HOME/carbonless/key` (mode 0600), created on first start and
  kept across restarts and clean shutdowns; `crb serve --new-key` rotates
  it. The page still strips `?key=` into a cookie as today.
- **Many reviews.** `Session` stays the unit of one open review. The server
  holds a map of review id → session, opened on the first request that
  needs it and closed after 30 minutes without requests **(call)**;
  reopening is cheap because the clone and the refs are on disk. Every
  `/api/...` route of today takes the review id; today's single-session
  wiring in `src/server/app.ts` becomes a lookup.
- **URLs.** Home is `/`. A review is `/r/<review-id>` (the review's ULID
  from `refs/crb/lookup/...`) with `/r/<id>/files` and the rest as today.
  `/pr/<owner>/<repo>/<n>[?head=...]` resolves or creates the PR's review
  and goes on to `/r/<id>`, so a typed or pasted address works too
  **(call)**; with the web UI it shows the PR loading at once and goes on
  in place (Home, Open any PR). The builder picks whether `/r/<id>` or the `/pr/...` form is
  what the CLI prints; the printed one must be stable across restarts (both
  are).
- **Shutdown** on the usual signals closes every session (today's
  `Session.closeAll`), squashes nothing new (sync is still off), and removes
  the state file.
- **Two servers on one machine** (an agent's test instance next to the
  owner's) share nothing but the cache clones and refs, which today's
  compare-and-swap writes already allow. The state file is per
  `XDG_STATE_HOME`, so tests isolate it as they isolate `XDG_CACHE_HOME`.
- **Dev and agent instances never find the owner's server** (agreed
  2026-10-29 with the versioning/distribution work). `pnpm dev` and
  `scripts/agent-worktree.sh` set a private `XDG_STATE_HOME` and
  `XDG_CONFIG_HOME` inside the worktree (git-ignored), so a branch's
  `crb <pr>` finds or starts its own server, never main's.
  gh keeps its login under `$XDG_CONFIG_HOME/gh`, so they also pin
  `GH_CONFIG_DIR` to the real one (`$GH_CONFIG_DIR`, else
  `${XDG_CONFIG_HOME:-~/.config}/gh`, read before the override); anyone
  running crb with their own `XDG_CONFIG_HOME` must do the same (FAQ).
- **Version handshake** (same agreement; format set by the
  versioning/distribution work). The CLI never hands a request to a
  mismatched server silently.
  - `crb --version` prints `<package.json version> (<short commit>)`, e.g.
    `0.4.0-rc.1 (93fe843)`. The version is package.json's `version` as is
    (the release script sets it, `-rc.N` included), never derived from git
    tags.
  - `GET /api/version` returns
    `{ "version": "0.4.0-rc.1", "commit": "<full sha>" }`.
  - The build bakes the commit in (`git rev-parse HEAD` in the build
    script), so an installed tarball reports it with no `.git`. A tree dirty
    at build time appends `-dirty` to the commit.
  - The client sends both on every request to the server. A server whose
    version or commit differs refuses. The commit matters because a
    worktree build and the installed release can share a version.
  - The error names each side: "server runs 0.4.0 (abc1234), this crb is
    0.4.0 (def5678)". It says to restart the server or run the matching
    `crb`. The release's update script restarts the service after an
    install, so a mismatch right after an upgrade clears itself.

## The CLI

- **`crb <pr> [--head ...] [--open]`**: finds the server through the state
  file; if none is running, starts `crb serve` detached (same host and port
  defaults, log to `$XDG_STATE_HOME/carbonless/serve.log`) and waits for the
  state file; then `POST /api/reviews` with the PR argument and options and
  prints the review's URL on stdout. Nothing else on stdout, as today.
- **The browser does not open unless asked.** `--open` opens it; today's
  `--no-open` default flips, per the owner. Hidden dev flags (`--as-of`,
  `--viewer`) stay and go through the same request.
- `crb --help` describes `serve` and the client form. The old `--port`,
  `--host`, `--api-only` flags belong to `serve`; the dev server's
  `pnpm dev` keeps working through it (builder's call how).
- A PR argument is accepted in today's three forms, and `owner/repo#n` or a
  URL may name a repo outside the view.

## Home

### Views and repos

- One view, named "My PRs", listing repos as `owner/repo`. Config:
  `$XDG_CONFIG_HOME/carbonless/config.json` (default
  `~/.config/carbonless/config.json`) **(call)**:

  ```json
  {
    "serve": { "host": "100.78.32.127", "port": 4747 },
    "views": [{ "name": "My PRs", "repos": ["acme/api", "acme/console"] }],
    "refresh": { "minutes": 2 }
  }
  ```

  The UI edits the first view (the pencil next to the repo chips: add by
  `owner/repo` or URL, remove, suggestions from repos of recent reviews);
  the add input suggests the viewer's repos as you type (owner, 2026-10-31:
  "should have auto-complete like the search bar, but only search for
  repos"): the open box's Repos group alone (`GET /api/home/search?only=repos`,
  the same source and matching), the same spinner while the viewer's repos
  load, without the ones listed already; arrows pick one, Enter or a click
  adds it, Enter with none picked adds what was typed, Escape closes the
  list (the dialog stays); while Save is out (owner, 2026-10-31: "there's
  no spinner while it is working"), Save spins and is disabled and the
  inputs are read-only; a failure shows why and gives them back;
  the server writes the file; a hand edit is picked up on the next refresh.
  A missing file means an empty view, and Home says so and offers to add
  repos. Several views in the file are kept but only the first is shown.
- Per-device config is deliberate: which repos this machine watches is the
  machine's business; what the reviewer did to a PR is the reviewer's and
  goes in refs (below).

### Sections

All from GitHub's PR facts for the view's repos, with the viewer's login
from `gh`. A PR is in exactly one section:

| Section | Rule |
|---|---|
| **Mine** | the viewer is the author (drafts included, with a Draft pill) |
| **Reviewing** | not mine, and one of: a review is requested from the viewer directly (not only via a team), the viewer has submitted a review or review comment, or the viewer has started it in carbonless |
| **Up for grabs** | not mine, not a draft, no review submitted by anyone, and no review requested from anyone except teams (owner, 2026-10-30: "prs addressed at a team and not directly at me that I haven't started reviewing should be up for grabs, not reviewing"). The teams are ones the viewer is in: a PR asked of a team the viewer isn't in, or when their teams can't be read (no `read:org`), goes to Other open; a bot's review doesn't count as reviewed |
| **Other open** | every other open PR of the view's repos |
| **Recently closed** | merged or closed in the last 3 days (owner, 2026-10-29); a quiet tail, violet merged icon or red closed icon |

**Which PRs are considered:** every open or recently closed PR of the
view's repos, plus every PR the viewer has **started** in carbonless,
whatever its repo. A started PR goes through the same table: the owner's
own PR of Claude's changes in a repo outside the view lands in Mine, a
colleague's in Reviewing, a merged one in Recently closed. (Builder check:
the owner's main case, "any change Claude made that I want to review", is
mostly their own PRs, so Mine must carry coverage and the any-repo rule
like Reviewing.)

**Started** = the viewer has a patch set for the PR in carbonless, in any
of the PR's reviews (its plain review or a `--head` pinned one; `--as-of`
views are dev mode and never count). "Opening a PR doesn't count" (owner):
a patch set exists only after the reviewer's first action
(`docs/review-data-storage.md`), so a PR opened and left alone stays where
GitHub's facts put it.

Hint under a title when it helps ("requested or started", "ready, no
reviewer yet"). Rows in a section are ordered by last GitHub activity,
newest first **(call)**. A PR closed without merging stays in Recently
closed for 3 days like a merged one, then drops off. A section longer
than 20 rows shows 20 and a "show N more" footer line next to the hidden
count (owner's wording; 20 is a **call**): a fold, never a drop, and the
refresh lists every PR (paginated), so the count is always the true one.

### A row

Repo · number · title · pills (Draft; your note, dashed) · status icons ·
turn · age or coverage · hover actions. Every icon has a tooltip and an
accessible name (principle 6); colors are the design tokens with their
code-review meaning.

- **Columns and their header** (owner, 2026-10-31: "There should be titles
  at the top of the list, so it's clear what are the elements of the
  row"): from `lg` (1024px) up a row is one line of fixed columns, Repo ·
  Pull request (number, title, pills; takes the rest) · Status · Turn ·
  Reviewed (coverage) · Updated (age, at the row's right edge), and one
  header for the page names them, in line with them, in short words; it
  sticks at the top, so it names the columns of whichever section is in
  view, folded or not. Below `lg` a row stacks (title; repo and the rest)
  and nothing lines up across rows, so there is no header **(call)**. A
  sub-row's coverage and age sit under the Reviewed and Updated columns.
- **Title**: always whole (owner, 2026-10-31: "The title should fully
  appear in every row. It should wrap inside the row if necessary"):
  never truncated or ellipsised, on any width; a word longer than the row
  breaks, with no sideways scroll.

- **Status icons**, in this order, each only when it applies: checks
  (`ok` passing, `bad` failing, `warn` running; none when there are no
  checks), review decision (`ok` approved, `bad` changes requested),
  unresolved thread count (`warn`, bubble), author avatar (not on Mine).
- **Turn**: an arrow and the avatar(s) of whoever the facts say should act,
  with "you" ringed in `accent` when it's the viewer; "no reviewer" in
  `muted` for Up for grabs. Rules, first match wins **(call)**:

  | # | Facts | Turn |
  |---|---|---|
  | 1 | merged or closed | none |
  | 2 | draft | author |
  | 3 | review decision is changes requested | author |
  | 4 | review requested from someone and not yet submitted | those reviewers (the viewer first) |
  | 5 | approved | author, labelled "merge" |
  | 6 | reviewers exist, last activity (commit, comment, review) was the author's | the reviewers who have reviewed |
  | 7 | reviewers exist, last activity was a reviewer's | author |
  | 8 | no reviewers | the viewer's own PR: you ("No reviewer: request one"); anyone else's: "no reviewer" |

  A manual waiting-on (below) overrides the column for the viewer. This
  table is the seed of the attention set; it's data on the row, never a
  reason to hide one.
- **Age** is the last GitHub activity as relative text with the exact time
  on hover (`RelativeTime`). On a started PR, in any section, the coverage
  bar and "37 / 120" in the viewer's progress unit (from the progress ref,
  read as the Files page reads it) show **next to** the age, not instead of
  it (owner, 2026-10-29: "Why not both?"). On a phone both sit on the
  second line.
- **A PR with several started reviews** (its plain one and a `--head`
  pinned one today; part 3 adds more) shows them as **sub-rows under the
  PR's row** (owner's decision, 2026-10-28), ordered by the review's last
  activity, newest first. The PR row keeps the facts, icons and turn; each
  sub-row carries that review's name (plain: "head"; pinned: a pin icon and
  the head's short SHA), its coverage, and its own last-acted age, and
  opens that review on click. A PR with one started review has no
  sub-rows: its coverage sits on the PR row. The grouping is a display
  choice over the refs as they are; nothing new is stored.
- **Click** on a PR row opens its plain review (`/r/<id>`), creating it if
  the PR has none; on a sub-row, that review. A merged or closed PR with no started review has nothing to
  review (today's refusal in `Session.open` stays): its row links to GitHub
  instead, the title carrying an external-link icon and the tooltip
  "Merged, nothing to review here. Open on GitHub"; `/pr/...` and
  `crb <pr>` answer with the same refusal as today.
- **Floating actions** (owner, 2026-10-31: "The actions can appear in a
  floating menu bar, it doesn't need space saved"): the row keeps no room
  for them; its last column (the age) ends at the row's right edge. With a
  mouse: snooze, waiting on, note (and Wake up on a hidden row) are icon
  buttons in a small bar floating over the row's top right end, shown on
  hover and on keyboard focus in the row; their popovers open under it,
  above the rows after it. On touch: a 40px "⋯" button floating at the
  row's top right (the title line leaves room for it) opens the same
  actions as a bottom sheet **(call)**; no hover, no long-press.

### Hidden rows

- A row is hidden while **snoozed** (until its date, or until activity if
  the snooze allows it) or **waiting on** someone other than the viewer
  (until that person acts, or the viewer clears it).
- A hidden row stays in its section, moved to a footer: "2 snoozed · 1
  waiting", a disclosure button (`aria-expanded`, 40px tall on touch) that
  reveals the rows in place, dimmed, each with its reason badge (the date,
  with a bolt when activity can wake it; the arrow and avatar of the
  person it waits on) and a **Wake up** action (owner, 2026-10-29; among the
  row's floating actions since 2026-10-31), which
  ends the snooze or the wait at once and puts the row back among the
  visible ones. Collapsed again on reload.
- A row that woke in the last 24 hours carries a small alarm badge
  ("woke: activity" / "woke: time") **(call)**, so what changed since
  yesterday is visible.

### Annotations: snooze, waiting on, note

Semantics:

- **Snooze** = a date-time (presets: tomorrow 09:00, in 3 days, next
  Monday, pick a date; local time) plus "Wake on activity too", on by
  default. Activity = the PR's GitHub `updatedAt` is later than the moment
  of snoozing **(call)**: a push, comment, review or state change all
  count; nothing else does.
- **Waiting on** = a login; "Me" is the viewer's own login. The PR hides
  until the named person's activity (a commit, comment or review by them
  later than the annotation) or until cleared (Wake up, or Clear in the
  Waiting-on panel). "Me" never hides and shows the row under "you" in the
  turn column. Teams (`org/slug`) are not offered: a team never acts
  itself, so a wait on one could never end.
- **Note** = free text shown as a dashed pill on the row; private to the
  reviewer, never posted to GitHub.
- Each is cleared by its own action (Wake up clears snooze and waiting-on;
  an empty note clears the note).

Storage **(call, to be checked against `docs/gitdb-design-principles.md`
by the builder, and departed from only with a stated reason)**:

- One ref per reviewer per repository: `refs/crb/inbox/<reviewer>` in the
  repo's cache clone, next to the review refs. Split by writer (GitDB 3),
  one unit per reviewer and repo (GitDB 16), events only (GitDB 5).
- Events, in the commit-message format of `docs/review-data-storage.md`
  (`v`, `id`, `type`, `ts`, `by`, `actor`, `details`), one commit per event,
  compare-and-swap, empty tree:

  | Type | Payload |
  |---|---|
  | `pr-snoozed` | PR number, `until` (ms since epoch), `wakeOnActivity` |
  | `pr-waiting-on` | PR number, `who` (a login; the reviewer's own means me) |
  | `pr-note` | PR number, `text` (empty clears) |
  | `pr-cleared` | PR number, `kind` (`snooze` / `waiting`) |

  Fold: last event per (PR number, kind) wins. Write rule, enforced and
  tested: all four need `by: "human"`.
- **A repo without a clone yet.** Annotating a PR of a view repo must not
  wait for a clone of the whole repo. crb's commits use the empty tree, so
  the ref can be written into a bare repository with no objects of the
  project in it: the builder makes `ensureClone` able to initialise the bare
  repo without fetching (`git init --bare` plus the remote config), writes
  the inbox ref there, and the full fetch happens on the review's first
  open as today. If the clone code can't be split that way cleanly, say so
  in the report and clone on first annotation instead.
- Size: a few hundred bytes per event; no effect on anyone's everyday git
  (the refs are in the cache clone). Compaction is out of scope, as it is
  for review refs.

### Open any PR

One box in the header (`/` focuses it; Esc closes the list). The input is
parsed on every keystroke:

| Input | Behaviour |
|---|---|
| A PR URL, `owner/repo#n`, or `#n` / `n` after a chosen repo | Enter opens it at once, view or not |
| `owner/repo ` (a repo followed by a space) + text | title search inside that repo: words in any order, case-insensitive; open PRs first, then merged and closed, each by last activity |
| anything else | two groups: **Repos** (only the viewer's repos: the view's, then repos of recent reviews, then every repo the viewer owns, collaborates on or reaches as an org member, read once from GitHub and cached; never public repos the viewer has no relation to (owner, 2026-10-30); while that list is still loading the group shows a spinner) and **Pull requests** (title matches across the view's cached PR lists, open and recently closed, with repo, author and age) |

- Tab or Enter on a repo fills `owner/repo ` and lists that repo's PRs by
  latest activity, ready for title words. Enter on a PR opens it. A snoozed
  or hidden PR still appears, with a "snoozed" tag. Backspace over the space
  leaves the repo.
- Title search in a repo outside the view, or beyond the cache in a view
  repo, uses `gh search prs --repo` after a short debounce, with a spinner
  in the list and no blocking of the typed results.
- Choosing a PR (or any `/pr/owner/repo/n` address, `?head=` too) shows a
  page at once (owner, 2026-10-31: "It should open a page immediately, that
  loads while the backend data model is created"): the review page's frame
  with the PR's title (when Home knows it, else `owner/repo #n`) and an
  "Opening…" spinner, while the server opens the review (a clone if the repo
  has none yet). Then it becomes `/r/<id>` in place (Back returns to where
  the reviewer came from). A PR that can't be opened says why on that same
  page. The server answers `/pr/...` with the page before any GitHub read;
  the page asks `POST /api/reviews`, which joins an open of the same PR
  under way, so opening it twice gives one review. The cross-site rule for
  `/pr/...` is unchanged; the CLI still opens through `POST /api/reviews`.

### Refresh

- The server refreshes every view repo every `refresh.minutes` (default
  2) and every started PR regardless of repo (a merged or closed one for
  3 days after it closed, then no more): the PR list with the fields the
  sections, rows and turn rules need (number, title, author, draft, state,
  merged-at, updated-at, review requests, latest reviews and review
  decision, checks rollup, unresolved thread count, the dates and authors
  of the last commit, comment and review). GraphQL, paginated at 100 per
  page, is the likely shape; `gh pr list --json` lacks unresolved threads.
  Builder's call, with the fake `gh` extended to serve it. Every open PR is
  listed, however many: the budget is measured in the report (points per
  refresh per repo at 100 and 300 open PRs) and must leave a 3-repo view at
  2 minutes well under a tenth of GitHub's hourly GraphQL allowance; if it
  doesn't, the interval's default goes up before any PR is left out.
- The page asks for a refresh when opened or focused if the last one is
  older than 30 seconds, and has a refresh button. The header shows the
  last refresh as relative text with the exact time on hover; it turns
  `warn` with the reason (rate limited, offline, `gh` error) when a refresh
  fails, and the lists keep the last good data.
- On a rate-limit or repeated failure the interval doubles up to 30 minutes
  and resets on success.
- Refresh results are kept in the server's memory only as a cache; the
  config and refs are the state. A restart refreshes within seconds.

### Phone (principle 5)

Rows stack to two lines below `lg` (title; repo, icons, turn, age), the search box is
full width under the header, section footers and the "⋯" button are 40px
targets, nothing scrolls sideways at 360px. The phone project of the
Playwright suite covers Home.

### Shortcuts and help

`/` search, Esc close, arrows and Enter in the list, Tab completes a repo.
Listed in the `?` help like the review page's.

## The review page

- The logo in the header links to Home (`/`), with "Home" as its accessible
  name and tooltip, on every screen size. The PR's own GitHub link stays
  where it is.
- Everything else on the review page is unchanged. Its URLs move under
  `/r/<id>`; the API routes take the review id.

## Design principles check

1. Editable AI decisions: no AI output here.
2. Coverage: Home reads coverage, never writes it. Hidden rows are the
   reviewer's doing, always counted, one click away.
3. Review data in git: one small per-reviewer ref per repo, in the cache
   clone; no effect on everyday git. The builder reads
   `docs/gitdb-design-principles.md` before writing it and the storage doc
   gains an "Inbox ref" section in the same change.
4. No central server: the server is local; `crb` talks to the one on this
   machine only.
5. Mobile: above.
6. Icon-first: rows are icons with tooltips; the only sentences are section
   hints and empty states.
7. Methodology-independent: sections and turns from PR facts.

## Tests

- **Unit:** section assignment and turn rules over PR facts (every row of
  both tables, plus "started anywhere" and the viewer-as-team-reviewer
  case); grouping of a PR's started reviews into sub-rows by last
  activity; the "show N more" fold never changing the section's count; snooze and waiting-on folding, hiding and waking (date passed,
  activity with and without the switch, the named person's activity vs
  someone else's); the inbox write rules (`by: "human"` only; unknown types
  skipped); search parsing and ranking (URL, `owner/repo#n`, repo + words,
  mixed); config read, write and defaults; the state file and the CLI's
  "server running?" check.
- **Git integration** (`test/git-fixture.ts`): inbox events in a bare repo
  with no project objects, then a fetch into the same repo, then reading
  both review and inbox refs; two writers with compare-and-swap.
- **Playwright** (fake `gh` scenario with several repos and a PR list per
  repo), desktop and phone projects: Home shows the four sections and
  recently closed (merged and closed-unmerged) from the scenario; Wake up on
  a snoozed row; a started review in a repo outside
  the view appears in Reviewing with its coverage; open by URL, by
  `owner/repo#n`, by repo-then-title; a snoozed row leaves its section and
  shows in the footer, reveals on click, wakes on activity after the
  scenario changes and a refresh; waiting-on hides and clears on that
  person's activity; the note shows on the row; the review page's Home
  link; two reviews open at once on one server; `crb <pr>` against a
  running server prints its URL and starts none; `crb <pr>` with no server
  starts one; a failed refresh shows the warning and keeps the rows; no
  horizontal scroll at 360px.
- **Measured** in the report: refresh cost per repo (`gh` calls and time),
  Home's first paint with the fake data, and the inbox ref's size after 100
  events.

## Left to the builder

- Internal shape of the multi-session server and the route refactor.
- The exact GraphQL query and the fake `gh` extension.
- How `pnpm dev` wires to `crb serve`.
- Debounce timings, list lengths, and the cache's eviction.
- Component structure on the web side (TanStack Query for Home's data and
  refresh, TanStack Router routes for `/`, `/r/<id>/...`, `/pr/...`).
- Wording of hints, empty states and tooltips, within principle 6.

## Changes in implementation

Calls made while building, each open to the owner's overrule:

- **Home's refresh starts on the first Home request**, not when the
  server starts (F3, call): a server that only hands out review links
  spends no GitHub budget. After a restart, the first Home open asks for
  a refresh and shows the sections once it returns.
- **Home's coverage is in lines**, falling back to clusters when only
  clusters without changed lines are left (F4, call). The Files page's
  unit is a browser setting the server can't see, so "37 / 120" on Home
  can differ from the unit the Files page shows (`docs/faq.md`).
- **A row whose only started review is pinned opens that review** (F5,
  call), not a new plain one: with one review there are no sub-rows, so
  the pinned review would otherwise be unreachable from Home, and the
  row's coverage is that review's.

## Open questions for the owner

None. The builder check (2026-10-28) asked five; four were settled from
the conversation and the code (where the server binds; own PRs count and
show coverage; merged PRs keep the refusal; no cap on open PRs) and one
went to the owner, who decided:

> "If there's more than one review per PR, the home screen should list
> them as separate sub-rows of the same PRs, ordered inside by the last
> activity date. But for now we don't support for that - multiple review
> sessions on the same branch/PR is for later. For now, let's do what's
> simpler (I think showing multiple review rows under the PR might be
> easiest)"

> "showing review progress on each row is an excellent idea"

> "Instead of "show all N", use "show N more" if there are more than N
> items to show"
