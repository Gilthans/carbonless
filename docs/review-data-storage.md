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
`2026-10-21-pr-review-parity-design.md`. The cluster concept, cluster identity,
cluster states and the coverage invariant from that spec are used here as
defined there.

The general principles behind this design, with their reasoning, are in
`docs/gitdb-design-principles.md`. The numbers in brackets below, like
"(GitDB 19)", point to them.

**Out of scope for this milestone:** carrying review state over from an earlier
revision to a new one. It's planned with "Re-review after new pushes" in
`docs/todo.md`. Until then, a reviewer keeps seeing the snapshot they started
on (see "After a push"), and the event format leaves room for carry-over (see
"Deferred").

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
  cluster states. Enforced on write and covered by tests.

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

**Revision.** Any head the tool sees for the review's branch: every push,
including force-pushed rebases and merges. Identified by a hash of its
`(merge base, head)` pair. Revisions are not recorded as events: they come and
go with the branch, and the current one is always derivable from git.

**Patch set.** A revision that is a landmark in one reviewer's history: one they
actually reviewed against. Patch sets are per reviewer and recorded in that
reviewer's progress ref. A revision becomes a patch set automatically on the
reviewer's first action against it (marking or crossing off a cluster). A patch
set stays tied to the revision it was started on. It never moves to a later
push: acting on a new push starts a new patch set.
Patch sets are numbered per reviewer in the order they were started ("PS2"); the
number is a display label, the revision hash is the identity. The name comes
from Gerrit, with two differences: a Gerrit patch set is a single commit and
every upload creates one, while ours is a range that can span many commits and
only revisions the reviewer acted on become one.

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
refs/crb/lookup/<source>/<key-hash>                               lookup: source key → review id
```

- **meta** holds review-level events: created, closed, compacted. Anyone may
  append. Merging two copies is a plain union.
- **patchsets/<n>** points at the head commit of the reviewer's patch set `n`.
  A head OID stored in an event doesn't keep the commit alive. After a
  force-push nothing else references it, so `git gc` could delete it, and the
  reviewer's snapshot (see "After a push") would be lost. One ref per patch set
  keeps it reachable, locally and on the remote. The merge base needs no ref:
  it's in the base branch's history. Patch sets are few per reviewer, so these
  refs add little.
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
| `by` | `human` or `ai` (later: `auto`, see "Deferred") |
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
| progress | `patchset-started` | patch set number, revision ID, merge base, head |
| progress | `cluster-state` | patch set ID, cluster identity hash, file path, state (`unreviewed`, `reviewed`, `crossed-off`), optional reason for crossed off |

Later features (carry-over, AI groupings, the reviewer's corrections to them)
add their own types.

Write rules, enforced in code and tested:

- `cluster-state` must have `by: "human"`.
- `by: "ai"` events can never change a cluster's state.

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
- **Several refs at once** (for example progress and a new `patchsets/<n>` ref
  when a patch set starts) use one `git update-ref --stdin` transaction.

## Reading

1. `git rev-list <ref>`, then read the commit messages (one
   `git log --format=%B` or `git cat-file --batch` call).
2. Parse events, drop duplicates by `id`, and sort by `(ts, id)`.
3. Fold into state. For each `(patch set, cluster)`, the last event wins.
4. Cache the parsed events in memory, keyed by the ref and its tip OID
   (`RefStore.readEvents`, a bounded map). A commit's history never changes,
   so an unchanged tip skips `git log`; folding the cached events again is
   cheap.

This is the same idea as git's `cat_sort_uniq` notes merge (concatenate, sort,
drop duplicates), applied to the commit graph: the set of events is the union of
everything reachable from the ref, so merging two copies never conflicts.

**Coverage** is computed exactly as in the parity spec: clusters come from the
git diff of the revision being reviewed. A cluster with no folded state is
unreviewed. A folded state with no matching cluster is ignored. Only the
reviewer's own progress ref is folded. States only count against the patch set's own
revision, and anything ambiguous stays unreviewed: two clusters sharing one
identity (never expected). A `crossed-off` state counts as crossed off with or
without a reason; crossed off never counts as reviewed.

## After a push

- A reviewer with a patch set keeps seeing that patch set's revision: its
  merge base and head, as recorded in `patchset-started` and pinned by
  `patchsets/<n>`. A banner says newer pushes exist.
- Coverage is computed against that revision's diff, so a push never changes
  what the reviewer sees as reviewed or unreviewed.
- A reviewer with no patch set yet sees the current head.
- There is no way to move to a newer push in this milestone: the banner stays
  until carry-over exists (see "Deferred").

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

Carry-over is out of scope for this milestone. Notes for when it's designed, so
this format doesn't need to change:

- Patch sets already record the merge base and head each reviewer worked
  against, and `patchsets/<n>` keeps those heads alive, which is what
  carry-over will diff from.
- Moving to a newer push, and carrying a patch set's state forward to it, is
  part of carry-over. Until then, a patch set stays on the revision it was
  started on and the reviewer can't switch to a newer push.
- Carry-over will add its own event types and a third `by` value, `auto`, for
  the deterministic engine. AI still never writes cluster states.

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
- Git integration, with throwaway repos (`test/git-fixture.ts`): compare-and-swap
  retry; squash before push keeps every event, builds on the remote tip and
  pushes as a fast-forward, including when another machine pushed in between;
  fetch of a single review into `refs/crb-remotes/`; a default clone of a repo
  with crb refs gets no `refs/crb/*`; compaction keeps every event; a patch
  set's head is still readable after the branch is force-pushed and
  `git gc --prune=now` runs; with a git config that sets a real user email,
  crb commits still carry only the slug and tool identities.
- Playwright: state persists across restarts through the refs; a revision the
  reviewer never acted on doesn't create a patch set; after a force-push, a
  reviewer with a patch set still sees its diff and progress unchanged, with
  the newer-pushes banner.

## Open questions for the reviewer

None at the moment.
