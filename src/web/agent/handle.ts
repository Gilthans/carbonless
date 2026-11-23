/**
 * The agent's handle: a drawer pull at the right end of a card's bottom
 * row (a thread's, beside Resolve; a composer's, beside its send
 * button), its right side a thick edge. As tall as the row's buttons:
 * 40px, and at least 40px wide.
 */
export const HANDLE =
	"flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-l-lg rounded-r-sm border border-r-4 px-2";

/** "Ask agent" before there is a conversation: a dashed sparkle on a light wash. */
export const ASK_HANDLE =
	"border-dashed border-agent-edge bg-agent/60 text-agent-ink hover:border-agent-ink hover:bg-agent";

/** A handle that can't be pressed now (aria-disabled), its reason the tooltip. */
export const HANDLE_OFF =
	"aria-disabled:cursor-not-allowed aria-disabled:border-line aria-disabled:bg-transparent aria-disabled:text-faint aria-disabled:hover:bg-transparent";
