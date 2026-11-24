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

**Re-review after new pushes** (design: the
document "Re-review after new pushes: design" on Linear CAR-5) adds to this format
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
| progress | `lines-carried` | `from` and `to` (patch set numbers, `from < to`), `states`: a list of `{ key, fromKey, state, lines, fromLines }`, `lines` of cluster `key` in `to` taking `state` (`reviewed` or `crossed-off`) from as many `fromLines` of cluster `fromKey` in `from`; see "Line carries" |
| progress | `lines-state` | snapshot id (`patchset`), cluster identity hash, file path, `state` (`reviewed` or `crossed-off`), `lines`: line ranges of the cluster (see "Marks on part of a cluster") |
| progress | `split-carried` | snapshot id (`patchset`), `states`: a list of `{ key, fromKey, state, from?, lines? }`, one per piece of a hunk cut at its whitespace-only runs (or two, one per state), `fromKey` the whole hunk's key before, `state` `reviewed` or `crossed-off`, `from` the hunk's line ranges it takes (for a hunk marked by lines), `lines` the piece's (only for part of it, as many as `from`); see "Split carries" |
| progress | `since-lines-state` | snapshot id (`patchset`), `since` (an earlier patch set's number), file `path`, `reviewed` and `crossed`: each `{ old, new }` line ranges on the since view's sides; the whole set for that (since, path) |
| progress | `thread-placed` | **read only since CAR-139** (never written again; read as a move, see "Thread moves"): `thread` (the thread's id), `patchset` (number), `anchor` (`path`, `startSide`, `startLine`, `side`, `line`), `engine` (the tracer's version, a positive integer) |

`carried` holds many clusters in one event, so a move costs one event per
rule, not one per cluster (see "Measurements"). It is written by the engine
only, once, in the same commit as the `patchset-started` it carries into. A
`thread-placed` was the reviewer's own placement of a thread in a patch set,
overriding the engine's; computed placements are never stored. Since
CAR-139 nothing writes it: a placement by hand is a `thread-moved` in the
reviewer's agent threads ref (see "Thread moves"), and the old events in
progress refs are read as moves, never migrated.

Later features (AI groupings, the reviewer's corrections to them) add their
own types.

Write rules, enforced in code (`validateForWrite`, `parseEvent`) and tested;
a reader drops what breaks them:

- `cluster-state` must have `by: "human"`.
- `carried` must have `by: "auto"`; every entry's keys are cluster keys (64
  hex characters, a repeat's `:2` suffix allowed; `fromKey` absent reads as
  `key`) and its state `reviewed` or `crossed-off`, never `unreviewed`.
- `split-carried` must have `by: "auto"`; every entry's `key` and `fromKey`
  are cluster keys, its state `reviewed` or `crossed-off`; `from` and
  `lines` parse as ranges, non-empty, and `lines` comes only with a `from`
  of as many lines. One bad entry drops the event.
- `lines-carried` must have `by: "auto"`; every entry's `key` and `fromKey`
  are cluster keys, its state `reviewed` or `crossed-off`, and `lines` and
  `fromLines` parse as non-empty ranges of as many lines. One bad entry
  drops the event.
- `thread-placed` must have `by: "human"` or `"ai"`, never `"auto"`; only
  a human's is read as a move.
- `thread-moved` and `thread-move-undone` must have `by: "human"` (see
  "Thread moves").
- `lines-state` and `since-lines-state` must have `by: "human"`; their
  ranges must parse (pairs of integers, `0 <= start < end`).
- `by: "ai"` events can never change a cluster's state; `by: "auto"` ones
  can only carry one that a human already set (the fold checks, see
  "Reading").
- `agent-thread-resolved` and `agent-comment-posted` must have `by:
  "human"` (see "Agent threads ref").
- An `agent-thread-opened` with a `review` anchor (the review conversation)
  must have `by: "human"`.
- `agent-thread-linked` must have `by: "human"` (see "Agent threads ref").
- Agent events (`agent-thread-opened`, `agent-message`,
  `agent-thread-resolved`, `agent-thread-seen`, `agent-comment-posted`,
  `agent-thread-linked`) are never `"auto"`; opened and message events are
  a human's or the agent's (`by: "ai"`), resolved, seen, comment-posted and
  linked a human's only.

## Writing

- **One commit per write.** Each states request (one or several reviewer
  actions, such as a mark, or every cluster a "Mark remaining reviewed" or a
  file reset changes; an action over 1000 clusters spans requests,
  `MAX_CHANGES`) is committed right away as one commit, so nothing is lost if
  the server crashes and no separate journal is needed. A request's events
  share that commit, so a reader (a reload, another tab) sees all of them or
  none: never a reset half done (CAR-215). Starting a patch set is its own
  commit before the marks; read between the two, the patch set is there with
  nothing marked, which only looks less reviewed.
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
  append-only, so there's nothing to merge. A write whose events depend on
  what the ref holds builds them again from the new tip's events on every
  try (`RefStore.appendBuilt`): a states write checks again that its patch
  set is still the latest and stamps after the new tip's events, so a
  patch set another process started in between makes it fail as read-only,
  never land on the old one (CAR-229). Agent-thread writes (messages,
  moves, undos, links…) and inbox writes do the same: a retry stamps after
  the new tip's events and checks again (a resend already stored writes
  nothing, an undo of a move no longer live or a move past the cap is
  refused), so a retried event never folds before one it lost the race to
  (CAR-245).
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
  as a guard. A line the base move brought or changed (a rebase onto a
  base that edited that very line) has no place that way; its GitHub
  LEFT line on the head (`lineKeys.githubLeft`, the virtual rebase
  against the new base) places it instead, only when the tracer names it
  the base move's (`lineKeys.baseMoved`: not placed, not the earlier
  patch set's own, in a file whose head file pairs with it), the earlier
  patch set didn't add it, no row `baseLine` places claims that base
  line, and with the same text guard (CAR-277; otherwise the cluster's
  line is also an orphan row, shown twice). Never by text alone: a twin elsewhere (a blank line, a `}`)
  is another line. A line the earlier patch set added, or one that can't
  be mapped, is none of the cluster's.
