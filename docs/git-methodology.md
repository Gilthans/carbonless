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
    "PR o/r#n is already merged; nothing to review" (or "is closed"), and
    creates no review.
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

## Test matrix

`test/methodology-fixture.ts` builds one PR history per permutation:

| Branch update | Landing |
| --- | --- |
| `none`: the base moves on, the PR doesn't | `open`: not landed |
| `rebase`: rebased onto the moved base, force-pushed | `merge-commit` |
| `merge-base-in`: the base merged into the PR branch | `squash` |
| | `rebase-merge`: the PR's own commits replayed onto the base |

3 × 4 = 12 permutations. History: base B0; the PR (two commits) on B0; the
base moves (X); the PR is updated; the base moves again (Y); the PR lands.
The PR changes `a.txt` lines 2 and 30 and adds `new.txt`; X and Y change
`a.txt` lines 15 and 22 and add `base-x.txt` / `base-y.txt`, so a base commit
leaking into the comparison shows as an extra cluster or file. The origin
repo has only `main` and `refs/pull/<n>/head` (as on GitHub), each stage
(`opened`, `updated`, `landed`) sets them, and the fake gh reports the PR's
state, head, commits (with dates) and a review on the first head.

Every permutation proves:

- `src/server/methodology.test.ts` (unit, 4 tests × 12):
  - the snapshot equals the reference (B0 → the PR's first head: same files,
    same clusters and keys) at the opened and the updated stage, through a
    refresh and a fresh open;
  - once landed: a running unstarted session keeps its snapshot on refresh;
    a new open refuses when merged, still shows the PR when open;
  - a review started at the opened stage stays pinned through the update and
    the landing, survives `reflog expire` + `gc --prune=now`, and keeps its
    progress;
  - as of a cutoff before the update / before the landing shows the head and
    comparison of then.
- `e2e/methodology.spec.ts` (Playwright, desktop and phone, 12 each): the
  updated PR's Files page lists only the PR's files; once landed `crb`
  refuses exactly when merged.

Add new history-sensitive behaviour to the matrix rather than to a single
fixture shape.

## Commits in one second

As-of picks the PR's head from commit dates (`src/server/asOf.ts`). Commits
sharing one date (a rebase often gives them the same committer second) tie;
the later one in GitHub's list (oldest first) wins, and a review at the same
moment wins over both. The fixture gives the PR's own commits, and the
rebased ones, one shared second each, and checks as of a moment before any
review, so only the commit dates can name the head.
