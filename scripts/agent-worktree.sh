#!/usr/bin/env bash
# Creates a ready-to-test worktree for an agent:
#   scripts/agent-worktree.sh <name> [base]
# -> .worktrees/<name> on a new branch <name>, from base (default: HEAD).
# Dependencies come from the shared pnpm store (no network when it is warm);
# Playwright browsers are global (~/.cache/ms-playwright), so none download.
# Tests use random ports, per-test temp dirs and their own XDG_CACHE_HOME, so
# `pnpm verify` can run in several worktrees at once. A private
# XDG_STATE_HOME and XDG_CONFIG_HOME (in .envrc; export them) keep the
# worktree's crb from finding the owner's crb serve, or starting one there.
# Remove with: git worktree remove .worktrees/<name> && git branch -D <name>
set -euo pipefail

name="${1:?usage: scripts/agent-worktree.sh <name> [base]}"
base="${2:-HEAD}"
root="$(git rev-parse --show-toplevel)"
dir="$root/.worktrees/$name"

git -C "$root" worktree add -b "$name" "$dir" "$base"
cd "$dir"
pnpm install --frozen-lockfile --prefer-offline
# A no-op when this Playwright version's Chromium is already in the global cache.
pnpm exec playwright install chromium
cat > .envrc <<ENVRC
export XDG_STATE_HOME="$dir/.crb-dev/state"
export XDG_CONFIG_HOME="$dir/.crb-dev/config"
ENVRC
echo "Ready: $dir"
echo "Before running crb there: source $dir/.envrc"
cat .envrc
