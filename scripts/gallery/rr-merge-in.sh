#!/usr/bin/env bash
# Gallery case `rr-merge-in`: the base is merged into the PR after the
# review, with conflicts (shape S3). PS1 changes the port and drops a
# header; the base then changes both lines too, and the author merges it in,
# resolving both files. The since view chips both files `conflict`; the
# thread on the port line is changed (its line was rewritten by the
# resolution); the thread on the dropped header's old line (a LEFT line) is
# unplaced, `base changed` (X6). See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-merge-in.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-merge-in

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/config.ts <<'EOF'
export const config = {
  host: "0.0.0.0",
  port: 8080,
  timeoutMs: 5000,
  retries: 2,
  logLevel: "info",
};
EOF
	cat >src/server.ts <<'EOF'
import { createServer } from "node:http";
import { config } from "./config";

export function start() {
  const server = createServer((req, res) => {
    res.setHeader("x-powered-by", "notify");
    res.end("ok");
  });
  server.listen(config.port, config.host);
  return server;
}

export function stop(server: ReturnType<typeof start>) {
  server.close();
}
EOF
}

# PS1: the port from the environment; the header dropped, a timeout set.
write_push1() {
	cat >src/config.ts <<'EOF'
export const config = {
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  timeoutMs: 5000,
  retries: 2,
  logLevel: "info",
};
EOF
	cat >src/server.ts <<'EOF'
import { createServer } from "node:http";
import { config } from "./config";

export function start() {
  const server = createServer((req, res) => {
    res.end("ok");
  });
  server.listen(config.port, config.host);
  server.setTimeout(config.timeoutMs);
  return server;
}

export function stop(server: ReturnType<typeof start>) {
  server.close();
}
EOF
}

# The base moves on: a new default port, a versioned header.
write_base_move() {
	sed -i 's/port: 8080,/port: 8081,/' src/config.ts
	sed -i 's|"x-powered-by", "notify"|"x-powered-by", "notify/2"|' src/server.ts
}

# The author's resolution of the merge: the new default under the
# environment's port; the header stays dropped.
resolve_merge() {
	write_push1
	sed -i 's/PORT ?? 8080/PORT ?? 8081/' src/config.ts
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "notify server" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_push1)
PS1="$(commit_all "Port from the environment; no x-powered-by; a timeout")"
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-merge-in: the base merged in with conflicts (conflict chips, a LEFT thread whose base changed)" <<'EOF'
The base is merged into the PR after the review, and both files conflict (shape S3 with conflicts). Open it in carbonless with PS1 reviewed (the seeding script does that), then view the head.

What happened, in order:

1. PS1 (`Port from the environment; no x-powered-by; a timeout`): `src/config.ts` reads the port from `PORT`; `src/server.ts` drops the `x-powered-by` header and sets a timeout. The reviewer marks everything reviewed and leaves two comments: on the port line (`config.ts` 3) and on the dropped header's old line (`server.ts` 6, the old side: a LEFT comment).
2. The base moves on: the default port becomes 8081, the header becomes `notify/2`. Both lines are the ones PS1 changed.
3. Push 2: the author merges the base in (`Merge base/rr-merge-in`), resolving `config.ts` to `PORT ?? 8081` and keeping the header dropped.

| Thing | In carbonless, viewing the head since PS1 |
| --- | --- |
| `src/config.ts`, `src/server.ts` | a red `conflict` chip on each file's header (git could not rebase them: all of each is new to read) |
| The port comment (`config.ts` 3) | on the resolved line with a yellow `changed since` chip; its card shows the old line (`?? 8080`) above the new one (`?? 8081`) and "Line rewritten since PS1 · See on PS1" |
| The header comment (LEFT, `server.ts` 6) | unplaced under `server.ts`'s header, fate `base changed` (X6): the base itself changed the line the commenter saw; the row shows that old code, lines 4–8 of PS1 |

Look at: the conflict chips (and their tooltip), the changed card in both views (the since view and the full diff: Ctrl+Shift+[), the unplaced row's original code and its `near` link, and the Overview's cards (`PS1` chip, `changed since`, `base changed`).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- the reviewer's part: PS1 ----------------------------------------------------

crb_open "$PR"
view="$(review_view)"
rev="$(jq -r .revision <<<"$view")"
all=()
while IFS= read -r k; do all+=("$k"); done < <(jq -r '.files[].clusters[].key' <<<"$view")
mark "$rev" reviewed -- "${all[@]}"
comment "$PS1" src/config.ts RIGHT 3 "Validate PORT: Number(\"abc\") is NaN and listen() takes it."
comment "$PS1" src/server.ts LEFT 6 "Does the load balancer still look for this header?"
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# ---- the base moves on; push 2: the base merged in, conflicts resolved ------------

g checkout --quiet "base/$CASE"
(cd "$CLONE" && write_base_move)
commit_all "Default port 8081; versioned header" >/dev/null
push_branch "base/$CASE"
g checkout --quiet "case/$CASE"
if g merge --quiet --no-edit "base/$CASE" >/dev/null 2>&1; then
	die "the merge should have conflicted"
fi
(cd "$CLONE" && resolve_merge)
g add --all
g commit --quiet --no-edit
PS2="$(g rev-parse HEAD)"
push_branch "case/$CASE"
log "pushed $PS2; waiting for the server to see it"
wait_head "$PS2"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY and view the head"
