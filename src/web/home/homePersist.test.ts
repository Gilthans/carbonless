// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { newQueryClient } from "../queryClient";
import { leaveHome, repoKey } from "./homeApi";
import {
	HOME_MAX_AGE_MS,
	HOME_STORAGE_KEY,
	persistHome,
	renderAfter,
} from "./homePersist";

const stops: (() => void)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	// A throttled save already timed lands now, not in the next test.
	await new Promise((r) => setTimeout(r, 5));
	sessionStorage.clear();
});

const VIEW = ["home", "view"];
const stored = () => sessionStorage.getItem(HOME_STORAGE_KEY) ?? "";

/** A page's client keeping Home's answers, saves written at once. */
async function page(opts: { restore?: boolean; throttleTime?: number } = {}) {
	const client = newQueryClient();
	stops.push(
		await persistHome(client, {
			storage: sessionStorage,
			throttleTime: 0,
			...opts,
		}),
	);
	return client;
}

const until = async (check: () => boolean) => {
	while (!check()) await new Promise((r) => setTimeout(r, 1));
};

describe("persistHome", () => {
	it("saves Home's answers only, and a new page restores them at their age, stale", async () => {
		const before = await page();
		const at = Date.now() - 60_000;
		before.setQueryData(VIEW, { view: "v" }, { updatedAt: at });
		before.setQueryData(repoKey("acme/api"), { rows: ["r"] });
		// A word no path or key holds: the buster names this file's path, which
		// may contain "review" (a worktree's name).
		before.setQueryData(["session"], { id: "session-sentinel-q7" });
		before.setQueryData(["home-search", "x", "all"], { repos: [] });
		await until(() => stored().includes('"rows"'));
		expect(stored()).not.toContain("session-sentinel-q7");
		expect(stored()).not.toContain("home-search");

		const after = await page();
		expect(after.getQueryState(VIEW)).toMatchObject({
			data: { view: "v" },
			dataUpdatedAt: at,
			isInvalidated: true,
		});
		expect(after.getQueryData(repoKey("acme/api"))).toEqual({ rows: ["r"] });
		expect(after.getQueryData(["session"])).toBeUndefined();
	});

	it("a reload restores nothing and saves anew", async () => {
		const before = await page();
		before.setQueryData(VIEW, { view: "old" });
		await until(() => stored().includes("old"));
		const reloaded = await page({ restore: false });
		expect(reloaded.getQueryData(VIEW)).toBeUndefined();
		reloaded.setQueryData(VIEW, { view: "new" });
		await until(() => stored().includes("new"));
	});

	it("a page without Home's answers never wipes the saved ones", async () => {
		const before = await page();
		before.setQueryData(VIEW, { view: "kept" });
		await until(() => stored().includes("kept"));
		// That page is gone: only the review page's save could write.
		stops.pop()?.();
		const review = await page({ restore: false });
		review.setQueryData(["session"], { id: "review" });
		window.dispatchEvent(new Event("pagehide"));
		await new Promise((r) => setTimeout(r, 5));
		expect(stored()).toContain("kept");
	});

	it("leaving the page saves at once, not after the throttle", async () => {
		const client = await page({ throttleTime: 60_000 });
		client.setQueryData(VIEW, { view: "just in" });
		expect(stored()).not.toContain("just in");
		window.dispatchEvent(new Event("pagehide"));
		expect(stored()).toContain("just in");
	});

	it("a review page's own reads never write Home's unchanged answers again", async () => {
		const home = await page();
		home.setQueryData(VIEW, { view: "v" });
		await until(() => stored().includes('"v"'));
		stops.pop()?.();
		let writes = 0;
		const counted = {
			getItem: (k: string) => sessionStorage.getItem(k),
			setItem: (k: string, v: string) => {
				writes++;
				sessionStorage.setItem(k, v);
			},
			removeItem: (k: string) => sessionStorage.removeItem(k),
		} as Storage;
		const review = newQueryClient();
		stops.push(
			await persistHome(review, { storage: counted, throttleTime: 0 }),
		);
		expect(review.getQueryData(VIEW)).toEqual({ view: "v" });
		// Restored and marked stale: saved once as such.
		await until(() => writes === 1);
		for (let i = 0; i < 5; i++) {
			review.setQueryData(["session"], { id: i });
			review.setQueryData(["files", i], { n: i });
		}
		window.dispatchEvent(new Event("pagehide"));
		await new Promise((r) => setTimeout(r, 5));
		expect(writes).toBe(1);
		// A change of Home's own is saved.
		review.setQueryData(VIEW, { view: "w" });
		await until(() => writes === 2);
		expect(stored()).toContain('"w"');
	});

	it("opening a PR from Home saves at once", async () => {
		const client = await page({ throttleTime: 60_000 });
		client.setQueryData(VIEW, { view: "clicked" });
		expect(stored()).not.toContain("clicked");
		leaveHome();
		expect(stored()).toContain("clicked");
	});

	it("back from the back-forward cache, Home's answers are read again", async () => {
		const client = await page();
		client.setQueryData(VIEW, { view: "v" });
		const shown = (persisted: boolean) => {
			const event = new Event("pageshow");
			Object.defineProperty(event, "persisted", { value: persisted });
			window.dispatchEvent(event);
		};
		shown(false);
		expect(client.getQueryState(VIEW)?.isInvalidated).toBe(false);
		shown(true);
		expect(client.getQueryState(VIEW)?.isInvalidated).toBe(true);
	});

	it("the app renders even when the restore fails", async () => {
		const render = vi.fn();
		await renderAfter(Promise.reject(new Error("boom")), render);
		expect(render).toHaveBeenCalledOnce();
		await renderAfter(Promise.resolve(), render);
		expect(render).toHaveBeenCalledTimes(2);
	});

	it("drops answers another build saved, or too old to show", async () => {
		const save = (over: object) =>
			sessionStorage.setItem(
				HOME_STORAGE_KEY,
				JSON.stringify({
					buster: "another build",
					timestamp: Date.now(),
					clientState: {
						mutations: [],
						queries: [
							{
								queryKey: VIEW,
								queryHash: JSON.stringify(VIEW),
								state: {
									data: { view: 1 },
									dataUpdatedAt: Date.now(),
									status: "success",
									fetchStatus: "idle",
								},
							},
						],
					},
					...over,
				}),
			);
		save({});
		expect((await page()).getQueryData(VIEW)).toBeUndefined();

		// This build's, saved too long ago.
		const ours = await page();
		ours.setQueryData(VIEW, { view: 1 });
		await until(() => stored().includes('"view":1'));
		const { buster } = JSON.parse(stored());
		save({ buster, timestamp: Date.now() - HOME_MAX_AGE_MS - 1 });
		expect((await page()).getQueryData(VIEW)).toBeUndefined();
		// The same, fresh: restored.
		save({ buster });
		expect((await page()).getQueryData(VIEW)).toEqual({ view: 1 });
	});

	it("storage that's unreadable or blocked restores nothing and never throws", async () => {
		sessionStorage.setItem(HOME_STORAGE_KEY, "not json");
		const garbled = await page();
		expect(garbled.getQueryCache().getAll()).toHaveLength(0);

		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		} as unknown as Storage;
		const client = newQueryClient();
		const stop = persistHome(client, { storage: blocked, throttleTime: 0 });
		await expect(stop).resolves.toBeTypeOf("function");
		stops.push(await stop);
		client.setQueryData(VIEW, { view: 1 });
		expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow();
	});
});
