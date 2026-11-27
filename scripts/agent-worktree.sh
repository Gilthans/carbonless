#!/usr/bin/env bash
# Creates a ready-to-test worktree for an agent:
#   scripts/agent-worktree.sh <name> [base]
# -> .worktrees/<name> on a new branch <name>, from base (default:
# origin/master, fetched first, so a worktree never starts from a stale
# master or from whatever the calling checkout has out). base can be any
# commit-ish: a branch, a ref, a SHA. The new branch tracks nothing (push it
# with `git push -u origin <name>`). If the fetch fails (offline, a sandbox
# without network), it warns and goes on from the refs it has; the printed
# "Base:" line's date shows how old that is.
# Dependencies come from the shared pnpm store (no network when it is warm);
# Playwright browsers are global (~/.cache/ms-playwright), so none download.
# Tests use random ports, per-test temp dirs and their own XDG_CACHE_HOME, so
# `pnpm verify` can run in several worktrees at once. A private
# XDG_STATE_HOME and XDG_CONFIG_HOME (in .envrc; export them) and a config
# serving on a free port keep the worktree's crb from finding the owner's
# crb serve, or starting one on its port.
# Remove with: git worktree remove .worktrees/<name> && git branch -D <name>
set -euo pipefail

name="${1:?usage: scripts/agent-worktree.sh <name> [base]}"
base="${2:-origin/master}"
root="$(git rev-parse --show-toplevel)"
dir="$root/.worktrees/$name"

if ! git -C "$root" fetch --quiet origin; then
	echo "WARNING: git fetch origin failed; branching from the local $base, which may be stale." >&2
fi
sha="$(git -C "$root" rev-parse --verify --quiet "$base^{commit}")" || {
	echo "agent-worktree.sh: no such commit: $base" >&2
	exit 1
}
echo "Base: $base ($(git -C "$root" log -1 --format='%h, %cd' --date=iso "$sha"))"

git -C "$root" worktree add --no-track -b "$name" "$dir" "$sha"
cd "$dir"
pnpm install --frozen-lockfile --prefer-offline
# A no-op when this Playwright version's Chromium is already in the global cache.
pnpm exec playwright install chromium
# .envrc and a config serving on a free port (0), never the owner's 4747.
node scripts/crb-private-env.mjs "$dir" 0 >/dev/null
echo "Ready: $dir"
echo "Base: $base ($(git log -1 --format='%h, %cd' --date=iso "$sha"))"
echo "Before running crb there: source $dir/.envrc"
cat .envrc
