# Final Verdict: what blocks the merge, and approve / comment / request changes

Status: approved by the owner 2026-11-01, with two changes from their doc comments folded in (a Comment verdict; one blocker list).

Calls the coordinator made (the owner may overrule) are marked **(call)**.

Doc (for comments): https://claude.ai/artifact/XeXueZHxuNREp8u3pmrXti

Mockups: https://claude.ai/artifact/WJkYZwPYYYL69R3sEJu2ve

## Why

Milestone 2 replaces the owner's GitHub review workflow. Threads, replies, resolving, editing, deleting and new comments are in. The one GitHub action still missing is the review verdict: Approve or Request changes. After this comes re-review after new pushes.

The owner's words:

> "I imagined a third tab for the PR, e.g. "Final Verdict". It should have all blockers to merging the PR, e.g.: checks that aren't passing, comments that are unresolved, and remaining approvals. This should allow us to approve or request changes.
> Additionally, in the files changed view, after all of the files, we should have a "final verdict" small section as well, which allows to select either "Approve the PR" or "Request Changes"."

> "approving/requesting changes can be done regardless of the state of the review. the reviewer isn't obligated to go over all the files, and he can approve with comments, implying he's ok with the pr being merged once his comments are resolved, without a rereview."

> "i usually just press the button. let's add a checkbox "include a message" that if clicked opens a text box."

## Goals

- **A third tab, "Final Verdict"**, next to Overview and Files changed, answering: what stands between this PR and merging, and what is my verdict?
- **GitHub's status first**: one prominent line saying whether GitHub would let the PR merge now (ready, blocked or waiting).
- **One list of blockers** (owner, 2026-11-01: "There should be 1 list of blockers, but it should be clear which are mandatory by github and which aren't"), each with where to deal with it. The ones GitHub requires come first, tagged "Required by GitHub"; the rest are plainly not required:
  - checks failing or still running (required ones first, when GitHub says which are required);
  - unresolved review threads (count, each linking to the thread on the Overview);
  - approvals still missing: what the repo requires (count, code owners) against who has approved, plus requested reviewers who haven't answered and reviewers whose latest verdict is "changes requested";
  - merge conflicts with the base, the base having moved on when the repo requires up-to-date branches, and Draft state.
  - When neither GitHub nor our list has anything, a single green "Ready to merge" line.
- **Approve, Comment or Request changes**, sent to GitHub as one submitted review, from the tab and from a small verdict section after the last file in Files changed. Each button's tooltip says what it means (owner, 2026-11-01, verbatim):
  - Approve: "Allow merging after remaining comments are resolved"
  - Request changes: "Disallow merging without another review"
  - Comment: "No approval, but approval by someone else acceptable"
- **Always allowed, whatever the review state.** Unreviewed lines, open threads and failing checks never block or warn the verdict. Approving with open comments means "fine to merge once these are resolved, no re-review".
- **No message by default.** An "Include a message" checkbox opens a text box; unchecked, nothing is sent as the body. GitHub refuses Request changes and Comment without a body, so pressing either with the box unchecked ticks it and focuses the text box; it sends once there is text (owner, 2026-10-31). Approve stays one click.
- **Same feel as the other writes:** the verdict shows at once with the sending clock, a yellow notice after 5 s, transient errors retried, a refusal listed in the always-on "not posted" chip (brief U) with Retry / Drop, and the leave guard asking while one is unsettled.

## Non-goals

- Merging the PR, or enabling auto-merge. The tab says "Ready to merge" and links to the PR on GitHub **(call)**.
- Batching the reviewer's new comments into the review. Comments stay single writes, posted as they are made (new-threads spec); the verdict is its own review.
- Dismissing other people's reviews, re-requesting reviews, editing CODEOWNERS or branch rules.
- Submitting or discarding a pending review the reviewer started on GitHub.

## Anti-goals

- **A verdict landing that the reviewer didn't press.** One press, one review. A retry never posts a second review.
- **A verdict silently joining or submitting the reviewer's pending GitHub review.** If one exists, the verdict is refused with the same "pending review" notice and link as replies, and nothing is sent.
- **Coverage ever looking more complete because of a verdict** (principle 2). Approving marks nothing reviewed and hides nothing.
- **Gating the verdict on carbonless's own progress.** The page may show progress as information, never as a condition.
- **A blocker list that claims "ready" when it can't know.** If GitHub doesn't tell carbonless what the repo requires (no access to branch rules), the list says the requirement is unknown rather than leaving it out.

## The Final Verdict tab

Order, top to bottom:

