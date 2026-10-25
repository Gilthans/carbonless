import { describe, expect, it } from "vitest";
import type { FileView, PrOverview } from "../../shared/types";
import { landingFile, parseFilesSearch, threadTarget } from "./landing";

type Thread = PrOverview["threads"][number];

const thread = (extra: Partial<Thread> = {}): Thread => ({
	path: "src/a.ts",
	line: 10,
	currentLine: 12,
	excerpt: "",
	html: "",
	body: "",
	createdAt: "",
	lastActivityAt: "",
	author: "rev1",
	bot: false,
	commentCount: 1,
	hasReply: false,
	outdated: false,
	resolved: false,
	code: {
		diffHunk: "@@ -1 +1 @@\n x",
		commit: "c1",
		side: "RIGHT",
		startSide: "RIGHT",
		startLine: 10,
		endLine: 10,
	},
	...extra,
});
const at = (
	snapshotHead: string,
	currentHead = snapshotHead,
	asOf: string | null = null,
) => ({
	snapshotHead,
	currentHead,
	asOf,
});

describe("parseFilesSearch", () => {
	it("keeps a path, a positive line, a side and the moved flag; drops the rest", () => {
		expect(
			parseFilesSearch({ path: "a.ts", line: 3, side: "LEFT", moved: true }),
		).toEqual({ path: "a.ts", line: 3, side: "LEFT", moved: true });
		expect(parseFilesSearch({ path: "a.ts", line: "7" })).toEqual({
			path: "a.ts",
			line: 7,
		});
		expect(
			parseFilesSearch({ path: "", line: -1, side: "UP", moved: "no" }),
		).toEqual({});
		expect(parseFilesSearch({ line: 1.5 })).toEqual({});
	});
});

describe("threadTarget", () => {
	it("lands on the code's own line when it was written on the snapshot's head", () => {
		expect(threadTarget(thread(), at("c1"), 10)).toEqual({
			path: "src/a.ts",
			line: 10,
			side: "RIGHT",
		});
	});

	it("takes GitHub's current line when the snapshot is the PR's head", () => {
		expect(threadTarget(thread(), at("h"), 10)).toEqual({
			path: "src/a.ts",
			line: 12,
			side: "RIGHT",
		});
	});

	it("says moved for an outdated thread, as of a cutoff, or on an older snapshot", () => {
		const moved = { path: "src/a.ts", line: 10, side: "RIGHT", moved: true };
		expect(threadTarget(thread({ outdated: true }), at("h"), 10)).toEqual(
			moved,
		);
		expect(
			threadTarget(thread(), at("h", "h", "2026-01-01T00:00:00Z"), 10),
		).toEqual(moved);
		expect(threadTarget(thread(), at("old", "new"), 10)).toEqual(moved);
		expect(threadTarget(thread(), undefined, 10)).toEqual(moved);
	});

	it("keeps the comment's side, and lands a file comment on the file", () => {
		const left = thread({
			code: { ...(thread().code as NonNullable<Thread["code"]>), side: "LEFT" },
		});
		expect(threadTarget(left, at("c1"), 10)).toMatchObject({ side: "LEFT" });
		expect(threadTarget(thread({ code: null }), at("c1"), null)).toEqual({
			path: "src/a.ts",
		});
	});
});

describe("landingFile", () => {
	const file = (index: number, path: string, oldPath?: string) =>
		({ index, path, ...(oldPath ? { oldPath } : {}) }) as FileView;
	it("finds the file by path, else by its old path", () => {
		const files = [file(0, "a.ts"), file(1, "new.ts", "old.ts")];
		expect(landingFile(files, { path: "a.ts" })?.index).toBe(0);
		expect(landingFile(files, { path: "old.ts" })?.index).toBe(1);
		expect(landingFile(files, { path: "gone.ts" })).toBeUndefined();
	});
});
