// @vitest-environment jsdom
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import fc from "fast-check";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../../test/git-fixture";
import {
	collectUnits,
	isolationProblems,
	statesOf,
	unitProblems,
} from "../../../test/markable";
import { buildSnapshot, loadFileHunks } from "../../server/diff/snapshot";
import {
	answerRereview,
	interdiffFileHunks,
	traceRereview,
} from "../../server/rereview/engine";
import type {
	ClusterView,
	FileHunks,
	FileView,
	Snapshot,
} from "../../shared/types";
import { DiffBody } from "./DiffBody";
import { type KindEntry, sinceByFile } from "./since";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

// Real git processes, and a render per run.
vi.setConfig({ ...GIT_TEST_TIMEOUTS, testTimeout: 240_000 });

/*
 * The invariant (docs/product-rules.md, "Every visible cluster is
 * individually markable") over random PRs: a base file, PS1 a random edit
 * of it, PS2 a random edit of PS1 (appended: S1). Both views of PS2 are
 * built by the server's own code (the snapshot's hunks; the engine's
 * interdiff) and rendered; every unit must have its own controls, and
 * ticking one must tick it alone.
 */

type Op =
	| { op: "keep" }
	| { op: "edit" }
	| { op: "indent" }
	| { op: "drop" }
	| { op: "insert"; n: number }
	| { op: "revert" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 6, arbitrary: fc.constant({ op: "keep" as const }) },
	{ weight: 2, arbitrary: fc.constant({ op: "edit" as const }) },
	{ weight: 1, arbitrary: fc.constant({ op: "indent" as const }) },
	{ weight: 1, arbitrary: fc.constant({ op: "drop" as const }) },
	{
		weight: 1,
		arbitrary: fc.record({
			op: fc.constant("insert" as const),
			n: fc.integer({ min: 1, max: 3 }),
		}),
	},
	{ weight: 2, arbitrary: fc.constant({ op: "revert" as const }) },
);

interface Line {
	text: string;
	/** The base's text of this line, if it has one. */
	base?: string;
}

const BASE: Line[] = Array.from({ length: 14 }, (_, i) => ({
	text: `line ${i + 1}`,
	base: `line ${i + 1}`,
}));

/** Applies one op per line; `tag` keeps new texts unique per patch set. */
function apply(lines: Line[], ops: Op[], tag: string): Line[] {
	const out: Line[] = [];
	let fresh = 0;
	lines.forEach((line, i) => {
		const o = ops[i] ?? { op: "keep" };
		switch (o.op) {
			case "keep":
				out.push(line);
				break;
			case "edit":
				out.push({ ...line, text: `${line.text} ${tag}` });
				break;
			case "indent":
				out.push({ ...line, text: `\t${line.text}` });
				break;
			case "drop":
				break;
			case "insert":
				out.push(line);
				for (let k = 0; k < o.n; k++)
					out.push({ text: `${tag} new ${fresh++}` });
				break;
			case "revert":
				if (line.base !== undefined) out.push({ ...line, text: line.base });
				break;
		}
	});
	return out;
}

const textOf = (lines: Line[]) => lines.map((l) => `${l.text}\n`).join("");

let repo: string;
const git = (args: string[], input?: string) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: testGitEnv({
			GIT_AUTHOR_NAME: "a",
			GIT_AUTHOR_EMAIL: "a@example.com",
			GIT_COMMITTER_NAME: "a",
			GIT_COMMITTER_EMAIL: "a@example.com",
		}),
		input,
	}).trim();

/** A commit of `f.txt` with `content`, on `parent`. */
function commit(content: string, parent?: string): string {
	const blob = git(["hash-object", "-w", "--stdin"], content);
	const tree = git(["mktree"], `100644 blob ${blob}\tf.txt\n`);
	return git(
		["commit-tree", tree, "-m", "c", ...(parent ? ["-p", parent] : [])],
		"",
	);
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "crb-markable-"));
	git(["init", "--quiet", "--initial-branch=main"]);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const record = (number: number, s: Snapshot) => ({
	number,
	revision: s.revision,
	mergeBase: s.base,
	head: s.head,
	startedAt: 0,
	since: null,
	shape: null,
	baseBranch: "main",
	interdiff: null,
});

interface Views {
	file: FileView;
	full: FileHunks;
	since: { hunks: FileHunks; kinds: Map<string, KindEntry> } | null;
}

