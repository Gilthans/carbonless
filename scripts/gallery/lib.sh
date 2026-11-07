#!/usr/bin/env bash
# Shared helpers for the gallery case scripts (README.md here): a clone of
# the gallery repo, its base and case branches, the PR, and the reviewer's
# part through the branch instance's API (marks, comments, the next head).
#
# Needs: git, gh (logged in as the gallery's owner), jq, curl, node, and a
# built crb (dist/cli.js) whose `crb serve` runs in this worktree's private
# environment (`source .envrc`; CLAUDE.md, "Branch instance").
set -euo pipefail

GALLERY="${GALLERY:-Gilthans/carbonless-gallery}"
GALLERY_URL="https://github.com/${GALLERY}.git"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CRB="${CRB:-$ROOT/dist/cli.js}"
WORK="${GALLERY_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/crb-gallery-XXXXXX")}"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Gallery Author}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-gallery@example.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

log() { printf 'gallery: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

[ -f "$CRB" ] || die "no $CRB: run pnpm build first"
for tool in git gh jq curl node; do
	command -v "$tool" >/dev/null || die "$tool is required"
done

# ---- git: the clone, the branches, the pushes -------------------------------

CLONE="$WORK/gallery"

# Clones the gallery (once) and checks out `main`.
gallery_clone() {
	if [ ! -d "$CLONE/.git" ]; then
		log "cloning $GALLERY into $CLONE"
		git clone --quiet "$GALLERY_URL" "$CLONE"
	fi
	git -C "$CLONE" checkout --quiet main
}

# `git` in the clone.
g() { git -C "$CLONE" "$@"; }

# Starts `base/<case>` fresh from main's first commit (an empty-ish tree
# every case builds its own files on) and checks it out. An existing
# remote branch of the case is deleted first (a re-run starts over).
case_branches_start() {
	local case="$1"
	for b in "base/$case" "case/$case"; do
		if g ls-remote --exit-code --heads origin "$b" >/dev/null 2>&1; then
			log "deleting origin/$b (re-run)"
			g push --quiet origin --delete "$b"
		fi
		g branch --quiet -D "$b" 2>/dev/null || true
	done
	local root
	root="$(g rev-list --max-parents=0 main | tail -1)"
	g checkout --quiet -b "base/$case" "$root"
}

# Commits everything in the clone with `message` and returns the SHA.
commit_all() {
	g add --all
	g commit --quiet -m "$1"
	g rev-parse HEAD
}

# Pushes the branch (force when `--force`), quietly.
push_branch() {
	local branch="$1"; shift
	g push --quiet "$@" origin "$branch:$branch"
}

# Opens the case's PR (`case/<case>` onto `base/<case>`) with `title` and the
# body on stdin; prints its number.
open_pr() {
	local case="$1" title="$2"
	local url
	url="$(gh pr create -R "$GALLERY" -B "base/$case" -H "case/$case" \
		--title "$title" --body-file -)"
	log "PR: $url"
	printf '%s\n' "${url##*/}"
}

# ---- carbonless: the review through the branch instance's API -------------

REVIEW_URL=""   # http://host:port/r/<id>
REVIEW_KEY=""   # the access key
REVIEW_API=""   # http://host:port/api/r/<id>

# `crb <pr>` against the running `crb serve` (the worktree's .envrc must be
# sourced): remembers the review's URL and key for the calls below.
crb_open() {
	local pr="$1"
	local link
	link="$(node "$CRB" "$GALLERY#$pr")"
	REVIEW_URL="${link%%\?*}"
	REVIEW_KEY="${link##*key=}"
	[ "$REVIEW_KEY" != "$link" ] || REVIEW_KEY=""
	REVIEW_API="${REVIEW_URL%/r/*}/api/r/${REVIEW_URL##*/r/}"
	log "review: $link"
}

api() {
	local method="$1" path="$2" body="${3:-}"
	local url="$REVIEW_API$path"
	case "$url" in *\?*) url="$url&key=$REVIEW_KEY" ;; *) url="$url?key=$REVIEW_KEY" ;; esac
	if [ -n "$body" ]; then
		curl -fsS -X "$method" -H 'content-type: application/json' --data "$body" "$url"
	else
		curl -fsS -X "$method" "$url"
	fi
}