- A cluster line no piece shows is unchanged since the earlier patch set.
  It joins no piece: ticking the pieces marks only what they show.
  Instead it **carries** the mark its counterpart held there (owner,
  2026-11-17: a crossed-off line "should work exactly like marking as
  reviewed"), see "Line carries" below.

- A removed base line is keyed to the snapshot's cluster that removes that
  base line (by position); a removal with no key of its own otherwise to the
  snapshot's cluster at its place (`clusterAt`): the author changed that
  place again, so its lines are that cluster's piece (the gallery's
  `rr-pieces`, second section).

**Line carries** (CAR-195). When the next patch set starts, each line of
a reworked or new cluster that no piece of the since view shows takes the
mark its counterpart on the earlier patch set held by hand, reviewed or
crossed off, with no tick: as a carried cluster does, line by line
(`sinceLineCarries`, `src/server/rereview/engine.ts`). The counterpart
(`sinceLineSources`):

- an added line: the earlier cluster's added line it is, through the
  interdiff's line map; a removed base line: the earlier cluster's removed
  line at the same place in the new base (the bases' line map). A line's
  place in its earlier cluster is its rank among that cluster's mapped
  lines, only when all of them map (else none).
- **Slider twins.** git may show the same insertion with a different one of
  two identical neighbouring lines as the added one (`blank, comment, set`
  after a blank, or `comment, set, blank` before it): the earlier patch
  set's diff took one, this one's the other. On the earlier side, a line no
  earlier cluster added, right next to a run of one cluster's added lines
  and reading as the run's far end (above: its last line; below: its first;
  and on, line by line, as git's slider would move it), stands for that
  line. Only that adjacency counts, never text alone; a line two runs claim
  stands for neither.
- **One to one.** Each earlier line stands for at most one line of the file
  (itself or one twin, whichever is asked first).

The earlier marks are read through the coverage join, by hand only
(`humanMarksOf`: a mark still the engine's, a cluster's or lines', carries
no further, as with `carried`). A hand mark of part of the cluster (a
since piece's tick) writes the cluster's whole set of marks, carried lines
included, so it **adopts** them: from then on they are the reviewer's own
marks, and they carry on to a later patch set like any hand mark (each hop
is a line unchanged since a line marked by hand, so content-equivalent).
Only the "N carried" chip goes with that. A line with no counterpart, or one whose
counterpart wasn't marked, gets nothing (principle 2): an **orphan**
(CAR-216, `orphanLines`). The since view shows it at its place as the
change it is (an added line at its new number, a removed base line with
its base number), each run of them a piece of its own chipped "not
reviewed in PS*n*", whose box marks exactly those lines with the same
`lines-state` as any piece (nothing new is stored). Typically git aligned
the base's identical lines another way in each patch set's diff (a blank
that was context becomes an added one). Computed on read from the
target's clusters, after the carries; should placing one fail, it stays
the cluster's "rest", to read until marked in the full diff.
Stored as one `lines-carried` event in the start's commit, beside
`carried`; the viewed head shows the same carries before that
(`overlayCarries`, from the engine's answer: each reworked or new
cluster's `lines`). The view marks the lines and names them
(`ClusterView.linesCarried`); the full diff shows "N carried" on the
cluster, and its box undoes them like any mark (a human `cluster-state`
replaces the entry). The since view doesn't count a carried line while it
holds a mark; unmarked again, it counts (`sinceUnits`). The fold takes an
event only from the patch set its target follows (`since`), and, as with
`carried`, trusts the ref's writer for the source cluster's size.

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
marked piece by piece never carries whole, even once every line is
marked (its stored entry stays line marks; the cluster carry takes whole
human states only), so a later push asks for it again even when its change
is identical (its unchanged lines carry by line); a `cluster-state`
written by the full diff's box ends that.

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
| `agent-thread-opened` | human or ai | `thread` (lowercase ULID), `anchor` (`subject` `line`: path, commit, side, line, startSide, startLine, optional columns; `file`: path, commit; `thread`: GitHub thread node id `thread` (1 to 200 characters, not a ULID), path, commit, and optionally side, line, startSide, startLine; or `review`: the review conversation, no other key (any other is dropped on read), human only), `text`, optional `truncated`; `agent` `{name, version, via?, machine?}` (required by ai; `via` `acp` or `mcp`, and a joined session's `machine`: optional, a bad value is dropped and the event kept; a few dozen bytes, this ref is never pushed); ai only: `origin` (below) and `suggests` (`"resolve"`: MCP `open` on a GitHub thread, since 2026-11-23; readers keep it only on a `thread` anchor, dropping the field, not the event, on code); human only: `view` (below); a human's carries `details.clientId`, an ai one opened with the agent's idempotency key `details.key` |
| `agent-message` | human or ai | `thread`, `text`, optional `truncated`; ai: `agent` (as above; a joined session's `name` is how it named itself, `version` its harness string, `via` `mcp`, and `machine`; a spawned agent's, written by its MCP `reply` too since 2026-11-13, `via` `acp` with its `agentInfo` name and version), `stop` (the ACP stop reason or `error`), `activity` (`{kind, title, decision?}`, titles only), `replyTo` (the event id of the last human message the answer replies to: `reply`'s `replyTo`, or the question a stopped or failed hand-out ends; a lower ULID, ai only), `error` (with `stop: "error"` only: the agent's reason for the failed turn, one line, at most 1000 characters; an event with it anywhere else is dropped); ai only: `head` (the OID of the checkout the answer came from; older ACP answers only, none since 2026-11-13), `suggests` (`"resolve"`), `origin` (below; an origin message has `stop: "end_turn"`, empty `activity`, no `replyTo`, `details.key` when the agent gave one, and may carry `suggests`); human only: `view`; a human's carries `details.clientId` |
| `agent-thread-resolved` | human | `thread`, `resolved` (`false` reopens) |
| `agent-thread-seen` | human | `thread`, `upTo` (the id of the last message the reviewer has seen; a lowercase ULID) |
| `agent-comment-posted` | human | `thread`, `message` (the agent message's id, a lowercase ULID), `block` (the ```` ```comment ```` block's index in that message, from 0), `clientId` (`ag.<thread>.<message>.<block>`, the comment's marker id), `github` `{thread, comment, url}` (the GitHub thread and comment node ids, and the comment's https link), `text` (what the reviewer posted, at most 32 KiB) |
| `agent-thread-linked` | human | `thread`, `github` (a GitHub thread node id, 1 to 200 characters): the reviewer posted a GitHub thread from this span conversation (its card's Comment; since 2026-11-16) |

`view` is the comparison on screen when a human message was sent:
`target` (`{patchset}` or `{head}`), `from` (`{branch: true}` or
`{patchset}`), and the resolved `left` and `right` commit OIDs, and (since
CAR-276, 2026-11-24) `base`: the merge base of `right` that LEFT line numbers
name (the since view's too, since CAR-217); a view without it from a patch
set may name a patch set's lines, so Comment on GitHub stays off for its LEFT
lines. About 50 bytes per human message (74 with SHA-256 OIDs); a
malformed `base` is dropped, its message kept. Readers drop
an event whose `view` is malformed, or carried by an ai event; the same
for `origin` on a human event, `head` on a human message, `suggests` on a
human opening or message,
and any `agent-thread-seen` by ai.

`origin` `{thread, message}` (two lowercase ULIDs, ai only; since
2026-11-15) is the request an agent message came from: the reviewer's
message the agent was answering when it called MCP `open`. It sits on the
event that carries the message: `agent-thread-opened` for a conversation
the agent opened (its text is the first message), `agent-message` for one
it continued (a GitHub thread that already had a conversation). It
replaces the earlier `origin: {request}` text, which nothing wrote; readers
drop an event with that shape. The fold drops an origin unless its
`thread` folds to a thread (an alias counts as its first opening) and its
`message` is a human message there. "Started N" on a request message is
folded from the origins on read (`startedBy`), never stored.

- **Write rule**, enforced on write and on read: the agent may open a
  thread and answer in one, never resolve one; an `agent-thread-resolved`
  by ai is skipped by readers, and so is an ai-opened thread without its
  `agent`. Only a human has seen a thread: `agent-thread-seen` by ai is
  refused on write and skipped on read, so nothing automatic can make an
  answer look seen. Only the reviewer posts to GitHub:
  `agent-comment-posted` by ai is refused on write and skipped on read
  (CAR-83, since 2026-11-16). It is written after GitHub took the comment,
  once per block (the store writes nothing for a block already recorded).
  The review conversation is the reviewer's to open: an
  `agent-thread-opened` by ai with a `review` anchor is refused on write
  and skipped on read. Only a human links one to a GitHub thread
  (`agent-thread-linked`, the same rule).
- **The review conversation** (`anchor: {subject: "review"}`, spec
  `docs/superpowers/specs/2026-11-13-review-conversation-design.md`): one
  agent conversation about the whole review, with no path or commit. At
  most one per review: the store refuses a second opening (the route
  answers 409 naming the one there; a resend of the same `clientId`
  returns it), and on read later review openings fold into the first, as
  for a GitHub thread (below), so a race or a hand-edited ref never shows
  two. Never resolved: the host refuses the resolve (409) and the fold
  ignores any `agent-thread-resolved` for it, so it always counts as open
  for the waiting rules (`isAgentQuestion`). Placement, the code window
  and the GitHub join skip it.
- **Fold:** deduplicate by `id`, sort by `(ts, id)`. Threads in the order
  they were opened; the opening text is the first message. A thread waits
  while a human message has no answer: one comes after the last answer's
  `replyTo` (the last human message its prompt included), or, for an
  answer without `replyTo`, after that answer; with no answer, any human
  message waits (an agent-opened one doesn't until the reviewer replies).
  An ai message with an `origin` is not an answer: the rule skips it, so a
  question waiting on a thread stays waiting when the agent adds an origin
  message there (principle 8). A reply sent while its thread's turn runs is stamped
  before the answer, so `replyTo` is what keeps it waiting, across
  restarts; resolved is the last `agent-thread-resolved`'s
  word, false before any. Messages and resolves of a thread never opened
  are dropped. New events are stamped after the ref's newest.
  **One conversation per GitHub thread, one review conversation:** openings
  whose `thread` anchors name the same GitHub thread, and openings with a
  `review` anchor, fold into the first one (its `id` stays): a
  later opening's text joins as a message in `(ts, id)` order, and
  messages, seen marks and resolves written under its own thread id join
  too. `seenUpTo` is the `upTo` furthest along in the thread's messages (an
  older mark written later does not move it back; an `upTo` the fold
  doesn't hold counts for nothing); `unread` is an ai message after it, or
  any ai message when there is none. An ai-opened thread is unread until
  seen; the store writes no `agent-thread-seen` when the thread is already
  seen up to there or later. `agent-thread-resolved` folds as ever for a
  thread anchor; whether it counts is the GitHub join's call.
  `agent-comment-posted` folds onto its message as `posted: [{block, url,
  at, text}]` (by block; the first record of a block wins), only onto an
  ai message the thread holds; any other is dropped. A record on a
  `line` or `file` conversation also joins it to the GitHub thread its
  block started (CAR-236): the fold reads it as a `thread` anchor on the
  first such record's `github.thread` (with the lines it was asked on),
  so it is that thread's conversation (later openings on that thread fold
  into it, and the GitHub join resolves and places it by that thread). The
  fold keeps where it was asked and every thread its blocks started, in
  record order: the GitHub join puts it on the first one still live, and
  back where it was asked when none is (an orphan) or while GitHub can't
  be read (`githubUnknown`). A thread another conversation was already
  opened on stays that one's. Derived on read only: no event records the
  join, so conversations posted before it join too. Its threads are
  ordered by when GitHub took each comment (the link's
  `#discussion_r<id>`, GitHub's increasing id), not by when the record was
  written: a record that failed is written on a later load. The page gets
  the thread it's on and where it was asked (`joined`), and placements
  trace it where it was asked, so a view that doesn't list its thread
  (an earlier patch set, or GitHub's threads failed) shows it there.

  **Links:** an `agent-thread-linked` turns a span conversation (`line` or
  `file`) into that GitHub thread's: its anchor becomes a `thread` anchor
  on the same span (path, commit, sides and lines; no columns), folded on
  read, never stored as state. Its id and every message stay; later
  openings on that GitHub thread join it as above. The fold drops a link
  of a thread never opened, a second link of a conversation (the first
  wins), and a link onto a GitHub thread that already has a conversation
  (that conversation came first; the linked one stays on its span, still
  listed). Only a human links: by ai is refused on write and skipped on
  read. The server writes it only after GitHub has the new thread (POST
  `threads` with `agentThread`, and on its resend, which writes nothing
  new), and only when the posted span is the conversation's (path,
  commit, sides and lines); a refused post links nothing, and a link the
  server won't write leaves the conversation on its span, the answer's
  `agentLinkProblem` saying why on its card. A draft moved to a new head
  drops its `agentThread`. If the GitHub thread goes, the
  conversation is an orphan on its recorded span, as any thread
  conversation is. One event per link, measured 2026-11-16 with a
  28-character node id: a 241-byte commit message, a 416-byte commit
  object (uncompressed; the tree is the shared empty one). Nothing else
  is stored: the new anchor is folded from the old one.
- **Resends:** a human's question carries the page's `clientId` in
  `details` (informational: the fold ignores it). The store remembers the
  ones in the ref and the ones it wrote, so Ask pressed twice, or resent
  after a server restart, writes one thread; a message's `clientId` counts
  only on its own thread. The agent's `open` may carry a key
  (`details.key`): an opening with a key already in the ref returns that
  thread, and an origin message with a key already written to that thread
  is not written again; agent keys and human `clientId`s never match each
  other. The dedupe and the timestamp order hold within
  one store, so the server keeps one store per review and reviewer.
- **Caps:** the writer cuts a text at 32 KiB of UTF-8 (`MAX_AGENT_TEXT`, on
  a code point) and flags it `truncated`, and keeps an activity list's first 50 entries, fewer if
  its JSON passes 4 KiB. Readers skip an event
  whose text is over 32 KiB or whose activity has more than 50 entries; the
  4 KiB byte cap is the writer's alone. The anchor's code is computed from the clone on read, never stored.
- **Privacy:** the threads are the reviewer's own (not secret, only
  theirs). Never pushed; like the inbox, when sync arrives the ref stays
  local unless the reviewer turns it on (GitDB 20): a future push of
  `reviewers/<reviewer>/*` must exclude `agent/`.
- **Size**, measured 2026-11-11 (`pnpm tsx scripts/measure-agent-ref.ts`, a
  4-core machine, load ~1; CPU is carbonless's process plus its git
  children). Format with thread anchors, a `view` on every human message, a
  `head` on every answer and one `agent-thread-seen` per answer (2026-11-07,
  before these: 804 KiB loose, 139 KiB packed):

  | Measure | Value |
  |---|---|
  | Events | 50 GitHub-thread conversations × 4 messages of 2 KiB of prose (200 message commits + 100 seen, 400 KiB of text) |
  | Loose size | 1204 KiB |
  | Packed size (`git gc`) | 163 KiB |
  | One append to the full ref (median of 9) | 27 ms wall; CPU 16 ms + 20 ms git |
  | Cold `read()`, loose (median of 9) | 15 ms wall; CPU 12 ms + 10 ms git |
  | Cold `read()`, packed (median of 9) | 14 ms wall; CPU 8 ms + 10 ms git |

  Well inside the bounds set for it (an append under 100 ms of CPU, a cold
  fold under 200 ms, under 300 KiB packed), so texts stay in commit
  messages; moving long ones to tree blobs (GitDB 6) is the fallback. No
  compaction, as for review refs. The 100 seen events add 100 commits' worth
  of git objects (loose size) but little packed.

  The review conversation, measured 2026-11-15 (`pnpm tsx
  scripts/measure-agent-ref.ts --review`, same 4-core machine under load
  ~23, so the times are pessimistic): one conversation of 20 messages of
  2 KiB of prose (10 human with a `view`, 10 answers through MCP, no
  `head`) and one seen per answer, 30 commits, 40 KiB of text:

  | Measure | Value |
  |---|---|
  | Loose size | 124 KiB |
  | Packed size (`git gc`) | 30 KiB |
  | One append (median of 9) | 21 ms wall; CPU 9 ms + 10 ms git |
  | Cold `read()`, loose or packed (median of 9) | 7 ms wall; CPU 4 ms |

  It adds to a review what one long agent thread does; the format (one
  more anchor subject, no new event kind, no new ref) changes nothing else.

## Thread moves

The reviewer puts a thread (a GitHub review thread or one of their agent
threads) on other lines of the snapshot they view (CAR-139; spec
`docs/superpowers/specs/2026-11-18-thread-placement-design.md`). A move is
the reviewer's view: GitHub keeps its own line, and nothing about a move is
ever sent. Both kinds share one record, in the reviewer's **agent threads
ref** (above), which is never pushed.

| Type | By | Payload |
|---|---|---|
| `thread-moved` | human | `thread` `{source, id}`: `source` `agent` (`id` the agent thread's lowercase ULID) or `github` (`id` GitHub's thread node id, 1 to 200 characters); `on` `{base, head, patchset?}`: the snapshot it was moved in, filled in by the server from the target the page names (never from the request), `patchset` when that snapshot is one of the reviewer's; `anchor` `{path, startSide, startLine, side, line}` in that snapshot; `engine` (`TRACER_VERSION`) |
| `thread-move-undone` | human | `thread` (as above), `move` (the id of the move it takes back: a `thread-moved`, or a legacy `thread-placed`) |

- **Write rules**, enforced on write and on read (`validateForWrite`,
  `parseEvent`): both `by: "human"` only (an agent never moves a thread);
  `source` one of the two (a reader skips an unknown one, so a future
  source never breaks an old reader); the anchor's sides `LEFT`/`RIGHT`,
  positive lines, start not after end on one side, its path at most 4 KiB;
  `on.base` and `on.head` full OIDs, `on.patchset` a positive integer;
  `move` a lowercase ULID. An older reader skips both types (GitDB 8) and
  shows the tracer's placement, which hides nothing: no version bump.
- **Departure from GitDB, stated:** a review thread's hand placement lived
  in the progress ref, to be shared through `meta` once sync exists (owner,
  2026-11-07). Its moves now go to the private agent threads ref instead
  (owner's decision 1, 2026-11-18): one writer either way (GitDB 3); no
  other reader needs the reviewer's view of where a thread sits, and an
  agent thread's id must not reach a pushed ref (GitDB 20). Sharing moves
  is decided when sync is designed. The ref keeps its name.
- **Legacy `thread-placed`:** read as moves (`legacyMoves`,
  `src/server/rereview/threads.ts`): each human one becomes a move of a
  GitHub thread on its patch set's snapshot (`base`, `head` from that patch
  set's `patchset-started`, pinned by `patchsets/<n>` and `-base`); one
  naming an unknown patch set is dropped, an ai one ignored. Nothing is
  written on read. An Undo of one is a `thread-move-undone` naming its id.
  Such a placement now also anchors later patch sets (decision 2).
- **Fold** (`foldMoves`, `src/shared/rereview/moves.ts`): moves and legacy
  moves in `(ts, id)` order, deduplicated by id, keyed `source:id`; minus
  those an undo of the same thread names (an undo naming another thread's
  move or an unknown id does nothing); at most 200 live moves a thread
  (later ones dropped; the server refuses a 201st with a 409, so none it
  acknowledged is ever dropped). An agent thread's move is dropped unless that thread was opened
  on lines (`movesOf`, `src/server/agent/store.ts`): never a file thread, a
  thread conversation or the review conversation. A GitHub thread's is kept
  and used only for a thread GitHub lists. Two tabs: both writes are
  compare-and-swap appends; the later `(ts, id)` wins.
- **Which lines a snapshot uses** (`effectiveMove`): a move made on the
  target itself (the last that fits it) is placed as chosen; else the last
  move visible there (on an earlier patch set, made before the next one
  started) is traced from its own snapshot by the tracer; else the
  thread's own anchor, traced as before. A move on the target that doesn't
  fit is skipped. A move whose commits are gone (a head pruned by hand)
  leaves the thread unplaced as `rewritten`, never the older trace.
- **Size**, measured 2026-11-18 (`pnpm tsx scripts/measure-agent-ref.ts
  --moves`, on top of the 50-thread ref above; git 2.53, a shared machine
  under load; every move with its own random base and head, which compress
  worse than real ones sharing a patch set's). A size test keeps one move
  commit under 1 KiB raw and 512 B deflated (`store.test.ts`):

  | Measure | Value |
  |---|---|
  | One `thread-moved` commit, GitHub thread | 638 B raw, 432 B deflated |
  | One `thread-moved` commit, agent thread | 637 B raw, 423 B deflated |
  | One `thread-move-undone` commit | 415 B raw, 303 B deflated |
  | Realistic: 2 agent + 5 GitHub threads moved once, 1 undone (8 commits) | +2 KiB packed |
  | Heavy, mixed: 50 agent + 100 GitHub threads moved on 3 patch sets, every 6th undone (525 commits) | +133 KiB packed (300 KiB) |
  | Cold `moves()` of the mixed heavy ref, packed (median of 9) | 30 ms wall; CPU 16 ms + 20 ms git |

  A realistic review adds a few KiB to a ref that is never pushed or
  fetched; everyday git never sees it (GitDB 14). Reading legacy
  `thread-placed` costs nothing new: placements already read the progress
  ref.

## Split carries

Added 2026-11-15 (CAR-156, owner: "treating whitespace-only change as a
separate cluster in all views sounds like a good idea regardless"; yes to
carrying marks onto the split pieces). A snapshot's clusters used to be
git's `-U0` hunks, one each. Now each hunk is cut at its whitespace-only
runs (`cutClusters`; see "The cut is part of cluster identity" below): a hunk that splits becomes
several clusters, each keyed by the usual rule (its path, lines and the
three new-side lines around it), so none of them has the key the whole hunk
had. A hunk that doesn't split keeps its key. Each piece knows its whole
hunk's old key and where its lines sit in it (`Cluster.split`).

Reviews in progress hold marks on the old keys. When a patch set's snapshot
is built (the session's open, an earlier patch set's view, a comparison
reading it), the engine carries them onto the pieces
(`ReviewService.carrySplits`, `splitCarries` in
`src/server/review/splitCarry.ts`): one `split-carried` event (`by:
"auto"`) in the reviewer's progress ref, for that patch set, any patch set,
earlier read-only ones too, since it adds no mark the reviewer didn't
make. Never in a view of the past (as of a cutoff) or on a pinned head:
those dev modes don't write it, and their old marks read unreviewed. When
two opens race, the one that loses the compare-and-swap reads again and
writes nothing. For each piece that holds no state of its own whose hunk's key holds
one (and is no cluster of the snapshot):

- a whole mark (`reviewed`, or `crossed-off` with its reason) goes onto the
  piece as it is, a carried one staying carried (so the next patch set's
  carry walks back through it as it would through the hunk);
- line marks (`lines-state`) go by line: the hunk's lines that are the
  piece's (its removed lines at `removedAt` among the hunk's removed ones,
  its added lines at `addedAt` among the hunk's added ones), as the piece's
  whole mark when they cover it in one state, else as the piece's line
  marks in each state, `from` naming the hunk's lines they come from.

Written once: once a piece holds anything (the carry, or the reviewer's own
mark), it is left alone, so every later read writes nothing. **The fold**
(principle 2) applies an entry only when the piece holds nothing from
before the event and, at that moment, the hunk's key holds that mark: a
whole entry the same whole state, a lines entry line marks of that state
holding every line of `from`. Anything else (a forged or stale entry, a
hunk unticked first, a piece already marked) leaves the piece as it was. A
reader that predates the event skips it (GitDB 8: fails closed) and keys
clusters the old way, so it still reads the hunk's own mark, never more.
Home never writes: it folds the carries in memory
(`withSplitCarries`), as the review's next open writes them.

**The cut is part of cluster identity.** Where the cut falls decides
which clusters exist and so their keys. Since CAR-218 (2026-11-22) it is
decided per display hunk, by the matching the view's `~` rows read
(`cutClusters` in `src/server/diff/snapshot.ts` builds the display hunks
from the uncut git hunks; `hunkCuts` and `cutByLines` in
`src/shared/whitespace.ts`), so a block git cuts into several hunks around
an accidental unchanged line is whitespace-only all through, and a piece
may have lines on one side only. A change to it, or to the matcher it
shares with the view (`matchDisplayHunk`, `matchSides`: weights,
tie-breaks, the fast path; `whitespaceKey`; the `SPLIT_CELLS` cap), moves
cuts, and marks on pieces cut the old way stop matching: they fail safe
(unreviewed), but the reviewer loses them, and the split carry only maps
whole-hunk keys. Treat such a change as a key format change (carry it, or
say so in the release); `snapshot.test.ts` pins the keys of a few fixed
hunks. CAR-218's own move is not carried (owner, 2026-11-22: "I'm fine
with letting the affected clusters reset. It's an error in the correct
direction"). Keys move where a hunk's whitespace-only lines have twins
across hunks or in unchanged lines, and also where several equally good
matchings exist and the display hunk's matching picks other twins inside
a hunk than splitHunk's matching of the hunk alone did (the context lines
around it change which optimum the traceback takes), so a hunk with no
twin outside it may be cut differently too. On this repo's last 506
merges the cut moved in 36 of 4,656 changed files. Either way it fails
safe: marks on a whole hunk that now splits still carry onto its pieces,
as above, while marks on pieces of the old cut read unreviewed, and the
release says so. No new event. A display hunk over `SPLIT_CELLS`
(old × new lines, context included, 250,000) is matched one git hunk at a
time, as before CAR-218, and a git hunk over it on its own isn't cut
unless both sides are the same keys line for line: the matching costs
about 4 ms of CPU at the cap and 45-55 ms at 2,000 × 2,000 (2026-11-16), on
the server as the snapshot is built. Should a file's hunks not fit its
text (the display hunks refuse them), each hunk is matched on its own.

**Added files cut at blank lines.** Since CAR-235 (2026-11-24; owner:
"each cluster should end when reaching a line of only whitespace") a file
the comparison adds is cut further: each piece with no removed lines ends
after a run of blank (empty or whitespace-only) lines, the blank lines
staying with the piece before them, and blank lines at the top joining the
first piece (`splitAtBlankLines` in `src/server/diff/clusters.ts`, called by
`cutClusters` for files of status `added`). Edited files are not cut this
way, nor are added lock files (`LOCK_FILES`, by name: `pnpm-lock.yaml`,
`package-lock.json`, `Cargo.lock`, `go.sum` and the like), which stay one
cluster, so a whole-file mark on one stays one event (see "Measurements").
Files `.gitattributes` marks `linguist-generated` are cut like any other:
nothing reads that attribute yet. The pieces carry `Cluster.split` like any other, so a review marked
before (the whole file one cluster) keeps its marks: the split carry puts a
whole mark on every piece and line marks on the lines they marked. No new
event and no new stored field. The since view needs nothing of its own: its
pieces follow the viewed snapshot's clusters, so a file added since the
compared patch set is cut the same way; `ENGINE_VERSION` went to 7 so no
cached comparison names the old whole-file key. Ignore whitespace is
untouched: an added file has no old side, so no piece is whitespace-only.
Since every added file is now cut, the two CAR-156 cases below are common
rather than rare: an older crb unticking a split-carried file (see "Mixed
versions") leaves the pieces marked, and a file carried whole into a later
patch set counts as N carried clusters, one per piece, not one.

**Mixed versions.** Once progress refs sync, an older crb that unticks the
whole hunk (its key still a cluster there) leaves pieces already
split-carried as they were: they still show a mark the reviewer made,
though not their latest intent.

**Departures.** It is a new event type, not a `carried` rule: `carried` is
between two patch sets and its entries are never sources for the next
carry (the fold's carried guard), while a split carry is a re-keying
within one patch set whose result must act as the mark it came from. It is
written on a read (opening a review), the one write that isn't a
reviewer's action, because the alternative, translating old keys on every
read forever, would spread the old cut through every reader of states.

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
   patch set's entry as `{ state, carried: { from, rule } }`, a
   `split-carried` entry fills a piece that holds nothing yet with its
   hunk's mark ("Split carries"), a `lines-carried` entry marks its `lines`
   of a cluster that holds nothing but line carries, as `{ state:
   unreviewed, lines, crossed, linesCarried: { from, lines } }`, only when
   its source cluster holds a human mark (not carried, whole or by lines)
   covering `fromLines` in that state (the carried guard, by line), and a
   human `thread-placed` is kept for reading as a move ("Thread moves").
   For
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
started" check and no compaction. Writing there is: one commit per write,
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

- Sharing hand placements (moves, and old `thread-placed`) with other
  reviewers: decided when sync is designed (owner, 2026-11-18: "Let's not
  think about syncing or sharing, as we're not there quite yet").
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

With at most one commit per event and squash before push, a review's local copy sits
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

**A line carry**, measured 2026-11-17 in
`src/server/review/reviews.test.ts` ("storage: a start carrying lines
into 200 clusters"): the start's commit with one `lines-carried` event of
200 entries, each two 64-hex keys, a state and two ranges of two pairs
(`lines`, `fromLines`): 44,937 bytes raw, 15,675 deflated (about 225 bytes
an entry raw). The test asserts under 60 KiB raw and 30 KiB deflated. It
is written only in a start's commit, once per patch set per reviewer, one
entry per (cluster, earlier cluster, state): a grown cluster's few
unchanged lines, never one per line.

**A split carry**, measured 2026-11-15 in
`src/server/review/reviews.test.ts` ("storage: a split carry is one small
commit per patch set"): one commit holding one `split-carried` event, once
per patch set per reviewer, only for reviews that had marks on hunks that
now split. 600 entries (200 hunks reviewed whole, each cut in three), two
random 64-hex keys and a state each: about 103 KB raw, 31 KB deflated. One
entry for part of a piece (with `from` and `lines`): 587 bytes raw, 400
deflated. The test asserts under 120 KiB raw and 60 KiB deflated for the
first, 1 KiB raw for the second. Since CAR-235 every added file with a
blank line between code splits, so a review in progress with such a file
writes one on its next open (one entry per piece of each marked file); a
review started after the change never writes one.

**Whole-file marks on added files** (CAR-235, measured 2026-11-24 with
`buildSnapshot` and `ReviewService.recordStates` on this repo's files,
added in one commit): "Mark all reviewed" or a cross-off writes one
`cluster-state` event per cluster (about 300 bytes raw each), so its commit
grows with the blocks of the file. Before the cut, each was one event (0.5
KB raw, 0.3 KB deflated).

| Added file | Lines | Clusters (was 1) | Mark all, raw | deflated |
|---|---|---|---|---|
| `splitCarry.ts` (typical) | 120 | 5 | 1.8 KB | 0.6 KB |
| `snapshot.ts` | 611 | 30 | 9.7 KB | 2.0 KB |
| `session.ts` | 2,733 | 117 | 36.3 KB | 6.8 KB |
| `pnpm-lock.yaml`, cut (before the blocklist) | 4,084 | 916 | 276.6 KB | 51.3 KB |
| `pnpm-lock.yaml`, blocklisted (now) | 4,084 | 1 | 0.5 KB | 0.3 KB |

A cross-off with a reason is about the same (298 KB raw, 50 KB deflated for
the lockfile). Each later patch set start then carries every piece: about
90 bytes raw an entry, so about 80 KB raw for the lockfile per reviewer per
start. Cut, one click on a big lock file took a review past the 50 KiB
target above, so lock files are not cut (owner, 2026-11-24: "skip the
custom split on a blocklist of files (like lock), and accept the size for
the rest"). A compact whole-file entry was considered and declined: it
would tie stored marks to how a file is cut, and a later change to the cut
could have unforeseen consequences.

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
- Unit, split carries (`splitCarry.test.ts`, `fold.test.ts`,
  `events.test.ts`): a whole mark, a crossed-off one with its reason, line
  marks covering a piece whole or in part, in one state or two, a carried
  hunk's mark staying carried, idempotence (nothing on a second read), a
  stored key matching nothing old or new staying unmatched, a piece's own
  mark never overridden, an entry before its hunk's mark or of another
  state marking nothing, a split piece as the next patch set's carry
  source; `carrySplits` writes once and onto a read-only patch set, and a
  reader skipping the event sees the hunk's own mark
  (`reviews.test.ts`); the session carries for the latest and an earlier
  patch set (`session.test.ts`).
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
