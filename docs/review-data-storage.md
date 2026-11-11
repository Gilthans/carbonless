# Review data storage

How carbonless stores review data in git. This is a living document: keep it
up to date whenever the storage changes. First written 2026-10-22 as a design
spec; parts marked *Builder's call* or listed under open questions are not
settled yet.

## Why

Review state (which clusters are reviewed or crossed off, and later AI groupings
and the reviewer's corrections) should live in git, not in loose JSON files:

- It travels with the repo and can be shared through the remote.
- Every change is kept as an event, so there is a full audit trail. This is also
  how corrections stay as data (CLAUDE.md principle 1).
- Its identity survives rebases and force-pushes of the PR branch.

This replaces the JSON-file storage first proposed in
the PR review parity spec (Linear, M2 project documents). The cluster concept, cluster identity,
cluster states and the coverage invariant from that spec are used here as
defined there.

The general principles behind this design, with their reasoning, are in
`docs/gitdb-design-principles.md`. The numbers in brackets below, like
"(GitDB 19)", point to them.

**Re-review after new pushes** (design:
`docs/superpowers/specs/2026-11-04-re-review-design.md`) adds to this format
the events, refs and folding that let a reviewer move to a new push and keep
every mark it can carry: `carried` and `thread-placed` events, the `-base` pin
ref, per-patch-set folding. The engine that computes carries and the UI
that moves the reviewer are its own PRs; the storage below is ready for them.

## Constraints

- **No effect on regular git workflows.** status, log, switch, commit, fetch and
  clone must not slow down as reviews accumulate. Only operations that walk every
  ref (`git log --all`, `gitk --all`, server-side gc) may be affected.
- **Reasonable storage.** Target: about 50 KiB or less per typical review after
  `git gc`, measured on what's pushed to the remote. Unsquashed local commits
  may be larger for a while.
- **Each review is isolated.** Reading or writing a review costs time in
  proportion to that review's own size, never to the number of reviews.
- **Coverage invariant holds** (principle 2). Stored data can only mark a cluster
  done when it matches a cluster computed from the current git diff. A corrupt,
  missing or invented event can only make coverage look incomplete. A
  reviewer's coverage comes only from their own progress ref, so nothing another
  person pushes can make it look more complete.
- **AI never writes review state.** Only the reviewer (`by: "human"`) writes
  cluster states. The deterministic engine (`by: "auto"`) writes only
  `carried` events, and the fold trusts an entry of one only when the state
  it carries is a human state in the source patch set (see "Reading").
  Enforced on write and on read, and covered by tests.

## Concepts

**Review.** One review of one change under review. Each review has a generated
ID (a lowercase ULID) and a **source**: what it reviews, and how it's found
again. Its identity is stable across rebases and force-pushes because the
source's key is, while the commits change.

**Review source.** For now the only source is `github-pr`: a GitHub pull request,
keyed by `<owner>/<repo>#<number>` (owner and repo lowercased, since GitHub
treats them case-insensitively). PR numbers are never reused, so the key stays
valid after the branch is renamed, deleted or force-pushed. Other sources are
planned (for example ad hoc reviews of a local branch or commit range, without
going through `gh`). Each source defines its own key, and nothing outside the
source assumes a review is a PR. The source and its fields are stored in the
review's metadata.

**Snapshot.** One state of the PR: a `(merge base, head)` pair and its
three-dot diff. Any head the tool sees for the review's branch is one: every
push, including force-pushed rebases and merges. Identified by a hash of the
pair, the **snapshot id**, which code and routes still call `revision`
(`Snapshot.revision`, `cluster-state.patchset`). Snapshots are not recorded
as events: they come and go with the branch, and the current one is always
derivable from git.

**Patch set.** A snapshot that is a landmark in one reviewer's history: one
they actually reviewed against. Patch sets are per reviewer and recorded in
that reviewer's progress ref. A snapshot becomes a patch set automatically on
the reviewer's first lasting action against it (marking or crossing off a
cluster; the re-review design adds opening a thread and giving a verdict). A
patch set stays tied to the snapshot it was started on. It never moves to a
later push: acting on a new push starts a new patch set, which records which
one it follows (`since`) and how the two relate (`shape`). Only the latest
patch set takes writes; earlier ones are read-only, and open exactly as
reviewed (their snapshots are pinned, see "Ref layout").
Patch sets are numbered per reviewer in the order they were started ("PS2"); the
number is a display label, the snapshot id is the identity, so two patch sets
never share a snapshot. The name comes from Gerrit, with two differences: a
Gerrit patch set is a single commit and every upload creates one, while ours
is a range that can span many commits and only snapshots the reviewer acted
on become one.

**Event.** One JSON object recording one action. Events are append-only and
never edited. Undoing something is a new event.

**Reviewer.** Identified by a slug: lowercase `[a-z0-9-]`, at most 64 characters,
derived from the GitHub login. Never an email address: ref names are visible to
anyone who can read the refs.

## Ref layout

```
refs/crb/reviews/<review-id>/meta                            shared review metadata
refs/crb/reviews/<review-id>/reviewers/<reviewer>/progress        one per reviewer
refs/crb/reviews/<review-id>/reviewers/<reviewer>/patchsets/<n>   head of patch set n
refs/crb/reviews/<review-id>/reviewers/<reviewer>/patchsets/<n>-base   merge base of patch set n
refs/crb/reviews/<review-id>/reviewers/<reviewer>/agent/threads   the reviewer's private agent threads
refs/crb/lookup/<source>/<key-hash>                               lookup: source key → review id
refs/crb/inbox/<reviewer>                                         one per reviewer per repo: Home's annotations
```

