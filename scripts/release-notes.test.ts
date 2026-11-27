import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_SHIPPED_BYTES,
	type ReleaseNotesFile,
	type ShippedReleaseNotes,
} from "../src/shared/releaseNotes.js";
import { GIT_TEST_TIMEOUTS } from "../test/git-fixture";
import { type Io, type RunResult, tarballDigests } from "./release-lib.js";
import {
	auditNotes,
	capShipped,
	collectNotes,
	commentNoteLines,
	coverage,
	decodeNotesInput,
	descriptionsNote,
	encodeNotesInput,
	finishNotes,
	formatNotesFile,
	kindFromLabels,
	type Linear,
	linearClient,
	linearKey,
	MAX_NOTES_INPUT_CHARS,
	mdText,
	mergeNotes,
	mergeOkNotes,
	NOTE_CHECK,
	NOTE_WORKFLOW_NAME,
	notesCheck,
	notesFromInput,
	parseNoteLine,
	postNote,
	prBodiesIo,
	prBodyNote,
	prNotesOk,
	promoteNotes,
	rcNotes,
	readNotesFile,
	releaseRange,
	renderNotesBody,
	rerunNoteChecks,
	rerunRedNoteCheck,
	shippedNotes,
	subjectPr,
	ticketNote,
	titleTickets,
	undescribedPrs,
	withChangelogSection,
	workflowText,
	writeNotes,
} from "./release-notes.js";

