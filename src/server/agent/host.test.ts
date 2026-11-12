import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import type { AgentAnchor } from "../../shared/agent.js";
import type { Snapshot } from "../../shared/types.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { anchoredFile, anchorHunk, authorOf, threadFacts } from "./host.js";

vi.setConfig(GIT_TEST_TIMEOUTS);

// Every git call the host makes, to prove an unsafe anchor makes none.
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock("../git.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../git.js")>();
	return {
		...real,
		runGitBuffer: (repo: string, args: string[], opts?: object) => {
			gitCalls.push(args);
			return real.runGitBuffer(repo, args, opts);
		},
	};
});

const TREE = "/cache/agents/01k9e6m2q8x4v7c3n5b0h1j2t6/tree";
let repo: GitFixture;
let snapshot: Snapshot;

beforeEach(async () => {
	const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
	const changed = [...lines];
	changed[29] = "line 30 changed";
	repo = createGitFixture([
		{ message: "base", files: { "src/x.ts": `${lines.join("\n")}\n` } },
		{ message: "pr", files: { "src/x.ts": `${changed.join("\n")}\n` } },
	]);
	snapshot = await buildSnapshot(
		repo.path,
		repo.shas[0] as string,
		repo.shas[1] as string,
	);
});
afterEach(() => repo.cleanup());

const anchor = (over: Partial<AgentAnchor> = {}): AgentAnchor =>
	({
		subject: "line",
		path: "src/x.ts",
		commit: repo.shas[1] as string,
		side: "RIGHT",
		line: 30,
		startSide: "RIGHT",
		startLine: 30,
		...over,
	}) as AgentAnchor;

describe("anchoredFile", () => {
	it("reads the file at the anchor's commit; LEFT at the merge base", async () => {
		const src = { repo: repo.path, snapshot: () => snapshot };
		const right = await anchoredFile(src, TREE, anchor());
		expect(right?.uri).toBe(`file://${TREE}/src/x.ts`);
		expect(right?.mimeType).toBe("text/x-typescript");
		expect(right?.text).toContain("line 30 changed");
		const left = await anchoredFile(
			src,
			TREE,
			anchor({ side: "LEFT", startSide: "LEFT" }),
		);
		expect(left?.text).toContain("line 30\n");
	});

	it("a ../ or absolute path, or a commit that isn't an OID, is null without a git read", async () => {
		const snap = vi.fn(() => snapshot);
		const src = { repo: repo.path, snapshot: snap };
		gitCalls.length = 0;
		for (const path of ["../outside.txt", "src/../../x", "/etc/passwd"]) {
			expect(await anchoredFile(src, TREE, anchor({ path }))).toBeNull();
			expect(await anchorHunk(src, anchor({ path }))).toBeNull();
		}
		expect(
			await anchoredFile(src, TREE, anchor({ commit: "--output=/tmp/x" })),
		).toBeNull();
		expect(snap).not.toHaveBeenCalled();
		expect(gitCalls).toEqual([]);
	});
});

describe("anchorHunk", () => {
	it("is the hunk around the anchor as unified diff", async () => {
		const hunk = await anchorHunk(
			{ repo: repo.path, snapshot: () => snapshot },
			anchor(),
		);
		expect(hunk?.split("\n")).toEqual([
			"@@ -27,7 +27,7 @@",
			" line 27",
			" line 28",
			" line 29",
			"-line 30",
			"+line 30 changed",
			" line 31",
			" line 32",
			" line 33",
		]);
	});

	it("is null for a file anchor and a file the snapshot doesn't change", async () => {
		const src = { repo: repo.path, snapshot: () => snapshot };
		expect(
			await anchorHunk(src, {
				subject: "file",
				path: "src/x.ts",
				commit: repo.shas[1] as string,
			}),
		).toBeNull();
		expect(await anchorHunk(src, anchor({ path: "other.ts" }))).toBeNull();
	});
});

