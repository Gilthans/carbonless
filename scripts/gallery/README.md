# Gallery case scripts

One script per re-review case of the gallery
(https://github.com/Gilthans/carbonless-gallery): it builds the case's
branches and PR on GitHub and does the reviewer's part through a running
carbonless, so the case opens with its patch sets seeded.

What a script does, in order (`lib.sh` has the pieces):

1. Clones the gallery into a scratch directory (`GALLERY_WORK`, else a temp
   dir) and starts `base/<case>` and `case/<case>` afresh from `main`'s
   first commit (an existing pair of the case is deleted: re-runs start
   over). Every push is a commit list written in the script, file by file.
2. Pushes both branches and opens the PR with `gh pr create`: the title is
   "<Case>: <what it shows>", the body a per-patch-set "what to look at"
   table.
3. Opens the PR in the branch instance (`crb <pr>` against the `crb serve`
   of this worktree: `source .envrc` first, see CLAUDE.md "Branch
   instance") while the PR is still on its first head, and seeds the
   reviewer's marks and comments through the API (`POST
   /api/r/<id>/review/states`, `POST /api/r/<id>/threads`; the comments go
   to GitHub).
4. Pushes the next head, and for a case with several patch sets marks one
   cluster of each new head (`GET /head`, `GET /review?head=`, a mark),
   which starts the patch set with the engine's carries.

The marks live in the review refs of the clone that opened the PR (the
instance's `~/.cache/carbonless` clone under its own review id): another
instance opening the same PR starts with none, which is why a case is
looked at on the instance that seeded it.

Cases:

- `rr-append.sh`: commits appended after the review (S1): carried,
  reworked, grown, duplicate, regenerated and new clusters.
- `rr-rebase.sh`: the base moves on; a rebase (S4a), a squash (S5), a
  fixup (S1) and a force-push back (S6), one patch set each.
- `rr-merge-in.sh`: the base merged in with conflicts (S3): conflict chips,
  a thread on a rewritten line (changed), a LEFT thread whose base changed
  (X6).
- `rr-moves.sh`: a rename, a deleted file (the trailing "Not in this
  comparison" group on PS2 and PS3), an extracted function (a `moved?`
  candidate), a formatter sweep (changed) and a reverted commit.

After a run, add the case's row to the gallery's README on `main` (the
script prints the PR number).