describe("Release note lines", () => {
	it("reads the marker forms: a kind, none with its reason", () => {
		expect(parseNoteLine("Release note (new): Threads tab.")).toEqual({
			kind: "new",
			text: "Threads tab.",
		});
		expect(parseNoteLine("release note (Fixed) :  Ok now.  ")).toEqual({
			kind: "fixed",
			text: "Ok now.",
		});
		expect(parseNoteLine("Release note: Kind from the labels.")).toEqual({
			kind: null,
			text: "Kind from the labels.",
		});
		expect(parseNoteLine("Release note: none (flaky test fix)")).toEqual({
			none: "flaky test fix",
		});
	});

	it("refuses none without a reason, a kind on none, an unknown kind, and a note breaking the text rules", () => {
		for (const [line, error] of [
			["Release note: none", /none needs a reason in parentheses/],
			["Release note: none ()", /reason is empty/],
			["Release note (new): none (x)", /none takes no kind/],
			["Release note (huge): Big.", /new, improved or fixed, not huge/],
			[
				"Release note (new): fixes CAR-12.",
				/starts with a lowercase letter.*names a ticket/,
			],
			["Release note (new): A <b>bold</b> claim.", /has HTML/],
			["Release note new: x", /isn't "Release note/],
		] as const) {
			const r = parseNoteLine(line);
			expect("error" in r && r.error, line).toMatch(error);
		}
	});

	it("defaults the kind from Feature, Improvement or Bug, and only from one of them", () => {
		expect(kindFromLabels(["Feature", "mobile"])).toBe("new");
		expect(kindFromLabels(["improvement"])).toBe("improved");
		expect(kindFromLabels(["Bug", "flaky-test"])).toBe("fixed");
		expect(kindFromLabels(["Bug", "Feature"])).toBeNull();
		expect(kindFromLabels([])).toBeNull();
	});

	it("a comment counts when its first line is a Release note line; text after a blank line is free, a line right under a note is an error", () => {
		expect(commentNoteLines("Looks done.\nRelease note: none (x)")).toBeNull();
		expect(
			commentNoteLines(
				"\nRelease note (new): One thing.\nRelease note (fixed): Another.",
			),
		).toEqual([
			{ kind: "new", text: "One thing." },
			{ kind: "fixed", text: "Another." },
		]);
		// As agents write them: the note, then the merge report.
		expect(
			commentNoteLines(
				"Release note: Opens the review.\n\nMerged 2026-11-17 as PR #140 (a61f36b3). Follow-ups: ask the owner.",
			),
		).toEqual([{ kind: null, text: "Opens the review." }]);
		expect(
			commentNoteLines(
				"Release note (new): A long note that\nwraps onto a second line.",
			),
		).toEqual([
			{ kind: "new", text: "A long note that" },
			{
				error: expect.stringMatching(
					/continues a Release note line: a note is one line/,
				),
			},
		]);
	});

	it("the newest release-note comment wins by updatedAt (an edit counts); other comments don't", () => {
		const c = (body: string, updatedAt: string) => ({ body, updatedAt });
		const comments = [
			c("Release note (new): First wording.", "2026-11-10T00:00:00Z"),
			c("Release note: none (refactor)", "2026-11-11T00:00:00Z"),
			c("Shipped!", "2026-11-14T00:00:00Z"),
			// Created first, edited last.
			c(
				"Release note: Second wording. With an explanation.",
				"2026-11-12T00:00:00Z",
			),
		];
		expect(ticketNote(comments, ["Improvement"])).toEqual({
			status: "notes",
			notes: [
				{ kind: "improved", text: "Second wording. With an explanation." },
			],
		});
		expect(ticketNote(comments.slice(0, 3), [])).toEqual({
			status: "none",
			why: "refactor",
		});
		expect(ticketNote([c("Shipped!", "2026-11-14T00:00:00Z")], [])).toEqual({
			status: "missing",
		});
		// No kind and labels that don't say: invalid, not a guess.
		expect(ticketNote(comments.slice(3), ["perf"]).status).toBe("invalid");
		// Notes and none together: invalid.
		expect(
			ticketNote(
				[
					c(
						"Release note (new): A.\nRelease note: none (x)",
						"2026-11-12T00:00:00Z",
					),
				],
				[],
			).status,
		).toBe("invalid");
	});

	it("any number of notes in one comment, none of them limited in sentences", () => {
		const long = `A summary. ${"Then more explanation. ".repeat(10).trim()}`;
		const body = Array.from(
			{ length: 5 },
			(_, i) => `Release note (new): Note ${i}. ${long}`,
		).join("\n");
		const s = ticketNote([{ body, updatedAt: "2026-11-12T00:00:00Z" }], []);
		expect(s.status === "notes" && s.notes.length).toBe(5);
	});

	it("a ticket-less PR's description: its Release note lines anywhere in it, a kind required", () => {
		expect(
			prBodyNote(
				"Fixes a test.\r\n\r\nRelease note: none (test tooling)\r\n\r\n🤖 Generated",
			),
		).toEqual({ status: "none", why: "test tooling" });
		expect(prBodyNote("## What\nRelease note (improved): Faster.")).toEqual({
			status: "notes",
			notes: [{ kind: "improved", text: "Faster." }],
		});
		expect(prBodyNote("Release note: Faster.").status).toBe("invalid");
		expect(prBodyNote(null)).toEqual({ status: "missing" });
	});
});

describe("PRs and tickets from first-parent subjects", () => {
	it("reads every CAR-NNN in a title, and the PR from (#N)", () => {
		expect(titleTickets("Threads tab (CAR-183)")).toEqual(["CAR-183"]);
		expect(titleTickets("CAR-113: re-review (car-114, CAR-113)")).toEqual([
			"CAR-113",
			"CAR-114",
		]);
		expect(titleTickets("e2e: keepalive (CAR-66, CAR-171)")).toEqual([
			"CAR-66",
			"CAR-171",
		]);
		expect(titleTickets("SCAR-1 and CAR-0 aren't tickets")).toEqual([]);
		expect(subjectPr("Threads tab (CAR-183) (#110)")).toEqual({
			number: 110,
			title: "Threads tab (CAR-183)",
			tickets: ["CAR-183"],
			exempt: false,
		});
		expect(subjectPr("next: 0.4.0 (#122)")?.exempt).toBe(true);
		expect(subjectPr("notes: 0.4.0 (#140)")?.exempt).toBe(true);
		expect(subjectPr("next: 0.4.0 is great (#1)")?.exempt).toBe(false);
		expect(subjectPr("Merge branch 'master' into x")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Against a throwaway repository: real git, gh faked, Linear faked.

type Handler =
	| Partial<RunResult>
	| string
	| ((args: string[]) => Partial<RunResult> | string);

/** An Io running git and tar for real in `repo`, and gh and npm from handlers (by argument prefix). */
function repoIo(
	repo: string,
	gh: Record<string, Handler> = {},
	tags: Io["tags"] = "local",
	npm: Record<string, Handler> = {},
) {
	const calls: string[] = [];
	const lines: string[] = [];
	const io: Io = {
		repo: "owner/repo",
		tags,
		log: (line) => lines.push(line),
		now: () => new Date("2026-11-20T10:00:00Z"),
		sleep: async () => {},
		run: (cmd, args, opts) => {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			if (cmd === "git" || cmd === "tar") {
				return new Promise((resolve) => {
					const child = spawn(cmd, args, { cwd: opts?.cwd ?? repo });
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (d) => {
						stdout += d;
					});
					child.stderr.on("data", (d) => {
						stderr += d;
					});
					child.on("close", (code) =>
						resolve({ code: code ?? 1, stdout, stderr }),
					);
				});
			}
			const handlers = cmd === "gh" ? gh : cmd === "npm" ? npm : {};
			const key = Object.keys(handlers)
				.filter((k) => line.startsWith(`${cmd} ${k}`))
				.sort((a, b) => b.length - a.length)[0];
			if (key === undefined) {
				return Promise.resolve({
					code: 127,
					stdout: "",
					stderr: `unexpected: ${line}`,
				});
			}
			const h = handlers[key] ?? "";
			const out = typeof h === "function" ? h([...args]) : h;
			return Promise.resolve(
				typeof out === "string"
					? { code: 0, stdout: out, stderr: "" }
					: { code: 0, stdout: "", stderr: "", ...out },
			);
		},
	};
	return { io, calls, lines };
}

type RawIssue = {
	labels?: string[];
	comments?: { body: string; updatedAt: string }[];
	attachments?: string[];
	title?: string;
};

/** A fake Linear: answers issue reads; any write fails unless `writes` collects them. */
function fakeLinear(
	issues: Record<string, RawIssue>,
	writes?: Record<string, unknown>[],
) {
	const queries: string[] = [];
	const raw = (identifier: string, i: RawIssue) => ({
		id: `uuid-${identifier}`,
		identifier,
		title: i.title ?? `${identifier} title`,
		state: { name: "Done", type: "completed" },
		labels: { nodes: (i.labels ?? []).map((name) => ({ name })) },
		comments: { nodes: i.comments ?? [] },
		attachments: { nodes: (i.attachments ?? []).map((url) => ({ url })) },
	});
	const linear: Linear = {
		query: async <T>(query: string, variables?: Record<string, unknown>) => {
			queries.push(query);
			if (/^\s*mutation/.test(query)) {
				if (!writes) throw new Error(`fake Linear: a write: ${query}`);
				writes.push(variables ?? {});
				return {
					commentCreate: {
						success: true,
						comment: { url: "https://linear.app/c/1" },
					},
				} as T;
			}
			if (query.includes("issue(id:")) {
				const id = String(variables?.id);
				const i = issues[id];
				return { issue: i ? raw(id, i) : null } as T;
			}
			if (query.includes("issues(")) {
				return {
					issues: {
						nodes: Object.entries(issues).map(([id, i]) => raw(id, i)),
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				} as T;
			}
			throw new Error(`fake Linear: unexpected ${query}`);
		},
	};
	return { linear, queries };
}

const note = (text: string, updatedAt = "2026-11-15T00:00:00Z") => ({
	body: `Release note: ${text}`,
	updatedAt,
});

describe("against a repository", {
	timeout: GIT_TEST_TIMEOUTS.testTimeout,
}, () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	const commit = (subject: string, files: Record<string, string> = {}) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(repo, path)), { recursive: true });
			writeFileSync(join(repo, path), text);
			git("add", path);
		}
		git("commit", "--allow-empty", "-q", "-m", subject);
		return git("rev-parse", "HEAD");
	};
	const notesFile = (f: Partial<ReleaseNotesFile> & { version: string }) =>
		formatNotesFile({ date: null, notes: [], none: [], ...f });

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "crb-notes-"));
		git("init", "-q", "-b", "master");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		commit("start", {
			"package.json":
				'{\n\t"name": "carbonless-review",\n\t"version": "0.3.0"\n}\n',
		});
		commit("Old feature (CAR-50) (#50)");
		commit("Spans releases, first part (CAR-66) (#51)");
		git("tag", "v0.3.0");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	/** 0.4.0's history: tickets, a ticket-less PR, two tickets in one title, the next PR. */
	const history = () => {
		commit("next: 0.4.0 (#60)", {
			"package.json":
				'{\n\t"name": "carbonless-review",\n\t"version": "0.4.0"\n}\n',
		});
		commit("Threads tab (CAR-183) (#110)");
		commit("Spans releases, second part (CAR-66) (#111)");
		commit("Test processes stop (#125)");
		commit("Merge branch 'x' (a direct push)");
		commit("e2e: keepalive (CAR-171, CAR-172) (#126)");
		commit("Threads tab, phone (CAR-183) (#127)");
	};

	it("the release range: first-parent PRs after the previous release, their tickets; nothing when empty", async () => {
		history();
		const { io } = repoIo(repo);
		const range = await releaseRange(io, "0.4.0", "HEAD");
		expect(range.from).toBe("v0.3.0");
		expect(range.prs.map((p) => [p.number, p.tickets, p.exempt])).toEqual([
			[60, [], true],
			[110, ["CAR-183"], false],
			[111, ["CAR-66"], false],
			[125, [], false],
			[126, ["CAR-171", "CAR-172"], false],
			[127, ["CAR-183"], false],
		]);
		expect(range.other).toEqual(["Merge branch 'x' (a direct push)"]);
		const empty = await releaseRange(io, "0.4.0", "v0.3.0");
		expect(empty.prs).toEqual([]);
		// The very first release: everything up to it.
		expect(
			(await releaseRange(io, "0.3.0", "v0.3.0")).prs.map((p) => p.number),
		).toEqual([50, 51]);
	});

	it("a next: or notes: title exempts a PR only when it changes nothing but package.json, docs/changelog.md and release-notes/", async () => {
		commit("next: 0.4.0 (#60)", {
			"package.json":
				'{\n\t"name": "carbonless-review",\n\t"version": "0.4.0"\n}\n',
			"docs/changelog.md": "# Changelog\n",
		});
		commit("notes: 0.4.0 (#61)", { "release-notes/0.4.0.json": "{}\n" });
		commit("notes: 0.4.0 (#62)", {
			"release-notes/0.4.0.json": "{ }\n",
			"src/sneaky.ts": "export {};\n",
		});
		const { io } = repoIo(repo);
		expect(
			(await releaseRange(io, "0.4.0", "HEAD")).prs.map((p) => [
				p.number,
				p.exempt,
			]),
		).toEqual([
			[60, true],
			[61, true],
			[62, false],
		]);
	});

	it("a merged-in branch's own commits are not PRs of the release (first parent only)", async () => {
		git("switch", "-q", "-c", "side");
		commit("Side work (CAR-999) (#999)");
		git("switch", "-q", "master");
		git("merge", "-q", "--no-ff", "-m", "Merged side (CAR-200) (#200)", "side");
		const { io } = repoIo(repo);
		expect(
			(await releaseRange(io, "0.4.0", "HEAD")).prs.map((p) => p.number),
		).toEqual([200]);
	});

	describe("a committed notes file (promote without a Linear key: git only)", () => {
		const covered = {
			version: "0.4.0",
			notes: [
				{
					id: "CAR-183",
					kind: "new" as const,
					prs: [110, 127],
					text: "Threads tab.",
				},
			],
			none: [
				{ id: "CAR-66", prs: [111], why: "refactor" },
				{ id: "#125", prs: [125], why: "test tooling" },
				{ id: "CAR-171", prs: [126], why: "flaky test fix" },
				{ id: "CAR-172", prs: [126], why: "flaky test fix" },
			],
		};

		it("passes when every ticket and ticket-less PR is in notes or none", async () => {
			history();
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile(covered),
			});
			const { io } = repoIo(repo);
			expect(await notesCheck(io, "0.4.0", sha)).toBe(
				"ok: release-notes/0.4.0.json covers the 5 PR(s) since v0.3.0 (1 notes, 4 none)",
			);
		});

		it("fails naming each missing ticket and PR, and a PR merged after the notes", async () => {
			history();
			commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({
					...covered,
					none: covered.none.filter(
						(n) => n.id !== "#125" && n.id !== "CAR-172",
					),
				}),
			});
			const sha = commit("Late one (CAR-200) (#141)");
			const { io } = repoIo(repo);
			await expect(notesCheck(io, "0.4.0", sha)).rejects.toThrow(
				"release-notes/0.4.0.json doesn't cover #125 (#125), CAR-172 (#126), CAR-200 (#141): give each a Release note (pnpm release note), then set up the Linear key ($LINEAR_API_KEY or ~/.config/linear/api-key) and promote again (it collects the notes itself); else run pnpm release notes 0.4.0 --pr again",
			);
		});

		it("fails without the file, on a file of another version, and on a malformed one", async () => {
			history();
			const none = git("rev-parse", "HEAD");
			const { io } = repoIo(repo);
			await expect(notesCheck(io, "0.4.0", none)).rejects.toThrow(
				/^no release-notes\/0\.4\.0\.json at [0-9a-f]{40}: set up the Linear key \(\$LINEAR_API_KEY or ~\/\.config\/linear\/api-key\) and promote again \(it collects the notes itself\); else run pnpm release notes 0\.4\.0 --pr/,
			);
			const other = commit("x (#2)", {
				"release-notes/0.4.0.json": notesFile({ ...covered, version: "0.5.0" }),
			});
			await expect(notesCheck(io, "0.4.0", other)).rejects.toThrow(
				"release-notes/0.4.0.json is for version 0.5.0",
			);
			const bad = commit("y (#3)", {
				"release-notes/0.4.0.json": JSON.stringify({
					...covered,
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110],
							text: "<img src=x onerror=alert(1)>",
						},
					],
				}),
			});
			await expect(notesCheck(io, "0.4.0", bad)).rejects.toThrow(
				/release-notes\/0\.4\.0\.json is malformed: notes\[0\] CAR-183: text .*has HTML/,
			);
			const notJson = commit("z (#4)", { "release-notes/0.4.0.json": "{" });
			await expect(notesCheck(io, "0.4.0", notJson)).rejects.toThrow(
				/isn't JSON/,
			);
		});

		it("a ticket an older release's file covers is covered (it shipped there)", async () => {
			// 0.4.0 shipped CAR-66's first part; 0.5.0 has its second part.
			commit("notes: 0.4.0 (#59)", {
				"release-notes/0.4.0.json": notesFile({
					version: "0.4.0",
					notes: [{ id: "CAR-66", kind: "new", prs: [59], text: "Keepalive." }],
				}),
			});
			git("tag", "v0.4.0");
			commit("Keepalive, part two (CAR-66) (#70)");
			const sha = commit("notes: 0.5.0 (#71)", {
				"release-notes/0.5.0.json": notesFile({ version: "0.5.0" }),
			});
			const { io } = repoIo(repo);
			expect(await notesCheck(io, "0.5.0", sha)).toMatch(/^ok: /);
		});
	});

	describe("ci:notes-input (promote-check, CAR-242: the input notes, git only)", () => {
		const file = (f: Partial<ReleaseNotesFile> = {}): ReleaseNotesFile => ({
			version: "0.4.0",
			date: null,
			notes: [
				{
					id: "CAR-183",
					kind: "new",
					prs: [110, 127],
					text: "Threads tab.",
				},
			],
			none: [
				{ id: "CAR-66", prs: [111], why: "refactor" },
				{ id: "#125", prs: [125], why: "test tooling" },
				{ id: "CAR-171", prs: [126], why: "flaky test fix" },
				{ id: "CAR-172", prs: [126], why: "flaky test fix" },
			],
			...f,
		});

		it("passes input notes covering every ticket and ticket-less PR with no file at the commit, and lists them; fails on one missing a ticket or PR", async () => {
			history();
			const sha = git("rev-parse", "HEAD");
			const { io } = repoIo(repo);
			const r = await notesFromInput(
				io,
				"0.4.0",
				sha,
				encodeNotesInput(file()),
			);
			expect(r.file).toEqual(file());
			expect(r.summary).toContain("### Release notes of 0.4.0");
			expect(r.summary).toContain(
				"The 5 PR(s) since v0.3.0: 1 notes, 4 none, from the promote's input.",
			);
			expect(r.summary).toContain("- Threads tab. (CAR-183, #110, #127)");
			const short = file({
				none: file().none.filter((n) => n.id !== "#125" && n.id !== "CAR-172"),
			});
			await expect(
				notesFromInput(io, "0.4.0", sha, encodeNotesInput(short)),
			).rejects.toThrow(
				"the release notes don't cover #125 (#125), CAR-172 (#126): give each a Release note (pnpm release note), then pnpm release promote again",
			);
			// Neither an input nor a file.
			await expect(notesFromInput(io, "0.4.0", sha, "")).rejects.toThrow(
				/^no release notes for 0\.4\.0: start the promote with pnpm release promote/,
			);
		});

		it("refuses an entry outside the RC's range (another RC's notes), and an input malformed, of another version, not base64 or not gzip", async () => {
			history();
			const sha = git("rev-parse", "HEAD");
			commit("Late one (CAR-200) (#141)");
			const { io } = repoIo(repo);
			const late = file({
				none: [...file().none, { id: "CAR-200", prs: [141], why: "later" }],
			});
			await expect(
				notesFromInput(io, "0.4.0", sha, encodeNotesInput(late)),
			).rejects.toThrow(
				/entries outside 0\.4\.0's PRs up to [0-9a-f]{40}: CAR-200 \(the notes input\)/,
			);
			await expect(
				notesFromInput(
					io,
					"0.4.0",
					sha,
					encodeNotesInput(file({ version: "0.5.0" })),
				),
			).rejects.toThrow("the notes input is for 0.5.0, not 0.4.0");
			await expect(
				notesFromInput(io, "0.4.0", sha, "not base64; rm -rf /"),
			).rejects.toThrow("the notes input isn't base64");
			await expect(
				notesFromInput(io, "0.4.0", sha, "aGVsbG8="),
			).rejects.toThrow(/the notes input isn't gzip/);
			const html = file({
				notes: [
					{
						id: "CAR-183",
						kind: "new",
						prs: [110],
						text: "<img src=x onerror=alert(1)>",
					},
				],
			});
			await expect(
				notesFromInput(io, "0.4.0", sha, encodeNotesInput(html)),
			).rejects.toThrow(
				/the notes input is malformed: notes\[0\] CAR-183: text .*has HTML/,
			);
		});

		it("refuses an out-of-range entry kept from the file at the commit too, with or without an input", async () => {
			history();
			// A hand-edited file naming a PR the release doesn't have.
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile(
					file({
						none: [
							...file().none,
							{ id: "CAR-999", prs: [999], why: "elsewhere" },
						],
					}),
				),
			});
			const { io } = repoIo(repo);
			const outside =
				/entries outside 0\.4\.0's PRs up to [0-9a-f]{40}: CAR-999 \(release-notes\/0\.4\.0\.json\)/;
			// The input doesn't name CAR-999: the file's entry is kept, and refused.
			await expect(
				notesFromInput(io, "0.4.0", sha, encodeNotesInput(file())),
			).rejects.toThrow(outside);
			await expect(notesFromInput(io, "0.4.0", sha, "")).rejects.toThrow(
				outside,
			);
		});

		it("the input wins over a file at the commit for any id both have, the file's other ids stay, and the summary says so; with no input the file serves", async () => {
			history();
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile(
					file({
						notes: [
							{
								id: "CAR-183",
								kind: "new",
								prs: [110, 127],
								text: "Old wording.",
							},
						],
					}),
				),
			});
			const { io } = repoIo(repo);
			const input = file({
				notes: [
					{
						id: "CAR-183",
						kind: "improved",
						prs: [110, 127],
						text: "New wording.",
					},
				],
				none: file().none.filter((n) => n.id !== "CAR-66"),
			});
			const r = await notesFromInput(io, "0.4.0", sha, encodeNotesInput(input));
			expect(r.file.notes).toEqual(input.notes);
			expect(r.file.none).toEqual(file().none);
			expect(r.summary).toContain(
				"from the promote's input, over release-notes/0.4.0.json at the RC.",
			);
			expect(r.summary).toContain(
				"The input replaced release-notes/0.4.0.json's entries for CAR-183.",
			);
			expect(r.summary).toContain(
				"Kept from release-notes/0.4.0.json (not in the input): CAR-66.",
			);
			expect(r.summary).toContain("- New wording. (CAR-183, #110, #127)");
			expect(r.summary).not.toContain("Old wording.");
			const fromFile = await notesFromInput(io, "0.4.0", sha, "");
			expect(fromFile.file.notes[0]?.text).toBe("Old wording.");
			expect(fromFile.summary).toContain(
				"from release-notes/0.4.0.json at the RC (no input).",
			);
		});

		it("ci:set-version packs the given notes as the release's (crbReleaseNotes and crbReleaseNotesFile), over a different file at the commit; the tree stays clean", () => {
			commit("Build info (no PR)", {
				"scripts/build-info.mjs": readFileSync(
					join(import.meta.dirname, "build-info.mjs"),
					"utf8",
				),
				".gitignore": "dist/\n",
			});
			history();
			commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile(
					file({
						notes: [
							{
								id: "CAR-183",
								kind: "new",
								prs: [110, 127],
								text: "Old wording.",
							},
						],
					}),
				),
			});
			const given = file({
				notes: [
					{
						id: "CAR-183",
						kind: "new",
						prs: [110, 127],
						text: "New wording.",
					},
				],
			});
			const dir = mkdtempSync(join(tmpdir(), "crb-notes-in-"));
			try {
				const path = join(dir, "release-notes.json");
				writeFileSync(path, formatNotesFile(given));
				execFileSync(
					join(import.meta.dirname, "../node_modules/.bin/tsx"),
					[
						join(import.meta.dirname, "release.ts"),
						"ci:set-version",
						"0.4.0",
						repo,
						path,
					],
					{ encoding: "utf8" },
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
			expect(pkg.version).toBe("0.4.0");
			expect(pkg.crbReleaseNotes).toEqual([
				{ version: "0.4.0", date: null, notes: given.notes },
			]);
			expect(pkg.crbReleaseNotesFile).toEqual(given);
			expect(git("status", "--porcelain")).toBe("");
			execFileSync("node", ["scripts/build-info.mjs"], { cwd: repo });
			expect(
				JSON.parse(readFileSync(join(repo, "dist/release-notes.json"), "utf8")),
			).toEqual([{ version: "0.4.0", date: null, notes: given.notes }]);
		});
	});

	describe("what a build ships (ci:set-version)", () => {
		it("an RC: its release's notes so far, undated, with the PRs no note covers yet; earlier releases dated", async () => {
			commit("notes: 0.3.1 (#52)", {
				"release-notes/0.3.0.json": notesFile({
					version: "0.3.0",
					date: "2026-11-01",
					notes: [
						{ id: "CAR-50", kind: "new", prs: [50], text: "Old feature." },
					],
				}),
			});
			history();
			commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({
					version: "0.4.0",
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
					none: [{ id: "#125", prs: [125], why: "test tooling" }],
				}),
				// An unreleased version between: not shipped.
				"release-notes/0.3.5.json": notesFile({ version: "0.3.5" }),
				// A later version: not shipped.
				"release-notes/0.5.0.json": notesFile({ version: "0.5.0" }),
			});
			const { io } = repoIo(repo);
			expect(await shippedNotes(io, "0.4.0-rc.3", repo)).toEqual([
				{
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
					uncovered: [111, 126],
				},
				{
					version: "0.3.0",
					date: "2026-11-01",
					notes: [
						{ id: "CAR-50", kind: "new", prs: [50], text: "Old feature." },
					],
				},
			]);
		});

		it("a release: undated (release-finish dates it when published), no uncovered list; refused without its file; an older release undated in its file takes its tag's date", async () => {
			commit("notes: 0.3.0 (#52)", {
				"release-notes/0.3.0.json": notesFile({ version: "0.3.0" }),
			});
			git("tag", "-f", "v0.3.0");
			const { io } = repoIo(repo);
			await expect(shippedNotes(io, "0.4.0", repo)).rejects.toThrow(
				"no release-notes/0.4.0.json: a release ships its notes",
			);
			commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({ version: "0.4.0" }),
			});
			const shipped = await shippedNotes(io, "0.4.0", repo);
			expect(shipped[0]).toEqual({
				version: "0.4.0",
				date: null,
				notes: [],
			});
			expect(shipped[1]?.version).toBe("0.3.0");
			expect(shipped[1]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("dist/release-notes.json keeps every released version (over 10) while crbReleaseNotes stays capped; a list left for another commit is ignored", () => {
			const tsx = join(import.meta.dirname, "../node_modules/.bin/tsx");
			const setVersion = (v: string) =>
				execFileSync(
					tsx,
					[join(import.meta.dirname, "release.ts"), "ci:set-version", v, repo],
					{ encoding: "utf8" },
				);
			commit("Build info (no PR)", {
				"scripts/build-info.mjs": readFileSync(
					join(import.meta.dirname, "build-info.mjs"),
					"utf8",
				),
				".gitignore": "dist/\n",
			});
			// 0.4.0 to 0.15.0 released, each with its notes: 12 versions, and
			// 0.3.0 before them without a file.
			for (let minor = 4; minor <= 15; minor++) {
				const v = `0.${minor}.0`;
				commit(`Feature ${minor} (CAR-${minor}) (#${minor})`);
				commit(`notes: ${v} (#${100 + minor})`, {
					[`release-notes/${v}.json`]: notesFile({
						version: v,
						date: `2026-01-${String(minor).padStart(2, "0")}`,
						notes: [
							{
								id: `CAR-${minor}`,
								kind: "new",
								prs: [minor],
								text: `Feature ${minor}.`,
							},
						],
					}),
				});
				git("tag", `v${v}`);
			}
			commit("notes: 0.16.0 (#200)", {
				"release-notes/0.16.0.json": notesFile({ version: "0.16.0" }),
			});
			setVersion("0.16.0-rc.1");
			const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
			const field = pkg.crbReleaseNotes as ShippedReleaseNotes[];
			expect(field.map((e) => e.version)).toEqual([
				"0.16.0",
				...Array.from({ length: 9 }, (_, i) => `0.${15 - i}.0`),
			]);
			expect(git("status", "--porcelain")).toBe("");
			execFileSync("node", ["scripts/build-info.mjs"], { cwd: repo });
			const dist = (): ShippedReleaseNotes[] =>
				JSON.parse(readFileSync(join(repo, "dist/release-notes.json"), "utf8"));
			const all = [
				"0.16.0",
				...Array.from({ length: 12 }, (_, i) => `0.${15 - i}.0`),
			];
			expect(dist().map((e) => e.version)).toEqual(all);
			expect(dist()[12]).toEqual({
				version: "0.4.0",
				date: "2026-01-04",
				notes: [{ id: "CAR-4", kind: "new", prs: [4], text: "Feature 4." }],
			});
			expect(dist().slice(0, 10)).toEqual(field);
			// The list is for that version and commit: a build of another
			// commit (the field set by hand here) falls back to the field.
			git("update-index", "--no-skip-worktree", "package.json");
			git("checkout", "--", "package.json");
			commit("Later (CAR-300) (#300)");
			writeFileSync(
				join(repo, "package.json"),
				JSON.stringify({
					name: "carbonless-review",
					version: "0.16.0-rc.1",
					crbReleaseNotes: field,
				}),
			);
			git("update-index", "--skip-worktree", "package.json");
			execFileSync("node", ["scripts/build-info.mjs"], { cwd: repo });
			expect(dist()).toEqual(field);
		});

		it("ci:set-version writes crbReleaseNotes and the build copies it to dist/release-notes.json; the tree stays clean", () => {
			commit("Build info (no PR)", {
				"scripts/build-info.mjs": readFileSync(
					join(import.meta.dirname, "build-info.mjs"),
					"utf8",
				),
				".gitignore": "dist/\n",
			});
			history();
			commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({
					version: "0.4.0",
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
				}),
			});
			execFileSync(
				join(import.meta.dirname, "../node_modules/.bin/tsx"),
				[
					join(import.meta.dirname, "release.ts"),
					"ci:set-version",
					"0.4.0-rc.2",
					repo,
				],
				{ encoding: "utf8" },
			);
			const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
			const expected: ShippedReleaseNotes[] = [
				{
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
					uncovered: [111, 125, 126],
				},
			];
			expect(pkg.crbReleaseNotes).toEqual(expected);
			expect(pkg.version).toBe("0.4.0-rc.2");
			expect(git("status", "--porcelain")).toBe("");
			execFileSync("node", ["scripts/build-info.mjs"], { cwd: repo });
			expect(
				JSON.parse(readFileSync(join(repo, "dist/release-notes.json"), "utf8")),
			).toEqual(expected);
		});
	});

	describe("the changelog and the GitHub release", () => {
		it("renders notes by kind with their ids and PRs, then every PR (escaped); none says so", async () => {
			history();
			const { io } = repoIo(repo);
			const range = await releaseRange(io, "0.4.0", "HEAD");
			range.prs.push({
				number: 130,
				title: "A </details><img src=x onerror=alert(1)> title for @someone",
				tickets: [],
				exempt: false,
			});
			const body = renderNotesBody(
				{
					version: "0.4.0",
					date: null,
					notes: [
						{ id: "#125", kind: "fixed", prs: [125], text: "Stops." },
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
						{
							id: "CAR-66",
							kind: "improved",
							prs: [111],
							text: "Uses `<dialog>`.",
						},
					],
					none: [],
				},
				range,
			);
			expect(body).toBe(
				[
					"### New",
					"",
					"- Threads tab. (CAR-183, #110, #127)",
					"",
					"### Improved",
					"",
					"- Uses `<dialog>`. (CAR-66, #111)",
					"",
					"### Fixed",
					"",
					"- Stops. (#125)",
					"",
					"<details><summary>Every PR (6)</summary>",
					"",
					"- Threads tab (CAR-183) (#110)",
					"- Spans releases, second part (CAR-66) (#111)",
					"- Test processes stop (#125)",
					"- e2e: keepalive (CAR-171, CAR-172) (#126)",
					"- Threads tab, phone (CAR-183) (#127)",
					"- A &lt;/details&gt;&lt;img src=x onerror=alert(1)&gt; title for @\u200bsomeone (#130)",
					"</details>",
				].join("\n"),
			);
			// A file edited by hand past the rules: the prose is escaped,
			// `code` left as markdown shows it.
			expect(
				renderNotesBody(
					{
						version: "0.4.0",
						date: null,
						none: [],
						notes: [
							{
								id: "CAR-1",
								kind: "new",
								prs: [1],
								text: "A <b>bold</b> one for @alice and upstream/lib#3, `<i>` kept.",
							},
						],
					},
					{ from: null, prs: [], other: [] },
				),
			).toBe(
				"### New\n\n- A &lt;b&gt;bold&lt;/b&gt; one for @\u200balice and upstream/lib#3, `<i>` kept. (CAR-1, #1)",
			);
			expect(renderNotesBody(null, { from: null, prs: [], other: [] })).toBe(
				"No user-facing changes.",
			);
			expect(mdText("a & b")).toBe("a &amp; b");
		});

		it("puts the version's section on top and keeps the older ones as they are", () => {
			const old = "# Changelog\n\n## 0.3.0 (2026-11-01)\n\n- Old PR (#50)\n";
			const once = withChangelogSection(
				old,
				"0.4.0",
				"## 0.4.0 (2026-11-20)\n\nNo user-facing changes.",
			);
			expect(once).toBe(
				"# Changelog\n\n## 0.4.0 (2026-11-20)\n\nNo user-facing changes.\n\n## 0.3.0 (2026-11-01)\n\n- Old PR (#50)\n",
			);
			// A rerun replaces its own section.
			expect(
				withChangelogSection(once, "0.4.0", "## 0.4.0 (2026-11-21)\n\nX"),
			).toBe(
				"# Changelog\n\n## 0.4.0 (2026-11-21)\n\nX\n\n## 0.3.0 (2026-11-01)\n\n- Old PR (#50)\n",
			);
		});

		it("ci:changelog and ci:release-body take the published notes, not the file at the RC's commit; the next PR's file is the published one, dated", () => {
			history();
			// A file at the RC's commit (and so in master's checkout) that
			// differs from what was published.
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({
					version: "0.4.0",
					notes: [
						{ id: "CAR-183", kind: "new", prs: [110], text: "Commit wording." },
					],
				}),
				"docs/changelog.md":
					"# Changelog\n\n## 0.3.0 (2026-11-01)\n\n- Old PR (#50)\n",
			});
			const published: ReleaseNotesFile = {
				version: "0.4.0",
				date: null,
				notes: [
					{
						id: "CAR-183",
						kind: "new",
						prs: [110],
						text: "Published wording.",
					},
				],
				none: [{ id: "#125", prs: [125], why: "test tooling" }],
			};
			const dir = mkdtempSync(join(tmpdir(), "crb-published-"));
			const path = join(dir, "release-notes.json");
			writeFileSync(path, formatNotesFile(published));
			const run = (...args: string[]) =>
				execFileSync(
					join(import.meta.dirname, "../node_modules/.bin/tsx"),
					[join(import.meta.dirname, "release.ts"), ...args],
					{ cwd: repo, encoding: "utf8" },
				);
			try {
				expect(run("ci:changelog", "0.4.0", sha, path)).toBe("prs=7\n");
				const body = run("ci:release-body", "0.4.0", sha, path);
				expect(
					body.startsWith("### New\n\n- Published wording. (CAR-183, #110)\n"),
				).toBe(true);
				expect(body).not.toContain("Commit wording.");
				// Notes of another version are refused.
				writeFileSync(
					path,
					formatNotesFile({ ...published, version: "0.5.0" }),
				);
				expect(() =>
					execFileSync(
						join(import.meta.dirname, "../node_modules/.bin/tsx"),
						[
							join(import.meta.dirname, "release.ts"),
							"ci:release-body",
							"0.4.0",
							sha,
							path,
						],
						{ cwd: repo, encoding: "utf8", stdio: "pipe" },
					),
				).toThrow(/is for 0\.5\.0, not 0\.4\.0/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			const today = new Date().toISOString().slice(0, 10);
			const changelog = readFileSync(join(repo, "docs/changelog.md"), "utf8");
			expect(changelog).toContain(
				`## 0.4.0 (${today})\n\n### New\n\n- Published wording. (CAR-183, #110)\n`,
			);
			expect(changelog).not.toContain("Commit wording.");
			expect(changelog).toContain("## 0.3.0 (2026-11-01)");
			expect(
				JSON.parse(
					readFileSync(join(repo, "release-notes/0.4.0.json"), "utf8"),
				),
			).toEqual({ ...published, date: today });
		});

		it("ci:changelog writes the notes file when the checkout has none", () => {
			history();
			const sha = git("rev-parse", "HEAD");
			const dir = mkdtempSync(join(tmpdir(), "crb-published-"));
			const path = join(dir, "release-notes.json");
			const published = notesFile({ version: "0.4.0" });
			writeFileSync(path, published);
			try {
				execFileSync(
					join(import.meta.dirname, "../node_modules/.bin/tsx"),
					[
						join(import.meta.dirname, "release.ts"),
						"ci:changelog",
						"0.4.0",
						sha,
						path,
					],
					{ cwd: repo, encoding: "utf8" },
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			expect(
				JSON.parse(readFileSync(join(repo, "release-notes/0.4.0.json"), "utf8"))
					.version,
			).toBe("0.4.0");
		});
	});

	describe("release-finish's notes: what was published (CAR-242)", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "crb-finish-notes-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		const published: ReleaseNotesFile = {
			version: "0.4.0",
			date: null,
			notes: [
				{
					id: "CAR-183",
					kind: "new",
					prs: [110],
					text: "Published wording.",
				},
			],
			none: [{ id: "#125", prs: [125], why: "test tooling" }],
		};

		/** The promote run's artifact: a tarball whose package.json has `field`, and its manifest. */
		const artifact = (sha: string, field?: unknown) => {
			mkdirSync(join(dir, "package"), { recursive: true });
			writeFileSync(
				join(dir, "package/package.json"),
				JSON.stringify({
					name: "carbonless-review",
					version: "0.4.0",
					...(field === undefined ? {} : { crbReleaseNotesFile: field }),
				}),
			);
			const tarball = "carbonless-review-0.4.0.tgz";
			execFileSync("tar", ["-czf", tarball, "package"], { cwd: dir });
			const digests = tarballDigests(readFileSync(join(dir, tarball)));
			writeFileSync(
				join(dir, "manifest.json"),
				JSON.stringify({
					version: "0.4.0",
					tag: "v0.4.0-rc.1",
					sha,
					...digests,
					next: "minor",
					tarball,
				}),
			);
			return digests.integrity;
		};
		const npmHas = (integrity: string) => ({
			"view carbonless-review@0.4.0 dist.integrity": `${integrity}\n`,
		});

		it("takes the package's crbReleaseNotesFile once npm has that very tarball, over a different file at the RC's commit", async () => {
			history();
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile({
					version: "0.4.0",
					notes: [
						{ id: "CAR-183", kind: "new", prs: [110], text: "Commit wording." },
					],
				}),
			});
			const integrity = artifact(sha, published);
			const ok = repoIo(repo, {}, "local", npmHas(integrity));
			expect(await finishNotes(ok.io, "0.4.0", dir)).toEqual({
				file: published,
				warning: null,
			});
			const other = repoIo(repo, {}, "local", npmHas("sha512-b3RoZXI="));
			await expect(finishNotes(other.io, "0.4.0", dir)).rejects.toThrow(
				/npm has carbonless-review@0\.4\.0 as sha512-b3RoZXI=, not the promote run's tarball/,
			);
			await expect(finishNotes(ok.io, "0.5.0", dir)).rejects.toThrow(
				"the promote run released 0.4.0, not 0.5.0",
			);
		});

		it("refuses malformed published notes; a package without them falls back to the file at the RC's commit, warning; neither fails", async () => {
			history();
			const bare = git("rev-parse", "HEAD");
			const bad = artifact(bare, { ...published, notes: [{ id: "x" }] });
			await expect(
				finishNotes(repoIo(repo, {}, "local", npmHas(bad)).io, "0.4.0", dir),
			).rejects.toThrow(/the published crbReleaseNotesFile is malformed/);
			const none = artifact(bare);
			await expect(
				finishNotes(repoIo(repo, {}, "local", npmHas(none)).io, "0.4.0", dir),
			).rejects.toThrow(
				`0.4.0's package has no crbReleaseNotesFile, and release-notes/0.4.0.json isn't at ${bare} either`,
			);
			const sha = commit("notes: 0.4.0 (#140)", {
				"release-notes/0.4.0.json": notesFile(published),
			});
			const old = artifact(sha);
			const r = await finishNotes(
				repoIo(repo, {}, "local", npmHas(old)).io,
				"0.4.0",
				dir,
			);
			expect(r.file).toEqual(published);
			expect(r.warning).toMatch(/promoted before CAR-242/);
		});
	});

	describe("pnpm release notes (Linear and gh faked; never a Linear write)", () => {
		beforeEach(() => {
			// origin is the repository itself: fetch and push work offline.
			git("remote", "add", "origin", repo);
		});

		const linearFor0_4 = () =>
			fakeLinear({
				"CAR-183": {
					labels: ["Feature"],
					comments: [note("Files changed has a Threads tab.")],
					attachments: [
						"https://github.com/owner/repo/pull/110",
						"https://github.com/owner/repo/pull/126",
					],
				},
				"CAR-66": { labels: ["Bug"], comments: [note("none (refactor)")] },
				"CAR-171": { comments: [note("none (flaky test fix)")] },
				"CAR-172": {
					comments: [{ body: "Done.", updatedAt: "2026-11-15T00:00:00Z" }],
				},
			});

		it("writes the file from Linear and the PR descriptions, listing what's missing", async () => {
			history();
			const { io, lines, calls } = repoIo(
				repo,
				{
					"api repos/owner/repo/pulls/125":
						"Release note: none (test tooling)\n",
					// CAR-172 has no note in Linear: its PR's description is asked.
					"api repos/owner/repo/pulls/126": "Fixes CAR-172\n",
				},
				"origin",
			);
			const { linear, queries } = linearFor0_4();
			const written: Record<string, string> = {};
			const r = await writeNotes(io, linear, {
				pr: false,
				root: "/root",
				worktree: join(repo, "../never"),
				write: (path, text) => {
					written[path] = text;
				},
			});
			expect(Object.keys(written)).toEqual(["/root/release-notes/0.4.0.json"]);
			expect(
				JSON.parse(written["/root/release-notes/0.4.0.json"] ?? ""),
			).toEqual({
				version: "0.4.0",
				date: null,
				notes: [
					{
						id: "CAR-183",
						kind: "new",
						prs: [110, 127],
						text: "Files changed has a Threads tab.",
					},
				],
				none: [
					{ id: "CAR-66", prs: [111], why: "refactor" },
					{ id: "#125", prs: [125], why: "test tooling" },
					{ id: "CAR-171", prs: [126], why: "flaky test fix" },
				],
			});
			expect(r.missing).toEqual([
				expect.stringMatching(
					/^CAR-172 \(#126\): no Release note: pnpm release note CAR-172 "<text>"/,
				),
			]);
			expect(lines).toContain(
				"warning: CAR-183 has #126 attached in Linear, but its title doesn't name CAR-183",
			);
			expect(lines).toContain(
				"warning: not a PR (no \"(#N)\"): Merge branch 'x' (a direct push)",
			);
			expect(lines.at(-1)).toBe(
				"incomplete: 1 without a note; promote refuses 0.4.0 until each has one",
			);
			expect(queries.some((q) => /mutation/.test(q))).toBe(false);
			expect(calls.filter((c) => c.startsWith("gh"))).toEqual([
				'gh api repos/owner/repo/pulls/125 --jq .body // ""',
				'gh api repos/owner/repo/pulls/126 --jq .body // ""',
			]);
		});

		it("a ticket an older release shipped comes back only with a newer note", async () => {
			commit("notes: 0.3.0 (#52)", {
				"release-notes/0.3.0.json": notesFile({
					version: "0.3.0",
					notes: [{ id: "CAR-66", kind: "new", prs: [51], text: "Keepalive." }],
				}),
			});
			git("tag", "-f", "v0.3.0");
			commit("Keepalive two (CAR-66) (#70)");
			commit("Other (CAR-67) (#71)");
			const { io } = repoIo(repo, {}, "origin");
			const same = fakeLinear({
				"CAR-66": { labels: ["Feature"], comments: [note("Keepalive.")] },
				"CAR-67": { labels: ["Feature"], comments: [note("Other.")] },
			});
			const write = () => {};
			const opts = {
				version: "0.4.0",
				pr: false,
				root: repo,
				worktree: "",
				write,
			};
			const r1 = await writeNotes(io, same.linear, opts);
			expect(r1.file.notes.map((n) => n.id)).toEqual(["CAR-67"]);
			expect(r1.shippedBefore).toEqual(["CAR-66: in 0.3.0"]);
			const newer = fakeLinear({
				"CAR-66": {
					labels: ["Feature"],
					comments: [
						note("Keepalive."),
						{
							body: "Release note (improved): Keepalive also on phones.",
							updatedAt: "2026-11-16T00:00:00Z",
						},
					],
				},
				"CAR-67": { labels: ["Feature"], comments: [note("Other.")] },
			});
			const r2 = await writeNotes(io, newer.linear, opts);
			expect(r2.file.notes.map((n) => [n.id, n.kind, n.text])).toEqual([
				["CAR-67", "new", "Other."],
				["CAR-66", "improved", "Keepalive also on phones."],
			]);
		});

		describe("an RC's notes so far (CAR-321: best effort)", () => {
			/** PR descriptions as the RC workflow fetches them (gh pr list --json number,body). */
			const BODIES = [
				{ number: 125, body: "Release note: none (test tooling)\n" },
				{ number: 126, body: "Fixes CAR-172\n" },
			];

			it("returns the notes it finds and skips the ones missing, never asking gh itself (descriptions from the fetched list)", async () => {
				history();
				const { io, calls } = repoIo(repo);
				const { linear, queries } = linearFor0_4();
				const r = await rcNotes(
					prBodiesIo(io, BODIES),
					{ linear, tried: [] },
					"0.4.0",
					"HEAD",
					{ cwd: repo },
				);
				expect(r.file).toEqual({
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Files changed has a Threads tab.",
						},
					],
					none: [
						{ id: "CAR-66", prs: [111], why: "refactor" },
						{ id: "#125", prs: [125], why: "test tooling" },
						{ id: "CAR-171", prs: [126], why: "flaky test fix" },
					],
				});
				// CAR-172 has no note anywhere: skipped, counted, not an error.
				expect(r.missing).toBe(1);
				expect(calls.filter((c) => c.startsWith("gh"))).toEqual([]);
				expect(queries.some((q) => /mutation/.test(q))).toBe(false);
			});

			it("a PR the fetched list lacks reads as no description: its ticket is skipped, nothing fails", async () => {
				history();
				const { io } = repoIo(repo);
				const r = await rcNotes(
					prBodiesIo(io, []),
					{ linear: linearFor0_4().linear, tried: [] },
					"0.4.0",
					"HEAD",
					{ cwd: repo },
				);
				expect(r.file?.none.map((n) => n.id)).toEqual(["CAR-66", "CAR-171"]);
				expect(r.missing).toBe(2);
			});

			it("no key, Linear failing or too slow: no notes and a warning, never a throw", async () => {
				history();
				const { io } = repoIo(repo);
				const bodies = prBodiesIo(io, BODIES);
				const noKey = await rcNotes(
					bodies,
					{ linear: null, tried: ["$LINEAR_API_KEY"] },
					"0.4.0",
					"HEAD",
					{ cwd: repo },
				);
				expect(noKey.file).toBeNull();
				expect(noKey.warnings).toEqual([
					expect.stringMatching(/^no Linear key \(tried \$LINEAR_API_KEY\)/),
				]);
				// The range is read before the key is needed: the caller can
				// still tell which PRs' descriptions it lacked (not #60, exempt).
				expect(noKey.prs).toEqual([110, 111, 125, 126, 127]);
				expect(undescribedPrs(noKey.prs, BODIES)).toEqual([110, 111, 127]);
				expect(undescribedPrs(noKey.prs, [])).toEqual(noKey.prs);
				const down: Linear = {
					query: async () => {
						throw new Error("Linear answered 503: no data");
					},
				};
				const failed = await rcNotes(
					bodies,
					{ linear: down, tried: [] },
					"0.4.0",
					"HEAD",
					{ cwd: repo },
				);
				expect(failed.file).toBeNull();
				expect(failed.warnings).toEqual([
					expect.stringMatching(/Linear answered 503/),
				]);
				const hang: Linear = { query: () => new Promise(() => {}) };
				const slow = await rcNotes(
					bodies,
					{ linear: hang, tried: [] },
					"0.4.0",
					"HEAD",
					{ cwd: repo, timeoutMs: 20 },
				);
				expect(slow.file).toBeNull();
				expect(slow.warnings).toEqual([expect.stringMatching(/timed out/)]);
				// Not a release: a warning too.
				const bad = await rcNotes(
					bodies,
					{ linear: linearFor0_4().linear, tried: [] },
					"0.4.0-rc.1",
					"HEAD",
					{ cwd: repo },
				);
				expect(bad.file).toBeNull();
				expect(bad.warnings).toEqual([expect.stringMatching(/not a release/)]);
			});

			it("an RC build ships them over the committed file (theirs win per id, the file's others stay), and only PRs still without a note are listed", async () => {
				history();
				commit("notes: 0.4.0 (#140)", {
					"release-notes/0.4.0.json": notesFile({
						version: "0.4.0",
						notes: [
							{ id: "CAR-183", kind: "new", prs: [110], text: "Old text." },
						],
						none: [{ id: "CAR-172", prs: [126], why: "flaky test fix" }],
					}),
				});
				const { io } = repoIo(repo);
				const { file } = await rcNotes(
					prBodiesIo(io, BODIES),
					{ linear: linearFor0_4().linear, tried: [] },
					"0.4.0",
					"HEAD",
					{ cwd: repo },
				);
				expect(file).not.toBeNull();
				const shipped = await shippedNotes(
					io,
					"0.4.0-rc.2",
					repo,
					file ?? undefined,
				);
				expect(shipped[0]).toEqual({
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Files changed has a Threads tab.",
						},
					],
					uncovered: [],
				});
				// Without them: today's behaviour, the file and the uncovered PRs.
				expect((await shippedNotes(io, "0.4.0-rc.2", repo))[0]).toEqual({
					version: "0.4.0",
					date: null,
					notes: [
						{ id: "CAR-183", kind: "new", prs: [110], text: "Old text." },
					],
					// #126 also carries CAR-171.
					uncovered: [111, 125, 126],
				});
				// Another release's notes are refused.
				await expect(
					shippedNotes(io, "0.4.0-rc.2", repo, {
						version: "0.5.0",
						date: null,
						notes: [],
						none: [],
					}),
				).rejects.toThrow(
					/notes for 0\.5\.0 given to a build of 0\.4\.0-rc\.2/,
				);
			});

			it("ci:set-version takes an RC's notes from $RC_NOTES (the collecting job's output) into crbReleaseNotes; unreadable ones only warn", () => {
				history();
				const tsx = join(import.meta.dirname, "../node_modules/.bin/tsx");
				const encoded = encodeNotesInput({
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
					none: [{ id: "#125", prs: [125], why: "test tooling" }],
				});
				const set = (rcNotesEnv: string) => {
					const out = execFileSync(
						tsx,
						[
							join(import.meta.dirname, "release.ts"),
							"ci:set-version",
							"0.4.0-rc.2",
							repo,
						],
						{
							encoding: "utf8",
							env: { ...process.env, RC_NOTES: rcNotesEnv },
						},
					);
					const pkg = JSON.parse(
						readFileSync(join(repo, "package.json"), "utf8"),
					);
					git("update-index", "--no-skip-worktree", "package.json");
					git("checkout", "--", "package.json");
					return {
						out,
						top: (pkg.crbReleaseNotes as ShippedReleaseNotes[])[0],
					};
				};
				const withNotes = set(encoded);
				expect(withNotes.top).toEqual({
					version: "0.4.0",
					date: null,
					notes: [
						{
							id: "CAR-183",
							kind: "new",
							prs: [110, 127],
							text: "Threads tab.",
						},
					],
					uncovered: [111, 126],
				});
				const broken = set("not base64 gzip");
				expect(broken.out).toMatch(/^::warning::.*RC_NOTES/m);
				expect(broken.top).toEqual({
					version: "0.4.0",
					date: null,
					notes: [],
					uncovered: [110, 111, 125, 126, 127],
				});
				// Another version's: ignored with a warning, too.
				const other = set(
					encodeNotesInput({
						version: "0.5.0",
						date: null,
						notes: [],
						none: [],
					}),
				);
				expect(other.out).toMatch(/^::warning::/m);
				expect(other.top?.notes).toEqual([]);
			});
		});

		it('--pr: a notes/X.Y.Z branch from origin/master with the file, pushed, and a "notes: X.Y.Z" PR', async () => {
			history();
			const { io, calls, lines } = repoIo(
				repo,
				{
					"api repos/owner/repo/pulls/125": "Release note: none (test tooling)",
					"api repos/owner/repo/pulls/126": "",
					"pr list": "",
					"pr create": "https://github.com/owner/repo/pull/140\n",
				},
				"origin",
			);
			const work = mkdtempSync(join(tmpdir(), "crb-notes-wt-"));
			try {
				await writeNotes(io, linearFor0_4().linear, {
					pr: true,
					root: "/never",
					worktree: join(work, "wt"),
					write: (path, text) => {
						mkdirSync(dirname(path), { recursive: true });
						writeFileSync(path, text);
					},
				});
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
			expect(git("log", "-1", "--format=%s", "notes/0.4.0")).toBe(
				"notes: 0.4.0",
			);
			expect(git("show", "notes/0.4.0:release-notes/0.4.0.json")).toContain(
				'"id": "CAR-183"',
			);
			expect(git("rev-parse", "notes/0.4.0^")).toBe(git("rev-parse", "master"));
			expect(calls).toContain(
				'gh pr list --repo owner/repo --head notes/0.4.0 --state open --json url --jq .[0].url // ""',
			);
			expect(calls.find((c) => c.startsWith("gh pr create"))).toMatch(
				/^gh pr create --repo owner\/repo --base master --head notes\/0\.4\.0 --title notes: 0\.4\.0 --body /,
			);
			expect(lines).toContain("https://github.com/owner/repo/pull/140");
			// The working tree is untouched; the temporary worktree is gone.
			expect(existsSync(join(repo, "release-notes"))).toBe(false);
			expect(git("worktree", "list").split("\n")).toHaveLength(1);
		});

		it("notes check fails listing the release's gaps and done tickets without a note", async () => {
			history();
			const { io, lines } = repoIo(
				repo,
				{
					"api repos/owner/repo/pulls/125": "",
				},
				"origin",
			);
			const { linear } = fakeLinear({
				"CAR-183": { labels: ["Feature"], comments: [note("Threads.")] },
				"CAR-66": { comments: [note("none (x)")] },
				"CAR-171": { comments: [note("none (x)")] },
				"CAR-172": { comments: [note("none (x)")] },
				"CAR-190": { title: "Release tooling" },
			});
			// Only the release's gap fails; a done ticket outside it (most
			// predate the rule) warns.
			await expect(auditNotes(io, linear)).rejects.toThrow(
				"1 without a release note",
			);
			expect(lines).toEqual([
				expect.stringMatching(
					/^warning: done: CAR-190 Release tooling: no Release note: pnpm release note CAR-190/,
				),
				expect.stringMatching(
					/^0\.4\.0: #125 \(#125\): no Release note: add a "Release note \(kind\)/,
				),
			]);
			// With the release covered, the warning alone passes.
			const covered = repoIo(
				repo,
				{ "api repos/owner/repo/pulls/125": "Release note: none (tests)" },
				"origin",
			);
			await auditNotes(covered.io, linear);
			expect(covered.lines.at(-1)).toBe(
				"ok: every ticket and PR of 0.4.0 so far has a release note",
			);
		});

		it("notes check takes a done ticket's note from its attached PR's description (CAR-211)", async () => {
			history();
			const { io, lines, calls } = repoIo(
				repo,
				{
					"api repos/owner/repo/pulls/125": "Release note: none (tests)",
					"api repos/owner/repo/pulls/150":
						"Fixes CAR-190\n\nRelease note: none (release tooling)",
					"api repos/owner/repo/pulls/151": "Fixes CAR-191",
				},
				"origin",
			);
			const { linear } = fakeLinear({
				"CAR-183": { labels: ["Feature"], comments: [note("Threads.")] },
				"CAR-66": { comments: [note("none (x)")] },
				"CAR-171": { comments: [note("none (x)")] },
				"CAR-172": { comments: [note("none (x)")] },
				"CAR-190": {
					title: "Release tooling",
					attachments: [
						"https://github.com/owner/repo/pull/150",
						"https://github.com/other/repo/pull/7",
					],
				},
				"CAR-191": {
					title: "Gate",
					attachments: ["https://github.com/owner/repo/pull/151"],
				},
			});
			await auditNotes(io, linear);
			expect(lines.filter((l) => l.startsWith("warning:"))).toEqual([
				expect.stringMatching(/^warning: done: CAR-191 Gate: no Release note/),
			]);
			expect(calls.some((c) => c.includes("other/repo"))).toBe(false);
		});

		it("promote (CAR-242) collects the notes for exactly the RC's range with no notes file: refuses one missing, sends them otherwise; a PR merged after the RC is neither needed nor sent", async () => {
			history();
			git("tag", "v0.4.0-rc.1");
			// After the RC: no note anywhere, and not this release's.
			commit("Late one (CAR-200) (#141)");
			const gh = {
				"api repos/owner/repo/pulls/125": "Release note: none (test tooling)",
				"api repos/owner/repo/pulls/126": "Fixes CAR-172\n",
			};
			const { io, calls } = repoIo(repo, gh, "origin");
			// CAR-172 has no note in Linear nor in #126's description.
			await expect(
				promoteNotes(io, "0.4.0", "v0.4.0-rc.1", {
					linear: linearFor0_4().linear,
					tried: [],
				}),
			).rejects.toThrow(
				/^v0\.4\.0-rc\.1 can't be promoted: 1 without a release note:\n {2}CAR-172 \(#126\): no Release note: pnpm release note CAR-172 "<text>"/,
			);
			const { linear, queries } = fakeLinear({
				"CAR-183": {
					labels: ["Feature"],
					comments: [note("Files changed has a Threads tab.")],
				},
				"CAR-66": { comments: [note("none (refactor)")] },
				"CAR-171": { comments: [note("none (flaky test fix)")] },
				"CAR-172": { comments: [note("none (flaky test fix)")] },
			});
			const ok = repoIo(repo, gh, "origin");
			const encoded = await promoteNotes(ok.io, "0.4.0", "v0.4.0-rc.1", {
				linear,
				tried: [],
			});
			expect(decodeNotesInput(encoded, "0.4.0")).toEqual({
				version: "0.4.0",
				date: null,
				notes: [
					{
						id: "CAR-183",
						kind: "new",
						prs: [110, 127],
						text: "Files changed has a Threads tab.",
					},
				],
				none: [
					{ id: "CAR-66", prs: [111], why: "refactor" },
					{ id: "#125", prs: [125], why: "test tooling" },
					{ id: "CAR-171", prs: [126], why: "flaky test fix" },
					{ id: "CAR-172", prs: [126], why: "flaky test fix" },
				],
			});
			// Read only: never a Linear write.
			expect(queries.some((q) => /mutation/.test(q))).toBe(false);
			expect(ok.lines.at(-1)).toBe(
				"0.4.0's notes up to v0.4.0-rc.1: 1 notes, 4 none (sent to the run)",
			);
			// What it sends is what promote-check passes for that RC.
			const rc = git("rev-parse", "v0.4.0-rc.1");
			expect(
				(await notesFromInput(ok.io, "0.4.0", rc, encoded)).file.none,
			).toHaveLength(4);
			expect(calls.some((c) => c.startsWith("gh workflow"))).toBe(false);
		});

		it("promote without a Linear key falls back to the file at the RC, saying where it looked", async () => {
			history();
			git("tag", "v0.4.0-rc.1");
			const { io, lines } = repoIo(repo, {}, "origin");
			await expect(
				promoteNotes(io, "0.4.0", "v0.4.0-rc.1", {
					linear: null,
					tried: ["$LINEAR_API_KEY", "/home/x/.config/linear/api-key"],
				}),
			).rejects.toThrow(
				/^no release-notes\/0\.4\.0\.json at [0-9a-f]{40}: set up the Linear key \(\$LINEAR_API_KEY or ~\/\.config\/linear\/api-key\)/,
			);
			expect(lines[0]).toMatch(
				/^warning: no Linear key \(tried \$LINEAR_API_KEY, \/home\/x\/\.config\/linear\/api-key\).*so the run takes release-notes\/0\.4\.0\.json at v0\.4\.0-rc\.1$/,
			);
		});
	});
});

