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
