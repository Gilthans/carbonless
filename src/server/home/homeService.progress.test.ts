import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homePr } from "../../../test/fake-gh/scenario";
import type { RepoHome } from "../../shared/home.js";
import { ViewerCache } from "../viewerCache.js";
import type { PrFacts } from "./facts.js";
import {
	type HomeConfig,
	HomeService,
	PROGRESS_WAIT_MS,
} from "./homeService.js";
import type { InboxStore } from "./inbox.js";
import { fetchRepoPrs, mapPrNode } from "./prFacts.js";

// A repo's first read, as its batches land (CAR-290). GitHub's side is a
// stand-in fetchRepoPrs the test drives batch by batch: what's checked is
// what HomeService answers meanwhile, not gh.
vi.mock("./prFacts.js", async (original) => ({
	...(await original<typeof import("./prFacts.js")>()),
	fetchRepoPrs: vi.fn(),
	fetchViewerTeams: vi.fn(async () => []),
}));

const T0 = Date.parse("2026-11-24T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** PR #n, the viewer's, #1 newest. */
const pr = (n: number): PrFacts =>
	mapPrNode(
		"acme",
		"api",
		homePr({
			repo: "acme/api",
			number: n,
			author: "octo",
			updatedAt: iso(T0 - n * 60_000),
		}),
	) as PrFacts;
const prs = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => pr(from + i));

type Options = NonNullable<Parameters<typeof fetchRepoPrs>[3]>;

/** One read the test drives: `progress` shows a batch, `finish` ends it. */
interface Driven {
	options: Options;
	progress: (facts: PrFacts[]) => void;
	finish: (facts: PrFacts[]) => void;
	fail: (error: Error) => void;
}

let reads: Driven[] = [];
beforeEach(() => {
	reads = [];
	vi.mocked(fetchRepoPrs).mockImplementation(
		(_owner, _repo, _since, options = {}) =>
			new Promise((resolve, reject) => {
				reads.push({
					options,
					progress: (facts) => options.onProgress?.(facts),
					finish: resolve,
					fail: reject,
				});
			}),
	);
});
afterEach(() => {
	vi.useRealTimers();
});

function service() {
	const config: HomeConfig = {
		views: [{ name: "My PRs", repos: ["acme/api"] }],
		refresh: { minutes: 2 },
	};
	const clock = { now: T0 };
	const home = new HomeService({
		config: {
			read: async () => ({ config, problems: [] }),
			update: async (change) => change(config),
		},
		started: { list: async () => [] },
		inbox: {
			read: async () => new Map(),
			append: async () => ({ note: "x" }),
			reset: () => {},
		} as unknown as InboxStore,
		viewers: new ViewerCache({
			read: async () => ({ login: "octo", avatarUrl: "" }),
		}),
		now: () => clock.now,
	});
	return { home, clock };
}

/** Whether `p` has settled, after everything already due has run. */
async function settled(p: Promise<unknown>): Promise<boolean> {
	let done = false;
	void p.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setImmediate(r));
	return done;
}

const numbers = (r: RepoHome) =>
	r.rows.map((row) => row.number).sort((a, b) => a - b);

/** The read under way, once HomeService has started it. */
async function current(): Promise<Driven> {
	await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0));
	return reads.at(-1) as Driven;
}

