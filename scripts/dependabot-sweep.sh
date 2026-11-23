#!/usr/bin/env bash
# The daily Dependabot sweep (CAR-273): starts a headless Claude Code agent
# with docs/agents/dependabot-sweep.md as its prompt, which sees every open
# Dependabot PR through to merge (or comments why it can't).
#
#   scripts/dependabot-sweep.sh [--dry-run] [--ref <git ref>]
#
# Run from anywhere in the repository; the agent starts at its root and
# makes its own worktree there. Exits 0 without starting an agent when no
# Dependabot PR is open (one `gh pr list` call).
#
#   --dry-run        print the open Dependabot PRs and the command it would
#                    run, then exit.
#   --ref <ref>      read the instructions from <ref> (e.g. origin/master)
#                    instead of the working tree, so a timer can run the
#                    newest instructions without touching the checkout.
#
# Environment:
#   CRB_SWEEP_PRS      "201 202": use this PR list instead of asking gh.
#                      Honoured with --dry-run only (to check the agent path
#                      without real Dependabot PRs).
#   CRB_SWEEP_TIMEOUT  time budget for the agent, as timeout(1) takes it
#                      (default 3h). On expiry the agent gets SIGTERM, then
#                      SIGKILL a minute later.
#   CRB_SWEEP_MODEL    model for the agent (default: Claude Code's default).
#   XDG_STATE_HOME     logs go to $XDG_STATE_HOME/carbonless/dependabot-sweep/
#                      (default ~/.local/state/...): <stamp>.jsonl (the full
#                      session, stream-json) and <stamp>.log (the agent's
#                      final summary), latest.log pointing at the newest.
set -euo pipefail

dry_run=0
ref=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) dry_run=1 ;;
	--ref)
		ref="${2:?--ref needs a git ref}"
		shift
		;;
	-h | --help)
		sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "dependabot-sweep: unknown argument: $1" >&2
		exit 2
		;;
	esac
	shift
done

root="$(git rev-parse --show-toplevel)"
cd "$root"
instructions_path="docs/agents/dependabot-sweep.md"

if [ -n "${CRB_SWEEP_PRS+x}" ] && [ "$dry_run" -ne 1 ]; then
	echo "dependabot-sweep: CRB_SWEEP_PRS is honoured with --dry-run only" >&2
	exit 2
fi

# The open Dependabot PRs, one "#<n> <title>" line each.
if [ -n "${CRB_SWEEP_PRS+x}" ]; then
	prs=""
	for n in $CRB_SWEEP_PRS; do
		case "$n" in
		*[!0-9]*)
			echo "dependabot-sweep: CRB_SWEEP_PRS: not a PR number: $n" >&2
			exit 2
			;;
		esac
		prs+="#$n (from CRB_SWEEP_PRS)"$'\n'
	done
	prs="${prs%$'\n'}"
else
	prs="$(gh pr list --author app/dependabot --state open --limit 100 \
		--json number,title --jq '.[] | "#\(.number) \(.title)"')"
fi

if [ -z "$prs" ]; then
	echo "dependabot-sweep: no open Dependabot PRs; not starting an agent"
	exit 0
fi

if [ -n "$ref" ]; then
	prompt="$(git show "$ref:$instructions_path")"
else
	prompt="$(cat "$instructions_path")"
fi

