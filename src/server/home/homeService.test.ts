import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpHomePr, homePr, release } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { HomeView, RepoHome, SectionId } from "../../shared/home.js";
import { composeSections } from "../../shared/homeSections.js";
import type { StartedReview } from "./facts.js";
import {
	configAccess,
	FRESH_MS,
	type HomeConfig,
	HomeService,
	NotOnHomeError,
} from "./homeService.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-29T12:00:00Z");
const H = 3_600_000;
const DAY = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

let fx: HomeFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

function memoryConfig(repos: string[], minutes = 2) {
	let config: HomeConfig = {
		views: [{ name: "My PRs", repos }],
		refresh: { minutes },
	};
	const writes: HomeConfig[] = [];
	return {
		writes,
		access: {
			read: async () => ({ config, problems: [] as string[] }),
			update: async (change: (c: HomeConfig) => HomeConfig) => {
				config = change(config);
				writes.push(config);
				return config;
			},
		},
	};
}

function service(
	opts: {
		repos?: string[];
		started?: StartedReview[];
		clock?: { now: number };
		minutes?: number;
	} = {},
) {
	const clock = opts.clock ?? { now: T0 };
	const config = memoryConfig(opts.repos ?? ["acme/api"], opts.minutes);
	const started = { list: async () => opts.started ?? [] };
	const home = new HomeService({
		config: config.access,
		started,
		now: () => clock.now,
	});
	return { home, clock, config };
}

type Loaded = HomeView & {
	repos: RepoHome[];
	sections: ReturnType<typeof composeSections>;
};

/**
 * Home as the page builds it: the view, then each view repo's rows
 * (`fresh`: read from GitHub now, as the Refresh button asks), composed.
 */
async function load(
	home: HomeService,
	opts: { fresh?: boolean } = {},
): Promise<Loaded> {
	const view = await home.view();
	const repos = await Promise.all(
		view.view.repos.map((name) => {
			const [owner = "", repo = ""] = name.split("/");
			return home.repo(owner, repo, opts);
		}),
	);
	return {
		...view,
		repos,
		sections: composeSections(
			repos.flatMap((r) => r.rows),
			view.viewer.login,
		),
	};
}
const refresh = (home: HomeService) => load(home, { fresh: true });
const repoOf = (view: Loaded, name: string) =>
	view.repos.find((r) => r.repo === name);
/** The fake gh's calls of Home's list query, one per repo read. */
const listReads = (log: string) =>
	[...log.matchAll(/-f name=(\S+) -F withOpen=/g)].map((m) => m[1]);

const ids = (view: { sections: Loaded["sections"] }, id: SectionId) =>
	view.sections.find((s) => s.id === id)?.rows.map((r) => r.number);
const row = (view: { sections: Loaded["sections"] }, n: number) =>
	view.sections.flatMap((s) => s.rows).find((r) => r.number === n);

const scenarioPrs = () => [
	homePr({
		repo: "acme/api",
		number: 1,
		author: "Octo",
		updatedAt: iso(T0 - 1 * H),
	}),
	homePr({
		repo: "acme/api",
		number: 2,
		author: "alice",
		requested: ["octo"],
		updatedAt: iso(T0 - 2 * H),
	}),
	homePr({
		repo: "acme/api",
		number: 3,
		author: "alice",
		updatedAt: iso(T0 - 3 * H),
	}),
	homePr({
		repo: "acme/api",
		number: 4,
		author: "alice",
		requested: ["bob"],
		updatedAt: iso(T0 - 4 * H),
	}),
	homePr({
		repo: "acme/api",
		number: 5,
		author: "alice",
		state: "MERGED",
		closedAt: iso(T0 - DAY),
	}),
	homePr({
		repo: "acme/api",
		number: 6,
		author: "alice",
		state: "CLOSED",
		closedAt: iso(T0 - 2 * DAY),
	}),
	homePr({
		repo: "acme/api",
		number: 7,
		author: "alice",
		state: "MERGED",
		closedAt: iso(T0 - 4 * DAY),
	}),
	homePr({
		repo: "acme/api",
		number: 8,
		author: "alice",
		requested: ["acme/backend"],
		updatedAt: iso(T0 - 5 * H),
	}),
	homePr({
		repo: "acme/api",
		number: 9,
		author: "bob",
		updatedAt: iso(T0 - 0.5 * H),
	}),
];

