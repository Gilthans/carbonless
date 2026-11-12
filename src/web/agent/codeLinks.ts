/**
 * Code links in an agent's answer: `path:line` and `path:start-end`, in
 * inline code or bare text, for paths in the PR only. The link is built
 * here from the matched path and numbers (after checking the path against
 * the PR's files), never from an href the agent wrote; the page follows it
 * through the router. Only these two forms are recognised.
 */
import type { FilesSearch } from "../files/landing";

export interface CodeRef {
	path: string;
	start: number;
	end: number;
}

const OID = /^[0-9a-f]{40}$/;

/** `path:line` or `path:start-end`, not part of a longer word or path. */
export const CODE_REF =
	/(?<![\w./@+-])((?:[\w@+-]+[./])*[\w@+-]+(?:\.[\w@+-]+)*):(\d+)(?:-(\d+))?(?![\w-])/g;

/** The refs of one piece of text, with where each sits. */
export function findCodeRefs(
	text: string,
): { index: number; length: number; ref: CodeRef }[] {
	const out: { index: number; length: number; ref: CodeRef }[] = [];
	for (const m of text.matchAll(CODE_REF)) {
		const start = Number(m[2]);
		const end = m[3] === undefined ? start : Number(m[3]);
		if (!Number.isSafeInteger(start) || start < 1) continue;
		out.push({
			index: m.index,
			length: m[0].length,
			ref: { path: m[1] as string, start, end: Math.max(start, end) },
		});
	}
	return out;
}

/**
 * Where a ref lands in Files changed: the answer's head (`ps` when it is a
 * patch set's, else `head`), or the reviewer's current view without one
 * (older messages); null for a path not in the PR.
 */
export function codeLinkSearch(
	ref: CodeRef,
	head: string | undefined,
	files: ReadonlySet<string>,
	patchsets: readonly { number: number; head: string }[],
): FilesSearch | null {
	if (!files.has(ref.path)) return null;
	const search: FilesSearch = {
		path: ref.path,
		line: ref.start,
		side: "RIGHT",
	};
	if (head !== undefined && OID.test(head)) {
		const ps = patchsets.find((p) => p.head === head);
		if (ps) search.ps = ps.number;
		else search.head = head;
	}
	return search;
}

/** codeLinkSearch as the query string of the Files changed URL. */
export function codeLinkTarget(
	ref: CodeRef,
	head: string | undefined,
	files: ReadonlySet<string>,
	patchsets: readonly { number: number; head: string }[],
): string | null {
	const search = codeLinkSearch(ref, head, files, patchsets);
	if (!search) return null;
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(search)) params.set(k, String(v));
	return `?${params}`;
}

/**
 * Wraps the refs in rendered (already sanitised) prose in links made by
 * `make`: whole inline `code` that is a ref, and refs in bare text. Text in
 * existing links, `pre` and other code is left alone.
 */
export function linkCodeRefs(
	root: HTMLElement,
	make: (ref: CodeRef, label: Node) => HTMLElement | null,
): void {
	const doc = root.ownerDocument;
	const inLink = (n: Node) => n.parentElement?.closest("a, pre") != null;
	for (const code of root.querySelectorAll("code")) {
		if (inLink(code)) continue;
		const found = findCodeRefs(code.textContent ?? "");
		const only = found[0];
		if (
			!only ||
			found.length !== 1 ||
			only.length !== code.textContent?.length
		) {
			continue;
		}
		const link = make(only.ref, code);
		if (!link) continue;
		code.replaceWith(link);
		link.append(code);
	}
	const texts: Text[] = [];
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (!n.parentElement?.closest("a, pre, code")) texts.push(n as Text);
	}
	for (const text of texts) {
		const found = findCodeRefs(text.data);
		if (!found.length) continue;
		const pieces: Node[] = [];
		let at = 0;
		for (const f of found) {
			const label = doc.createTextNode(
				text.data.slice(f.index, f.index + f.length),
			);
			const link = make(f.ref, label);
			if (!link) continue;
			if (f.index > at)
				pieces.push(doc.createTextNode(text.data.slice(at, f.index)));
			link.append(label);
			pieces.push(link);
			at = f.index + f.length;
		}
		if (!pieces.length) continue;
		if (at < text.data.length)
			pieces.push(doc.createTextNode(text.data.slice(at)));
		text.replaceWith(...pieces);
	}
}
