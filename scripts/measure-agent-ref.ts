/**
 * Measures the agent threads ref (docs/review-data-storage.md, "Agent
 * threads ref"): 50 threads of 4 messages of 2 KiB each in a throwaway
 * bare repo, written through AgentThreadStore. Prints the loose and packed
 * size, one append (wall and CPU, carbonless's and its git children's) and
 * a cold read() (a new store, nothing cached), loose and after `git gc`.
 *
 *   pnpm tsx scripts/measure-agent-ref.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AgentThreadStore } from "../src/server/agent/store";
import { RefStore } from "../src/server/review/refStore";
import type { AgentAnchor } from "../src/shared/agent";
import { createBareRepo, testGitEnv } from "../test/git-fixture";

/** A review id as the server makes one (a lowercase ULID). */
const REVIEW = "01k9e6m2q8x4v7c3n5b0h1j2t6";
const THREADS = 50;
const MESSAGES = 4;
const TEXT_BYTES = 2048;
/** Appends and cold reads timed; the median is reported. */
const RUNS = 9;

const agent = { name: "claude-agent-acp", version: "0.5.1" };
const anchor = (i: number): AgentAnchor => ({
	subject: "line",
	path: `src/module${i}/service.ts`,
	commit: "0123456789abcdef0123456789abcdef01234567",
	side: "RIGHT",
	line: 40 + i,
	startSide: "RIGHT",
	startLine: 38 + i,
	startCol: null,
	endCol: null,
});

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
		});
		ids.push(t.id);
		for (let m = 1; m < MESSAGES; m++) {
			await store.message(
				t.id,
				m % 2
					? {
							by: "ai",
							text: text(),
							agent,
							stop: "end_turn",
							activity: [
								{ kind: "read", title: "Read src/db/pool.ts" },
								{ kind: "search", title: "grep withLock" },
							],
						}
					: { by: "human", text: text(), clientId: `c${i}.${m}` },
			);
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
			`${THREADS} threads × ${MESSAGES} messages of ${TEXT_BYTES / 1024} KiB (${THREADS * MESSAGES} commits, ${textBytes / 1024} KiB of text)`,
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
	console.log("| Measure | Value |\n|---|---|");
	for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
} finally {
	cleanup();
}