/** PS2's file as the page gets it: its clusters, its full diff and its since view from PS1. */
async function views(ps1Ops: Op[], ps2Ops: Op[]): Promise<Views | null> {
	const ps1Lines = apply(BASE, ps1Ops, "v1");
	const ps2Lines = apply(ps1Lines, ps2Ops, "v2");
	const base = commit(textOf(BASE));
	const p1 = commit(textOf(ps1Lines), base);
	const p2 = commit(textOf(ps2Lines), p1);
	const ps1 = await buildSnapshot(repo, base, p1);
	const ps2 = await buildSnapshot(repo, base, p2);
	const summary = ps2.files[0];
	if (!summary || ps1.files.length === 0) return null;
	const file: FileView = {
		...summary,
		clusters: summary.clusters.map((c) => ({ ...c, state: "unreviewed" })),
		done: false,
		reviewed: false,
		crossedOff: false,
	};
	const full = await loadFileHunks(repo, ps2, 0);
	// PS1 reviewed in full: what PS2 left alone carries, the rest is to read.
	const states = new Map(
		ps1.files.flatMap((f) =>
			f.clusters.map((c) => [c.key, { state: "reviewed" as const }]),
		),
	);
	const sincePs = {
		...record(1, ps1),
		snapshot: ps1,
		states,
	};
	const target = { ...ps2, baseBranch: "main" };
	const traced = await traceRereview(repo, sincePs, [], target);
	const { answer } = answerRereview(traced, sincePs, [], target);
	const hunks = interdiffFileHunks(traced, ps2, answer, 0);
	const view = {
		revision: ps2.revision,
		patchset: null,
		files: [file],
		progress: {
			clusters: { total: 0, reviewed: 0, crossedOff: 0 },
			lines: { total: 0, reviewed: 0, crossedOff: 0 },
			files: { total: 0, reviewed: 0, crossedOff: 0, done: 0 },
		},
	};
	const kinds = sinceByFile(answer, view).get(0)?.kinds ?? new Map();
	return { file, full, since: { hunks, kinds } };
}

function Stateful(props: {
	file: FileView;
	from?: number;
	kinds?: Map<string, KindEntry>;
}) {
	const [states, setStates] = useState(new Map<string, ClusterView["state"]>());
	const file = {
		...props.file,
		clusters: props.file.clusters.map((c) => ({
			...c,
			state: states.get(c.key) ?? c.state,
		})),
	};
	return (
		<DiffBody
			file={file}
			revision="r"
			from={props.from}
			kinds={props.kinds}
			onToggle={(c) =>
				setStates((s) =>
					new Map(s).set(
						c.key,
						c.state === "unreviewed" ? "reviewed" : "unreviewed",
					),
				)
			}
			onCrossOff={() => {}}
		/>
	);
}

/** Renders one view and checks the invariant: own controls, a tick ticks its unit alone. */
async function check(
	file: FileView,
	hunks: FileHunks,
	since?: Map<string, KindEntry>,
): Promise<void> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(hunks), { status: 200 })),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={client}>
				<Stateful file={file} from={since ? 1 : undefined} kinds={since} />
			</QueryClientProvider>,
		);
		await waitFor(() =>
			expect(document.querySelector('[aria-busy="true"]')).toBeNull(),
		);
		const units = collectUnits(document.body);
		expect(unitProblems(units)).toEqual([]);
		for (const u of units) {
			const before = statesOf(collectUnits(document.body));
			const box = document.querySelector(
				`[data-markable-unit="${u.index}"] input[type="checkbox"]`,
			) as HTMLInputElement;
			act(() => {
				fireEvent.click(box);
			});
			expect(
				isolationProblems(
					u.index,
					before,
					statesOf(collectUnits(document.body)),
					"reviewed",
				),
			).toEqual([]);
		}
	} finally {
		cleanup();
		vi.unstubAllGlobals();
	}
}

const scripts = fc.tuple(
	fc.array(opArb, { minLength: 14, maxLength: 14 }),
	fc.array(opArb, { minLength: 20, maxLength: 20 }),
);

describe("every unit is markable on its own, over random PS1 → PS2 edits", () => {
	window.scrollTo = vi.fn();

	it("the full diff of PS2", async () => {
		await fc.assert(
			fc.asyncProperty(scripts, async ([ops1, ops2]) => {
				const v = await views(ops1, ops2);
				fc.pre(v !== null);
				if (!v) return;
				await check(v.file, v.full);
			}),
			{ numRuns: 25 },
		);
	});

	// A known violation, red once fixed (then make it `it`): one PS2
	// cluster in several pieces shares one box; a removal-only piece and
	// a gone block have none.
	it.fails("the since view from PS1 [Brief 8 (rr-mark-scope): every since-view piece is markable on its own]", async () => {
		await fc.assert(
			fc.asyncProperty(scripts, async ([ops1, ops2]) => {
				const v = await views(ops1, ops2);
				fc.pre(v !== null && v.since !== null);
				if (!v?.since) return;
				await check(v.file, v.since.hunks, v.since.kinds);
			}),
			{ numRuns: 25 },
		);
	});
});
