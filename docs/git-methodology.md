# Git-methodology independence

carbonless behaves the same however a team uses git. It depends only on
GitHub's PR facts (state, head, base branch) and the three-dot comparison
`merge-base(base tip, head) → head`, never on assumptions about the shape of
history.

## Behaviour

- **Comparison.** Always `merge-base(origin/<base>, head) → head`. The base's
  own commits never show as PR changes, whether the PR branch was rebased onto
  the moved base or the base was merged into it.
- **Merged or closed** comes from GitHub's PR `state`, not from ancestry. A
  squash or rebase-and-merge leaves the PR head outside the base, so "head is
  reachable from the base" misses them.
  - `MERGED` / `CLOSED` and the reviewer has no patch set: `crb` refuses with
    "PR o/r#n is already merged; nothing to review" (or "PR o/r#n is closed;
    reopen it on GitHub to review"), and creates no review. Reopening a closed
    PR on GitHub is the way to review it again.
  - The reviewer has a patch set: it opens pinned on that patch set, as always.
  - A running session with no patch set keeps its snapshot on refresh once the
    PR is merged or closed (a merge commit would otherwise empty it).
  - As of a cutoff (`--as-of`) the PR counts as open.
- **An open PR whose head is already in the base** (its commits were pushed to
  the base directly, or GitHub hasn't marked it merged yet): carbonless opens
  it with the empty comparison, as GitHub shows it ("This PR changes no
  files"). It doesn't refuse, because GitHub still calls the PR open and the
  reviewer may want to see that. A refresh of an unstarted review moves to it
  like to any new head.
- **Force-push.** A started review stays on its patch set; the pinned head is
  held by the review's refs, so gc never prunes it
  (`docs/review-data-storage.md`).
- **A pinned head** (`crb --head <sha|reviewed>`): the comparison is
  `merge-base(origin/<base>, pinned) → pinned`, with the base branch as it
  is now; nothing else is as of then. `reviewed` is the commit of the
  viewer's latest submitted GitHub review (replies to threads aside,
  `docs/faq.md`), and a sha must be one of the PR's
  commits or a commit one of its reviews was on, so the commit may be one a
  force-push dropped: it's fetched by OID. Refresh re-reads GitHub but keeps
  the pinned head; the PR's real head shows only as "newer commits".
- **Re-review** (`src/server/rereview/`). Moving from a patch set to a
  newer snapshot reads git facts only: whether either head is an ancestor
  of the other, whether the merge base moved, and the virtual rebase
  `git merge-tree --write-tree B2 H1` (the old head as if rebased onto the
  new base, built without touching any branch) compared with the new head's
  tree. That gives the shape (`ShapeCode`: S1 appended, S3 base merged in,
  S4a trivial rebase, S4b rebase with conflicts, S4c rework, S5 squash, S6
  head moved back, S7 retargeted, from GitHub's base branch name), the
  interdiff `diff(H1', H2)` (the author's own changes with the base's
  folded out; a conflicted file is its full diff from `B2`, flagged), and
  the carry (`src/shared/rereview/carry.ts`): a marked cluster carries when
  the exact same removed and added lines sit where the line mappers of
  `diff(H1, H2)` and `diff(B1, B2)` put them, whatever the commits did.
  A marked cluster with no image is gone when the interdiff shows its
  removal (reverted, deleted) and absorbed when it shows nothing of it
  (its change is in the base now: a stacked parent landed, S8), which is
  neither shown nor counted.
  The commit count on the connector is the new head's first-parent commits
  since the old head, or since the merge base after a force-push. When no
  virtual rebase can be built (unrelated histories, a shallow clone), the
  interdiff is unavailable and nothing carries. `GET /head` fetches once
  per triple (head, base oid, base branch name), as GitHub reports them, and
  reports that fetch's merge base: the same head under a base that took in
  some of the PR's own commits gets the new merge base, so those commits
  stop showing as the PR's (as on GitHub). An open or a Refresh counts as
  that triple's fetch.
- **Thread code** (`src/server/threadCode.ts`). A line comment's code pane is
  the PR's diff of its file at the commit the comment was made on, from the
  clone (a commit a force-push dropped is fetched by OID): its old side is
  `merge-base(commit, snapshot base)`, and that must be the merge base with
  the base branch *as it stood when the comment was made*, or the old-side
  rows could be ones the commenter never saw. "As it stood" is the last
  first-parent commit of `origin/<base>` with a committer date at or before
  the comment (`rev-list -1 --first-parent --before=<time>`). That holds for
  merge commits, squash and rebase-and-merge landings, which GitHub commits
  at landing time, and for a rebased or base-merged PR branch (both merge
  bases are the fork point the commit was on). It can be wrong when commits
  reach the base with older committer dates (a direct fast-forward push of
  commits made earlier) or the base's history was rewritten: then the two
  merge bases differ and the pane is GitHub's own diff hunk (`source:
  "github"`), never a guess. Without a GitHub hunk, a range wholly on the new
  side takes the snapshot's merge base alone (its own rows are right either
  way; rows of the old side around it could be off in those cases). That
  pane, and any whose GitHub hunk isn't a run of the rebuilt diff, carries
  the "different snapshot" chip (`docs/faq.md`): the check compares diffs,
  never history.
- **Thread placement** (`src/server/rereview/threads.ts`). A thread is
  traced from that same snapshot (its commit, the merge base above) into
  the viewed one. With none (no commit from GitHub, one no fetch brings
  back, or no merge base), it is traced from GitHub's own fact instead:
  its current line on the PR's head as GitHub reports the head, whatever
  history led there; only the same text places it
  (`docs/product-rules.md`, "A thread with nothing to trace from sits on
  GitHub's line").

## Test matrix

`test/methodology-fixture.ts` builds one PR history per permutation:

| Branch update | Landing |
| --- | --- |
| `none`: the base moves on, the PR doesn't | `open`: not landed |
| `rebase`: rebased onto the moved base, force-pushed | `merge-commit` |
| `merge-base-in`: the base merged into the PR branch | `squash` |
| `rebase-amend`: rebased, with line 30 amended on the way | `rebase-merge`: the PR's own commits replayed onto the base |
| `merge-base-in-conflict`: the base also changed line 30; merged in, the conflict resolved by hand | |
| `stacked-squash`: the PR sat on a parent PR (line 10, `parent.txt`); the parent landed by squash, the PR rebased onto that | |
| `base-absorbs`: the base merged in the PR's first commit (line 2, `new.txt`; same sha), the head unchanged | |

7 × 4 = 28 permutations. History: base B0; the PR (two commits) on B0 (on
the parent's commit for `stacked-squash`); the base moves (X); the PR is
updated; the base moves again (Y); the PR lands. The PR changes `a.txt`
lines 2 and 30 and adds `new.txt`; X and Y change `a.txt` lines 15 and 22
and add `base-x.txt` / `base-y.txt`, so a base commit leaking into the
comparison shows as an extra cluster or file. The origin repo has only
`main` and `refs/pull/<n>/head` (as on GitHub), each stage (`opened`,
`updated`, `landed`) sets them, and the fake gh reports the PR's state,
head, commits (with dates), a review on the first head and the force-push
of a rebase.

Each update has a reference comparison per stage, the PR's intended
change on its own (`references.opened`, `references.updated`): B0 → the
first head for all; for `rebase-amend` the amended content, for
`merge-base-in-conflict` the resolved content over a base holding the
base's line 30, for `stacked-squash` the parent's changes at the opened
stage (the comparison to `main` still shows them) and the PR's own change
alone at the updated stage, for `base-absorbs` the first commit → the head
(line 30 alone) at the updated stage. The fake gh reports the base oid
(`baseRefOid`) of each stage.

Every permutation proves:

- `test/methodology-matrix.ts`, run by `src/server/methodology-<update>.test.ts` (unit, 9 tests × 28):
  - the snapshot equals the stage's reference (same files, same clusters
    and keys) at the opened and the updated stage, through a refresh and a
    fresh open;
  - re-review from the opened head to the updated one, with every cluster
    of PS1 marked: the head check (`checkHead`, no Refresh) reports the
    new head with `merge-base(main, head)`; the shape, the interdiff, the carried, reworked, new and
    gone clusters and the commit count are the update's
    (`none`: S1, nothing new, all carried; `rebase`: S4a, 2 commits, all
    carried; `merge-base-in`: S3, 1 commit, all carried; `rebase-amend`:
    S4c, line 30 reworked, the rest carried; `merge-base-in-conflict`: S3
    with `a.txt` conflicted, both its clusters new, `new.txt` carried;
    `stacked-squash`: S4a, the PR's three clusters carried, the parent's
    two absorbed into the base, nothing gone; `base-absorbs`: S3, 0
    commits, line 30 carried, the first commit's two clusters absorbed,
    nothing gone); viewing the updated head
    writes nothing; the first action on
    it starts PS2 with the carries, which a fresh open shows;
  - once landed: a running unstarted session keeps its snapshot on refresh;
    a new open refuses when merged, still shows the PR when open;
  - a review started at the opened stage stays pinned through the update and
    the landing, survives `reflog expire` + `gc --prune=now`, and keeps its
    progress;
  - as of a cutoff before the update / before the landing shows the head and
    comparison of then;
  - pinned on rev1's reviewed head (`--head reviewed`), opened first at the
    updated stage (after a rebase the head is fetched by OID): the
    reference against today's base (the updated one for `base-absorbs`), through a refresh after the landing, `gc --prune=now` and a
    fresh open, with its progress in its own review;
  - thread code comes from the clone at the updated stage and after the
    landing: a comment on the first head (force-pushed away by a rebase)
    shows that head's diff (for `base-absorbs`, GitHub's own hunk: the
    head's merge base moved since the comment), and one on the updated head
    next to the base's own change shows that change as context on both
    sides;
  - the Overview's timeline follows GitHub's facts: after a force-push
    (`rebase`, `rebase-amend`, `stacked-squash`), the rebased commits
    (GitHub lists only those) sort by their new commit times, after the
    review of the first head, and the force-push follows them; a merge of
    the base (`merge-base-in`, `merge-base-in-conflict`) adds its merge
    commit as a later commit run; a landing shows the merge alone (GitHub's
    close at the same moment is left out), whatever the landing method.
- `e2e/methodology.spec.ts` (Playwright, desktop and phone, 28 each): the
  updated PR's Files page lists only the PR's files; once landed `crb`
  refuses exactly when merged.

The shapes the engine tells apart on throwaway repos outside the matrix
(`src/server/rereview/shape.test.ts`, `interdiff.test.ts`,
`engine.test.ts`): S5 (squash), S6 (head moved back), S7 (retargeted), a
reverted commit, unrelated histories and a shallow clone (no virtual
rebase), a conflicted file the PR deletes. After a retarget each patch set
keeps the base branch it was reviewed against (its graph card's "Against";
only the head's card names the PR's current base; `session.test.ts`, S7).

Add new history-sensitive behaviour to the matrix rather than to a single
fixture shape.

## Commits in one second

As-of picks the PR's head from commit dates (`src/server/asOf.ts`). Commits
sharing one date (a rebase often gives them the same committer second) tie;
the later one in GitHub's list (oldest first) wins, and a review at the same
moment wins over both. This assumes GitHub lists a PR's commits in history
order, oldest first, as its `commits` connection does. The fixture gives the PR's own commits, and the
rebased ones, one shared second each, and checks as of a moment before any
review, so only the commit dates can name the head.
