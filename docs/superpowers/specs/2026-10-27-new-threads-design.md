# Starting new threads: on a span, on lines, on a file

Status: approved by the owner 2026-10-28, with their doc comments folded in.

Calls the coordinator made (the owner may overrule) are marked **(call)**.

Mockups: https://claude.ai/artifact/Fjmc4WwwFKKBLEGCiRHdfn

## Why

Milestone 2 replaces the owner's GitHub review workflow. Replies, resolving, editing and deleting are in. Next, by the owner's order, is starting new threads from Files changed. Approve / request changes comes after.

The owner's words:

> "1) I want to be able to add a comment on any span in the code, not just an entire line (though gh doesn't support it and will show only line comments)
> 2) in the future, we'd like to have more types of conversation over snippets of code. so for now selecting text should enable adding a comment to it, but it should be open to asking claude a question about it for example
> 3) need to be able to add a comment on a file too - empty, binary, etc."

## Goals

- **Comment on any span:** select any text in the diff, from a few characters inside one line to a range across lines, and comment on it. GitHub gets the whole lines; carbonless keeps and shows the exact span.
- **Comment on lines** without selecting text: tap or drag on line numbers.
- **Comment on a file:** every file, whatever its kind: text, empty, binary, renamed-only, mode-only, deleted or a submodule.
- **Selection opens actions, not just a comment box.** "Comment" is the first action. The shape takes "Ask Claude" and other conversation kinds later without reworking the selection or the anchor.
- **The lines carbonless marks are exactly GitHub's lines** (owner: "the review line that was marked is exactly the same one as appears in github"). A thread's highlighted lines in carbonless are the lines GitHub shows for it, for new threads and existing ones; the span always sits inside them. What carbonless sends is what it then reads back and shows, and the real-GitHub check compares them (`pnpm compare-threads`).
- **Same feel as replies:** the new thread shows at once (the clock while sending); a yellow notice after 5 s; transient errors retry with backoff; anything else is red with the message and Retry. The draft is never lost: it survives a reload, shows in the Drafts filter, and leaving with one asks first.

## Non-goals (this stage)

- Asking Claude, or any kind besides a GitHub comment. Only the extension point is built now.
- Pending reviews, batching comments into a review, approve / request changes (the next stage).
- Comments in the Overview's code windows (threads start in Files changed).
- Markdown preview and suggestion blocks (plain text, as for replies).

## Anti-goals

- **A comment landing somewhere other than where the reviewer pointed.** If carbonless can't map the selection to the exact GitHub lines, it doesn't offer Comment there (with a tooltip saying why). It never guesses a nearby line.
- **A comment silently joining the reviewer's pending GitHub review.** GraphQL's `addPullRequestReviewThread` does exactly that when one is open (checked; see below), so it is not used.
- **Selecting text breaking copy.** Selecting and copying code works as before; the action bar sits beside the selection and doesn't steal it.
- **Any change to review progress** (principle 2). Commenting never marks, hides or reorders anything.

## What GitHub does (checked on the scratch PR, 2026-10-27; probe comments deleted)

- REST `POST /repos/{o}/{r}/pulls/{n}/comments` with `commit_id`, `path`:
  - a single line: `line` + `side` (`RIGHT` or `LEFT`): works;
  - a range: `start_line`/`start_side` + `line`/`side`: works;
  - a file: `subject_type: "file"`, no line: works (GitHub reports line 1).
- A line that isn't in the diff is refused: 422, "pull_request_review_thread.line could not be resolved".
- **With a pending review open, REST refuses** (422, "user_id can only have one pending review per pull request"), like replies. **GraphQL `addPullRequestReviewThread` instead adds the comment to the pending review** (state PENDING, invisible to others). REST only.
- An HTML comment in the body (`<!-- … -->`) doesn't render on GitHub but stays in the body's source.

