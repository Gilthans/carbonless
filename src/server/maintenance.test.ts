import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../../test/git-fixture";
import { withRepoLock } from "./clone";
import {
	countObjects,
	IDLE_MS,
	MAINTAINED_AT,
	MAINTENANCE_EVERY_MS,
	maintainClone,
	maintainClones,
	maintenanceCommands,
} from "./maintenance";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const git = (cwd: string, args: string[], input?: string) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: testGitEnv(),
		input,
	}).trim();

const day = MAINTENANCE_EVERY_MS;

interface Grown {
	clone: string;
	/** Commits fetched by ID that no ref holds (PR heads a force-push dropped). */
	dangling: string[];
	/** Loose objects crb wrote that no ref holds. */
	looseUnreachable: string[];
}

/**
 * A bare clone grown as crb grows one: `k` fetches (each its own pack, as
 * a fetch of 100+ objects is), half of them commits fetched by ID with no
 * ref, and `k` crb writes (loose blobs and commits on refs/crb, plus loose
 * objects no ref holds).
 */
function grow(tmp: string, k: number): Grown {
	mkdirSync(tmp, { recursive: true });
	const src = join(tmp, "src");
	git(tmp, ["init", "--quiet", "-b", "main", src]);
	// One fast-import for the remote's history: k commits on main, and k
	// commits on refs/tmp/* that are dropped after (unreachable there too).
	const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
	let stream = "";
	for (let i = 1; i <= k; i++) {
		stream += `commit refs/heads/main\nmark :${i}\ncommitter t <t@t> ${1_700_000_000 + i} +0000\n${data(`m${i}`)}`;
		if (i > 1) stream += `from :${i - 1}\n`;
		for (let f = 0; f < 3; f++) {
			const body = `file ${i} ${f}\n`;
			stream += `M 100644 inline f${i}-${f}\n${data(body)}`;
		}
		const lost = `force-pushed away ${i}\n`;
		stream += `commit refs/tmp/d${i}\nmark :${k + i}\ncommitter t <t@t> ${1_700_000_000 + i} +0000\n${data(`d${i}`)}M 100644 inline lost\n${data(lost)}`;
	}
	git(src, ["fast-import", "--quiet"], stream);
	const mains = git(src, [
		"rev-parse",
		...Array.from({ length: k }, (_, i) => `main~${k - 1 - i}`),
	]).split("\n");
	const dangling = git(src, [
		"rev-parse",
		...Array.from({ length: k }, (_, i) => `refs/tmp/d${i + 1}`),
	]).split("\n");
	git(
		src,
		["update-ref", "--stdin"],
		dangling.map((_, i) => `delete refs/tmp/d${i + 1}\n`).join(""),
	);

	const clone = join(tmp, "repos", "acme", "widget.git");
	mkdirSync(join(tmp, "repos", "acme"), { recursive: true });
	git(tmp, ["init", "--quiet", "--bare", clone]);
	git(clone, ["config", "gc.auto", "0"]);
	// Every fetch keeps its pack, as a real fetch of 100+ objects does.
	git(clone, ["config", "transfer.unpackLimit", "1"]);
	const url = pathToFileURL(src).href;
	const looseUnreachable: string[] = [];
	for (let i = 0; i < k; i++) {
		git(clone, [
			"fetch",
			"--quiet",
			url,
			`${mains[i]}:refs/remotes/origin/main`,
		]);
		git(clone, ["fetch", "--quiet", url, dangling[i] as string]);
		// crb's writes: a loose event commit on a review ref, and a loose
		// object nothing refers to.
		const blob = git(
			clone,
			["hash-object", "-w", "--stdin"],
			`mark ${i} unreferenced\n`,
		);
		looseUnreachable.push(blob);
		const empty = git(
			clone,
			["hash-object", "-t", "tree", "-w", "--stdin"],
			"",
		);
		const event = git(
			clone,
			[
				"-c",
				"user.name=crb",
				"-c",
				"user.email=crb@crb",
				"commit-tree",
				empty,
				"-m",
				`crb: event ${i}`,
			],
			undefined,
		);
		git(clone, ["update-ref", `refs/crb/reviews/r${i}/meta`, event]);
	}
	git(clone, ["config", "--unset", "transfer.unpackLimit"]);
	return { clone, dangling, looseUnreachable };
}

/** OIDs `cat-file --batch-check` can't find in `repo`. */
const missing = (repo: string, oids: string[]) =>
	git(repo, ["cat-file", "--batch-check"], `${oids.join("\n")}\n`)
		.split("\n")
		.filter((line) => line.endsWith(" missing"));

