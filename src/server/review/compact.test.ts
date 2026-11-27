import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture.js";
import type { AgentAnchor } from "../../shared/agent.js";
import {
	AgentThreadStore,
	agentThreadsRef,
	foldAgentThreads,
} from "../agent/store.js";
import { onSpawn } from "../spawnWatch.js";
import { compactReview } from "./compact.js";
import { type CrbEvent, newEvent, parseEventLines } from "./events.js";
import { foldProgress } from "./fold.js";
import { RefStore } from "./refStore.js";
import { listReviews, ReviewService } from "./reviews.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const REV1 = "a".repeat(64);
const REV2 = "b".repeat(64);
const key = (i: number) => i.toString(16).padStart(64, "0");
const pr = {
	owner: "acme",
	repo: "widget",
	number: 7,
	url: "https://github.com/acme/widget/pull/7",
	baseBranch: "main",
	headBranch: "feature",
	headRepo: "acme/widget",
};
const anchor: AgentAnchor = {
	subject: "line",
	path: "src/lock.ts",
	commit: "a".repeat(40),
	side: "RIGHT",
	line: 12,
	startSide: "RIGHT",
	startLine: 10,
	startCol: null,
	endCol: null,
};
const agent = { name: "fake-acp", version: "1.0.0" };

let repo: string;
let cleanup: () => void;
let store: RefStore;

const git = (...args: string[]) =>
	execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: testGitEnv(),
	}).trim();

beforeEach(() => {
	({ path: repo, cleanup } = createBareRepo());
	store = new RefStore(repo);
});
afterEach(() => cleanup());

const progressRef = (id: string, slug: string) =>
	`refs/crb/reviews/${id}/reviewers/${slug}/progress`;

let clock = 1_700_000_000_000;
const at = <E extends CrbEvent>(e: E): E => {
	clock += 10;
	return { ...e, ts: clock };
};

const started = (patchset: number, revision: string, since?: number) =>
	at(
		newEvent("patchset-started", "dan", {
			patchset,
			revision,
			mergeBase: "1".repeat(40),
			head: "2".repeat(40),
			...(since ? { since, shape: "S1" as const } : {}),
		}),
	);
const mark = (i: number, state: "reviewed" | "crossed-off" | "unreviewed") =>
	at(
		newEvent("cluster-state", "dan", {
			patchset: REV1,
			cluster: key(i),
			path: `src/f${i % 7}.ts`,
			state,
		}),
	);

/**
 * A review as a reviewer leaves it: meta, two reviewers' progress (one
 * commit per write: patch sets, marks, unmarks, line marks, carries, a
 * placement), an agent conversation, a patch set's pins, and what an older
 * or newer crb could have written (a line of an unknown type, a duplicate).
 */
let prNumber = 7;
async function seedReview(marks: number): Promise<string> {
	const reviews = new ReviewService(store);
	const id = await reviews.findOrCreateReview(
		{ ...pr, number: prNumber++ },
		"dan",
	);
	const dan = progressRef(id, "dan");
	await store.appendEvent(dan, "PS1", started(1, REV1), "dan");
	for (let i = 0; i < marks; i++) {
		// Some marked twice, some taken back: last one wins in the fold.
		const state = i % 5 === 0 ? "crossed-off" : "reviewed";
		await store.appendEvent(dan, `m${i}`, mark(i, state), "dan");
		if (i % 9 === 0) {
			await store.appendEvent(dan, `u${i}`, mark(i, "unreviewed"), "dan");
		}
	}
	await store.appendEvent(
		dan,
		"lines",
		at(
			newEvent("lines-state", "dan", {
				patchset: REV1,
				cluster: key(marks + 1),
				path: "src/lines.ts",
				state: "reviewed",
				lines: [[0, 3]],
			}),
		),
		"dan",
	);
	await store.appendEvents(
		dan,
		"PS2",
		[
			started(2, REV2, 1),
			at(
				newEvent(
					"carried",
					"dan",
					{
						from: 1,
						to: 2,
						rule: "exact",
						states: [
							{ key: key(1), fromKey: key(1), state: "reviewed" },
							{ key: key(2), fromKey: key(2), state: "reviewed" },
						],
					},
					"auto",
				),
			),
		],
		"dan",
	);
	const placed = at(
		newEvent("thread-placed", "dan", {
			thread: "PRRT_1",
			patchset: 2,
			anchor: {
				path: "src/a.ts",
				startSide: "RIGHT",
				startLine: 3,
				side: "RIGHT",
				line: 4,
			},
			engine: 1,
		}),
	);
	await store.appendEvent(dan, "placed", placed, "dan");
	// The same event twice (a merge of two copies would do this).
	await store.appendEvent(dan, "dup", placed, "dan");
	// A newer crb's event type, and a line nobody can read: kept verbatim.
	const tip = await store.tip(dan);
	const future = await store.commitMessage(
		tip,
		'crb: future\n\n{"v":2,"id":"01kfuture0000000000000000","type":"from-the-future","x":1}\n{not json\n',
		"dan",
	);
	await store.transaction([{ ref: dan, newOid: future, oldOid: tip }]);
	// A second reviewer.
	const eve = progressRef(id, "eve");
	await store.appendEvent(
		eve,
		"PS1",
		{ ...started(1, REV1), actor: "eve" },
		"eve",
	);
	await store.appendEvent(
		eve,
		"m",
		{ ...mark(3, "reviewed"), actor: "eve" },
		"eve",
	);
	// An agent conversation.
	const threads = new AgentThreadStore(store, id, "dan");
	const t = await threads.open({
		anchor,
		text: "Why a lock here?",
		by: "human",
		clientId: "c1",
	});
	await threads.message(t.id, {
		by: "ai",
		text: "It guards the cache.",
		agent,
		stop: "end_turn",
		activity: [],
	});
	await threads.message(t.id, { by: "human", text: "Thanks", clientId: "c2" });
	// Patch set pins: refs to PR commits, never event refs.
	const pinned = await store.commitMessage(null, "a PR commit\n", "dan");
	git("update-ref", `refs/crb/reviews/${id}/reviewers/dan/patchsets/1`, pinned);
	return id;
}

