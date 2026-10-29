# Editing and deleting your own comments

Status: approved by the owner 2026-10-27, with their doc comments folded in.

Calls the coordinator made (the owner may overrule): delete with an undo window (the owner then added a confirm dialog before it); a changed-on-GitHub check before an edit is saved; thread comments only (not PR conversation comments or review bodies); pending-review comments left as they are.

## Why

Milestone 2 replaces the owner's GitHub review workflow. Replies and resolving are in. The next step, by the owner's order, is editing and deleting your own comments, then starting new threads in Files changed. Approve / request changes comes later in the milestone.

## Goals

- **Edit** any comment you wrote in a review thread, wherever the thread is open: an Overview card (inside Show more) and Files changed.
- **Delete** any comment you wrote, from the same places.
- **Instant UI and the same notices** as replies and saves: the change shows at once, a yellow notice after 5 s with the reason, transient errors retry with backoff, red with the message and Retry on anything else.
- **Nothing typed is lost.** An edit in progress is a draft like a reply draft: it survives closing the thread, switching pages and a reload, shows in the Drafts filter, and leaving the page with one asks first.
- **"Edited" is visible** on every edited comment (anyone's), as on GitHub: a short "edited" after the time, with when on hover/focus.

## Non-goals (this stage)

- PR conversation comments and review summary bodies (they come with "new PR comments" later).
- Comments in a pending review (only you see them; GitHub's own UI handles them).
- Edit history (GitHub keeps it; carbonless shows only "edited" for now). Owner, for the future: "clicking on editing should show edit history" (`docs/todo.md`).
- Editing other people's comments, even where GitHub allows it (maintainers can).
- Markdown preview (plain text, as for replies).

## Anti-goals

- **Changing anything the reviewer didn't explicitly ask for.** One click per edit or delete, on one comment.
- **Overwriting a newer version unseen.** If the comment changed on GitHub since carbonless showed it (edited in GitHub's UI or another tab), the edit isn't saved over it silently.
- **A delete that can't be stopped by a slip of the finger.** Deleting is permanent on GitHub.

## What GitHub does (checked on the scratch PR, 2026-10-27)

- REST `PATCH /repos/{o}/{r}/pulls/comments/{id}` edits a comment; GraphQL then shows `lastEditedAt` and `includesCreatedEdit: true`.
- REST `DELETE /repos/{o}/{r}/pulls/comments/{id}` deletes one.
- GraphQL comments carry `viewerCanUpdate`, `viewerCanDelete` and `viewerDidAuthor`.
- **A pending review doesn't block either** (unlike replies): both worked with one open.
- **Deleting a thread's opener keeps the thread**: the next comment becomes its first, and replying still works (to the new first comment). Deleting its last comment removes the thread (its id no longer resolves).

## Editing

- Your own comments get a pencil icon button (tooltip "Edit", ≥40px) in their header, shown when `viewerCanUpdate` and writes are on. A small overflow is fine on a phone if the header is tight, as long as both actions stay one tap away.
- Edit swaps the comment's body for a textarea with its Markdown source, focused, sized to the text, with Save and Cancel. Ctrl/Cmd+Enter saves; Escape cancels when nothing changed and asks first when something did. Saving empty text isn't allowed (Delete is the way to remove it).
- On Save the new text shows at once, marked as saving (the clock, as for sending replies), and the textarea closes. It syncs through the thread-writes queue (per-thread order, so a reply then an edit land in that order) and its notices ("Edit", file:line or "PR comment").
- **Changed on GitHub (coordinator's call):** before saving, the server compares the comment's current body on GitHub with the body the edit started from. If they differ it refuses (409, `changed`): a red notice "Changed on GitHub since you opened it", the draft kept, with "Show theirs" (reload that comment, keep the draft) and "Save anyway". A retry of the same edit after an ambiguous failure counts as done when GitHub's body already equals the new text.
- An edit to a comment that is gone (404) says so, and the draft stays, so the text can be copied (as orphan reply drafts do).

## Deleting

- A trash icon button (tooltip "Delete", ≥40px) next to Edit, shown when `viewerCanDelete` and writes are on.
- **A dialog, then Undo (owner's call: "add a confirmation when deleting a comment, in addition to the undo"):** Delete first opens a small confirmation anchored to the button (`role="alertdialog"`, modal where the browser can): "Delete this comment?", and for an opener with replies "It stays as [deleted] in the thread."; Delete (red) and Cancel, Cancel focused. Escape, Cancel or a click outside closes it with nothing done, focus back on Delete. Confirmed, the comment collapses at once into a one-line "Deleted · Undo" row; the delete is sent after 5 s (`DELETE_UNDO_MS`). Undo within the window cancels it, and nothing reaches GitHub. Leaving the page during the window asks first. `prefers-reduced-motion`: no animation, same window.
- After the window it syncs through the same queue and notices ("Delete"). A retry that gets 404 counts as deleted.
- **Deleting the opener of a thread with replies edits it instead** (owner: "if deleting the first comment in a thread and there are more comments in the thread, it should instead be edited to say [deleted]"): its body becomes `[deleted]` (PATCH, same undo window and notices), so the thread keeps its opener, place and code. carbonless shows such an opener like any other comment of the viewer's, "[deleted]" as its text, with Edit, so it can be written back (owner, later: "it should look like a regular comment, and not like a deleted one, allowing for me to edit it back if I want"); Delete stays off on it while replies follow it. Deleting the only comment really deletes it, and the thread goes away. In the Overview it fades and leaves, as a resolved card moves; in Files changed its bubble goes.
- Counts, latest comment and the attention set are recomputed by the server from the new comment list, as after a reply.
- Deleting never changes review progress or cluster state (principle 2).

## Where it's off

As for replies: off in as-of views and with `--viewer` other than the `gh` login; on for merged and closed PRs and with `--head`. GitHub's `viewerCanUpdate`/`viewerCanDelete` decide per comment.

## Server and data

- `ThreadComment` gains `viewerCan: { update, delete }`, `editedAt: string | null` and its REST id (needed for PATCH/DELETE), from GraphQL (`viewerCanUpdate`, `viewerCanDelete`, `lastEditedAt`, `databaseId`).
- New endpoints (shapes left to the builder), e.g. `PATCH /api/threads/:id/comments/:commentId` `{ body, from }` and `DELETE /api/threads/:id/comments/:commentId`, each answering `ThreadUpdate` (or a "thread gone" answer when the last comment was deleted). The same per-thread serialization, error mapping (400, 403, 404, 409 `changed`, 502 transient, 503) and cache updates as replies.
- The fake gh gains PATCH and DELETE with state, failures and delays; `docs/product-rules.md` "Writing to GitHub" lists the new writes.

## Tests

- Unit: edit draft kept and restored; save shows the new text at once; changed-on-GitHub refusal keeps the draft, "Save anyway" overwrites; a retried edit that already landed isn't sent twice; delete undo within the window sends nothing; delete after the window; 404 on delete counts as done; deleting an opener with replies PATCHes it to `[deleted]`; last comment deleted removes it; edit/delete hidden without `viewerCan` and in as-of/`--viewer`.
- Playwright, desktop and phone, on the fake gh: edit and delete from an Overview card and from Files changed; Undo; an edit survives a reload; "edited" shows.
- Real-GitHub check on the scratch PR only: edit, the changed-on-GitHub case (edit in GitHub's UI meanwhile), delete a reply, delete an opener with replies (becomes `[deleted]`), delete a thread's only comment.

## Left to the builder

The exact layout of the icons and the edit form within the design tokens and principles 5–6; endpoint shapes; how the edit draft is keyed (by comment id).
