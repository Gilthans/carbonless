/**
 * Write / Preview on the boxes whose text crb posts to GitHub (CAR-202):
 * a segmented pencil/eye toggle, and the text rendered the way crb shows a
 * posted GitHub comment, in the textarea's place. The pipeline is the one
 * the agent box's Posted row uses: `escapeTags` (as the server does before
 * posting, so a dropped tag shows as text, as it will on GitHub), `marked`,
 * then GithubHtml, which sanitizes (sanitizeGithubHtml). GitHub-only
 * rendering (@mentions, #123, emoji shortcodes, ```suggestion) is out of
 * scope: it shows as plain markdown.
 *
 * A box keeps its textarea mounted (hidden) while it previews, so Write
 * brings back the cursor where it was; the preview is at least as tall as
 * the textarea it replaces, so switching never moves what's below.
 */
import { EyeIcon, PencilIcon } from "@primer/octicons-react";
import { Marked } from "marked";
import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { escapeTags } from "../shared/markdownEscape";
import { GithubHtml, ImageErrorContext } from "./GithubHtml";
import { Tooltip } from "./Tooltip";

export type WriteMode = "write" | "preview";

const md = new Marked({ gfm: true, breaks: false, async: false });

/** The text as markdown HTML, before sanitizing (GithubHtml sanitizes). */
export function commentHtml(text: string): string {
	return md.parse(escapeTags(text)) as string;
}

/**
 * Ctrl/Cmd+Shift+P: switches a box between Write and Preview. By the
 * letter printed (`key`), as the app's shortcuts match letters, so another
 * layout's physical P (Dvorak's "l") doesn't.
 */
export function isPreviewKey(
	e: Pick<
		globalThis.KeyboardEvent,
		"ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key"
	>,
): boolean {
	return (
		(e.ctrlKey || e.metaKey) &&
		e.shiftKey &&
		!e.altKey &&
		e.key.toLowerCase() === "p"
	);
}

/** The shortcut, for the help (EDITOR_KEYS). */
export const PREVIEW_KEYS = "Mod+Shift+P";

/** The text as GitHub comments render, sanitized: in a box's place. */
export function CommentPreview(props: {
	text: string;
	className?: string;
	/** At least this tall (px): the textarea it replaces. */
	minHeight?: number;
	previewRef?: RefObject<HTMLElement | null>;
	/** The box's own keys (Ctrl+Enter, Escape) and the toggle's. */
	onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}) {
	return (
		<section
			ref={props.previewRef}
			data-testid="comment-preview"
			aria-label="Preview"
			// Scrolls past the box's max height, and takes the keys.
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region keyboard users must reach.
			tabIndex={0}
			onKeyDown={props.onKeyDown}
			style={
				props.minHeight ? { minHeight: `${props.minHeight}px` } : undefined
			}
			className={`block w-full min-w-0 overflow-y-auto rounded-md border border-line-strong bg-raised px-3 py-2 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent ${props.className ?? ""}`}
		>
			<CommentHtml text={props.text} />
		</section>
	);
}

/**
 * The text as GitHub comments render, sanitized, bare (a posted comment).
 * Its images are the reviewer's or the agent's links, never GitHub's
 * expiring signed ones: one that fails doesn't ask the page to refresh.
 */
export function CommentHtml(props: { text: string; className?: string }) {
	const html = useMemo(() => commentHtml(props.text), [props.text]);
	return (
		<ImageErrorContext value={undefined}>
			<GithubHtml html={html} className={`text-sm ${props.className ?? ""}`} />
		</ImageErrorContext>
	);
}

