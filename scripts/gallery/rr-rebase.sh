#!/usr/bin/env bash
# Gallery case `rr-rebase`: the base moves on and the PR is rebased, squashed,
# amended and force-pushed back (shapes S4a, S5, S1, S6). PS1 sits on the
# fork point; the base then changes a line next to a reviewed cluster (its
# context differs: still carried, P2). Each push after a mark is a patch
# set, so the graph shows them all. See README.md here.
#
#   source .envrc && pnpm build && crb serve … &   (CLAUDE.md, "Branch instance")
#   scripts/gallery/rr-rebase.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CASE=rr-rebase

# ---- the files ---------------------------------------------------------------

write_base() {
	mkdir -p src
	cat >src/store.ts <<'EOF'
export interface Link {
  slug: string;
  url: string;
  createdAt: number;
}

export class Store {
  private links = new Map<string, Link>();

  get(slug: string): Link | undefined {
    return this.links.get(slug);
  }

  put(link: Link): void {
    this.links.set(link.slug, link);
  }

  delete(slug: string): boolean {
    return this.links.delete(slug);
  }

  has(slug: string): boolean {
    return this.links.has(slug);
  }

  slugs(): string[] {
    return [...this.links.keys()];
  }

  count(): number {
    return this.links.size;
  }

  clear(): void {
    this.links.clear();
  }
}
EOF
	cat >src/app.ts <<'EOF'
import { Store } from "./store";

const store = new Store();

export function shorten(url: string): string {
  const slug = Math.random().toString(36).slice(2, 8);
  store.put({ slug, url, createdAt: Date.now() });
  return slug;
}

export function resolve(slug: string): string | null {
  const link = store.get(slug);
  return link ? link.url : null;
}

export function healthz(): { ok: boolean; links: number } {
  return { ok: true, links: store.count() };
}
EOF
	cat >README.md <<'EOF'
# shortener

Links in memory; `healthz` counts them.
EOF
}

# PS1, commit 1: links expire (store.ts).
write_ps1_store() {
	cat >src/store.ts <<'EOF'
export interface Link {
  slug: string;
  url: string;
  createdAt: number;
  ttlSeconds: number;
}

export class Store {
  private links = new Map<string, Link>();

  get(slug: string): Link | undefined {
    const link = this.links.get(slug);
    if (link && expired(link)) return undefined;
    return link;
  }

  put(link: Link): void {
    this.links.set(link.slug, link);
  }

  delete(slug: string): boolean {
    return this.links.delete(slug);
  }

  has(slug: string): boolean {
    return this.links.has(slug);
  }

  slugs(): string[] {
    return [...this.links.keys()];
  }

  count(): number {
    return [...this.links.values()].filter((l) => !expired(l)).length;
  }

  clear(): void {
    this.links.clear();
  }
}

function expired(link: Link): boolean {
  return Date.now() > link.createdAt + link.ttlSeconds * 1000;
}
EOF
}

# PS1, commit 2: the app takes a ttl (app.ts).
write_ps1_app() {
	cat >src/app.ts <<'EOF'
import { Store } from "./store";

const store = new Store();

export function shorten(url: string, ttlSeconds = 86400): string {
  if (ttlSeconds <= 0) throw new Error("ttl must be positive");
  const slug = Math.random().toString(36).slice(2, 8);
  store.put({ slug, url, createdAt: Date.now(), ttlSeconds });
  return slug;
}

export function resolve(slug: string): string | null {
  const link = store.get(slug);
  return link ? link.url : null;
}

export function healthz(): { ok: boolean; links: number } {
  return { ok: true, links: store.count() };
}
EOF
}

# The base moves on: a comment right above `get` (context of the expiry
# cluster) and a version in the README.
write_base_move() {
	python3 - <<'EOF'
import re, io
p = "src/store.ts"
s = open(p).read()
s = s.replace("  private links = new Map<string, Link>();\n\n  get(", "  private links = new Map<string, Link>();\n\n  /** The link, or undefined when none is stored. */\n  get(")
open(p, "w").write(s)
p = "README.md"
s = open(p).read()
open(p, "w").write(s + "\nVersion 1.1.\n")
EOF
}

# Push 4: a fixup after the squash: the expiry check also drops the link.
write_fixup() {
	python3 - <<'EOF'
p = "src/store.ts"
s = open(p).read()
s = s.replace("    if (link && expired(link)) return undefined;\n", "    if (link && expired(link)) {\n      this.links.delete(slug);\n      return undefined;\n    }\n")
open(p, "w").write(s)
EOF
}

# ---- the branches and the PR --------------------------------------------------