describe("HomeService", () => {
	it("builds all five sections in order, newest activity first", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			viewerTeams: ["acme/backend"],
		});
		const { home } = service();
		const view = await refresh(home);
		expect(view.viewer).toEqual({
			login: "Octo",
			avatarUrl: "https://avatars.example/Octo",
		});
		expect(view.view).toEqual({ name: "My PRs", repos: ["acme/api"] });
		expect(view.sections.map((s) => s.id)).toEqual([
			"mine",
			"reviewing",
			"grabs",
			"other",
			"closed",
		]);
		expect(ids(view, "mine")).toEqual([1]);
		expect(ids(view, "reviewing")).toEqual([2]);
		// Asked only of the viewer's team, nobody reviewed: up for grabs.
		expect(ids(view, "grabs")).toEqual([9, 3, 8]);
		expect(ids(view, "other")).toEqual([4]);
		expect(ids(view, "closed")).toEqual([5, 6]);
		expect(view.repos).toEqual([
			expect.objectContaining({
				repo: "acme/api",
				refreshedAt: iso(T0),
				error: null,
				failures: 0,
			}),
		]);
		expect(view.refreshMinutes).toBe(2);
		expect(view.viewerError).toBe(null);
		expect(row(view, 2)?.section).toBe("reviewing");
		expect(row(view, 5)).toMatchObject({
			openable: false,
			state: "MERGED",
			turn: { kind: "none" },
		});
		expect(row(view, 2)).toMatchObject({
			openable: true,
			turn: { kind: "people", logins: ["octo"] },
			reviews: [],
			hidden: null,
			woke: null,
		});
		expect(row(view, 2)?.people.octo?.login).toBe("Octo");
		expect(row(view, 2)?.reviewers).toEqual(["octo"]);
		expect(row(view, 8)?.reviewers).toEqual(["acme/backend"]);
		expect(row(view, 8)?.people["acme/backend"]?.login).toBe("acme/backend");
		expect(row(view, 3)?.reviewers).toEqual([]);
	});

	it("lists every row of a long section (the fold is the page's)", async () => {
		const prs = Array.from({ length: 25 }, (_, i) =>
			homePr({
				repo: "acme/api",
				number: i + 1,
				author: "Octo",
				updatedAt: iso(T0 - i * 1000),
			}),
		);
		fx = createHomeFixture({ repos: { "acme/api": { prs } } });
		const view = await refresh(service().home);
		expect(ids(view, "mine")).toHaveLength(25);
	});

	it("the view alone reads no repo: the viewer, the repos, no PR read", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service();
		const view = await home.view();
		expect(view.viewer.login).toBe("Octo");
		expect(view.view.repos).toEqual(["acme/api"]);
		expect(view).not.toHaveProperty("sections");
		expect(listReads(fx.ghLog())).toEqual([]);
	});

	it("a repo's read is its own: only that repo is asked of GitHub", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: scenarioPrs() },
				"acme/web": {
					prs: [
						homePr({
							repo: "acme/web",
							number: 50,
							author: "Octo",
							updatedAt: iso(T0),
						}),
					],
				},
			},
		});
		const { home } = service({ repos: ["acme/api", "acme/web"] });
		const web = await home.repo("acme", "web");
		expect(web.repo).toBe("acme/web");
		expect(web.rows.map((r) => [r.number, r.section])).toEqual([[50, "mine"]]);
		expect(listReads(fx.ghLog())).toEqual(["web"]);
		expect(fx.ghLog()).not.toMatch(/name=api\b/);
	});

	it("one read per repo per refresh.minutes, however many clients ask; fresh always reads", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home, clock } = service({ minutes: 2 });
		// Client A's first ask reads.
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toEqual(["api"]);
		// Client B, a minute later, and A's own timed ask just under the
		// period: the cache answers, with every row.
		clock.now = T0 + 60_000;
		const b = await home.repo("acme", "api");
		expect(b.rows.map((r) => r.number).sort()).toEqual([
			1, 2, 3, 4, 5, 6, 8, 9,
		]);
		clock.now = T0 + 2 * 60_000 - 1;
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toEqual(["api"]);
		// The period is up: the next ask, whoever's, reads.
		clock.now = T0 + 2 * 60_000;
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toEqual(["api", "api"]);
		// Refresh or Retry reads at once, however fresh the cache.
		clock.now += 1000;
		await home.repo("acme", "api", { fresh: true });
		expect(listReads(fx.ghLog())).toEqual(["api", "api", "api"]);
	});

	it("never caches for less than FRESH_MS, whatever refresh.minutes says", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home, clock } = service({ minutes: 0 });
		await home.repo("acme", "api");
		clock.now = T0 + FRESH_MS - 1;
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toEqual(["api"]);
	});

	it("concurrent requests for one repo share one read; a cold repo waits for it", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			hold: ["home:acme/api"],
		});
		const { home } = service();
		const asks = Promise.all([
			home.repo("acme", "api"),
			home.repo("Acme", "API"),
			home.repo("acme", "api", { fresh: true }),
		]);
		// The read is out and held: every ask is waiting on it.
		await expect.poll(() => listReads(fx?.ghLog() ?? "")).toEqual(["api"]);
		release(fx.path, "home:acme/api");
		const [a, b, c] = await asks;
		expect(a.rows).toHaveLength(8);
		expect(b).toEqual(a);
		expect(c).toEqual(a);
		expect(listReads(fx.ghLog())).toEqual(["api"]);
	});

	it("a repo outside the view is refused (404) without asking GitHub", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() }, "other/tool": { prs: [] } },
		});
		const { home } = service();
		await expect(home.repo("other", "tool")).rejects.toBeInstanceOf(
			NotOnHomeError,
		);
		expect(fx.ghLog()).toBe("");
	});

	it("setRepos makes no GitHub call and doesn't wait for a read in flight", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			hold: ["home"],
		});
		const { home, config } = service();
		// The viewer, known before the save, as the page knows it.
		await home.view();
		const reading = home.repo("acme", "api");
		const before = fx.ghLog();
		const saved = await home.setRepos(["acme/api", "acme/nowhere"]);
		expect(saved.view.repos).toEqual(["acme/api", "acme/nowhere"]);
		expect(saved.viewer.login).toBe("Octo");
		expect(config.writes.at(-1)?.views[0]?.repos).toEqual([
			"acme/api",
			"acme/nowhere",
		]);
		expect(fx.ghLog()).toBe(before);
		release(fx.path, "home");
		expect((await reading).rows).toHaveLength(8);
	});

	it("a repo GitHub doesn't know answers its own error; the others' rows are untouched", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service({ repos: ["acme/api", "acme/apii"] });
		const view = await load(home);
		expect(repoOf(view, "acme/apii")).toMatchObject({
			rows: [],
			refreshedAt: null,
			error: "Not found on GitHub",
			failures: 1,
		});
		expect(repoOf(view, "acme/api")?.error).toBe(null);
		expect(ids(view, "mine")).toEqual([1]);
	});

	it("a failed read keeps the repo's last rows and says why; failures count up and reset", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home, clock } = service();
		const good = await refresh(home);
		fx.scenario({ rateLimited: true });
		for (let i = 1; i <= 3; i++) {
			clock.now += 60_000;
			const bad = await refresh(home);
			expect(repoOf(bad, "acme/api")).toMatchObject({
				error: expect.stringMatching(/rate limit/i),
				refreshedAt: repoOf(good, "acme/api")?.refreshedAt,
				failures: i,
			});
			expect(bad.sections).toEqual(good.sections);
		}
		fx.scenario({ rateLimited: false });
		clock.now += 60_000;
		const ok = await refresh(home);
		expect(repoOf(ok, "acme/api")).toMatchObject({
			error: null,
			refreshedAt: iso(clock.now),
			failures: 0,
		});
	}, 30_000);

	it("one repo failing keeps its last rows; the others refresh", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: scenarioPrs() },
				"acme/web": {
					prs: [
						homePr({
							repo: "acme/web",
							number: 50,
							author: "Octo",
							updatedAt: iso(T0),
						}),
					],
				},
			},
		});
		const { home } = service({ repos: ["acme/api", "acme/web"] });
		await refresh(home);
		const s = fx.current();
		fx.scenario({
			repos: { "acme/web": s.repos?.["acme/web"] ?? { prs: [] } },
		});
		const view = await refresh(home);
		expect(repoOf(view, "acme/api")?.error).toBe("Not found on GitHub");
		expect(repoOf(view, "acme/web")?.error).toBe(null);
		expect(ids(view, "mine")).toEqual([50, 1]);
	});

	it("a started review in a repo outside the view: no row, no GitHub read of that repo", async () => {
		const outside = homePr({
			repo: "other/tool",
			number: 5,
			author: "carol",
			updatedAt: iso(T0 - H),
		});
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: scenarioPrs() },
				"other/tool": { prs: [outside] },
			},
		});
		const review = (owner: string, repo: string, number: number) => ({
			owner,
			repo,
			number,
			id: `01jb${owner[0]}${String(number).padStart(21, "0")}`,
			pinnedHead: null,
			head: String(number).padStart(40, "0"),
			asOf: null,
			coverage: { done: 37, total: 120, unit: "lines" as const },
			lastActedAt: iso(T0 - 2 * H),
		});
		const started = [
			{ ...review("other", "tool", 5), lastActedAt: iso(T0 - H) },
			review("acme", "api", 3),
		];
		const asked: (ReadonlySet<string> | undefined)[] = [];
		const home = new HomeService({
			config: memoryConfig(["acme/api"]).access,
			started: {
				list: async (_slug, withCoverage) => {
					asked.push(withCoverage);
					return started;
				},
			},
			now: () => T0,
		});
		const view = await refresh(home);
		// Coverage is asked only for the view's repos: none for the view's
		// suggestions, its own for a repo's rows.
		expect(asked.map((s) => [...(s ?? [])])).toEqual([[], ["acme/api"]]);
		// The view dialog's suggestions: every started review's repo, newest first.
		expect(view.startedRepos).toEqual(["other/tool", "acme/api"]);
		const rows = view.sections.flatMap((s) => s.rows);
		expect(rows.filter((r) => r.repo === "tool")).toEqual([]);
		expect(fx.ghLog()).not.toMatch(/other|tool/);
		expect(home.knownPrs().map((p) => p.repo)).not.toContain("tool");
		// One in a view repo still shows, in Reviewing, with its coverage.
		expect(ids(view, "reviewing")).toContain(3);
		expect(row(view, 3)?.reviews).toEqual([
			{
				id: started[1]?.id,
				label: "head",
				pinnedHead: null,
				coverage: started[1]?.coverage,
				lastActedAt: started[1]?.lastActedAt,
				headMoved: false,
			},
		]);
	});

	it("a repo leaving the view takes its started rows at once; back, they and their annotations return", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const started: StartedReview = {
			owner: "acme",
			repo: "api",
			number: 3,
			id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
			pinnedHead: null,
			head: "3".padStart(40, "0"),
			asOf: null,
			coverage: { done: 1, total: 2, unit: "lines" },
			lastActedAt: iso(T0 - H),
		};
		const { home, config } = service({ started: [started] });
		await refresh(home);
		await home.annotate("acme", "api", 3, { op: "note", text: "after lunch" });
		const setView = (repos: string[]) =>
			config.access.update((c) => ({
				...c,
				views: [{ name: "My PRs", repos }],
			}));
		await setView([]);
		// Before any refresh: the view reads the config.
		expect(row(await load(home), 3)).toBeUndefined();
		const out = await refresh(home);
		expect(row(out, 3)).toBeUndefined();
		// Its facts go too, started or not: search and annotate don't see them.
		expect(home.knownPrs()).toEqual([]);
		// Not served either: the page drops its query.
		await expect(home.repo("acme", "api")).rejects.toBeInstanceOf(
			NotOnHomeError,
		);
		// A chip to add it back.
		expect(out.startedRepos).toEqual(["acme/api"]);
		await setView(["acme/api"]);
		const back = await refresh(home);
		expect(ids(back, "reviewing")).toContain(3);
		expect(row(back, 3)?.reviews).toHaveLength(1);
		expect(row(back, 3)?.annotations.note).toBe("after lunch");
	});

	it("puts the viewer's turn first in each section, then newest activity", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: [
						// Mine: bob's turn (newer), then mine to request a reviewer (8).
						homePr({
							repo: "acme/api",
							number: 24,
							author: "Octo",
							requested: ["bob"],
							updatedAt: iso(T0 - 1 * H),
						}),
						homePr({
							repo: "acme/api",
							number: 23,
							author: "Octo",
							updatedAt: iso(T0 - 5 * H),
						}),
						// Reviewing: the viewer reviewed last, alice's turn (newer);
						// a review asked of the viewer (older).
						homePr({
							repo: "acme/api",
							number: 21,
							author: "alice",
							reviews: [{ login: "Octo", at: iso(T0 - 1 * H) }],
							updatedAt: iso(T0 - 1 * H),
						}),
						homePr({
							repo: "acme/api",
							number: 22,
							author: "alice",
							requested: ["octo"],
							updatedAt: iso(T0 - 6 * H),
						}),
					],
				},
			},
		});
		const { home } = service();
		const view = await refresh(home);
		expect(ids(view, "mine")).toEqual([23, 24]);
		expect(ids(view, "reviewing")).toEqual([22, 21]);
	});

	it("several started reviews of one PR: sub-rows, newest activity first", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": {
					prs: [
						homePr({
							repo: "acme/api",
							number: 3,
							author: "alice",
							updatedAt: iso(T0),
						}),
					],
				},
			},
		});
		const base = {
			owner: "acme",
			repo: "api",
			number: 3,
			asOf: null,
			coverage: { done: 1, total: 2, unit: "clusters" as const },
		};
		const started: StartedReview[] = [
			{
				...base,
				id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
				pinnedHead: null,
				// The PR moved on since this patch set.
				head: "e".repeat(40),
				lastActedAt: iso(T0 - 3 * H),
			},
			{
				...base,
				id: "01jbbbbbbbbbbbbbbbbbbbbbbb",
				pinnedHead: "abcdef1234567890abcdef1234567890abcdef12",
				head: "3".padStart(40, "0"),
				lastActedAt: iso(T0 - H),
			},
		];
		const view = await refresh(service({ started }).home);
		expect(
			row(view, 3)?.reviews.map((r) => [r.label, r.pinnedHead, r.headMoved]),
		).toEqual([
			["abcdef1", "abcdef1234567890abcdef1234567890abcdef12", false],
			["head", null, true],
		]);
	});

	it("snooze hides, Wake up shows; activity wakes it after a refresh, with the badge", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: T0 };
		const { home } = service({ clock });
		await refresh(home);
		const snoozed = await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(T0 + 2 * DAY),
			wakeOnActivity: true,
		});
		expect(snoozed).toMatchObject({ number: 3, hidden: "snoozed" });
		expect(snoozed.annotations.snooze?.wakeOnActivity).toBe(true);
		// Stamped by the service's clock, not the machine's: no test drifts
		// with today's date.
		expect(snoozed.annotations.snooze?.at).toBe(iso(T0));
		expect(row(await load(home), 3)?.hidden).toBe("snoozed");
		const woken = await home.annotate("acme", "api", 3, { op: "wake" });
		expect(woken).toMatchObject({ hidden: null, woke: null, annotations: {} });

		const again = await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(T0 + 2 * DAY),
			wakeOnActivity: true,
		});
		const at = Date.parse(again.annotations.snooze?.at ?? "");
		// Within FRESH_MS: the cache answers, the activity isn't read yet.
		clock.now = T0 + 1000;
		bumpHomePr(fx.path, "acme/api", 3, iso(at + 60_000), "bob");
		expect(row(await load(home), 3)?.hidden).toBe("snoozed");
		const after = await refresh(home);
		expect(row(after, 3)?.hidden).toBe(null);
		expect(row(after, 3)?.woke?.by).toBe("activity");
	});

	it("a snooze whose date passes wakes on the next view, no refresh needed", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: Date.now() };
		const { home } = service({ clock });
		await refresh(home);
		await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(clock.now + H),
			wakeOnActivity: false,
		});
		expect(row(await load(home), 3)?.hidden).toBe("snoozed");
		clock.now += H;
		const view = await load(home);
		expect(row(view, 3)).toMatchObject({ hidden: null, woke: { by: "time" } });
	});

	it("waiting on someone overrides the turn and clears on their activity", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: Date.now() };
		const { home } = service({ clock });
		await refresh(home);
		const waiting = await home.annotate("acme", "api", 4, {
			op: "wait",
			who: "tomer",
		});
		expect(waiting).toMatchObject({
			hidden: "waiting",
			turn: { kind: "people", logins: ["tomer"] },
		});
		const me = await home.annotate("acme", "api", 9, {
			op: "wait",
			who: "octo",
		});
		expect(me).toMatchObject({
			hidden: null,
			turn: { kind: "people", logins: ["Octo"] },
		});
		bumpHomePr(fx.path, "acme/api", 4, iso(clock.now + 60_000), "carol");
		clock.now += 2 * 60_000;
		expect(row(await refresh(home), 4)?.hidden).toBe("waiting");
		bumpHomePr(fx.path, "acme/api", 4, iso(clock.now + 60_000), "Tomer");
		clock.now += 2 * 60_000;
		const view = await refresh(home);
		expect(row(view, 4)).toMatchObject({
			hidden: null,
			woke: { by: "activity" },
		});
		// Its wait over, the facts' turn shows again.
		expect(row(view, 4)?.turn).toEqual({ kind: "people", logins: ["bob"] });
	});

	it("a note shows on the row; an empty one clears it", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service();
		await refresh(home);
		expect(
			(
				await home.annotate("acme", "api", 2, {
					op: "note",
					text: "awaiting Tomer",
				})
			).annotations,
		).toEqual({
			note: "awaiting Tomer",
		});
		expect(
			(await home.annotate("acme", "api", 2, { op: "note", text: "" }))
				.annotations,
		).toEqual({});
	});

	it("annotating a PR Home doesn't list is refused", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service();
		await refresh(home);
		await expect(
			home.annotate("acme", "api", 404, { op: "wake" }),
		).rejects.toThrow(/not on Home/);
	});

	it("setRepos writes the first view (lowercased, deduplicated, URLs taken)", async () => {
		fx = createHomeFixture({
			repos: {
				"acme/api": { prs: scenarioPrs() },
				"acme/web": {
					prs: [
						homePr({
							repo: "acme/web",
							number: 50,
							author: "Octo",
							updatedAt: iso(T0),
						}),
					],
				},
			},
		});
		const { home, config } = service({ repos: [] });
		const view = await home.setRepos([
			"Acme/Web",
			"https://github.com/acme/api",
			"acme/web",
		]);
		expect(config.writes.at(-1)?.views[0]?.repos).toEqual([
			"acme/web",
			"acme/api",
		]);
		expect(view.view.repos).toEqual(["acme/web", "acme/api"]);
		expect(ids(await load(home), "mine")).toEqual([50, 1]);
		await expect(home.setRepos(["no-slash"])).rejects.toThrow(/owner\/repo/);
	});

	it("teams unknown: a team's request lands in Other open", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			viewerTeams: null,
		});
		const view = await refresh(service().home);
		expect(ids(view, "grabs")).toEqual([9, 3]);
		expect(ids(view, "other")).toEqual([4, 8]);
	});
});

