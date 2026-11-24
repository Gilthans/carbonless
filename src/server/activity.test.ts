import { describe, expect, it } from "vitest";
import { stepLabel, stepText } from "../shared/activity";
import {
	Activity,
	activityOf,
	beginCall,
	beginStep,
	currentActivity,
	join,
	MAX_REQUESTS,
	phase,
	runIn,
	shared,
	trackedRequests,
	trackRequest,
	waitOn,
} from "./activity";

/** A promise and the function that settles it. */
function gate<T = void>() {
	let open: (value: T) => void = () => {};
	let fail: (error: Error) => void = () => {};
	const promise = new Promise<T>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

let ids = 0;
const newId = () => `req-test-${String(++ids).padStart(6, "0")}`;

describe("activity (CAR-296)", () => {
	it("says a request's innermost step: a phase over its calls, else its newest call; nothing once it ends", async () => {
		const id = newId();
		const { activity, done } = trackRequest(id);
		expect(activityOf([id])[id]).toBeNull();
		const inPhase = gate();
		const work = runIn(activity, async () => {
			const endView = beginCall("gh pr view");
			expect(activityOf([id])[id]).toMatchObject({
				name: "gh pr view",
				label: "GitHub: pr view",
			});
			endView();
			await phase("crb: fetch pr", {}, async () => {
				// The phase hides the call under it.
				const endFetch = beginCall("git fetch");
				await inPhase.promise;
				endFetch();
			});
		});
		await Promise.resolve();
		expect(activityOf([id])[id]).toMatchObject({
			name: "crb: fetch pr",
			label: "Fetching the PR",
		});
		inPhase.open();
		await work;
		expect(activityOf([id])[id]).toBeNull();
		expect(activity.size).toBe(0);
		done();
		expect(activityOf([id])).toEqual({ [id]: null });
	});

	it("a step ends on failure too, and once is enough", async () => {
		const activity = new Activity();
		await expect(
			runIn(activity, () =>
				phase("crb: clone", { repo: "acme/widget" }, async () => {
					expect(activity.current()?.label).toBe("Cloning acme/widget…");
					throw new Error("boom");
				}),
			),
		).rejects.toThrow("boom");
		expect(activity.size).toBe(0);
		const end = runIn(activity, () => beginCall("git fetch"));
		end();
		end();
		expect(activity.size).toBe(0);
	});

	it("does nothing outside a tracked request", () => {
		expect(currentActivity()).toBeUndefined();
		const end = beginCall("gh pr view");
		end();
	});

	it("a request waiting on shared work says that work's step, whoever started it", async () => {
		const held = gate<number>();
		const a = trackRequest(newId());
		const b = trackRequest(newId());
		const reqs = [a, b];
		let work: Promise<number> = Promise.resolve(0);
		const first = runIn(a.activity, () => {
			work = shared(async () =>
				phase("crb: home details", { n: 2, of: 5 }, () => held.promise),
			);
			return join(work);
		});
		// Another request joins the same work.
		const second = runIn(b.activity, () => join(work));
		await Promise.resolve();
		for (const r of reqs) {
			expect(r.activity.current()?.label).toBe("GitHub: PR details 2 of 5");
		}
		held.open(7);
		expect(await first).toBe(7);
		expect(await second).toBe(7);
		for (const r of reqs) {
			expect(r.activity.size).toBe(0);
			r.done();
		}
	});

	it("a wait whose work shows nothing reads its own label (Working…), never a stale step", async () => {
		const activity = new Activity();
		const other = new Activity();
		const held = gate();
		const waiting = runIn(activity, () => waitOn(held.promise, () => other));
		expect(activity.current()).toMatchObject({
			name: "crb: working",
			label: "Working…",
		});
		const end = runIn(other, () => beginCall("git fetch"));
		expect(activity.current()?.label).toBe("git fetch");
		end();
		expect(activity.current()?.label).toBe("Working…");
		held.open();
		await waiting;
		expect(activity.current()).toBeNull();
	});

	it("a cycle of waits ends (Working…)", async () => {
		const a = new Activity();
		const b = new Activity();
		const held = gate();
		const one = runIn(a, () => waitOn(held.promise, () => b));
		const two = runIn(b, () => waitOn(held.promise, () => a));
		expect(a.current()?.label).toBe("Working…");
		held.open();
		await Promise.all([one, two]);
	});

	it("keeps at most MAX_REQUESTS requests, the oldest going first", () => {
		const before = trackedRequests();
		const made = Array.from({ length: MAX_REQUESTS + 5 }, () =>
			trackRequest(newId()),
		);
		expect(trackedRequests()).toBe(MAX_REQUESTS);
		for (const r of made) r.done();
		expect(trackedRequests()).toBeLessThanOrEqual(before);
	});

	it("answers only well-formed ids, as own properties", () => {
		const out = activityOf(["__proto__", "bad id!", "constructor-x"]);
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.hasOwn(out, "__proto__")).toBe(true);
		expect(out.__proto__).toBeNull();
		expect(Object.keys(out)).toEqual(["__proto__", "constructor-x"]);
	});

	it("rejects an unknown phase name", async () => {
		await expect(phase("crb: nope", {}, async () => 1)).rejects.toThrow(
			/Not a phase/,
		);
	});

	it("an unknown kind of step never shows an internal name", () => {
		const activity = new Activity();
		runIn(activity, () => beginStep("call", "something internal /tmp/x"));
		expect(activity.current()?.label).toBe("Working…");
	});
});

describe("step labels (CAR-296)", () => {
	it("are crb's words: no paths, OIDs, branches or logins", () => {
		expect(stepLabel("gh pr view")).toBe("GitHub: pr view");
		expect(stepLabel("gh api graphql")).toBe("GitHub: api graphql");
		expect(stepLabel("gh api repos/pulls/N/comments")).toBe(
			"GitHub: api repos/pulls/N/comments",
		);
		expect(stepLabel("gh api repos/branches/feature/secret/protection")).toBe(
			"GitHub: api repos/branches/…/…/protection",
		);
		expect(stepLabel("gh api orgs/acme/members")).toBe(
			"GitHub: api orgs/…/members",
		);
		expect(stepLabel("git fetch")).toBe("git fetch");
		expect(stepLabel("git /home/me/repo")).toBe("Working…");
		expect(stepLabel("crb: clone", { repo: "acme/widget" })).toBe(
			"Cloning acme/widget…",
		);
		expect(stepLabel("crb: clone", { repo: "../etc/passwd" })).toBe(
			"Cloning the repo…",
		);
		expect(stepLabel("crb: home list", { n: 3 })).toBe(
			"GitHub: PR list, page 3",
		);
		expect(stepLabel("constructor")).toBe("Working…");
		expect(stepLabel("__proto__")).toBe("Working…");
	});

	it("show whole seconds once past one", () => {
		expect(stepText({ label: "git fetch", ms: 400 })).toBe("git fetch");
		expect(stepText({ label: "git fetch", ms: 12_900 })).toBe(
			"git fetch · 12s",
		);
	});
});
