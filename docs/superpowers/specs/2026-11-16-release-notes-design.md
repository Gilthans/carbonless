# Release notes per version, and "What's new" from the update toast

CAR-192. Draft, 2026-11-16, for the owner's review. Depends on CAR-191
(the release freeze, PR #128), which touches the same release scripts.

Mockups (desktop and phone, loading, failed, by hand, RC, Global
settings): `release-notes-mockups.html`, a standalone page the
coordinator sends as a link (it is not in the repo).

## The owner's words (2026-11-16)

> I want each version to have its own change log, taken from the linear
> tickets that made it into the release. Each ticket, before being moved to
> done, should force the mover to either explicitly say the ticket requires
> no release notes (e.g. flaky test fixes, refactors), or give the message
> that should be used in the changelog. This should be applied
> retroactively to any ticket that's going into 0.4.0, so that 0.4.0 comes
> with a fully populated changelog.
> The update toast should now open a modal that explains what's new in the
> next version, and an "update" button below

## Why

Today `docs/changelog.md` is a list of PR titles that release-finish
writes into the "next" PR. PR titles are written for reviewers ("e2e:
deadlines no longer fire late for a frozen test process…"), half of them
are about tests, and the toast only links the version's tag on GitHub,
which shows nothing. Someone deciding whether to click Update can't tell
what they'd get.

## Goals

- Each ticket says, before it is done, either the note for the changelog
  or, explicitly, that it needs none.
- Each version has its own notes, made from the tickets in it, and every
  ticket in a release is accounted for: promote refuses a release with a
  ticket that has neither.
- The running crb shows the notes of every version between it and the
  one on offer, in a modal, with Update below.
- 0.4.0 is the first version with full notes.

## Non-goals

- Writing notes with AI at release time. Notes are written per ticket by
  whoever finishes it, and the owner approves the wording.
- Notes for every RC. RCs show the upcoming release's notes collected so
  far (below), not a list of their own.
- Changing how versions, RCs, promote, publish or the freeze work.

## Anti-goals

- **A Linear secret in CI.** No workflow gets a Linear key. Today CI's
  only credentials are GitHub's own token and npm's OIDC, and the release
  jobs are audited around that (`docs/releasing.md`, "Trusted
  publishing"). A Linear key in CI would be one more secret for every
  workflow change to protect, for a read we can do on the owner's
  machine. Everything Linear is read where the key already is.
- **A carbonless server** (principle 4). crb reads notes from the npm
  registry it already asks for updates; nothing new is hosted.
- **Notes gating an update.** Update works while notes load and after they
  fail.
- **Notes that look complete when they aren't.** An RC with merged PRs that
  have no note yet says so; a failed fetch is an error, never an empty
  list.

## 1. Where a ticket's note lives

**A comment on the ticket** whose first line starts with `Release note`
(recommended; owner decision D1):

```
Release note (new): Files changed has a Threads tab beside the file tree: every conversation, newest first.
```

```
Release note: none (flaky test fix)
```

- Kind in parentheses: `new`, `improved` or `fixed`. Left out, it
  defaults from the ticket's labels (Feature → new, Improvement →
  improved, Bug → fixed), else the tool asks.
- `none` takes a short reason in parentheses (required: "explicitly say").
- Any number of `Release note` lines in one comment, for a ticket that
  shipped more than one user-visible thing (CAR-38's renderers, say), or
  a complex change that needs explaining (owner, 2026-11-18: "don't limit
  it. We might want to explain complex changes in the release notes").
- **The newest such comment wins** (by `updatedAt`, so an edited comment
  counts). Changing a note is a new comment or an edit; the old one stays
  as history of who said what.
- **Text rules**, checked wherever a note is read: plain text (`code` in
  backticks is the only markup), one or more sentences on one line (a
  first sentence that stands alone as the summary, then any explanation;
  at most 600 characters per note, as a sanity bound, not a style limit),
  no control or bidi characters, starts with a capital, no ticket ids or PR
  numbers in the text (the tools add those). Written for a reviewer who
  uses crb, not for us: what they can now do or no longer suffer, in the
  UI's words.

Why a comment and not the alternatives:

| Option | For | Against |
| --- | --- | --- |
| Comment with a marker (recommended) | Agents already post comments through the API; author and time are kept, so "none" is visibly someone's decision; editing a note doesn't touch the description | Linear can't filter a view on comment text (the audit below covers that) |
| A `## Release note` section in the description | Visible at the top | Briefs and agents rewrite descriptions; a section is easy to lose or edit by accident; markdown parsing is fragile |
| A label group (`Release note` → `written` / `none`, exclusive) | Linear views can filter on it | The text still needs a home; two sources can disagree. Could be added later as a derived marker the tools set, never read |

## 2. The gate: nothing reaches Done without a note

Linear can't block a state change, and on this team the move to Done is
**automatic**: CAR-183 went Implementation → Done two seconds after PR
#110 merged: Linear's GitHub integration moves a linked ticket to Done
on merge (CLAUDE.md, "Tickets"). So a check at "moving to Done" would
always run too late. The gate moves to **before the merge**, where every
agent merge already runs a check, plus two catch-alls:

1. **At merge: `pnpm release merge-ok <pr>`** (CAR-191 adds it; CLAUDE.md
   requires it before any agent merge). It also reads the PR's tickets
   (below) from Linear and refuses while any has no `Release note`
   comment, naming the ticket and the command to add one. It reads the
   key as agents do today (`$LINEAR_API_KEY`, else the key file in the
   user's config dir); without a key it refuses, saying so.
2. **Writing the note: `pnpm release note CAR-NNN "<text>" [--kind k]`**
   and **`pnpm release note CAR-NNN --none "<why>"`**: validate the text
   (rules above) and post the comment. The implementing agent drafts the
   note in its report; the coordinator posts it when the owner approves the
   merge (the owner reads the note with the PR). An agent that moves a
   ticket to Done by hand uses the same command first (CLAUDE.md, "How we
   work", gets the rule).
3. **Audit: `pnpm release notes check`**: lists tickets in the release so
   far (section 3) without a note, and Done tickets of the last 30 days
   without one. For the owner's merges in GitHub's UI, which no script
   sees. The coordinator runs it after a batch of merges.
4. **At release: promote refuses** (section 4), in CI, without Linear.

Owner decision D2: keep Linear's automatic Done and gate at merge
(recommended: nothing changes in how tickets move), or turn the
automation off and have `pnpm release done CAR-NNN` move tickets after
checking the note.

## 3. Which tickets are in a release

- **The PRs**: the first-parent commits of master after the previous
  release tag up to the RC being promoted. Every PR lands as one
  first-parent commit whose subject is the PR's title and ends `(#N)`
  (checked: everything since v0.2.0 does). This needs only git, so CI can
  compute it with no token. (`releasePrs` in `scripts/release-lib.ts`
  asks `gh` for merged PRs and filters by ancestry; it stays for the PR
  list in the GitHub release.)
- **PR → tickets**: every `CAR-NNN` in the title (`(CAR-183)`, `CAR-113:`,
  `(CAR-66, CAR-171)`). The branch name (`car-172-174-…`) is not in git
  and is ambiguous (`car-38-custom-…`), so the title is the only source;
  `merge-ok` refuses a PR whose branch is `car-NNN-*` while its title names
  no ticket, so they can't drift. PR descriptions say `Fixes CAR-NNN`
  (CLAUDE.md), which `merge-ok` also compares with the title. The owner's
  machine can also cross-check
  Linear's PR attachments (CAR-183 has #110 attached); a mismatch is a
  warning in `pnpm release notes`.
- **Exempt PRs**: titles `next: X.Y.Z` (release-finish) and
  `notes: X.Y.Z` (section 4).
- **Ticket-less PRs** (#125 "Test processes stop…", and five open ones
  now): they need a note too, in the PR description, as a line
  `Release note: …` or `Release note: none (…)`, same rules (recommended;
  owner decision D4). `pnpm release notes` reads it with `gh`;
  `merge-ok` refuses without it. The alternative, every PR needs a
  ticket, is stricter but makes a ticket for every one-line CI fix.
- **A ticket in two releases** (its PRs landed on both sides of a tag,
  like CAR-175 or CAR-66): its note shows in the first release that
  ships any of its PRs. A later release lists it only if the ticket has a
  newer `Release note` comment than the one already released (a second
  user-visible part), else counts it as covered.

## 4. Collecting the notes into the repo

Linear is the source; the repo holds each version's snapshot, reviewed in
a PR. This is the only way the notes can be in the package: promote packs
the RC's commit as it is.

- **`release-notes/X.Y.Z.json`**, one file per version, committed:

  ```json
  {
    "version": "0.4.0",
    "date": null,
    "notes": [
      { "id": "CAR-183", "kind": "new", "prs": [110],
        "text": "Files changed has a Threads tab beside the file tree: every conversation, newest first." }
    ],
    "none": [
      { "id": "CAR-170", "prs": [116], "why": "flaky test fix" },
      { "id": "#125", "prs": [125], "why": "test tooling" }
    ]
  }
  ```

  `none` keeps every no-notes decision in the file too, so a check needs
  only the file. Order of `notes`: new, improved, fixed, then by first PR.
  `date` is set by the build of the release (promote), null before.
- **`pnpm release notes [X.Y.Z]`** (the coordinator's or the owner's
  machine, Linear key and `gh`): computes the release's PRs and tickets up
  to `origin/master`, reads each ticket's newest note (and ticket-less PRs'
  descriptions), validates, writes the file, prints what's missing, and
  with `--pr` opens a PR **"notes: X.Y.Z"** from a `notes/X.Y.Z` branch.
  It never writes to Linear.
- **The owner approves the wording in that PR.** A wording change goes
  back to Linear (a new comment, `pnpm release note`) and the file is
  written again, so Linear stays the one source; the coordinator does
  this from the owner's review comments.
- **When**: before every promote (rollout, step 4), and whenever the
  coordinator wants RCs to carry fresher notes. Merging it publishes an RC
  like any merge; that RC is the one to promote.
- **The release-time check, in CI with no Linear key**:
  `release.ts ci:notes-check X.Y.Z <rc sha>` in `promote-check` (no token
  there, as today) recomputes the release's PRs and tickets from git and
  fails unless every ticket and ticket-less PR is in the file's `notes` or
  `none`, naming what's missing and saying to run `pnpm release notes`.
  `pnpm release promote` runs the same check locally before dispatching
  (and, with a Linear key, warns when a note in Linear changed since the
  file was written).
- **A PR check?** Not needed for the gate (merge-ok and promote cover it),
  and it can't read Linear. Ticket-less PRs' `Release note:` line could be
  checked by CI from the event payload with no token; my call: leave it to
  merge-ok, revisit if the owner's own merges skip it.

## 5. Changelog format and what ships

- **`docs/changelog.md`**: release-finish's `ci:changelog` renders the
  section from `release-notes/X.Y.Z.json` instead of PR titles, still in
  the "next" PR (no Linear, no `gh`):

  ```markdown
  ## 0.4.0 (2026-11-20)

  ### New
  - Files changed has a Threads tab beside the file tree: every conversation, newest first. (CAR-183, #110)

  ### Fixed
  - …

  <details><summary>Every PR (14)</summary>

  - Test processes stop once the test that started them is gone (#125)
  - …
  </details>
  ```

  A version with no notes says `No user-facing changes.` Older sections
  (0.1.0–0.3.0) stay as they are.
- **In the package, two places** (both written by the build from the
  `release-notes/*.json` at that commit, so an RC and its release carry
  the same notes):
  - `dist/release-notes.json`: this version and every earlier release,
    newest first, with no version cap (owner, 2026-11-18: Global settings
    pages back through every older release, "all the way back"; local, so
    size is no concern; a 1 MB backstop). crb reads its own from here
    (Global settings), offline. `ci:set-version` leaves the full list in
    the checkout's git dir for the build, so it never reaches npm's
    manifest.
  - **A field in `package.json`**, `crbReleaseNotes`, with the newest of
    that data capped at the last 10 versions and 64 KB (oldest dropped first; the
    build fails if this version alone is over). `ci:set-version`, which
    already sets `version` and `gitHead` in the runner's checkout, writes
    it. npm keeps unknown `package.json` fields in each version's manifest
    (checked: `semver@7.6.0`'s manifest has its `tap` and `templateOSS`),
    so a crb can read a newer version's notes with one small request
    (section 6). To verify on the first RC: `npm view
    carbonless-review@<rc> crbReleaseNotes`.
  - For an RC, the entry for the upcoming version also lists the release
    range's PRs that have no note in the file yet (`uncovered: [131,
    129]`, from git at build time), so the modal can say "2 more changes,
    no notes yet". A release has none (promote refused otherwise).
- **GitHub releases** (recommended; owner decision D5): release-finish
  creates the GitHub release for `vX.Y.Z` (it has `contents: write`
  already) with the version's changelog section as its body. The toast's
  link and the modal's ↗ already point at `releases/tag/vX.Y.Z`, which
  today shows a bare tag. It matters for 0.4.0 in particular: a 0.3.0 crb
  has no modal and its toast links there. RCs get no GitHub release.

## 6. How a running crb gets newer notes

- **From npm, the version's manifest**: `GET
  <registry>/carbonless-review/<offered version>` (the registry crb
  already asks, `$CRB_NPM_REGISTRY` included; mirrors proxy full
  manifests), reading `crbReleaseNotes`. One request covers every version
  between, since the offered version carries the last 10. My call; the
  alternatives:

  | Source | For | Against |
  | --- | --- | --- |
  | npm manifest field (chosen) | Host crb already reaches for the check; small (a few KB); covers RCs; one request | Needs the build to write the field; npm could drop custom fields one day (then: error state, below) |
  | The newer tarball (`dist/release-notes.json`) | Same file crb ships | ~1 MB per fetch, tar parsing, for a few KB |
  | GitHub raw at the tag | Simple; RC tags exist | A new host for the server; some networks reach a registry mirror but not GitHub |
  | GitHub releases API | Rendered release text | Releases only, no RCs; unauthenticated rate limit |
  | unpkg / jsDelivr | Small reads | A third party in the path for no gain |

- **Server side**, never from the browser: `GET /api/update/notes`
  (new) answers the notes between `current` and `available`, prepared
  for the modal: versions newer than the running one, newest first; on
  the RC channel, for the upcoming version only the entries the running
  build doesn't have (by `id`, against its own `dist/release-notes.json`);
  `uncovered` with GitHub's compare link; `older: true` when the offered
  version's list doesn't reach back to the running one (then a "Older
  versions" link to GitHub's releases).
- **Fetched when an update is found**, so the modal usually opens with
  notes in place; kept in memory per offered version (a version's
  manifest never changes); fetched again on Retry or when the offered
  version changes. A failure is kept with its reason ("Registry timed
  out", "Registry answered 404", "No notes in this version") and never
  retried by itself more than once per check.
- **Untrusted input**: the manifest is read capped (256 KB, as the
  registry check caps at 64 KB), every field validated against the schema
  and text rules in section 1 (strings only, lengths, no control/bidi
  characters); a bad entry is dropped and the answer says how many were
  (shown as a `warn` line, "1 note couldn't be read": flag uncertainty).
  Text renders as React text (`code` spans as `<code>`), never HTML or
  markdown. Links are built by crb from validated numbers and versions
  (`#N` → the PR on GitHub, `releaseUrl`, the compare URL), never taken
  from the manifest. Tests send a note with `<img onerror>`, a
  `javascript:` link and a bidi override, and fail without the escaping.
- **Offline**: the update check needs the registry too, so an offer
  without notes means the registry went away in between. The modal
  says so with Retry and the release link; Update still works (or fails
  as it does today).

## 7. The modal

Mockups: `release-notes-mockups.html`.

- **Opened** from the toast's **What's new** (it replaces both the
  version link and the toast's Update; owner decision D3), and from
  Global settings ("Update available" row: What's new beside Update).
- **Global settings shows the running version's notes inline** (owner,
  2026-11-18: "include the release notes in the global settings page,
  below the version, a few lines with a 'show more' section"): under the
  Version row, the first 3 notes of the running version (from its own
  `dist/release-notes.json`, no network), each with its kind icon and
  `#N`, each note's first sentence only; **Show more** (40px, a chevron
  that turns) expands in place to every note in full and the version's
  earlier releases kept in the file, and turns into Show less. A version
  with no notes says "No user-facing changes"; a build without the file
  (a local build) shows nothing there. Long notes show their first
  sentence until expanded, in the modal too (the rest behind the same
  in-place Show more per note).
- **Shape**: as the agent modal, a centred `<dialog>` on a desktop
  (`min(34rem, 100vw - 2rem)`, `surface` inside `edge`, `shadow-float`), a
  bottom sheet on a phone (`shadow-sheet`). Escape, the backdrop and ✕
  (40px, tooltip "Close") close it; Tab stays inside; focus goes back
  where it was. The toast stays dismissible per version as now.
- **Header**: the download icon (`accent`), "What's new" (20px bold), the
  range in monospace `muted` ("v0.3.0 → v0.5.0"; on an RC, "rc.3 →
  v0.4.0-rc.5"; below 400px only "→ v0.5.0"), a fixed spinner slot, ✕.
- **Body** (scrolls inside the dialog): a section per version, newest
  first: the version (monospace, bold), its date (`RelativeTime`: short
  relative, exact date and zone on hover/focus; from `date` in the notes),
  and ↗ to its GitHub release (40px, tooltip "Release on GitHub"). Then
  one row per note: the kind's icon in `muted` (octicons `PlusCircleIcon`
  New, `ArrowUpIcon` Improved, `ToolsIcon` Fixed; each with a tooltip and
  accessible name), the text in `ink`, and `#N` in `faint` linking the PR.
  No colour for kinds (none is a review state; principle 6's colours keep
  their meanings). A version whose tickets all said none: "No
  user-facing changes" in `muted`. On an RC: "N more changes, no notes
  yet" in `muted` with a plus icon, linking GitHub's compare view.
- **Footer**, pinned below the list: **Update to vX** (`cta`, the primary
  action; full width, 44px on a phone), which runs the toast's existing
  flow (`useUpdateFlow`: asks about unsaved work, installs, restarts) and
  closes the modal; progress and failure stay in the toast as today. By
  hand: `ByHandWhy` ("No auto-update: …" with the FAQ link) and `Command`
  in place of Update, as the toast shows them today; the toast itself no
  longer shows the command.
- **Loading** (principle 8): skeleton bars where the notes go, the body
  `aria-busy`, the spinner in the header's fixed slot; never an empty
  list or "No user-facing changes" before the answer. Update is enabled.
- **Failed**: a `warn` notice in the body (only a part is missing):
  alert icon, "Notes didn't load: <reason>" (the reason in a tooltip on a
  phone), Retry, ↗ to the release on GitHub. Update is enabled.
- **Mobile**: works at 360px with no horizontal page scroll; notes wrap
  (`overflow-wrap: anywhere`), the command scrolls inside its box; every
  button 40px or more.
- `docs/design/README.md` gets a "What's new modal" entry next to the
  agent modal, and its Changelog a line.

## 8. 0.4.0, retroactively

Merged since v0.3.0 (git first-parent `v0.3.0..origin/master`, Linear,
read-only, 2026-11-16):

| PR | Ticket | Labels | Draft note (not approved) |
| --- | --- | --- | --- |
| #110 | CAR-183 (Done) | Feature, threads, mobile | new: Files changed has a Threads tab beside the file tree: every conversation, newest first, one tap to its line. |
| #125 | none | | none (test tooling) |
| #122 | (`next: 0.4.0`, exempt) | | |

Open PRs that will be in 0.4.0 if merged before promote:

| PR | Ticket | Likely |
| --- | --- | --- |
| #118 | CAR-38 (Feature) | new: changed images show before and after, with a per-file Show as switch |
| #120 | CAR-163 (Feature) | new: one agent conversation about the whole review, from the header chip |
| #121 | CAR-129 (flaky-test, Bug) | none (flaky test fix) |
| #123 | CAR-190 | none (release tooling) |
| #128 | CAR-191 | none (release tooling) |
| #130 | CAR-184 | fixed or improved: Ignore whitespace also applies to the verdict and the since view |
| #124, #126, #127, #129, #131 | none | each needs a `Release note:` line (D4); #126, #127 and #129 look user-facing |
| (this work) | CAR-192 | new: the update toast opens What's new, with Update below |

The list is computed again by `pnpm release notes 0.4.0` right before
promote; this table is a snapshot.

Plan: once the tooling (rollout steps 1–2) is merged, the coordinator
drafts every note from the tickets and the implementers' reports, sends the
owner one list to approve or reword (one message or one artifact), posts
the approved notes as comments with `pnpm release note`, and opens
"notes: 0.4.0". The owner's merge of that PR is the final approval of the
wording.

## 9. Tests

Unit (Vitest):
- Note parsing: marker forms, kinds and the label defaults, `none` with
  and without a reason (without: refused), many lines in one comment, newest
  comment wins (by `updatedAt`), every text rule (the 600-character bound, one line, the first sentence as the summary,
  control and bidi characters, ids in the text).
- Release range from git: first-parent subjects → PRs and tickets, several
  tickets in one title, `CAR-113:` prefixes, exempt `next:`/`notes:`, a
  ticket in two releases, a range with no PRs. Against a throwaway repo
  (`test/git-fixture.ts`).
- `ci:notes-check`: passes when covered, fails naming each missing ticket
  and PR, fails on a file of another version, on a malformed file.
- `merge-ok`: refuses a ticket without a note, a ticket-less PR without a
  `Release note:` line, a `car-NNN-*` branch whose title names no ticket,
  and a missing Linear key; Linear and `gh` faked.
- `pnpm release notes`: file written from faked Linear answers; missing
  notes listed; never a Linear write (the fake fails on any mutation).
- Build: `dist/release-notes.json` and the `package.json` field written,
  `crbReleaseNotes` capped at 10 versions and 64 KB, oldest dropped,
  `dist/release-notes.json` every version; `uncovered` on an RC.
- `renderChangelog` from a notes file: groups, the PR list, "No
  user-facing changes"; older sections kept.
- `scripts/release.test.ts`: no workflow gains a secret (a Linear key or
  any `secrets.*`), `promote-check` still has no token, release-finish's
  GitHub release step has the token only where it calls `gh`.
- Server `GET /api/update/notes`: a fake registry (as `registry.test.ts`)
  answering notes, a 404, a timeout, an answer over the cap, a manifest
  without the field, bad entries dropped and counted; the RC diff against
  the running build's own notes; `older`; the in-memory cache (one fetch
  for two reads), Retry fetching again.
- Web: the modal's loading state held (`test/loading.ts`) then loaded;
  the error state with Retry; by-hand footer; a note with markup and a
  `javascript:` text renders as text.

Playwright (desktop and phone projects; the fake registry the update
specs use):
- Toast → What's new → modal lists two versions newest first → Update
  installs exactly the offered version (the existing update flow).
- Loading held at the registry, then released: skeleton, then notes; the
  spinner's slot doesn't move anything (bounding boxes).
- Notes fail: warn notice, Retry loads them; Update still works.
- By hand: reason, FAQ link and command in the modal; no command in the
  toast.
- RC: "since rc.N" entries only, and the "more changes" line.
- Global settings: What's new opens the same modal; the running
  version's notes show under Version (3 first sentences), Show more
  expands to all of them and earlier releases, Show less folds back;
  a local build shows none; 360px fit.
- Phone: 360px, no horizontal page scroll, sheet's Update 44px, every
  control ≥ 40px.
- `pnpm flake-check` on the new specs (they hold answers).

## 10. Rollout

Tooling first, so 0.4.0's notes exist before it is promoted.

1. **Notes tooling** (on top of CAR-191's merge-ok): `pnpm release note`,
   `pnpm release notes [--pr]`, `notes check`, `merge-ok`'s note check,
   the CLAUDE.md rule, `docs/releasing.md` ("Release notes"). Nothing in
   CI yet.
2. **Build and release changes**: `release-notes/*.json` into
   `dist/release-notes.json` and `crbReleaseNotes`; `ci:notes-check` in
   promote; `ci:changelog` from the notes; the GitHub release in
   release-finish (if D5). The first RC after this merge is checked with
   `npm view … crbReleaseNotes` (with an empty `0.4.0.json`, which the
   check would refuse at promote, as it should).
3. **The modal**: `/api/update/notes`, the modal, the toast and Global
   settings changes, design README, tests. It ships in 0.4.0 but shows
   notes only to crbs from 0.4.0 on; 0.3.0 users get the GitHub release
   page from their toast (D5).
4. **0.4.0's notes**: the coordinator drafts, the owner approves, the
   notes are posted to Linear, "notes: 0.4.0" is merged; its RC is the one
   promoted.

Steps 1 and 3 are independent and can be built in parallel; step 2 needs
step 1's file format.

## Docs to update in the same changes

`docs/releasing.md` (release notes, the notes PR, the promote check, the
GitHub release), `CLAUDE.md` ("How we work": a note before merge),
`docs/design/README.md` (the modal), `docs/product-rules.md` (a short
rule: notes never gate an update; an RC's missing notes are shown, never
hidden), `docs/faq.md` if a question comes up (e.g. why an RC says "no
notes yet").

## My calls (open to change)

- Notes are snapshotted into `release-notes/X.Y.Z.json` by a script on a
  machine with the Linear key and reviewed in a "notes: X.Y.Z" PR; CI
  checks coverage from git and the file alone.
- The release range comes from git's first-parent subjects (no token), the
  ticket from the PR title only.
- crb reads newer notes from the npm manifest (`crbReleaseNotes`), server
  side, prefetched when an update is found; up to 10 versions back.
- Kind icons are neutral (`muted`); kinds are New, Improved, Fixed.
- Update moves into the modal; progress and failure stay in the toast.
  Global settings keeps its direct Update next to What's new.
- On an RC, show only what the running build didn't have, plus a count of
  changes without notes.
- A ticket spanning releases shows once, unless it gets a newer note.

## Owner decisions (answered 2026-11-18)

All seven taken as recommended. D4: "Let's support it though I don't
expect ticketless PRs to be a common thing". D2: "gating at the PR level
makes the most sense". Two changes from the review: no limit on note
lines or length beyond a sanity bound (section 1), and Global settings
shows the running version's notes with Show more (section 7).

### As asked

1. **D1: where the note lives in Linear.** Recommended: a comment starting
   `Release note (kind): …` or `Release note: none (why)`, newest wins.
   Alternatives: a description section; a label for "none" plus text.
2. **D2: when the gate runs.** Linear moves tickets to Done by itself when
   the PR merges (CAR-183: two seconds after #110). Recommended: keep that
   and gate at `pnpm release merge-ok` (before every agent merge), with an
   audit for your own merges and promote as the backstop. Alternative:
   turn the automation off and have a `pnpm release done` move tickets.
3. **D3: the toast's Update.** Recommended: the toast's one action becomes
   What's new; Update lives in the modal ("an update button below"), so
   updating is one click more. Alternative: keep Update on the toast too.
4. **D4: ticket-less PRs.** Recommended: a `Release note:` line in the PR
   description, same rules, checked by merge-ok and promote. Alternatives:
   every PR needs a ticket; or ticket-less PRs never get notes.
5. **D5: GitHub releases.** Recommended: release-finish creates the GitHub
   release with the version's notes (0.3.0 users' toasts link there).
   Alternative: tags only, notes only in `docs/changelog.md` and the app.
6. **D6: who approves wording.** Recommended: you, once per release, by
   merging "notes: X.Y.Z" (plus the per-PR note you see at merge time).
   Alternative: you approve each note when its PR merges, and the notes PR
   is a formality.
7. **D7: 0.4.0's ticket-less and tooling PRs.** Recommended: release
   tooling, CI and test PRs (CAR-129, CAR-190, CAR-191, #124, #125, #131)
   are `none`; #126, #127 and #129 get notes.
