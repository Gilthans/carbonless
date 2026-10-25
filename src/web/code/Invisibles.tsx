import { useQuery } from "@tanstack/react-query";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useSyncExternalStore,
} from "react";
import { highlightLine } from "../files/highlight";
import { Tooltip } from "../Tooltip";
import { DEFAULT_TAB_WIDTH, type Piece, renderInvisibles } from "./invisibles";

export const INVISIBLES_STORAGE_KEY = "crb.code.invisibles";

/** The remembered ¶ choice: shown unless turned off (or storage is unavailable). */
export function readShowInvisibles(): boolean {
	try {
		return localStorage.getItem(INVISIBLES_STORAGE_KEY) !== "off";
	} catch {
		return true;
	}
}

let show: boolean | undefined;
const listeners = new Set<() => void>();

/** Every code view shares one ¶ choice, remembered for this viewer. */
export function setShowInvisibles(next: boolean): void {
	show = next;
	try {
		localStorage.setItem(INVISIBLES_STORAGE_KEY, next ? "on" : "off");
	} catch {
		// Storage is a convenience only.
	}
	for (const listener of listeners) listener();
}

/** Forgets the in-memory choice (tests), so the next read is from storage. */
export function resetShowInvisibles(): void {
	show = undefined;
}

export function useShowInvisibles(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			listeners.add(onChange);
			return () => listeners.delete(onChange);
		},
		() => {
			show ??= readShowInvisibles();
			return show;
		},
	);
}

/** The ¶ toggle (Notepad++'s "Show All Characters"). */
export function InvisiblesToggle() {
	const on = useShowInvisibles();
	return (
		<Tooltip content="Show all characters" describe={false}>
			{(trigger) => (
				<button
					type="button"
					{...trigger}
					aria-label="Show all characters"
					aria-pressed={on}
					onClick={() => setShowInvisibles(!on)}
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line-strong text-sm font-semibold text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent aria-pressed:text-canvas pointer-coarse:h-10 pointer-coarse:w-10"
				>
					<span aria-hidden>¶</span>
				</button>
			)}
		</Tooltip>
	);
}

/**
 * A marker drawn as CSS generated content (never selected, copied or read
 * out), over the original character kept in the DOM at zero size, so a copy
 * gives back exactly the code. The zero-size character is isolated: a bidi
 * control can't reorder the text around it.
 */
const MARK =
	"text-faint before:content-[attr(data-glyph)_/_''] [&>span]:text-[0px] [&>span]:leading-[0] [&>span]:[unicode-bidi:isolate]";
const BIDI = "rounded-sm bg-warn/15 text-warn";

function Marker(props: { piece: Exclude<Piece, { kind: "text" }> }): ReactNode {
	const { piece } = props;
	const raw = piece.raw ? <span>{piece.raw}</span> : null;
	switch (piece.kind) {
		case "space":
			return (
				<span data-inv="space" data-glyph="·" className={MARK}>
					{raw}
				</span>
			);
		case "tab":
			return (
				<span
					data-inv="tab"
					data-glyph={piece.marker ? "\\t" : ""}
					className={`inline-block ${MARK}`}
					style={{ width: `${piece.columns}ch` }}
				>
					{raw}
				</span>
			);
		case "escape":
			return (
				<span
					data-inv={piece.bidi ? "bidi" : "escape"}
					data-glyph={piece.label}
					title={
						piece.bidi
							? `${piece.name}: reorders how the code displays`
							: piece.name
					}
					className={`${MARK} ${piece.bidi ? BIDI : ""}`}
				>
					{raw}
				</span>
			);
		case "eol":
			return (
				<span data-inv="eol" data-glyph={piece.label} className={MARK}>
					{raw}
				</span>
			);
	}
}

/** Blanks that a browser's plain-text copy turns into ordinary spaces. */
const BLANK = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;

/**
 * Chrome copies a no-break space (and its kin) as a plain space. While a
 * selection holding one is copied, each such character is swapped for an
 * unused private-use character, the selection is read as text, and the
 * originals are put back, in the DOM and in what is copied.
 */
