/**
 * Measures the agent threads ref (docs/review-data-storage.md, "Agent
 * threads ref"): 50 GitHub-thread conversations of 4 messages of 2 KiB each
 * (a view on each human message, a head on each answer, one seen event per
 * answer) in a throwaway bare repo, written through AgentThreadStore. Prints the loose and packed
 * size, one append (wall and CPU, carbonless's and its git children's) and
 * a cold read() (a new store, nothing cached), loose and after `git gc`.
 * With `--review`: one review conversation of 20 messages instead (no
 * `head` on answers: every agent answers through MCP since 2026-11-13).
 * With `--moves` (CAR-139): then thread moves on top: one move and one
 * undo commit's size (raw, deflated), a realistic review's moves (2 agent
 * and 5 GitHub threads moved once, 1 undone) and the mixed heavy case
 * (50 agent and 100 GitHub threads moved on 3 patch sets, every 6th
 * undone), each as packed growth, and a cold read of the ref's moves.
 *
 *   pnpm tsx scripts/measure-agent-ref.ts [--review] [--moves]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { AgentThreadStore } from "../src/server/agent/store";
import { RefStore } from "../src/server/review/refStore";
import type { AgentAnchor, AgentView } from "../src/shared/agent";
import { createBareRepo, testGitEnv } from "../test/git-fixture";

/** A review id as the server makes one (a lowercase ULID). */
const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const REVIEW_MODE = process.argv.includes("--review");
const MOVES_MODE = process.argv.includes("--moves");
const THREADS = REVIEW_MODE ? 1 : 50;
const MESSAGES = REVIEW_MODE ? 20 : 4;
const TEXT_BYTES = 2048;
/** Appends and cold reads timed; the median is reported. */
const RUNS = 9;

const agent = { name: "claude-agent-acp", version: "0.5.1" };
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const anchor = (i: number): AgentAnchor =>
	REVIEW_MODE ? { subject: "review" } : threadAnchor(i);
const threadAnchor = (i: number): AgentAnchor => ({
	subject: "thread",
	// A GitHub review thread's node id.
	thread: `PRRT_kwDOKx${String(i).padStart(6, "0")}Hq1AbCdEf`,
	path: `src/module${i}/service.ts`,
	commit: COMMIT,
	side: "RIGHT",
	line: 40 + i,
	startSide: "RIGHT",
	startLine: 38 + i,
});
const view: AgentView = {
	target: { patchset: 2 },
	from: { branch: true },
	left: COMMIT,
	right: COMMIT,
};

// Prose-like text from a seeded generator: compresses like real answers,
// not like one repeated letter.
let seed = 42;
const rand = () => {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
};
const WORDS =
	"the lock is taken before the write and released after the commit so two writers never race on the same row unless the retry loop reenters while holding it which `withLock()` guards by checking the owner token first see src/db/pool.ts line 88 for the call".split(
		" ",
	);
const text = () => {
	let out = "";
	while (Buffer.byteLength(out) < TEXT_BYTES) {
		out += `${WORDS[Math.floor(rand() * WORDS.length)]}${rand() < 0.08 ? ".\n" : " "}`;
	}
	return out.slice(0, TEXT_BYTES);
};

/** CPU ms of this process and of its waited-for children (Linux /proc). */
function cpu(): { self: number; children: number } {
	const stat = readFileSync("/proc/self/stat", "utf8");
	// Fields after "(comm) ": cutime and cstime are the 16th and 17th.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const tick = 1000 / 100; // CLK_TCK
	const usage = process.cpuUsage();
	return {
		self: (usage.user + usage.system) / 1000,
		children: (Number(fields[13]) + Number(fields[14])) * tick,
	};
}

async function timed<T>(
	run: () => Promise<T>,
): Promise<{ wall: number; self: number; children: number }> {
	const c0 = cpu();
	const t0 = performance.now();
	await run();
	const wall = performance.now() - t0;
	const c1 = cpu();
	return { wall, self: c1.self - c0.self, children: c1.children - c0.children };
}