/** Everything a reader gets from a review's refs. */
async function readAll(id: string) {
	const fresh = new RefStore(repo);
	const progress = async (slug: string) =>
		foldProgress(await fresh.readEvents(progressRef(id, slug)));
	return {
		dan: await progress("dan"),
		eve: await progress("eve"),
		threads: foldAgentThreads(
			await fresh.readEvents(agentThreadsRef(id, "dan")),
		),
		reviews: await listReviews(repo),
		pins: git(
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			`refs/crb/reviews/${id}/reviewers/dan/patchsets/`,
		),
	};
}

/** The event lines a ref's history holds, in the order readers see them, without compaction's own. */
function lines(ref: string): string[] {
	return git("log", "--reverse", "--format=%B", ref)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("{") && !l.includes('"type":"compacted"'));
}

const commitCount = (ref: string) => Number(git("rev-list", "--count", ref));

const eventRefs = (id: string) => [
	`refs/crb/reviews/${id}/meta`,
	progressRef(id, "dan"),
	progressRef(id, "eve"),
	agentThreadsRef(id, "dan"),
];

describe("compactReview", () => {
	it("rewrites each event ref to one commit and every fold reads the same", async () => {
		const id = await seedReview(40);
		// Meta with a history too.
		await store.appendEvent(
			`refs/crb/reviews/${id}/meta`,
			"closed",
			newEvent("review-closed", "dan", { outcome: "merged" }),
			"dan",
		);
		const before = await readAll(id);
		const linesBefore = eventRefs(id).map(lines);
		const tipsBefore = eventRefs(id).map((r) => git("rev-parse", r));
		expect(before.dan.patchsets).toHaveLength(2);
		expect(before.threads[0]?.messages).toHaveLength(3);

		const result = await compactReview(store, id, "dan");

		expect(result.skipped).toEqual([]);
		expect(result.compacted.map((c) => c.ref).sort()).toEqual(
			[...eventRefs(id)].sort(),
		);
		for (const ref of eventRefs(id)) expect(commitCount(ref)).toBe(1);
		// The same lines in the same order (one exact duplicate dropped).
		const linesAfter = eventRefs(id).map(lines);
		expect(linesAfter[1]).toEqual(
			(linesBefore[1] as string[]).filter((l, i, all) => all.indexOf(l) === i),
		);
		for (const i of [0, 2, 3]) expect(linesAfter[i]).toEqual(linesBefore[i]);
		expect(linesAfter[1]?.some((l) => l.includes("from-the-future"))).toBe(
			true,
		);
		expect(linesAfter[1]).toContain("{not json");
		expect(await readAll(id)).toEqual(before);
		// Each ref says it was compacted, from which tip, of how many commits.
		for (const [i, ref] of eventRefs(id).entries()) {
			const marker = parseEventLines(git("log", "-1", "--format=%B", ref)).find(
				(e) => e.type === "compacted",
			);
			expect(marker).toMatchObject({
				by: "auto",
				from: tipsBefore[i],
				commits: commitCount(tipsBefore[i] as string),
			});
		}
		// The reviewer's refs keep the reviewer as author; never a real identity.
		expect(
			git("log", "-1", "--format=%an <%ae> %cn <%ce>", progressRef(id, "eve")),
		).toBe("eve <eve@crb> crb <crb@crb>");
	});

	it("leaves a compacted review alone, and compacts writes made after it", async () => {
		const id = await seedReview(5);
		await compactReview(store, id, "dan");
		const tips = eventRefs(id).map((r) => git("rev-parse", r));
		const again = await compactReview(store, id, "dan");
		expect(again.compacted).toEqual([]);
		expect(eventRefs(id).map((r) => git("rev-parse", r))).toEqual(tips);

		// A mark after the merge lands on top, and folds in.
		await store.appendEvent(
			progressRef(id, "dan"),
			"late",
			mark(99, "reviewed"),
			"dan",
		);
		const before = await readAll(id);
		const third = await compactReview(store, id, "dan");
		expect(third.compacted.map((c) => c.ref)).toEqual([progressRef(id, "dan")]);
		expect(commitCount(progressRef(id, "dan"))).toBe(1);
		expect(await readAll(id)).toEqual(before);
	});

	it("keeps a write that lands while it compacts (compare-and-swap, then again)", async () => {
		const id = await seedReview(10);
		const dan = progressRef(id, "dan");
		let raced = false;
		const result = await compactReview(store, id, "dan", {
			beforeSwap: async (ref) => {
				if (ref !== dan || raced) return;
				raced = true;
				// Another tab marks a line meanwhile.
				await store.appendEvent(dan, "racing", mark(77, "reviewed"), "dan");
			},
		});
		expect(raced).toBe(true);
		expect(result.skipped).toEqual([]);
		expect(commitCount(dan)).toBe(1);
		const progress = foldProgress(await new RefStore(repo).readEvents(dan));
		expect(progress.statesByRevision.get(REV1)?.get(key(77))?.state).toBe(
			"reviewed",
		);
	});

	it("gives up on a ref that keeps moving, losing nothing", async () => {
		const id = await seedReview(3);
		const dan = progressRef(id, "dan");
		let n = 0;
		const result = await compactReview(store, id, "dan", {
			beforeSwap: async (ref) => {
				if (ref === dan) {
					await store.appendEvent(
						dan,
						"racing",
						mark(200 + n++, "reviewed"),
						"dan",
					);
				}
			},
		});
		expect(result.skipped.map((s) => s.ref)).toEqual([dan]);
		const progress = foldProgress(await new RefStore(repo).readEvents(dan));
		for (let i = 0; i < n; i++) {
			expect(
				progress.statesByRevision.get(REV1)?.get(key(200 + i))?.state,
			).toBe("reviewed");
		}
		// The others were compacted all the same.
		expect(commitCount(progressRef(id, "eve"))).toBe(1);
	});

	it("starts as many git processes for 4x the events, and for 4x the other reviews", async () => {
		const spawnsOf = async (id: string) => {
			let n = 0;
			const stop = onSpawn(() => {
				n++;
			});
			try {
				// A fresh store: the empty tree's lookup counts every time.
				await compactReview(new RefStore(repo), id, "dan");
			} finally {
				stop();
			}
			return n;
		};
		const small = await seedReview(10);
		const large = await seedReview(40);
		let made = 0;
		const others = async (k: number) => {
			const commit = git("rev-parse", progressRef(small, "eve"));
			const input = Array.from(
				{ length: k - made },
				(_, i) =>
					`create refs/crb/reviews/01k${String(made + i).padStart(23, "0")}/reviewers/dan/progress ${commit}\n`,
			).join("");
			made = k;
			execFileSync("git", ["update-ref", "--stdin"], {
				cwd: repo,
				input,
				env: testGitEnv(),
			});
		};
		const atSmall = await spawnsOf(small);
		const atLarge = await spawnsOf(large);
		expect(atLarge).toBe(atSmall);
		// Isolation: other reviews in the clone don't add processes.
		const third = await seedReview(10);
		await others(50);
		const atK = await spawnsOf(third);
		const fourth = await seedReview(10);
		await others(200);
		const at4K = await spawnsOf(fourth);
		expect(at4K).toBe(atK);
		expect(atK).toBe(atSmall);
	});
});
