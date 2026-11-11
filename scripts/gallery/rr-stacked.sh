#!/usr/bin/env bash
# Gallery case `rr-stacked`: a child PR stacked on a parent PR. PS1 is the
# child reviewed on top of the parent, with a comment and a verdict
# (Comment: the gallery's PRs are the gh login's own). Then the parent is
# squash-merged and its branch deleted, so GitHub retargets the child to the
# base (S7: the parent's code now reads as the child's, all new: the
# multi-base graph is a todo); one mark there starts PS2. Then the child is
# rebased onto the base (S4a): the same diff as PS1 again, which the Final
# Verdict tab says. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-stacked.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-stacked
PARENT="case/$CASE-parent"

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/api.ts <<'EOF'
export async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
EOF
	cat >src/config.ts <<'EOF'
export const API_URL = "https://api.example.com";
export const PAGE_SIZE = 50;
EOF
}

# The parent PR: retries around every request.
write_parent() {
	cat >src/retry.ts <<'EOF'
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
EOF
	cat >src/api.ts <<'EOF'
import { withRetry } from "./retry";

export async function getJson(url: string): Promise<unknown> {
  return withRetry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  });
}
EOF
}

# The child PR, on the parent's branch: a timeout helper and its setting
# (lines the parent never touches, so a rebase replays it cleanly).
write_child() {
	cat >src/timeout.ts <<'EOF'
import { TIMEOUT_MS } from "./config";

export function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
EOF
	cat >src/config.ts <<'EOF'
export const API_URL = "https://api.example.com";
export const PAGE_SIZE = 50;
export const TIMEOUT_MS = 5000;
EOF
}

# ---- the branches and the PRs -------------------------------------------------

gallery_clone
if g ls-remote --exit-code --heads origin "$PARENT" >/dev/null 2>&1; then
	log "deleting origin/$PARENT (re-run)"
	g push --quiet origin --delete "$PARENT"
fi
g branch --quiet -D "$PARENT" 2>/dev/null || true
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "api client" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "$PARENT"
(cd "$CLONE" && write_parent)
PARENT_TIP="$(commit_all "Retry every request three times")"
push_branch "$PARENT"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_child)
PS1="$(commit_all "A timeout for requests")"
push_branch "case/$CASE"

PARENT_URL="$(gh pr create -R "$GALLERY" -B "base/$CASE" -H "$PARENT" \
	--title "rr-stacked (parent): retries; squash-merged under its child" \
	--body-file - <<'EOF'
The parent of the stacked case `rr-stacked`: the child PR is opened on this branch and reviewed there, then this PR is squash-merged and its branch deleted, so GitHub retargets the child to `base/rr-stacked`. Look at the child PR, not this one.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
PARENT_PR="${PARENT_URL##*/}"
log "parent PR: $PARENT_URL"

CHILD_URL="$(gh pr create -R "$GALLERY" -B "$PARENT" -H "case/$CASE" \
	--title "rr-stacked: a PR stacked on another; the parent squash-merged, the child retargeted and rebased" \
	--body-file - <<EOF
A child PR stacked on a parent PR (#$PARENT_PR). The reviewer reviews the child on top of the parent (PS1); the parent is then squash-merged and its branch deleted, so GitHub retargets the child to \`base/rr-stacked\` (S7); the child is then rebased onto it (S4a). Open it in carbonless on the seeding instance.

What happened, in order:

| Step | The PR | In carbonless |
| --- | --- | --- |
| PS1 | the child on \`$PARENT\`: \`src/timeout.ts\` (new) and \`TIMEOUT_MS\` in \`src/config.ts\` | everything reviewed; a comment on \`timeout.ts\` 5 (the \`setTimeout\` line); a verdict: Comment |
| The parent squash-merged, its branch deleted | GitHub retargets the child to \`base/rr-stacked\`; the head is unchanged | PS2 (one mark started it), "Retargeted to base/rr-stacked": the parent's \`src/retry.ts\` and \`src/api.ts\` now read as the child's own change, \`new\`, because the base no longer has the parent's commits (a graph with the parent's head as a second comparison base is a todo); the child's clusters \`carried\` |
| The child rebased onto \`base/rr-stacked\` | the head (force-pushed) | the head dot: PS2 → head "Rebased, nothing new" (the parent's clusters absorbed by the base); Final Verdict: "You commented … (PS1)" and "Retargeted, same diff · nothing to re-read" |

Look at: the patch set graph (the branch dot's name changes between PS1 and PS2), PS2's since view (the parent's code as new), viewing the head (nothing to read), the comment staying on its line through all three, and the Final Verdict tab's since line.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
PR="${CHILD_URL##*/}"
log "child PR: $CHILD_URL"

# ---- the reviewer's part: PS1 ----------------------------------------------------

crb_open "$PR"
mark_view "$(review_view)"
comment "$PS1" src/timeout.ts RIGHT 5 "Should the timeout span all three retries, or each try?"
verdict COMMENT "$PS1" "Timeouts look right; one question on their scope."
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# ---- the parent lands: squash-merged, its branch deleted, the child retargeted -----

# What GitHub does when a merge deletes the head branch (the repository's
# "Automatically delete head branches"): the PRs on that branch move to its
# base. Deleting the branch through the API instead closes them, so the
# script squash-merges, retargets the child as GitHub would, then deletes.
(cd "$WORK" && gh pr merge "$PARENT_PR" -R "$GALLERY" --squash >/dev/null)
gh pr edit "$PR" -R "$GALLERY" --base "base/$CASE" >/dev/null
g push --quiet origin --delete "$PARENT"
log "parent #$PARENT_PR squash-merged, #$PR retargeted, $PARENT deleted"
wait_pr_base "$PR" "base/$CASE"
wait_base "base/$CASE"
view="$(view_head "$PS1")"
key="$(keys_of src/timeout.ts 1 <<<"$view")"
mark "$(jq -r .revision <<<"$view")" reviewed -- "$key"
log "PS2 (retargeted): $(review_view | jq -c '{patchset, progress: .progress.clusters}')"

# ---- the child rebased onto the base -------------------------------------------

g fetch --quiet origin
g checkout --quiet "case/$CASE"
g rebase --quiet --onto "origin/base/$CASE" "$PARENT_TIP"
HEAD3="$(g rev-parse HEAD)"
push_branch "case/$CASE" --force
log "pushed $HEAD3; waiting for the server to see it"
wait_head "$HEAD3"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY (and the Final Verdict tab)"
