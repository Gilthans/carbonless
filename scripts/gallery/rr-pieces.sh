#!/usr/bin/env bash
# Gallery case `rr-pieces`: marks per piece in the since view (shape S1).
# PS1 is reviewed in full; push 2 edits a function PS1 added in three
# places (one cluster, three pieces), merges two reviewed changes into one
# cluster that deletes more base lines and keeps one line the same as a
# reviewed PS1 line (a removal-only piece inside a PS2 cluster), and takes
# two lines PS1 added out again (a reverted piece). See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-pieces.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-pieces

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/rates.ts <<'EOF'
export interface Rate {
  currency: string;
  value: number;
}

export function parseRate(line: string): Rate {
  const [currency, value] = line.split("=");
  return { currency: currency.trim(), value: Number(value) };
}

export function formatRate(rate: Rate): string {
  const fixed = rate.value.toFixed(4);
  const padded = fixed.padStart(10, " ");
  const label = rate.currency.toUpperCase();
  const sep = " | ";
  const line = `${label}${sep}${padded}`;
  return line;
}

export function sortRates(rates: Rate[]): Rate[] {
  return [...rates].sort((a, b) => a.currency.localeCompare(b.currency));
}
EOF
}

# PS1: a validation in parseRate, formatAmount, and formatRate's body reworked
# in two changes (the formatting lines; the line it returns).
write_push1() {
	cat >src/rates.ts <<'EOF'
export interface Rate {
  currency: string;
  value: number;
}

export function parseRate(line: string): Rate {
  const [currency, value] = line.split("=");
  if (currency === undefined || value === undefined) throw new Error(line);
  if (Number.isNaN(Number(value))) throw new Error(`not a number: ${value}`);
  return { currency: currency.trim(), value: Number(value) };
}

export function formatAmount(value: number, currency: string): string {
  const digits = currency === "JPY" ? 0 : 2;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 1).toFixed(digits).slice(1);
  const symbol = currency === "EUR" ? "€" : "$";
  return `${sign}${symbol}${grouped}${cents}`;
}

export function formatRate(rate: Rate): string {
  const digits = rate.currency === "JPY" ? 2 : 4;
  const fixed = rate.value.toFixed(digits);
  const padded = fixed.padStart(12, " ");
  const label = rate.currency.toUpperCase().slice(0, 3);
  console.debug(`formatting ${label}`);
  const sep = " | ";
  const line = formatAmount(rate.value, rate.currency);
  return line;
}

export function sortRates(rates: Rate[]): Rate[] {
  return [...rates].sort((a, b) => a.currency.localeCompare(b.currency));
}
EOF
}

# Push 2: formatAmount edited at three lines; formatRate down to the line
# PS1 added (the rest of its body gone); parseRate's validation taken out.
write_push2() {
	cat >src/rates.ts <<'EOF'
export interface Rate {
  currency: string;
  value: number;
}

export function parseRate(line: string): Rate {
  const [currency, value] = line.split("=");
  return { currency: currency.trim(), value: Number(value) };
}

export function formatAmount(value: number, currency: string): string {
  const digits = currency === "JPY" || currency === "KRW" ? 0 : 2;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const cents = (abs % 1).toFixed(digits).slice(1);
  const symbol = currency === "EUR" ? "€" : "$";
  return `${sign}${grouped}${cents} ${symbol}`.trim();
}

export function formatRate(rate: Rate): string {
  const line = formatAmount(rate.value, rate.currency);
  return line;
}

export function sortRates(rates: Rate[]): Rate[] {
  return [...rates].sort((a, b) => a.currency.localeCompare(b.currency));
}
EOF
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "rates" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_push1)
commit_all "Validate rates, format amounts" >/dev/null
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-pieces: each piece of the since view marked on its own" <<'EOF'
Marks per piece (shape S1). In the since view one cluster of the head can show as several pieces, with lines unchanged since PS1 between them; each piece has its own checkbox and cross-off, as a cluster does in an ordinary review, and marks only itself. The full diff shows a partly marked cluster mixed. Open it in carbonless with PS1 reviewed (the seeding script does that), then view the head.

| Where (`src/rates.ts`) | PS1 | Push 2 | In carbonless, viewing the head since PS1 |
| --- | --- | --- | --- |
| `formatAmount` | added (10 lines, one cluster), reviewed | three lines edited (2, 6 and 9 of it) | one `reworked` cluster in **three pieces**: tick one, only it is reviewed; the full diff shows the cluster mixed (a dash, "Partly reviewed: N of M lines") with that piece's lines green; tick the other two and it is reviewed; untick one and it is mixed again |
| `formatRate`'s body | two reviewed clusters: the formatting lines replaced, and the returned line | the formatting lines and `sep` all gone, the returned line kept | the head has one cluster there (six base lines removed, the kept line added); the since view shows only removals, chipped `removed`, as that cluster's piece: ticking it reviews the cluster (its other lines are unchanged since reviewed PS1 lines) |
| `parseRate`'s validation | two lines added, reviewed | taken out (back to the base) | a piece of its own, chipped `reverted`, marked on its own; to read until marked |

Look at: the boxes and cross-offs on every piece, the chips' tooltips, `to read` dropping as pieces are marked (and staying after a reload), the full diff's mixed box and its tooltip.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- the reviewer's part: PS1 ----------------------------------------------------

crb_open "$PR"
view="$(review_view)"
[ "$(jq -r '.files | length' <<<"$view")" = 1 ] || die "expected 1 file on PS1"
mark_view "$view" reviewed
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# ---- push 2 ---------------------------------------------------------------------

(cd "$CLONE" && write_push2)
PS2="$(commit_all "Group by spaces, format rates as amounts, drop the validation")"
push_branch "case/$CASE"
log "pushed $PS2; waiting for the server to see it"
wait_head "$PS2"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY and view the head (PR #$PR)"
