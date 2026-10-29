import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpHomePr, homePr } from "../../../test/fake-gh/scenario";
import {
	createHomeFixture,
	type HomeFixture,
} from "../../../test/home-fixture";
import type { HomeView, SectionId } from "../../shared/home.js";
import type { StartedReview } from "./facts.js";
import {
	configAccess,
	type HomeConfig,
	HomeService,
	MAX_BACKOFF_MS,
} from "./homeService.js";

// Each fake gh call is a node process: give a loaded machine time.
vi.setConfig({ testTimeout: 30_000 });

const T0 = Date.parse("2026-10-29T12:00:00Z");
const H = 3_600_000;
const DAY = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();

let fx: HomeFixture | undefined;
afterEach(() => {
	fx?.cleanup();
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
	} = {},
) {
	const clock = opts.clock ?? { now: T0 };
	const config = memoryConfig(opts.repos ?? ["acme/api"]);
	const started = { list: async () => opts.started ?? [] };
	const home = new HomeService({
		config: config.access,
		started,
		now: () => clock.now,
	});
	return { home, clock, config };
}

const ids = (view: HomeView, id: SectionId) =>
	view.sections.find((s) => s.id === id)?.rows.map((r) => r.number);
const row = (view: HomeView, n: number) =>
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
		const view = await home.refresh();
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
		expect(ids(view, "reviewing")).toEqual([2, 8]);
		expect(ids(view, "grabs")).toEqual([9, 3]);
		expect(ids(view, "other")).toEqual([4]);
		expect(ids(view, "closed")).toEqual([5, 6]);
		expect(view.refreshedAt).toBe(iso(T0));
		expect(view.refreshError).toBe(null);
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
		const view = await service().home.refresh();
		expect(ids(view, "mine")).toHaveLength(25);
	});

	it("before any refresh: the viewer, empty sections, no time", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home } = service();
		const view = await home.view();
		expect(view.refreshedAt).toBe(null);
		expect(view.sections.every((s) => s.rows.length === 0)).toBe(true);
		expect(view.sections).toHaveLength(5);
	});

	it("single flight: a refresh in flight is joined, never started twice", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			homeDelayMs: 300,
		});
		const { home } = service();
		const [a, b] = await Promise.all([home.refresh(), home.refresh()]);
		expect(a).toEqual(b);
		const lists = fx
			.ghLog()
			.split("\n")
			.filter((l) => l.includes("open: pullRequests"));
		expect(lists).toHaveLength(1);
	});

	it("a failed refresh keeps the last rows and says why; backoff doubles to 30 min, resets", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const { home, clock } = service();
		const good = await home.refresh();
		expect(home.nextDelayMs()).toBe(2 * 60_000);
		fx.scenario({ rateLimited: true });
		const delays: number[] = [];
		for (let i = 0; i < 6; i++) {
			clock.now += 60_000;
			const bad = await home.refresh();
			expect(bad.refreshError).toMatch(/rate limit/i);
			expect(bad.refreshedAt).toBe(good.refreshedAt);
			expect(bad.sections).toEqual(good.sections);
			delays.push(home.nextDelayMs());
		}
		expect(delays).toEqual([4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
		expect(MAX_BACKOFF_MS).toBe(30 * 60_000);
		fx.scenario({ rateLimited: false });
		clock.now += 60_000;
		const ok = await home.refresh();
		expect(ok.refreshError).toBe(null);
		expect(ok.refreshedAt).toBe(iso(clock.now));
		expect(home.nextDelayMs()).toBe(2 * 60_000);
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
		await home.refresh();
		const s = fx.current();
		fx.scenario({
			repos: { "acme/web": s.repos?.["acme/web"] ?? { prs: [] } },
		});
		const view = await home.refresh();
		expect(view.refreshError).toMatch(/acme\/api/);
		expect(ids(view, "mine")).toEqual([50, 1]);
	});

	it("started PRs outside the view show, refreshed until 3 days after closing", async () => {
		const outside = homePr({
			repo: "other/tool",
			number: 5,
			author: "carol",
			updatedAt: iso(T0 - H),
		});
		fx = createHomeFixture({
			repos: { "acme/api": { prs: [] }, "other/tool": { prs: [outside] } },
		});
		const started: StartedReview = {
			owner: "other",
			repo: "tool",
			number: 5,
			id: "01jbaaaaaaaaaaaaaaaaaaaaaa",
			pinnedHead: null,
			asOf: null,
			coverage: { done: 37, total: 120, unit: "lines" },
			lastActedAt: iso(T0 - 2 * H),
		};
		const clock = { now: T0 };
		const { home } = service({ started: [started], clock });
		let view = await home.refresh();
		expect(ids(view, "reviewing")).toEqual([5]);
		expect(row(view, 5)?.reviews).toEqual([
			{
				id: started.id,
				label: "head",
				pinnedHead: null,
				coverage: started.coverage,
				lastActedAt: started.lastActedAt,
			},
		]);
		const merged = homePr({
			repo: "other/tool",
			number: 5,
			author: "carol",
			state: "MERGED",
			closedAt: iso(T0 + H),
		});
		fx.scenario({
			repos: { "acme/api": { prs: [] }, "other/tool": { prs: [merged] } },
		});
		clock.now = T0 + 2 * H;
		view = await home.refresh();
		expect(ids(view, "closed")).toEqual([5]);
		expect(row(view, 5)?.openable).toBe(true);
		const detailCalls = () =>
			fx
				?.ghLog()
				.split("\n")
				.filter((l) => l.includes("other")).length ?? 0;
		clock.now = T0 + 4 * DAY;
		const before = detailCalls();
		view = await home.refresh();
		expect(ids(view, "closed")).toEqual([]);
		await home.refresh();
		// Read once more to learn it's past 3 days, then no more.
		expect(detailCalls() - before).toBeLessThanOrEqual(1);
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
				lastActedAt: iso(T0 - 3 * H),
			},
			{
				...base,
				id: "01jbbbbbbbbbbbbbbbbbbbbbbb",
				pinnedHead: "abcdef1234567890abcdef1234567890abcdef12",
				lastActedAt: iso(T0 - H),
			},
		];
		const view = await service({ started }).home.refresh();
		expect(row(view, 3)?.reviews.map((r) => [r.label, r.pinnedHead])).toEqual([
			["abcdef1", "abcdef1234567890abcdef1234567890abcdef12"],
			["head", null],
		]);
	});

	it("snooze hides, Wake up shows; activity wakes it after a refresh, with the badge", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: T0 };
		const { home } = service({ clock });
		await home.refresh();
		const snoozed = await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(T0 + 2 * DAY),
			wakeOnActivity: true,
		});
		expect(snoozed).toMatchObject({ number: 3, hidden: "snoozed" });
		expect(snoozed.annotations.snooze?.wakeOnActivity).toBe(true);
		expect(row(await home.view(), 3)?.hidden).toBe("snoozed");
		const woken = await home.annotate("acme", "api", 3, { op: "wake" });
		expect(woken).toMatchObject({ hidden: null, woke: null, annotations: {} });

		const again = await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(T0 + 2 * DAY),
			wakeOnActivity: true,
		});
		const at = Date.parse(again.annotations.snooze?.at ?? "");
		clock.now = T0 + H;
		bumpHomePr(fx.path, "acme/api", 3, iso(at + 60_000), "bob");
		expect(row(await home.view(), 3)?.hidden).toBe("snoozed");
		const after = await home.refresh();
		expect(row(after, 3)?.hidden).toBe(null);
		expect(row(after, 3)?.woke?.by).toBe("activity");
	});

	it("a snooze whose date passes wakes on the next view, no refresh needed", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: Date.now() };
		const { home } = service({ clock });
		await home.refresh();
		await home.annotate("acme", "api", 3, {
			op: "snooze",
			until: iso(clock.now + H),
			wakeOnActivity: false,
		});
		expect(row(await home.view(), 3)?.hidden).toBe("snoozed");
		clock.now += H;
		const view = await home.view();
		expect(row(view, 3)).toMatchObject({ hidden: null, woke: { by: "time" } });
	});

	it("waiting on someone overrides the turn and clears on their activity", async () => {
		fx = createHomeFixture({ repos: { "acme/api": { prs: scenarioPrs() } } });
		const clock = { now: Date.now() };
		const { home } = service({ clock });
		await home.refresh();
		const waiting = await home.annotate("acme", "api", 4, {
			op: "wait",
			who: "tomer",
		});
		expect(waiting).toMatchObject({
			hidden: "waiting",
			turn: { kind: "people", logins: ["tomer"] },
		});
		const me = await home.annotate("acme", "api", 9, { op: "wait", who: "me" });
		expect(me).toMatchObject({
			hidden: null,
			turn: { kind: "people", logins: ["Octo"] },
		});
		bumpHomePr(fx.path, "acme/api", 4, iso(clock.now + 60_000), "carol");
		clock.now += 2 * 60_000;
		expect(row(await home.refresh(), 4)?.hidden).toBe("waiting");
		bumpHomePr(fx.path, "acme/api", 4, iso(clock.now + 60_000), "Tomer");
		clock.now += 2 * 60_000;
		const view = await home.refresh();
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
		await home.refresh();
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
		await home.refresh();
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
		expect(ids(view, "mine")).toEqual([50, 1]);
		await expect(home.setRepos(["no-slash"])).rejects.toThrow(/owner\/repo/);
	});

	it("teams unknown: a team's request lands in Other open", async () => {
		fx = createHomeFixture({
			repos: { "acme/api": { prs: scenarioPrs() } },
			viewerTeams: null,
		});
		const view = await service().home.refresh();
		expect(ids(view, "other")).toEqual([4, 8]);
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
