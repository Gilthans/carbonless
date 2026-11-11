#!/usr/bin/env bash
# Gallery case `rr-markable`: the since view's edges of "every visible
# cluster is individually markable" (docs/product-rules.md). PS1 is
# reviewed in full; push 2 reverts one reviewed line and edits the base line
# under it (one interdiff block in pieces: a gone piece beside the
# reworked cluster's), undoes a whole file (a
# gone file), re-indents a reviewed line (whitespace-only rework) and adds
# a mode change. The head is left unstarted (a provisional view). See
# README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-markable.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-markable

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src bin
	cat >src/table.ts <<'EOF'
export interface Row {
  id: string;
  name: string;
  price: number;
}

export function render(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const name = r.name;
    const cents = Math.round(r.price * 100);
    const price = (cents / 100).toFixed(2);
    out.push(`${r.id}\t${name}\t${price}`);
  }
  return out;
}

export function total(rows: Row[]): number {
  let sum = 0;
  for (const r of rows) sum += r.price;
  return sum;
}
EOF
	cat >src/legacy.ts <<'EOF'
export function legacyRender(rows: string[]): string {
  return rows.join("\n");
}
EOF
	cat >src/fmt.ts <<'EOF'
export function pad(s: string, n: number): string {
  return s.padEnd(n);
}
EOF
	printf '#!/bin/sh\nnode dist/table.js "$@"\n' >bin/table.sh
}

write_ps1() {
	cat >src/table.ts <<'EOF'
export interface Row {
  id: string;
  name: string;
  price: number;
}

export function render(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const cents = Math.round(r.price * 100);
    const price = (cents / 100).toFixed(2) + " EUR";
    out.push(`${r.id}\t${name}\t${price}`);
  }
  return out;
}

export function total(rows: Row[]): number {
  let sum = 0;
  for (const r of rows) sum += Math.max(0, r.price);
  return sum;
}
EOF
	cat >src/legacy.ts <<'EOF'
export function legacyRender(rows: string[]): string {
  return rows.join("\r\n");
}
EOF
	cat >src/fmt.ts <<'EOF'
export function pad(s: string, n: number): string {
  return s.trim().padEnd(n);
}
EOF
}

write_push2() {
	cat >src/table.ts <<'EOF'
export interface Row {
  id: string;
  name: string;
  price: number;
}

export function render(rows: Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const name = r.name;
    const cents = Math.round(r.price * 100 + Number.EPSILON);
    const price = (cents / 100).toFixed(2) + " EUR";
    out.push(`${r.id}\t${name}\t${price}`);
  }
  return out;
}

export function total(rows: Row[]): number {
  let sum = 0;
  for (const r of rows) sum += Math.max(0, r.price);
  return sum;
}

export function formatPrice(price: number): string {
  return `${price.toFixed(2)} EUR`;
}
EOF
	cat >src/legacy.ts <<'EOF'
export function legacyRender(rows: string[]): string {
  return rows.join("\n");
}
EOF
	printf 'export function pad(s: string, n: number): string {\n\treturn s.trim().padEnd(n);\n}\n' >src/fmt.ts
	chmod +x bin/table.sh
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "table 1.0" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_ps1)
PS1="$(commit_all "Trim names, show the currency, CRLF for legacy")"
push_branch "case/$CASE"
PR="$(open_pr "$CASE" "rr-markable: since-view units that must each be markable (a gone piece holding a reworked line, a gone file)" <<'EOF'
The since view's edge cases for "every cluster visible in the UI in any view should be individually markable" (the owner). Open it with PS1 reviewed (the seeding script does that), then view the head since PS1. The head is left unstarted: the view is provisional until the first mark.

1. PS1 (`Trim names, show the currency, CRLF for legacy`): `render()`'s name (trim) and price (EUR), two clusters one line apart; `total()` clamps; `legacy.ts` joins with CRLF; `fmt.ts` trims. All reviewed.
2. Push 2 (`Keep names as given, round cents, formatPrice, back to LF, tabs`): the name line back to the base's, the `cents` line between the two clusters edited (price untouched), a new `formatPrice()`; `legacy.ts` back to the base (nothing of PS1 left); `fmt.ts`'s line re-indented with a tab; `bin/table.sh` made executable.

| Where | Since PS1 | What to look at |
| --- | --- | --- |
| `table.ts` `render()` | the name cluster is `gone`; `cents` + `price` are one `reworked` cluster | one interdiff block in pieces: the reverted name line is a `gone` piece with its own box; the base's `cents` line removed belongs to the reworked cluster (keyed to it since the per-piece marks), and each piece ticks alone |
| `table.ts` `formatPrice()` | `new` | its own box |
| `table.ts` `total()` | carried | not in the since view; green and `carried` in the full diff |
| `legacy.ts` | the whole file undone: listed after the files, red, its PS1 change as a gone block | each gone piece has its own box and ⊘ |
| `fmt.ts` | the reviewed line re-indented: `reworked`, whitespace only | with Ignore whitespace on, a collapsed row with its own box |
| `bin/table.sh` | a mode change, new | a file-level row with its own box |

Try each unit's box and ⊘ on desktop and on a phone, in the since view and in the full diff (Ctrl+Shift+[): each changes only itself, and a reload keeps it. The first mark starts PS2.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- the reviewer's part: PS1 ----------------------------------------------------

crb_open "$PR"
view="$(review_view)"
[ "$(jq -r '.files | length' <<<"$view")" = 3 ] || die "expected 3 files on PS1"
mark_view "$view" reviewed
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# ---- push 2 ---------------------------------------------------------------------

(cd "$CLONE" && write_push2)
PS2="$(commit_all "Keep names as given, round cents, formatPrice, back to LF, tabs")"
push_branch "case/$CASE"
log "pushed $PS2; waiting for the server to see it"
wait_head "$PS2"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY and view the head"
