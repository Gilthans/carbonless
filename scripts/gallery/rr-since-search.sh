#!/usr/bin/env bash
# Gallery case `rr-since-search`: Find in PR in the since view searches the
# interdiff, not the whole PR. PS1 puts five lines on top of core.ts (so
# PS1's line numbers differ from the base's) and changes line 20; push 2
# rewrites line 30 (PS1's 35). PS1 is reviewed in full and PS2 started with
# one mark. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-since-search.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-since-search

# ---- the files ---------------------------------------------------------------

lines() { for i in $(seq 1 "$2"); do printf '%s %s\n' "$1" "$i"; done; }

write_base() {
	mkdir -p src
	lines core 40 >src/core.ts
	lines util 10 >src/util.ts
}

# PS1: five lines on top of core.ts, its line 20 "earlyTerm"; util.ts line 3.
write_push1() {
	{
		lines top 5
		lines core 40 | sed 's/^core 20$/earlyTerm 20/'
	} >src/core.ts
	lines util 10 | sed 's/^util 3$/util 3 v1/' >src/util.ts
}

# Push 2: core.ts's line 30 (PS1's 35) rewritten; util.ts line 8.
write_push2() {
	{
		lines top 5
		lines core 40 | sed -e 's/^core 20$/earlyTerm 20/' -e 's/^core 30$/laterTerm 30/'
	} >src/core.ts
	lines util 10 | sed -e 's/^util 3$/util 3 v1/' -e 's/^util 8$/util 8 v2/' >src/util.ts
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "core and util" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_push1)
commit_all "PS1: a header, earlyTerm" >/dev/null
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-since-search: Find in PR searches the interdiff in the since view" <<'EOF'
Find in PR searches the comparison on screen. In the since view (base PS1, target PS2) that is the interdiff PS1 → PS2: a line changed only in PS1 is no changed line there, and hits carry the since view's line numbers on both sides (the old side numbered as in PS1, not the base). Move the base to the branch and the whole PR is searched again.

| Search (since view PS1 → PS2) | Expect |
| --- | --- |
| `earlyTerm` (changed in PS1 only) | no hit (the spinner while files load, never `0 of 0` before) |
| `core 30` (removed in PS2) | one hit; Enter opens `src/core.ts` and scrolls to the removed row, old line **35** (PS1's number; the base's is 30) |
| `laterTerm` (added in PS2) | one hit at new line 35 |
| `earlyTerm` with the base on the branch | one hit at new line 25 |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- the reviewer's part: PS1 ----------------------------------------------------

crb_open "$PR"
view="$(review_view)"
[ "$(jq -r '.files | length' <<<"$view")" = 2 ] || die "expected 2 files on PS1"
mark_view "$view" reviewed
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# ---- push 2, started with one mark ----------------------------------------------

(cd "$CLONE" && write_push2)
PS2="$(commit_all "PS2: laterTerm")"
push_branch "case/$CASE"
log "pushed $PS2; waiting for the server to see it"
wait_head "$PS2"
head_view="$(view_head "$PS2")"
mark "$(jq -r .revision <<<"$head_view")" reviewed -- \
	"$(keys_of src/util.ts 2 <<<"$head_view")"
log "done: open $REVIEW_URL/files?ps=2&from=1&key=$REVIEW_KEY (PR #$PR)"
