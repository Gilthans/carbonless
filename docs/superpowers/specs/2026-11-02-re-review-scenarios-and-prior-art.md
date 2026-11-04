# Re-review after new pushes: scenarios and prior art

2026-11-02, decisions of 2026-11-03 folded in. Commentable copy: https://claude.ai/artifact/Rn3ZYY1mdj1Nh44gYw1MLJ (the doc is the working copy; this file mirrors it).

## The problem

A reviewer comes back to a PR after the author pushed more commits. Today carbonless keeps them pinned on the snapshot they started (`docs/review-data-storage.md`, "After a push"), with a banner; there is no way to move forward. Moving forward means answering three questions, and they share one engine (a line mapping between the two snapshots):

1. **Matching.** Where does each comment made on the old snapshot sit in the new one, and which reviewed clusters are still the same change? Review progress must carry over without ever marking something reviewed that the reviewer never saw (principle 2).
2. **The interdiff.** What did the author change since the reviewer's snapshot, shown without the noise of a rebase or a base merge-in? This is the part GitHub gets wrong after any force-push.
3. **Context for the unmatched.** When a commented line no longer exists, how does the reviewer still understand the comment and what became of its code?

### Vocabulary

- **Snapshot**: one PR state, one per push the tool has seen, and what the reviewer sees of it: the pair `(B, H)`: the three-dot diff from `merge-base(base, H)` to head `H`. `B` below means that merge base.
- **Patch set (PS)**: the owner's "changeset": a snapshot the reviewer took a lasting action on: marked or crossed off a cluster, commented, gave a verdict (owner, 2026-11-03; that today a comment does not start one is an oversight to fix). Pinned by a ref, so its head survives force-pushes.
- **Revision**: folded into snapshot, one term for the pair and its diff (owner, 2026-11-04); "revision" in docs/review-data-storage.md means the same and is renamed in the design. The current snapshot is `R` = `(B2, H2)`; the reviewer's last patch set is `PS1` = `(B1, H1)`.
- **Interdiff**: the author's own changes between `PS1` and `R`, with changes that came from the base factored out.
- **Virtual rebase `H1'`**: `H1` merged onto `B2` by `git merge-tree` without touching any branch, so `diff(H1', H2)` is the interdiff. Probed on 2026-11-02 with git 2.53: clean for a rebase and for a base merge-in, and a conflict is reported per file with the conflict markers available (see The interdiff).
- **Carry**: moving a cluster state or a comment anchor from `PS1` to `R`, recorded as an event (`by: auto`), never silently.

## How the new snapshot relates to your patch set

Every scenario below happens in one of these shapes ("revision" in the tables below reads as snapshot), and a design has to behave the same in all of them (principle 7). `H1 ⊂ H2` means the old head is an ancestor of the new one.

| # | Shape | Head | Merge base | What a naive `diff(H1, H2)` shows |
| --- | --- | --- | --- | --- |
| S1 | Commits appended | `H1 ⊂ H2` | `B2 = B1` | Exactly the author's changes. The easy case. |
| S2 | Base moved on, PR untouched | `H2 = H1` | `B2 = B1` | Nothing. The snapshot is unchanged; only mergeability changed. |
| S3 | Base merged into the PR, then commits | `H1 ⊂ H2`, a merge commit in between | `B2` ahead of `B1` | The author's changes plus everything the base gained: noise, often larger than the PR. |
| S4a | Trivial rebase | force-push, `H1 ⊄ H2` | `B2` ahead | Same noise as S3, and all commit ids changed. The PR's own diff is identical. |
| S4b | Rebase with conflict resolution | force-push | `B2` ahead | Noise plus real changes in the files that conflicted; the resolution must be reviewed. |
| S4c | Rebase plus amends, reorders, squashes | force-push | `B2` ahead or equal | Noise plus the author's changes; commit boundaries no longer correspond. |
| S4d | Rebase that drops a commit | force-push | any | Part of the reviewed change disappeared; comments on it point at nothing. |
| S5 | Squash all commits into one, same content | force-push | `B2 = B1` | Nothing, yet every commit id is new (GitHub loses the per-commit view). |
| S6 | Force-push backwards (reset to an older commit) | force-push, `H2 ⊂ H1` | `B2 = B1` | A negative diff: changes the reviewer reviewed are gone, maybe to come back later. |
| S7 | PR retargeted to another base branch | `H2 = H1` | `B2` on another branch | Nothing, while the snapshot's diff may change completely (merge base moved). |
| S8 | Stacked PR: the parent landed by squash, child not yet rebased | `H2 = H1` or more | `B2` ahead, now containing the parent's content under a new commit | The child's snapshot still shows the parent's changes until the author rebases; after the rebase (S4a) they vanish. |
| S9 | Revert inside the PR | `H1 ⊂ H2` | `B2 = B1` | A change that was reviewed is undone: its cluster disappears, its comments point at nothing. |
| S10 | Branch head repository changed (fork swapped) | new commits | any | Rare; treated as S4c. |

Two observations shape the design:

- **S3 and S4 are the same problem.** In both, `B2` moved and the base's changes are entangled with the author's. Whether the author merged or rebased only changes whether commit ids survive. The virtual rebase `H1'` removes the base's share in both (probed; see The interdiff).
- **Line mapping needs no interdiff.** To find where a line of `H1` sits in `H2`, a plain `diff(H1:f, H2:f)` is enough in every shape: an unchanged line is matched wherever it moved to, whoever moved it. The interdiff only matters for deciding what the reviewer needs to look at. Lines on the old side (deleted lines, `LEFT`) map through `diff(B1:f, B2:f)` instead.

