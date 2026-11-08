#!/usr/bin/env bash
# Gallery case `rr-showcase`: the re-review demo. One PR goes through the
# three ways an author updates a PR after a review, in order, with the
# reviewer's marks and comments at each step: PS1 reviewed, commented and
# given a verdict (Comment: the gallery's PRs are the gh login's own); push 2
# appends commits (S1, PS2); push 3 rebases onto a moved base (S4a, PS3);
# push 4 merges the base in with a conflict (S3), left as the head to view.
# The PR body is the guided tour. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-showcase.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-showcase

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/cart.ts <<'EOF'
export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function total(items: Item[], discount = 0): number {
  const raw = subtotal(items) - discount;
  return Math.round(raw * 100) / 100;
}
EOF
	cat >src/format.ts <<'EOF'
export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
EOF
}

# PS1's cart: the total takes a coupon, clamped at 0.
write_cart_ps1() {
	cat >src/cart.ts <<'EOF'
import { type Coupon, discountOf } from "./coupon";

export interface Item {
  sku: string;
  price: number;
  qty: number;
}

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function total(items: Item[], coupon?: Coupon): number {
  const sub = subtotal(items);
  const raw = sub - (coupon ? discountOf(coupon, sub) : 0);
  return Math.round(Math.max(raw, 0) * 100) / 100;
}
EOF
}

# PS1: coupons (percent and fixed), the total takes one, prices in a currency.
write_ps1() {
	cat >src/coupon.ts <<'EOF'
export type Coupon =
  | { kind: "percent"; value: number }
  | { kind: "fixed"; value: number };

const PATTERN = /^SAVE(\d+)(%?)$/;

export function parseCoupon(code: string): Coupon | null {
  const m = PATTERN.exec(code);
  if (!m) return null;
  const value = Number(m[1]);
  return m[2] === "%" ? { kind: "percent", value } : { kind: "fixed", value };
}

export function discountOf(coupon: Coupon, subtotal: number): number {
  if (coupon.kind === "fixed") return Math.min(coupon.value, subtotal);
  return (subtotal * coupon.value) / 100;
}
EOF
	write_cart_ps1
	cat >src/format.ts <<'EOF'
export function formatPrice(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}
EOF
}

# Push 2 (appended): codes in any case, percent capped at 100, tests.
write_push2() {
	sed -i 's/  const m = PATTERN.exec(code);/  const m = PATTERN.exec(code.trim().toUpperCase());/' src/coupon.ts
	sed -i 's|  return (subtotal \* coupon.value) / 100;|  return (subtotal * Math.min(coupon.value, 100)) / 100;|' src/coupon.ts
	cat >src/coupon.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { discountOf, parseCoupon } from "./coupon";

describe("parseCoupon", () => {
  it("reads percent and fixed codes, any case", () => {
    expect(parseCoupon("SAVE10%")).toEqual({ kind: "percent", value: 10 });
    expect(parseCoupon(" save5 ")).toEqual({ kind: "fixed", value: 5 });
    expect(parseCoupon("FREE")).toBeNull();
  });
});

describe("discountOf", () => {
  it("caps a percent coupon at the subtotal", () => {
    expect(discountOf({ kind: "percent", value: 150 }, 40)).toBe(40);
  });
});
EOF
}

# The base moves on (before push 3): quantities get a formatter, below the
# lines the PR changes (a clean rebase).
write_base_move1() {
	cat >>src/format.ts <<'EOF'

export function formatQty(qty: number): string {
  return qty === 1 ? "1 item" : `${qty} items`;
}
EOF
}

# The base moves on again (before push 4): rounding by toFixed, on the very
# line the PR changed (a conflict when merged in).
write_base_move2() {
	sed -i 's|  return Math.round(raw \* 100) / 100;|  return Number(raw.toFixed(2));|' src/cart.ts
}

# The author's resolution: the PR's clamp with the base's rounding.
resolve_merge() {
	write_cart_ps1
	sed -i 's|  return Math.round(Math.max(raw, 0) \* 100) / 100;|  return Number(Math.max(raw, 0).toFixed(2));|' src/cart.ts
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "cart and prices" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_ps1)
PS1="$(commit_all "Coupons: percent and fixed discounts")"
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-showcase: re-review after an append, a rebase and a merge-in (the demo)" <<'EOF'
**The re-review demo.** One PR, reviewed, then updated three ways in a row: commits appended, a rebase onto a moved base, the base merged in with a conflict. Each update after a review is a patch set (PS1, PS2, PS3); the last push is left for you to read. Open it in carbonless on the seeding instance (the link is in the report); everything below is in Files changed unless it says otherwise.

