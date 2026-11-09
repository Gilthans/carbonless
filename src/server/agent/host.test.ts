import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import type { AgentAnchor } from "../../shared/agent.js";
import type { Snapshot } from "../../shared/types.js";
import { buildSnapshot } from "../diff/snapshot.js";
import { anchoredFile, anchorHunk } from "./host.js";

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
