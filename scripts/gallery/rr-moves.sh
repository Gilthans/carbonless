#!/usr/bin/env bash
# Gallery case `rr-moves`: after the review the author renames a file,
# deletes a file the PR added, extracts a function into its own file, runs
# a formatter over another and reverts a commit. Every PS1 thread lands
# somewhere: on the renamed file's line (placed), under its file with a
# fate (moved?, reverted), as changed (the formatter rewrote its line), or
# in the trailing "Not in this comparison" group (the deleted file), on PS2
# and PS3 alike. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-moves.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-moves

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/names.ts <<'EOF'
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function initials(name: string): string {
  return name.split(" ").map((p) => p[0]).join("");
}
EOF
	cat >src/widget.ts <<'EOF'
import { slugify } from "./names";

export interface Widget {
  id: string;
  title: string;
  items: string[];
  open: boolean;
}

export function create(title: string): Widget {
  return { id: slugify(title), title, items: [], open: true };
}

export function render(w: Widget): string {
  const head = `<h2 id="${w.id}">${w.title}</h2>`;
  const rows = w.items.map((i) => `<li>${i}</li>`).join("");
  const body = w.open ? `<ul>${rows}</ul>` : "";
  return `<section>${head}${body}</section>`;
}

export function toggle(w: Widget): Widget {
  return { ...w, open: !w.open };
}

export function add(w: Widget, item: string): Widget {
  return { ...w, items: [...w.items, item] };
}

export function remove(w: Widget, item: string): Widget {
  return { ...w, items: w.items.filter((i) => i !== item) };
}

export function count(w: Widget): number {
  return w.items.length;
}
EOF
	cat >src/format.ts <<'EOF'
export function money(cents: number): string {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function percent(x: number): string {
	return `${Math.round(x * 100)}%`;
}
EOF
	cat >src/flags.ts <<'EOF'
export const FLAGS = {
  darkMode: true,
  compactRows: false,
};
EOF
}

