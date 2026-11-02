import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../../test/git-fixture";
import {
	REINDENT_NEW,
	REINDENT_OLD,
	WRAP_ADDED,
	WRAP_NEW,
	WRAP_OLD,
	WRAP_REMOVED,
} from "../../../test/whitespace-fixture";
import { parseU0Patch } from "../../server/diff/clusters";
import { buildDisplayHunks } from "../../server/diff/hunks";
import type { DiffLine, DisplayHunk } from "../../shared/types";
import {
	type DiffRow,
	linesWhitespaceEqual,
	matchHunk,
	PAIR_CAP,
	pairHunk,
	pairRun,
	runs,
	stripWhitespace,
	viewRuns,
	whitespaceEqual,
	whitespaceOnly,
} from "./whitespace";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const del = (oldNo: number, text: string, over: Partial<DiffLine> = {}) => ({
	kind: "del" as const,
	oldNo,
	text,
	clusterKey: "k",
	...over,
});
const add = (newNo: number, text: string, over: Partial<DiffLine> = {}) => ({
	kind: "add" as const,
	newNo,
	text,
	clusterKey: "k",
	...over,
});
const ctx = (oldNo: number, newNo: number, text: string): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});

/** The rows as a readable trace: ` old/new` context, `-old`, `+new`, `~old/new`, `~old/`, `~/new`. */
const trace = (rows: DiffRow[]) =>
	rows.map((r) =>
		r.kind === "ws"
			? `~${r.del?.oldNo ?? ""}/${r.add?.newNo ?? ""}`
			: r.line.kind === "del"
				? `-${r.line.oldNo}`
				: r.line.kind === "add"
					? `+${r.line.newNo}`
					: ` ${r.line.oldNo}/${r.line.newNo}`,
	);

const keyOf = (l: DiffLine) =>
	`${stripWhitespace(l.text)}${l.noNewline ? "\0" : ""}`;

/**
 * What "~ rows are whitespace-only, add/del rows are the change" means:
 * dropping the lines shown as plain add/del from the hunk's two sides must
 * leave whitespace-equal sequences (the rows are a valid `-w` edit script).
 * A moved block or a crossed line can never hide in `~` rows.
 */
function expectSound(lines: DiffLine[], rows: DiffRow[]) {
	const plain = new Set(
		rows.flatMap((r) => (r.kind === "line" ? [r.line] : [])),
	);
	const oldKeys = lines
		.filter((l) => l.kind === "context" || (l.kind === "del" && !plain.has(l)))
		.map(keyOf);
	const newKeys = lines
		.filter((l) => l.kind === "context" || (l.kind === "add" && !plain.has(l)))
		.map(keyOf);
	expect(oldKeys, `unsound: ${trace(rows).join(" ")}`).toEqual(newKeys);
}

/**
 * Principle 2: whatever the matching does, every line of the hunk is in the
 * rows exactly once, each side in diff order, a two-sided row only joins
 * whitespace-equal lines of one run, a one-sided row has a twin, and the
 * labelling is sound (expectSound).
 */