/** Pencil (Write) and eye (Preview): a segmented pair of 40px icon buttons. */
export function PreviewToggle(props: {
	mode: WriteMode;
	onChange: (mode: WriteMode) => void;
	onKeyDown?: (e: KeyboardEvent) => void;
	className?: string;
	/** Its slot kept, unseen (not focusable, not announced). */
	unseen?: boolean;
}) {
	const item = (mode: WriteMode, label: string, Icon: typeof PencilIcon) => (
		<Tooltip content={label} describe={false}>
			{(trigger) => (
				<button
					{...trigger}
					type="button"
					aria-label={label}
					aria-pressed={props.mode === mode}
					onClick={() => props.onChange(mode)}
					// Keeps the box's focus on a mouse click (Write focuses it).
					onMouseDown={(e) => e.preventDefault()}
					className="flex size-10 items-center justify-center text-muted hover:bg-overlay hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-pressed:bg-overlay aria-pressed:text-ink"
				>
					<Icon size={16} aria-hidden />
				</button>
			)}
		</Tooltip>
	);
	return (
		<fieldset
			aria-label="Write or preview"
			data-testid="preview-toggle"
			onKeyDown={props.onKeyDown}
			style={props.unseen ? { visibility: "hidden" } : undefined}
			// An outline, not a border: the pair is exactly 40px tall (84px with
			// Send), and it draws over the pressed half.
			className={`m-0 flex shrink-0 overflow-hidden rounded-md border-0 p-0 outline outline-line -outline-offset-1 ${props.className ?? ""}`}
		>
			{item("write", "Write", PencilIcon)}
			{item("preview", "Preview", EyeIcon)}
		</fieldset>
	);
}

/**
 * A box's mode. Blank text or `off` (the box isn't posting to GitHub:
 * Ask agent) is always Write, with no toggle, and resets the choice to
 * Write. Preview measures the
 * textarea first, so the preview takes its place at least at its height;
 * Write focuses it again (its selection kept: it stayed mounted). A
 * switch by keys from the box moves the focus to the preview, so the
 * same keys switch back. `onKeyDown` goes on the textarea and on the
 * preview too, inside the box's own key handler (Ctrl+Enter, Escape).
 */
export function useWritePreview(opts: {
	initial: WriteMode;
	text: string;
	box: RefObject<HTMLTextAreaElement | null>;
	off?: boolean;
}) {
	const { box } = opts;
	const [chosen, setChosen] = useState<WriteMode>(opts.initial);
	const [height, setHeight] = useState<number | undefined>();
	const preview = useRef<HTMLElement>(null);
	const toggle = !opts.off && opts.text.trim() !== "";
	// Hidden (emptied, or Ask agent), the box forgets Preview: the next
	// text is typed in Write, never flipped away from under the cursor.
	if (!toggle && chosen !== "write") setChosen("write");
	const mode: WriteMode = toggle ? chosen : "write";
	const focusNext = useRef<WriteMode | null>(null);
	const choose = useCallback(
		(next: WriteMode) => {
			if (next === mode) return;
			const el = box.current;
			if (next === "preview") {
				const h = el?.offsetHeight;
				setHeight(h ? h : undefined);
				focusNext.current =
					el && el === document.activeElement ? "preview" : null;
			} else {
				focusNext.current = "write";
			}
			setChosen(next);
		},
		[mode, box],
	);
	useLayoutEffect(() => {
		const want = focusNext.current;
		if (want !== mode) return;
		focusNext.current = null;
		if (want === "write") box.current?.focus({ preventScroll: true });
		else preview.current?.focus({ preventScroll: true });
	}, [mode, box]);
	const onKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (!toggle || !isPreviewKey(e)) return;
			e.preventDefault();
			e.stopPropagation();
			const fromInside =
				e.target === box.current || e.target === preview.current;
			choose(mode === "write" ? "preview" : "write");
			if (fromInside && mode === "write") focusNext.current = "preview";
		},
		[toggle, mode, choose, box],
	);
	return {
		mode,
		choose,
		/** Whether the toggle shows. */
		toggle,
		onKeyDown,
		/** For the preview (CommentPreview). */
		previewProps: { previewRef: preview, minHeight: height, onKeyDown },
		/** For the toggle (PreviewToggle). */
		toggleProps: { mode, onChange: choose, onKeyDown },
	};
}
