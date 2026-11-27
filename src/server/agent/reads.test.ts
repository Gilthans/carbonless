import { describe, expect, it } from "vitest";
import type { DiffLine, DisplayHunk, FileHunks } from "../../shared/types";
import { whitespaceLines } from "../../shared/whitespace";
import { hunkView } from "../../web/files/whitespace";
import {
	analyse,
	atHead,
	fileDiff,
	fileWindow,
	hunkText,
	isReadablePath,
	toRanges,
} from "./reads";

const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});
const del = (oldNo: number, text: string): DiffLine => ({
	kind: "del",
	oldNo,
	text,
});
const add = (newNo: number, text: string): DiffLine => ({
	kind: "add",
	newNo,
	text,
});

/** A hunk with a re-indented line, two lines merged into one and a rewrite. */
const HUNK: DisplayHunk = {
	oldStart: 1,
	oldCount: 6,
	newStart: 1,
	newCount: 5,
	heading: "function f() {",
	lines: [
		ctx(1, 1, "a"),
		del(2, "if (x) {"),
		add(2, "    if (x) {"),
		del(3, "const total = a + b;"),
		del(4, "return total;"),
		add(3, "return a + b;"),
		ctx(5, 4, "}"),
		del(6, "old tail"),
		add(5, "something else entirely"),
	],
};

const file = (hunks: DisplayHunk[]): FileHunks => ({ hunks, newLineCount: 5 });