describe("the promote's notes input (CAR-242)", () => {
	const file = (notes: ReleaseNotesFile["notes"]): ReleaseNotesFile => ({
		version: "0.4.0",
		date: null,
		notes,
		none: [{ id: "#125", prs: [125], why: "test tooling" }],
	});

	it("round-trips through gzip+base64, compactly", () => {
		const f = file([
			{ id: "CAR-183", kind: "new", prs: [110, 127], text: "Threads tab." },
			{ id: "CAR-66", kind: "fixed", prs: [111], text: "Uses `<dialog>`." },
		]);
		const encoded = encodeNotesInput(f);
		expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		expect(decodeNotesInput(encoded, "0.4.0")).toEqual(f);
		expect(decodeNotesInput(`  ${encoded}\n`, "0.4.0")).toEqual(f);
	});

	it("refuses notes too large for a workflow input, saying so, before dispatching; and an oversized input", () => {
		// Text that doesn't compress: 200 notes of 580 random hex characters.
		const big = file(
			Array.from({ length: 200 }, (_, i) => ({
				id: `CAR-${i + 1}`,
				kind: "new" as const,
				prs: [i + 1],
				text: `X${randomBytes(290).toString("hex")}`,
			})),
		);
		expect(() => encodeNotesInput(big)).toThrow(
			new RegExp(
				`^0\\.4\\.0's notes are \\d+ characters encoded, over the ${MAX_NOTES_INPUT_CHARS} a workflow input can carry \\(GitHub caps a dispatch's inputs at 65,535\\)`,
			),
		);
		expect(() =>
			decodeNotesInput("A".repeat(MAX_NOTES_INPUT_CHARS + 1), "0.4.0"),
		).toThrow(
			`the notes input is ${MAX_NOTES_INPUT_CHARS + 1} characters, over ${MAX_NOTES_INPUT_CHARS}`,
		);
		// Just under the limit still goes.
		const fits = file(big.notes.slice(0, 100));
		expect(encodeNotesInput(fits).length).toBeLessThanOrEqual(
			MAX_NOTES_INPUT_CHARS,
		);
	});

	it("refuses an input that unpacks to over 1 MB (a gzip bomb)", () => {
		const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 32)).toString("base64");
		expect(bomb.length).toBeLessThan(MAX_NOTES_INPUT_CHARS);
		expect(() => decodeNotesInput(bomb, "0.4.0")).toThrow(
			/the notes input isn't gzip \(or unpacks to over 1048576 bytes\)/,
		);
	});

	it("merges over a file: the input's entries win per id, the file's other ids stay", () => {
		const input = file([{ id: "CAR-1", kind: "new", prs: [1], text: "New." }]);
		const atCommit: ReleaseNotesFile = {
			version: "0.4.0",
			date: null,
			notes: [
				{ id: "CAR-1", kind: "new", prs: [1], text: "Old." },
				{ id: "CAR-2", kind: "fixed", prs: [2], text: "Two." },
			],
			none: [{ id: "#125", prs: [125], why: "test tooling" }],
		};
		const m = mergeNotes(input, atCommit);
		expect(m.file.notes.map((n) => n.text)).toEqual(["New.", "Two."]);
		expect(m.file.none).toEqual(input.none);
		// #125 is the same in both: not "replaced".
		expect(m.replaced).toEqual(["CAR-1"]);
		expect(m.kept).toEqual(["CAR-2"]);
		expect(mergeNotes(input, null)).toEqual({
			file: input,
			replaced: [],
			kept: [],
		});
		expect(mergeNotes(null, atCommit).file).toEqual(atCommit);
	});
});