gallery_clone
case_branches_start "$CASE"
(cd "$CLONE" && write_base)
commit_all "shortener 1.0" >/dev/null
push_branch "base/$CASE"
g checkout --quiet -b "case/$CASE"
(cd "$CLONE" && write_ps1_store)
commit_all "Links expire after a ttl" >/dev/null
(cd "$CLONE" && write_ps1_app)
PS1="$(commit_all "shorten takes a ttl")"
push_branch "case/$CASE"

PR="$(open_pr "$CASE" "rr-rebase: rebased, squashed, amended and force-pushed back after a review" <<'EOF'
The base moves on after the review and the PR is rewritten four times (`docs/git-methodology.md`: the `rebase` branch update, then force-pushes). Every mark the reviewer made on PS1 is about the same change, so it carries through the rebase and the squash; the amend reworks one cluster; the force-push back moves the head back to a patch set. Open it in carbonless with the patch sets seeded (the seeding script does that), then look at each connector of the graph.

What happened, in order:

1. PS1: two commits on the fork point (`Links expire after a ttl`, `shorten takes a ttl`): six clusters over `src/store.ts` and `src/app.ts`, all reviewed, one comment.
2. The base moved on: a doc comment right above `get` (inside the context of the expiry cluster) and a version line in the README.
3. Push 2: a trivial rebase onto it (S4a). The reviewer's first mark on the head starts PS2.
4. Push 3: the two commits squashed into one, the same tree (S5). PS3.
5. Push 4: a fixup commit on top: `get` also drops an expired link (S1, one cluster reworked). PS4.
6. Push 5: force-pushed back to push 3's head (S6): the head is an ancestor of PS4's.

| Connector | Card | Viewing that head since the patch set before |
| --- | --- | --- |
| PS1 → PS2 | `Rebased, nothing new` | nothing to read, 6 carried (P2: the base's comment is context, the expiry cluster still carries) |
| PS2 → PS3 | `Squashed, nothing new` | nothing to read, 6 carried (P9); one carried from PS2 (the mark that started it), the rest from PS1 |
| PS3 → PS4 | `1 new commit · 1 file, 1 cluster to read` | `get` reworked; the other five carried |
| PS4 → head | `Head moved back` | nothing to read: the amended cluster is back to its PS3 content, carried from PS1 |

Look at: the graph with four patch sets and the head dot, each connector's card on hover (the shape's one line), the dots' cards (what each patch set was reviewed against: the merge base changes at PS2), going back to PS1 (read-only, as reviewed, the base's comment absent), and the comparison base moving between any two dots (PS1 → PS4 is the interdiff across every rewrite).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# ---- PS1 --------------------------------------------------------------------------

crb_open "$PR"
view="$(review_view)"
rev="$(jq -r .revision <<<"$view")"
[ "$(jq -r '.files | length' <<<"$view")" = 2 ] || die "expected 2 files on PS1"
all=()
while IFS= read -r k; do all+=("$k"); done < <(jq -r '.files[].clusters[].key' <<<"$view")
mark "$rev" reviewed -- "${all[@]}"
comment "$PS1" src/store.ts RIGHT 13 "Should an expired link also be dropped from the map, or do we keep it for the count?"
log "PS1 reviewed: $(review_view | jq -c .progress.clusters)"

# Marks the first cluster of the viewed head reviewed: the patch set starts
# with the engine's carries (everything else carried).
start_patchset() {
	local head="$1" view rev first
	wait_head "$head"
	view="$(view_head "$head")"
	rev="$(jq -r .revision <<<"$view")"
	first="$(jq -r '.files[0].clusters[0].key' <<<"$view")"
	mark "$rev" reviewed -- "$first"
	log "patch set started on $head: $(review_view | jq -c '{patchset, clusters: .progress.clusters}')"
}

# ---- the base moves on; push 2: a trivial rebase (S4a) -------------------------------

g checkout --quiet "base/$CASE"
(cd "$CLONE" && write_base_move)
commit_all "Document get; version 1.1" >/dev/null
push_branch "base/$CASE"
g checkout --quiet "case/$CASE"
g rebase --quiet "base/$CASE"
push_branch "case/$CASE" --force
start_patchset "$(g rev-parse HEAD)"

# ---- push 3: the two commits squashed into one (S5) -------------------------------------

g reset --quiet --soft "base/$CASE"
PS3="$(commit_all "Links expire after a ttl; shorten takes one")"
push_branch "case/$CASE" --force
start_patchset "$PS3"

# ---- push 4: a fixup commit on top (S1) ------------------------------------------------

(cd "$CLONE" && write_fixup)
PS4="$(commit_all "fixup: drop an expired link on get")"
push_branch "case/$CASE"
start_patchset "$PS4"

# ---- push 5: force-pushed back to push 3's head (S6) ----------------------------------

g reset --quiet --hard "$PS3"
push_branch "case/$CASE" --force
wait_head "$PS3"
log "done: open $REVIEW_URL/files?key=$REVIEW_KEY; the head is back on push 3"