export function copyWithOriginals(event: ClipboardEvent): void {
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || !event.clipboardData) return;
	const raws: Text[] = [];
	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		const root = range.commonAncestorContainer;
		const scope = root instanceof Element ? root : root.parentElement;
		const candidates = [
			...(scope?.querySelectorAll("[data-inv] > span") ?? []),
			...(scope?.closest("[data-inv] > span") ? [scope] : []),
		];
		for (const span of candidates) {
			const text = span.firstChild;
			if (
				text instanceof Text &&
				BLANK.test(text.data) &&
				range.intersectsNode(text)
			) {
				raws.push(text);
			}
		}
	}
	if (raws.length === 0) return;
	const plain = selection.toString();
	const originals = new Map<string, string>();
	let next = 0xe000;
	const swapped: [Text, string][] = [];
	for (const text of raws) {
		const original = text.data;
		let sentinel = [...originals].find(([, o]) => o === original)?.[0];
		if (!sentinel) {
			while (plain.includes(String.fromCharCode(next))) next++;
			sentinel = String.fromCharCode(next++);
			originals.set(sentinel, original);
		}
		swapped.push([text, original]);
		text.data = sentinel;
	}
	let copied: string;
	try {
		copied = selection.toString();
	} finally {
		for (const [text, original] of swapped) text.data = original;
	}
	for (const [sentinel, original] of originals) {
		copied = copied.replaceAll(sentinel, original);
	}
	event.clipboardData.setData("text/plain", copied);
	event.preventDefault();
}

let copyFixInstalled = false;

type Token = {
	content: string;
	offset: number;
	color?: string;
	fontStyle?: number;
};

const tokenStyle = (token: Token): CSSProperties => ({
	color: token.color,
	fontStyle: token.fontStyle && token.fontStyle & 1 ? "italic" : undefined,
	fontWeight: token.fontStyle && token.fontStyle & 2 ? "bold" : undefined,
});

/** A run of ordinary text, colored by the highlighting tokens it overlaps. */
function TextRun(props: { raw: string; start: number; tokens?: Token[] }) {
	const { raw, start, tokens } = props;
	if (!tokens?.length) return <>{raw}</>;
	const end = start + raw.length;
	const parts: ReactNode[] = [];
	let at = start;
	for (const token of tokens) {
		const from = Math.max(at, token.offset);
		const to = Math.min(end, token.offset + token.content.length);
		if (to <= from) continue;
		if (from > at) parts.push(raw.slice(at - start, from - start));
		parts.push(
			<span key={from} style={tokenStyle(token)}>
				{raw.slice(from - start, to - start)}
			</span>,
		);
		at = to;
	}
	if (at < end) parts.push(raw.slice(at - start));
	return <>{parts}</>;
}

/**
 * One line of code, highlighted (plain until the highlighting arrives), with
 * its invisible characters shown (Notepad++ style, see invisibles.ts).
 * `newline`: a newline follows the line (false before git's "No newline at
 * end of file"). Copying the line copies the original text.
 */
export function CodeLine(props: {
	text: string;
	lang: string | null;
	tabWidth?: number;
	newline?: boolean;
}) {
	const { text, lang, newline = true } = props;
	const show = useShowInvisibles();
	useEffect(() => {
		if (copyFixInstalled) return;
		copyFixInstalled = true;
		document.addEventListener("copy", copyWithOriginals);
	}, []);
	const tokens = useQuery({
		queryKey: ["highlight", lang, text],
		// A CR would start a new line for the highlighter: a space keeps the
		// offsets and the rest of the line.
		queryFn: () => highlightLine(text.replaceAll("\r", " "), lang),
		enabled: lang !== null && text.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const pieces = renderInvisibles(text, props.tabWidth ?? DEFAULT_TAB_WIDTH, {
		newline,
		show,
	});
	return (
		<>
			{pieces.map((piece) =>
				piece.kind === "text" ? (
					<TextRun
						key={piece.start}
						raw={piece.raw}
						start={piece.start}
						tokens={tokens.data}
					/>
				) : (
					<Marker key={`${piece.kind}${piece.start}`} piece={piece} />
				),
			)}
		</>
	);
}