describe("capShipped", () => {
	const entry = (version: string, chars: number): ShippedReleaseNotes => ({
		version,
		date: null,
		notes: [
			{ id: "CAR-1", kind: "new", prs: [1], text: `A${"a".repeat(chars)}` },
		],
	});

	it("keeps the newest 10 versions, then drops the oldest until it fits", () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			entry(`0.${12 - i}.0`, 10),
		);
		expect(capShipped(many).map((e) => e.version)).toEqual(
			many.slice(0, 10).map((e) => e.version),
		);
		const big = Array.from({ length: 5 }, (_, i) =>
			entry(`0.${5 - i}.0`, 20_000),
		);
		const kept = capShipped(big);
		expect(kept.map((e) => e.version)).toEqual(["0.5.0", "0.4.0", "0.3.0"]);
		expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
			MAX_SHIPPED_BYTES,
		);
	});

	it("refuses when this version alone is over the cap", () => {
		const huge: ShippedReleaseNotes = {
			version: "1.0.0",
			date: null,
			notes: Array.from({ length: 120 }, (_, i) => ({
				id: `CAR-${i + 1}`,
				kind: "new" as const,
				prs: [i + 1],
				text: `A${"a".repeat(590)}`,
			})),
		};
		expect(() => capShipped([huge])).toThrow(
			/1\.0\.0's notes alone are \d+ bytes, over 65536/,
		);
	});
});