describe("clone maintenance", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-maint-"));
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it.each([
		[8, "geometric"],
		[32, "geometric"],
		[8, "git < 2.32"],
	] as const)(
		"packs a clone grown by %i fetches and writes into a few packs, losing nothing (%s)",
		async (k, plan) => {
			const grown = grow(join(tmp), k);
			const before = await countObjects(grown.clone);
			// Sanity: the clone grew as crb's do.
			expect(before.packs).toBeGreaterThanOrEqual(2 * k);
			expect(before.loose).toBeGreaterThanOrEqual(2 * k);

			const old = plan === "git < 2.32";
			const result = await maintainClone(grown.clone, {
				...(old ? { gitVersion: [2, 30] as [number, number] } : {}),
			});
			if (old) {
				// git's maintenance tasks finish each step on the next run.
				expect(
					await maintainClone(grown.clone, {
						force: true,
						now: Date.now() + IDLE_MS + 1,
						gitVersion: [2, 30],
					}),
				).toMatchObject({ ran: true });
			}
			expect(result).toMatchObject({ ran: true });
			const after = await countObjects(grown.clone);
			expect(after.loose).toBe(0);
			// The same bound at k and 4k: the pack count no longer grows with use.
			// (Older git's incremental repack rolls small packs up only once
			// they add up to its batch size: it just doesn't add to them.)
			expect(after.packs).toBeLessThanOrEqual(old ? before.packs + 2 : 3);
			// Nothing is pruned: heads fetched by ID with no ref, and objects
			// crb wrote that nothing refers to, are all still there.
			expect(missing(grown.clone, grown.dangling)).toEqual([]);
			expect(missing(grown.clone, grown.looseUnreachable)).toEqual([]);
			expect(
				git(grown.clone, ["fsck", "--connectivity-only", "--no-dangling"]),
			).toBe("");
		},
	);

	it("runs at most once a day per clone, and records when", async () => {
		const { clone } = grow(tmp, 2);
		const now = Date.now();
		expect(await maintainClone(clone, { now })).toMatchObject({ ran: true });
		const at = Number(git(clone, ["config", "--get", MAINTAINED_AT]));
		expect(at).toBeGreaterThan(0);
		expect(await maintainClone(clone, { now: at + day - 60_000 })).toEqual({
			ran: false,
			reason: "recent",
		});
		expect(await maintainClone(clone, { now: at + day + 1 })).toMatchObject({
			ran: true,
		});
	});

	it("skips a clone whose lock someone holds (an open or a fetch)", async () => {
		const { clone } = grow(tmp, 2);
		const before = await countObjects(clone);
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		let inside = () => {};
		const entered = new Promise<void>((r) => {
			inside = r;
		});
		const open = withRepoLock(clone, async () => {
			inside();
			await held;
		});
		await entered;
		// Doesn't wait for the open: a timeout of 0.
		expect(await maintainClone(clone, { now: Date.now() + IDLE_MS })).toEqual({
			ran: false,
			reason: "busy",
		});
		release();
		await open;
		expect(await countObjects(clone)).toEqual(before);
	});

	it("skips a clone this process used within the idle window", async () => {
		const { clone } = grow(tmp, 2);
		await withRepoLock(clone, async () => {});
		expect(await maintainClone(clone)).toEqual({ ran: false, reason: "busy" });
		expect(
			await maintainClone(clone, { now: Date.now() + IDLE_MS + 1 }),
		).toMatchObject({ ran: true });
	});

	it("never overlaps an open: one that comes during a run waits for it", async () => {
		const { clone } = grow(tmp, 2);
		const order: string[] = [];
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const run = maintainClone(clone, { gate }).then((r) => {
			order.push("maintenance done");
			return r;
		});
		// The run holds the lock (its gate is shut) before the open asks.
		await vi.waitFor(() => expect(existsSync(`${clone}.lock`)).toBe(true));
		const open = withRepoLock(clone, async () => {
			order.push("open");
		});
		release();
		await Promise.all([run, open]);
		expect(order).toEqual(["maintenance done", "open"]);
		expect(await run).toMatchObject({ ran: true });
	});

	it("goes through every clone one at a time, skipping what isn't one", async () => {
		const a = grow(join(tmp, "a"), 2);
		const reposRoot = join(tmp, "a", "repos");
		const b = join(reposRoot, "acme", "other.git");
		git(tmp, ["init", "--quiet", "--bare", b]);
		// A clone under way, and a stray file: never maintained.
		git(tmp, [
			"init",
			"--quiet",
			"--bare",
			join(reposRoot, "acme", "x.git.partial"),
		]);
		const lines: string[] = [];
		const results = await maintainClones({
			root: reposRoot,
			log: (m) => lines.push(m),
		});
		// In name order, each to its end before the next.
		expect([...results.keys()]).toEqual([b, a.clone]);
		expect([...results.values()].every((r) => r.ran)).toBe(true);
		expect(lines[1]).toMatch(
			/^maintenance acme\/widget\.git: \d+ loose, \d+ packs → 0 loose, \d+ packs/,
		);
	});
});

describe("maintenanceCommands", () => {
	it.each([[[2, 30]], [[2, 32]], [[2, 53]], [[3, 0]]] as [[number, number]][])(
		"never prunes, on git %j",
		(version) => {
			const all = maintenanceCommands(version).flat();
			for (const banned of ["gc", "prune", "-a", "-A", "--prune", "--cruft"]) {
				expect(all).not.toContain(banned);
			}
			expect(all.some((a) => a.startsWith("--expire"))).toBe(false);
		},
	);

	it("rolls packs up geometrically from git 2.32, with maintenance tasks before", () => {
		expect(maintenanceCommands([2, 32])[0]).toContain("--geometric=2");
		expect(maintenanceCommands([2, 31])[0]).toContain(
			"--task=incremental-repack",
		);
	});
});