- **meta** holds review-level events: created, closed, compacted. Anyone may
  append. Merging two copies is a plain union.
- **patchsets/<n>** points at the head commit of the reviewer's patch set `n`,
  and **patchsets/<n>-base** at its merge base. An OID stored in an event
  doesn't keep the commit alive. After a force-push nothing else references
  the old head, so `git gc` could delete it, and the reviewer's snapshot (see
  "After a push") would be lost; a base branch that is rewritten does the
  same to the merge base. One ref each keeps them reachable, locally and on
  the remote, so any patch set opens exactly as reviewed. Both are created in
  the transaction that starts the patch set, with "must not exist yet" as
  their old value, so two tabs starting the same number can't both succeed
  (`ReviewService.ensurePatchset`). A reader treats a missing `-base` ref (a
  patch set started before it existed) as unpinned and falls back to the
  merge base OID recorded in `patchset-started`, which is almost always still
  reachable. Patch sets are few per reviewer (a review with 3 reviewers and 5
  patch sets each has 30 pin refs), so these refs add little (GitDB 4, 14).
- **progress** holds one reviewer's patch sets and cluster states. Only that
  reviewer writes it, so two people can never produce conflicting writes. This
  is a convention, not enforced: anyone with push access can write any ref
  (signing commits was considered and judged not worth the complexity). Progress
  is private to each reviewer: a reviewer only ever reads their own. Other
  reviewers' progress refs are used only to show that someone else has started
  (on the PR overview), by checking that the refs exist, without fetching them.
