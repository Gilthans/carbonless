import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prView,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { createPrFixture, type PrFixture } from "../test/pr-fixture";
import { compareThreads, main } from "./compare-threads";

/** a.txt's two changes (pr-fixture.ts): line 2 and line 26. */
const HUNK_2 = "@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 changed";
const HUNK_26 =
	"@@ -23,4 +23,4 @@\n line 23\n line 24\n line 25\n-line 26\n+line 26 changed";

describe("compare-threads", () => {
	let pr: PrFixture;
	let out: string;

	/** One thread per kind of anchor: right, left, a range, a file comment. */
	const scenario = (over: Partial<Scenario> = {}) => {
		const head = pr.head();
		const on = (i: number, diffHunk: string) => [
			threadComment({
				login: "rev1",
				text: `Thread ${i}`,
				commit: head,
				createdAt: `2099-01-0${i + 1}T09:00:00Z`,
				diffHunk,
			}),
			threadComment({
				login: "octo-author",
				text: "Reply",
				createdAt: `2099-01-0${i + 1}T10:00:00Z`,
			}),
		];
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: head, baseRefName: "main" }),
					graphql: {
						// The comments' dates are after the clone's commits: their base is known.
						commits: [
							{ commit: { oid: head, committedDate: "2099-01-01T00:00:00Z" } },
						],
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2 }, on(0, HUNK_2)),
							reviewThread(
								{ path: "a.txt", line: 2, diffSide: "LEFT" },
								on(1, "@@ -1,2 +1,2 @@\n line 1\n-line 2"),
							),
							reviewThread(
								{
									path: "a.txt",
									line: 26,
									originalStartLine: 25,
									startDiffSide: "RIGHT",
								},
								on(2, HUNK_26),
							),
							reviewThread(
								{
									path: "new.txt",
									subjectType: "FILE",
									line: null,
									originalLine: null,
								},
								on(3, ""),
							),
						],
					},
				},
			},
			...over,
		});
	};

	beforeEach(() => {
		pr = createPrFixture();
		out = mkdtempSync(join(tmpdir(), "crb-compare-"));
	});
	afterEach(async () => {
		await pr.cleanup();
		rmSync(out, { recursive: true, force: true });
	});

	it("finds every thread matching GitHub, and main exits 0", async () => {
		scenario();
		const c = await compareThreads(pr.arg);
		expect(c.threads.map((t) => [t.github, t.match, t.causes])).toEqual([
			["file", true, []],
			["RIGHT 25-26", true, []],
			["LEFT 2", true, []],
			["RIGHT 2", true, []],
		]);
		expect(c.counts).toMatchObject({
			total: 4,
			matching: 4,
			mismatches: 0,
			fileComments: 1,
			clone: 3,
			snapshotSame: 3,
		});

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await main([pr.arg, "--out", out])).toBe(0);
		} finally {
			log.mockRestore();
			err.mockRestore();
		}
		expect(readFileSync(join(out, "compare.md"), "utf8")).toContain(
			"4/4 match, 0 mismatches",
		);
		expect(JSON.parse(readFileSync(join(out, "compare.json"), "utf8"))).toEqual(
			JSON.parse(JSON.stringify(c)),
		);
		// Its own cache under --out, never the reviewer's.
		expect(existsSync(join(out, "xdg", "carbonless"))).toBe(true);
		// Read-only on GitHub: REST reads only.
		expect(pr.ghLog()).toContain("api repos/acme/widget/pulls/12/comments");
		expect(pr.ghLog()).not.toMatch(/-X|--method|mutation/);
	});

	it("reports GitHub's range off by one as a mismatch, and main exits 1", async () => {
		// Thread 0's opener: GitHub's line one below what the hunk ends at.
		scenario({ restEdits: { "C12-0": { original_line: 3, line: 3 } } });
		const c = await compareThreads(pr.arg);
		const off = c.threads.find((t) => t.id === "T12-0");
		expect(off).toMatchObject({
			github: "RIGHT 3",
			ours: "RIGHT 2 (1 marked)",
		});
		expect(off?.match).toBe(false);
		expect(off?.causes).toContain("end line");
		expect(c.counts).toMatchObject({ total: 4, matching: 3, mismatches: 1 });

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await main([pr.arg, "--out", out])).toBe(1);
		} finally {
			log.mockRestore();
			err.mockRestore();
		}
		expect(readFileSync(join(out, "compare.md"), "utf8")).toMatch(
			/\| RIGHT 3 \| RIGHT 2 \(1 marked\) \| clone \| same \| NO \| end line/,
		);
	});

	it("as of a cutoff, compares only the threads opened by then", async () => {
		scenario({ commits: { [pr.head()]: { contexts: [] } } });
		const c = await compareThreads(pr.arg, { asOf: "2099-01-02T12:00:00Z" });
		expect(c.asOf).toBe("2099-01-02T12:00:00Z");
		expect(c.threads.map((t) => [t.id, t.match])).toEqual([
			["T12-1", true],
			["T12-0", true],
		]);
	});
});
