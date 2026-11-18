import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
	testGitEnv,
} from "../test/git-fixture";
import {
	type Corpus,
	main,
	report,
	type ScoreRun,
	verdictOf,
} from "./score-carry";

// Real git: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const CORPUS = join(
	import.meta.dirname,
	"../test/fixtures/score-carry/corpus.json",
);

const KEEP = "package a\n\nfunc keep() int {\n\treturn 1\n}\n";

/** The synthetic review the example corpus describes: base, then two patch sets. */
const COMMITS = [
	{ message: "base", files: { "a.go": KEEP } },
	{
		message: "ps1",
		files: {
			"a.go": `${KEEP}
func work(n int) int {
	total := 0
	for i := 0; i < n; i++ {
		total += i
	}
	logResult("work", total)
	return total
}
`,
		},
	},
	{
		message: "ps2",
		files: {
			"a.go": `${KEEP}
func work(n int) int {
	// Gauss: no loop needed.
	if n > 0 {
		logResult("work", total(n))
	}
	return total(n)
}
`,
		},
	},
];

describe("score-carry", () => {
	let repo: GitFixture;
	let out: string;

	beforeAll(() => {
		repo = createGitFixture(COMMITS);
		["base", "ps1", "ps2"].forEach((tag, i) => {
			execFileSync("git", ["tag", tag, repo.shas[i] as string], {
				cwd: repo.path,
				env: testGitEnv(),
			});
		});
		out = mkdtempSync(join(tmpdir(), "score-carry-"));
	});
	afterAll(() => {
		repo.cleanup();
		rmSync(out, { recursive: true, force: true });
	});

	const run = async (...args: string[]) => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const code = await main([CORPUS, "--repo", repo.path, ...args]);
			return {
				code,
				printed: log.mock.calls.map((c) => c.join(" ")).join("\n"),
			};
		} finally {
			log.mockRestore();
		}
	};

	it("scores the example corpus with the current tracer", async () => {
		const { code, printed } = await run("--out", out);
		expect(code).toBe(0);
		const result = JSON.parse(
			readFileSync(join(out, "score-carry.json"), "utf8"),
		) as ScoreRun;
		expect(
			Object.fromEntries(result.entries.map((e) => [e.id, e.verdict])),
		).toEqual({
			"unchanged@ps2": "right",
			// Its hunk adds only unrelated lines: unplaced, never on `if n > 0`.
			"loop-gone@ps2": "unplaced-ok",
			// Re-indented and edited inside the rewrite: its partner.
			"log-moved@ps2": "right",
			"return-range@ps2": "right",
			"file@ps2": "right",
			"expects-the-old-loop@ps2": "unplaced-wrong",
			"expects-gone-but-kept@ps2": "wrong-line",
		});
		expect(printed.split("\n")[0]).toMatch(
			/^tracer \d+: 5\/7 right {2}\(right 4, wrong-line 1, unplaced-ok 1, unplaced-wrong 1\)$/,
		);
		expect(printed).toContain(
			"  disputed: 0/2 right  (right 0, wrong-line 1, unplaced-ok 0, unplaced-wrong 1)",
		);
		expect(printed).toContain(
			"  rewritten: 3/3 right  (right 2, wrong-line 0, unplaced-ok 1, unplaced-wrong 0)",
		);
	});

	it("--compare lists each entry whose verdict changed, with both placements", async () => {
		const previous = JSON.parse(
			readFileSync(join(out, "score-carry.json"), "utf8"),
		) as ScoreRun;
		const edited: ScoreRun = {
			tracerVersion: 1,
			entries: previous.entries.map((e) =>
				e.id === "loop-gone@ps2"
					? {
							...e,
							verdict: "wrong-line",
							placement: {
								kind: "changed",
								anchor: {
									path: "a.go",
									startSide: "RIGHT",
									startLine: 9,
									side: "RIGHT",
									line: 9,
								},
								old: { side: "RIGHT", startLine: 9, line: 9, text: [] },
								now: [],
							},
						}
					: e,
			),
		};
		const file = join(out, "previous.json");
		writeFileSync(file, JSON.stringify(edited));
		const { printed } = await run("--compare", file);
		expect(printed).toContain("compared with tracer 1: 1 verdict(s) changed");
		expect(printed).toMatch(
			/ {2}loop-gone@ps2: wrong-line \(changed a\.go:9\) -> unplaced-ok \(unplaced deleted near \d+\)/,
		);
	});

	it("refuses a corpus it can't read as version 1, and a missing repository", async () => {
		const bad = join(out, "bad.json");
		writeFileSync(bad, JSON.stringify({ version: 2, entries: [] }));
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await main([bad, "--repo", repo.path])).toBe(2);
			expect(await main([CORPUS])).toBe(2);
		} finally {
			err.mockRestore();
		}
	});
});

describe("verdictOf", () => {
	const entry = (expected: Corpus["entries"][number]["expected"]) => ({
		id: "t",
		madeAt: { commit: "c", path: "a.go", side: "RIGHT" as const, line: 3 },
		target: { commit: "d" },
		expected,
	});
	const placed = (startLine: number, line: number) =>
		({
			kind: "placed",
			anchor: {
				path: "a.go",
				startSide: "RIGHT",
				startLine,
				side: "RIGHT",
				line,
			},
			changed: false,
		}) as const;

	it("counts a range that touches an expected line", () => {
		expect(verdictOf(entry({ path: "a.go", lines: [5] }), placed(4, 6))).toBe(
			"right",
		);
		expect(verdictOf(entry({ path: "a.go", lines: [5] }), placed(6, 7))).toBe(
			"wrong-line",
		);
		expect(verdictOf(entry({ path: "b.go", lines: [5] }), placed(5, 5))).toBe(
			"wrong-line",
		);
	});

	it("an unplaced thread is right only when expected gone", () => {
		const gone = {
			kind: "unplaced",
			fate: "deleted",
			path: "a.go",
			nearest: null,
		} as const;
		expect(verdictOf(entry("gone"), gone)).toBe("unplaced-ok");
		expect(verdictOf(entry({ path: "a.go", lines: [3] }), gone)).toBe(
			"unplaced-wrong",
		);
		expect(verdictOf(entry("file"), gone)).toBe("wrong-line");
	});

	it("report shows right/total with each verdict", () => {
		expect(
			report({
				tracerVersion: 9,
				entries: [
					{
						id: "x",
						tags: [],
						verdict: "unplaced-ok",
						placement: { kind: "outside", path: "a.go", fate: "file-gone" },
					},
				],
			}),
		).toBe(
			"tracer 9: 1/1 right  (right 0, wrong-line 0, unplaced-ok 1, unplaced-wrong 0)",
		);
	});
});