describe("agent reads", () => {
	it("hunkText: unified text in git's order, with the heading and git's no-newline line", () => {
		const h: DisplayHunk = {
			oldStart: 3,
			oldCount: 1,
			newStart: 3,
			newCount: 1,
			lines: [del(3, "x"), { ...add(3, "y"), noNewline: true }],
		};
		expect(hunkText(h)).toBe(
			"@@ -3,1 +3,1 @@\n-x\n+y\n\\ No newline at end of file",
		);
		expect(hunkText(HUNK).split("\n")[0]).toBe(
			"@@ -1,6 +1,5 @@ function f() {",
		);
	});

	it("analyse: the page's whitespace-only lines and its line pairs, never its own", () => {
		const a = analyse([HUNK]);
		expect(a.whitespaceOnly).toEqual({ LEFT: [[2, 2]], RIGHT: [[2, 2]] });
		// The page's own computation over the same hunk ("Ignore whitespace" off).
		const pairs = hunkView(HUNK.lines, false).pairs.map(([d, n]) => [
			d.oldNo,
			n.newNo,
		]);
		expect(a.pairs).toEqual(pairs);
		// The two removed lines and one added: paired by similarity.
		expect(a.pairs).toContainEqual([3, 3]);
		const ws = [...whitespaceLines(HUNK.lines)];
		expect(ws.map((l) => l.kind).sort()).toEqual(["add", "del"]);
	});

	it("fileDiff: whole hunks within the budget; the rest from nextHunk", () => {
		const one = hunkText(HUNK).length + 1;
		const f = file([HUNK, { ...HUNK }, { ...HUNK }]);
		const part = fileDiff(f, 0, one * 2);
		expect(part.given).toHaveLength(2);
		expect(part.nextHunk).toBe(2);
		expect(part.used).toBe(one * 2);
		const rest = fileDiff(f, part.nextHunk as number, one * 2);
		expect(rest.given).toHaveLength(1);
		expect(rest.nextHunk).toBeUndefined();
		// Left for later rather than cut, when asked so.
		const none = fileDiff(f, 0, one - 1, false);
		expect(none).toMatchObject({ given: [], used: 0, nextHunk: 0, text: "" });
	});

	it("fileDiff: a first hunk alone over the budget is cut with a marker", () => {
		const long: DisplayHunk = {
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: 400,
			lines: Array.from({ length: 400 }, (_, i) => add(i + 1, "x".repeat(20))),
		};
		const part = fileDiff(file([long, HUNK]), 0, 1000);
		expect(part.text.length).toBeLessThanOrEqual(1000);
		expect(part.text).toMatch(/\n\[truncated: hunk 0 is too long; .*\]$/);
		expect(part.nextHunk).toBe(1);
	});

	it("fileDiff: a cut hunk's analysis covers only the lines it shows; the since view's marker says its old side can't be read", () => {
		// 60 edited lines, each paired with its old one.
		const lines: DiffLine[] = [
			...Array.from({ length: 60 }, (_, i) => del(i + 1, `value ${i} = old`)),
			...Array.from({ length: 60 }, (_, i) => add(i + 1, `value ${i} = new`)),
		];
		const big: DisplayHunk = {
			oldStart: 1,
			oldCount: 60,
			newStart: 1,
			newCount: 60,
			lines,
		};
		const part = fileDiff(file([big]), 0, 1800, true, true);
		expect(hunkText(big).length).toBeGreaterThan(1800);
		const a = analyse(part.given, part.shown);
		const shownAdds = new Set(
			[...(part.shown ?? [])]
				.filter((l) => l.kind === "add")
				.map((l) => l.newNo),
		);
		expect(a.pairs.length).toBeGreaterThan(0);
		expect(a.pairs.length).toBeLessThan(60);
		for (const [, n] of a.pairs) expect(shownAdds.has(n)).toBe(true);
		expect(part.text).toMatch(/old side is the earlier patch set rebased/);
		// The whole hunk, uncut: all 60.
		expect(analyse([big]).pairs).toHaveLength(60);
	});

	it("fileWindow: a window of lines within the budget; nextLine for the rest; a long line is cut", () => {
		const text = ["one", "two", "three", "four"];
		expect(fileWindow(text, 2, 3)).toEqual({
			lines: 4,
			startLine: 2,
			endLine: 3,
			text: "two\nthree",
		});
		expect(fileWindow(text, 1, undefined, 9)).toEqual({
			lines: 4,
			startLine: 1,
			endLine: 2,
			text: "one\ntwo",
			nextLine: 3,
		});
		const long = fileWindow(["y".repeat(500), "z"], 1, undefined, 200);
		expect(long.text.split("\n")).toEqual([
			expect.stringMatching(/^y{100} \[truncated: line 1 is too long\]$/),
			"z",
		]);
		expect(long.nextLine).toBeUndefined();
	});

	it("toRanges: inclusive ranges of sorted numbers", () => {
		expect(toRanges([5, 1, 2, 3, 7, 3])).toEqual([
			[1, 3],
			[5, 5],
			[7, 7],
		]);
	});

	it("isReadablePath: never an option, absolute, or out of the repository", () => {
		for (const ok of ["a.txt", "src/a b.ts", "dir/.hidden", "a-b"]) {
			expect(isReadablePath(ok), ok).toBe(true);
		}
		for (const bad of [
			"",
			"--output=x",
			"-p",
			"/etc/passwd",
			"../x",
			"a/../../x",
			"a\\..\\x",
			"a\0b",
			"a\nb",
		]) {
			expect(isReadablePath(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	it("atHead: each placement as the agent reads it, paths sanitised", () => {
		const s = (t: string) => t.replace("\u202e", "");
		const anchor = {
			path: "a\u202e.txt",
			side: "RIGHT" as const,
			startSide: "RIGHT" as const,
			startLine: 3,
			line: 4,
		};
		expect(atHead({ kind: "placed", anchor, changed: false }, s)).toEqual({
			kind: "placed",
			path: "a.txt",
			side: "RIGHT",
			startSide: "RIGHT",
			startLine: 3,
			line: 4,
		});
		expect(
			atHead(
				{
					kind: "changed",
					anchor,
					old: { side: "RIGHT", startLine: 1, line: 1, text: [] },
					now: [],
				},
				s,
			),
		).toMatchObject({ kind: "changed", line: 4 });
		expect(
			atHead(
				{ kind: "unplaced", fate: "deleted", path: "a.txt", nearest: null },
				s,
			),
		).toEqual({ kind: "unplaced", path: "a.txt", fate: "deleted", near: null });
		expect(
			atHead({ kind: "outside", path: "b", fate: "file-gone" }, s),
		).toEqual({ kind: "outside", path: "b", fate: "file-gone" });
		expect(atHead({ kind: "file", path: "b" }, s)).toEqual({
			kind: "file",
			path: "b",
		});
		// Still being placed (CAR-8): unknown, with why, never a line.
		expect(atHead({ kind: "pending", path: "b" }, s)).toEqual({
			kind: "unknown",
			why: "crb is still placing this thread",
		});
	});
});
