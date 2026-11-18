# Preview for comment boxes (CAR-202)

## Why

The owner (2026-11-18):

> "can you please make the review textbox have a toggle for a "preview" mode
> that shows how it will look like? Do the same for regular comment threads
> as well. This is important because AI comments use markdown more heavily"

Every crb box whose text is posted to GitHub gets a **Write / Preview**
toggle. Preview shows the text rendered the way crb shows a posted GitHub
comment, so the reviewer sees what they are about to post.

## Owner decisions (2026-11-18)

1. **Which boxes.** The agent's suggested comment (CAR-83) and the regular
   comment boxes.
2. **Default mode** ("your suggestion sounds right"):
   - The agent's suggested comment opens in **Preview**. It is markdown the
     reviewer didn't write, so they read it first.
   - The reviewer's own boxes open in **Write**.

## Which boxes (my calls marked)

| Box | File | Opens in |
|---|---|---|
| Agent's suggested comment | `src/web/agent/AgentComment.tsx` | Preview |
| Reply, in reply mode | `src/web/threads/ReplyBox.tsx` | Write |
| New thread | `src/web/threads/NewThread.tsx` | Write |
| Editing your own comment | `src/web/threads/CommentEdit.tsx` | Write |
| The verdict's review message (my call: it posts to GitHub as markdown too) | `src/web/verdict/VerdictCard.tsx` | Write |

Not covered: boxes whose text goes only to the agent, never to GitHub
(Ask agent in `ReplyBox`, `AgentComposer`, the review drawer's box). When
`ReplyBox` switches to Ask agent, the toggle hides and the box is in Write.

## What the reviewer sees

- **The toggle:** a segmented pair of icon buttons, pencil (**Write**) and eye
  (**Preview**), each with a tooltip and an accessible name, each at least
  40px. It sits in the box's own button row:
  - beside the send button in the reply row;
  - in the header row of the agent's box, left of the reset button;
  - in the action row of the new-thread, edit and verdict boxes.
- **Toggle on a closed reply box** (one line, nothing typed): hidden (my
  call). It shows once the box has text, since an empty box has nothing to
  preview.
- **Preview:** the rendered comment in place of the textarea. It is at least
  as tall as the textarea it replaces, so switching never moves what's
  below. It grows with content up to the box's max height and then scrolls.
- **Keyboard** (my call, as on GitHub): Ctrl/Cmd+Shift+P switches mode.
  Pressing Write focuses the textarea with the cursor where it was.
- **Sending from Preview works:** Reply, Comment, Save, Add review comment
  and the verdict's submit all stay as they are, and post the same text.
- **Mode isn't saved:** each box opens in its default after a reload.
  Drafts are unchanged.
- **The agent's box while locked** (sending or "may have landed", CAR-83):
  either mode can be shown; Write stays read-only, as today.
- **The Posted row** of the agent's box is unchanged: it is already
  rendered.

## How it renders

One shared component, e.g. `src/web/CommentPreview.tsx`:

- **Pipeline:** `marked(escapeTags(text))`, then `GithubHtml`, which
  sanitizes via `sanitizeGithubHtml`. This is the path the agent box's Posted
  row already uses; it moves into the shared component and the Posted row
  uses it too.
- **Same as posted:** the preview escapes the text with `escapeTags`, as the
  server does before posting. So a literal `<details>` in the text shows as
  text in the preview, as it will on GitHub.
- **Out of scope:** GitHub-only rendering: @mentions and #123 links, emoji
  shortcodes, ```suggestion blocks. They show as plain markdown.

## Principles

- **Principle 5:** at 360px the toggle and send button fit on one row with
  the box, with no horizontal scroll and 40px targets.
- **Principle 6:** icons with tooltips, design tokens only, no "Nothing to
  preview" text. The toggle hides when the box is empty.
- **Principle 8:** rendering is synchronous, so there is no loading state.
- **Sanitization:** the preview is HTML built from the reviewer's or the
  agent's text. A test with `<img src=x onerror=…>` and `[x](javascript:…)`
  must fail without the sanitizer.

## Tests

**Unit** (`CommentPreview`, and each box):
- markdown renders: a heading, a list, code, a table, a link;
- script, `onerror` and `javascript:` links are stripped;
- the toggle's default per box;
- toggling keeps the text and the draft;
- send works from Preview;
- the toggle is hidden in Ask agent mode and on an empty reply box;
- Ctrl/Cmd+Shift+P switches mode.

**e2e** (desktop and phone):
- the agent's box opens in Preview with rendered markdown; Write shows the
  raw text; an edit shows up in Preview; Add review comment posts the edited
  text;
- a reply typed in Write, previewed, then sent: the fake gh gets the text;
- switching doesn't move the content below (the box's bottom edge stays
  put, ±1px, when Preview content is shorter);
- 360px: no horizontal scroll, and the toggle is 40px.

## Docs

- `docs/product-rules.md`, "Writing to GitHub": every box that posts to
  GitHub has Preview; the agent's box opens in it.
