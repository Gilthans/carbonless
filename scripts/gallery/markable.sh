#!/usr/bin/env bash
# Gallery case `markable`: every kind of unit the full diff shows, each to
# be marked on its own (docs/product-rules.md, "Every visible cluster is
# individually markable"): a modified line, two clusters one unchanged line
# apart, added and removed lines, a whitespace-only re-indent and a mixed
# cluster, a three-line cluster with a thread on its middle line, a lost
# final newline, and file-level changes (a rename only, a mode change, a
# binary file, an empty file). One cluster is seeded reviewed and one
# crossed off. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/markable.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=markable

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src docs bin assets
	cat >src/cache.ts <<'EOF'
export interface Entry<V> {
  value: V;
  at: number;
}

export class Cache<V> {
  private map = new Map<string, Entry<V>>();
  private ttl = 60_000;

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, at: Date.now() });
  }

  size(): number {
	return this.map.size;
  }

  clear(): void {
	this.map.clear();
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  // TODO: evict the oldest entry when full
}
EOF
	printf 'export const VERSION = "1.4";\n' >src/version.ts
	printf '# Notes\n\nThe cache keeps entries for a minute.\n' >docs/old.md
	printf '#!/bin/sh\nnode dist/cli.js "$@"\n' >bin/run.sh
	printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01' >assets/logo.png
}

write_ps1() {
	cat >src/cache.ts <<'EOF'
export interface Entry<V> {
  value: V;
  at: number;
}

export class Cache<V> {
  private map = new Map<string, Entry<V>>();
  private ttl = 30_000;

  get(key: string): V | undefined {
    const e = this.map.get(key.trim());
    if (!e) return undefined;
    if (Date.now() - e.at >= this.ttl) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, at: Date.now() });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.ttl = 30_000;
  }

  keys(): string[] {
    const out = [...this.map.keys()];
    out.sort();
    return out;
  }

}
EOF
	printf 'export const VERSION = "1.5";' >src/version.ts
	git mv docs/old.md docs/notes.md
	chmod +x bin/run.sh
	printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x02' >assets/logo.png
	: >src/empty.ts
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "cache 1.4" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_ps1)
PS1="$(commit_all "Shorter ttl, has(), sorted keys")"
push_branch "case/$CASE"
PR="$(open_pr "$CASE" "markable: every kind of unit in the full diff, each marked on its own" <<'EOF'
Every unit the full diff shows has its own reviewed box and cross-off (⊘), and using one changes that unit and nothing else on screen (the owner: "every cluster visible in the UI in any view should be individually markable"). This PR has one of every kind of unit.

| Unit | Where | What to look at |
| --- | --- | --- |
| a modified line | `src/cache.ts`: the ttl (`60_000` → `30_000`) | its own box; ticking it ticks only it |
| two clusters one unchanged line apart | `cache.ts` `get()`: `key.trim()`, then `>` → `>=` | two blocks, two boxes |
| added lines | `cache.ts`: `has()` | — |
| a removed line | `cache.ts`: the `TODO` above the closing brace | — |
| whitespace only | `cache.ts`: `size()`'s body re-indented (tab → spaces) | with Settings → Ignore whitespace on, a collapsed row "Whitespace only · 2 lines" that still has its box and ⊘ |
| mixed | `cache.ts`: `clear()` re-indented and gaining a line | the re-indent pairs quietly; one box for the cluster |
| a three-line cluster with a thread on its middle line | `cache.ts`: `keys()` | open the thread: its row sits between the cluster's lines, and the cluster keeps one box, on its first line |
| a lost final newline | `src/version.ts` | the "No newline at end of file" row belongs to the cluster; seeded crossed off (`release script appends it`) |
| a rename only | `docs/old.md` → `docs/notes.md` | a file-level row with its own box |
| a mode change | `bin/run.sh` (644 → 755) | file-level |
| a binary file | `assets/logo.png` | file-level |
| an empty file added | `src/empty.ts` | file-level |

Seeded: the ttl line reviewed; `version.ts` crossed off; a comment on `keys()`'s middle line.

Try, on desktop and on a phone, unified and side by side, Ignore whitespace off and on: tick and untick every unit, cross one off and undo; reload; each unit keeps its own state. A reviewed unit's ⊘ is off and says why on hover ("Reviewed: untick to cross off").

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- the reviewer's part --------------------------------------------------------

crb_open "$PR"
view="$(review_view)"
rev="$(jq -r .revision <<<"$view")"
[ "$(jq -r '.files | length' <<<"$view")" = 6 ] || die "expected 6 files"
ttl="$(keys_of src/cache.ts 1 <<<"$view")"
version="$(keys_of src/version.ts <<<"$view")"
mark "$rev" reviewed -- "$ttl"
mark "$rev" crossed-off "release script appends it" -- "$version"
# keys(): the middle of its three new lines.
line="$(g show "$PS1:src/cache.ts" | grep -n 'out.sort();' | cut -d: -f1)"
comment "$PS1" src/cache.ts RIGHT "$line" "Sort in place: \`[...keys].sort()\` reads better?"
log "seeded: $(review_view | jq -c .progress.clusters)"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY"