## Scenarios: matching comments

A comment's anchor is `(path, commit, side, line range, optional span)` (`CodeAnchor`). The question is where that range sits in `R`, and how sure we are. The outcomes a design must support: **placed** (same text, maybe another line number), **placed, changed** (the lines were edited; show old and new), **unplaced** (gone), each with a reason the reviewer can see and correct (principle 1).

| # | Scenario | Common? | Expected outcome |
| --- | --- | --- | --- |
| C1 | Lines inserted or removed above the commented line; the line itself untouched | Every push | Placed on the new number. Must be exact and automatic. GitHub does this. |
| C2 | The commented line was edited (typically: the author fixed what the comment asked) | Very common | Placed, changed: anchored to the replacement lines, with the commented text as it was. Never silently "outdated". GitHub collapses these. |
| C3 | The commented line was deleted, nothing replaced it | Common | Unplaced, with a landing spot: the nearest surviving line above, and the commit that removed it. |
| C4 | A multi-line range where only part changed | Common | Placed on the surviving part plus the replacement, marked changed; the whole original range shown on request. |
| C5 | Comment on a `LEFT` (deleted) line, then `B2` moved (S3, S4) and the base also touched that region | Occasional, nasty | The old side the commenter saw is `B1`, not `B2`. Map through `diff(B1:f, B2:f)`; if the base changed that line, flag it. Today's LEFT placement (`threadPlacement.ts`) ignores this. |
| C6 | Comment on a context (unchanged) line of the hunk; the base later changes that line (S3, S4) | Occasional | The line is still unchanged by the PR but its text differs. Placed, changed, marked as changed by the base, not the author. |
| C7 | File renamed between snapshots | Common in refactors | Follow the rename (git's detection, which Files changed already pairs). Comments move with the file. |
| C8 | File deleted, or the whole file reverted | Occasional | All its comments unplaced; shown under the file's header with their old code (we already keep the commit by OID). |
| C9 | The commented code moved to another file (function extracted) | Occasional, high value | Line mapping within the file fails. Moved-code matching (todo item 2) may find it; proposed as a candidate the reviewer confirms, never asserted. |
| C10 | Comments by other people on intermediate heads the reviewer never saw (`H1 < Hx < H2`) | Every multi-reviewer PR | Same mapping from `Hx`; also flagged as new since the reviewer's last visit. Proposed (2026-11-04, see the thread): their head is a shared landmark the reviewer can diff from or to, derived from GitHub, not a patch set in the reviewer's own progress. |
| C11 | Comment on a commit a rebase dropped (S4) | Every rebased PR | We fetch that commit by OID already. Map `Hx → H2` by file content; commit ancestry is irrelevant. |
| C12 | Comment made on GitHub in a "changes since your last review" view, on a `LEFT` line | Rare but real (todo: LEFT placement) | Its `LEFT` line belongs to an earlier PR head, not to `B`. Only GitHub's `diff_hunk` reveals that. Locate by text in that head, then map. |
| C13 | Comment on a line that was changed, then changed back (S9, or a fix then a revert) | Rare | Placed, unchanged, if the text matches again. A chain of patch sets, not just the last, should be consulted. |
| C14 | The author applied the comment's suggestion exactly | Common with suggestions | Placed, changed; carbonless may say "applied as suggested" (GitHub resolves these when applied through its UI, otherwise not). Resolution stays the humans' call. |
| C15 | Two identical lines in the file (duplicate code); one moves | Occasional | Mapping must pair by diff position, not by text search, or it will jump to the wrong twin. |
| C16 | Whitespace-only reformat of the commented line (formatter run) | Common after a formatter | Placed, changed, but marked whitespace-only so it reads as unchanged with Ignore whitespace on. |
| C17 | A comment on a span inside a line (carbonless's own `span=` marker); the line's text shifts within the line | Occasional | Re-find the span text in the new line; if the text is gone, fall back to whole lines and say so. |
| C18 | File-level comment (no line) | Common | Nothing to map; follows renames (C7), unplaced on delete (C8). |
| C19 | GitHub's own `line` (its current position) disagrees with ours | Unknown until measured | Treat as the "different snapshot" chip does: show ours, flag the disagreement, never trust either blindly. |

**What "review progress updates" adds.** Review progress (reviewed and crossed-off clusters) maps the same way, at cluster scale, so a reviewer who opens the diff to the merge base again finds all of it in place: that is the next section, Scenarios: carrying review progress (owner, 2026-11-03: "similar to comment mapping, but on a larger scale"). Thread activity since the last visit: new replies, resolved by whom, new threads by others (C10). That is attention-set work, listed in `docs/todo.md`; it only needs the mapping above to show each thread in place.

## Scenarios: carrying review progress

A cluster's identity is its path, its exact removed and added lines, and 3 unchanged lines above and below (the parity spec). Carry-over can only ever mark a cluster in `R` as reviewed when it is provably the one the reviewer marked in `PS1`. Anything less certain stays unreviewed and is shown as such, with what changed in it. The reviewer's time is the thing to protect: on a 200-file PR with a 2-line fix, they should re-read 2 lines.

| # | Scenario | Common? | Expected outcome |
| --- | --- | --- | --- |
| P1 | Cluster identical in `R` (same lines, same context) | Most clusters on every push | Carried automatically, recorded as an event (`by: auto`, from `PS1`). Deterministic, no AI. |
| P2 | Cluster's changed lines identical, context lines differ (the base, or a neighbouring edit, changed a line within 3 of it) | Common in S3/S4 and near fixes | Carried (owner, 2026-11-03): context is not part of the carry rule. Context lines the PR changed are a cluster of their own; ones the base changed are not in the diff at all. |
| P3 | Cluster edited (the author reworked the lines) | The fix itself | Not carried. Shown as reworked: the cluster plus a mini interdiff of what changed inside it since `PS1`. Reviewer marks it again. |
| P4 | Cluster split in two, or two merged, by an insertion in the middle or a removed gap | Common | Not carried as clusters. Line-level carry would say which lines were seen and which are new; needs a decision on whether states are per cluster or per line (today: per cluster). |
| P5 | Cluster moved within the file (line numbers only) | Every push | Carried (identity has no line numbers). |
| P6 | Cluster moved to another file (rename) | Refactors | Carried through the rename pair; identity includes the path, so the carry rule needs the rename map. |
| P7 | Crossed-off cluster (e.g. generated file) regenerated with different content | Common for lockfiles, snapshots | The reason was a preference, not a verdict on those lines. Carried by the same rule as reviewed (owner, 2026-11-03): only a cluster that traces exactly; a regenerated cluster is crossed off again. |
| P8 | Reviewed in `PS1`, reworked in `PS2`, reverted to `PS1`'s content in `PS3` | Rare | Carry from any earlier patch set whose cluster matches, not only the last one. Patch set heads are all pinned, so this is cheap. |
| P9 | Trivial rebase or squash (S4a, S5): every cluster identical | Very common before merge | Everything carries; the page says "rebased, nothing new" and moving is one tap. |
| P10 | Formatter sweep: every cluster's lines changed by whitespace only | Occasional, painful | Not carried (principle 2: whitespace changes are changes). The interdiff shows them collapsed as quiet rows (the Ignore whitespace view), so marking them is fast. |
| P11 | Commit dropped or reverted (S4d, S6, S9): a reviewed cluster is gone | Occasional | Nothing to carry; the interdiff shows the removal so the reviewer notices work they reviewed vanished. |
| P12 | Duplicate identities in one snapshot (occurrence numbers) and the count changes | Rare | Carry by occurrence only while the counts agree; otherwise none of them. |
| P13 | The reviewer approved (or requested changes) on `H1`; new commits arrived | Every re-review | The verdict tab says what the verdict was given on and what changed since, from the interdiff. GitHub keeps a stale approval standing unless the repo dismisses it. |
| P14 | The reviewer reviewed on two devices (phone, desktop) against the same patch set | Common for the owner | One progress ref per reviewer, so nothing special, but carry events must merge like other events (append-only, last wins). |
| P15 | A push lands while the reviewer is mid-review | Common | Stays pinned (today's behaviour). Moving is explicit, and the old patch set stays as history. |
| P16 | The reviewer moved to `R`, then wants to see `PS1` again (what did I approve?) | Occasional | Patch sets are pinned and listed; any can be opened read-only. |

**Audit.** Every carry is an event naming its source (`PS1`, cluster key) and rule (`identical`, `rename`, later maybe `context-only`), so the reviewer can see why a cluster is marked and undo it, and so a bug in a rule shows up as data (principle 1, principle 2).

## Scenarios: the interdiff

The interdiff answers "what did the author change since I looked". It is optional to view but it drives carry-over, so it has to be right in every shape of history.

**The probe.** On 2026-11-02, with git 2.53 on throwaway repos: `git merge-tree --write-tree B2 H1` produced `H1'` (the old head as if rebased onto the new base) without touching any branch. `git diff H1' H2` then showed only the author's fix, both when the author had rebased (S4) and when they had merged the base in (S3), while the naive `diff(H1, H2)` also showed the base's own file. When the base and the PR changed the same line, `merge-tree` exited 1 and named the file, and the tree holds the conflict markers, so the author's resolution can be shown against what git left them. This is the same idea as Gerrit's "due to rebase" marking and Reviewable's rebase handling; the prior-art section says what they do exactly.

| # | Scenario | Interdiff should show |
| --- | --- | --- |
| I1 | S1, commits appended | `diff(H1, H2)`: exactly the new commits. |
| I2 | S3, base merged in, no other change | Nothing. `diff(H1', H2)` is empty; the merge is a non-event for the reviewer. |
| I3 | S4a, trivial rebase | Nothing, and the reviewer is told why their commit list changed. |
| I4 | S3 or S4 plus the author's own changes | Only those changes. Verified by the probe. |
| I5 | S4b, rebase with conflict resolution | For each conflicted file: the conflict as git would have left it versus what the author committed. That is exactly the new code to review. Other files: as I4. |
| I6 | S4c, squash, reorder, amend | Content-based, so commit boundaries don't matter. Per-commit views (`git range-diff`) are a bonus, not the basis. |
| I7 | S4d, S6, S9: reviewed change removed | The removal, as a deletion in the interdiff. A reviewer must notice that something they reviewed is gone. |
| I8 | S8, stacked PR parent squashed into base, child rebased | `merge-tree` merges identical changes cleanly, so the parent's content is factored out and nothing shows. Verified by a second probe: the child's snapshot shrank to its own change and the interdiff was empty. |
| I9 | S7, retargeted | `B2` is on another branch; same machinery, but `merge-base(B2, H1)` may be far back and the virtual rebase may conflict widely. Fall back to I10. |
| I10 | The virtual rebase can't be built (unrelated histories, a shallow clone, a binary conflict) | Fail closed: show the full new snapshot as unreviewed and say the interdiff is unavailable. Never a guess. |
| I11 | Several patch sets: `PS1`, `PS2`, now `R` | The reviewer picks the "since" point; default is their last patch set. |
| I12 | The reviewer never acted (no patch set) but did look | A comment or verdict now starts a patch set (owner, 2026-11-03). Merely opening records a last-seen head to diff from, without starting one (my call). |
| I13 | Base merged in a file the PR also edits, no conflict, both changed nearby lines | `diff(H1', H2)` is empty for that file, but the cluster's context changed (P2). The interdiff is empty and the carry rule decides. |

**Where the interdiff shows.** Two reasonable places, not mutually exclusive: a filter on Files changed (show only clusters that are new or reworked since `PS1`; carried clusters stay reachable and marked), and a view of the interdiff as its own diff, each hunk tagged new, rework, or due to rebase. Mockups belong in the design doc that follows this one.

## Scenarios: context for comments that can't be placed

An unplaced comment must still be readable and actionable (reply, resolve), and the reviewer must be able to tell what happened to the code. carbonless already shows a thread's code at the commit it was made on, from the clone; the additions are about what happened next.

| # | Scenario | What the reviewer needs to see |
| --- | --- | --- |
| X1 | The line was deleted (C3) | The thread, with the code as the commenter saw it, plus: deleted in which commit, by whom, and a link to the nearest surviving line ("was between lines 40 and 41 of the new file"). |
| X2 | The line was rewritten (C2) | The old lines beside the new ones (a mini interdiff of just that range), in the thread card, placed on the new lines. |
| X3 | The file is gone (C8) | The thread under the file's header in the file list, with the old code; the file's deletion is itself a cluster to review. |
| X4 | The code moved elsewhere (C9) | A candidate location, labelled as a guess with a confidence source (git rename, moved-code matching, AI), one tap to accept or reject. Rejected is remembered. |
| X5 | The change was reverted (S9) or dropped (S4d) | The thread marked "the change this was about is no longer in the PR", with the commit that removed it when there is one. |
| X6 | The comment is on a `LEFT` line whose old side changed (C5) | The old side as the commenter saw it, and the note that the base changed this line since. |
| X7 | A thread the author says is addressed (reply, resolved) but the code mapping says unchanged | No automatic verdict. Show both facts; the reviewer decides. AI may suggest "addressed by commit X" as an editable annotation. |
| X8 | Many unplaced threads at once (a big rework) | A list view: every unplaced thread, grouped by file, each with its fate (deleted, rewritten, moved, reverted), so the reviewer can sweep them. |

In every case the thread keeps its code pane from its own commit (today's `threadCode.ts`), so the context never degrades to GitHub's "outdated" collapse.

## How existing tools handle it

Researched on 2026-11-02 from official docs and source where open (GitLab, Gerrit); "undocumented" means nothing authoritative was found. The short version: nobody computes the interdiff against a common base, two tools (GitLab, Gerrit) re-anchor comments by diff mapping and degrade gracefully, and only Reviewable tracks "reviewed at revision N" per file per reviewer.

### GitHub

- **Since your last review** is `diff(commit of your latest review, head)`, a two-dot diff of the heads ([writeup](https://daisy.wtf/writing/github-changes-since-last-review/)). After a rebase it fails, and the force-push compare link only covers the latest force-push and allows no comments ([community](https://github.com/orgs/community/discussions/3478), [community](https://github.com/orgs/community/discussions/141845)). Not in the official docs at all.
- **Comments** carry `line`/`originalLine`, `commit`/`originalCommit`, `diffHunk` and `isOutdated` ([REST](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28), GraphQL schema). The outdated rule is undocumented; observed: the commented line changing makes the thread outdated, which removes it from Files changed and collapses it on the Conversation tab ([community](https://github.com/orgs/community/discussions/23138)). File-level comments reportedly go outdated on any push ([community](https://github.com/orgs/community/discussions/86527)). No re-anchoring is described anywhere.
- **Viewed** is a per-file, per-viewer three-state flag (`VIEWED`, `DISMISSED` "new changes since last viewed", `UNVIEWED`), cleared when the file changes ([docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request)). Whether a pure rebase clears it is undocumented.
- **Stale approvals**: GitHub records the diff at approval time and the branch rule can dismiss when the diff changes, including through Update branch; a merge base moving with no new changes preserves approvals in most cases ([docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [changelog](https://github.blog/changelog/2023-06-06-security-enhancements-to-required-approvals-on-pull-requests/)).

### GitLab

- **Versions**: one diff version per push with `base_sha`, `start_sha`, `head_sha` and a `patch_id_sha` ([docs](https://docs.gitlab.com/user/project/merge_requests/versions/), [API](https://docs.gitlab.com/api/merge_requests/#retrieve-merge-request-diff-versions)). Version compare is head-to-head, so after a rebase it is "polluted with unrelated target branch changes"; diffing `base...v1` against `base...v2` is an open proposal ([issue 27601](https://gitlab.com/gitlab-org/gitlab/-/work_items/27601)). "Changes since your last review" does not exist ([issue 25559](https://gitlab.com/gitlab-org/gitlab/-/issues/25559)).
- **PositionTracer** (open source, [position\_tracer.rb](https://gitlab.com/gitlab-org/gitlab/-/blob/master/lib/gitlab/diff/position_tracer.rb), [line\_strategy.rb](https://gitlab.com/gitlab-org/gitlab/-/blob/master/lib/gitlab/diff/position_tracer/line_strategy.rb)) runs on every push to source or target. With the old diff A→B and the new C→D it uses three diffs: **ac** (old base to new base), **bd** (old head to new head), **cd** (the new MR diff), and maps a line through them with a per-file `LineMapper`. An added line maps through bd then cd: still added, became unchanged, or removed. A removed line maps through ac then cd. An unchanged line maps through both. A range is traced end by end and collapses to its last line if order breaks. It explicitly allows C and D not to descend from A and B, so it survives rebases and base merges.
- **Outcome**: traced, the note gets its new position; otherwise it keeps its old position and gets a `change_position` plus a system note "changed this line in version N of the diff" linking to the exact version and line ([update\_diff\_position\_service.rb](https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/services/discussions/update_diff_position_service.rb)). A project setting may auto-resolve outdated threads, but never ones on unchanged lines ([docs](https://docs.gitlab.com/user/project/merge_requests/#automatically-resolve-threads-when-they-become-outdated)).
- **Viewed** files are hidden until their contents change, keyed server-side and reset on diff change ([docs](https://docs.gitlab.com/user/project/merge_requests/changes/#mark-files-as-viewed)). Approval reset compares `git patch-id` first, so a rebase or base merge with identical content does not reset ([docs](https://docs.gitlab.com/user/project/merge_requests/approvals/settings/)).

### Gerrit

- **Ported comments** (3.4): unresolved comments from older patch sets are shown on newer ones, the original comment in a new place, not a copy; resolving the port resolves the original ([docs](https://gerrit-review.googlesource.com/Documentation/user-porting-comments.html), [3.4 notes](https://www.gerritcodereview.com/3.4.html)). Resolved comments are not ported, for performance.
- **Algorithm** ([CommentPorter.java](https://gerrit.googlesource.com/gerrit/+/master/java/com/google/gerrit/server/restapi/change/CommentPorter.java), [GitPositionTransformer.java](https://gerrit.googlesource.com/gerrit/+/master/java/com/google/gerrit/server/patch/GitPositionTransformer.java)): a plain commit-to-commit diff between the two patch sets, hunk-level edit lists, cumulative line shift; a comment whose lines overlap an edit degrades to a file-level comment, a deleted file to a change-level one, and "this strategy will never drop any positions". Renames carry the line range. A rebase and a new upload are treated identically.
- **Change kind** per patch set, computed by an in-memory cherry-pick of the prior patch set onto the new parent and comparing trees: `NO_CHANGE`, `NO_CODE_CHANGE`, `TRIVIAL_REBASE`, `MERGE_FIRST_PARENT_UPDATE`, `REWORK` ([ChangeKindCacheImpl.java](https://gerrit.googlesource.com/gerrit/+/master/java/com/google/gerrit/server/change/ChangeKindCacheImpl.java)). Label `copyCondition` queries decide which votes survive, e.g. `changekind:TRIVIAL_REBASE`, `has:unchanged-files` ([config-labels](https://gerrit-review.googlesource.com/Documentation/config-labels.html)).
- **Patch set diff** is commit-to-commit, so base changes bleed in; since 2.15 hunks also present between the two parents are marked `due_to_rebase`, not counted in size, and files that are rebase-only are hidden; overlapping hunks are left unmarked "in case of doubt" ([2.15 notes](https://www.gerritcodereview.com/2.15.html), [review UI](https://gerrit-review.googlesource.com/Documentation/user-review-ui.html)). No diff against a common base exists.
- **Reviewed flag** per (patch set, file, account) is copied forward lazily when the file's blob id is identical in the next patch set ([Files.java](https://gerrit.googlesource.com/gerrit/+/master/java/com/google/gerrit/server/restapi/change/Files.java)). Any content change, even rebase-induced, clears it.

### Critique (Google, internal)

- Snapshots; diff between any pair of snapshots, with similar snapshots collapsed and per-snapshot badges for reviewed and commented ([SWE at Google ch. 19](https://abseil.io/resources/swe-book/html/ch19.html)). The per-file reviewed checkbox is cleared for all reviewers when a new snapshot arrives. How comments map across snapshots and how a depot sync is separated from the author's edits are not published.

### Reviewable

- **Revisions** are immutable captures of pushed commits; force-pushed-out ones are kept and diffable; provisional revisions let the author fix up without polluting the list ([files](https://docs.reviewable.io/files.html), [reviews](https://docs.reviewable.io/reviews.html)).
- **File matrix**: files × revisions × reviewers. A mark means "reviewed at revision N"; diff bounds per file default from your last reviewed revision to the latest ("Show Diffs to Review"); the review is complete when every file is marked at the latest revision by a non-author ([files](https://docs.reviewable.io/files.html)). This is the closest existing model to carbonless's patch sets.
- **Rebase and base merge**: old revisions are kept struck through; "changes between the old and new base will automatically collapse in the diff"; rebased commits are matched to ancestors by commit message; each cell flags "base changes only", "base updated and modified in revision", or "base changes not reflected". The algorithm is undocumented.
- **Discussions** show "at the nearest corresponding line" in every revision until resolved, with a red dog-ear when the context may be inaccurate and a purple one to jump to the commented revision ([discussions](https://docs.reviewable.io/discussions.html)). Matching algorithm undocumented.

### Phabricator / Phorge

- Ghost inlines: comments are ported forward by line-offset mapping across hunks and intermediate rebases, deliberately without content matching and deliberately aggressive ("takes the cautious route"), shown pale with a jump-back button ([docs](https://secure.phabricator.com/book/phabricator/article/differential_inlines/)). Diff-of-diffs marks rebase-introduced lines pale and is acknowledged wrong when bases differ ([T10500](https://secure.phabricator.com/T10500)). Accept is sticky across updates by default (`differential.sticky-accept`).

### Azure Repos, Bitbucket, others

- **Azure Repos**: an iteration per push with a reason (`Push`, `ForcePush`, `Rebase`, `Retarget`, `ResolveConflicts`); threads carry a `changeTrackingId` and, once tracked, a `trackingCriteria` with their original spans and path ([REST](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1)). Algorithm opaque. Branch policies can reset votes on every iteration.
- **Bitbucket Data Center** anchors comments to commit hashes, so a rebase orphans them, which Atlassian calls intended ([KB](https://support.atlassian.com/bitbucket-data-center/kb/commit-comments-are-lost-in-pull-request-after-rebase-from-master-in-bitbucket-datacenter/)). Its auto-unapprove compares `git patch-id` and keeps approvals when the diff is unchanged, resetting on a 20 s timeout ([KB](https://support.atlassian.com/bitbucket-data-center/kb/bitbucket-server-data-center-auto-unapprove-plugin-does-not-remove-approvals-even-after-new-commits-are-pushed-to-the-source-branch/)). **Cloud** resets Viewed only for files new commits altered ([docs](https://support.atlassian.com/bitbucket-cloud/docs/review-code-in-a-pull-request/)).
- **Review Board** documents the same interdiff flaw: a newer diff on a newer base shows "other changes made to that file … that has nothing to do with the review" ([docs](https://www.reviewboard.org/docs/manual/latest/users/reviews/reviewing-diffs/)). **Graphite** versions per submit with "hide reviewed changes" from the last reviewed version; rebase handling undocumented ([docs](https://graphite.com/docs/pull-request-versions)). **git-appraise** keeps comments on the original commit in git notes and links a rebased head through an alias ([README](https://github.com/google/git-appraise/blob/master/README.md)).

### Comparison

| Tool | Revision unit | Comment re-anchoring | Interdiff after rebase or base merge | Reviewed-state carry |
| --- | --- | --- | --- | --- |
| GitHub | commit | none; line changed = outdated, hidden from Files | head-to-head; fails after a rebase | per file, cleared on change |
| GitLab | push (version) | three-diff trace (ac, bd, cd); outdated keeps position + change link | head-to-head; polluted after a rebase (open issue) | per file, cleared on change; patch-id guards approvals |
| Gerrit | patch set | commit-to-commit diff; degrades line → file → change, never dropped; unresolved only | commit-to-commit, hunks marked due\_to\_rebase, rebase-only files hidden | per file, copied on identical blob; votes by change kind |
| Critique | snapshot | unpublished | any pair of snapshots | per file, cleared on new snapshot |
| Reviewable | revision (push group) | nearest corresponding line, flagged when unreliable; undocumented | base changes collapsed; base-change flags per file | per file per revision per reviewer; diff from last reviewed |
| Phabricator | diff | line-offset ghosts, aggressive, jump back | pale rebase lines; wrong when bases differ | none; accept sticky |
| Azure Repos | iteration (push, with reason) | server tracking, original spans kept | per iteration; no rebase filtering | checkbox, rule undocumented |
| Bitbucket DC | commits | by commit hash; rebase orphans | since last reviewed commits | none; patch-id guards approvals |

**What nobody does, and carbonless can:** compute the interdiff as `diff(H1', H2)` with `H1'` the old head virtually rebased by `merge-tree`. Gerrit and Phabricator approximate it by subtracting the parents' diff and marking hunks; GitLab and Review Board have it as an open issue. Our probes show git does it directly, conflicts included.

## Options for carbonless

My recommendation, for discussion, is the first option under each heading. Nothing here is decided.

### The engine: one line mapping, three uses

1. **GitLab's three-diff trace, on our clone** (recommended). For a comment on `(Hx, side, line)`: a `RIGHT` line maps through `diff(Hx:f, H2:f)`; a `LEFT` line through `diff(Bx:f, B2:f)` where `Bx` is the old side the commenter saw (which `threadCode.ts` already works out); then the new MR diff `diff(B2:f, H2:f)` says whether the line is still added, became unchanged, or was removed. Deterministic, uses git's own diff, works in every shape of history, and gives each thread one of three outcomes with a reason. Phabricator's and Gerrit's offset mapping is the same idea with less care on the old side. Agreed 2026-11-03, with two properties to keep: the tracer is a library of its own (pure functions, diffs in, positions out, no git calls, its own isolated tests), and it never assumes the new commits descend from the old ones.
2. Trust GitHub's `line`/`isOutdated`. Rejected: undocumented rule, hides outdated threads, fails on force-push, and principle 2 says never rely on the host's answer alone. We can still compare against it and flag disagreement, as the "different snapshot" chip does.
3. Text search for the commented lines. Rejected as the primary method (C15, duplicate lines), kept as a fallback candidate for moved code, always labelled a guess.

### Carry-over of review progress

1. **Exact identity carries, everything else is shown as rework** (recommended). Agreed 2026-11-03 with the rule sharpened: the exact change carries. A cluster's removed and added lines, traced by the engine to their place in the new snapshot (path or rename pair), are identical there. Context is not part of the rule: context lines the PR changed form a cluster of their own, ones the base changed are not in the diff. A cluster whose run of changes was reworked is unticked. Crossed off carries by the same rule. The carry is an `auto` event from the matching patch set, any earlier one included (P8). A reworked cluste r shows the old cluster's lines against the new ones, so the reviewer reads the delta, and marks it again. Gerrit's identical-blob rule and Reviewable's reviewed-at-revision are the precedents; ours is finer (cluster, not file).
2. Add a `context-only` rule (P2): carry when only the 3 surrounding lines changed and the interdiff for that file is empty, marked so in the event and in the UI. Settled by option 1 (owner, 2026-11-03): context is not in the rule, so nothing is lost on base merges near a change.
3. Per-line states instead of per-cluster, so a split cluster carries its untouched lines (P4). Bigger change to the storage format and the UI. Parked on the todo list (owner, 2026-11-03): first find a way to measure how often clusters split on real PRs.

### The interdiff

1. **Virtual rebase by `merge-tree`** (recommended): `H1' = merge-tree(B2, H1)`, interdiff `= diff(H1', H2)`; a conflicted file shows git's conflict against the author's resolution (I5); if `merge-tree` can't run, the interdiff is unavailable and everything is unreviewed (I10). This is the diff of diffs the owner described, diff(B1 to H1) against diff(B2 to H2), computed by git on file content rather than on patch text, so context drift and line numbers after a rebase add no noise and duplicate lines pair by position. A conflicted file needs no special handling to be correct: it shows as rework either way; the conflict markers are only an optional baseline for reading the resolution. Agreed 2026-11-03. Proven by two probes; needs the methodology matrix extended with S3, S4b, S8 and a shape where `merge-tree` fails.
2. Gerrit's subtraction: `diff(H1, H2)` minus hunks also in `diff(B1, B2)`, marked due to rebase. Approximate, loses overlapping hunks "in doubt", no help with conflicts. Fallback only.
3. `git range-diff` per commit. Useful as a bonus view when commits correspond; useless after squashes and merges. Not the basis.

### Where it shows

1. **Files changed, filtered to "since PS1"** (recommended): carried clusters collapse with a carried mark, reworked and new clusters open, unplaced threads listed under their file; the full snapshot is one toggle away. Reviewable's "Show Diffs to Review" is the precedent. The reviewer moves to `R` explicitly from the banner, which says the shape: "3 new commits", "rebased, nothing new", "rebased with 2 conflicts".
2. A separate interdiff page. Keeps Files changed simple but splits the reviewer's attention across two diffs. Possible later for "compare any two patch sets" (P16).
3. Both, one engine. Likely where this ends up; start with 1.

**Constraints (owner, 2026-11-03), all inside Files changed:**

1. The reviewer can always go back to any changeset exactly as it was when they reviewed it, comments and review marks as they were. Patch set heads are pinned, so even a force-push can't take that away; the merge base lives in the base branch's history, so pinning it too (one more ref per patch set) closes the last gap, a rewritten base.
2. With two or more changesets, the reviewer can see either the interdiff between two consecutive changesets or the diff to the merge base.
3. Each changeset has its own state and data model, and a changeset's interdiff and base diff share it: a comment made on one shows on the other, review state is correlated intuitively. Both views are projections of one changeset's state; the carry from the previous changeset seeds it.

### Context for unplaced threads

1. **Keep the commenter's code pane, add the fate** (recommended): deleted in commit X, rewritten (old beside new), file gone, reverted; a landing spot in the new file; a candidate location when moved-code matching or AI finds one, as an editable annotation (X4, X7). GitLab's `change_position` and Phabricator's jump-back button are the precedents.
2. Gerrit's degrade-to-file-level only. Simpler, but loses the "what happened" the reviewer needs for X1 and X5.

### Storage

Carry events (`by: auto`) in the reviewer's progress ref, naming source patch set, cluster key and rule; a `patchset-started` for `R` with `details.since` = `PS1` and the shape (S1..S9) it detected; the pinned `patchsets/<n>` refs already keep every old head alive, so any pair can be compared later. Thread anchors are computed by the engine by default and stored only where discretion decided them (owner, 2026-11-04): a placement event (thread, patch set, anchor, by human or ai, engine version) wins over the engine's answer, and is validated against the snapshot before use (a line that isn't there fails closed to unplaced). So AI or the reviewer can settle ambiguous cases later without a migration, and the deterministic path stays free and small. This stays within `docs/review-data-storage.md` "Deferred" and `docs/gitdb-design-principles.md`.

## Open decisions (yours)

- [ ] **Context-only carry (P2, I13):** carry a cluster whose changed lines are identical but whose 3 context lines differ, marked "context changed", or leave it unreviewed? Decided 2026-11-03: context is not part of the rule. An exact change that traces to its new place carries; a reworked run of changes is unticked.
- [ ] **Crossed-off carry (P7):** does a crossed-off cluster stay crossed off when its file is regenerated with new content, or must it be crossed off again? Decided 2026-11-03: crossed off carries by the same cluster rule as reviewed, nothing file-wide; a regenerated cluster is crossed off again.
- [ ] **What starts a patch set:** today only marking a cluster. Should a comment, or merely opening the PR, pin the head (I12)? Decided 2026-11-03: any lasting reviewer action starts one (mark, cross off, comment, verdict); marking-only today is an oversight. Opening alone records a last-seen head without starting one (my call; say if not).
- [ ] **Resolved threads:** place them too (GitLab) or only unresolved ones (Gerrit, for speed)? Decided 2026-11-03: unresolved threads only, as Gerrit does. A thread unresolved later is placed from then on: placement is computed at read time from the current resolved state, never cached past a resolve or unresolve.
- [ ] **Default view on return:** land on "since your last patch set" or on the full snapshot with carried marks? Decided 2026-11-03: "since", with the full view a toggle away.
- [ ] **AI's role:** limited to proposing candidate locations for moved code and "addressed by commit X" annotations, all editable, never marking or hiding (principles 1, 2). Decided 2026-11-03: no AI in this round. Later it associates changes with comments, confirms comments were addressed and helps associate clusters, always as editable suggestions.

## Gallery and test coverage

Five gallery cases (six PRs) cover every scenario above; each PR has curated patch sets, so you can open it at each one, see the case, and judge whether the behaviour is acceptable. A seeding script per case does the reviewer's part reproducibly: open the PR pinned on the first head, mark and cross off the listed clusters, post the listed comments through carbonless, then push the next head. Comments must be made before the next push, so the script runs the pushes in order. Marks live in the local review refs; the script seeds them in whichever clone opens the gallery.

| Case (`base/<case>`, `case/<case>`) | Pushes, each a patch set | Scenarios shown |
| --- | --- | --- |
| `rr-append` | PS1: one tall file with a duplicated block, a generated file, 8 threads on every anchor kind. Push 2: lines inserted above, one commented line edited, one deleted, a range partly changed, a suggestion applied verbatim, one duplicate block moved, a whitespace-only edit, a span's line reflowed, a cluster split by an insertion, the generated file regenerated, one thread resolved and another unresolved. Approve on PS1 before push 2. | S1, C1, C2, C3, C4, C14, C15, C16, C17, C18, P1, P3, P4, P5, P7, P12, P13, I1, X1, X2, resolved then unresolved |
| `rr-rebase` | PS1 on the fork point. Base gains a commit touching lines near, and one inside the context of, the PR's clusters. Push 2: trivial rebase. Push 3: rebase plus an amend of a commented line and a squash of the commits. Push 4: force-push back to push 2's content. One comment made on GitHub's own "changes since your last review" view on a LEFT line between push 2 and 3. | S2, S4a, S4c, S5, S6, C5, C6, C11, C12, C13, P2, P8, P9, I3, I4, I11, I13 |
| `rr-merge-in` | PS1. Base changes a line the PR also changed and a file the PR didn't. Push 2: the author merges the base in and resolves the conflict with something other than either side; a second file merges cleanly. | S3, S4b, I2, I5, X6, conflict baseline |
| `rr-moves` | PS1: three files. Push 2: one file renamed with a commented line inside, one deleted with a thread on it, a commented function extracted to a new file, a whole-file formatter sweep on the third, one reviewed commit reverted. | S9, C7, C8, C9, P6, P10, P11, X3, X4, X5, X8 |
| `rr-stacked` (two PRs) | Parent PR on `base/rr-stacked`, child PR on the parent's branch, PS1 on the child. The parent lands by squash and its branch is deleted, so GitHub retargets the child; push 2: the child rebases. | S7, S8, I8 |

Not in the gallery: C10 needs comments from a second GitHub account (list it only if you have one; otherwise it is test-only), C19 can only be observed on real PRs, I10 and S10 are test-only (unrelated histories, a swapped fork).

**Tests**, each failing without the feature:

- **Tracer library** (pure, no git): a table-driven case per C1–C19 with synthetic diffs, plus a property checked for any input: every traced position lands on a line that exists in the new snapshot or is reported unplaced with a reason; nothing is dropped and nothing lands on a line whose text differs without being marked changed.
- **Carry rules**: a case per P1–P12, plus the fail-closed property: a carried state names a cluster in `R` whose removed and added lines equal the source cluster's; any corrupt, missing or invented carry event leaves the cluster unreviewed (principle 2). Crossed off carries by the same rule.
- **Interdiff**: the methodology matrix (`test/methodology-fixture.ts`) grows a fourth branch update, rebase with amend, a conflicting merge-base-in, and a stacked-squash landing, and asserts the interdiff per I1–I9; I10 with a shallow clone and with unrelated histories asserts "unavailable, everything unreviewed".
- **End to end** (Playwright, desktop and phone): each gallery case rebuilt as a fixture with the fake gh: the banner says the shape, the "since" filter shows exactly the reworked and new clusters, unplaced threads list their fate, going back to PS1 shows it exactly as reviewed (constraint 1), the interdiff and base views of one changeset share state (constraint 3).
- **Real PR**: `pnpm compare-threads` on gytpol/test-automation#99 as of each of its review rounds, read-only, checks thread placement against GitHub's own `line` (C19).

## What happens next

After this discussion: a design doc with mockups (desktop and phone) for the banner, the "since" filter, reworked clusters and unplaced threads; the methodology matrix extended with the shapes above; a gallery PR per edge case (S3, S4b, S8, C5, P4, P10). Parked on the todo list: per-line states (P4), once there is a way to measure how often clusters split. The worktree `.worktrees/re-review` (branch `re-review` from master) holds this document.