# The review view: the session's own (no argument), a viewed head
# (`head=<oid>`), or an earlier patch set (`patchset=<n>`).
review_view() {
	local query="${1:-}"
	api GET "/review${query:+?$query}"
}

# The cluster keys of `path` in the review view on stdin, in file order:
# all of them, or the ones at the given 1-based positions.
keys_of() {
	local path="$1"; shift
	local view
	view="$(cat)"
	if [ $# -eq 0 ]; then
		jq -r --arg p "$path" '.files[] | select(.path == $p) | .clusters[].key' <<<"$view"
	else
		for i in "$@"; do
			jq -r --arg p "$path" --argjson i "$i" '.files[] | select(.path == $p) | .clusters[$i - 1].key' <<<"$view"
		done
	fi
}

# Marks clusters: `mark <revision> <state> [reason] -- <key>...` (state:
# reviewed | crossed-off | unreviewed). The first mark on a snapshot that
# is no patch set yet starts it (the server computes the carries first).
mark() {
	local revision="$1" state="$2"; shift 2
	local reason=""
	if [ "$1" != "--" ]; then reason="$1"; shift; fi
	[ "$1" = "--" ] && shift
	local changes
	changes="$(printf '%s\n' "$@" | jq -R --arg s "$state" --arg r "$reason" \
		'{key: ., state: $s} + (if $r == "" then {} else {reason: $r} end)' | jq -s .)"
	api POST /review/states "$(jq -n --arg rev "$revision" --argjson c "$changes" '{revision: $rev, changes: $c}')" >/dev/null
	log "marked $# cluster(s) $state"
}

# Posts a review comment through carbonless (it lands on GitHub):
# `comment <commit> <path> <side> <line> <body>` on one line, or with
# `<startLine>` before `<line>` as `comment_range`.
comment() {
	local commit="$1" path="$2" side="$3" line="$4" body="$5"
	api POST /threads "$(jq -n --arg c "$commit" --arg p "$path" --arg s "$side" \
		--argjson l "$line" --arg b "$body" --arg id "gallery-$(date +%s%N)" \
		'{clientId: $id, body: $b, attemptedAt: (now | todate), retry: false,
		  path: $p, commit: $c, subject: "line", side: $s, line: $l,
		  startSide: $s, startLine: $l, startCol: null, endCol: null}')" >/dev/null
	log "commented on $path:$line"
}

# Asks the server to look at GitHub's head again and prints it (`GET /head`).
check_head() {
	api GET /head | jq -r '.head.oid // empty'
}

# Waits until the server reports `sha` as the PR's head (GitHub's API can
# lag a push by a few seconds), a minute at most.
wait_head() {
	local sha="$1" head i
	for i in $(seq 1 20); do
		head="$(check_head)"
		[ "$head" = "$sha" ] && return 0
		sleep 3
	done
	die "the server reports head $head, not $sha"
}

# The snapshot of the PR's current head as viewed (its revision on stdout),
# after the server has seen the push: a mark against it starts the next
# patch set with the engine's carries.
view_head() {
	local head="${1:-}"
	[ -n "$head" ] || head="$(check_head)"
	[ -n "$head" ] || die "the server reports no head to view"
	review_view "head=$head"
}

# Waits until the server's review of the current snapshot has `n` files
# (a push just landed): the fold is immediate, so this is one read.
expect_files() {
	local n="$1"
	local got
	got="$(review_view | jq '.files | length')"
	[ "$got" = "$n" ] || die "expected $n files, the review has $got"
}