describe("HomeService, fix round 1", () => {
	it("a PR whose details GitHub didn't give keeps its row, and the error says so, without backoff", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: T0 };
		const { home } = service({ clock });
		await refresh(home);
		bumpHomePr(fx.path, "acme/api", 3, iso(T0 + 1000), "bob");
		fx.scenario({ homeDetailsNull: { "acme/api": [3] } });
		clock.now = T0 + 2000;
		const view = await refresh(home);
		expect(row(view, 3)).toBeDefined();
		expect(repoOf(view, "acme/api")?.error).toMatch(/acme\/api#3/);
		expect(repoOf(view, "acme/api")?.failures).toBe(0);
	});

	it("a PR the list skipped (pages shifted) keeps its row", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service();
		await refresh(home);
		fx.scenario({ homeListSkip: { "acme/api": [3, 4] } });
		const view = await refresh(home);
		expect(row(view, 3)).toBeDefined();
		expect(row(view, 4)).toBeDefined();
		expect(repoOf(view, "acme/api")?.error).toBe(null);
	});

	it("a missing repo keeps failing on its own; the other's reads go on", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service({ repos: ["acme/api", "acme/apii"] });
		for (let i = 1; i <= 3; i++) {
			const view = await refresh(home);
			expect(repoOf(view, "acme/apii")?.failures).toBe(i);
			expect(repoOf(view, "acme/api")?.failures).toBe(0);
			expect(ids(view, "mine")).toEqual([1]);
		}
	});

	it("GET works when the login can't be read: the reason, no rows, no throw", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			loggedOut: true,
		});
		const { home } = service();
		const view = await refresh(home);
		expect(view.viewerError).toMatch(/gh auth login|not logged in/i);
		expect(view.viewer.login).toBe("");
		expect(repoOf(view, "acme/api")).toMatchObject({
			rows: [],
			error: expect.stringMatching(/gh auth login|not logged in/i),
			failures: 1,
		});
		// Logged in again: the viewer and rows come back.
		fx.scenario({ loggedOut: false });
		const ok = await refresh(home);
		expect(ok.viewer.login).toBe("Octo");
		expect(ids(ok, "mine")).toEqual([1]);
	});

	it("a wait shows in the turn under a snooze too", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service({ clock: { now: Date.now() } });
		await refresh(home);
		await home.annotate("acme", "api", 4, { op: "wait", who: "tomer" });
		const r = await home.annotate("acme", "api", 4, {
			op: "snooze",
			until: iso(Date.now() + DAY),
			wakeOnActivity: false,
		});
		expect(r.hidden).toBe("snoozed");
		expect(r.turn).toEqual({ kind: "people", logins: ["tomer"] });
	});

	it("a repo leaving the view takes its rows and search entries with it; case doesn't matter", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home, config } = service({ repos: ["Acme/API"] });
		const view = await refresh(home);
		expect(ids(view, "mine")).toEqual([1]);
		await config.access.update((c) => ({
			...c,
			views: [{ name: "My PRs", repos: [] }],
		}));
		await refresh(home);
		expect(home.knownPrs()).toEqual([]);
	});
});