- **Lines resolve against `merge-base...commit_id`** (checked on gallery #8, 2026-10-28; probes deleted). `commit_id` may be an older commit of the PR (accepted, and moved forward to the head when the line is unchanged). A `LEFT` line is always the merge base's line: a line that exists only in one commit's own diff is refused (422). So GitHub has no line comment on a custom left side (a commit range or an interdiff).

Still to check, by the builder (gallery #4 has every file kind; comments there are allowed and get deleted after): file comments on a binary, an empty, a renamed-only and a deleted file; a line in expanded context outside any hunk (accepted or 422); a range that starts on `LEFT` and ends on `RIGHT`.

## The anchor: one shape for every kind of conversation

A **code span** is what a selection produces and what every conversation kind starts from:

- `path`, `commit` (the snapshot head);
- `start` and `end`, each `{ side, line, col }`. `col` is a UTF-16 offset into the line's text, `end` exclusive. A whole-line selection has `col` null at both ends;
- or `subject: "file"` with no lines.

It extends the existing `CodeAnchor` (`src/shared/types.ts`) with the two optional columns; nothing that reads anchors today changes.

**Carrying the span on GitHub (call):** GitHub stores lines only, so the span's columns ride in a hidden marker at the end of the body, `<!-- crb:span 3:9-5:24 -->`. Anyone using carbonless sees the span; GitHub shows the lines and hides the marker. The marker also carries the write's client id, which a retry uses to find the comment it may already have posted. carbonless strips the marker from what it shows, and an edit keeps it.

Why not store spans in `refs/crb`: that would put per-thread data in git, which other reviewers only see after a push and fetch (principle 3). The marker travels with the comment. The catch: someone editing the comment in GitHub's UI sees the marker's source text and may delete it. Then the thread falls back to its lines.

Owner: "It's a good first step. In the future we'll have to store things in our git refs and we'll probably use something along the lines of git-appraise, but this allows us to defer this work for later." (`docs/todo.md`, Future plans.)

## Selecting

- **Text in the code cells**, in any diff row (added, deleted, context, expanded context, whitespace `~` rows), within one file. The selection runs from where it starts to where it ends, across rows and sides. Line numbers and signs are already `select-none`, so they are never part of the text.
- **Line numbers:** clicking (or tapping) a line number selects that whole line; shift-click, or dragging down the numbers, extends the selection. A second tap on a phone extends (call: phones make native drag-selection fiddly).
- **Mapping to GitHub:** the selection's first and last rows give `start_side`/`start_line` and `side`/`line`: the new number for added and context rows, the old number for deleted rows. Context rows count as `RIGHT`. The side comes from the cell the selection is in, not the row: the planned side-by-side view (`2026-10-28-side-by-side-diff-design.md`) puts an old and a new line in one row, so a mapping keyed on the row would have to be redone.
- **Pinned heads (`--head <sha|reviewed>`):** the comment goes to the pinned commit (`commit_id`). Its `RIGHT` lines are that commit's lines. Its `LEFT` lines are GitHub's merge base for that commit, and carbonless's left side is `merge-base(origin/<base>, pinned)`; these are normally the same commit. The server checks (GitHub's compare `base...pinned` gives its merge base): when they match, `LEFT` works as anywhere; when they differ (the base was merged into the PR after the pinned commit), Comment is off for selections touching `LEFT` lines, with the reason as the tooltip.
- **Custom left sides** (owner asked: "Can't we have a custom LEFT? Github technically allows you to compare any subset of commits in the PR"): checked, GitHub's API can't anchor a comment to a range's left side (above). carbonless has no range view yet; when it gets one, its `RIGHT` lines that are also in GitHub's diff at that commit can carry GitHub comments, and the rest becomes a case for carbonless's own threads stored in git (the git-appraise direction). `docs/todo.md`, Future plans.

## The action bar (the extension point)

- When a selection ends (mouse up, keyboard selection, or the phone's selection settling), a small floating bar appears next to its end with one icon button per available action, each ≥40px with a tooltip. On a phone it is a bar pinned to the bottom of the screen, above the system's own selection menu.
- Actions come from a registry: `{ id, icon, label, available(span) → true | reason, start(span) }`. This stage registers one action, **Comment**. "Ask Claude" later registers another and gets its own spec: where its answers live, what it may see. When an action isn't available its button stays visible, disabled, with the reason as its tooltip (for example "GitHub only takes comments on lines in the diff").
- Keyboard: with a selection, `c` starts a comment. The bar's buttons are reachable with Tab, and Escape dismisses the bar.

## Keyboard shortcuts (owner: "In general I'd like to support keyboard shortcuts as a rule in the system. When clicking ? in the main screen, it should open a modal with the shortcuts help, similar to gmail.")

- **A rule from now on:** every frequent action gets a keyboard shortcut where it makes sense, registered in one place so it shows in the help (`docs/product-rules.md`).
- **One registry** in the web app: each shortcut has its key, a short label, a group (Global, Files changed, Overview, Threads) and when it applies. Shortcuts never fire while typing in a text field (except the field's own: Ctrl/Cmd+Enter, Escape) and never shadow the browser's own (Ctrl/Cmd+C copies).
- **`?` opens the help**: a modal listing every shortcut by group, keys shown as key caps, the ones that apply to the current page first. Escape or `?` closes it. On a phone it is reachable from the header's menu (no keyboard), as a full-height sheet.
- This stage registers `?`, `c` and the shortcuts the app already has (the builder lists them from the code). New shortcuts for existing actions (next file, mark reviewed…) are a later stage.
- Pressing the bar's button doesn't clear the selection before the action has the span.

## Commenting

- Comment opens a new-thread composer right under the span's last line (where a thread's row would go). It is a reply box with no previous comments, and the span is highlighted. Ctrl/Cmd+Enter posts; Escape cancels and asks first if text was typed.
- **The span shows.** In Files changed, a new or existing thread with a marker paints its exact characters: a stronger accent wash on the selected text, on top of `thread-mark` on its lines. A thread without a marker (made on GitHub) shows its lines as today. The same holds in the thread's code window in the Overview and in Files changed. When the code moved on and the columns no longer fit the line (outdated, or edited on GitHub), the thread falls back to lines.
- **Draft:** keyed by a client id and stored with its span, like a reply draft. It counts in Drafts, survives a reload and a refresh, and reopens at its span. If its lines are gone after a refresh (the head moved), the draft stays in Drafts as an orphan, with its text and where it was, so nothing typed is lost.
- **Posting:** the thread appears at once with the clock. It syncs through the thread-writes queue and notices ("New comment", file:line or file), with the same error mapping as replies: 400, 403, 404 (the file or line is gone), 409 for a pending review (the same warning and link as replies), 502 transient, 503. A retry first looks for a comment carrying its client id before posting again.
- After posting, it is an ordinary thread: reply, resolve, edit and delete work, and it shows in the Overview's Unresolved list.

## Commenting on a file

- Every file header gets a comment icon button (tooltip "Comment on file", ≥40px), in every kind of file and whether the file is expanded or not. It opens the composer in the header's threads area, where file threads already show.
- It posts with `subject_type: "file"`. If GitHub refuses a file comment on some kind of file (to be checked), the button is disabled there with GitHub's reason.

## Where it's off

As for replies: off in as-of views and with `--viewer` other than the `gh` login; on for merged and closed PRs (GitHub allows it) and with `--head` (`LEFT` lines only where GitHub's merge base matches, above). The selection bar still appears where Comment is off, so later actions like Ask Claude aren't tied to GitHub writes. Its Comment button is then disabled with the reason.

## Server and data

- `CodeAnchor` gains optional `startCol` and `endCol`. `ReviewThread` gains `span` (parsed from the opener's marker, or null), and the marker is stripped from bodies the server sends.
- A new endpoint, for example `POST /api/threads` `{ clientId, path, commit, start, end | subject: "file", body }`, answering the new `ReviewThread` (shape left to the builder). It posts through REST `pulls/{n}/comments`, the error mapping and pending-review handling are shared with replies, and the cache is updated as after a reply.
- The fake gh gains create (line, range, file), refusing with 422 under a pending review and for lines outside the diff, with `failNext` and delays. `docs/product-rules.md` "Writing to GitHub" and CLAUDE.md's list of writes add new comments.

## Tests

- Unit:
  - selection → span mapping for added, deleted, context and expanded rows, across sides, inside one line, and across a highlighted token boundary and an invisibles marker;
  - with `--head`, `LEFT` lines on when GitHub's merge base matches carbonless's left side and off (with the reason) when it doesn't;
  - the `?` help lists every registered shortcut; shortcuts don't fire while typing; `c` with a selection starts a comment;
  - the marker written, parsed and stripped, and kept through an edit;
  - the draft kept, restored and orphaned;
  - a retry finds the comment by client id;
  - a pending-review refusal keeps the draft;
  - a file comment;
  - the registry's disabled reasons.
- Playwright on the fake gh, desktop and phone:
  - select a span and comment; the span is painted after a reload;
  - select lines by line numbers and comment;
  - comment on a binary file and on an empty file;
  - the draft survives a reload;
  - the pending-review warning.
- Real GitHub on the scratch PRs only:
  - a span inside one line, a multi-line range and a range across sides;
  - a file comment on each file kind in #2;
  - a comment with a pending review open (refused, nothing pending created);
  - edit the comment in GitHub's UI and see the marker kept or the thread falling back.

## Left to the builder

- The bar's exact look and placement within the tokens and principles 5–6.
- The endpoint shape.
- How the DOM selection maps to columns: offsets from `CodeLine`'s pieces, perhaps via data attributes.
- The marker's exact syntax, as long as it is an HTML comment at the end of the body.