describe("authorOf", () => {
	const people = { viewer: "octo-cat", prAuthor: "Ann_B" };
	it("authorOf names the PR author pr_author", () => {
		expect(authorOf("Ann_B", people)).toBe("pr_author");
		// Logins compare as the review's slugs do (the viewer is one).
		expect(authorOf("ann-b", people)).toBe("pr_author");
		expect(authorOf("Octo_Cat", people)).toBe("reviewer");
		expect(authorOf("someone", people)).toBe("other");
		// Reviewing your own PR: you are the reviewer here.
		expect(
			authorOf("octo-cat", { viewer: "octo-cat", prAuthor: "Octo_Cat" }),
		).toBe("reviewer");
		// The author unknown: nobody is the author.
		expect(authorOf("", { viewer: "octo-cat", prAuthor: "" })).toBe("other");
	});
});

describe("threadFacts", () => {
	it("is the thread's comments with roles, its span columns, a link to its first comment and its code as diff text", () => {
		const facts = threadFacts(
			{
				thread: {
					path: "src/x.ts",
					line: 30,
					commit: "c".repeat(40),
					createdAt: "2026-11-02T00:00:00.000Z",
					outdated: false,
					resolved: false,
					anchor: {
						path: "src/x.ts",
						commit: "c".repeat(40),
						side: "RIGHT",
						line: 30,
						startSide: "RIGHT",
						startLine: 29,
						at: "2026-11-02T00:00:00.000Z",
						startCol: 2,
						endCol: 5,
					},
					code: {
						anchor: {
							path: "src/x.ts",
							commit: "c".repeat(40),
							side: "RIGHT",
							line: 30,
							startSide: "RIGHT",
							startLine: 29,
							at: "2026-11-02T00:00:00.000Z",
						},
						source: "clone",
						rows: [
							{
								kind: "context",
								oldNo: 29,
								newNo: 29,
								text: "line 29",
								marked: true,
							},
							{
								kind: "del",
								oldNo: 30,
								newNo: null,
								text: "line 30",
								marked: false,
							},
							{
								kind: "add",
								oldNo: null,
								newNo: 30,
								text: "line 30 changed",
								marked: true,
							},
						],
					},
				},
				comments: [
					{
						author: "Ann_B",
						publishedAt: "2026-11-02T00:00:00.000Z",
						body: "Why?",
					},
					{ author: "octo-cat", publishedAt: null, body: "Pending reply" },
				],
				openerRestId: 11,
			},
			"https://github.com/acme/widget/pull/7",
			(login) => authorOf(login, { viewer: "octo-cat", prAuthor: "Ann_B" }),
		);
		expect(facts).toEqual({
			url: "https://github.com/acme/widget/pull/7#discussion_r11",
			path: "src/x.ts",
			startLine: 29,
			line: 30,
			startCol: 2,
			endCol: 5,
			openedOn: "c".repeat(40),
			createdAt: "2026-11-02T00:00:00.000Z",
			outdated: false,
			resolved: false,
			comments: [
				{
					login: "Ann_B",
					role: "pr_author",
					at: "2026-11-02T00:00:00.000Z",
					body: "Why?",
				},
				{ login: "octo-cat", role: "reviewer", at: "", body: "Pending reply" },
			],
			code: "@@ -29,2 +29,2 @@\n line 29\n-line 30\n+line 30 changed",
		});
	});

	it("a file thread has no lines, columns or code; without an opener id the link is the PR's", () => {
		const facts = threadFacts(
			{
				thread: {
					path: "README.md",
					line: null,
					commit: "",
					createdAt: "2026-11-02T00:00:00.000Z",
					outdated: false,
					resolved: true,
					anchor: null,
					code: null,
				},
				comments: [],
				openerRestId: null,
			},
			"https://github.com/acme/widget/pull/7",
			() => "other",
		);
		expect(facts).toEqual({
			url: "https://github.com/acme/widget/pull/7",
			path: "README.md",
			startLine: null,
			line: null,
			openedOn: "",
			createdAt: "2026-11-02T00:00:00.000Z",
			outdated: false,
			resolved: true,
			comments: [],
			code: null,
		});
	});
});
