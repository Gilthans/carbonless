import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "../src/server/session";
import {
	prView,
	reviewThread,
	type Scenario,
	threadComment,
} from "../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../test/git-fixture";
import { createPrFixture, type PrFixture } from "../test/pr-fixture";
import {
	compareThreads,
	githubCell,
	main,
	placementAgreement,
	placementCell,
	placementKind,
} from "./compare-threads";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

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

		const xdg = process.env.XDG_CACHE_HOME;
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
		// ...set for the run only.
		expect(process.env.XDG_CACHE_HOME).toBe(xdg);
		// Read-only on GitHub: REST reads only.
		expect(pr.ghLog()).toContain("api repos/acme/widget/pulls/12/comments");
		expect(pr.ghLog()).not.toMatch(/\s(-X|--method)\s|\bmutation\b/);
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

	it("reports a thread not served only if a second read misses it too", async () => {
		scenario();
		const real = Session.prototype.threads;
		let reads = 0;
		let always = false;
		// carbonless's read missing thread 0: the first time, or every time.
		const spy = vi
			.spyOn(Session.prototype, "threads")
			.mockImplementation(async function (this: Session, id, stage) {
				const view = await real.call(this, id, stage);
				reads++;
				if (reads > 1 && !always) return view;
				return {
					...view,
					threads: view.threads.filter((t) => t.id !== "T12-0"),
				};
			});
		try {
			const once = await compareThreads(pr.arg);
			expect(reads).toBe(2);
			expect(once.counts).toMatchObject({ total: 4, matching: 4 });

			always = true;
			const twice = await compareThreads(pr.arg);
			expect(twice.threads.find((t) => t.id === "T12-0")).toMatchObject({
				ours: "not served",
				match: false,
				causes: ["not served"],
				notes: ["also when read again"],
			});
			expect(twice.counts.mismatches).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("compares a merged PR as of now, at its last head", async () => {
		scenario({ commits: { [pr.head()]: { contexts: [] } } });
		const s = JSON.parse(
			readFileSync(process.env.CRB_FAKE_GH ?? "", "utf8"),
		) as Scenario;
		const twelve = s.prs[12];
		if (!twelve) throw new Error("no PR 12");
		const view = { ...twelve.view, state: "MERGED" };
		pr.scenario({ ...s, prs: { 12: { ...twelve, view } } });
		// Now: after the threads' (future) dates.
		vi.useFakeTimers({
			toFake: ["Date"],
			now: new Date("2099-02-01T00:00:00Z"),
		});
		try {
			const c = await compareThreads(pr.arg);
			expect(c.over).toBe("MERGED");
			expect(c.asOf).toBe("2099-02-01T00:00:00Z");
			expect(c.counts).toMatchObject({ total: 4, matching: 4 });
		} finally {
			vi.useRealTimers();
		}
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

describe("compare-threads --placed-from (placements across rounds)", () => {
	let pr: PrFixture;
	let out: string;
	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

	beforeEach(() => {
		pr = createPrFixture();
		out = mkdtempSync(join(tmpdir(), "crb-compare-"));
	});
	afterEach(async () => {
		await pr.cleanup();
		rmSync(out, { recursive: true, force: true });
	});

	/**
	 * Round 1 on head 1 (threads opened 2099-01-02), round 2 on head 2
	 * (pushed 2099-01-06): three lines on top of a.txt, line 2 rewritten,
	 * line 26 as it was (now 29). GitHub's REST `line` per thread on head 2.
	 */
	const twoRounds = (opts: { pushedAfter?: boolean } = {}) => {
		const first = pr.head();
		const next = [...lines];
		next[1] = "line 2 reworked";
		next[25] = "line 26 changed";
		const second = pr.moveHead({
			"a.txt": `top 1\ntop 2\ntop 3\n${next.join("\n")}\n`,
			"new.txt": "new\nmore\n",
		});
		// A third push after the second round's cutoff: GitHub's head now.
		const third = opts.pushedAfter
			? pr.moveHead({ "later.txt": "later\n" })
			: second;
		const opener = (i: number, at = "2099-01-02T09:00:00Z") => [
			threadComment({
				login: "rev1",
				text: `Thread ${i}`,
				commit: first,
				createdAt: at,
			}),
		];
		const on = (line: number, now: number | null) => ({
			path: "a.txt",
			originalLine: line,
			line: now,
		});
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: third, baseRefName: "main" }),
					graphql: {
						commits: [
							{
								commit: { oid: first, committedDate: "2099-01-01T00:00:00Z" },
							},
							{
								commit: { oid: second, committedDate: "2099-01-06T00:00:00Z" },
							},
							...(third === second
								? []
								: [
										{
											commit: {
												oid: third,
												committedDate: "2099-02-01T00:00:00Z",
											},
										},
									]),
						],
						reviewThreads: [
							// Line 26 moved down by three: both say 29.
							reviewThread(on(26, 29), opener(0)),
							// Line 2 rewritten: GitHub outdated, carbonless changed.
							reviewThread(on(2, null), opener(1)),
							// GitHub one off: a line disagreement.
							reviewThread(on(26, 30), opener(2)),
							// GitHub outdated, carbonless on the same text.
							reviewThread(on(26, null), opener(3)),
							reviewThread(
								{
									path: "new.txt",
									subjectType: "FILE",
									line: null,
									originalLine: null,
								},
								opener(4),
							),
							// Opened in round 2: not in the table.
							reviewThread(on(26, 29), opener(5, "2099-01-07T09:00:00Z")),
							// Resolved since: as of a cutoff nothing reads resolved
							// (GitHub doesn't say when), so it is placed.
							reviewThread({ ...on(26, 29), isResolved: true }, opener(6)),
						],
					},
				},
			},
			commits: {
				[first]: { contexts: [] },
				[second]: { contexts: [] },
				[third]: { contexts: [] },
			},
		});
		return { first, second, third };
	};

	it("places each first-round thread into the later head and compares it with GitHub's line", async () => {
		const { first, second } = twoRounds();
		const c = await compareThreads(pr.arg, {
			asOf: "2099-01-20T00:00:00Z",
			placedFrom: "2099-01-05T00:00:00Z",
		});
		const p = c.placements;
		if (!p) throw new Error("no placements");
		expect(p).toMatchObject({
			placedFrom: "2099-01-05T00:00:00Z",
			fromHead: first,
			toHead: second,
			githubHead: second,
			unlisted: 0,
		});
		const byId = Object.fromEntries(
			p.rows.map((r) => [r.id, [r.github, r.ours, r.oursNow, r.kind]]),
		);
		expect(byId).toEqual({
			"T12-0": ["RIGHT 29", "placed RIGHT 29", "", "agree"],
			"T12-1": ["outdated", "changed RIGHT 5", "", "agree"],
			"T12-2": ["RIGHT 30", "placed RIGHT 29", "", "line"],
			"T12-3": ["outdated", "placed RIGHT 29", "", "we-place-outdated"],
			"T12-4": ["file", "file", "", "agree"],
			"T12-6": ["RIGHT 29", "placed RIGHT 29", "", "agree"],
		});
		expect(p.counts).toEqual({ total: 6, agree: 4, disagree: 2 });
		// Strong agreements apart from the weak ones (GitHub's outdated).
		expect(p.agreements).toEqual({
			"line-exact": 2,
			file: 1,
			"outdated↔changed": 1,
		});
		expect(
			Object.fromEntries(p.rows.map((r) => [r.id, r.agreement ?? null])),
		).toEqual({
			"T12-0": "line-exact",
			"T12-1": "outdated↔changed",
			"T12-2": null,
			"T12-3": null,
			"T12-4": "file",
			"T12-6": "line-exact",
		});

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await main([
				pr.arg,
				"--as-of",
				"2099-01-20T00:00:00Z",
				"--placed-from",
				"2099-01-05T00:00:00Z",
				"--out",
				out,
			]);
			expect(
				await main([
					pr.arg,
					"--as-of",
					"2099-01-04T00:00:00Z",
					"--placed-from",
					"2099-01-05T00:00:00Z",
				]),
			).toBe(2);
		} finally {
			log.mockRestore();
			err.mockRestore();
		}
		const md = readFileSync(join(out, "compare.md"), "utf8");
		expect(md).toContain("## Placements");
		expect(md).toContain(
			"4/6 agree (2 line-exact, 1 file, 1 outdated↔changed), 2 disagree",
		);
		expect(md).toContain(
			"GitHub's outdated agrees with every carbonless outcome except placed",
		);
		expect(md).toMatch(
			/\| a\.txt \| 2099-01-02T09:00:00Z \| RIGHT 30 \| placed RIGHT 29 \| line \|/,
		);
		// Read-only on GitHub.
		expect(pr.ghLog()).not.toMatch(/\s(-X|--method)\s|\bmutation\b/);
	});

	it("places into GitHub's head now too when the PR moved on after --as-of", async () => {
		const { second, third } = twoRounds({ pushedAfter: true });
		const c = await compareThreads(pr.arg, {
			asOf: "2099-01-20T00:00:00Z",
			placedFrom: "2099-01-05T00:00:00Z",
		});
		expect(c.placements).toMatchObject({ toHead: second, githubHead: third });
		const row = c.placements?.rows.find((r) => r.id === "T12-0");
		expect(row).toMatchObject({
			ours: "placed RIGHT 29",
			oursNow: "placed RIGHT 29",
			kind: "agree",
		});
	});
});