1. **GitHub's status, prominent** (owner: "github's final verdict should appear in prominence and it should be clear why, but our blockers should appear as well"). A line from GitHub's own facts (`mergeStateStatus`, `reviewDecision`, required checks, `mergeable`, Draft): "GitHub: ready to merge" (green), "GitHub: blocked" (red) or "GitHub: waiting" (yellow, only required checks still running). The why is the list right under it.
2. **Blockers, one list** (owner, 2026-11-01). GitHub's requirements first, each tagged "Required by GitHub" and red while unmet: "Required check failing: jira / jira_status_check", "Review required", "Changes requested by ravi", "Conflicts with main", "Branch is behind main", "Draft". When the rule can't be read, these come from what GitHub does report (`reviewDecision`, required check flags, `mergeStateStatus`). Then the rest, untagged and yellow, never red, so they never read as GitHub blocking: everything a careful reviewer would want settled even when GitHub allows the merge. Each row carries its kind's icon (check, thread, person, branch). An item is in the list once: a failing required check is a required row, not also a check row. What the rows say, by kind:
   - **Checks:** failing (red if required, else yellow), running (yellow), each with its name and a link to the run; passing ones folded into one "N passing" row at the end.
   - **Threads:** "N unresolved", expanding to one row per thread (file:line or file, opener, last reply, time) linking to the thread on the Overview; the reviewer's own threads first **(call)**. Bot threads count separately, as on the Overview.
   - **Approvals:** "1 of 2 approvals" from the repo's rule, code-owner approval when required (which owners are still missing), requested reviewers with no answer, reviewers whose latest verdict requests changes. GitHub's own `reviewDecision` (APPROVED / REVIEW_REQUIRED / CHANGES_REQUESTED) is the source of truth for the summary; the detail rows explain it.
   - **Branch:** conflicts with the base; behind the base when the rule requires up-to-date; Draft.
3. **Reviews** (owner, 2026-11-01: "verdict screen should list all existing approvals separately, as well as my own verdict"): one row per reviewer, the viewer's first and marked "you", then the others newest first, bots apart: the state's icon and colour, the name linking to the review on GitHub, when, "earlier push" when on another commit. The header counts approvals and change requests. No reviews: no section. Approvals aren't repeated in the blockers' green summary row; a change request stays a required blocker too. Not on the Files end card.
4. **Your verdict:**
   - The reviewer's current verdict on GitHub if any ("You approved 2 h ago at abc1234"), with the note when it was on an older head ("on an earlier push").
   - Three buttons, **Approve** (green), **Comment** (neutral) and **Request changes** (red), icon + short text, ≥40px, each with its tooltip (Goals).
   - **Include a message** checkbox; when checked, a text box (same editor as replies, drafts kept across reloads like replies) appears under it and is sent as the review body.
   - Information only, small and muted: "You reviewed 120 of 340 lines", "2 of your threads are open" **(call: shown, never blocking)**.
   - On the reviewer's own PR, Approve and Request changes are disabled with a tooltip ("Authors can't approve their own PR"), as GitHub refuses them; Comment stays on (GitHub accepts a COMMENT review from the author).
   - In as-of and `--viewer` views, where writes are off, the buttons are disabled the same way the reply box is.

## The verdict section at the end of Files changed