## The tour

### 0. Where you land

Files changed opens on **PS3** (your latest patch set). The patch set graph above the files shows: the branch dot `base/rr-showcase`, PS1, PS2, PS3 and, in the last slot, the **head dot** (dashed connector, "1"): the author pushed again since you last read. A toast at the bottom says so; it never takes focus and nothing on the page moves.

*Proves:* the page loads on what you reviewed, and tells you about the push without moving anything.

### 1. PS1: the first review, read-only

Drag the **viewing** marker to PS1 (or press Ctrl+[ twice). PS1 opens **as reviewed · read-only**: every cluster ticked, the checkboxes locked, "Back to PS3" under the progress bar. Two threads you left there: `src/coupon.ts` 8 ("save10% … normalise the code first?") and `src/cart.ts` 16 ("Clamping at 0 …").

*Proves:* an earlier patch set opens exactly as you left it.

### 2. PS1 → PS2: commits appended (S1)

View PS2 with the comparison base on PS1 (Ctrl+] once, from PS1). The connector card says "1 new commit · 2 files, 2 clusters to read". The since view shows only what the author changed:
- `src/coupon.ts`: one **reworked** cluster (the file is new in the PR, so it is one cluster): its two edited lines, 8 (the code normalised) and 16 (the percent capped), show as deletions above the new lines.
- `src/coupon.test.ts`: one **new** cluster.
- `src/cart.ts`, `src/format.ts`: nothing to read: their clusters were **carried** (green, chip `carried` in the full diff: Ctrl+Shift+[ moves the comparison base to the branch).
- The thread on `coupon.ts` 8 is **changed since**: its card shows the old line above the new one, "Line rewritten since PS1 · See on PS1".
- Your comment on `coupon.test.ts` 14 ("Add the fixed coupon above the subtotal too") was made on PS2.

*Proves:* after an append you read only the author's new work; your marks follow unchanged code; a thread on a rewritten line says so instead of silently moving.

### 3. PS2 → PS3: a rebase onto a moved base (S4a)

View PS3 since PS2. The base gained `formatQty` in `src/format.ts`; the author rebased onto it with no change of their own. The connector card says "Rebased, nothing new"; the since view says **Nothing to read since PS2 · 5 carried**; the base's new lines are not the PR's and never show as yours to read. The progress bar still counts every cluster, all carried. Your thread on `src/format.ts` 2 ("Cache the Intl.NumberFormat …") was made on PS3.

*Proves:* a rebase costs nothing to re-read, and the base's changes never pose as the author's.

### 4. PS3 → head: the base merged in, with a conflict (S3)

Press **View** on the toast (or drag the viewing marker onto the head dot, or Ctrl+] past PS3). Nothing is written by looking. The connector card says "Base merged in, 1 file had conflicts · 1 file, 2 clusters to read". The base had changed the rounding line the PR changed (`src/cart.ts` 16), and the author resolved the conflict in the merge:
- `src/cart.ts` has a red **conflict** chip and **2 new**: its clusters are new to read (the resolution is the author's work); the tree dots it yellow, the other files green.
- The thread on `cart.ts` 16 is **changed since** (`Math.round(…)` → `Number(….toFixed(2))`).
- Everything else carries.

Tick a cart.ts cluster: that first mark **starts PS4** (the head dot becomes a dot; the address says `ps=4`). Untick a carried cluster anywhere: it stays unticked (your word beats a carry).

*Proves:* a merge-in shows only the conflict resolution as new; viewing is free, the first mark makes the patch set.

### 5. Final Verdict: since your verdict

Open the **Final Verdict** tab. Under "Your verdict":
- "You commented `<PS1's commit>` (PS1), … ago": the verdict you gave on PS1.
- "Since then: 3 commits · 3 files · 1 reworked, 3 new clusters" (the engine's counts, PS1 to the head: `coupon.ts` reworked, `coupon.test.ts` and `cart.ts`'s two clusters new), and once PS4 exists its meter, "x / y on PS4". A spinner holds the line while the comparison runs. The same card closes Files changed, after the last file.
- The buttons go on the head. Approve is off here only because the gallery's PRs are your own on GitHub; Comment works (it lands on GitHub and ends the since line).

For the identical-diff copy ("Rebased, same diff · nothing to re-read" with "Approve again on …"), see `rr-stacked`.

*Proves:* the verdict tab says what you approved (or said) and what changed since, from the same engine, never "nothing" while it computes.

### 6. Overview

Each thread card shows the patch set it was opened on (`PS1`, `PS2`, `PS3`) and, where the line moved under it, `changed since` with the fate line.

## Pushes

| Patch set | Commit | Shape | What the reviewer did here |
| --- | --- | --- | --- |
| PS1 | Coupons: percent and fixed discounts | first review | everything reviewed; comments on `coupon.ts` 8 and `cart.ts` 16; verdict: Comment |
| PS2 | Lowercase coupon codes; cap percent at 100 | S1, appended | the reworked and new clusters reviewed; a comment on `coupon.test.ts` 14 |
| PS3 | (rebased onto the base's `formatQty`) | S4a, rebase | one mark (nothing new); a comment on `format.ts` 2 |
| head | Merge base/rr-showcase (conflict in `cart.ts`) | S3, base merged in | left for you |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- PS1: reviewed, two comments, a verdict --------------------------------------

crb_open "$PR"
mark_view "$(review_view)"
comment "$PS1" src/coupon.ts RIGHT 8 "save10% (lowercase) doesn't match: normalise the code first?"
comment "$PS1" src/cart.ts RIGHT 16 "Clamping at 0 hides a coupon bigger than the cart: throw instead?"
verdict COMMENT "$PS1" "Two questions before I approve: lowercase codes, and the clamp."
log "PS1: $(review_view | jq -c .progress.clusters)"

# ---- push 2: appended (S1); PS2 reads the reworked and new clusters ---------------

(cd "$CLONE" && write_push2)
PS2="$(commit_all "Lowercase coupon codes; cap percent at 100")"
push_branch "case/$CASE"
wait_head "$PS2"
view="$(view_head "$PS2")"
rev="$(jq -r .revision <<<"$view")"
keys=()
while IFS= read -r k; do keys+=("$k"); done < <(keys_of src/coupon.ts <<<"$view"; keys_of src/coupon.test.ts <<<"$view")
mark "$rev" reviewed -- "${keys[@]}"
comment "$PS2" src/coupon.test.ts RIGHT 14 "Add the fixed coupon above the subtotal too."
log "PS2: $(review_view | jq -c '{patchset, progress: .progress.clusters}')"

# ---- push 3: the base moves on, the PR rebased onto it (S4a); PS3 -----------------

g checkout --quiet "base/$CASE"
(cd "$CLONE" && write_base_move1)
commit_all "Quantities: formatQty" >/dev/null
push_branch "base/$CASE"
g checkout --quiet "case/$CASE"
g rebase --quiet "base/$CASE"
PS3="$(g rev-parse HEAD)"
push_branch "case/$CASE" --force
wait_head "$PS3"
view="$(view_head "$PS3")"
key="$(keys_of src/cart.ts 1 <<<"$view")"
mark "$(jq -r .revision <<<"$view")" reviewed -- "$key"
comment "$PS3" src/format.ts RIGHT 2 "Cache the Intl.NumberFormat per currency? It's built on every call."
log "PS3: $(review_view | jq -c '{patchset, progress: .progress.clusters}')"

# ---- push 4: the base moves on again and is merged in, with a conflict (S3) --------

g checkout --quiet "base/$CASE"
(cd "$CLONE" && write_base_move2)
commit_all "Round with toFixed" >/dev/null
push_branch "base/$CASE"
g checkout --quiet "case/$CASE"
if g merge --quiet --no-edit "base/$CASE" >/dev/null 2>&1; then
	die "the merge should have conflicted"
fi
(cd "$CLONE" && resolve_merge)
g add --all
g commit --quiet --no-edit
HEAD4="$(g rev-parse HEAD)"
push_branch "case/$CASE"
wait_head "$HEAD4"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY: the head is left to view"