describe("HomeService, final round", () => {
	it("every read lists the started reviews again: coverage and newly started PRs are current without a refresh", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const review = (number: number, done: number): StartedReview => ({
			owner: "acme",
			repo: "api",
			number,
			asOf: null,
			id: `01jb${String(number).padStart(22, "0")}`,
			pinnedHead: null,
			head: String(number).padStart(40, "0"),
			lastActedAt: iso(T0 - H),
			coverage: { done, total: 120, unit: "lines" },
		});
		let list = [review(3, 120)];
		const config = memoryConfig(["acme/api"]);
		const home = new HomeService({
			config: config.access,
			started: { list: async () => list },
			now: () => T0,
		});
		const first = await refresh(home);
		expect(row(first, 3)?.reviews[0]?.coverage.done).toBe(120);
		// Two clusters marked unreviewed again, and PR 4 started: no refresh.
		list = [review(3, 100), review(4, 1)];
		const next = await load(home);
		expect(row(next, 3)?.reviews[0]?.coverage.done).toBe(100);
		expect(row(next, 4)?.reviews).toHaveLength(1);
		expect(ids(next, "reviewing")).toContain(4);
	});
});

describe("configAccess", () => {
	it("changes Home's parts and keeps the rest of crb's config", async () => {
		type Crb = HomeConfig & { serve: { host: string; port: number } };
		let c: Crb = {
			serve: { host: "h", port: 1 },
			views: [],
			refresh: { minutes: 2 },
		};
		const access = configAccess<Crb>(
			async () => ({ config: c, problems: ["p"] }),
			async (change) => {
				c = change(c);
				return c;
			},
		);
		await access.update((h) => ({
			...h,
			views: [{ name: "My PRs", repos: ["a/b"] }],
		}));
		expect(c).toEqual({
			serve: { host: "h", port: 1 },
			views: [{ name: "My PRs", repos: ["a/b"] }],
			refresh: { minutes: 2 },
		});
		expect((await access.read()).problems).toEqual(["p"]);
	});
});