# What the agent may run. Everything else is denied (dontAsk, no prompts):
# reading and editing files, git, the gh subcommands the instructions use,
# the pnpm scripts for tests and merge-ok, and the repo's own scripts.
allowed=(
	Read Edit Write Grep Glob
	"Bash(cd *)"
	"Bash(git *)"
	"Bash(gh pr list *)" "Bash(gh pr view *)" "Bash(gh pr checks *)"
	"Bash(gh pr diff *)" "Bash(gh pr comment *)" "Bash(gh pr edit *)"
	"Bash(gh pr merge *)"
	"Bash(gh run list *)" "Bash(gh run view *)" "Bash(gh run rerun *)"
	"Bash(gh run download *)"
	"Bash(gh api repos/*/dependabot/alerts*)"
	"Bash(pnpm install *)" "Bash(pnpm verify:fast*)" "Bash(pnpm test*)"
	"Bash(pnpm lint*)" "Bash(pnpm typecheck*)" "Bash(pnpm build*)"
	"Bash(pnpm flake-check *)" "Bash(pnpm ci-flakes*)" "Bash(pnpm why *)"
	"Bash(pnpm list *)" "Bash(pnpm exec biome *)" "Bash(pnpm exec tsc *)"
	"Bash(pnpm release merge-ok *)" "Bash(pnpm release status*)"
	"Bash(node scripts/*)" "Bash(scripts/agent-worktree.sh *)"
	"Bash(source *)" "Bash(date*)" "Bash(ls *)" "Bash(mkdir *)"
	"Bash(sleep *)" Monitor
)
# Carve-outs from the allowed patterns above (deny wins; Edit rules cover
# every file-writing tool).
denied=(
	"Bash(git push *master*)" "Bash(git * push *master*)"
	"Bash(git push *--tags*)" "Bash(git * push *--tags*)"
	"Bash(git push *--mirror*)" "Bash(git push *--all*)"
	"Bash(git push *refs/tags/*)" "Bash(git push *--delete*)"
	"Bash(git * push *--delete*)" "Bash(git * push *refs/tags/*)"
	"Bash(git tag *)" "Bash(git config *)" "Bash(git remote *)"
	"Bash(gh api * -X *)" "Bash(gh api * --method *)"
	"Bash(gh api * -f *)" "Bash(gh api * -F *)"
	"Bash(gh api * --field *)" "Bash(gh api * --raw-field *)"
	"Bash(gh api * --input *)"
	"Bash(gh pr merge * --squash*)" "Bash(gh pr merge * --rebase*)"
	"Bash(gh pr merge * --delete-branch*)"
	"Edit(.claude/**)" "Edit(**/.claude/**)" "Edit(~/.claude/**)"
	"Edit(.github/**)" "Edit(**/.github/**)"
	"Edit(scripts/release*)" "Edit(**/scripts/release*)"
)
timeout_budget="${CRB_SWEEP_TIMEOUT:-3h}"
cmd=(
	timeout --kill-after=1m "$timeout_budget"
	claude -p
	--name dependabot-sweep
	--permission-mode dontAsk
	--permission-prompts none
	--allowedTools "${allowed[@]}"
	--disallowedTools "${denied[@]}"
	--output-format stream-json --verbose
)
if [ -n "${CRB_SWEEP_MODEL:-}" ]; then
	cmd+=(--model "$CRB_SWEEP_MODEL")
fi

log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/carbonless/dependabot-sweep"
stamp="$(date +%Y-%m-%dT%H%M%S)"

if [ "$dry_run" -eq 1 ]; then
	echo "dependabot-sweep: open Dependabot PRs:"
	printf '%s\n' "$prs" | sed 's/^/  /'
	echo "dependabot-sweep: would run, in $root (prompt: ${ref:+$ref:}$instructions_path, $(printf '%s' "$prompt" | wc -l) lines, on stdin):"
	printf '  %q' "${cmd[@]}"
	printf '\n'
	echo "dependabot-sweep: log: $log_dir/$stamp.jsonl, summary: $log_dir/$stamp.log"
	exit 0
fi

mkdir -p "$log_dir"
# One sweep at a time: a second start while one runs exits at once.
exec 9>"$log_dir/.lock"
if ! flock -n 9; then
	echo "dependabot-sweep: another sweep is running; not starting a second" >&2
	exit 0
fi

jsonl="$log_dir/$stamp.jsonl"
summary="$log_dir/$stamp.log"
echo "dependabot-sweep: $(printf '%s' "$prs" | wc -l) PR(s); agent log $jsonl"
status=0
printf '%s\n\nOpen Dependabot PRs at start:\n%s\n' "$prompt" "$prs" |
	"${cmd[@]}" >"$jsonl" 2>"$log_dir/$stamp.stderr" || status=$?
# The agent's final message (the one-line-per-PR log), from the session.
jq -r 'select(.type == "result") | .result // empty' "$jsonl" >"$summary" 2>/dev/null || true
ln -sfn "$stamp.log" "$log_dir/latest.log"
[ -s "$log_dir/$stamp.stderr" ] || rm -f "$log_dir/$stamp.stderr"
# Keep 60 days of logs.
find "$log_dir" -maxdepth 1 -type f \( -name '*.jsonl' -o -name '*.log' -o -name '*.stderr' \) -mtime +60 -delete
cat "$summary"
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
	echo "dependabot-sweep: the agent ran out of its $timeout_budget budget" >&2
fi
exit "$status"