describe("merge-ok's note check", () => {
	const pull = (title: string, body = "", ref = "some-branch") => ({
		number: 9,
		title,
		body,
		head: { ref },
		author_association: "OWNER",
	});
	const TRIED = ["$LINEAR_API_KEY", "/x/.config/linear/api-key"];
	const linearWith = (issues: Record<string, RawIssue>) => () => ({
		linear: fakeLinear(issues).linear,
		tried: TRIED,
	});
	const noKey = () => ({ linear: null, tried: TRIED });
	const never = () => {
		throw new Error("no Linear here");
	};
	const files =
		(...names: string[]) =>
		async () =>
			names;
	const noFiles = async (): Promise<string[]> => {
		throw new Error("no files asked here");
	};

	it("passes a ticket with a note or an explicit none", async () => {
		expect(
			await prNotesOk(
				pull(
					"Threads tab (CAR-183, CAR-184)",
					"Fixes CAR-183\nPart of CAR-184",
				),
				linearWith({
					"CAR-183": { labels: ["Feature"], comments: [note("Threads.")] },
					"CAR-184": { comments: [note("none (refactor)")] },
				}),
				noFiles,
			),
		).toBe("CAR-183: 1 note(s), CAR-184: no note (refactor)");
	});

	it("refuses a ticket without a note, naming the command", async () => {
		await expect(
			prNotesOk(
				pull("Threads tab (CAR-183)"),
				linearWith({
					"CAR-183": {
						comments: [{ body: "LGTM", updatedAt: "2026-11-15T00:00:00Z" }],
					},
				}),
				noFiles,
			),
		).rejects.toThrow(
			/^#9 can't merge without its release notes: CAR-183 has no Release note: pnpm release note CAR-183 "<text>"/,
		);
		await expect(
			prNotesOk(
				pull("Threads tab (CAR-183)"),
				linearWith({ "CAR-183": { comments: [note("Threads.")] } }),
				noFiles,
			),
		).rejects.toThrow(/CAR-183's Release note: .*no kind/);
		await expect(
			prNotesOk(pull("x (CAR-1)"), linearWith({}), noFiles),
		).rejects.toThrow(/CAR-1: Linear has no such ticket/);
	});

	it("refuses without a Linear key, naming every place it looked", async () => {
		await expect(
			prNotesOk(pull("Threads tab (CAR-183)"), noKey, noFiles),
		).rejects.toThrow(
			"no Linear key (tried $LINEAR_API_KEY, /x/.config/linear/api-key): set $LINEAR_API_KEY or put it in ~/.config/linear/api-key (release notes live in Linear); so CAR-183's Release note can't be read here: add a",
		);
	});

	it("a ticket-less PR needs a Release note line in its description", async () => {
		expect(
			await prNotesOk(
				pull("Test processes stop", "Release note: none (test tooling)"),
				never,
				noFiles,
			),
		).toBe("#9: no note (test tooling) in its description");
		await expect(
			prNotesOk(pull("Test processes stop", "Just a fix."), never, noFiles),
		).rejects.toThrow(/^#9 has no ticket and no "Release note/);
		await expect(
			prNotesOk(
				pull("Test processes stop", "Release note (new): see #12."),
				never,
				noFiles,
			),
		).rejects.toThrow(/#9's Release note: .*names a PR/);
	});

	it("refuses a car-NNN branch whose title names no ticket, and a description linking other tickets", async () => {
		await expect(
			prNotesOk(pull("Threads tab", "", "car-183-threads"), noKey, noFiles),
		).rejects.toThrow(
			"#9's branch car-183-threads is a ticket's, but its title names none: add (CAR-NNN) to the title",
		);
		await expect(
			prNotesOk(pull("Threads (CAR-183)", "Fixes CAR-184"), noKey, noFiles),
		).rejects.toThrow(
			"#9's title names CAR-183 but its description links CAR-184: make them agree",
		);
		await expect(
			prNotesOk(pull("Threads", "Fixes CAR-184"), noKey, noFiles),
		).rejects.toThrow(
			/title names no ticket but its description links CAR-184/,
		);
	});

	it("prints no control characters from a PR's text", async () => {
		const err = await prNotesOk(
			pull("Threads", "Release note: \u001b]8;;x\u0007Hi.", "car-1-\u001b[2Jx"),
			noKey,
			noFiles,
		).catch((e: Error) => e.message);
		expect(err).toMatch(/branch car-1-\?\[2Jx/);
		expect(err).not.toContain("\u001b");
		const line = await prNotesOk(
			pull("Threads", "Release note: \u001b]8;;x\u0007Hi."),
			never,
			noFiles,
		).catch((e: Error) => e.message);
		expect(line).toMatch(/"Release note: \?\]8;;x\?Hi\."/);
	});

	it("next and notes PRs need none: their title, their own branch, only release files", async () => {
		expect(
			await prNotesOk(
				pull("next: 0.5.0", "", "next/0.5.0"),
				never,
				files("package.json", "docs/changelog.md", "release-notes/0.4.0.json"),
			),
		).toMatch(/no note needed/);
		expect(
			await prNotesOk(
				pull("notes: 0.4.0", "", "notes/0.4.0"),
				never,
				files("release-notes/0.4.0.json"),
			),
		).toMatch(/no note needed/);
		// The title alone exempts nothing: another branch, or code changed.
		for (const [ref, changed] of [
			["car-9-sneaky", ["release-notes/0.4.0.json"]],
			["next/0.4.0", ["release-notes/0.4.0.json"]],
			["notes/0.4.0", ["release-notes/0.4.0.json", "src/server/app.ts"]],
		] as const) {
			await expect(
				prNotesOk(pull("notes: 0.4.0", "", ref), noKey, files(...changed)),
				`${ref} ${changed.join(" ")}`,
			).rejects.toThrow(/^#9( has no ticket|'s branch)/);
		}
	});
});

describe("pnpm release note (posts one comment)", () => {
	const io = () => {
		const lines: string[] = [];
		const io: Io = {
			repo: "owner/repo",
			log: (l) => lines.push(l),
			now: () => new Date(),
			sleep: async () => {},
			run: async () => ({ code: 127, stdout: "", stderr: "no commands here" }),
		};
		return { io, lines };
	};

	it("posts the note with its kind (given, or from the labels), or none with its reason", async () => {
		const writes: Record<string, unknown>[] = [];
		const { linear } = fakeLinear(
			{ "CAR-183": { labels: ["Feature"] } },
			writes,
		);
		const { io: a, lines } = io();
		await postNote(a, linear, "car-183", {
			text: "Threads tab. Newest first.",
		});
		await postNote(a, linear, "CAR-183", { text: "Faster.", kind: "improved" });
		await postNote(a, linear, "CAR-183", { none: "refactor" });
		expect(writes).toEqual([
			{
				issueId: "uuid-CAR-183",
				body: "Release note (new): Threads tab. Newest first.",
			},
			{ issueId: "uuid-CAR-183", body: "Release note (improved): Faster." },
			{ issueId: "uuid-CAR-183", body: "Release note: none (refactor)" },
		]);
		expect(lines[0]).toBe(
			"CAR-183: Release note (new): Threads tab. Newest first.",
		);
		// What it posts reads back as what was meant.
		expect(
			ticketNote(
				writes
					.map((w) => ({
						body: String(w.body),
						updatedAt: "2026-11-15T00:00:00Z",
					}))
					.slice(0, 1),
				[],
			),
		).toEqual({
			status: "notes",
			notes: [{ kind: "new", text: "Threads tab. Newest first." }],
		});
	});

	it("refuses a bad note, a bad reason, or a missing kind, before writing anything", async () => {
		const writes: Record<string, unknown>[] = [];
		const { linear, queries } = fakeLinear(
			{ "CAR-1": { labels: ["perf"] } },
			writes,
		);
		const { io: a } = io();
		await expect(
			postNote(a, linear, "CAR-1", { text: "Two\nlines." }),
		).rejects.toThrow(/line break/);
		await expect(postNote(a, linear, "CAR-1", { none: "" })).rejects.toThrow(
			/reason is empty/,
		);
		expect(queries).toEqual([]);
		await expect(
			postNote(a, linear, "CAR-1", { text: "Fine." }),
		).rejects.toThrow(
			"CAR-1's labels (perf) don't say new, improved or fixed: give --kind",
		);
		await expect(
			postNote(a, linear, "#125", { text: "Fine." }),
		).rejects.toThrow(
			/not a ticket \(CAR-NNN\): #125\. A PR without a ticket says "Release note: …" in its description/,
		);
		await expect(
			postNote(a, linear, "CAR-2", { text: "Fine.", kind: "new" }),
		).rejects.toThrow("Linear has no CAR-2");
		expect(writes).toEqual([]);
	});
});

describe("Linear access", () => {
	it("reads the key from $LINEAR_API_KEY, else $XDG_CONFIG_HOME's file, else ~/.config's, naming each place tried", () => {
		const home = mkdtempSync(join(tmpdir(), "crb-linear-"));
		try {
			const conf = join(home, ".config/linear/api-key");
			expect(linearKey({}, home)).toEqual({
				key: null,
				tried: ["$LINEAR_API_KEY", conf],
			});
			mkdirSync(join(home, ".config/linear"), { recursive: true });
			writeFileSync(conf, "lin_file\n");
			expect(linearKey({}, home).key).toBe("lin_file");
			expect(linearKey({ LINEAR_API_KEY: "lin_env" }, home).key).toBe(
				"lin_env",
			);
			// A worktree's .envrc points XDG_CONFIG_HOME at its own dir: the
			// key in ~/.config is still found, after that dir's.
			const own = join(home, "wt/.crb-dev/config");
			expect(linearKey({ XDG_CONFIG_HOME: own }, home)).toEqual({
				key: "lin_file",
				tried: ["$LINEAR_API_KEY", join(own, "linear/api-key"), conf],
			});
			mkdirSync(join(own, "linear"), { recursive: true });
			writeFileSync(join(own, "linear/api-key"), "lin_own");
			expect(linearKey({ XDG_CONFIG_HOME: own }, home).key).toBe("lin_own");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("posts GraphQL with the key, and fails on Linear's errors", async () => {
		const sent: { url: string; init: RequestInit }[] = [];
		const answer = (status: number, body: unknown) =>
			(async (url: string, init: RequestInit) => {
				sent.push({ url, init });
				return new Response(JSON.stringify(body), { status });
			}) as unknown as typeof fetch;
		const ok = linearClient(
			"lin_key",
			answer(200, { data: { x: 1 } }),
			"http://fake.invalid/graphql",
		);
		expect(await ok.query("query { x }", { a: 1 })).toEqual({ x: 1 });
		expect(sent[0]?.url).toBe("http://fake.invalid/graphql");
		expect(
			(sent[0]?.init.headers as Record<string, string> | undefined)
				?.authorization,
		).toBe("lin_key");
		expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
			query: "query { x }",
			variables: { a: 1 },
		});
		const bad = linearClient(
			"k",
			answer(400, { errors: [{ message: "Entity not found" }] }),
			"http://fake.invalid",
		);
		await expect(bad.query("query { x }")).rejects.toThrow(
			"Linear answered 400: Entity not found",
		);
	});
});

describe("coverage", () => {
	it("counts a ticket-less PR by #N and a ticket by its id; exempt PRs need nothing", () => {
		const range = {
			from: null,
			other: [],
			prs: [
				{ number: 1, title: "a", tickets: ["CAR-1"], exempt: false },
				{ number: 2, title: "b", tickets: [], exempt: false },
				{ number: 3, title: "next: 0.4.0", tickets: [], exempt: true },
			],
		};
		expect(coverage(range, null, new Map(), "0.4.0")).toEqual({
			missing: [
				{ id: "CAR-1", prs: [1] },
				{ id: "#2", prs: [2] },
			],
			uncoveredPrs: [1, 2],
		});
	});
});

describe("the committed release notes", () => {
	// A bad file breaks every RC build (ci:set-version reads them all) and
	// biome skips release-notes/: CI checks them here instead.
	const dir = join(import.meta.dirname, "../release-notes");

	it("every release-notes/*.json parses strictly and is named for its version", () => {
		const names = existsSync(dir) ? readdirSync(dir) : [];
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name, name).toMatch(/^\d+\.\d+\.\d+\.json$/);
			const file = readNotesFile(
				readFileSync(join(dir, name), "utf8"),
				`release-notes/${name}`,
			);
			expect(`${file.version}.json`, name).toBe(name);
		}
	});
});

describe("the release-note check (CAR-211): the ticket's note, else the PR's description", () => {
	const pull = (title: string, body = "", ref = "car-183-x") => ({
		number: 9,
		title,
		body,
		head: { ref },
		author_association: "OWNER",
	});
	const TRIED = ["$LINEAR_API_KEY"];
	const linearWith = (issues: Record<string, RawIssue>) => () => ({
		linear: fakeLinear(issues).linear,
		tried: TRIED,
	});
	const noKey = () => ({ linear: null, tried: TRIED });
	const noFiles = async (): Promise<string[]> => {
		throw new Error("no files asked here");
	};
	const empty = {
		comments: [{ body: "LGTM", updatedAt: "2026-11-15T00:00:00Z" }],
	};

	it("passes a ticket with no note in Linear on its description's note, the kind from the ticket's labels", async () => {
		expect(
			await prNotesOk(
				pull(
					"Threads (CAR-183)",
					"Fixes CAR-183\n\nRelease note: Threads tab.",
				),
				linearWith({ "CAR-183": { labels: ["Feature"], ...empty } }),
				noFiles,
			),
		).toBe("CAR-183: 1 note(s) in the PR's description");
		expect(
			await prNotesOk(
				pull("Threads (CAR-183)", "Release note: none (refactor)"),
				linearWith({ "CAR-183": empty }),
				noFiles,
			),
		).toBe("CAR-183: no note (refactor) in the PR's description");
	});

	it("the ticket's note wins over the description's, even a broken one there", async () => {
		expect(
			await prNotesOk(
				pull("Threads (CAR-183)", "Release note: see #12."),
				linearWith({
					"CAR-183": { comments: [note("none (refactor)")] },
				}),
				noFiles,
			),
		).toBe("CAR-183: no note (refactor)");
		// And a broken ticket note isn't saved by the description's.
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)", "Release note (new): Threads."),
				linearWith({ "CAR-183": { comments: [note("Threads.")] } }),
				noFiles,
			),
		).rejects.toThrow(/CAR-183's Release note: .*no kind/);
	});

	it("refuses neither, or a broken description note, naming both ways to fix it", async () => {
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)"),
				linearWith({ "CAR-183": empty }),
				noFiles,
			),
		).rejects.toThrow(
			/CAR-183 has no Release note: pnpm release note CAR-183 .*, or a "Release note" line in the PR's description/,
		);
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)", "Release note (new): see #12."),
				linearWith({ "CAR-183": empty }),
				noFiles,
			),
		).rejects.toThrow(
			/CAR-183 has no Release note, and the description's is broken: .*names a PR/,
		);
		// No kind: the description of a ticket without a type label must say it.
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)", "Release note: Threads."),
				linearWith({ "CAR-183": empty }),
				noFiles,
			),
		).rejects.toThrow(/no kind, and its ticket's labels don't say/);
	});

	it("with no key, passes only on a description note, and says why otherwise", async () => {
		expect(
			await prNotesOk(
				pull("Threads (CAR-183)", "Release note (new): Threads tab."),
				noKey,
				noFiles,
			),
		).toBe(
			"#9: 1 note(s) in its description (no Linear key here: CAR-183's notes unread)",
		);
		await expect(
			prNotesOk(pull("Threads (CAR-183)", "Fixes CAR-183"), noKey, noFiles),
		).rejects.toThrow(
			/^no Linear key \(tried \$LINEAR_API_KEY\).*; so CAR-183's Release note can't be read here: add a "Release note \(new\|improved\|fixed\): …" or "Release note: none \(why\)" line to the PR's description$/,
		);
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)", "Release note: Threads."),
				noKey,
				noFiles,
			),
		).rejects.toThrow(
			`#9's Release note: "Threads.": no kind, and the ticket's labels aren't read here: state the kind (write "Release note (new|improved|fixed): …")`,
		);
		// A ticket-less PR's says so for itself.
		await expect(
			prNotesOk(pull("Threads", "Release note: Threads.", "x"), noKey, noFiles),
		).rejects.toThrow(
			/no kind, and a PR without a ticket has no labels to take it from/,
		);
	});

	it("reads Linear only for the repository's own people's PRs: anyone else's passes only on a description note", async () => {
		const never = () => {
			throw new Error("Linear must not be asked for this PR");
		};
		for (const association of [
			"CONTRIBUTOR",
			"FIRST_TIME_CONTRIBUTOR",
			"NONE",
			undefined,
		]) {
			const pr = (body: string) => ({
				...pull("Threads (CAR-183)", body),
				author_association: association,
			});
			expect(
				await prNotesOk(pr("Release note (new): Threads tab."), never, noFiles),
				String(association),
			).toBe(
				`#9: 1 note(s) in its description (its author isn't the repository's (${association ?? "unknown"}): Linear isn't read for it)`,
			);
			await expect(
				prNotesOk(pr("Fixes CAR-183"), never, noFiles),
				String(association),
			).rejects.toThrow(
				`#9: its author isn't the repository's (${association ?? "unknown"}): Linear isn't read for it, so CAR-183's Release note there doesn't count: add a "Release note (new|improved|fixed): …" or "Release note: none (why)" line to the PR's description`,
			);
		}
		for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
			expect(
				await prNotesOk(
					{ ...pull("Threads (CAR-183)"), author_association: association },
					linearWith({ "CAR-183": { comments: [note("none (refactor)")] } }),
					noFiles,
				),
				association,
			).toBe("CAR-183: no note (refactor)");
		}
	});

	it("reads at most 5 tickets from Linear for one PR", async () => {
		const ids = [1, 2, 3, 4, 5, 6].map((n) => `CAR-${n}`);
		const issues = Object.fromEntries(
			ids.map((id) => [id, { comments: [note("none (x)")] }]),
		);
		const { linear, queries } = fakeLinear(issues);
		await expect(
			prNotesOk(
				pull(`Many (${ids.join(", ")})`),
				() => ({ linear, tried: TRIED }),
				noFiles,
			),
		).rejects.toThrow(
			"#9's title names 6 tickets: at most 5 (split the PR, or name fewer)",
		);
		expect(queries).toEqual([]);
		expect(
			await prNotesOk(
				pull(`Five (${ids.slice(0, 5).join(", ")})`),
				linearWith(issues),
				noFiles,
			),
		).toBe(
			ids
				.slice(0, 5)
				.map((id) => `${id}: no note (x)`)
				.join(", "),
		);
	});

	it("fails, never passes, when Linear can't be read", async () => {
		const failing = () => ({
			linear: {
				query: async () => {
					throw new Error("Linear answered 503: no data");
				},
			} satisfies Linear,
			tried: TRIED,
		});
		await expect(
			prNotesOk(
				pull("Threads (CAR-183)", "Release note (new): Threads tab."),
				failing,
				noFiles,
			),
		).rejects.toThrow(
			"couldn't read CAR-183 from Linear (Linear answered 503: no data): try again",
		);
	});

	it("a title and description naming different tickets still fails, and release PRs still pass", async () => {
		await expect(
			prNotesOk(
				pull(
					"Threads (CAR-183)",
					"Fixes CAR-184\n\nRelease note (new): Threads.",
				),
				noKey,
				noFiles,
			),
		).rejects.toThrow(/title names CAR-183 but its description links CAR-184/);
		expect(
			await prNotesOk(
				pull("notes: 0.4.0", "", "notes/0.4.0"),
				noKey,
				async () => ["release-notes/0.4.0.json"],
			),
		).toMatch(/no note needed/);
	});

	it("one decision from several PRs' descriptions", () => {
		const n = (text: string) => ({
			status: "notes" as const,
			notes: [{ kind: "new" as const, text }],
		});
		expect(descriptionsNote([])).toEqual({ status: "missing" });
		expect(
			descriptionsNote([n("A."), { status: "missing" }, n("A."), n("B.")]),
		).toEqual({
			status: "notes",
			notes: [
				{ kind: "new", text: "A." },
				{ kind: "new", text: "B." },
			],
		});
		expect(
			descriptionsNote([{ status: "none", why: "x" }, { status: "missing" }]),
		).toEqual({ status: "none", why: "x" });
		expect(
			descriptionsNote([n("A."), { status: "invalid", errors: ["bad"] }]),
		).toEqual({ status: "invalid", errors: ["bad"] });
	});

	it("collectNotes takes a ticket's PR description note when Linear has none, the ticket's otherwise", async () => {
		const asked: string[] = [];
		const io: Io = {
			repo: "owner/repo",
			log: () => {},
			now: () => new Date(),
			sleep: async () => {},
			run: async (_cmd, args) => {
				asked.push(args.join(" "));
				const n = /pulls\/(\d+)$/.exec(args[1] ?? "")?.[1];
				const bodies: Record<string, string> = {
					"5": "Fixes CAR-1\n\nRelease note: From the description.",
					"6": "Release note (fixed): Ignored, the ticket has one.",
					"7": "Nothing here.",
				};
				return { code: 0, stdout: bodies[n ?? ""] ?? "", stderr: "" };
			},
		};
		const { linear } = fakeLinear({
			"CAR-1": { labels: ["Improvement"], ...empty },
			"CAR-2": { labels: ["Bug"], comments: [note("From Linear.")] },
			"CAR-3": empty,
		});
		const pr = (number: number, ticket: string) => ({
			number,
			title: `x (${ticket})`,
			tickets: [ticket],
			exempt: false,
		});
		const r = await collectNotes(
			io,
			linear,
			"0.5.0",
			{
				from: null,
				prs: [pr(5, "CAR-1"), pr(6, "CAR-2"), pr(7, "CAR-3")],
				other: [],
			},
			new Map(),
		);
		expect(r.file.notes).toEqual(
			expect.arrayContaining([
				{
					id: "CAR-1",
					kind: "improved",
					prs: [5],
					text: "From the description.",
				},
				{ id: "CAR-2", kind: "fixed", prs: [6], text: "From Linear." },
			]),
		);
		expect(r.file.notes).toHaveLength(2);
		expect(r.missing).toEqual([
			expect.stringMatching(
				/^CAR-3 \(#7\): no Release note: pnpm release note CAR-3 .* \(or a "Release note" line in #7's description\)$/,
			),
		]);
		// Only the PRs of tickets with no note in Linear are asked for.
		expect(asked.some((a) => a.endsWith("pulls/6"))).toBe(false);
	});
});

