# Home and the always-on server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One long-lived `crb serve` per machine serving any number of reviews, `crb <pr>` as a thin client that prints a link, and a Home page at `/` listing the view's PRs with annotations, search and GitHub refresh.

**Architecture:** Task 1 turns the one-process-per-PR CLI into a server holding a registry of `Session`s keyed by review id, with config, state, key and version files, the client/auto-start path, and review URLs under `/r/<id>`. Task 2 adds the Home server: a GitHub refresh of PR facts, pure section and turn rules, a per-reviewer inbox ref for annotations, the started-review scan with coverage, and the `/api/home/*` routes. Task 3 builds the Home page against Task 2's contract. Tasks 2 and 3 start once Task 1's interfaces are fixed (they are, below) and rebase on it for their wiring and e2e.

**Tech Stack:** Node 24, Fastify, git CLI, `gh` (GraphQL), React 19, TanStack Query and Router, Tailwind tokens, Vitest, Playwright (desktop + phone) with fake `gh`.

**Spec:** `docs/superpowers/specs/2026-10-28-home-and-always-on-server-design.md`. Mockups: https://claude.ai/artifact/NDHGwsuuCfFphmvqB3vDTT

## Global Constraints

- Paths: config `$XDG_CONFIG_HOME/carbonless/config.json` (default `~/.config/...`); state `$XDG_STATE_HOME/carbonless/` (default `~/.local/state/...`) holding `server.json` (0600), `key` (0600), `serve.log`; cache `$XDG_CACHE_HOME/carbonless/` as today. Relative XDG values are ignored, as `clone.ts` does today.
- Config defaults: `serve.host` `127.0.0.1`, `serve.port` `4747`, `views` `[]` (an empty "My PRs"), `refresh.minutes` `2`.
- `crb <pr>` never opens a browser unless `--open`. Stdout carries only the URL.
- Version: `crb --version` prints `<package.json version> (<short commit>)`; `GET /api/version` returns `{ "version", "commit" }` with the full sha; the commit is baked in at build time, `-dirty` appended when the tree was dirty; the client sends both on every request; any difference is refused with "server runs X (abc1234), this crb is Y (def5678)".
- Review sessions close after 30 minutes without requests.
- Home: sections `mine`, `reviewing`, `grabs`, `other`, `closed` (labels "Mine", "Reviewing", "Up for grabs", "Other open", "Recently closed"); a section shows 20 rows, then "show N more"; Recently closed holds PRs merged or closed in the last 3 days.
- Snooze presets: tomorrow 09:00, in 3 days 09:00, next Monday 09:00, pick a date; `wakeOnActivity` defaults to true. A row woken in the last 24 h carries a "woke" badge.
- Refresh: every `refresh.minutes`; on failure the interval doubles up to 30 min and resets on success; the page refreshes on open or focus when the last refresh is older than 30 s.
- Annotations are events with `by: "human"` in `refs/crb/inbox/<reviewer>`, never written by anything automatic. Home never writes review progress.
- Principles 5 and 6: no horizontal page scroll at 360 px, ≥ 40 px tap targets, icons with tooltip and accessible name, token colours only, dates through `RelativeTime`.
- Tests never call the real `gh`. Agents never use port 4747 or the owner's state dirs; commits via `git commit --only -- <paths>`; no pushes.

## Review Focus

1. **A second server or a stale state file**: `server.json` names a dead pid, or a pid that isn't crb → the client replaces it and starts a fresh server; two `crb <pr>` at once with no server → exactly one server ends up serving both (Task 1, `client.test.ts` "concurrent auto-start").
2. **A review URL after a restart**: `/r/<id>` opened in a server that never opened that review (bookmark, phone) → it finds the repo by scanning cache clones and opens it; an unknown id → 404 page with a Home link, not a crash (Task 1, `registry.test.ts` "opens by id after restart"; e2e "bookmark survives restart").
3. **GitHub slow, failing or rate-limited during refresh**: Home keeps the last good rows, shows the warning with its reason, and the backoff doubles; a refresh in flight is never started twice (Task 2, `homeService.test.ts` "backoff" and "single flight").
4. **Clock edges on snooze**: a snooze whose date passes while the page is open wakes on the next refresh or page focus without a reload; `updatedAt` equal to the snooze moment does not wake it (Task 2, `inbox.test.ts` "wakes strictly after").
5. **A config file edited by hand into garbage** (bad JSON, unknown keys, a repo string without a slash): the server starts with defaults for the bad parts, Home shows the problem, and the next UI save rewrites a valid file without dropping unknown keys (Task 1, `config.test.ts`).