describe("HomeService, review round 1", () => {
	it("a repo taken out during its first read keeps what that read brings: back in, no cold read", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			hold: ["home:acme/api"],
		});
		const { home } = service();
		await home.view();
		const reading = home.repo("acme", "api");
		await expect.poll(() => listReads(fx?.ghLog() ?? "")).toEqual(["api"]);
		await home.setRepos([]);
		release(fx.path, "home:acme/api");
		await reading;
		await home.setRepos(["acme/api"]);
		const back = await home.repo("acme", "api");
		expect(back.rows).toHaveLength(8);
		// Answered from what the first read brought: no second read.
		expect(listReads(fx.ghLog())).toEqual(["api"]);
	});

	it("a save keeps saying why the viewer can't be read", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			loggedOut: true,
		});
		const { home } = service();
		expect((await home.view()).viewerError).toMatch(
			/gh auth login|not logged in/i,
		);
		const saved = await home.setRepos(["acme/api"]);
		expect(saved.viewerError).toMatch(/gh auth login|not logged in/i);
	});

	it("a repo's answer lists only that repo's clone for started reviews", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const only: (string | undefined)[] = [];
		const home = new HomeService({
			config: memoryConfig(["acme/api"]).access,
			started: {
				list: async (_slug, _coverage, repo) => {
					only.push(repo);
					return [];
				},
			},
			now: () => T0,
		});
		await home.view();
		await home.repo("acme", "api");
		expect(only).toEqual([undefined, "acme/api"]);
	});

	it("a failing repo is read less often whoever asks: the cache period doubles per failure; fresh still reads", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			rateLimited: true,
		});
		const { home, clock } = service({ minutes: 2 });
		await home.repo("acme", "api");
		clock.now += 2 * 60_000;
		// Retry: a fresh read, failing again.
		expect((await home.repo("acme", "api", { fresh: true })).failures).toBe(2);
		expect(listReads(fx.ghLog())).toHaveLength(2);
		// Two failures: 2 min × 4 = 8 min. A focus or another device asking
		// meanwhile gets the cache.
		const read = clock.now;
		clock.now = read + 2 * 60_000;
		await home.repo("acme", "api");
		clock.now = read + 8 * 60_000 - 1;
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toHaveLength(2);
		clock.now = read + 8 * 60_000;
		await home.repo("acme", "api");
		expect(listReads(fx.ghLog())).toHaveLength(3);
		// Retry reads at once.
		await home.repo("acme", "api", { fresh: true });
		expect(listReads(fx.ghLog())).toHaveLength(4);
	});
});