function expectCoverage(lines: DiffLine[], rows: DiffRow[]) {
	expectSound(lines, rows);
	const oldSide = lines.filter((l) => l.kind !== "add");
	const newSide = lines.filter((l) => l.kind !== "del");
	const seenOld: DiffLine[] = [];
	const seenNew: DiffLine[] = [];
	const twins = matchHunk(lines);
	for (const row of rows) {
		if (row.kind === "ws") {
			if (row.del && row.add) {
				expect(row.del.kind).toBe("del");
				expect(row.add.kind).toBe("add");
				expect(row.del.clusterKey).toBe(row.add.clusterKey);
				expect(whitespaceEqual(row.del.text, row.add.text)).toBe(true);
				expect(!!row.del.noNewline).toBe(!!row.add.noNewline);
				expect(linesWhitespaceEqual(row.del, row.add)).toBe(true);
			} else {
				const line = (row.del ?? row.add) as DiffLine;
				const twin = twins.get(line);
				expect(twin).toBeDefined();
				expect(keyEqual(line, twin as DiffLine)).toBe(true);
			}
			if (row.del) seenOld.push(row.del);
			if (row.add) seenNew.push(row.add);
		} else {
			if (row.line.kind !== "add") seenOld.push(row.line);
			if (row.line.kind !== "del") seenNew.push(row.line);
		}
	}
	// The same objects, each once, in order, on each side.
	expect(seenOld).toEqual(oldSide);
	expect(seenNew).toEqual(newSide);
	expect(new Set(seenOld).size).toBe(oldSide.length);
	expect(new Set(seenNew).size).toBe(newSide.length);
	// Within a run, unpaired removed lines come before unpaired added ones.
	for (const run of runs(lines)) {
		if (run.key === undefined) continue;
		const inRun = new Set(run.lines);
		const mine = rows.filter((r) =>
			r.kind === "ws"
				? inRun.has((r.del ?? r.add) as DiffLine)
				: inRun.has(r.line),
		);
		let sawAdd = false;
		for (const row of mine) {
			const two = row.kind === "ws" && row.del && row.add;
			const isAdd =
				row.kind === "ws" ? row.add !== undefined : row.line.kind === "add";
			if (two) sawAdd = false;
			else if (isAdd) sawAdd = true;
			else expect(sawAdd, `del after add in ${trace(rows)}`).toBe(false);
		}
	}
}

const keyEqual = (a: DiffLine, b: DiffLine) =>
	whitespaceEqual(a.text, b.text) && !!a.noNewline === !!b.noNewline;