const median = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

async function medianOf(run: () => Promise<unknown>) {
	const all = [];
	for (let i = 0; i < RUNS; i++) all.push(await timed(run));
	return {
		wall: median(all.map((r) => r.wall)),
		self: median(all.map((r) => r.self)),
		children: median(all.map((r) => r.children)),
	};
}

function sizeKiB(repo: string): { loose: number; packed: number } {
	const out = execFileSync("git", ["count-objects", "-v"], {
		cwd: repo,
		encoding: "utf8",
		env: testGitEnv(),
	});
	const field = (name: string) =>
		Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(out)?.[1] ?? Number.NaN);
	return { loose: field("size"), packed: field("size-pack") };
}

/** Random hex: every move gets its own base and head (they compress worse than real ones). */
const oid = () =>
	Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join(
		"",
	);
const ghId = (i: number) => `PRRT_kwDOKx${String(i).padStart(6, "0")}Hq1AbCdEf`;

/** A commit's bytes: raw, and as git keeps it loose (zlib). */
function commitSize(repo: string, ref: string): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, env: testGitEnv() });
	const tip = git("rev-parse", ref).toString().trim();
	const body = git("cat-file", "commit", tip);
	const object = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
	return `${body.length} B raw, ${deflateSync(object).length} B deflated`;
}

async function measureMoves(
	store: AgentThreadStore,
	agentIds: readonly string[],
): Promise<string[][]> {
	const ref = `refs/crb/reviews/${REVIEW}/reviewers/dan/agent/threads`;
	const gc = () =>
		execFileSync("git", ["gc", "--quiet", "--prune=now"], {
			cwd: repo,
			env: testGitEnv(),
		});
	const at = (i: number) => ({
		path: `src/module${i}/service.ts`,
		startSide: "RIGHT" as const,
		startLine: 40 + i,
		side: "RIGHT" as const,
		line: 42 + i,
	});
	const move = (
		thread: { source: "github" | "agent"; id: string },
		i: number,
		ps: number,
	) =>
		store.move({
			thread,
			on: { base: oid(), head: oid(), patchset: ps },
			anchor: at(i),
		});
	gc();
	const before = sizeKiB(repo).packed;
	const one = await move({ source: "github", id: ghId(1) }, 1, 2);
	const ghCommit = commitSize(repo, ref);
	await move({ source: "agent", id: agentIds[0] ?? "" }, 2, 2);
	const agentCommit = commitSize(repo, ref);
	await store.undoMove(one.thread, one.id);
	const undoCommit = commitSize(repo, ref);
	// Realistic: 2 agent + 5 GitHub threads moved once, 1 undone (8 commits).
	await move({ source: "agent", id: agentIds[1] ?? "" }, 3, 2);
	for (let i = 2; i < 6; i++)
		await move({ source: "github", id: ghId(i) }, i, 2);
	gc();
	const realistic = sizeKiB(repo).packed - before;
	// Heavy, mixed: 50 agent + 100 GitHub threads moved on 3 patch sets,
	// every 6th undone.
	const threads = [
		...agentIds.map((id) => ({ source: "agent" as const, id })),
		...Array.from({ length: 100 }, (_, i) => ({
			source: "github" as const,
			id: ghId(100 + i),
		})),
	];
	let k = 0;
	let commits = 0;
	for (let ps = 2; ps <= 4; ps++) {
		for (const [i, t] of threads.entries()) {
			const m = await move(t, i, ps);
			commits++;
			if (++k % 6 === 0) {
				await store.undoMove(t, m.id);
				commits++;
			}
		}
	}
	gc();
	const heavy = sizeKiB(repo);
	const coldMoves = await medianOf(() =>
		new AgentThreadStore(new RefStore(repo), REVIEW, "dan").moves(),
	);
	const ms = (x: number) => `${x.toFixed(1)} ms`;
	return [
		["One `thread-moved` commit, GitHub thread", ghCommit],
		["One `thread-moved` commit, agent thread", agentCommit],
		["One `thread-move-undone` commit", undoCommit],
		[
			"Realistic: 2 agent + 5 GitHub threads moved once, 1 undone (8 commits)",
			`+${realistic} KiB packed`,
		],
		[
			`Heavy, mixed: ${agentIds.length} agent + 100 GitHub threads moved on 3 patch sets, every 6th undone (${commits} commits)`,
			`+${heavy.packed - before} KiB packed (${heavy.packed} KiB)`,
		],
		[
			"Cold moves() of the mixed heavy ref, packed (median of 9)",
			`${ms(coldMoves.wall)} wall; CPU ${ms(coldMoves.self)} carbonless + ${ms(coldMoves.children)} git`,
		],
	];
}