describe("placement cells and kinds", () => {
	const rest = (
		more: Partial<Parameters<typeof placementKind>[1]> = {},
	): Parameters<typeof placementKind>[1] => ({
		node_id: "C1",
		path: "a.ts",
		line: 10,
		original_line: 8,
		start_line: null,
		original_start_line: null,
		side: "RIGHT",
		start_side: null,
		original_commit_id: null,
		diff_hunk: "",
		...more,
	});
	const anchor = (line: number, path = "a.ts", side = "RIGHT" as const) => ({
		path,
		startSide: side,
		startLine: line,
		side,
		line,
	});
	const placed = (line: number, path?: string) => ({
		kind: "placed" as const,
		anchor: anchor(line, path),
		changed: false as const,
	});

	it("agrees on the same path, side and end line; says which differs", () => {
		expect(placementKind(placed(10), rest())).toBe("agree");
		expect(placementKind(placed(11), rest())).toBe("line");
		expect(placementKind(placed(10, "b.ts"), rest())).toBe("path");
		expect(
			placementKind(
				{
					kind: "changed",
					anchor: { ...anchor(10), side: "LEFT", startSide: "LEFT" },
					old: { side: "RIGHT", startLine: 8, line: 8, text: [] },
					now: [],
				},
				rest(),
			),
		).toBe("side");
	});

	it("an outdated GitHub line agrees with anything but placed; a fate where GitHub places is we-unplace", () => {
		const gone = {
			kind: "unplaced" as const,
			fate: "deleted" as const,
			path: "a.ts",
			nearest: null,
		};
		expect(placementKind(placed(10), rest({ line: null }))).toBe(
			"we-place-outdated",
		);
		expect(placementKind(gone, rest({ line: null }))).toBe("agree");
		expect(placementKind(gone, rest())).toBe("we-unplace");
		expect(
			placementKind(
				{ kind: "outside", path: "a.ts", fate: "file-gone" },
				rest({ subject_type: "file", line: null }),
			),
		).toBe("we-unplace");
		expect(
			placementKind(
				{ kind: "file", path: "a.ts" },
				rest({ subject_type: "file", line: null }),
			),
		).toBe("agree");
	});

	it("labels each agreement strong (line-exact, file) or weak (GitHub outdated against a fate)", () => {
		const gone = {
			kind: "unplaced" as const,
			fate: "deleted" as const,
			path: "a.ts",
			nearest: null,
		};
		expect(placementAgreement(placed(10), rest())).toBe("line-exact");
		expect(
			placementAgreement(
				{ kind: "file", path: "a.ts" },
				rest({ subject_type: "file", line: null }),
			),
		).toBe("file");
		expect(
			placementAgreement(
				{
					kind: "changed",
					anchor: anchor(10),
					old: { side: "RIGHT", startLine: 8, line: 8, text: [] },
					now: [],
				},
				rest({ line: null }),
			),
		).toBe("outdated↔changed");
		expect(placementAgreement(gone, rest({ line: null }))).toBe(
			"outdated↔unplaced",
		);
		expect(
			placementAgreement(
				{ kind: "outside", path: "a.ts", fate: "reverted" },
				rest({ line: null }),
			),
		).toBe("outdated↔outside");
		// A disagreement has no label.
		expect(placementAgreement(placed(11), rest())).toBeNull();
		expect(placementAgreement(placed(10), rest({ line: null }))).toBeNull();
	});

	it("names each placement and GitHub's place in one cell", () => {
		expect(placementCell(placed(10))).toBe("placed RIGHT 10");
		expect(
			placementCell({
				kind: "unplaced",
				fate: "moved",
				path: "a.ts",
				nearest: null,
				movedTo: "b.ts",
			}),
		).toBe("unplaced moved → b.ts");
		expect(
			placementCell({ kind: "outside", path: "x", fate: "reverted" }),
		).toBe("outside reverted");
		expect(githubCell(rest({ start_line: 8 }))).toBe("RIGHT 8-10");
		expect(githubCell(rest({ line: null }))).toBe("outdated");
		expect(githubCell(rest({ subject_type: "file" }))).toBe("file");
	});
});