describe("rerunning the release-note check after a note (CAR-211)", () => {
	const ghIo = (
		handlers: Record<
			string,
			(args: string[]) => { code: number; stdout?: string; stderr?: string }
		>,
	) => {
		const calls: string[] = [];
		const lines: string[] = [];
		const io: Io = {
			repo: "owner/repo",
			log: (l) => lines.push(l),
			now: () => new Date(),
			sleep: async () => {},
			run: async (cmd, args) => {
				const line = [cmd, ...args].join(" ");
				calls.push(line);
				const key = Object.keys(handlers).find((k) => line.startsWith(k));
				const r = key ? handlers[key]?.([...args]) : undefined;
				return r
					? { stdout: "", stderr: "", ...r }
					: { code: 127, stdout: "", stderr: `unexpected: ${line}` };
			},
		};
		return { io, calls, lines };
	};
	const prs = JSON.stringify([
		{ number: 9, title: "Threads (CAR-183)" },
		{ number: 10, title: "Other (CAR-1830)" },
		{ number: 11, title: "More (CAR-183, CAR-7)" },
		{ number: 12, title: "New (CAR-183)" },
	]);
	const link = (run: number) =>
		`https://github.com/owner/repo/actions/runs/${run}/job/${run}0`;
	// gh pr checks: the PR's checks (exit 1 with a failed one, 8 while one
	// is pending), or "no checks reported" on stderr.
	const checks = (pr: string) =>
		({
			"9": {
				code: 1,
				stdout: JSON.stringify([
					{ name: "checks", workflow: "CI", bucket: "pass", link: link(400) },
					// Another workflow's job of the same name is not it.
					{
						name: "release-note",
						workflow: "Other",
						bucket: "fail",
						link: link(499),
					},
					{
						name: "release-note",
						workflow: "Release note",
						bucket: "fail",
						link: link(501),
					},
				]),
			},
			"11": {
				code: 8,
				stdout: JSON.stringify([
					{
						name: "release-note",
						workflow: "Release note",
						bucket: "pending",
						link: link(502),
					},
				]),
			},
			"12": { code: 1, stderr: "no checks reported on the 'x' branch" },
			// Checks, but none is the release-note check (renamed, or not yet reported).
			"14": {
				code: 0,
				stdout: JSON.stringify([
					{ name: "checks", workflow: "CI", bucket: "pass", link: link(600) },
					{
						name: "release-note",
						workflow: "Release notes",
						bucket: "fail",
						link: link(601),
					},
				]),
			},
			"13": {
				code: 0,
				stdout: JSON.stringify([
					{
						name: "release-note",
						workflow: "Release note",
						bucket: "pass",
						link: link(503),
					},
				]),
			},
		})[pr] ?? { code: 1, stderr: "HTTP 502" };

	it("pnpm release note reruns the release-note check of each open PR naming the ticket", async () => {
		const writes: Record<string, unknown>[] = [];
		const { linear } = fakeLinear(
			{ "CAR-183": { labels: ["Feature"] } },
			writes,
		);
		const { io, calls, lines } = ghIo({
			"gh pr list": () => ({ code: 0, stdout: prs }),
			"gh pr checks": (a) => checks(a[2] ?? ""),
			"gh run rerun": () => ({ code: 0 }),
		});
		await postNote(io, linear, "CAR-183", { text: "Threads tab." });
		expect(calls).toContain(
			"gh pr list --repo owner/repo --base master --state open --limit 200 --json number,title",
		);
		expect(calls).toContain(
			"gh pr checks 9 --repo owner/repo --json name,workflow,bucket,link",
		);
		expect(calls.filter((c) => c.startsWith("gh run rerun"))).toEqual([
			"gh run rerun 501 --repo owner/repo",
		]);
		expect(calls.some((c) => c.startsWith("gh pr checks 10 "))).toBe(false);
		expect(lines).toEqual([
			"CAR-183: Release note (new): Threads tab.",
			"https://linear.app/c/1",
			`#9: reran its release-note check (run 501, ${link(501)})`,
			"#11: its release-note check is running (it may have read Linear before the note): if it ends red, gh run rerun 502",
			"#12: no release-note run yet: it reads the note when it runs",
		]);
		expect(writes).toHaveLength(1);
	});

	it("a failed lookup or rerun only warns: the note is posted", async () => {
		const writes: Record<string, unknown>[] = [];
		const { linear } = fakeLinear(
			{ "CAR-183": { labels: ["Feature"] } },
			writes,
		);
		const { io, lines } = ghIo({
			"gh pr list": () => ({
				code: 0,
				stdout: JSON.stringify([
					{ number: 9, title: "x (CAR-183)" },
					{ number: 77, title: "y (CAR-183)" },
				]),
			}),
			"gh pr checks": (a) => checks(a[2] ?? ""),
			"gh run rerun": () => ({ code: 1, stderr: "HTTP 403: no" }),
		});
		await expect(
			postNote(io, linear, "CAR-183", { text: "Threads tab." }),
		).resolves.toBe("Release note (new): Threads tab.");
		expect(lines.filter((l) => l.startsWith("warning:"))).toEqual([
			expect.stringMatching(
				/^warning: couldn't rerun #9's release-note check: .*HTTP 403/,
			),
			expect.stringMatching(
				/^warning: couldn't rerun #77's release-note check: gh pr checks 77 failed \(1\): HTTP 502/,
			),
		]);
		const listFails = ghIo({
			"gh pr list": () => ({ code: 1, stderr: "offline" }),
		});
		await rerunNoteChecks(listFails.io, "CAR-183");
		expect(listFails.lines).toEqual([
			expect.stringMatching(/^warning: couldn't list open PRs/),
		]);
	});

	it("merge-ok reruns only a red check, and says to wait for it", async () => {
		const pull = (number: number) => ({ number, title: "x" });
		const mk = () =>
			ghIo({
				"gh pr checks": (a) => checks(a[2] ?? ""),
				"gh run rerun": () => ({ code: 0 }),
			});
		const red = mk();
		await rerunRedNoteCheck(red.io, pull(9));
		expect(red.calls.at(-1)).toBe("gh run rerun 501 --repo owner/repo");
		expect(red.lines).toEqual([
			`#9's release-note check was red (it ran before the note): reran it (run 501, ${link(501)}); wait for it to turn green before merging`,
		]);
		for (const n of [11, 12, 13]) {
			const other = mk();
			await rerunRedNoteCheck(other.io, pull(n));
			expect(
				other.calls.some((c) => c.startsWith("gh run rerun")),
				`#${n}`,
			).toBe(false);
			expect(other.lines, `#${n}`).toEqual([]);
		}
		const broken = mk();
		await rerunRedNoteCheck(broken.io, pull(77));
		expect(broken.lines).toEqual([expect.stringMatching(/^warning: /)]);
	});

	it('says so when the PR\'s checks list no release-note check, rather than "no run yet"', async () => {
		const mk = () =>
			ghIo({
				"gh pr list": () => ({
					code: 0,
					stdout: JSON.stringify([{ number: 14, title: "x (CAR-183)" }]),
				}),
				"gh pr checks": (a) => checks(a[2] ?? ""),
				"gh run rerun": () => ({ code: 0 }),
			});
		const expected = `warning: #14's checks have no "${NOTE_CHECK}" of workflow "${NOTE_WORKFLOW_NAME}" (not reported yet, or renamed in release-note.yml?): rerun it by hand if it's red`;
		const note = mk();
		await rerunNoteChecks(note.io, "CAR-183");
		expect(note.lines).toEqual([expected]);
		const merge = mk();
		await rerunRedNoteCheck(merge.io, { number: 14, title: "x" });
		expect(merge.lines).toEqual([expected]);
		for (const m of [note, merge]) {
			expect(m.calls.some((c) => c.startsWith("gh run rerun"))).toBe(false);
		}
	});

	it("merge-ok's note step reruns the check only after its own note check passed", async () => {
		const mk = () =>
			ghIo({
				"gh pr checks": (a) => checks(a[2] ?? ""),
				"gh run rerun": () => ({ code: 0 }),
			});
		const noKey = () => ({ linear: null, tried: ["$LINEAR_API_KEY"] });
		const noFiles = async (): Promise<string[]> => [];
		const refused = mk();
		await expect(
			mergeOkNotes(
				refused.io,
				{
					number: 9,
					title: "Threads (CAR-183)",
					body: "",
					author_association: "OWNER",
				},
				noKey,
				noFiles,
			),
		).rejects.toThrow(/no Linear key/);
		expect(refused.calls).toEqual([]);
		const passed = mk();
		expect(
			await mergeOkNotes(
				passed.io,
				{
					number: 9,
					title: "Threads (CAR-183)",
					body: "Release note: none (tooling)",
					author_association: "OWNER",
				},
				noKey,
				noFiles,
			),
		).toMatch(/^#9: no note \(tooling\) in its description/);
		expect(passed.calls).toEqual([
			"gh pr checks 9 --repo owner/repo --json name,workflow,bucket,link",
			"gh run rerun 501 --repo owner/repo",
		]);
	});
});

describe("the release-note workflow (CAR-211)", () => {
	const text = readFileSync(
		join(import.meta.dirname, "../.github/workflows/release-note.yml"),
		"utf8",
	);
	const code = text
		.split("\n")
		.filter((l) => !l.trim().startsWith("#"))
		.join("\n");
	const steps = code.split(/^ {6}- /m).slice(1);

	it("runs on every PR to master (pull_request_target: this file and ref from master), as the job release-note, one run per PR", () => {
		expect(code).toMatch(
			/^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited\]\n {4}branches: \[master\]\n/m,
		);
		expect(code).not.toMatch(/^ {2}pull_request:$/m);
		// The names the reruns look for (NOTE_CHECK, NOTE_WORKFLOW_NAME).
		expect(code).toMatch(new RegExp(`^jobs:\n {2}${NOTE_CHECK}:$`, "m"));
		expect(code).toMatch(new RegExp(`^name: ${NOTE_WORKFLOW_NAME}$`, "m"));
		expect(code.match(/^name: .*$/m)?.[0]).toBe(`name: ${NOTE_WORKFLOW_NAME}`);
		// github.ref is master for every PR's run: grouped by the PR.
		expect(code).toMatch(
			/^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \}\}\n {2}cancel-in-progress: true$/m,
		);
	});

	it("runs in the environment release-note (master only), read-only, no cache", () => {
		expect(code).toMatch(/^ {4}environment: release-note$/m);
		expect(code.match(/environment:/g)).toHaveLength(1);
		expect(code).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
		expect(code).not.toMatch(/: write\b|id-token/);
		expect(code).not.toMatch(/cache:/);
	});

	it("checks out master, without credentials, and pins every action by SHA", () => {
		const checkout = steps.filter((s) => s.includes("actions/checkout@"));
		expect(checkout).toHaveLength(1);
		expect(checkout[0]).toMatch(/ref: master\n/);
		expect(checkout[0]).toMatch(/persist-credentials: false/);
		for (const m of code.matchAll(/uses: (\S+)/g)) {
			expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
		}
	});

	it("gives the Linear key to one step only, the last, after the install", () => {
		const withKey = steps.filter((s) => s.includes("secrets."));
		expect(withKey).toHaveLength(1);
		expect(withKey[0]).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions
			"LINEAR_API_KEY: ${{ secrets.LINEAR_READ_API_KEY }}",
		);
		expect(steps.at(-1)).toBe(withKey[0]);
		expect(code.split("LINEAR").length - 1).toBe(2);
		expect(code).not.toMatch(/^env:/m);
		const install = steps.findIndex((s) => s.includes("pnpm install"));
		expect(steps[install]).toContain("--frozen-lockfile --ignore-scripts");
		expect(install).toBeLessThan(steps.indexOf(withKey[0] ?? ""));
	});

	it("never checks out or runs the PR: only master, and nothing of the PR's head", () => {
		expect(code).not.toMatch(
			/pull_request\.head|head_ref|head\.sha|refs\/pull/,
		);
		expect(code).not.toMatch(/github\.head_ref/);
		const refs = [...code.matchAll(/^\s+ref: (.*)$/gm)].map((m) => m[1]);
		expect(refs).toEqual(["master"]);
	});

	it("never pastes the PR's text into a script: run lines name no event field but the number, via env", () => {
		for (const s of steps) {
			const run = /run: ([\s\S]*)$/.exec(s)?.[1] ?? "";
			expect(run, s).not.toContain("${{");
		}
		expect(code).not.toMatch(/pull_request\.(title|body|head)/);
		expect(code).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions
			"PR_NUMBER: ${{ github.event.pull_request.number }}",
		);
	});
});