---

### Task 1: The server, the client and review URLs (brief A)

**Files:**
- Create: `src/server/paths.ts`, `src/server/config.ts`, `src/server/serverState.ts`, `src/server/version.ts`, `src/server/registry.ts`, `src/server/serve.ts`, `src/client.ts`, `scripts/build-info.mjs`, `e2e/serve.spec.ts`, with a `*.test.ts` beside each server module and `src/client.test.ts`
- Modify: `src/cli.ts` (subcommands), `src/server/app.ts` (routes under `/api/r/:id/`, `/pr/...` redirect, `/api/reviews`, `/api/version`, version check), `src/server/clone.ts` (cache dir from `paths.ts`), `src/server/review/reviews.ts` (find a review's PR by id), `src/web/api.ts` + `src/web/router.tsx` + `src/web/App.tsx` (routes under `/r/$id`, logo links Home), `package.json` (`build`, `dev`), `scripts/agent-worktree.sh`, `.gitignore`, `e2e/fixtures.ts` + `e2e/pr-setup.ts` (start `crb serve`, then `crb <pr>`), `CLAUDE.md` (run instructions), `docs/faq.md` if it mentions running crb

**Interfaces (produces, exact):**

```ts
// src/server/paths.ts
export function configDir(): string;   // $XDG_CONFIG_HOME/carbonless
export function stateDir(): string;    // $XDG_STATE_HOME/carbonless
export function cacheDir(): string;    // $XDG_CACHE_HOME/carbonless (clone.ts uses it)

// src/server/config.ts
export interface ViewConfig { name: string; repos: string[] }      // "owner/repo", lowercased
export interface CrbConfig {
  serve: { host: string; port: number };
  views: ViewConfig[];
  refresh: { minutes: number };
}
export interface ConfigRead { config: CrbConfig; problems: string[] } // what was bad and replaced by a default
export function readConfig(): Promise<ConfigRead>;
export function updateConfig(change: (c: CrbConfig) => CrbConfig): Promise<CrbConfig>; // keeps unknown keys, atomic write

// src/server/serverState.ts
export interface ServerState { url: string; host: string; port: number; pid: number; startedAt: string; version: BuildInfo }
export function writeServerState(s: ServerState): Promise<void>;
export function readLiveServerState(): Promise<ServerState | null>; // null when missing or pid dead
export function removeServerState(): Promise<void>;
export function accessKey(): Promise<string>;        // creates `key` on first use
export function rotateAccessKey(): Promise<string>;

// src/server/version.ts
export interface BuildInfo { version: string; commit: string }       // commit may end in "-dirty"
export const BUILD: BuildInfo;                                        // dist/build-info.json; in tsx dev: package.json + `git rev-parse HEAD`
export const formatVersion: (b: BuildInfo) => string;                 // "0.4.0-rc.1 (93fe843)"
export const VERSION_HEADER = "x-crb-version";                        // JSON BuildInfo

// src/server/registry.ts
export interface OpenRequest { pr: string; cwd?: string; head?: HeadSpec; asOf?: string; viewer?: string }
export class SessionRegistry {
  constructor(options?: { idleMs?: number; now?: () => number });
  open(req: OpenRequest, progress?: (m: string) => void): Promise<{ id: string; session: Session }>;
  get(id: string): Promise<Session>;          // opens by id from the refs when not open; UnknownReviewError when no clone has it
  closeAll(): Promise<void>;
}
export class UnknownReviewError extends Error {}

// src/server/review/reviews.ts (addition)
export interface StoredReview { id: string; key: string; pr: ReviewPr; asOf?: string; head?: string }
export function findReviewById(cacheRoot: string, id: string): Promise<{ repoDir: string; review: StoredReview } | null>;
export function listReviews(repoDir: string): Promise<StoredReview[]>;  // Task 2's started scan uses it

// src/server/serve.ts
export function startServer(opts: { host?: string; port?: number; webRoot?: string; newKey?: boolean }): Promise<{ url: string; close(): Promise<void> }>;
```

HTTP:
- `GET /api/version` → `BuildInfo`. Any request carrying `x-crb-version` that differs → `409 { error: "server runs … , this crb is …", code: "version-mismatch", server: BuildInfo }`. Browser requests carry no header and are not checked.
- `POST /api/reviews` `{ pr, head?, asOf?, viewer? }` (the client resolves a bare number against its cwd first and sends `owner/repo#n`) → `200 { id, url }` with `url` = `<server url>/r/<id>`; a refusal (merged, closed, unknown PR) → `409 { error, code: "refused" }`.
- Every existing review route moves from `/api/<x>` to `/api/r/:id/<x>`, same bodies. An unknown id → 404 `{ error, code: "unknown-review" }`.
- `GET /pr/:owner/:repo/:number[?head=<sha|reviewed>]` → 302 `/r/<id>`; a refusal → the web 404 page with the refusal text.
- Web routes: `/` (Home, a placeholder until Task 3), `/r/$id` (overview), `/r/$id/files`. The header logo is a link to `/` named "Home".

CLI: `crb serve [--host] [--port] [--new-key]` (foreground; writes state, logs to stderr) · `crb <pr> [--head] [--open]` (hidden `--as-of`, `--viewer`) · `crb --version` · `crb --help`. With no live server the client spawns `crb serve` detached with stdout/stderr to `serve.log`, waits up to 20 s for `server.json`, then posts.

- [ ] **Step 1: Failing tests** for `paths`, `config` (defaults, a missing file, bad JSON → defaults + a problem, a repo without a slash dropped with a problem, unknown keys kept by `updateConfig`), `serverState` (dead pid → null; key survives remove; rotate changes it; files are 0600), `version` (format; mismatch message names both sides).
- [ ] **Step 2: Implement them**; `scripts/build-info.mjs` writes `dist/build-info.json` from `package.json` and `git rev-parse HEAD` + `git status --porcelain` (non-empty → `-dirty`); `build` runs it after `tsc`.
- [ ] **Step 3: Failing tests for `SessionRegistry`** (with the fake `gh` and `test/git-fixture.ts`): open twice → same id, one session; `get` after a fresh registry ("restart") opens by id; unknown id → `UnknownReviewError`; idle close after `idleMs` with an injected clock, then `get` reopens; `closeAll` closes all.
- [ ] **Step 4: Implement the registry and `findReviewById`/`listReviews`** (scan `cacheDir()/repos/*/*.git` with `git for-each-ref refs/crb/reviews/<id>/meta`; read the `review-created` event; rebuild `OpenRequest` from its `pr`, `details.head` and `details.asOf`).
- [ ] **Step 5: Routes and app** (`app.test.ts`): the version check both ways; `/api/reviews` success and refusal; `/api/r/:id/session` for two reviews on one app; unknown id 404; `/pr/...` 302; access key still required off loopback.
- [ ] **Step 6: The client** (`client.test.ts`): a live server is used, none started; a stale `server.json` (dead pid) is replaced; two concurrent `ensureServer()` calls end with one server (lock file in `stateDir()`); a version mismatch exits 1 with the message; stdout is only the URL; `--open` opens.
- [ ] **Step 7: Web routes**: `api.ts` takes the review id from the route (builder's call how; one place sets it); all pages under `/r/$id`; the logo links Home; the `?` help and shortcuts unchanged. Unit tests for the route parsing; existing tests updated, not deleted.
- [ ] **Step 8: Dev and agents**: `pnpm dev` runs `tsx watch src/cli.ts serve --port ${CRB_API_PORT:-4858}` with `XDG_STATE_HOME`/`XDG_CONFIG_HOME` under `.crb-dev/` in the worktree (git-ignored) and Vite proxying to it; `CRB_PR` opens that PR through the client and prints the link. `scripts/agent-worktree.sh` writes the same two variables into `.worktrees/<name>/.envrc` and prints them; CLAUDE.md says to export them. The dev default port moves off 4747 (4747 is the owner's).
- [ ] **Step 9: e2e** (`e2e/fixtures.ts` starts `crb serve` on a random port with temp XDG dirs, then runs `crb <pr>` and reads its URL; every existing spec passes through it unchanged apart from URLs) and `e2e/serve.spec.ts`: two PRs open at once in one server; `crb <pr>` with no server starts one and a second `crb` reuses it; a bookmark `/r/<id>` works after the server restarts; the logo goes to `/`; an old build's version header is refused. Add to `E2E_MAP`.
- [ ] **Step 10: Docs**: CLAUDE.md "Run it on a PR" (`crb serve`, `crb <pr>`), the owner-instance restart line, `docs/faq.md` if it describes running crb. `pnpm verify` green; commit.

### Task 2: Home, server side (brief B)

**Files:**
- Create: `src/server/home/prFacts.ts`, `src/server/home/sections.ts`, `src/server/home/inbox.ts`, `src/server/home/started.ts`, `src/server/home/search.ts`, `src/server/home/homeService.ts`, tests beside each; `src/shared/home.ts` (the types below)
- Modify: `src/server/review/events.ts` (inbox event types), `src/server/clone.ts` (`ensureRepoInit`), `src/server/app.ts` (`/api/home/*`), `test/fake-gh/gh` + `test/fake-gh/scenario.ts` (repo PR lists, search, viewer teams, mutable updatedAt), `docs/review-data-storage.md` ("Inbox ref" section), `docs/gitdb-design-principles.md` only if departing from one (say which)

**Interfaces:**
- Consumes: Task 1's `SessionRegistry`, `listReviews`, `readConfig`/`updateConfig`, `cacheDir()`, the app's route registration.
- Produces (`src/shared/home.ts`, exact, Task 3 builds against it):

```ts
export type SectionId = "mine" | "reviewing" | "grabs" | "other" | "closed";
export type Turn =
  | { kind: "none" }
  | { kind: "people"; logins: string[]; label?: "merge" }   // viewer first when present
  | { kind: "no-reviewer" };
export interface Person { login: string; avatarUrl: string }
export interface Coverage { done: number; total: number; unit: "lines" | "clusters" | "files" }
export interface RowReview {
  id: string;                       // review id, for /r/<id>
  label: string;                    // "head", or the pinned head's 7-char sha
  pinnedHead: string | null;
  coverage: Coverage;
  lastActedAt: string;
}
export interface Annotations {
  snooze?: { until: string; wakeOnActivity: boolean; at: string };
  waiting?: { who: string; at: string };     // a login or "me"
  note?: string;
}
export interface HomeRow {
  owner: string; repo: string; number: number; title: string; url: string;
  author: Person; draft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED"; closedAt: string | null;
  updatedAt: string;                         // last GitHub activity, the row's age
  checks: "passing" | "failing" | "running" | null;
  decision: "approved" | "changes-requested" | null;
  unresolvedThreads: number;
  turn: Turn;                                // after the viewer's waiting-on override
  people: Record<string, Person>;            // avatars for turn logins
  annotations: Annotations;
  hidden: "snoozed" | "waiting" | null;
  woke: { at: string; by: "activity" | "time" } | null;
  reviews: RowReview[];                      // started reviews, newest activity first; [] when none
  openable: boolean;                         // false: merged/closed with no started review → link to GitHub
}
export interface HomeSection { id: SectionId; rows: HomeRow[] } // hidden rows included, flagged; newest updatedAt first
export interface HomeView {
  viewer: Person;
  view: { name: string; repos: string[] };
  configProblems: string[];
  refreshedAt: string | null;
  refreshError: string | null;               // last refresh's failure, rows kept
  sections: HomeSection[];                   // all five, always, in order
  startedRepos: string[];                    // repos of started reviews, newest first: the view dialog's chips (2026-11-01)
}
export type AnnotationOp =
  | { op: "snooze"; until: string; wakeOnActivity: boolean }
  | { op: "wait"; who: string }
  | { op: "note"; text: string }
  | { op: "wake" };                          // clears snooze and waiting
export interface SearchResult {
  repos: { name: string; inView: boolean; openCount: number | null }[];
  prs: { owner: string; repo: string; number: number; title: string; author: Person; state: HomeRow["state"]; updatedAt: string; hidden: HomeRow["hidden"] }[];
  scope: string | null;                      // "owner/repo" when the query named one
  pending: boolean;                          // a GitHub search is still running; ask again
}
```

HTTP: `GET /api/home` → `HomeView` · `POST /api/home/refresh` → `HomeView` (joins a refresh in flight) · `POST /api/home/prs/:owner/:repo/:number/annotations` `AnnotationOp` → `HomeRow` · `PUT /api/home/view` `{ repos: string[] }` → `HomeView` · `GET /api/home/search?q=` → `SearchResult`.

Server-side functions (internal, named so the reviewer can find them): `fetchRepoPrs(owner, repo, closedSince): Promise<PrFacts[]>` (GraphQL, 100 per page, every open PR plus closed since), `sectionOf(pr, viewer, viewerTeams, started, now): SectionId | null`, `turnOf(pr, viewer): Turn`, `InboxStore.append(slug, owner, repo, op)`, `foldInbox(events): Map<number, Annotations>`, `hiddenReason(a, pr, now)`, `wokeOf(a, pr, now)`, `listStarted(viewer): Promise<StartedReview[]>`, `parseQuery(q): ParsedQuery`.

- [ ] **Step 1: Failing tests for `sections.ts`**: every rule of the spec's section table and turn table (8 rules, first match wins), drafts, team review requests (viewer in a requested team → reviewing; teams unknown → other), a started PR (repos outside the view never reach the table since 2026-11-01), closed-unmerged within and past 3 days, `--as-of` reviews never count as started.
- [ ] **Step 2: Implement `sections.ts`** (pure).
- [ ] **Step 3: Failing tests for the inbox**: events validate (`by: "human"` only; unknown types skipped by readers); fold last-wins per (PR, kind); `wake` clears both; snooze hides until `until`; with `wakeOnActivity` wakes when `updatedAt` > the snooze's `at` (equal does not); without it ignores activity; waiting hides until the named login's activity after `at`, someone else's activity doesn't clear it, `me` never hides; `woke` reported for 24 h; written into a bare repo made by `ensureRepoInit` with no project objects, then a full fetch keeps the ref; two writers race with compare-and-swap.
- [ ] **Step 4: Implement** the four inbox event types in `events.ts` (`pr-snoozed`, `pr-waiting-on`, `pr-note`, `pr-cleared` with `kind`), `inbox.ts` on `RefStore.appendEvent`, `ensureRepoInit` in `clone.ts` (init bare + remote config, no fetch; `ensureClone` later fetches into it). Docs: the "Inbox ref" section of `docs/review-data-storage.md` with a size measured after 100 events.
- [ ] **Step 5: Failing tests for the refresh** with an extended fake `gh` (a scenario gets `repos: { "acme/api": { prs: [...] } }`, `viewerTeams`, a search answer, and a way to bump a PR's `updatedAt` between calls): the PR list maps to facts (checks rollup, decision, unresolved count, last activity per login); pagination past 100; `homeService` single-flight; backoff doubling to 30 min and reset; failure keeps last rows and sets `refreshError`; started PRs outside the view refreshed until 3 days after closing (superseded 2026-11-01: Home lists only the view's repos, started or not; see the spec's "Which PRs are considered").
- [ ] **Step 6: Implement `prFacts.ts`, `started.ts` (coverage from the progress ref and the patch set's snapshot, cached by (repo, mergeBase, head); measure Home's first build with 3 repos × 100 PRs and 5 started reviews), `homeService.ts`.**
- [ ] **Step 7: Search** (`search.test.ts`): `parseQuery` for a URL, `owner/repo#n`, `owner/repo ` + words, `#n` after a repo, free text; ranking (repos: view, then recent reviews, then GitHub; PRs: open before closed, by `updatedAt`; words in any order, case-insensitive); a GitHub search is started only for 3+ characters and answered later through `pending`.
- [ ] **Step 8: Routes** (`app.test.ts`): each route above, annotation validation (400 on a bad op, a past `until`, a note over 500 chars), view update writes the config.
- [ ] **Step 9: Measure** refresh cost (GraphQL points via `rateLimit { cost }` in the query, at 100 and 300 open PRs) against the real API, read-only, on `Gilthans/carbonless-gallery`; report it. `pnpm verify` green; commit.

### Task 3: Home, web (brief C)

**Files:**
- Create: `src/web/home/HomePage.tsx`, `src/web/home/Section.tsx`, `src/web/home/PrRow.tsx`, `src/web/home/RowActions.tsx` (snooze, waiting on, note; popovers on desktop, bottom sheet on touch), `src/web/home/OpenBox.tsx` (search), `src/web/home/ViewSettings.tsx`, `src/web/home/homeApi.ts`, tests beside each, `e2e/home.spec.ts`
- Modify: `src/web/router.tsx` (`/` → Home), `src/web/shortcuts.tsx` (`/`, Esc, arrows, Tab), `src/web/api.ts` if shared helpers move, `scripts/verify-fast.mjs` (`E2E_MAP`), `src/web/theme.test.ts` for new colour pairs

**Interfaces:**
- Consumes: `src/shared/home.ts` and the `/api/home/*` routes, exactly; `RelativeTime`, `Tooltip`, existing icons and progress bar components.
- Produces: nothing other tasks use.

- [ ] **Step 1: Failing component tests** (mocked `homeApi`): five sections in order with labels; a section with 25 rows shows 20 and "show 5 more"; hidden rows sit behind a footer "2 snoozed · 1 waiting" (only the non-zero parts), revealed in place, each with its reason badge and a Wake up button; a row shows repo, number, title, Draft pill, note pill, status icons (each with tooltip and accessible name), turn (viewer ringed), age; a started row shows coverage next to the age; several started reviews render as sub-rows ordered by `lastActedAt` and each links to `/r/<id>`; a non-openable row links to GitHub with the external-link icon and tooltip "Merged, nothing to review here. Open on GitHub"; the woke badge; refresh age in the header turning `warn` with `refreshError`; `configProblems` shown; an empty view offers to add repos.
- [ ] **Step 2: Implement the page and rows** after the mockups' Main and Phone boards (Recently closed rows use the violet merged or red closed icon).
- [ ] **Step 3: Failing tests for the row actions**: snooze presets compute local 09:00 dates, the "Wake on activity too" switch defaults on, pick-a-date; waiting on lists author and reviewers plus a login field; note save and clear; each posts the op and updates the row from the answer (TanStack Query cache) without a full reload; Wake up posts `{ op: "wake" }`.
- [ ] **Step 4: Implement `RowActions`**: hover buttons on desktop; a 40 px "⋯" button with a bottom sheet on touch (no hover, no long-press).
- [ ] **Step 5: Failing tests for `OpenBox`**: a pasted URL or `owner/repo#n` + Enter navigates to `/pr/owner/repo/n`; typing shows Repos and Pull requests groups; Tab or Enter on a repo fills `owner/repo ` and lists its PRs; words filter titles; Enter on a PR opens it; `pending` re-asks after a short delay with a spinner; Backspace over the space leaves the repo; `/` focuses, Esc closes; arrows move the highlight; ARIA combobox roles.
- [ ] **Step 6: Implement `OpenBox` and `ViewSettings`** (add by `owner/repo` or URL, remove, suggestions from repos of recent reviews; saves through `PUT /api/home/view`).
- [ ] **Step 7: e2e (`e2e/home.spec.ts`, desktop and phone)** on Task 2's fake-gh scenario: the sections from the scenario; a started review shows with its coverage, its row goes when its repo leaves the view and returns, through the Suggested chip, when it comes back (2026-11-01: only the view's repos are listed); open by URL, by `owner/repo#n`, by repo then title words; snooze leaves the section, shows in the footer, Wake up brings it back; snooze with activity wakes after the scenario bumps `updatedAt` and a refresh; waiting-on clears on that person's activity; a note shows; the refresh warning keeps the rows; no horizontal scroll at 360 px; tap targets ≥ 40 px. Add to `E2E_MAP`.
- [ ] **Step 8: Screenshots** desktop and 360 px for the report. `pnpm verify` green; commit.
