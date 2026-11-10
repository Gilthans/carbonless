# PR Review Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `crb <PR>` opens a GitHub PR in the browser with a PR overview and a GitHub-like "Files changed" view where the reviewer checks off change clusters, with progress stored as events in local git refs.

**Architecture:** A Fastify server owns everything that touches git or `gh`: a private bare clone per repo, the diff model (files, clusters, identities, display hunks), the review store (append-only events in `refs/crb/` commits) and the coverage join that turns clusters + stored states into progress. The React app only renders what the server returns and posts reviewer actions back. Files load lazily: the summary endpoint never reads blobs, a file's hunks load when it's expanded.

**Tech Stack:** Node 24, TypeScript 7, Fastify 5 (+ `@fastify/static`, `@fastify/cookie`), git CLI, `gh` CLI, React 19, TanStack Query (all server state, mutations, invalidation), TanStack Router (pages), TanStack Form (forms), TanStack Virtual (only if long diffs need it), Tailwind 4, Shiki, `react-markdown` + `remark-gfm`, `ulid`, Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-10-21-pr-review-parity-design.md`, with the storage subset described there and detailed in `docs/review-data-storage.md` (principles: `docs/gitdb-design-principles.md`). Read all three before starting.

## Global Constraints

- CLI binary is `crb` (`package.json` `bin: { "crb": "dist/cli.js" }`). Inputs: `crb https://github.com/<owner>/<repo>/pull/<n>`, `crb <owner>/<repo>#<n>`, `crb <n>` (repo from `gh repo view` in the cwd). The seed's `[repo] [base] [head]` mode is removed.
- Read-only towards GitHub: only `gh pr view`, `gh api graphql` (queries), `gh api user`, `gh repo view`, `gh repo clone`, `gh auth status`. Nothing is ever pushed.
- Never touch the reviewer's working copies. All git work happens in `$XDG_CACHE_HOME/carbonless/repos/<owner>/<repo>.git` (default `~/.cache/carbonless/...`), a bare clone.
- Fetches run as `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' fetch ...` so they use the `gh` login.
- Every diff command pins its options so user git config can't change results: `git -c core.quotePath=false -c diff.renames=true diff --no-color --no-ext-diff --no-textconv --diff-algorithm=myers -M --ignore-submodules=none`.
- Comparison = `merge-base(origin/<base>, head)` → `head`.
- Only refs under `refs/crb/` are carbonless's. Ref layout: `refs/crb/reviews/<review-id>/meta`, `refs/crb/reviews/<review-id>/reviewers/<slug>/progress`, `refs/crb/reviews/<review-id>/reviewers/<slug>/patchsets/<n>`, `refs/crb/lookup/github-pr/<sha256-hex of "<owner>/<repo>#<n>">`. Owner and repo lowercased in the key.
- crb commits: empty tree (`git hash-object -w -t tree /dev/null`, never hard-coded), author `<slug> <slug@crb>`, committer `crb <crb@crb>` via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars, never git config. Message: one summary line, blank line, one JSON event per line. Linear history, one event per commit.
- Every ref update is compare-and-swap (`git update-ref <ref> <new> <old>`, zero OID for create); multi-ref updates go through one `git update-ref --stdin` transaction.
- Events: `{ v: 1, id: <lowercase ULID>, type, ts: <ms epoch>, by: "human" | "ai", actor: <slug>, details?: object }`. Readers skip unknown `type`/`v`, ignore unknown `details` keys, and drop any `cluster-state` whose `by` isn't `"human"`.
- Reviewer slug: GitHub login lowercased, characters outside `[a-z0-9-]` replaced by `-`, max 64 chars.
- Coverage invariant (CLAUDE.md principle 2): clusters come only from the git diff; a cluster with no stored state is `unreviewed`; a stored state with no matching cluster is ignored. Only the server computes progress.
- Progress percentage = `reviewed ÷ (total − crossedOff)`; when the denominator is 0 show 100%.
- Every file in Files changed starts collapsed. Unified view only. 3 context lines. Expand steps of 20 lines.
- Non-loopback `--host` requires a per-launch random access key (`?key=`, then an HttpOnly SameSite=Strict cookie `crb_key`); every request, API and static, checks it.
- Never copy code or data from `gytpol/active-directory-domain-agent` into this repo, tests or fixtures. All `gh` JSON fixtures are synthetic.
- `pnpm verify` must pass at the end of every task.
- Web UI uses the TanStack family wherever it fits (reviewer's preference): TanStack Query for every server read and write (`useQuery`/`useMutation`, invalidate on success, no hand-rolled fetch state), TanStack Router for pages, TanStack Form for forms. Don't add TanStack Table/Start.

## Review Focus

1. **Paths with spaces, unicode or quotes** (`src/my file.ts`, `docs/über.md`) must list, diff and expand correctly. Test in Task 1.
2. **A stale tab writes after the snapshot changed** (Refresh moved an unpinned review to a new head, or another tab started a patch set): the server rejects the write with 409 and the UI reloads, never storing a state against the wrong snapshot. Test in Task 4 and Task 7.
3. **Two writers at once** (two tabs checking clusters simultaneously): compare-and-swap retries and both events survive. Test in Task 3.
4. **Corrupt or foreign data in a progress ref** (bad JSON line, `cluster-state` with `by: "ai"`, a key for a cluster that doesn't exist): ignored, coverage can only look less complete. Test in Task 4.
5. **`gh` missing, logged out, or the PR doesn't exist**: the CLI exits 1 with a one-line message naming the problem, before starting the server. Test in Task 5 and Task 8.

---

## File Structure

```
src/cli.ts                       crb entry: parse args, startup sequence, listen, print URL
src/shared/types.ts              API types shared by server and web (replaced wholesale)
src/server/git.ts                runGit (extended with env/input/allowFailure), GitError
src/server/gh.ts                 runGh, GhError, prRef parsing, PR metadata + overview fetch, viewer slug
src/server/overview.ts           pure mapping: gh JSON -> PrOverview
src/server/clone.ts              private clone path, repo lock, ensureClone, fetchPr, mergeBase
src/server/diff/files.ts         listChangedFiles: raw + numstat -> ChangedFile[]
src/server/diff/clusters.ts      parseU0Patch, fileLevelCluster, buildClusters
src/server/diff/identity.ts      contextAround, clusterKeys
src/server/diff/hunks.ts         buildDisplayHunks, contextLines
src/server/diff/snapshot.ts      buildSnapshot (summary, no blobs) + loadFileHunks (lazy)
src/server/review/events.ts      event types, newEvent, parseEventLines, serializeCommitMessage
src/server/review/refStore.ts    RefStore: emptyTree, appendEvent (CAS + retry), transaction, readEvents
src/server/review/fold.ts        foldProgress(events) -> ProgressState
src/server/review/reviews.ts     ReviewService: findOrCreateReview, getProgress, recordStates
src/server/review/coverage.ts    buildReviewView(snapshot, progressState) -> ReviewView
src/server/session.ts            Session: current PR, snapshot selection, refresh, head-moved check
src/server/access.ts             access-key hook
src/server/app.ts                Fastify routes (replaced wholesale)
src/web/App.tsx                  tabs: Overview | Files changed, moved-head banner, refresh
src/web/api.ts                   typed fetchers + mutations
src/web/overview/OverviewPage.tsx
src/web/files/FilesPage.tsx      layout: sticky ProgressBar, FileTree, FileDiff list
src/web/files/ProgressBar.tsx
src/web/files/FileTree.tsx
src/web/files/FileDiff.tsx       collapsed header, lazy hunks, cluster rail + checkbox, expand rows
src/web/files/highlight.ts       Shiki setup + extension -> language map
test/git-fixture.ts              (extended) commits with renames, modes, binary, submodules, deletes
test/fake-gh/gh                  fake gh executable for e2e (node script)
test/fixtures/gh/*.json          synthetic gh responses
e2e/fixtures.ts                  (rewritten) fixture repo + fake gh scenario + start crb
e2e/*.spec.ts                    overview, files, persistence, moved head
```

Delete with the old mode: `src/server/app.test.ts` (rewritten), `src/web/App.test.tsx` (rewritten), `e2e/comparison.spec.ts`, `getCommit`/`resolveRepoRoot` in `src/server/git.ts` and their tests once unused.

## Shared types (`src/shared/types.ts`)

Define these in Task 1 (diff types), Task 4 (review types) and Task 5 (overview types); every later task uses them as written.

```ts
export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "type-changed";
export type ClusterState = "unreviewed" | "reviewed" | "crossed-off";

export interface Cluster {
	key: string;                 // identity, see Task 2
	kind: "lines" | "file";
	label?: string;              // file-level only, e.g. "Renamed from a/x.cs"
	oldStart: number; oldCount: number; newStart: number; newCount: number; // 0s for file-level
	removed: string[]; added: string[];
	lines: number;               // removed.length + added.length (0 for file-level)
}
export interface FileSummary {
	index: number; path: string; oldPath?: string; status: FileStatus;
	oldMode?: string; newMode?: string; binary: boolean; submodule: boolean;
	additions: number; deletions: number; clusters: Cluster[];
}
export interface Snapshot { base: string; head: string; revision: string; files: FileSummary[] }

export interface DiffLine { kind: "context" | "add" | "del"; oldNo?: number; newNo?: number; text: string; clusterKey?: string }
export interface DisplayHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }
export interface FileHunks { hunks: DisplayHunk[]; newLineCount: number }

export interface ClusterView extends Cluster { state: ClusterState; reason?: string }
export interface FileView extends Omit<FileSummary, "clusters"> { clusters: ClusterView[]; done: boolean; crossedOff: boolean }
export interface Counts { total: number; reviewed: number; crossedOff: number }
export interface Progress { clusters: Counts; lines: Counts; files: Counts & { done: number } }
export interface ReviewView { revision: string; patchset: number | null; files: FileView[]; progress: Progress }
export interface StateChange { key: string; state: ClusterState; reason?: string }

export interface SessionInfo {
	pr: { owner: string; repo: string; number: number; title: string; url: string };
	viewer: string;               // slug
	snapshotHead: string; currentHead: string; headMoved: boolean; patchset: number | null;
}
// PrOverview: see Task 5.
```

---

### Task 1: Changed files and line clusters

**Files:**
- Modify: `src/server/git.ts`, `test/git-fixture.ts`, `src/shared/types.ts`
- Create: `src/server/diff/files.ts`, `src/server/diff/clusters.ts`
- Test: `src/server/diff/files.test.ts`, `src/server/diff/clusters.test.ts`

**Interfaces:**
- Produces:
  - `runGit(repoPath: string, args: string[], opts?: { env?: Record<string,string>; input?: string; allowFailure?: boolean }): Promise<string>` (`allowFailure` returns `""` on non-zero exit instead of throwing).
  - `DIFF_ARGS: string[]` (the pinned options from Global Constraints) exported from `files.ts`.
  - `listChangedFiles(repo: string, base: string, head: string): Promise<ChangedFile[]>` where `ChangedFile = Omit<FileSummary, "index" | "clusters"> & { oldOid: string; newOid: string }`.
  - `parseU0Patch(patch: string): LineCluster[]` where `LineCluster = Omit<Cluster, "key" | "kind" | "label"> & { noNewlineOld?: boolean; noNewlineNew?: boolean }`.
  - `fileLevelCluster(file: ChangedFile, hasLineClusters: boolean): Omit<Cluster, "key"> | null`.
  - `buildClusters(repo: string, base: string, head: string, file: ChangedFile): Promise<Omit<Cluster, "key">[]>` (file-level cluster first, then line clusters in file order; submodules and binary files get no line clusters).
  - `createGitFixture` gains per-commit options: `delete?: string[]`, `rename?: Record<string,string>`, `chmod?: Record<string,"755"|"644">`, `binary?: Record<string, Uint8Array>`, `submodule?: Record<string,string>` (path → commit SHA, written with `git update-index --add --cacheinfo 160000,<sha>,<path>`).

- [ ] **Step 1: Write failing tests**

`clusters.test.ts` (pure, no git):
```ts
it("splits changes separated by one unchanged line into two clusters", () => {
	const patch = "@@ -3 +3 @@\n-a\n+A\n@@ -5,0 +6,2 @@\n+x\n+y\n";
	expect(parseU0Patch(patch)).toEqual([
		{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, removed: ["a"], added: ["A"], lines: 2 },
		{ oldStart: 5, oldCount: 0, newStart: 6, newCount: 2, removed: [], added: ["x", "y"], lines: 2 },
	]);
});
it("records missing trailing newline", () => {
	const [c] = parseU0Patch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n");
	expect(c).toMatchObject({ noNewlineOld: true, removed: ["a"], added: ["a"] });
});
it.each([
	[{ status: "renamed", oldPath: "a.ts", path: "b.ts" }, false, "Renamed from a.ts"],
	[{ status: "modified", oldMode: "100644", newMode: "100755" }, false, "Mode changed 100644 → 100755"],
	[{ status: "modified", binary: true }, false, "Binary file changed"],
	[{ status: "added", binary: false, additions: 0 }, false, "Empty file added"],
	[{ status: "deleted", binary: false, deletions: 0 }, false, "Empty file deleted"],
	[{ status: "modified", submodule: true, oldOid: "a".repeat(40), newOid: "b".repeat(40) }, false, "Submodule moved aaaaaaa → bbbbbbb"],
])("file-level cluster %#", (partial, hasLines, label) => { /* build ChangedFile defaults + partial */ expect(fileLevelCluster(file, hasLines)?.label).toBe(label) });
it("a rename with edits keeps the rename cluster", () => { expect(fileLevelCluster(renamedFile, true)?.label).toBe("Renamed from a.ts") });
it("a plain edit has no file-level cluster", () => { expect(fileLevelCluster(modifiedFile, true)).toBeNull() });
```
`files.test.ts` (git fixtures): one fixture whose head commit modifies, adds, deletes, renames-with-edit, chmods, adds a binary, bumps a submodule pointer, adds an empty file, and touches `dir/my file.ts` and `docs/über.md`. Assert `listChangedFiles` returns each with the right `status`, `oldPath`, modes, `binary`, `submodule`, `additions`/`deletions`, and exact unicode/space paths. Then assert `buildClusters` gives: rename-with-edit → `["file","lines"]` kinds; binary → one file cluster; submodule → one file cluster and no lines cluster; empty add → one file cluster.

- [ ] **Step 2: Run** `pnpm vitest run src/server/diff` — expect FAIL (modules missing).

- [ ] **Step 3: Implement.** `listChangedFiles` runs `git diff --raw -z --no-abbrev` and `git diff --numstat -z` (both with `DIFF_ARGS`) and zips them by order. Raw records: `:<oldmode> <newmode> <oldoid> <newoid> <status>\0<path>\0[<newpath>\0]`; numstat: `<add>\t<del>\t<path>\0` or `<add>\t<del>\t\0<old>\0<new>\0` for renames; `-\t-` means binary. Status letters: `A`, `D`, `M`, `R<score>`, `T`. Mode `160000` on either side → `submodule: true`. `buildClusters` runs `git diff -U0 <DIFF_ARGS> <base> <head> -- <oldPath> <path>` for one file (skip for binary/submodule).

- [ ] **Step 4: Run** `pnpm vitest run src/server/diff` — expect PASS. Run `pnpm verify` — PASS.

- [ ] **Step 5: Commit** `git commit -m "feat: list changed files and extract change clusters"`

---

### Task 2: Cluster identity, display hunks, context lines

**Files:**
- Create: `src/server/diff/identity.ts`, `src/server/diff/hunks.ts`, `src/server/diff/snapshot.ts`
- Test: `src/server/diff/identity.test.ts`, `src/server/diff/hunks.test.ts`, `src/server/diff/snapshot.test.ts`

**Interfaces:**
- Consumes: Task 1 (`listChangedFiles`, `buildClusters`, `runGit`).
- Produces:
  - `contextAround(newLines: string[], c: { newStart: number; newCount: number }): { before: string[]; after: string[] }` — up to 3 unchanged new-side lines before and after. For a pure deletion (`newCount === 0`) git's `newStart` is the line *after which* the deletion sits: before = lines `newStart-2..newStart`, after = `newStart+1..newStart+3`. Otherwise before = `newStart-3..newStart-1`, after = `newStart+newCount..newStart+newCount+2`. Clamp to the file. Deleted files: both empty.
  - `clusterKeys(path: string, clusters: Omit<Cluster,"key">[], newLines: string[]): string[]` — sha256 hex of `JSON.stringify([path, kind, label ?? null, removed, added, before, after])`; the 2nd, 3rd… cluster in the snapshot with the same hash gets `<hash>:2`, `<hash>:3` (occurrence in file order).
  - `buildDisplayHunks(oldLines: string[], newLines: string[], clusters: Cluster[], context = 3): DisplayHunk[]` — expand each line cluster by `context` unchanged new-side lines each way, merge expansions that touch or overlap (that reproduces git: clusters ≤ 6 unchanged lines apart share a hunk). Unchanged line old number = new number − (added − removed of all clusters above it). Changed lines carry `clusterKey`.
  - `contextLines(oldLines: string[], newLines: string[], clusters: Cluster[], newFrom: number, newTo: number): DiffLine[]` — context-kind lines for a new-side range, same old-number mapping, clamped.
  - `buildSnapshot(repo: string, base: string, head: string): Promise<Snapshot>` — files in raw-diff order with clusters and keys; `revision = sha256(base + "\0" + head)`. Reads blobs only to compute keys (new side via `git cat-file --batch`, one process for all files).
  - `loadFileHunks(repo: string, snapshot: Snapshot, index: number): Promise<FileHunks>` and `loadContext(repo, snapshot, index, newFrom, newTo): Promise<DiffLine[]>`, caching blob contents by OID in an in-memory `Map` (max 200 entries, drop oldest).

- [ ] **Step 1: Write failing tests**

`hunks.test.ts`, the spec's `Program.cs` shape with synthetic content: a 120-line file with five clusters at new lines 8, 84, 94, 118–119, 122–126 (the 4th and 5th separated by 2 unchanged lines):
```ts
it("five clusters become four GitHub hunks", () => {
	const hunks = buildDisplayHunks(oldLines, newLines, clusters);
	expect(hunks).toHaveLength(4);
	expect(hunks[3].lines.filter(l => l.clusterKey).map(l => l.clusterKey)).toEqual(expect.arrayContaining([clusters[3].key, clusters[4].key]));
	expect(hunks[0]).toMatchObject({ oldStart: 5, newStart: 5 });
});
it("context lines map old numbers through earlier clusters", () => {
	expect(contextLines(oldLines, newLines, clusters, 20, 21)).toEqual([
		{ kind: "context", oldNo: 19, newNo: 20, text: newLines[19] },
		{ kind: "context", oldNo: 20, newNo: 21, text: newLines[20] },
	]);
});
```
`identity.test.ts`:
```ts
it("identical clusters in one file get distinct keys", () => { /* two "+}" clusters with identical 3-line context */ expect(new Set(keys).size).toBe(2); expect(keys[1]).toBe(`${keys[0]}:2`) });
it("same change with different context gets a different key", ...);
it("key is stable across calls", ...);
it("pure deletion context uses the line before as the anchor", () => expect(contextAround(lines, { newStart: 5, newCount: 0 })).toEqual({ before: lines.slice(2, 5), after: lines.slice(5, 8) }));
```
`snapshot.test.ts` (git fixture): `buildSnapshot` returns every file from Task 1's fixture, every cluster has a key, `revision` is 64 hex chars and identical across two calls; `loadFileHunks` for `dir/my file.ts` returns hunks whose changed lines carry the cluster keys from the snapshot.

- [ ] **Step 2: Run** `pnpm vitest run src/server/diff` — FAIL.
- [ ] **Step 3: Implement** the signatures above.
- [ ] **Step 4: Run** `pnpm vitest run src/server/diff` — PASS; `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: cluster identity, display hunks and context lines"`

---

### Task 3: Event format and ref store

**Files:**
- Create: `src/server/review/events.ts`, `src/server/review/refStore.ts`
- Test: `src/server/review/events.test.ts`, `src/server/review/refStore.test.ts`
- Modify: `package.json` (add `ulid`)

**Interfaces:**
- Consumes: `runGit` with `env`/`input`.
- Produces:
  - Event types (discriminated union `CrbEvent`):
    - `review-created`: `{ source: "github-pr"; key: string; pr: { owner; repo; number; url; baseBranch; headBranch; headRepo } }`
    - `patchset-started`: `{ patchset: number; revision: string; mergeBase: string; head: string }`
    - `cluster-state`: `{ patchset: string /* revision */; cluster: string; path: string; state: ClusterState; reason?: string }`
    - `review-closed`: parsed and validated only, never written in this milestone.
  - `newEvent<T extends CrbEvent["type"]>(type: T, actor: string, payload, by: "human" | "ai" = "human"): CrbEvent` (fills `v: 1`, lowercase ULID `id`, `ts: Date.now()`).
  - `validateForWrite(e: CrbEvent): void` — throws if `cluster-state` has `by !== "human"`.
  - `serializeCommitMessage(summary: string, events: CrbEvent[]): string` and `parseEventLines(message: string): CrbEvent[]` (skips the summary line, invalid JSON, unknown types, `v !== 1`, and fails safe on `cluster-state` with `by !== "human"`).
  - `class RefStore { constructor(repo: string); emptyTree(): Promise<string>; readEvents(ref: string): Promise<CrbEvent[]>; tip(ref: string): Promise<string | null>; appendEvent(ref: string, summary: string, event: CrbEvent, author: string): Promise<string /* new tip */>; transaction(updates: { ref: string; newOid: string; oldOid: string | null }[]): Promise<void>; commit(parent: string | null, summary: string, events: CrbEvent[], author: string): Promise<string>; writeBlob(content: string): Promise<string> }`
  - `appendEvent` = read tip → `commit` on it → `update-ref ref new old`; on CAS failure re-read the tip and retry (max 5 tries) — the event is re-committed onto the new tip unchanged.
  - `readEvents` = `git log -z --format=%B <ref>` (empty array when the ref doesn't exist).

- [ ] **Step 1: Write failing tests**

`events.test.ts`:
```ts
it("round-trips events through a commit message", ...);
it("skips unknown types and versions", () => expect(parseEventLines(msg([{ ...ev, type: "future" }, { ...ev, v: 2 }, ev]))).toEqual([ev]));
it("skips invalid JSON lines", ...);
it("drops cluster-state written by ai on read", ...);
it("refuses to write cluster-state by ai", () => expect(() => validateForWrite(newEvent("cluster-state", "dan", payload, "ai"))).toThrow());
```
`refStore.test.ts` (throwaway bare repo):
```ts
it("commits carry only slug and tool identities", async () => {
	// repo-local config with user.email = real@example.com
	const tip = await store.appendEvent(ref, "crb: test", ev, "dan");
	expect(await runGit(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", tip])).toBe("dan <dan@crb>|crb <crb@crb>\n");
});
it("uses the empty tree", ...);  // git cat-file -p <tip>^{tree} is empty
it("concurrent appends keep every event", async () => {
	await Promise.all(Array.from({ length: 10 }, (_, i) => store.appendEvent(ref, "s", evN(i), "dan")));
	expect((await store.readEvents(ref)).map(e => e.id).sort()).toEqual(ids.sort());
	expect(await runGit(repo, ["rev-list", "--merges", ref])).toBe("");
});
it("transaction fails as a whole when one old value is stale", ...);
it("reads nothing from a missing ref", ...);
```

- [ ] **Step 2: Run** `pnpm vitest run src/server/review` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: crb event format and compare-and-swap ref store"`

---

### Task 4: Reviews, patch sets and the coverage join

**Files:**
- Create: `src/server/review/fold.ts`, `src/server/review/reviews.ts`, `src/server/review/coverage.ts`
- Modify: `src/shared/types.ts` (review types)
- Test: `src/server/review/fold.test.ts`, `src/server/review/reviews.test.ts`, `src/server/review/coverage.test.ts`

**Interfaces:**
- Consumes: Task 2 `Snapshot`, Task 3 `RefStore`, event types.
- Produces:
  - `interface ProgressState { patchset: { number: number; revision: string; mergeBase: string; head: string } | null; states: Map<string /* cluster key */, { state: ClusterState; reason?: string }> }`
  - `foldProgress(events: CrbEvent[]): ProgressState` — dedupe by `id`, sort by `(ts, id)`, latest `patchset-started` is the patch set, last `cluster-state` per cluster wins, only states whose `patchset` equals the patch set's revision count.
  - `class ReviewService { constructor(store: RefStore); findOrCreateReview(pr: PrRefFull, actor: string): Promise<string /* review id */>; getProgress(reviewId: string, slug: string): Promise<ProgressState>; recordStates(reviewId: string, slug: string, snapshot: Snapshot, changes: StateChange[]): Promise<ProgressState> }` where `PrRefFull` is Task 5's `PrMeta` subset `{ owner; repo; number; url; baseBranch; headBranch; headRepo }`.
  - `findOrCreateReview`: read `refs/crb/lookup/github-pr/<sha256("<owner>/<repo>#<n>" lowercased owner/repo)>`; if absent, new ULID id, write the id blob and a `review-created` commit, create both refs in one transaction with zero old OIDs; if that transaction loses a race, re-read the lookup ref.
  - `recordStates`: throws `UnknownClusterError` for any key not in `snapshot`; throws `StaleSnapshotError` if a patch set exists and its revision ≠ `snapshot.revision`. With no patch set: one transaction creates the progress commit holding `patchset-started` (`patchset: 1`, the snapshot's revision/base/head) and `refs/.../patchsets/1` pointing at `snapshot.head`; then one `appendEvent` per change. Commit summary: `crb: reviewed|crossed off|reset <n> cluster(s) in <path>` (builder's call on wording).
  - `buildReviewView(snapshot: Snapshot, progress: ProgressState): ReviewView` — the coverage join. File `done` = every cluster reviewed or crossed off; `crossedOff` = every cluster crossed off; files with zero clusters can't exist (Task 1 guarantees ≥1).
  - Errors map to HTTP in Task 7: `UnknownClusterError` → 400, `StaleSnapshotError` → 409.

- [ ] **Step 1: Write failing tests**

`coverage.test.ts`:
```ts
it("clusters without a stored state are unreviewed", ...);
it("a stored state for a cluster not in the snapshot is ignored", () => { /* states has "ghost" key */ expect(view.progress.clusters).toEqual({ total: 3, reviewed: 1, crossedOff: 0 }) });
it("progress counts lines and files", () => expect(view.progress).toEqual({
	clusters: { total: 4, reviewed: 2, crossedOff: 1 },
	lines: { total: 30, reviewed: 12, crossedOff: 5 },
	files: { total: 3, reviewed: 1, crossedOff: 1, done: 2 },
}));
```
(`files.reviewed` = done files that aren't fully crossed off.)

`fold.test.ts`:
```ts
it("is independent of event order and duplicates", () => expect(foldProgress(shuffle([...evs, ...evs]))).toEqual(foldProgress(evs)));
it("last event per cluster wins", ...);
it("ignores states recorded against another revision", ...);
```
`reviews.test.ts` (throwaway bare repo + Task 2 snapshot):
```ts
it("finds the same review for the same PR, ignoring owner/repo case", ...);
it("first state starts patch set 1 and pins its head", async () => {
	await svc.recordStates(id, "dan", snap, [{ key: k1, state: "reviewed" }]);
	expect(await runGit(repo, ["rev-parse", `refs/crb/reviews/${id}/reviewers/dan/patchsets/1`])).toBe(`${snap.head}\n`);
	expect((await svc.getProgress(id, "dan")).patchset?.number).toBe(1);
});
it("rejects unknown cluster keys", ...);
it("rejects writes against a different snapshot once a patch set exists", () => expect(svc.recordStates(id, "dan", otherSnap, ch)).rejects.toBeInstanceOf(StaleSnapshotError));
it("a progress ref with a bad line and an ai cluster-state only loses those", async () => { /* append raw commit via store.commit + update-ref */ expect(view.progress.clusters.reviewed).toBe(1) });
it("the pinned head survives a force-push and gc", async () => { /* fixture: rewrite head branch, git gc --prune=now in the bare repo */ await expect(runGit(repo, ["cat-file", "-e", snap.head])).resolves.toBe("") });
```

- [ ] **Step 2: Run** `pnpm vitest run src/server/review` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: reviews, patch sets and the coverage join"`

---

### Task 5: GitHub data through gh

**Files:**
- Create: `src/server/gh.ts`, `src/server/overview.ts`, `test/fixtures/gh/pr-view.json`, `test/fixtures/gh/review-threads.json`
- Modify: `src/shared/types.ts` (overview types)
- Test: `src/server/gh.test.ts`, `src/server/overview.test.ts`

**Interfaces:**
- Produces:
  - `class GhError extends Error {}`; `runGh(args: string[], opts?: { cwd?: string }): Promise<string>` — spawns `gh` (honors `PATH`, so tests can substitute a fake). Missing binary → `GhError("gh is not installed. Install it from https://cli.github.com")`; `gh auth status` failing → `GhError("gh is not logged in. Run: gh auth login")`.
  - `parsePrArg(arg: string): { owner: string; repo: string; number: number } | { number: number }` — accepts the three CLI forms; anything else throws `GhError("Not a PR: <arg>. Use a PR URL, owner/repo#123 or a number")`.
  - `resolvePrRef(arg: string, cwd: string): Promise<PrRef>` — bare numbers use `gh repo view --json nameWithOwner` in `cwd`.
  - `viewerSlug(): Promise<string>` — `gh api user`, slug rule from Global Constraints.
  - `interface PrMeta { owner; repo; number; url; title; baseBranch; headBranch; headRepo: string /* owner/repo */; headOid: string; state: "OPEN"|"CLOSED"|"MERGED" }`; `fetchPrMeta(ref: PrRef): Promise<PrMeta>` — `gh pr view <n> -R <owner>/<repo> --json number,title,url,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner`. Not found → `GhError("PR <owner>/<repo>#<n> not found")`.
  - `fetchOverview(ref: PrRef, viewer: string): Promise<PrOverview>` — `gh pr view ... --json number,title,url,author,body,state,isDraft,createdAt,updatedAt,baseRefName,headRefName,mergeable,reviewRequests,reviews,comments,statusCheckRollup` plus `gh api graphql` for `reviewThreads(first:100){ nodes { isResolved isOutdated path line comments(first:100){ totalCount nodes { author { login __typename } body createdAt } } } }`, then `mapOverview`.
  - `mapOverview(view: unknown, threads: unknown, viewer: string): PrOverview` in `overview.ts` (pure):
    ```ts
    interface PrOverview {
      title: string; number: number; url: string; author: string; body: string; isDraft: boolean;
      state: "OPEN" | "CLOSED" | "MERGED"; createdAt: string; updatedAt: string; baseBranch: string; headBranch: string;
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
      requestedReviewers: { name: string; team: boolean }[];
      reviews: { author: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"; submittedAt: string; you: boolean }[]; // latest per author, newest first
      commenters: { author: string; lastAt: string; bot: boolean; you: boolean }[];
      humanStarted: boolean;   // any review or comment by a non-bot who is neither the PR author nor the viewer
      checks: { name: string; status: "failing" | "pending" | "passing"; url?: string }[]; // failing, pending, passing
      threads: { path: string; line: number | null; excerpt: string; author: string; bot: boolean; hasReply: boolean; outdated: boolean }[]; // unresolved only
    }
    ```
    Check status: CheckRun `conclusion` in `FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE` or StatusContext `state` in `FAILURE, ERROR` → failing; CheckRun `status !== "COMPLETED"` or state `PENDING, EXPECTED` → pending; else passing. Thread `bot` = first comment author `__typename === "Bot"`; `hasReply` = `comments.totalCount > 1`; excerpt = first 200 chars of the first comment.

- [ ] **Step 1: Write failing tests** using the synthetic fixtures (author `octo-author`, viewer `me`, a bot `ci-bot` of type Bot, a human reviewer `rev1` with two reviews, one requested team):
```ts
it.each([
	["https://github.com/Acme/Widget/pull/12", { owner: "Acme", repo: "Widget", number: 12 }],
	["acme/widget#12", { owner: "acme", repo: "widget", number: 12 }],
	["12", { number: 12 }],
])("parsePrArg(%s)", ...);
it("rejects other input", () => expect(() => parsePrArg("main")).toThrow(GhError));
it("keeps the latest review per reviewer, newest first, and marks you", ...);
it("orders checks failing, pending, passing", () => expect(o.checks.map(c => c.status)).toEqual(["failing", "pending", "passing", "passing"]));
it("lists unresolved threads with bot and reply flags", ...);
it("humanStarted ignores the author, the viewer and bots", ...);
it("slugifies logins", () => expect(slugify("Dan_O.Riyan")).toBe("dan-o-riyan"));
it("reports a missing gh binary", async () => { /* PATH without gh */ await expect(runGh(["auth", "status"])).rejects.toThrow("gh is not installed") });
```
(Export `slugify(login: string): string` for this test.)

- [ ] **Step 2: Run** `pnpm vitest run src/server/gh.test.ts src/server/overview.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: read PR metadata and overview through gh"`

---

### Task 6: Private clone and the fake gh

**Files:**
- Create: `src/server/clone.ts`, `test/fake-gh/gh` (executable node script), `test/fake-gh/scenario.ts`
- Test: `src/server/clone.test.ts`

**Interfaces:**
- Consumes: `runGit`, `runGh`, `PrMeta`.
- Produces:
  - `clonePath(owner: string, repo: string): string` — `$XDG_CACHE_HOME/carbonless/repos/<owner lowercased>/<repo lowercased>.git`.
  - `withRepoLock<T>(path: string, fn: () => Promise<T>): Promise<T>` — `<path>.lock` created with `open(..., "wx")`, retry every 100 ms for up to 120 s, a lock older than 10 min is removed as stale, always released in `finally`.
  - `ensureClone(owner: string, repo: string): Promise<string>` — under the lock: if missing, `gh repo clone <owner>/<repo> <path> -- --bare`.
  - `fetchPr(path: string, meta: PrMeta): Promise<{ baseTip: string; head: string; mergeBase: string }>` — under the lock: `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base> refs/pull/<n>/head` (credential helper per Global Constraints), check `git cat-file -e <meta.headOid>`, `mergeBase = git merge-base refs/remotes/origin/<base> <headOid>`.
  - Fake gh: reads the scenario JSON at `$CRB_FAKE_GH`: `{ repoPath: string; user: { login: string }; nameWithOwner?: string; prs: Record<string, { view: object; threads: object }>; loggedOut?: boolean }`. Supports exactly: `auth status`, `api user`, `repo view --json nameWithOwner`, `repo clone <o/r> <path> -- --bare` (→ `git clone --bare <repoPath> <path>`), `pr view <n> -R <o/r> --json <fields>` (prints `prs[n].view`; exits 1 with "no pull requests found" if missing), `api graphql ...` (finds `number` among `-F`/`-f` args, prints `prs[n].threads`). Anything else exits 2 with "fake gh: unsupported".
  - `test/fake-gh/scenario.ts`: `writeScenario(dir: string, s: Scenario): string` and `prView(partial): object` / `threadsResponse(partial[]): object` builders reusing `test/fixtures/gh` shapes.

- [ ] **Step 1: Write failing tests** (`clone.test.ts`, with `PATH=test/fake-gh:$PATH`, `XDG_CACHE_HOME` in a temp dir, a fixture repo with `refs/pull/7/head` created by `git update-ref`):
```ts
it("clones bare into the cache dir once", ...);   // second ensureClone doesn't re-clone (inode/mtime unchanged)
it("fetches the PR head and computes the merge base", async () => {
	const r = await fetchPr(path, meta);
	expect(r).toEqual({ baseTip: shas.base, head: shas.head, mergeBase: shas.branchPoint });
});
it("works when the base branch moved after the PR branched", ...);
it("serializes concurrent opens with the lock", async () => { await Promise.all([ensureClone(o, r), ensureClone(o, r)]); /* one clone, no error */ });
it("never writes outside the cache dir", ...);  // fixture repo's refs and HEAD unchanged after fetchPr
```
- [ ] **Step 2: Run** `pnpm vitest run src/server/clone.test.ts` — FAIL.
- [ ] **Step 3: Implement** `clone.ts` and the fake gh (`chmod +x test/fake-gh/gh`).
- [ ] **Step 4: Run** — PASS; `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: private bare clones and a fake gh for tests"`

---

### Task 7: Session, server routes, access key and the crb CLI

**Files:**
- Create: `src/server/session.ts`, `src/server/access.ts`
- Rewrite: `src/server/app.ts`, `src/cli.ts`, `src/server/app.test.ts`
- Modify: `package.json` (`bin` → `crb`, add `@fastify/cookie`, `dev` script → `tsx watch src/cli.ts $CRB_PR --port 4747 --no-open --api-only`), `src/server/git.ts` (drop unused seed helpers), `README.md` (usage)
- Delete: `src/server/git.test.ts` cases for removed helpers
- Test: `src/server/session.test.ts`, `src/server/access.test.ts`, `src/server/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces:
  - `class Session { static async open(arg: string, cwd: string): Promise<Session>; info(): SessionInfo; snapshot(): Snapshot; overview(): Promise<PrOverview>; review(): Promise<ReviewView>; fileHunks(index: number): Promise<FileHunks>; context(index: number, newFrom: number, newTo: number): Promise<DiffLine[]>; setStates(snapshotHead: string, changes: StateChange[]): Promise<ReviewView>; refresh(): Promise<SessionInfo>; checkHead(): Promise<SessionInfo> }`
  - `open` order: `runGh(["auth","status"])` → `resolvePrRef` → `viewerSlug` → `fetchPrMeta` → `ensureClone` → `fetchPr` → `findOrCreateReview` → `getProgress` → snapshot = patch set's `(mergeBase, head)` if one exists, else `(fetchPr.mergeBase, fetchPr.head)` → `buildSnapshot`.
  - `refresh` = `fetchPrMeta` + `fetchPr`; with no patch set, rebuild the snapshot on the new head; with a patch set keep it. `headMoved = currentHead !== snapshotHead`. `checkHead` = `fetchPrMeta` only (no fetch).
  - `setStates` throws `StaleSnapshotError` when `snapshotHead !== snapshot().head`, then delegates to `ReviewService.recordStates`.
  - SPA fallback: with `webRoot` set, any non-`/api/` GET that matches no file serves `index.html` (TanStack Router owns client paths `/` and `/files`); unknown `/api/` paths return 404 JSON.
  - `registerAccessKey(app: FastifyInstance, key: string | null)` in `access.ts`: when `key` is null do nothing; otherwise an `onRequest` hook accepts `?key=<key>` (and sets the `crb_key` cookie: HttpOnly, SameSite=Strict, Path=/) or a matching cookie, else replies 401 `{ error: "Missing or wrong access key" }`. Compare with `crypto.timingSafeEqual`.
  - `buildApp(session: Session, opts: { webRoot?: string; accessKey: string | null }): Promise<FastifyInstance>` with routes:
    | Route | Returns |
    |---|---|
    | `GET /api/session` | `SessionInfo` |
    | `GET /api/overview` | `PrOverview` |
    | `GET /api/review` | `ReviewView` |
    | `GET /api/files/:index/hunks` | `FileHunks` |
    | `GET /api/files/:index/context?newFrom&newTo` | `DiffLine[]` |
    | `POST /api/review/states` body `{ snapshotHead: string; changes: StateChange[] }` | `ReviewView`; 400 unknown cluster or bad body; 409 `{ error: "stale" }` |
    | `POST /api/refresh` | `SessionInfo` |
    | `GET /api/head` | `SessionInfo` after `checkHead()` |
    `GhError` → 502 with its message; `GitError` → 500.
  - CLI: `crb <pr> [--port <n>] [--host <h>] [--no-open] [--api-only] [-h]`. Prints `carbonless listening on <url>` (URL includes `?key=…` when a key is set). Errors before listening print `crb: <message>` and exit 1. Host is loopback when it's `127.0.0.1`, `::1` or `localhost`.

- [ ] **Step 1: Write failing tests**

`access.test.ts`: no key → 200; key set → 401 without key, 200 with `?key=` and a `set-cookie` containing `crb_key=` and `HttpOnly`, 200 with the cookie alone, 401 with a wrong key.

`session.test.ts` and `app.test.ts` with the fake gh scenario (Task 6) and `app.inject`:
```ts
it("serves the review for the PR head before any check-off", async () => { expect((await get("/api/session")).patchset).toBeNull() });
it("records a state and returns updated progress", ...);
it("rejects a state for an unknown cluster with 400", ...);
it("rejects a stale snapshotHead with 409", async () => {
	// no patch set yet; scenario moves the PR head; POST /api/refresh; then POST states with the old head
	expect(res.statusCode).toBe(409);
});
it("keeps a started review on its snapshot after the PR moves", async () => {
	// check one cluster, move head, refresh
	expect(info).toMatchObject({ headMoved: true, snapshotHead: oldHead, currentHead: newHead, patchset: 1 });
});
it("serves context lines for a file", ...);
it("maps a gh failure to 502", ...);
```
CLI checks go in the e2e suite (Task 8) since they need the built binary.

- [ ] **Step 2: Run** `pnpm vitest run src/server` — FAIL.
- [ ] **Step 3: Implement.** Remove `src/web` usage of the old `/api/comparison` only as far as typecheck needs (the UI is rebuilt in Tasks 8–10); a placeholder `App` that renders `SessionInfo.pr.title` is enough here.
- [ ] **Step 4: Run** `pnpm vitest run src/server` — PASS; `pnpm verify` — PASS (rewrite `e2e/comparison.spec.ts` minimally or delete it; Task 8 replaces the e2e suite).
- [ ] **Step 5: Commit** `git commit -m "feat: crb CLI, session and review API"`

---

### Task 8: E2E harness and the PR overview page

**Files:**
- Rewrite: `e2e/fixtures.ts`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/App.test.tsx`
- Create: `src/web/overview/OverviewPage.tsx`, `e2e/overview.spec.ts`, `e2e/cli.spec.ts`
- Delete: `e2e/comparison.spec.ts`
- Modify: `package.json` (add `react-markdown`, `remark-gfm`)

**Interfaces:**
- Consumes: the API from Task 7, fake gh from Task 6.
- Produces:
  - `e2e/fixtures.ts` exports `test` with fixtures `pr: (opts?: { files?: FixtureCommit[]; overview?: Partial<ViewJson>; threads?: ThreadJson[] }) => Promise<{ repo: GitFixture; scenarioPath: string; number: 7; moveHead: (commit: FixtureCommit) => void }>` (builds a fixture repo with `main` + PR branch, `refs/pull/7/head`, writes a scenario) and `startCrb: (arg?: string, extraArgs?: string[]) => Promise<{ url: string; output(): string; stop(): Promise<void> }>` (spawns `node dist/cli.js` with `PATH=test/fake-gh:…`, `CRB_FAKE_GH`, temp `XDG_CACHE_HOME`; `stop` sends SIGTERM and waits). `startCrb` can be called twice on the same scenario to test restarts.
  - `api.ts`: `fetchSession`, `fetchOverview`, `fetchReview`, `fetchHunks(revision, index)`, `fetchContext(revision, index, from, to)` (both send `?revision=`), `postStates(revision, changes)` (body `{ revision, changes }`; per Ruling R17 the revision always comes from the same `ReviewView` the UI rendered), `postRefresh()`, `fetchHead()`, all throwing `ApiError { status: number; message: string }`.
  - `App.tsx`: header with PR title, `#<n>`, Refresh button; tabs "Overview" | "Files changed" as TanStack Router `Link`s; the moved-head banner slot (Task 10).
  - `src/web/router.tsx`: code-based TanStack Router route tree — root route renders `App` (layout with `<Outlet/>`), `/` → `OverviewPage`, `/files` → `FilesPage` (placeholder until Task 9); browser history; `main.tsx` renders `RouterProvider` inside `QueryClientProvider`. Query options live next to the fetchers in `api.ts` as `queryOptions(...)` factories (`sessionQuery`, `overviewQuery`, `reviewQuery`, `hunksQuery(revision, index)`, `contextQuery(...)`) so components and route loaders share keys.
  - `OverviewPage` sections, each a `<section aria-label=…>`: **"What it does"** (title, author, `base ← head`, draft badge, times, GitHub link, description via `react-markdown` + `remark-gfm` with no raw HTML), **"Who's on it"** (requested reviewers, latest reviews, commenters, "you" shown separately, a clear line "No one else has started reviewing" / "<names> already started"), **"Is it ready"** (draft, conflicts, checks failing first then pending then passing collapsed in `<details>`, unresolved threads split Bots/AI and Humans, and a "No reply" list), and a **"Review files"** button showing overall cluster progress (`reviewed / total − crossedOff`).

- [ ] **Step 1: Write failing tests**

`App.test.tsx` (jsdom, mocked fetch): overview renders the description markdown as HTML (`<strong>` for `**x**`) and does not render a `<script>` from the body; "Who's on it" says "rev1 already started"; checks appear in order failing → pending → passing.

`e2e/overview.spec.ts`:
```ts
test("shows what the PR does, who's on it and whether it's ready", async ({ page, pr, startCrb }) => {
	await pr({ overview: { title: "Add widgets", isDraft: true }, threads: [botThreadNoReply, humanThreadWithReply] });
	const s = await startCrb();
	await page.goto(s.url);
	await expect(page.getByRole("region", { name: "What it does" })).toContainText("Add widgets");
	await expect(page.getByRole("region", { name: "Is it ready" })).toContainText("Draft");
	await expect(page.getByRole("region", { name: "Is it ready" }).getByText("No reply")).toBeVisible();
});
```
`e2e/cli.spec.ts`: `startCrb("not-a-pr")` exits 1 with `crb: Not a PR`; a scenario with `loggedOut: true` exits 1 with `gh is not logged in`; PR 99 (missing) exits 1 with `not found`; `--host 0.0.0.0` prints a URL containing `?key=` and a request without the key gets 401.

- [ ] **Step 2: Run** `pnpm test && pnpm test:e2e` — the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: PR overview page and e2e harness with fake gh"`

---

### Task 9: Files changed view

**Files:**
- Create: `src/web/files/FilesPage.tsx`, `src/web/files/ProgressBar.tsx`, `src/web/files/FileTree.tsx`, `src/web/files/FileDiff.tsx`, `src/web/files/highlight.ts`, `src/web/files/*.test.tsx`, `e2e/files.spec.ts`
- Modify: `package.json` (add `shiki`)

**Interfaces:**
- Consumes: `fetchReview`, `fetchHunks`, `fetchContext`, `postStates`, `ReviewView`, `FileHunks`.
- Produces (UI behavior, matching the spec's Files changed section and the approved mockup "A, revised"):
  - `ProgressBar({ progress }: { progress: Progress })` — sticky top; two bars "Clusters" and "Lines", each with the percentage (`reviewed ÷ (total − crossedOff)`, 100% at 0/0), `reviewed / (total − crossedOff) reviewed`; green fill from the left, hatched purple crossed-off segment at the right end; legend "Left: N clusters · N lines · N files" and "Crossed off, not reviewed: N clusters · N lines · N files". `role="progressbar"` with `aria-label` "Clusters" / "Lines" and `aria-valuenow` = percentage.
  - `FileTree({ files, current, onSelect })` — folder tree in snapshot order, per file: status icon (not started / partly done / done / crossed off, crossed off struck through with the reason as a tag), `done/total` clusters, `+a −d`; current file highlighted.
  - `FileDiff({ file, revision, onChange })` — header: path (`old → new` for renames), `+/−`, "N of M clusters reviewed", "Cross off file…", "Mark remaining reviewed", collapse toggle. Starts collapsed; expanding fetches hunks (TanStack Query key `["hunks", revision, index]`). Body: unified lines with old/new numbers, add/del backgrounds, `@@ -a,b +c,d @@` rows; each line cluster gets a left rail (grey unreviewed, green reviewed and dimmed, purple crossed off, blue focused) with a checkbox on its first line (`aria-label="Mark cluster reviewed"`); file-level clusters render as a row with their label and the same checkbox. Expand rows between hunks: ↓ loads the next 20 lines below the previous hunk, ↑ the 20 above the next, ↕ fills a gap ≤ 20; ↑ at the top and ↓ at the bottom of the file (`newLineCount` bounds). Loaded lines are context only.
  - "Cross off file…" opens a small dialog built with TanStack Form (`useForm`; reason required, trimmed, non-empty): reason text field with quick picks "generated" and "rename only"; confirming posts `crossed-off` for every cluster in the file. "Mark remaining reviewed" posts `reviewed` for every `unreviewed` cluster. A checked checkbox click posts `unreviewed` (undo).
  - All writes go through one `useMutation` (`useSetStates`) whose `onSuccess` writes the returned `ReviewView` into the `reviewQuery` cache (`setQueryData`).
  - `postStates` failure 409 → invalidate session + review and show "The review moved to a new snapshot; reloaded." Other failures show the error inline; the checkbox reverts.
  - `highlight.ts`: `highlightLine(text: string, lang: string | null): Promise<ThemedToken[]>` using a Shiki core highlighter with only these languages loaded lazily: `csharp, xml, powershell, markdown, typescript, tsx, javascript, json, yaml, css, html, shellscript, python, go, rust, java, sql`; extension map includes `.wxs .wxl .csproj .props .targets → xml`, `.ps1 .psm1 → powershell`, `.cs → csharp`; unknown → plain text. Lines are highlighted one at a time (multi-line constructs may lose state; acceptable for this milestone).

- [ ] **Step 1: Write failing tests**

Component tests (jsdom): `ProgressBar` shows 51% for clusters `{ total: 39, reviewed: 18, crossedOff: 4 }` (18/35) and 100% for `{ total: 2, reviewed: 0, crossedOff: 2 }`; `FileDiff` starts collapsed and fetches hunks only on expand; clicking a cluster checkbox calls `postStates` with the rendered `ReviewView.revision` and `[{ key, state: "reviewed" }]`.

`e2e/files.spec.ts` (fixture PR: one file with two clusters 10 lines apart, one file with a single cluster, one renamed file with no edits, a 60-line unchanged gap for expansion):
```ts
test("checking a cluster updates file and overall progress", async ({ page, pr, startCrb }) => {
	// open /files, expand file 1, check its first cluster
	await expect(page.getByRole("progressbar", { name: "Clusters" })).toHaveAttribute("aria-valuenow", "25");
	await expect(page.getByTestId("file-tree")).toContainText("1/2");
});
test("cross off a file with a reason", ...);       // renamed file: struck through, tag "rename only", crossed-off legend counts it, percentage unchanged
test("mark remaining reviewed", ...);              // file shows 2/2, tree icon done
test("loading more lines", ...);                    // ↓ adds 20 context lines with correct old/new numbers; ↕ appears when gap ≤ 20
test("files start collapsed", ...);                 // no diff lines visible before expanding
```

- [ ] **Step 2: Run** `pnpm test && pnpm test:e2e` — new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: files changed view with cluster review and progress"`

---

### Task 10: Persistence, moved head and refresh

**Files:**
- Create: `e2e/persistence.spec.ts`, `src/web/HeadBanner.tsx`
- Modify: `src/web/App.tsx`

**Interfaces:**
- Consumes: `fetchHead`, `postRefresh`, `SessionInfo`.
- Produces:
  - `App` polls `GET /api/head` every 5 minutes (`refetchInterval: 300_000`) and on window focus; Refresh button calls `POST /api/refresh` then invalidates every query.
  - `HeadBanner({ info })` shown when `info.headMoved`: "New commits were pushed to this PR. You're reviewing the snapshot from <short snapshotHead>; there's no way to move to the new head yet." with a link to the PR. No other UI change.

- [ ] **Step 1: Write failing e2e tests**
```ts
test("progress survives a restart", async ({ page, pr, startCrb }) => {
	// check a cluster, stop crb, start again on the same scenario
	await expect(page.getByRole("progressbar", { name: "Clusters" })).toHaveAttribute("aria-valuenow", "25");
});
test("a started review stays on its snapshot after a push", async ({ page, pr, startCrb }) => {
	// check a cluster; moveHead(changes the checked file); click Refresh
	await expect(page.getByText("New commits were pushed")).toBeVisible();
	await expect(page.getByRole("progressbar", { name: "Clusters" })).toHaveAttribute("aria-valuenow", "25"); // unchanged
});
test("opening without checking anything off creates no snapshot", async ({ page, pr, startCrb }) => {
	// open, moveHead, Refresh: no banner, files show the new head's clusters
	// and the clone has no refs under refs/crb/reviews/*/reviewers/
});
```
- [ ] **Step 2: Run** `pnpm test:e2e` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat: moved-head banner, refresh and persistence checks"`

---

### Task 11: Manual check against the reference PR and docs

**Files:**
- Modify: `README.md`, `CLAUDE.md` (Development section: `crb`, fake gh), `docs/review-data-storage.md` (only if the implementation departed from it), `docs/todo.md` (mark "PR review view" done)

- [ ] **Step 1:** `pnpm build && node dist/cli.js https://github.com/gytpol/active-directory-domain-agent/pull/27 --host "$(tailscale ip -4)" --no-open` and open the printed URL.
- [ ] **Step 2:** Confirm in the UI and via `curl -s '<url-with-key>' ...api/review | jq '.progress'`: **24 files, 39 clusters, 1,588 lines**; the overview shows 6 checks and the unresolved bot threads. Check one cluster, restart, confirm it's still checked. Confirm the reviewer's working copy at `~/active-directory-domain-agent` is untouched (`git -C ~/active-directory-domain-agent status` and its refs unchanged). Report any mismatch instead of adjusting counts.
- [ ] **Step 3:** Update the docs listed above; describe `crb` usage and `pnpm dev` with `CRB_PR=<pr>` in the README.
- [ ] **Step 4:** `pnpm verify` — PASS.
- [ ] **Step 5: Commit** `git commit -m "docs: crb usage and milestone status"`