describe("ci:pr-note, as the workflow runs it (CAR-211)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-pr-note-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const ciPrNote = (pull: object) => {
		writeFileSync(join(dir, "pull.json"), JSON.stringify(pull));
		writeFileSync(
			join(dir, "files.json"),
			JSON.stringify([[{ filename: "src/a.ts" }]]),
		);
		try {
			const out = execFileSync(
				join(import.meta.dirname, "../node_modules/.bin/tsx"),
				[
					join(import.meta.dirname, "release.ts"),
					"ci:pr-note",
					join(dir, "pull.json"),
					join(dir, "files.json"),
				],
				{
					encoding: "utf8",
					// No key, as on a fork's PR: nowhere to find one.
					env: {
						...process.env,
						LINEAR_API_KEY: "",
						HOME: dir,
						XDG_CONFIG_HOME: dir,
					},
				},
			);
			return { code: 0, out };
		} catch (e) {
			const err = e as { status: number; stdout: string };
			return { code: err.status, out: err.stdout };
		}
	};

	it("with no key, passes a ticket PR on its description's note, fails one without, as an annotation", {
		timeout: 30_000,
	}, () => {
		expect(
			ciPrNote({
				number: 9,
				title: "Threads (CAR-183)",
				body: "Release note: none (test tooling)",
				head: { ref: "car-183-x" },
				author_association: "MEMBER",
			}),
		).toEqual({
			code: 0,
			out: "#9: no note (test tooling) in its description (no Linear key here: CAR-183's notes unread)\n",
		});
		const failed = ciPrNote({
			number: 9,
			title: "Threads (CAR-183)",
			body: "Fixes CAR-183",
			head: { ref: "car-183-x" },
			author_association: "MEMBER",
		});
		expect(failed.code).toBe(1);
		expect(failed.out).toMatch(
			/^::error title=Release note::no Linear key .*line to the PR's description\n$/,
		);
	});

	it("keeps a PR's text to one printable annotation line", () => {
		expect(workflowText("a%b\r\n::warning::x")).toBe("a%25b%0D%0A::warning::x");
	});
});
