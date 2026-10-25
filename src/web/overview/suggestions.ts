/**
 * GitHub's "suggested change" blocks (```suggestion fences in a review
 * comment), read so the overview can show them as a mini diff.
 *
 * The suggestion's text comes from the raw markdown, which is exact (GitHub's
 * HTML highlights it and can't be trusted to keep every character). The
 * HTML says where each block sits among the rest of the comment. Anything
 * that doesn't line up fails closed: the caller shows GitHub's HTML as is,
 * so nothing is ever dropped.
 */

const FENCE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;

/**
 * The lines of each ```suggestion block in `body`, in order. Other fenced
 * blocks are skipped whole (a suggestion fence inside them is just text). A
 * block left open runs to the end, as in CommonMark. Null when the markdown
 * can't be read with confidence (an open block of any kind at the end).
 */
export function suggestionBlocks(body: string): string[][] | null {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const blocks: string[][] = [];
	let open: {
		indent: number;
		char: string;
		length: number;
		lines?: string[];
	} | null = null;
	for (const line of lines) {
		if (open) {
			const close = FENCE.exec(line);
			if (
				close?.[2]?.[0] === open.char &&
				(close[2]?.length ?? 0) >= open.length &&
				!close[3]?.trim()
			) {
				if (open.lines) blocks.push(open.lines);
				open = null;
				continue;
			}
			// Up to the fence's own indentation is stripped from its lines.
			let text = line;
			for (let i = 0; i < open.indent && text.startsWith(" "); i++) {
				text = text.slice(1);
			}
			open.lines?.push(text);
			continue;
		}
		const start = FENCE.exec(line);
		if (!start) continue;
		const fence = start[2] ?? "";
		const info = (start[3] ?? "").trim();
		// A backtick fence's info string can't hold a backtick (the regex).
		open = {
			indent: start[1]?.length ?? 0,
			char: fence[0] ?? "`",
			length: fence.length,
			...(info.split(/\s+/)[0] === "suggestion" ? { lines: [] } : {}),
		};
	}
	if (open) return null;
	return blocks;
}

/** One piece of a comment: GitHub's HTML, or a suggested change. */
export type CommentPart =
	| { kind: "html"; html: string }
	| {
			kind: "suggestion";
			/** The suggested lines, exactly (empty: delete the commented lines). */
			added: string[];
			/** The lines GitHub's block shows as replaced (its text, for checking). */
			removed: string[];
	  };

const BLOB = "js-suggested-changes-blob";

/** A cell's text: what GitHub drew for one line. */
const rowText = (cell: Element) => cell.textContent ?? "";

/**
 * The comment split around its suggested changes: GitHub's HTML before,
 * between and after each block (still to be sanitized), and each block with
 * its lines from `body`. Null (show GitHub's HTML) unless every block GitHub
 * drew sits at the top level of the comment, they match the markdown's
 * blocks one for one, and each has as many added rows as its markdown has
 * lines.
 */
export function splitSuggestions(
	html: string,
	body: string,
): CommentPart[] | null {
	if (!html.includes(BLOB)) return null;
	const blocks = suggestionBlocks(body);
	if (!blocks || blocks.length === 0) return null;
	if (typeof DOMParser === "undefined") return null;
	// An inert document: nothing in it runs or loads.
	const doc = new DOMParser().parseFromString(html, "text/html");
	const blobs = [...doc.body.querySelectorAll(`.${BLOB}`)];
	if (blobs.length !== blocks.length) return null;
	if (blobs.some((b) => b.parentElement !== doc.body)) return null;
	const parts: CommentPart[] = [];
	let pending = "";
	const flush = () => {
		if (pending.trim()) parts.push({ kind: "html", html: pending.trim() });
		pending = "";
	};
	let index = 0;
	for (const node of [...doc.body.childNodes]) {
		if (node instanceof Element && node.classList.contains(BLOB)) {
			const added = blocks[index++] ?? [];
			const cells = (kind: string) =>
				[...node.querySelectorAll(`td.blob-code-${kind}`)].map(rowText);
			const addedRows = cells("addition");
			// GitHub draws an empty suggestion with no added rows; a block of
			// empty lines with as many empty rows.
			if (addedRows.length !== added.length) return null;
			flush();
			parts.push({ kind: "suggestion", added, removed: cells("deletion") });
			continue;
		}
		pending +=
			node instanceof Element
				? node.outerHTML
				: node.nodeType === Node.TEXT_NODE
					? escapeText(node.textContent ?? "")
					: "";
	}
	flush();
	return parts;
}

function escapeText(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