After the last file, a compact card: the reviewer's current verdict if any, the three buttons, and the "Include a message" checkbox with its box. It is the same component as on the tab, without the blockers. The phone's floating Files button must not cover it (extra room at the list's end, as brief S did for the selection bar).

## Writing the verdict

- REST `POST /repos/{o}/{r}/pulls/{n}/reviews` with `event: APPROVE | COMMENT | REQUEST_CHANGES`, `commit_id` = the head the reviewer is viewing **(call: the viewed head, so GitHub records what was actually reviewed; on `--head reviewed` or a pinned snapshot that is an older commit, and the card says so before sending)**, and `body` only when the message box is used (always, for Comment and Request changes).
- A pending review by the viewer makes GitHub refuse: checked on carbonless-scratch 2026-10-31, `POST …/reviews` with an `event` while the viewer has a PENDING review returns 422 "User can only have one pending review per pull request" and posts nothing. So GitHub itself guards the anti-goal; carbonless shows the existing pending-review notice and lists the verdict in the "not posted" chip. No pre-send check is needed.
- GitHub requires a `body` for `REQUEST_CHANGES` and `COMMENT` (REST docs), so neither is sent without text (Goals).
- **Retry safety:** before resending, carbonless reads the viewer's reviews and treats one with the same event, submitted after the first attempt started, as the landed verdict. A body carries the hidden `crb:v1` marker with the client id (as new threads do) when there is one.
- The new verdict replaces the shown one at once (optimistic), with the sending clock; Overview's "Who's on it", the Timeline and the tab update when GitHub's answer comes back.
- **Switching to Comment** (owner, 2026-11-01: "if i request changes and then want to switch it to a comment, it doesn't switch"): GitHub keeps the latest APPROVED or CHANGES_REQUESTED review through later comments, so Comment over the viewer's standing one posts the comment, then dismisses that review ("Changed to a comment"). Comment's tooltip adds "Replaces your approval" / "Replaces your request for changes"; a refused dismissal answers success with `stillStands` and a yellow notice, never "not posted" (`docs/product-rules.md`, "Writing to GitHub").
- The fake gh gains `pulls/{n}/reviews` POST (and GraphQL fields below) so every case is testable without GitHub.

## Reading what blocks

New reads, in the Overview's existing GraphQL call where possible so no extra round trip is added on first open (product rule on first-open performance):

- `reviewDecision`, `mergeStateStatus` (BLOCKED / BEHIND / DIRTY / UNSTABLE / CLEAN / DRAFT / HAS_HOOKS / UNKNOWN);
- per check, `isRequired(pullRequestNumber:)` on the status-check rollup contexts;
- the base branch's rule: `requiredApprovingReviewCount`, `requiresCodeOwnerReviews`, `requiresStrictStatusChecks`, from branch protection and repository rulesets, read lazily for the tab only. These may be unreadable without push access; then the approvals row shows GitHub's `reviewDecision` alone and says the exact count is unknown.
- **On the owner's repos the rule is usually unreadable** (builder check on a work repo: push access, not admin; protection 404, `branchProtectionRules` and `rules/branches` come back empty, `GET /branches/<base>` says only `protected: true` and the required check names). An empty rules list on a protected branch therefore means "unknown", not "none". Then the approvals row is GitHub's `reviewDecision` ("Review required" / "Changes requested" / "Approved") with who approved and who's still asked, without "N of M" **(call: no per-repo setting for the count; GitHub's decision is enough)**.
- Required checks: the overview reads checks through `gh pr view --json statusCheckRollup`, which has no `isRequired`; the tab adds a GraphQL read of the rollup contexts with `isRequired(pullRequestNumber:)` (readable with push access).
- Code owners still missing: from requested reviewers that GitHub marks as code-owner requests (`asCodeOwner`), not by parsing CODEOWNERS **(call)**.

## As-of views, merged and closed PRs **(call)**

- **As-of:** checks and threads as of the cutoff (as the Overview does today); approvals from the reviews submitted before the cutoff; GitHub's present-only facts (`reviewDecision`, `mergeStateStatus`, required flags, rules) are left out, not shown as of now. The status line says "As of <date>" instead of Ready/Blocked. Buttons disabled, as for every write in as-of.
- **Merged or closed:** the status line says "Merged" or "Closed"; blockers are not listed; the reviewer's verdict is shown and the buttons are disabled (GitHub would accept a review on a closed PR, but it has no effect on merging).

## Phone

The tab bar has three tabs at 360px: short labels ("Overview", "Files", "Verdict") **(call)**, icons with tooltips and accessible names as today. The three verdict buttons share one full-width row, icon over a short label ("Approve", "Comment", "Changes") **(call)**. Every target ≥40px; no horizontal page scroll.

## Tests

- Unit: blocker list from GitHub facts (each status, required vs not, rules unreadable → "unknown", nothing blocking → ready); verdict write (event, commit, body only when included, marker), retry finds the landed review and doesn't post twice, pending review refusal, author's own PR allows only Comment, Comment and Request changes never sent empty, as-of/viewer disabled.
- Playwright desktop and phone with the fake gh: open the tab, see each kind of blocker; approve without a message → "You approved" and the Overview's reviewer list updates; comment and request changes with a message; the tooltips; a refused verdict goes to the chip and Retry lands it; the Files changed end card works and isn't covered on the phone; the tab bar fits at 360px.
- Gallery: a `verdict` case with failing and running checks, unresolved threads, a requested reviewer, a changes-requested review and a code-owner rule if the gallery repo can have one (branch protection on the playground repo is approved as a GitHub write there). The scratch PR is where the owner presses the real buttons.

## Left to the builder

Component structure, how the tab's reads are cached and refreshed (the existing Refresh button refreshes it), exact copy within the icon-first rules, the order inside each blocker group beyond what's stated.