# PS1, commit 1: edits in names, widget's render and format; a poller added.
write_push1() {
	sed -i 's|    .replace(/\[^a-z0-9\]+/g, "-")|    .replace(/[^a-z0-9]+/g, "-").slice(0, 64)|' src/names.ts
	sed -i 's|  const rows = w.items.map((i) => `<li>${i}</li>`).join("");|  const rows = w.items.map((i) => `<li>${escape(i)}</li>`).join("");|' src/widget.ts
	sed -i 's|	const abs = Math.abs(cents);|	const abs = Math.abs(Math.round(cents));|' src/format.ts
	mkdir -p src/legacy
	cat >src/legacy/poller.ts <<'EOF'
export class Poller {
  private timer: ReturnType<typeof setInterval> | undefined;

  start(every: number, tick: () => void): void {
    this.timer = setInterval(tick, every);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
EOF
}

# PS1, commit 2: a flag (reverted after the review).
write_flag() {
	sed -i 's|  compactRows: false,|  compactRows: false,\n  betaSearch: true,|' src/flags.ts
}

# Push 2: names.ts renamed whole; render() extracted from widget.ts, which
# moves to src/widget/view.ts; format.ts re-indented; the poller deleted.
write_push2() {
	git mv src/names.ts src/naming.ts
	sed -i 's|from "./names"|from "./naming"|' src/widget.ts
	mkdir -p src/widget
	git mv src/widget.ts src/widget/view.ts
	sed -i 's|from "./naming"|from "../naming"|' src/widget/view.ts
	# render(): its six lines (and the blank after) leave view.ts.
	sed -i '/^export function render/,/^}$/d' src/widget/view.ts
	sed -i '/^export function create/,/^}$/{n;/^$/d}' src/widget/view.ts
	cat >src/widget/render.ts <<'EOF'
import type { Widget } from "./view";

export function render(w: Widget): string {
  const head = `<h2 id="${w.id}">${w.title}</h2>`;
  const rows = w.items.map((i) => `<li>${escape(i)}</li>`).join("");
  const body = w.open ? `<ul>${rows}</ul>` : "";
  return `<section>${head}${body}</section>`;
}
EOF
	sed -i 's/^\t/  /' src/format.ts
	git rm --quiet -r src/legacy
}

# Push 3: a small fix, so the trailing group shows on another patch set.
write_push3() {
	sed -i 's|return name.split(" ")|return name.trim().split(" ")|' src/naming.ts
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "widgets" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_push1)
commit_all "Cap slugs, escape items, round cents, a poller" >/dev/null
(cd "$CLONE" && write_flag)
FLAG="$(commit_all "Beta search flag")"
PS1="$FLAG"
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-moves: renames, a deleted file, an extracted function, a formatter, a revert (thread fates)" <<'EOF'
After the review the author moves code around. Every thread of PS1 lands somewhere and says how. Open it in carbonless with PS1 reviewed (the seeding script does that), then look at PS2 and PS3.

What happened, in order:

1. PS1 (two commits): `src/names.ts` caps slugs, `src/widget.ts` escapes items in `render()`, `src/format.ts` rounds cents, a new `src/legacy/poller.ts`, and (second commit) a `betaSearch` flag in `src/flags.ts`. The reviewer marks everything reviewed and comments on each change.
2. Push 2 (PS2): `src/names.ts` renamed to `src/naming.ts` unchanged; `render()` extracted to `src/widget/render.ts` and the rest of `src/widget.ts` moved to `src/widget/view.ts`; `src/format.ts` re-indented by a formatter (tabs to spaces); `src/legacy/poller.ts` deleted; the flag commit reverted.
3. Push 3 (PS3): a one-line fix in `src/naming.ts`.

| PS1 thread | On PS2 and PS3 |
| --- | --- |
| `names.ts` 4 (the slug cap) | placed on `src/naming.ts` 4: a rename with the line intact carries the thread (C7) |
| `widget.ts` 16 (escape in `render()`) | unplaced under `src/widget/view.ts`, fate `moved?` to `src/widget/view.ts`: the file was renamed and the line didn't follow (a candidate only: the function went to `render.ts`, which carbonless doesn't search for) |
| `format.ts` 3 (round cents) | `changed since`: the formatter rewrote the line (whitespace only); the card shows the tab-indented line above the space-indented one |
| `legacy/poller.ts` 5 | in the trailing group, `Not in this comparison`, `src/legacy/poller.ts · file deleted`, with its code from PS1; there on PS2 and on PS3 until it is resolved |
| `flags.ts` 4 (`betaSearch`) | in the trailing group too, `src/flags.ts · reverted`: after the revert the PR no longer changes `flags.ts`, so the file isn't in the comparison |

Look at: each fate's chip, icon and tooltip; the unplaced rows' original code (`PS1 · path · lines a–b`) and `near` links; dragging the `moved?` thread onto a line of `view.ts` (on the latest patch set) and reloading; resolving the poller thread on GitHub and Refresh (the trailing group goes), unresolving it (it comes back).

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
comment "$PS1" src/names.ts RIGHT 4 "64 is arbitrary: name the constant?"
comment "$PS1" src/widget.ts RIGHT 16 "Where does escape() come from? It isn't imported."
comment "$PS1" src/format.ts RIGHT 3 "Round before the sign, or -0.5 cents prints as -\$0.00."
comment "$PS1" src/legacy/poller.ts RIGHT 5 "Clear the old timer before starting a new one."
comment "$PS1" src/flags.ts RIGHT 4 "Is beta search ready to be on by default?"
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

start_patchset() {
	local head="$1" view rev first
	wait_head "$head"
	view="$(view_head "$head")"
	rev="$(jq -r .revision <<<"$view")"
	first="$(jq -r '.files[0].clusters[0].key' <<<"$view")"
	mark "$rev" reviewed -- "$first"
	log "patch set started on $head: $(review_view | jq -c '{patchset, clusters: .progress.clusters}')"
}

# ---- push 2 ---------------------------------------------------------------------

(cd "$CLONE" && write_push2)
commit_all "Rename names, extract render, format, drop the poller" >/dev/null
g revert --no-edit "$FLAG" >/dev/null
PS2="$(g rev-parse HEAD)"
push_branch "case/$CASE"
start_patchset "$PS2"

# ---- push 3 ---------------------------------------------------------------------

(cd "$CLONE" && write_push3)
PS3="$(commit_all "Trim names before taking initials")"
push_branch "case/$CASE"
start_patchset "$PS3"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY (PS3; PS2 on the rail)"
