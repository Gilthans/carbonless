import { CheckIcon, CopyIcon, XIcon } from "@primer/octicons-react";
import { copyText } from "./copyText";

/** A Copy press's outcome: none yet, on the clipboard, or refused. */
export type Copied = "ok" | "failed" | null;

/** A Copy button's word (its name or tooltip) for `copied`. */
export const copyWord = (copied: Copied, word = "Copy") =>
	copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : word;

/** A Copy button's icon: copy, ✓ once copied, ✗ (bad) when refused. */
export function CopyMark(props: { copied: Copied }) {
	if (props.copied === "ok")
		return <CheckIcon size={16} aria-hidden className="text-ok" />;
	if (props.copied === "failed")
		return <XIcon size={16} aria-hidden className="text-bad" />;
	return <CopyIcon size={16} aria-hidden />;
}

/**
 * Copies `text` and says how it went. When the browser refuses, `shown`
 * (the field or element showing the text) is selected instead, for the
 * reviewer to copy by hand.
 */
export async function copyInto(
	text: string,
	shown: HTMLElement | null,
	done: (copied: Copied) => void,
) {
	const ok = await copyText(text);
	done(ok ? "ok" : "failed");
	if (!ok && shown) select(shown);
}

function select(shown: HTMLElement) {
	if (
		shown instanceof HTMLInputElement ||
		shown instanceof HTMLTextAreaElement
	) {
		shown.focus();
		shown.select();
		return;
	}
	window.getSelection()?.selectAllChildren(shown);
}
