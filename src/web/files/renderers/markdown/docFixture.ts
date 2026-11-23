import type { SincePiece } from "../../../../shared/pieces";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
} from "../../../../shared/types";

/**
 * Test support: a Markdown file's two sides and its edits as the server
 * would send them (hunks, the unchanged lines with both numbers, the
 * clusters), so the Rendered view's tests read like the change they show.
 */
export interface Edit {
	key: string;
	/** Old lines `[from, to)` removed, new lines `[from, to)` added. */
	old?: [number, number];
	new?: [number, number];
	whitespaceOnly?: true;
	state?: ClusterView["state"];
}

export interface DocFixture {
	file: FileView;
	hunks: FileHunks;
	context: DiffLine[];
}

const range = ([a, b]: [number, number]) =>
	Array.from({ length: b - a }, (_, i) => a + i);

export function docFixture(
	oldText: string[],
	newText: string[],
	edits: Edit[],
	opts: { path?: string; since?: boolean } = {},
): DocFixture {
	const delAt = new Map<number, string>();
	const addAt = new Map<number, string>();
	for (const e of edits) {
		for (const n of e.old ? range(e.old) : []) delAt.set(n, e.key);
		for (const n of e.new ? range(e.new) : []) addAt.set(n, e.key);
	}
	const context: DiffLine[] = [];
	let o = 1;
	let n = 1;
	while (o <= oldText.length || n <= newText.length) {
		if (delAt.has(o)) o++;
		else if (addAt.has(n)) n++;
		else if (o <= oldText.length && n <= newText.length) {
			context.push({
				kind: "context",
				oldNo: o,
				newNo: n,
				text: newText[n - 1] as string,
			});
			o++;
			n++;
		} else throw new Error("edits don't align the sides");
	}
	const hunks = edits.map((e) => {
		const lines: DiffLine[] = [
			...(e.old ? range(e.old) : []).map(
				(k): DiffLine => ({
					kind: "del",
					oldNo: k,
					text: oldText[k - 1] as string,
					clusterKey: e.key,
				}),
			),
			...(e.new ? range(e.new) : []).map(
				(k): DiffLine => ({
					kind: "add",
					newNo: k,
					text: newText[k - 1] as string,
					clusterKey: e.key,
				}),
			),
		];
		const oldStart = e.old?.[0] ?? 0;
		const newStart = e.new?.[0] ?? 0;
		return {
			oldStart,
			oldCount: e.old ? e.old[1] - e.old[0] : 0,
			newStart,
			newCount: e.new ? e.new[1] - e.new[0] : 0,
			lines,
		};
	});
	const clusters: ClusterView[] = edits.map((e) => ({
		key: e.key,
		kind: "lines",
		oldStart: e.old?.[0] ?? 0,
		oldCount: e.old ? e.old[1] - e.old[0] : 0,
		newStart: e.new?.[0] ?? 0,
		newCount: e.new ? e.new[1] - e.new[0] : 0,
		removed: (e.old ? range(e.old) : []).map((k) => oldText[k - 1] as string),
		added: (e.new ? range(e.new) : []).map((k) => newText[k - 1] as string),
		lines:
			(e.old ? e.old[1] - e.old[0] : 0) + (e.new ? e.new[1] - e.new[0] : 0),
		state: e.state ?? "unreviewed",
		...(e.whitespaceOnly ? { whitespaceOnly: true as const } : {}),
	}));
	const pieces: SincePiece[] | undefined = opts.since
		? edits.map((e, h) => ({
				hunk: h,
				line: 0,
				key: e.key,
				owns: [
					[
						0,
						(e.old ? e.old[1] - e.old[0] : 0) +
							(e.new ? e.new[1] - e.new[0] : 0),
					],
				],
				old: e.old ? [e.old] : [],
				new: e.new ? [e.new] : [],
				...(e.new ? {} : { kind: "removed" as const }),
			}))
		: undefined;
	const file: FileView = {
		index: 0,
		path: opts.path ?? "README.md",
		status:
			oldText.length === 0
				? "added"
				: newText.length === 0
					? "deleted"
					: "modified",
		binary: false,
		submodule: false,
		additions: addAt.size,
		deletions: delAt.size,
		markdownBlocks: true,
		clusters,
		done: clusters.every((c) => c.state !== "unreviewed"),
		reviewed: false,
		crossedOff: false,
	};
	return {
		file,
		hunks: {
			hunks,
			newLineCount: newText.length,
			...(pieces ? { pieces, markdownBlocks: true as const } : {}),
		},
		context,
	};
}