describe("a repo's first read answers as it lands", () => {
	it("the first ask answers at the first batch, incomplete; the next at the next batch; then complete", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		expect(read.options.onProgress).toBeTypeOf("function");
		// Nothing read yet: the ask waits (never an empty answer).
		expect(await settled(first)).toBe(false);
		read.progress(prs(1, 10));
		const a = await first;
		expect(a).toMatchObject({
			complete: false,
			progress: 1,
			refreshedAt: null,
			error: null,
		});
		expect(numbers(a)).toEqual(prs(1, 10).map((p) => p.number));

		// Having seen batch 1, the page's next ask waits for batch 2.
		const second = home.repo("acme", "api", { seen: 1 });
		expect(await settled(second)).toBe(false);
		// Another tab, having seen nothing, answers at once with the same.
		const other = await home.repo("acme", "api");
		expect(other).toMatchObject({ complete: false, progress: 1 });
		expect(numbers(other)).toEqual(numbers(a));
		read.progress(prs(1, 30));
		const b = await second;
		expect(b).toMatchObject({ complete: false, progress: 2 });
		expect(numbers(b)).toHaveLength(30);

		// The end answers whoever waits, complete.
		const third = home.repo("acme", "api", { seen: 2 });
		expect(await settled(third)).toBe(false);
		read.finish(prs(1, 35));
		const c = await third;
		expect(c).toMatchObject({ complete: true, error: null });
		expect(c.refreshedAt).not.toBeNull();
		expect(numbers(c)).toHaveLength(35);
		// One read for every ask.
		expect(reads).toHaveLength(1);
	});

	it("a row shown mid-read can be annotated", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		read.progress(prs(1, 10));
		await first;
		const row = await home.annotate("acme", "api", 3, {
			op: "note",
			text: "x",
		});
		expect(row).toMatchObject({ number: 3, annotations: { note: "x" } });
		read.finish(prs(1, 12));
	});

	it("a read that fails mid-way keeps the rows so far, says why, and is complete (not loading)", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		read.progress(prs(1, 10));
		await first;
		const next = home.repo("acme", "api", { seen: 1 });
		read.fail(new Error("gh: API rate limit exceeded for user ID 1."));
		const r = await next;
		expect(r).toMatchObject({
			complete: true,
			refreshedAt: null,
			error: "Rate limited by GitHub",
			failures: 1,
		});
		expect(numbers(r)).toHaveLength(10);
	});

	it("a retry after a mid-way failure reads progressively again, from the rows it has", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const failed = await current();
		failed.progress(prs(1, 10));
		await first;
		failed.fail(new Error("gh: boom"));
		await vi.waitFor(async () =>
			expect(await home.repo("acme", "api")).toMatchObject({ complete: true }),
		);
		const retry = home.repo("acme", "api", { fresh: true, seen: 1 });
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		const read = reads[1] as Driven;
		expect([...(read.options.known?.keys() ?? [])]).toHaveLength(10);
		// The ended read's gate doesn't let the new read's ask through.
		expect(await settled(retry)).toBe(false);
		read.progress(prs(1, 20));
		expect(await retry).toMatchObject({ complete: false, progress: 2 });
		read.finish(prs(1, 25));
	});

	it("a refresh of a repo read in full keeps its rows whole and answers once done", async () => {
		const { home, clock } = service();
		const first = home.repo("acme", "api");
		(await current()).finish(prs(1, 5));
		expect(await first).toMatchObject({ complete: true });
		clock.now += 10 * 60_000;
		const again = home.repo("acme", "api", { fresh: true });
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		const read = reads[1] as Driven;
		// Not progressive: the last rows stand until the read is done.
		expect(read.options.onProgress).toBeUndefined();
		expect(await settled(again)).toBe(false);
		read.finish(prs(1, 6));
		const r = await again;
		expect(r).toMatchObject({ complete: true });
		expect(numbers(r)).toHaveLength(6);
	});

	it("an ask that holds a whole list waits for the whole read, never a partial one (fix round 1)", async () => {
		// A cold server (restarted, or the repo evicted) while the page shows
		// every row: the page says so, and its rows are never cut to a batch.
		const { home } = service();
		const whole = home.repo("acme", "api", { whole: true });
		const read = await current();
		read.progress(prs(1, 10));
		// A first ask without rows gets the batch; the whole one still waits.
		expect(await home.repo("acme", "api")).toMatchObject({ complete: false });
		expect(await settled(whole)).toBe(false);
		read.progress(prs(1, 30));
		expect(await settled(whole)).toBe(false);
		read.finish(prs(1, 35));
		const r = await whole;
		expect(r).toMatchObject({ complete: true });
		expect(numbers(r)).toHaveLength(35);
	});

	it("a batch of a read that failed, landing late, changes nothing (fix round 1)", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const failed = await current();
		failed.progress(prs(1, 10));
		await first;
		failed.fail(new Error("gh: boom"));
		await vi.waitFor(async () =>
			expect(await home.repo("acme", "api")).toMatchObject({ complete: true }),
		);
		// Late: no new progress, no new rows.
		failed.progress(prs(1, 30));
		const after = await home.repo("acme", "api");
		expect(after).toMatchObject({ complete: true, progress: 1 });
		expect(numbers(after)).toHaveLength(10);
		// A retry that ends whole: the old read's late batch never cuts it.
		const retry = home.repo("acme", "api", { fresh: true, whole: true });
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		(reads[1] as Driven).finish(prs(1, 40));
		expect(numbers(await retry)).toHaveLength(40);
		failed.progress(prs(1, 20));
		const last = await home.repo("acme", "api");
		expect(last).toMatchObject({ complete: true, error: null });
		expect(numbers(last)).toHaveLength(40);
	});

	it("a retry of a failed first read spins, not the old error, while it lands (fix round 1)", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const failed = await current();
		failed.progress(prs(1, 10));
		await first;
		failed.fail(new Error("gh: API rate limit exceeded for user ID 1."));
		await vi.waitFor(async () =>
			expect(await home.repo("acme", "api")).toMatchObject({
				complete: true,
				error: "Rate limited by GitHub",
			}),
		);
		const retry = home.repo("acme", "api", { fresh: true, seen: 1 });
		await vi.waitFor(() => expect(reads).toHaveLength(2));
		(reads[1] as Driven).progress(prs(1, 20));
		expect(await retry).toMatchObject({ complete: false, error: null });
		(reads[1] as Driven).finish(prs(1, 25));
	});

	it("reset() answers the asks held on a first read at once (fix round 1)", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		read.progress(prs(1, 10));
		await first;
		const held = home.repo("acme", "api", { seen: 1 });
		expect(await settled(held)).toBe(false);
		home.reset();
		expect(await settled(held)).toBe(true);
		read.finish(prs(1, 12));
	});

	it("an ask that has seen more than the read has (a restart) waits for the next batch (fix round 2)", async () => {
		const { home } = service();
		// A page from before a restart, its read 3 batches along.
		const ask = home.repo("acme", "api", { seen: 3 });
		const read = await current();
		expect(await settled(ask)).toBe(false);
		read.progress(prs(1, 10));
		expect(await ask).toMatchObject({ complete: false, progress: 1 });
		read.finish(prs(1, 12));
	});

	it("a first read slower than the cache period, failing, is answered with its error, not followed by another read (fix round 2)", async () => {
		const { home, clock } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		read.progress(prs(1, 10));
		await first;
		// GitHub slow: the read outlasts the period, then fails, while no ask waits.
		clock.now += 60 * 60_000;
		read.fail(new Error("gh: boom"));
		// The read has ended before the page's next ask (its gap between asks).
		await new Promise((r) => setImmediate(r));
		const next = home.repo("acme", "api", { seen: 1 });
		expect(await settled(next)).toBe(true);
		expect(await next).toMatchObject({ complete: true, error: "boom" });
		expect(reads).toHaveLength(1);
	});

	it("an ask that has seen everything answers after PROGRESS_WAIT_MS with what there is", async () => {
		const { home } = service();
		const first = home.repo("acme", "api");
		const read = await current();
		read.progress(prs(1, 10));
		await first;
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const waiting = home.repo("acme", "api", { seen: 1 });
		expect(await settled(waiting)).toBe(false);
		await vi.advanceTimersByTimeAsync(PROGRESS_WAIT_MS);
		expect(await waiting).toMatchObject({ complete: false, progress: 1 });
		vi.useRealTimers();
		read.finish(prs(1, 11));
	});
});
