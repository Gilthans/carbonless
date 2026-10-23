# GitDB design principles

How carbonless stores its own data in git refs ("GitDB"). These came out of
designing review storage (`docs/review-data-storage.md`),
measuring the options, and studying git-appraise, Gerrit's NoteDb and Radicle.

None of these is an iron rule. Each one has a reason. If the reason doesn't hold
for what you're building, depart from the principle, and write down which one and
why in the design. If a reason turns out to be wrong in general, update this doc.

## Where data lives

### 1. Use our own ref namespace: `refs/crb/`

**Why:** git's default refspecs only fetch `refs/heads/*` and tags, so nobody
downloads crb data unless they ask for it. A namespace we own lets the format
change freely. Other namespaces belong to someone: `refs/notes/` expects git's
notes format, `refs/cobs/` is Radicle's, `refs/pull/` is GitHub's.

**Reconsider when:** we deliberately want interop with a tool that owns a
namespace. Then write a bridge rather than share its namespace.

### 2. Keep everything in one repository

**Why:** git updates refs atomically only within one repository
(`git update-ref --stdin`, `git push --atomic`). Gerrit splits data between the
project repo and `All-Users`, and publishing drafts across the two has left
"zombie drafts" behind for years.

**Reconsider when:** data genuinely belongs to no single repository (for example
per-user settings across all repos). Then design for partial failure up front.

### 3. Split refs by writer, not by kind of data