- **lookup/** finds the review for a source key without reading every review's
  metadata (which would grow with the number of reviews). It points at a blob
  containing the review ID. `<source>` is the source name (`github-pr`) and
  `<key-hash>` is a hex hash of the source's key (for `github-pr`,
  `<owner>/<repo>#<number>`, lowercased), so no name can cause ref name
  conflicts, invalid ref names or case collisions. The hidden dev mode
  `--as-of <cutoff>` uses the key `<owner>/<repo>#<number>@<cutoff>` (cutoff
  in canonical UTC ISO, e.g. `2026-09-15T11:35:52Z`), so a view of the PR as
  of a past moment gets a review of its own (its `review-created` event
  carries `details.asOf`) and never touches the PR's real one. Likewise
  `crb --head <sha|reviewed>`, which pins the snapshot's head on one commit
  of the PR, uses the key `<owner>/<repo>#<number>^<head>` (the full head
  OID; `^` never occurs in a cutoff, `@` never in an OID), with
  `details.head` in its `review-created` event. It needs its own review
  because the PR's review, once started, is pinned on its own patch set's
  head; a pinned view always gets its own, even on the PR's current head.
  Its refs are those of any other small review. A `github-pr` lookup ref is kept after the PR
  closes, since PR numbers aren't reused (reviewer's decision, 2026-10-23:
  look up by PR number for now).
- All refs live in carbonless's private bare clone (see the parity spec), never
  in the reviewer's working copies.
- **One repository.** All of a review's refs live in the PR's own repository,
  so any update to them can be one atomic transaction (GitDB 2). Nothing is
  split into a second repository.
- **No PR head refs.** `refs/crb/` is the tool's only namespace. PR heads are
  fetched when needed (`git fetch <remote> refs/pull/<n>/head`) and used by OID,
  without keeping a local ref. This replaces the parity spec's
  `refs/carbonless/pr/<n>/head`. The private clone sets `gc.auto=0`, so the
  `gc --auto` a fetch may trigger never prunes an unreferenced head, and the
  fetch is redone on every open anyway.

Ref name limits with the default loose-file ref storage (tested on Linux): about
250 bytes per path component (git adds `.lock` to the filename while writing),
the full path must fit the OS path limit (about 4096 bytes on Linux, 260 on
Windows without `core.longpaths`), and `Alice` and `alice` collide on
case-insensitive filesystems. The layout above stays far inside these limits.

## Commit format

Each ref points at a linear chain of commits. Each commit holds one event, or
several after a squash:

```
tree      <empty tree>          shared by every crb commit, costs nothing
parent    <previous tip>        none for the first commit
author    daniel <daniel@crb>   the reviewer's slug, never their real email
committer crb <crb@crb>         fixed tool identity
message   crb: started PS1, reviewed 2 clusters in src/server/diff.ts

          {"v":1,"id":"01jb…","type":"patchset-started",…}
          {"v":1,"id":"01jb…","type":"cluster-state",…}
          {"v":1,"id":"01jb…","type":"cluster-state",…}
```

- The tree is always the empty tree. Get its OID with
  `git hash-object -t tree /dev/null` instead of hard-coding it, so SHA-256
  repos work.
- **Identity is set explicitly** on every commit: author `<slug> <slug@crb>`,
  committer `crb <crb@crb>`. Otherwise `git commit-tree` takes the identity
  from the local git config and would push the reviewer's real email with
  every commit (GitDB 19). Set it through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`
  environment variables, never by changing git config.
- **The first line is a short human summary** of the events (`crb: reviewed 2
  clusters in src/server/diff.ts`), so `git log` on a crb ref is readable
  without tooling (GitDB 7). It's informational only: readers use only the
  JSON lines. *(Builder's call on the wording.)*
- After a blank line, the message body has one JSON event per line.
- History is linear: there are no merge commits (see "Squash before push").
- No state is stored in the tree. State is rebuilt by replaying events (see
  "Reading"). Snapshot trees were measured at 3–9 times the size (see
  "Measurements").

## Events

Every event has:

| Field | Meaning |
|---|---|
| `v` | Format version, starting at 1 |
| `id` | Lowercase ULID, unique per event |
| `type` | Event type |
| `ts` | Time the action happened (ms since epoch) |
| `by` | `human`, `ai`, or `auto` for the deterministic re-review engine |
| `actor` | Reviewer slug |
| `details` | Optional. A type-specific object for extra information about the event |

Readers skip event types and versions they don't know, and ignore keys in
`details` they don't recognize, so the format can be extended without breaking
older versions. `details` is informational only: nothing in it can affect
folding or coverage, so the write rules below and the coverage invariant don't
depend on it.

Initial event types:

| Ref | Type | Payload |
|---|---|---|
| meta | `review-created` | source name and key; for `github-pr`: owner, repo, PR number and URL, base branch, head branch and head repository |
| meta | `review-closed` | `merged` or `closed`, merge commit if any |
| meta | `compacted` | see "Compaction" |
| progress | `patchset-started` | patch set number, snapshot id (`revision`), merge base, head; optional, from re-review on: `since` (the patch set it follows, a smaller number), `shape` (`S1`, `S3`, `S4a`, `S4b`, `S4c`, `S5`, `S6`, `S7`), `baseBranch` (GitHub's base branch name then), `interdiff` (`available` or `unavailable`) |
| progress | `cluster-state` | snapshot id (`patchset`), cluster identity hash, file path, state (`unreviewed`, `reviewed`, `crossed-off`), optional reason for crossed off |
| progress | `carried` | `from` and `to` (patch set numbers, `from < to`), `rule` (`exact` or `rename`), `states`: a list of `{ key, fromKey, state }`, one per cluster carried under that rule, `state` being `reviewed` or `crossed-off`; `fromKey` is written only when it differs from `key` (absent means equal: the reader fills it in) |
| progress | `lines-state` | snapshot id (`patchset`), cluster identity hash, file path, `state` (`reviewed` or `crossed-off`), `lines`: line ranges of the cluster (see "Marks on part of a cluster") |
| progress | `since-lines-state` | snapshot id (`patchset`), `since` (an earlier patch set's number), file `path`, `reviewed` and `crossed`: each `{ old, new }` line ranges on the since view's sides; the whole set for that (since, path) |
| progress | `thread-placed` | `thread` (the thread's id), `patchset` (number), `anchor` (`path`, `startSide`, `startLine`, `side`, `line`), `engine` (the tracer's version, a positive integer) |

`carried` holds many clusters in one event, so a move costs one event per
rule, not one per cluster (see "Measurements"). It is written by the engine
only, once, in the same commit as the `patchset-started` it carries into. A
`thread-placed` is the reviewer's own placement of a thread in a patch set
(an AI's later), overriding the engine's; computed placements are never
stored. It lives in the reviewer's progress ref; once sync exists it is
shared through `meta` only when it was placed or moved by hand (owner,
2026-11-07).

Later features (AI groupings, the reviewer's corrections to them) add their
own types.

Write rules, enforced in code (`validateForWrite`, `parseEvent`) and tested;
a reader drops what breaks them:

- `cluster-state` must have `by: "human"`.
- `carried` must have `by: "auto"`; every entry's keys are cluster keys (64
  hex characters, a repeat's `:2` suffix allowed; `fromKey` absent reads as
  `key`) and its state `reviewed` or `crossed-off`, never `unreviewed`.
- `thread-placed` must have `by: "human"` or `"ai"`, never `"auto"`.
- `lines-state` and `since-lines-state` must have `by: "human"`; their
  ranges must parse (pairs of integers, `0 <= start < end`).
- `by: "ai"` events can never change a cluster's state; `by: "auto"` ones
  can only carry one that a human already set (the fold checks, see
  "Reading").
- `agent-thread-resolved` must have `by: "human"` (see "Agent threads ref").
- Agent events (`agent-thread-opened`, `agent-message`,
  `agent-thread-resolved`) are a human's or the agent's (`by: "ai"`), never
  `"auto"`.

## Writing

- **One commit per event.** Each event is written as its own commit right away,
  so nothing is lost if the server crashes and no separate journal is needed.
- **Squash before push.** Every 5 minutes, and when the page closes or the
  server shuts down, the tool takes the events in local commits that aren't on
  the remote yet, writes them as **one** commit on top of the remote tip, moves
  the local ref to it and pushes. The regular flow never rewrites history
  already on the remote, so the push is a fast-forward. The only exception is
  "Compaction", which runs once a review is merged or closed. With sync off, the
  squash base is the previous squash commit instead of the remote tip.
  - With nothing unpushed, a round does nothing.
  - Page close: the browser can't wait for a push while unloading, so the page
    sends a fire-and-forget signal (`navigator.sendBeacon`) to the local server,
    which does the squash and push.
  - Server shutdown: on the normal shutdown signals. A crash skips this, but
    every event is already a local commit, so nothing is lost: unpushed events
    go out on the next start.
- **Compare-and-swap.** Update refs with `git update-ref <ref> <new> <old>`. If
  the ref moved, re-parent the commit onto the new tip and retry. Events are
  append-only, so there's nothing to merge.
- **Several refs at once** (progress and the new `patchsets/<n>` and
  `patchsets/<n>-base` refs when a patch set starts) use one
  `git update-ref --stdin` transaction. A start's `since` must be the
  latest patch set's number as the store holds it at that moment (none for
  PS1): its carries were computed against that patch set, and landing them
  past a newer one would skip that one's human states (principle 2: an
  untick there must stand). A start whose `since` is anything else is
  refused as stale (HTTP 409), whether it lost a race just now or was
  computed long ago, and the client computes it again. A start that loses
  the race on the progress ref reads again and retries; if the snapshot is
  a patch set by now, nothing is written.
- **Starting the next patch set.** `recordStates` on a snapshot that is none
  of the reviewer's patch sets starts one when told how
  (`PatchsetStart`: `since`, `shape`, `baseBranch`, `interdiff` and the
  `carried` events), else refuses it as stale (HTTP 409); PS1 needs no
  start. A write against an earlier patch set is refused as read-only
  (`ReadOnlyPatchsetError`, also 409). New threads and verdicts take the
  same path before their GitHub write (re-review design, "Server").

## Marks on part of a cluster

Added 2026-11-08 (owner: "Marking a cluster as reviewed should affect only
that cluster regardless of the original reworked cluster"; "Breaking the
illusion of a regular review when reviewing an interdiff is a steep price
to pay"). The since view shows the interdiff from an earlier patch set. One
cluster of the patch set's snapshot can show there as several **pieces**:
runs of its changed lines with lines unchanged since the earlier patch set
between them as context. Every piece is reviewed, and crossed off, on its
own, exactly as a cluster is in an ordinary review. A mark still belongs to
the snapshot's clusters (principle 2: coverage comes only from them), so a
piece's mark is a mark on part of its cluster.

**Line ranges.** A cluster's lines are indexed in its own diff, its removed
lines first (`0 … removed - 1`), then its added ones (`removed … lines - 1`).
A set of them is a list of half-open ranges `[start, end)`, normalized
(sorted, merged, none empty): `src/shared/lineRanges.ts`.

**Which lines a piece owns** (`pieceRanges`, `src/shared/pieces.ts`; the
engine computes it for the since view's hunks, `interdiffFileHunks`):

- A shown added line is the cluster's line at its new number. A shown
  removed line is the cluster's removed line at its place in the new base,
  found by position: the since view numbers it in the earlier head (or its
  virtual rebase), and the engine maps it back through that patch set's
  own diff and the bases' diff (`lineKeys.baseLine`); its text must match
  as a guard. Never by text alone: a twin elsewhere (a blank line, a `}`)
  is another line. A line the earlier patch set added, or one that can't
  be mapped, is none of the cluster's.
- A cluster line no piece shows is unchanged since the earlier patch set.
  It joins a piece only when it is unchanged since a line the reviewer
  **reviewed** there: an added line that is the same line as one a reviewed
  earlier cluster added (through the interdiff's line map), or a removed
  base line a reviewed earlier cluster removed too (through the bases' line
  map). Such an added line goes to the piece shown before it (the first
  piece for those before any), a removed one to the first piece. Marking the
  piece may cover it because it reads the same as a line the reviewer
  marked reviewed on the earlier patch set, and nothing about it changed.
  Only a whole `reviewed` mark vouches: a crossed-off or partly marked
  earlier cluster vouches for nothing.
- **Fails closed.** A line unchanged since a line that was *not* reviewed
  (or one the engine can't map) joins no piece. Ticking every piece then
  leaves the cluster partly reviewed (mixed in the full diff), and the
  since view counts it under "only in the full diff". Tested in
  `src/server/rereview/pieces.test.ts` and `src/shared/pieces.test.ts`.
- A removed base line is keyed to the snapshot's cluster that removes that
  base line (by position); a removal with no key of its own otherwise to the
  snapshot's cluster at its place (`clusterAt`): the author changed that
  place again, so its lines are that cluster's piece (the gallery's
  `rr-pieces`, second section).

**`lines-state`.** A piece's mark is written as one commit: a
`cluster-state` `unreviewed` for the whole cluster, then a `lines-state`
`reviewed` for its reviewed lines and one `crossed-off` for its crossed
lines (each only when non-empty). The whole cluster's marks, every time:
no merging with earlier ones. When the marks cover every line one way, the
writer writes the whole mark (`cluster-state` `reviewed` or `crossed-off`)
instead. It is a new event type, not a field of `cluster-state`: a reader
that predates it skips it, and with the reset in front it sees the cluster
**unreviewed**, never more reviewed than the reviewer marked (GitDB 8:
fails closed, so no version bump). The fold applies a `lines-state` only to
a cluster with no whole mark; the coverage join (`buildReviewView`,
`viewOfLines`) drops a cluster's line marks entirely when any range lies
past its lines or it is a file-level cluster. A cluster whose lines are all
marked, some crossed off, counts as reviewed (as a file does) and shows its
crossed lines; one partly marked is unreviewed, with its marked lines in
the line counts (`ClusterView.reviewedLines`, `crossedLines`). A cluster
marked piece by piece never carries and never vouches, even once every
line is marked (its stored entry stays line marks; the carry takes whole
human states only), so a later push asks for it again even when its change
is identical; a `cluster-state` written by the full diff's box ends that.

**Since-only pieces and `since-lines-state`.** A piece that owns no line
of the snapshot (lines the earlier patch set had that are gone, or base
lines restored: "reverted" when the snapshot's diff doesn't touch its
place, else "removed") has nothing in the snapshot to mark. Its mark is
kept against the comparison: the earlier patch set's number, the file's
path, and its lines by number on the since view's two sides (`old`: the
earlier head, or its virtual rebase on the new base; `new`: this head).
One event holds the whole set for a (since, path), reviewed and crossed;
the last wins. **Departure** (owner's brief: "the earlier patch set's
cluster key and the piece's old-side range"): no cluster key, because a
piece can hold lines of no earlier cluster (a base line the earlier patch
set kept); path and range name the lines without one. Both sides are fixed
for a started patch set (its own and the earlier one's heads are pinned),
so the numbers stay put, as long as the virtual rebase comes out the same
(git's merge-tree: a change in it can shift a stale mark; it never marks a
cluster, see below). A mark counts for a piece only when it holds all of
the piece's lines: a range that holds no since-only piece of this
comparison marks nothing, and a range that holds more than the marked
pieces marks every since-only piece inside it, in the since view only. These marks never change a
cluster's state, never carry, and never count in the snapshot's progress;
the since view counts an unmarked since-only piece in "to read", and the
engine's answer lists them per file (`sinceOnly`) and in `toRead`.

**Counts follow the view** (owner, 2026-11-08: "all the counts should be
related to the interdiff, not the base diff"). In the since view every
count is over its **units** (`sinceUnits`, `src/shared/pieces.ts`): each
piece, and the rest of a cluster no piece owns (only the full diff shows
it: lines unchanged since a line not reviewed then, or a cluster the
interdiff doesn't show) for a reworked or new cluster and for any whose
mark is not the engine's carry (one the reviewer unticked), marked as the
folded marks say: no unmarked line is left out (principle 2). A since view
with no units says "Nothing to read", and one the engine failed "Not
counted": never the full diff's numbers. The progress bar
(units, their shown lines, files with any), "to read", the file header
chips, the tree's dots and "needs eyes", and the connector of the
comparison on screen all count them and drop as pieces are marked; the
engine's `toRead` counts every unit, for any other connector. Each file's
header meter counts its own units too. The full diff counts the
snapshot's clusters. None of this is stored.

**Writes** (`ReviewService.recordStates`, `POST /review/states`): a change
with `reviewedLines`/`crossedLines` (state `unreviewed`, no reason) whose
ranges fit the cluster; a change with `sinceMark` (key
`since:<since>:<path>`, a path of printable characters, `since` an earlier
patch set of the reviewer's). Anything else is refused by key (400) before
anything is written.

**Sizes**, measured 2026-11-08 (`reviews.test.ts`, "storage: marks per
piece"): one piece's commit (reset + `lines-state`) 821 bytes raw, about
380 deflated; one `since-lines-state` commit about 470 bytes raw (325
deflated), 909 raw (524 deflated) with 25 pieces of one file marked. A
heavy review, 200 files and 600 clusters each split into 5 pieces ticked
one at a time (4 piece commits, then the whole mark) plus a since-only
piece per file: 5,600 events, 1.8 MB raw, **67 KiB deflated** as one
squashed commit (what a push would carry). Unsquashed, locally, it is
about 3,000 loose commits of under 1 KB each until a squash and `git gc`.

## Inbox ref

Home's per-PR annotations (snooze, waiting on, note; spec
`docs/superpowers/specs/2026-10-28-home-and-always-on-server-design.md`) are
the reviewer's own, so they live in `refs/crb/inbox/<reviewer>` of each
repo's cache clone, next to the review refs: one ref per reviewer per
repository, written only by that reviewer (GitDB 3, 16), events only
(GitDB 5), in the commit format above (empty tree, slug identities,
compare-and-swap). Written by `src/server/home/inbox.ts`.

| Type | Payload |
|---|---|
| `pr-snoozed` | `pr` (number), `until` (ms since epoch), `wakeOnActivity` |
| `pr-waiting-on` | `pr`, `who` (a GitHub login; the reviewer's own means me) |
| `pr-note` | `pr`, `text` (empty clears the note) |
| `pr-cleared` | `pr`, `kind` (`snooze` or `waiting`) |

- **Write rule**, enforced on write and on read: all four need
  `by: "human"`. Nothing automatic hides a PR; an inbox event by anyone
  else is skipped by readers.
- **Fold:** deduplicate by `id`, sort by `(ts, id)`, the last event per
  (PR, kind) wins. Home's Wake up writes one commit of two `pr-cleared`
  events. New events are stamped after the ref's newest, so a clock
  stepping back can't reorder a clear before what it clears.
- **Hiding is computed, never stored:** a snooze hides until `until`, or
  until the PR's GitHub `updatedAt` is strictly later than the snooze
  event's `ts` when `wakeOnActivity`; a wait hides until the named login's
  last commit, comment or review is later than the event. Both are folded
  against the current time on every read.
- **A repo without a clone.** crb commits use the empty tree, so the ref is
  written into a bare repository with none of the project's objects:
  `ensureRepoInit` (`src/server/clone.ts`) runs `git init --bare` and marks
  the repo `crb.initOnly`, with no call to GitHub. The review's first open
  (`ensureClone`) then clones beside it and fetches the branches, tags, HEAD
  and remote URL in locally, keeping the inbox ref in place, and drops the
  mark. The remote URL is the clone's (as `gh repo clone` chose it), not
  guessed at init. The cost: an annotated, never-opened repo's first open
  clones aside and then fetches locally, about twice the disk and time of a
  plain clone, once. `ensureRepoInit` never waits on the repo lock when the
  repo exists, so an annotation doesn't queue behind a running clone.
- **"Me":** a wait on the reviewer's own login. It never hides and shows
  as "you"; no sentinel value is stored (`me` is a real GitHub login).
- **Privacy:** notes are private to the reviewer. Nothing pushes crb refs
  yet; when sync arrives, the inbox ref stays local unless the reviewer
  turns it on (GitDB 20).
- **Size**, measured 2026-10-29: 100 commits (125 events: snoozes, waits,
  notes, wakes over 30 PRs) took 404 KiB loose and 18 KiB packed after
  `git gc`; an append took 14 ms and a cold read of the fold 5 ms. No
  compaction, as for review refs.

## Agent threads ref

Review buddy's threads (spec
`docs/superpowers/specs/2026-11-04-review-buddy-design.md`): the reviewer
asks their own agent about a span of the diff and it answers in a thread
only that reviewer sees. One ref per reviewer per review, beside progress:

```
refs/crb/reviews/<review-id>/reviewers/<reviewer>/agent/threads
```

`agent/` leaves room for other channels of agent data beside `threads`
(owner, 2026-11-04). Written only by this server on the reviewer's behalf
(GitDB 3, 16), events only (GitDB 5), in the commit format above (empty
tree, slug identities, compare-and-swap). Written by
`src/server/agent/store.ts`.

| Type | By | Payload |
|---|---|---|
| `agent-thread-opened` | human or ai | `thread` (lowercase ULID), `anchor` (`subject` `line`: path, commit, side, line, startSide, startLine, optional columns; or `file`: path, commit), `text`, optional `truncated`; `agent` `{name, version}` (required by ai); a human's carries `details.clientId` |
| `agent-message` | human or ai | `thread`, `text`, optional `truncated`; ai: `agent`, `stop` (the ACP stop reason or `error`), `activity` (`{kind, title, decision?}`, titles only), `replyTo` (the event id of the last human message the prompt included; a lower ULID, ai only), `error` (with `stop: "error"` only: the agent's reason for the failed turn, one line, at most 1000 characters; an event with it anywhere else is dropped); a human's carries `details.clientId` |
| `agent-thread-resolved` | human | `thread`, `resolved` (`false` reopens) |

- **Write rule**, enforced on write and on read: the agent may open a
  thread and answer in one, never resolve one; an `agent-thread-resolved`
  by ai is skipped by readers, and so is an ai-opened thread without its
  `agent`.
- **Fold:** deduplicate by `id`, sort by `(ts, id)`. Threads in the order
  they were opened; the opening text is the first message. A thread waits
  while a human message has no answer: one comes after the last ai
  message's `replyTo` (the last human message its prompt included), or,
  for an ai message without `replyTo`, after that ai message; with no ai
  message, any human message waits (an agent-opened one doesn't until the
  reviewer replies). A reply sent while its thread's turn runs is stamped
  before the answer, so `replyTo` is what keeps it waiting, across
  restarts; resolved is the last `agent-thread-resolved`'s
  word, false before any. Messages and resolves of a thread never opened
  are dropped. New events are stamped after the ref's newest.
- **Resends:** a human's question carries the page's `clientId` in
  `details` (informational: the fold ignores it). The store remembers the
  ones in the ref and the ones it wrote, so Ask pressed twice, or resent
  after a server restart, writes one thread; a message's `clientId` counts
  only on its own thread. The dedupe and the timestamp order hold within
  one store, so the server keeps one store per review and reviewer.
- **Caps:** the writer cuts a text at 32 KiB of UTF-8 (`MAX_AGENT_TEXT`, on
  a code point) and flags it `truncated`, and keeps an activity list's
  first 50 entries, fewer if its JSON passes 4 KiB. Readers skip an event
  whose text is over 32 KiB or whose activity has more than 50 entries; the
  4 KiB byte cap is the writer's alone. The anchor's code is computed from the clone on read, never stored.
- **Privacy:** the threads are the reviewer's own (not secret, only
  theirs). Never pushed; like the inbox, when sync arrives the ref stays
  local unless the reviewer turns it on (GitDB 20): a future push of
  `reviewers/<reviewer>/*` must exclude `agent/`.
- **Size**, measured 2026-11-07 (`pnpm tsx scripts/measure-agent-ref.ts`, a
  4-core machine under load ~9; CPU is carbonless's process plus its git
  children):

  | Measure | Value |
  |---|---|
  | Events | 50 threads × 4 messages of 2 KiB of prose (200 commits, 400 KiB of text) |
  | Loose size | 804 KiB |
  | Packed size (`git gc`) | 139 KiB |
  | One append to the full ref (median of 9) | 73 ms wall; CPU 16 ms + 20 ms git |
  | Cold `read()`, loose (median of 9) | 28 ms wall; CPU 9 ms + 10 ms git |
  | Cold `read()`, packed (median of 9) | 27 ms wall; CPU 9 ms + 10 ms git |

  Well inside the bounds set for it (an append under 100 ms of CPU, a cold
  fold under 200 ms, under 300 KiB packed), so texts stay in commit
  messages; moving long ones to tree blobs (GitDB 6) is the fallback. No
  compaction, as for review refs.

## Reading

1. `git rev-list <ref>`, then read the commit messages (one
   `git log --format=%B` or `git cat-file --batch` call).
2. Parse events, drop duplicates by `id`, and sort by `(ts, id)`.
3. Fold into state (`foldProgress`): every `patchset-started` is a patch
   set, in start order (a repeated number or snapshot id is ignored), each
   with its own state map keyed by its snapshot id; then, replaying the rest
   in order, a human `cluster-state` sets its cluster's entry in the patch
   set on its snapshot id (none: ignored), a human `lines-state` marks its
   lines of a cluster that holds no whole mark (reviewed lines and crossed
   lines, each taking its lines from the other), a human `since-lines-state`
   replaces the patch set's mark on since-only pieces of its (since, path),
   a `carried` entry sets the `to`
   patch set's entry as `{ state, carried: { from, rule } }`, and a
   `thread-placed` replaces the thread's placement in its patch set. For
   each `(patch set, cluster)`, the last event wins, so a human mark after a
   carry overrides it.
   **The carried guard** (principle 2): an entry counts only when `from`
   and `to` are known patch sets and, at that moment of the replay, the
   source cluster (`fromKey` in `from`) holds a human state (not itself
   carried) that is `reviewed` or `crossed-off` and equal to the entry's.
   An entry whose source is unreviewed, missing, carried, of another state,
   or set only later, and an event naming an unknown patch set, are ignored
   entry by entry: a forged or stale carry can only leave the target
   unreviewed. The other half, that the target cluster really is the same
   change, is the engine's correctness, covered by its own tests.
4. Cache the parsed events in memory, keyed by the ref and its tip OID
   (`RefStore.readEvents`, a bounded map). A commit's history never changes,
   so an unchanged tip skips `git log`; folding the cached events again is
   cheap.

This is the same idea as git's `cat_sort_uniq` notes merge (concatenate, sort,
drop duplicates), applied to the commit graph: the set of events is the union of
everything reachable from the ref, so merging two copies never conflicts.

**Coverage** is computed exactly as in the parity spec: clusters come from the
git diff of the snapshot being reviewed, and take their states from the map
of the patch set on that snapshot id (`buildReviewView`), so an earlier patch
set folds against its own snapshot the same way as the latest. A cluster with
no folded state is unreviewed. A folded state with no matching cluster is
ignored. Only the reviewer's own progress ref is folded. States only count
against the patch set's own snapshot, and anything ambiguous stays
unreviewed: two clusters sharing one identity (never expected). A
`crossed-off` state counts as crossed off with or without a reason; crossed
off never counts as reviewed. A carried state keeps its `carried` mark in
the view, so the page can show where it came from.

## After a push

- A reviewer with a patch set keeps seeing their latest patch set's snapshot:
  its merge base and head, as recorded in `patchset-started` and pinned by
  `patchsets/<n>` and `patchsets/<n>-base`. Newer pushes are shown beside it
  (the re-review design's patch set graph; until it lands, a banner).
- Coverage is computed against that snapshot's diff, so a push never changes
  what the reviewer sees as reviewed or unreviewed.
- A reviewer with no patch set yet sees the current head.
- Any earlier patch set opens as reviewed (`Session.reviewAt(n)`): its
  snapshot is rebuilt from the pins and its hunks and context load by its
  snapshot id like the current one's; writes against it are refused.
- Moving to a newer push starts the next patch set with its carries (the
  re-review design's engine and UI; the store side is "Writing").

## Last-seen head

The PR's head when this crb instance last opened a review is kept outside
git, as `$XDG_STATE_HOME/carbonless/seen/<review-id>.json` (`{ head, at }`,
written atomically on every open after the previous value was read into
`SessionInfo.lastSeen`; `src/server/seen.ts`). It is UI state, private to the
instance: it lets the page say what is new since the reviewer last looked
before any patch set exists, and it never affects folding or coverage. An
unreadable or malformed file reads as none.

## Sync with the remote

**Not in the first milestone** (reviewer's decision, 2026-10-23). The PR review
parity milestone keeps all refs in carbonless's private clone and pushes
nothing, so it has no squash before push, no fetch of review refs, no "who else
started" check and no compaction. Writing there is: one commit per event,
compare-and-swap, no push. The format below stays ready for sync.

- **On by default** (once sync exists). Review refs are pushed to the PR's remote, so a reviewer's
  slug and their progress are visible to anyone who can read that remote's refs.
  A per-repo setting turns sync off. *(Builder's call on where it lives.)*
- **Fetch only what's open.** For a review the reviewer opens, fetch its
  `meta` and the reviewer's own refs (`reviewers/<reviewer>/*`), plus the single
  `refs/crb/lookup/<source>/<key-hash>` lookup ref. Never fetch `refs/crb/*` as a whole:
  with 100k reviews that made a fetch with nothing new take 2 s instead of 8 ms.
- **Who else started:** list other crb reviewers with
  `git ls-remote <remote> 'refs/crb/reviews/<id>/reviewers/*'`. This reads ref
  names only and fetches no objects. It complements, and doesn't replace, the
  parity spec's "Who's on it" section, which covers reviewers in other tools from
  GitHub's data (requested reviewers, submitted reviews, commenters). The ref
  check adds crb reviewers who haven't submitted anything on GitHub yet. A
  GitHub review that's started but not submitted is visible only to its author,
  so neither source can show it. Neither source feeds coverage.
- **Fetch into a separate namespace**, for example
  `+refs/crb/reviews/<id>/meta:refs/crb-remotes/<remote>/reviews/<id>/meta`.
  Never fetch straight over local refs that may have unpushed events.
- **Integrate:** the squash step does it. Because the squashed commit is built
  on top of the fetched remote tip, events that arrived from another machine
  are kept through ancestry and local ones are added on top. No merge commits
  are needed.
- **Push** only meta and the reviewer's own refs, with `--atomic`.
  Regular pushes are plain fast-forwards. Only compaction pushes with
  `--force-with-lease`.

## Compaction

When a review's PR is merged or closed, compaction can rewrite each of its refs
to a single commit holding every event (deduplicated and sorted), so `git gc`
can drop the old commits. Rules:

- No event may be lost. A test compares the folded state and the set of event
  IDs before and after.
- A `compacted` event records that it happened. A client that sees a compacted
  ref on the remote replaces its local copy instead of merging, otherwise the old
  history comes back.
- Pushing a compacted ref needs `--force-with-lease`.

Closed reviews are kept forever, compacted, along with their lookup refs.
Tracked in `docs/todo.md`.

## Deferred

- Sharing `thread-placed` through `meta` once sync exists, for placements
  made or moved by hand only (owner, 2026-11-07).
- Earlier patch sets are read-only in this round (owner, 2026-11-07).

## Measurements

From a simulation on this machine (git 2.53, synthetic repos, local `file://`
transport). GitHub's server-side behavior was not measured. The simulation
scripts are not in the repo yet.

**Storage per review** after `git gc`. Typical review: 2 reviewers × 150 events,
40 files, 3 revisions. Every event holds three random OIDs, so these are on the
pessimistic side.

| Layout | One commit per event | One commit per 10 events |
|---|---|---|
| Nested state tree per file | 333 KiB | 147 KiB |
| One flat state file | 221 KiB | 73 KiB |
| **Events in messages, empty tree (chosen)** | 105 KiB | **37 KiB** |

With one commit per event and squash before push, a review's local copy sits
near the 105 KiB column until squashed and garbage-collected. Squashes happen
every several events or more, so what reaches the remote should land at or
below the 37 KiB column.

A heavy review (3 reviewers × 600 events, 200 files, 6 revisions) took about
2 MiB with the nested layout.

**A patch set start with carries**, measured 2026-11-07 in
`src/server/review/reviews.test.ts` ("storage: a start carrying 200
clusters"): the commit holding `patchset-started` and one `carried` event of
200 entries, raw (`git cat-file -s`) and deflated (as git stores it):

| 200 entries | raw | deflated |
|---|---|---|
| every `fromKey` equal to `key` (omitted; the exact rule's usual case) | about 20 KB | about 8 KB |
| every `fromKey` different (renames, moved context) | about 35 KB | about 15 KB |

An entry is one or two 64-hex cluster keys and a state (about 90 or 170
bytes); the design doc's 7 KiB estimate assumed 32-hex keys. The test
asserts under 20 KiB raw and 10 KiB deflated for the first case and 40 KiB
and 20 KiB for the second. A review's cost still depends only on its own
size: one such commit per patch set start per reviewer, nothing per
cluster.

**Everyday git** (ms, median of 5) on a 3,000-commit, 2,000-file repo, with the
review refs on the remote and the clone using the default refspec:

| Reviews on remote | status | log -50 | switch | commit | fetch | clone | `log --all -1` |
|---|---|---|---|---|---|---|---|
| 0 | 4 | 3 | 4 | 5 | 8 | 312 | 4 |
| 10k (30k refs) | 4 | 4 | 3 | 6 | 8 | 329 | 14 |
| 100k (300k refs) | 4 | 4 | 4 | 5 | 8 | 314 | 112 |

Default clones and fetches don't see `refs/crb/*` at all: they ask only for
branches and tags, and with git's protocol v2 the server only advertises refs
the client asks for. A single-review prefix lookup took 4 ms at both 0 and 100k
reviews.

## Testing

- Unit: event parsing and validation (unknown types skipped, the write rules
  above); fold determinism (same events in any order and duplicated give the same
  state); last-event-wins; the coverage join from the parity spec; a `reviewed`
  event in another reviewer's progress ref never changes this reviewer's
  coverage.
- Unit, re-review: `carried` and `thread-placed` round-trip, and each way
  they can break the write rules is dropped on read and refused on write;
  the fold keeps every patch set with its own map, and each way a carried
  entry can be wrong (source unreviewed, missing, itself carried, of another
  state, set later; an unknown `from` or `to`) leaves the target unreviewed;
  a human mark after a carry wins; `buildReviewView` applies PS1's states to
  PS1's snapshot and PS2's to PS2's.
- Git integration, with throwaway repos (`test/git-fixture.ts`): compare-and-swap
  retry; squash before push keeps every event, builds on the remote tip and
  pushes as a fast-forward, including when another machine pushed in between;
  fetch of a single review into `refs/crb-remotes/`; a default clone of a repo
  with crb refs gets no `refs/crb/*`; compaction keeps every event; a patch
  set's head is still readable after the branch is force-pushed and
  `git gc --prune=now` runs, and its merge base after the base branch is
  deleted; with a git config that sets a real user email, crb commits still
  carry only the slug and tool identities; starting PS2 writes `since`, the
  carries and both pins in one commit and one transaction, twice at once
  ends with one PS2, a write against PS1 is then read-only, and against an
  unknown snapshot without a start stale; the 200-entry carry's size.
- Playwright: state persists across restarts through the refs; a revision the
  reviewer never acted on doesn't create a patch set; after a force-push, a
  reviewer with a patch set still sees its diff and progress unchanged, with
  the newer-pushes banner.

## Open questions for the reviewer

None at the moment.