const { path: repo, cleanup } = createBareRepo();
try {
	const store = new AgentThreadStore(new RefStore(repo), REVIEW, "dan");
	const ids: string[] = [];
	for (let i = 0; i < THREADS; i++) {
		const t = await store.open({
			anchor: anchor(i),
			text: text(),
			by: "human",
			clientId: `c${i}`,
			view,
		});
		ids.push(t.id);
		for (let m = 1; m < MESSAGES; m++) {
			const after = await store.message(
				t.id,
				m % 2
					? {
							by: "ai",
							text: text(),
							agent,
							stop: "end_turn",
							...(REVIEW_MODE ? {} : { head: COMMIT }),
							activity: [
								{ kind: "read", title: "Read src/db/pool.ts" },
								{ kind: "search", title: "grep withLock" },
							],
						}
					: { by: "human", text: text(), clientId: `c${i}.${m}`, view },
			);
			// The reviewer sees each answer.
			if (m % 2) await store.seen(t.id, after.messages.at(-1)?.id ?? "");
		}
	}
	const textBytes = THREADS * MESSAGES * TEXT_BYTES;
	const loose = sizeKiB(repo);
	// Appends to a full ref, through the warm store the server keeps.
	let n = 0;
	const append = await medianOf(() =>
		store.message(ids[0] ?? "", {
			by: "human",
			text: text(),
			clientId: `extra${n++}`,
		}),
	);
	const coldLoose = await medianOf(() =>
		new AgentThreadStore(new RefStore(repo), REVIEW, "dan").read(),
	);
	execFileSync("git", ["gc", "--quiet", "--prune=now"], {
		cwd: repo,
		env: testGitEnv(),
	});
	const packed = sizeKiB(repo);
	const coldPacked = await medianOf(() =>
		new AgentThreadStore(new RefStore(repo), REVIEW, "dan").read(),
	);
	const ms = (x: number) => `${x.toFixed(1)} ms`;
	const rows = [
		[
			"Events",
			`${THREADS} threads × ${MESSAGES} messages of ${TEXT_BYTES / 1024} KiB (${THREADS * MESSAGES} message commits + ${THREADS * (MESSAGES / 2)} seen, ${textBytes / 1024} KiB of text)`,
		],
		["Loose size", `${loose.loose} KiB`],
		["Packed size (git gc)", `${packed.packed} KiB`],
		[
			"One append (median of 9)",
			`${ms(append.wall)} wall; CPU ${ms(append.self)} carbonless + ${ms(append.children)} git`,
		],
		[
			"Cold read(), loose",
			`${ms(coldLoose.wall)} wall; CPU ${ms(coldLoose.self)} carbonless + ${ms(coldLoose.children)} git`,
		],
		[
			"Cold read(), packed",
			`${ms(coldPacked.wall)} wall; CPU ${ms(coldPacked.self)} carbonless + ${ms(coldPacked.children)} git`,
		],
	];
	if (MOVES_MODE) rows.push(...(await measureMoves(store, ids)));
	console.log("| Measure | Value |\n|---|---|");
	for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
} finally {
	cleanup();
}