**Why:** a ref written by only one party never has conflicting writes. Splitting
by kind of data buys nothing inside one writer's ref, because git reuses
unchanged subtrees and blobs for free. Gerrit does the same (a plugin's `checks`
ref beside the change's `meta` ref).

**Reconsider when:** one writer's data has very different lifetimes or fetch
patterns, for example data that most readers never need.

### 4. Pin what must stay readable with a ref

**Why:** an OID written inside an event doesn't keep that object alive. After a
force-push, nothing references the old commit and `git gc` may delete it. A ref
does keep it alive, locally and on the remote. Gerrit keeps one ref per patch set
for this reason.

**Reconsider when:** losing the object is acceptable. Unreferenced objects survive
`git gc` for its grace period (two weeks by default), which is fine for data
that's re-fetched on every use.

## Shape of the data

### 5. Store events, not state

**Why:** append-only events give a full audit trail, keep the reviewer's
corrections as data (CLAUDE.md principle 1), and make merging trivial: the merge
of two copies is the union of their events. Undoing something is a new event.
Gerrit's `meta` ref and Radicle's collaborative objects both work this way.

**Reconsider when:** replay gets slow. Cache the folded state (see 12) before
storing state snapshots.

### 6. A commit is a batch of events; data goes in the message, the tree stays empty

**Why:** measured on simulated reviews, events in commit messages with the empty
tree took 3–9 times less space than per-file or flat state trees, because every
snapshot rewrites trees and blobs. Gerrit's change history starts the same way:
an empty tree, data in footers.

**Reconsider when:** a single event carries large content (long comment text,
attachments). Gerrit puts those in tree files (notes keyed by commit) and keeps
the message small.

### 7. Make commits readable with plain git

**Why:** start each message with a short human summary (`crb: reviewed 3
clusters in src/server/diff.ts`) above the machine-readable lines. Then
`git log` on a crb ref explains itself while debugging, as Gerrit's `meta` does.
It costs almost nothing.

### 8. Version every event and ignore what you don't understand

**Why:** every event has `v` and `type`. Readers skip unknown types and unknown
keys, and type-specific extras go in an optional `details` object that never
affects the result. Older and newer versions of the tool can then share a
remote without breaking each other.

**Reconsider when:** a change must not be ignored by old readers (for example a
new rule that affects coverage). Then bump the version and have old readers
refuse rather than misread.

### 9. Give identities that don't depend on commit OIDs

**Why:** rebases and force-pushes change every OID, so anything keyed only to a
commit OID breaks (that's the weak point of git-notes-based tools like
git-appraise). Use a stable identity for long-lived things: a generated ID
(ULID) where nobody else needs to agree on it, and a hash of the content (for
example of a `(merge base, head)` pair) where several machines must arrive at
the same ID without talking. Avoid counters: they need coordination, which is
why Gerrit reserves sequence numbers in batches.

## Writing and syncing

### 10. Write locally right away, publish compactly

**Why:** one local commit per event (about 2.6 ms each, measured) means nothing
is lost if the process dies. Squashing unpushed commits into one before pushing
keeps the remote's history small.

**Reconsider when:** writes are much more frequent or come from many users on
one machine. Gerrit keeps its per-file "reviewed" flags out of git entirely
because of write latency and history size at server scale. The way out is to
keep hot data in a fast local store and still publish to the same refs in the
same format.

### 11. Merge by union and keep history linear

**Why:** with append-only events, merging is a union and needs no conflict
resolution. Build the squashed commit on top of the fetched remote tip, so pushes
are always fast-forwards and no merge commits are needed. Where events
contradict, a deterministic rule decides (latest timestamp, then event ID), so
every machine computes the same result. This is git's `cat_sort_uniq` notes
merge strategy applied to the commit graph.

### 12. Never rewrite remote history in the regular flow

**Why:** other machines may have already fetched it. Rewriting is reserved for
explicit, rare operations like compacting a finished review. Those push with
`--force-with-lease`, record that they happened, and other clients replace their
copy instead of merging the old history back in.

### 13. Use compare-and-swap for every ref update

**Why:** `git update-ref <ref> <new> <old>` fails if someone else moved the ref,
so two writers (two browser tabs, two processes) can't silently overwrite each
other. Append-only events make the retry easy: re-parent and try again.

## Reading and cost

### 14. Never slow down everyday git

**Why:** review data must be invisible to people who never use crb. Measured with
100k reviews (300k refs) on a remote: status, log, switch, commit, fetch and
clone were unchanged, because they never see `refs/crb/*`. Only commands that
walk every ref slowed (`git log --all -1`: 4 ms to 112 ms). GitHub repos carry
thousands of `refs/pull/*` refs the same way.

### 15. Fetch narrowly, never wholesale

**Why:** fetching `refs/crb/*` as a whole made a fetch with nothing new take 2 s
instead of 8 ms at 100k reviews. Fetch only the refs of what's open. To learn
that something exists, list ref names with `git ls-remote <remote> <prefix>`,
which downloads no objects. Gerrit's starred-changes refs show the same idea:
the ref's existence is the data.

### 16. Keep each unit isolated, and look things up with index refs

**Why:** working on one review must cost the same whatever else exists. A
prefix lookup for one review took 4 ms at 0 and at 100k reviews. Any question
across units ("which review is this branch?") needs a dedicated lookup ref or a
local index, not a scan. Gerrit adds a search index for the same reason.

### 17. Cache derived state by the ref's tip OID

**Why:** the tip OID changes exactly when the data changes, so it's a perfect
cache key. Gerrit caches parsed changes the same way.

## Trust and privacy

### 18. Treat everything read from git as untrusted

**Why:** anyone with push access can write any ref. Git hosts don't restrict
custom namespaces, and commit authors aren't verified. Validate events on read
as well as on write, and design so that bad data fails safe: for review
coverage, a corrupt, missing or forged event can only make coverage look less
complete. A reviewer's trusted state comes only from their own refs. Signing
commits would allow verification but was judged too complex for now.

### 19. Keep personal data out of names and commits

**Why:** ref names and commit headers are visible to anyone who can read the
remote, and pushed history is hard to take back. Use short slugs, not emails,
in ref paths. Set commit author and committer explicitly
(`<slug> <slug@crb>`, a fixed tool identity), because `git commit-tree`
otherwise uses the local git config and would publish the reviewer's real email.
Gerrit uses `<account id>@<server id>` for the same reason.

### 20. Assume everything pushed is public to the repo's readers

**Why:** unlike Gerrit's server, a plain git remote can't hide some refs from
some users. Only push what every reader of the repository may see, and make
syncing something a repo can turn off.

## Ref naming hygiene

### 21. Keep ref names safe and predictable

**Why:** git's file-based ref storage has limits that bite late:
- A name can't be both a ref and a directory (`a/b` and `a/b/c`), so give every
  ref a leaf name that nothing nests under.
- About 250 bytes per path component (git appends `.lock` while writing) and the
  OS path limit overall (260 on Windows without `core.longpaths`).
- `Alice` and `alice` collide on case-insensitive filesystems: use lowercase.
- Arbitrary names (branch names contain `/`) go through a hash instead of into
  the path.
- Optional: shard paths (`refs/changes/37/430037`, as Gerrit does) if many refs
  will be stored loose. Packed refs and reftable make this mostly unnecessary.

## Process

### 22. Measure before choosing a format, and again when it changes

**Why:** intuition was wrong here: the first design (a state tree per event)
was 9 times larger than the one we chose. Simulate realistic volumes, measure
packed size after `git gc` and the cost to everyday git commands, and write the
numbers into the design.

### 23. Work with any plain git remote

**Why:** CLAUDE.md principle 4: no central server. Everything above uses only
standard git (refs, commits, fetch, push), so it works with GitHub, GitLab, a
bare repo on a shared disk, or no remote at all.
