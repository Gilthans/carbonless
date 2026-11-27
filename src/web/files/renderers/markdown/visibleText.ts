import { INVISIBLE } from "../../../code/invisibleChars";

/**
 * Text as a reader sees it rendered (CAR-167, no invisible change): every
 * blank (a space, a tab, a line end, a no-break or other unusual space) is
 * one space, runs of them collapsed as HTML does; what prints as nothing
 * (zero widths, bidi controls, tag characters, the soft hyphen, other
 * default-ignorable and format characters, controls) is gone. In a `pre`
 * (`pre`), blanks keep their run, only trailing ones before a line end go.
 * The same sets the line view draws as markers (invisibleChars.ts).
 */
function visibleText(text: string, pre = false): string {
	let out = "";
	for (const c of text) {
		if (c === "\n") out += "\n";
		else if (/^[\t\r\p{Zs}]$/u.test(c)) out += " ";
		else if (!INVISIBLE.test(c)) out += c;
	}
	return pre ? out.replace(/ +(?=\n|$)/g, "") : out.replace(/\s+/g, " ");
}

/**
 * Whether text holds a character that prints as nothing or not as itself
 * (`INVISIBLE`, but a plain space, tab or line end).
 */
export function hasUnseen(text: string): boolean {
	for (const c of text) {
		if (
			c !== " " &&
			c !== "\t" &&
			c !== "\n" &&
			c !== "\r" &&
			INVISIBLE.test(c)
		) {
			return true;
		}
	}
	return false;
}

/**
 * An element's rendered look: its tags without attributes (a title, a
 * link's target, an image's alt or URL don't show as text), each loaded
 * image by its path (`data-md-path`, the same on both sides), its text
 * as `visibleText` reads it; no blank next to a block's edge or a break.
 * Two elements that look alike give the same string.
 */
export function looksOf(root: Node): string {
	let out = "";
	const walk = (n: Node, pre: boolean) => {
		if (n.nodeType === 3) {
			out += visibleText(n.nodeValue ?? "", pre).replace(/</g, "&lt;");
			return;
		}
		if (!(n instanceof Element)) {
			for (const c of n.childNodes) walk(c, pre);
			return;
		}
		const tag = n.nodeName.toLowerCase();
		if (tag === "img") {
			out += `<img ${n.getAttribute("data-md-path") ?? n.getAttribute("src") ?? ""}>`;
			return;
		}
		out += `<${tag}>`;
		for (const c of n.childNodes) walk(c, pre || tag === "pre");
		out += `</${tag}>`;
	};
	walk(root, false);
	return out.replace(EDGE, "$1").trim();
}

/** Block-level tags: a blank next to one draws nothing. */
const EDGE =
	/ ?(<\/?(?:p|li|ul|ol|h[1-6]|blockquote|table|thead|tbody|tfoot|tr|td|th|dl|dt|dd|div|details|summary|br|hr)\b[^>]*>) ?/g;

/** HTML (the renderer's, sanitized) → its look (`looksOf`). */
export function looksOfHtml(html: string): string {
	const t = document.createElement("template");
	t.innerHTML = html;
	return looksOf(t.content);
}
