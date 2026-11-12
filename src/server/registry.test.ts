import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acpLog, releaseAcp, useFakeAcp } from "../../test/fake-acp/scenario";
import { prView } from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { parseAsOf } from "./asOf";
import {
	RefusedReviewError,
	SessionRegistry,
	UnknownReviewError,
} from "./registry";

// The reopens' lookups of a review by id, in order.
const lookups = vi.hoisted(() => [] as string[]);
vi.mock("./review/reviews.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./review/reviews.js")>();
	return {
		...real,
		findReviewById: (...args: Parameters<typeof real.findReviewById>) => {
			lookups.push(args[1]);
			return real.findReviewById(...args);
		},
	};
});

describe("SessionRegistry", () => {
	let pr: PrFixture;
	const registries: SessionRegistry[] = [];
	const registry = (
		options?: ConstructorParameters<typeof SessionRegistry>[0],
	) => {
		const r = new SessionRegistry(options);
		registries.push(r);
		return r;
	};

	beforeEach(() => {
		pr = createPrFixture();
		// The PR's commits, for --head to pick from.
		pr.scenario({
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						commits: [
							{
								commit: {
									oid: pr.head(),
									committedDate: "2026-01-02T10:00:00Z",
									pushedDate: null,
								},
							},
						],
					},
				},
			},
		});
	});
	afterEach(async () => {
		await Promise.all(registries.splice(0).map((r) => r.closeAll()));
		await pr.cleanup();
	});

	it("opening a PR twice gives the same review and one session", async () => {
		const r = registry();
		const progress: string[] = [];
		const first = await r.open({ pr: pr.arg }, (m) => progress.push(m));
		expect(first.id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
		expect(progress).toContain("cloning acme/widget…");
		const again = await r.open({ pr: pr.arg });
		expect(again.id).toBe(first.id);
		expect(again.session).toBe(first.session);
		expect(await r.get(first.id)).toBe(first.session);
	});

	it(
		"open spawns nothing; Spawn returns before the agent has answered initialize, and it starts after",
		async () => {
			const fake = useFakeAcp(pr.repo.path, {
				agent: { name: "fake-acp", version: "1.0.0" },
				hold: ["initialize"],
			});
			try {
				const { session } = await registry().open({ pr: pr.arg });
				const host = session.agent;
				if (!host) throw new Error("no agent");
				// Configured, but no Spawn in this review: nothing starts.
				expect((await host.status()).state).toBe("off");
				expect(acpLog(fake.log).filter((e) => e.method === "spawn")).toEqual(
					[],
				);
				await host.startAcp();
				// Held: Spawn did not wait for the handshake.
				await vi.waitFor(
					async () => expect((await host.status()).state).toBe("starting"),
					{ timeout: 20_000, interval: 20 },
				);
				releaseAcp(fake.scenario, "initialize");
				await vi.waitFor(
					async () => expect((await host.status()).state).toBe("ready"),
					{ timeout: 20_000, interval: 20 },
				);
				expect(
					acpLog(fake.log).filter((e) => e.method === "initialize"),
				).toHaveLength(1);
			} finally {
				await Promise.all(registries.splice(0).map((r) => r.closeAll()));
				fake.restore();
			}
			// Real git, gh and agent processes: see GIT_TEST_TIMEOUTS.
		},
		GIT_TEST_TIMEOUTS.testTimeout,
	);

	it("concurrent opens of one PR share one session", async () => {
		const r = registry();
		const [a, b] = await Promise.all([
			r.open({ pr: pr.arg }),
			r.open({ pr: "https://github.com/acme/widget/pull/12" }),
		]);
		expect(a.id).toBe(b.id);
		expect(a.session).toBe(b.session);
	});

	it("a pinned head and an as-of view are reviews of their own", async () => {
		const r = registry();
		const plain = await r.open({ pr: pr.arg });
		const pinned = await r.open({
			pr: pr.arg,
			head: { kind: "sha", prefix: pr.head().slice(0, 7) },
		});
		expect(pinned.id).not.toBe(plain.id);
		expect(pinned.session.info().pinnedHead).toBe(pr.head());
		expect(await r.get(plain.id)).toBe(plain.session);
		expect(await r.get(pinned.id)).toBe(pinned.session);
	});

	it("opens by id after restart, pinned head and all", async () => {
		const before = registry();
		const plain = await before.open({ pr: pr.arg });
		const pinned = await before.open({
			pr: pr.arg,
			head: { kind: "sha", prefix: pr.head() },
		});
		await before.closeAll();
		expect(plain.session.closed).toBe(true);

		const after = registry();
		const reopened = await after.get(plain.id);
		expect(reopened).not.toBe(plain.session);
		expect(reopened.id).toBe(plain.id);
		expect(reopened.info().pr.number).toBe(12);
		const again = await after.get(pinned.id);
		expect(again.id).toBe(pinned.id);
		expect(again.info().pinnedHead).toBe(pr.head());
		// Two gets at once: one session.
		const fresh = registry();
		const [x, y] = await Promise.all([
			fresh.get(plain.id),
			fresh.get(plain.id),
		]);
		expect(x).toBe(y);
		// Five opens of a review: more than the default on a loaded machine.
	}, 20_000);

	it("opens an as-of review by id after restart, as of its cutoff", async () => {
		// After the fixture's commits (made now), so the PR exists then.
		const asOf = parseAsOf(new Date(Date.now() + 60_000).toISOString());
		const before = registry();
		const { id } = await before.open({ pr: pr.arg, asOf });
		await before.closeAll();
		const reopened = await registry().get(id);
		expect(reopened.id).toBe(id);
		expect(reopened.info().asOf).toBe(asOf);
	});

	it("by id, a review its PR now refuses (merged, nothing started) is a RefusedReviewError saying why", async () => {
		const before = registry();
		const { id } = await before.open({ pr: pr.arg });
		await before.closeAll();
		pr.scenario({
			prs: {
				12: {
					view: {
						...prView({ headRefOid: pr.head(), baseRefName: "main" }),
						state: "MERGED",
					},
				},
			},
		});
		const get = registry().get(id);
		await expect(get).rejects.toBeInstanceOf(RefusedReviewError);
		await expect(get).rejects.toThrow(
			"PR acme/widget#12 is already merged; nothing to review",
		);
	});

	it("get answers at once while an idle session is still closing", async () => {
		let now = 1_000_000;
		const r = registry({ idleMs: 60_000, now: () => now });
		const a = await r.open({ pr: pr.arg });
		const b = await r.open({
			pr: pr.arg,
			head: { kind: "sha", prefix: pr.head() },
		});
		now += 30_000;
		await r.get(b.id);
		now += 40_000;
		// a is idle: its close must not hold up the get of b.
		let release = () => {};
		const closing = new Promise<void>((done) => {
			release = done;
		});
		const close = a.session.close.bind(a.session);
		a.session.close = () => closing.then(close);
		try {
			const got = await Promise.race([
				r.get(b.id),
				new Promise((done) => setTimeout(() => done("held up"), 1000)),
			]);
			expect(got).toBe(b.session);
		} finally {
			release();
		}
	});

	it("an unknown id is an UnknownReviewError", async () => {
		const r = registry();
		await expect(r.get("01zzzzzzzzzzzzzzzzzzzzzzzz")).rejects.toBeInstanceOf(
			UnknownReviewError,
		);
		await expect(r.get("not-an-id")).rejects.toBeInstanceOf(UnknownReviewError);
	});

	it("closes a session idle for idleMs; get reopens it", async () => {
		let now = 1_000_000;
		const r = registry({ idleMs: 60_000, now: () => now });
		const { id, session } = await r.open({ pr: pr.arg });
		now += 59_000;
		expect(await r.get(id)).toBe(session);
		// Used just now: another 59 s is still not idle.
		now += 59_000;
		await r.sweep();
		expect(session.closed).toBe(false);
		now += 61_000;
		await r.sweep();
		expect(session.closed).toBe(true);
		const reopened = await r.get(id);
		expect(reopened).not.toBe(session);
		expect(reopened.closed).toBe(false);
	});

	it("peek never opens a review and isn't a use; touch is", async () => {
		let now = 1_000_000;
		const r = registry({ idleMs: 60_000, now: () => now });
		const id = "01k9e6m2q8x4v7c3n5b0h1j2t6";
		lookups.length = 0;
		expect(r.peek(id)).toBeUndefined();
		expect(lookups).toEqual([]);
		const opened = await r.open({ pr: pr.arg });
		now += 59_000;
		expect(r.peek(opened.id)).toBe(opened.session);
		now += 2_000;
		await r.sweep();
		// Peeked 2 s ago, opened 61 s ago: idle all the same.
		expect(opened.session.closed).toBe(true);
		expect(r.peek(opened.id)).toBeUndefined();
		const again = await r.get(opened.id);
		now += 59_000;
		r.touch(opened.id);
		now += 2_000;
		await r.sweep();
		expect(again.closed).toBe(false);
		r.touch("01k9e6m2q8x4v7c3n5b0h1j2t7");
	});

	it("a review a session asks to join (or is joined to) isn't closed when idle", async () => {
		let now = 1_000_000;
		const r = registry({ idleMs: 60_000, now: () => now });
		const { session } = await r.open({ pr: pr.arg });
		const join = session.agent?.join;
		if (!join) throw new Error("no agent");
		const { request } = join.request({ name: "s", machine: "m" });
		now += 61_000;
		await r.sweep();
		expect(session.closed).toBe(false);
		await join.answer(request, false);
		await r.sweep();
		expect(session.closed).toBe(true);
	});

	it(
		"a reopen of a review waits for its old session's close (the agent claim goes first)",
		async () => {
			let now = 1_000_000;
			const r = registry({ idleMs: 60_000, now: () => now });
			const { id, session } = await r.open({ pr: pr.arg });
			let release: () => void = () => {};
			const held = new Promise<void>((done) => {
				release = done;
			});
			const close = session.close.bind(session);
			vi.spyOn(session, "close").mockImplementation(async () => {
				await held;
				await close();
			});
			now += 61_000;
			const sweeping = r.sweep();
			lookups.length = 0;
			const reopen = r.get(id);
			// The close is held: the reopen hasn't even looked the review up.
			for (let i = 0; i < 50; i++) await Promise.resolve();
			expect(lookups).toEqual([]);
			release();
			await sweeping;
			const reopened = await reopen;
			expect(lookups).toEqual([id]);
			expect(reopened).not.toBe(session);
			expect(reopened.closed).toBe(false);
			// Real git: an open, then a reopen by id (clone, snapshot twice).
		},
		GIT_TEST_TIMEOUTS.testTimeout,
	);

	it("closeAll closes every session", async () => {
		const r = registry();
		const a = await r.open({ pr: pr.arg });
		const b = await r.open({
			pr: pr.arg,
			head: { kind: "sha", prefix: pr.head() },
		});
		await r.closeAll();
		expect(a.session.closed).toBe(true);
		expect(b.session.closed).toBe(true);
	});

	it("a refused open (merged, nothing started) rejects and keeps nothing", async () => {
		pr.scenario({
			prs: {
				12: {
					view: {
						...prView({ headRefOid: pr.head(), baseRefName: "main" }),
						state: "MERGED",
					},
				},
			},
		});
		const r = registry();
		await expect(r.open({ pr: pr.arg })).rejects.toThrow(/already merged/);
	});
});