/** The display hunk git and the server would make of two texts. */
function gitHunk(oldText: string, newText: string): DisplayHunk {
	const dir = mkdtempSync(join(tmpdir(), "crb-ws-"));
	try {
		writeFileSync(join(dir, "old"), oldText);
		writeFileSync(join(dir, "new"), newText);
		let patch = "";
		try {
			patch = execFileSync(
				"git",
				["diff", "--no-index", "--no-color", "-U0", "--", "old", "new"],
				{ cwd: dir, encoding: "utf8", env: testGitEnv() },
			);
		} catch (error) {
			// git exits 1 when the files differ.
			patch = String((error as { stdout?: string }).stdout ?? "");
		}
		const clusters = parseU0Patch(patch).map((c, i) => ({
			...c,
			key: `c${i}`,
			kind: "lines" as const,
		}));
		const lines = (t: string) => t.split("\n").slice(0, -1);
		const hunks = buildDisplayHunks(lines(oldText), lines(newText), clusters);
		expect(hunks).toHaveLength(1);
		return hunks[0] as DisplayHunk;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("stripWhitespace", () => {
	it("removes ASCII whitespace only", () => {
		expect(stripWhitespace(" a\tb\rc\vd\fe ")).toBe("abcde");
		// Unicode blanks are content, as for git -w.
		expect(stripWhitespace("a\u00A0b\u2003c\u200B")).toBe(
			"a\u00A0b\u2003c\u200B",
		);
	});

	it("compares lines whitespace-equal", () => {
		expect(whitespaceEqual("\tif (a) {", "  if (a) {")).toBe(true);
		expect(whitespaceEqual("x\r", "x")).toBe(true);
		expect(whitespaceEqual("x  ", "x")).toBe(true);
		expect(whitespaceEqual("a b", "ab")).toBe(true);
		expect(whitespaceEqual("a", "b")).toBe(false);
		expect(whitespaceEqual("a\u00A0b", "a b")).toBe(false);
		expect(whitespaceEqual("", " \t")).toBe(true);
	});
});

describe("pairHunk", () => {
	it("pairs a re-indented block line by line", () => {
		const lines = [
			del(1, "a"),
			del(2, "b"),
			del(3, "c"),
			add(1, "  a"),
			add(2, "  b"),
			add(3, "  c"),
		];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual(["~1/1", "~2/2", "~3/3"]);
		expect(whitespaceOnly(rows)).toBe(true);
		expectCoverage(lines, rows);
	});

	it("pairs a CRLF to LF change", () => {
		const lines = [del(5, "x\r"), del(6, "y\r"), add(5, "x"), add(6, "y")];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual(["~5/5", "~6/6"]);
		expect(whitespaceOnly(rows)).toBe(true);
	});

	it("pairs trailing-space removal", () => {
		const rows = pairHunk([del(1, "x   "), add(1, "x")]);
		expect(trace(rows)).toEqual(["~1/1"]);
	});

	it("keeps a real change as add/del rows among the pairs, in diff order", () => {
		const lines = [
			del(3, "a"),
			del(4, "b"),
			del(5, "c"),
			del(6, "d"),
			add(3, "  a"),
			add(4, "  b changed"),
			add(5, "  c"),
			add(6, "  d"),
		];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual(["~3/3", "-4", "+4", "~5/5", "~6/6"]);
		expect(whitespaceOnly(rows)).toBe(false);
		expectCoverage(lines, rows);
	});

	it("puts unpaired removed lines before unpaired added ones between pairs", () => {
		const lines = [
			del(1, "a"),
			del(2, "gone"),
			del(3, "b"),
			add(1, " a"),
			add(2, "new"),
			add(3, "also new"),
			add(4, " b"),
			add(5, "tail"),
		];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual(["~1/1", "-2", "+2", "+3", "~3/4", "+5"]);
		expectCoverage(lines, rows);
	});

	it("pairs duplicate lines in order", () => {
		const lines = [
			del(1, "}"),
			del(2, "}"),
			del(3, "}"),
			add(1, "  }"),
			add(2, "  }"),
		];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual(["~1/1", "~2/2", "-3"]);
		expectCoverage(lines, rows);
	});

	it("leaves one-sided and empty clusters as plain rows", () => {
		expect(pairHunk([])).toEqual([]);
		const adds = [add(1, "a"), add(2, "b")];
		expect(trace(pairHunk(adds))).toEqual(["+1", "+2"]);
		expect(whitespaceOnly(pairHunk(adds))).toBe(false);
		const dels = [del(1, "a")];
		expect(trace(pairHunk(dels))).toEqual(["-1"]);
		expectCoverage(dels, pairHunk(dels));
	});

	it("never pairs lines that differ in more than whitespace", () => {
		const lines = [del(1, "a\u00A0b"), add(1, "a b")];
		expect(trace(pairHunk(lines))).toEqual(["-1", "+1"]);
	});

	it("treats a final newline lost or gained as a real change, like git -w", () => {
		// Old file ends without a newline, new one with it: a change.
		expect(
			trace(pairHunk([del(1, "a", { noNewline: true }), add(1, "a")])),
		).toEqual(["-1", "+1"]);
		// And the other way round.
		expect(
			trace(pairHunk([del(1, "a"), add(1, " a", { noNewline: true })])),
		).toEqual(["-1", "+1"]);
		// Both without one: whitespace only.
		expect(
			trace(
				pairHunk([
					del(1, "a", { noNewline: true }),
					add(1, "  a", { noNewline: true }),
				]),
			),
		).toEqual(["~1/1"]);
		expect(
			linesWhitespaceEqual(del(1, "a", { noNewline: true }), add(1, "a")),
		).toBe(false);
	});

	it("doesn't match a run over the size cap, and does at the cap", () => {
		const big = (n: number, key = "k") => [
			...Array.from({ length: n }, (_, i) =>
				del(i + 1, `line ${i}`, { clusterKey: key }),
			),
			...Array.from({ length: n }, (_, i) =>
				add(i + 1, `  line ${i}`, { clusterKey: key }),
			),
		];
		const over = big(PAIR_CAP + 1);
		const plain = pairHunk(over);
		expect(plain.every((r) => r.kind === "line")).toBe(true);
		expectCoverage(over, plain);
		const at = big(PAIR_CAP);
		const paired = pairHunk(at);
		expect(paired.every((r) => r.kind === "ws")).toBe(true);
		expect(paired).toHaveLength(PAIR_CAP);
	});

	it("over the cap for the hunk, matches each run on its own (a big re-indented file keeps its rows)", () => {
		// Two re-indented runs around a context line: together over the cap.
		const half = PAIR_CAP / 2 + 10;
		const run = (key: string, from: number) => [
			...Array.from({ length: half }, (_, i) =>
				del(from + i, `${key} ${i}`, { clusterKey: key }),
			),
			...Array.from({ length: half }, (_, i) =>
				add(from + i, `  ${key} ${i}`, { clusterKey: key }),
			),
		];
		const lines: DiffLine[] = [
			...run("A", 1),
			ctx(half + 1, half + 1, "between"),
			...run("B", half + 2),
		];
		const rows = pairHunk(lines);
		expectCoverage(lines, rows);
		expect(rows.filter((r) => r.kind === "ws")).toHaveLength(2 * half);
		// A single run over the cap on its own still can't be matched.
		const huge = [
			...Array.from({ length: PAIR_CAP + 1 }, (_, i) =>
				del(i + 1, `c ${i}`, { clusterKey: "C" }),
			),
			...Array.from({ length: PAIR_CAP + 1 }, (_, i) =>
				add(i + 1, `  c ${i}`, { clusterKey: "C" }),
			),
		];
		const wide: DiffLine[] = [...huge, ctx(PAIR_CAP + 2, PAIR_CAP + 2, "x")];
		expect(pairHunk(wide).every((r) => r.kind === "line")).toBe(true);
	});

	it("leaves a run of an unexpected shape alone", () => {
		const lines: DiffLine[] = [add(2, " b", {}), del(2, "b")];
		const rows = pairRun(lines, matchHunk(lines));
		expect(rows.every((r) => r.kind === "line")).toBe(true);
		expect(rows.map((r) => (r.kind === "line" ? r.line : null))).toEqual(lines);
	});

	it("matches across a context line: a twin in another run, or a context twin, gives one-sided rows", () => {
		// Git's shape for a re-indented block whose `}` byte-matched another:
		// cluster A adds `}` and `sum`, a context `}`, cluster B removes them.
		const lines: DiffLine[] = [
			del(8, "  if (x) {", { clusterKey: "A" }),
			add(8, "    if (x) {", { clusterKey: "A" }),
			add(9, "    }", { clusterKey: "A" }),
			add(10, "    sum += 1;", { clusterKey: "A" }),
			ctx(9, 11, "  }"),
			del(10, "  sum += 1;", { clusterKey: "B" }),
			del(11, "}", { clusterKey: "B" }),
			ctx(12, 12, "return;"),
		];
		const rows = pairHunk(lines);
		expect(trace(rows)).toEqual([
			"~8/8",
			"~/9",
			"~/10",
			" 9/11",
			"~10/",
			"~11/",
			" 12/12",
		]);
		expectCoverage(lines, rows);
		const twins = matchHunk(lines);
		expect(twins.get(lines[1] as DiffLine)).toBe(lines[0]);
		expect(twins.get(lines[2] as DiffLine)).toBe(lines[4]);
		expect(twins.get(lines[3] as DiffLine)).toBe(lines[5]);
		expect(twins.get(lines[6] as DiffLine)).toBe(lines[4]);
		for (const run of runs(lines)) {
			if (run.key) expect(whitespaceOnly(pairRun(run.lines, twins))).toBe(true);
		}
	});

	it("keeps a line moved across a context line a change (a real reorder)", () => {
		// old [A, B] → new [B, A], with A unchanged bytes: B moved.
		const lines: DiffLine[] = [
			add(1, "B", { clusterKey: "A" }),
			ctx(1, 2, "A"),
			del(2, " B", { clusterKey: "B" }),
		];
		expect(trace(pairHunk(lines))).toEqual(["+1", " 1/2", "-2"]);
		expectCoverage(lines, pairHunk(lines));
	});

	it("keeps a re-indented block moved across an unchanged line a change", () => {
		// Git's hunk for old `init(); a(); b();` → new `a(); b(); init();`
		// re-indented: `+a +b`, ` init();`, `-a -b`. The reorder is real.
		const t1: DiffLine[] = [
			add(1, "    a();", { clusterKey: "A" }),
			add(2, "    b();", { clusterKey: "A" }),
			ctx(1, 3, "  init();"),
			del(2, "  a();", { clusterKey: "B" }),
			del(3, "  b();", { clusterKey: "B" }),
		];
		expect(trace(pairHunk(t1))).toEqual(["+1", "+2", " 1/3", "-2", "-3"]);
		expectCoverage(t1, pairHunk(t1));
		// Three lines: more change matches than one context self-match.
		const t2: DiffLine[] = [
			add(1, "    a();", { clusterKey: "A" }),
			add(2, "    b();", { clusterKey: "A" }),
			add(3, "    c();", { clusterKey: "A" }),
			ctx(1, 4, "  init();"),
			del(2, "  a();", { clusterKey: "B" }),
			del(3, "  b();", { clusterKey: "B" }),
			del(4, "  c();", { clusterKey: "B" }),
		];
		expect(trace(pairHunk(t2))).toEqual([
			"+1",
			"+2",
			"+3",
			" 1/4",
			"-2",
			"-3",
			"-4",
		]);
		expectCoverage(t2, pairHunk(t2));
	});

	it("keeps a change that would take one side of a context line a change", () => {
		// A second `}` added before a context `}`: one of them is new, and
		// no context row can show that, so the added one stays added.
		const lines: DiffLine[] = [add(1, "}"), ctx(1, 2, "  }")];
		expect(trace(pairHunk(lines))).toEqual(["+1", " 1/2"]);
		const both: DiffLine[] = [ctx(1, 1, "  }"), del(2, "}")];
		expect(trace(pairHunk(both))).toEqual([" 1/1", "-2"]);
	});

	it("a pure re-indent that git splits over context lines comes out all whitespace-only", () => {
		const hunk = gitHunk(REINDENT_OLD, REINDENT_NEW);
		const rows = pairHunk(hunk.lines);
		expectCoverage(hunk.lines, rows);
		const changes = rows.filter(
			(r) => r.kind === "line" && r.line.kind !== "context",
		);
		expect(changes).toEqual([]);
		const clusterRuns = runs(hunk.lines).filter((r) => r.key !== undefined);
		expect(clusterRuns).toHaveLength(5);
		const twins = matchHunk(hunk.lines);
		for (const run of clusterRuns) {
			expect(whitespaceOnly(pairRun(run.lines, twins))).toBe(true);
		}
	});

	it("a wrapped loop shows the `if`, its `}` and the `log` line that crossed a context row; the body is whitespace-only", () => {
		const hunk = gitHunk(WRAP_OLD, WRAP_NEW);
		const rows = pairHunk(hunk.lines);
		expectCoverage(hunk.lines, rows);
		const changes = rows.flatMap((r) =>
			r.kind === "line" && r.line.kind !== "context" ? [r.line] : [],
		);
		expect(changes.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(
			WRAP_ADDED,
		);
		expect(changes.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(
			WRAP_REMOVED,
		);
		// The loop body: six two-sided pairs, nothing one-sided.
		const pairs = rows.filter((r) => r.kind === "ws");
		expect(pairs).toHaveLength(6);
		expect(pairs.every((r) => r.kind === "ws" && r.del && r.add)).toBe(true);
	});

	it("covers every line exactly once for any generated hunk", () => {
		// A small deterministic generator, so a failure reproduces.
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ["a", "b", "}", "if (x)", "return", "", "a\u00A0b"];
		const blank = ["", " ", "\t", "  ", "\r", " \t "];
		const line = () => {
			const w = words[rand(words.length)] as string;
			return `${blank[rand(blank.length)]}${w}${blank[rand(blank.length)]}`;
		};
		for (let n = 0; n < 400; n++) {
			// Runs of context lines and cluster runs, in turn.
			const lines: DiffLine[] = [];
			let oldNo = 1;
			let newNo = 1;
			const parts = 1 + rand(4);
			for (let p = 0; p < parts; p++) {
				for (let c = rand(3); c > 0; c--) {
					lines.push(ctx(oldNo++, newNo++, line()));
				}
				const key = `k${p}`;
				const dels = Array.from({ length: rand(6) }, () =>
					del(oldNo++, line(), { clusterKey: key }),
				);
				const adds = Array.from({ length: rand(6) }, () =>
					add(newNo++, line(), { clusterKey: key }),
				);
				// Sometimes a side's last line has no final newline.
				const lastDel = dels[dels.length - 1];
				if (lastDel && rand(3) === 0) lastDel.noNewline = true;
				const lastAdd = adds[adds.length - 1];
				if (lastAdd && rand(3) === 0) lastAdd.noNewline = true;
				lines.push(...dels, ...adds);
			}
			const rows = pairHunk(lines);
			expectCoverage(lines, rows);
			for (const run of runs(lines)) {
				if (run.key === undefined) continue;
				const mine = pairRun(run.lines, matchHunk(lines));
				expect(whitespaceOnly(mine)).toBe(
					mine.length > 0 && mine.every((r) => r.kind === "ws"),
				);
			}
		}
	});

	it("never hides a block moved across unchanged lines, for any generated move", () => {
		// Git's shape for old [X.., block] → new [block', X..], the block
		// re-indented (and sometimes edited): adds, context, dels.
		let seed = 4242;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const words = ["a();", "b();", "}", "init();", "x", "if (y) {"];
		const indent = ["", "  ", "\t", "    "];
		for (let n = 0; n < 400; n++) {
			const block = Array.from(
				{ length: 1 + rand(4) },
				() => words[rand(words.length)] as string,
			);
			const across = Array.from(
				{ length: 1 + rand(3) },
				() => `${indent[rand(indent.length)]}${words[rand(words.length)]}`,
			);
			const edited = rand(3) === 0 ? rand(block.length) : -1;
			const lines: DiffLine[] = [];
			let newNo = 1;
			block.forEach((w, i) => {
				const text = `${indent[rand(indent.length)]}${i === edited ? `${w} // changed` : w}`;
				lines.push(add(newNo++, text, { clusterKey: "A" }));
			});
			let oldNo = 1;
			for (const text of across) lines.push(ctx(oldNo++, newNo++, text));
			for (const w of block) {
				lines.push(
					del(oldNo++, `${indent[rand(indent.length)]}${w}`, {
						clusterKey: "B",
					}),
				);
			}
			const rows = pairHunk(lines);
			expectCoverage(lines, rows);
		}
	});
});

describe("viewRuns", () => {
	const lines: DiffLine[] = [
		ctx(1, 1, "a"),
		del(2, "b"),
		del(3, "c"),
		add(2, "  b"),
		add(3, "d"),
		ctx(4, 4, "e"),
	];

	it("keeps every line as it is with Ignore whitespace off", () => {
		const out = viewRuns(lines, false);
		expect(out.map((r) => r.key)).toEqual([undefined, "k", undefined]);
		expect(trace(out.flatMap((r) => r.rows))).toEqual([
			" 1/1",
			"-2",
			"-3",
			"+2",
			"+3",
			" 4/4",
		]);
	});

	it("pairs each cluster run with Ignore whitespace on, as pairHunk", () => {
		const out = viewRuns(lines, true);
		expect(out.map((r) => r.lines)).toEqual(runs(lines).map((r) => r.lines));
		expect(trace(out.flatMap((r) => r.rows))).toEqual([
			" 1/1",
			"~2/2",
			"-3",
			"+3",
			" 4/4",
		]);
	});
});
