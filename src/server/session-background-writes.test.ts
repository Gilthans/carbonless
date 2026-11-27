import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { writeFileAtomic } from "./atomicFile";
import { Session } from "./session";

/**
 * While `held`, the atomic writes of best-effort notes (the seen head, the
 * re-review cache) wait for it, as a busy file on Windows can hold one for
 * seconds (CAR-181). Every other write goes through.
 */
const gate = vi.hoisted(() => ({
	held: null as Promise<void> | null,
	/** The writes `held` holds, by path. */
	holds: /[\\/](seen|rereview)[\\/]/,
	/** While set, a finished trace waits for it before it returns. */
	trace: null as Promise<void> | null,
	/** Traces that finished (and may be waiting for `trace`). */
	traced: 0,
}));
vi.mock("./atomicFile", async (original) => {
	const real = await original<typeof import("./atomicFile")>();
	return {
		...real,
		writeFileAtomic: vi.fn(
			async (...args: Parameters<typeof real.writeFileAtomic>) => {
				if (gate.holds.test(args[0])) await gate.held;
				return real.writeFileAtomic(...args);
			},
		),
	};
});

vi.mock("./rereview/engine", async (original) => {
	const engine = await original<typeof import("./rereview/engine")>();
	return {
		...engine,
		traceRereview: async (...args: Parameters<typeof engine.traceRereview>) => {
			const traced = await engine.traceRereview(...args);
			gate.traced++;
			await gate.trace;
			return traced;
		},
	};
});

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const heldWrites = (kind: "seen" | "rereview") =>
	vi
		.mocked(writeFileAtomic)
		.mock.calls.filter(([path]) =>
			new RegExp(`[\\\\/]${kind}[\\\\/]`).test(path),
		);

describe("best-effort saves never hold an answer (CAR-181)", () => {
	let pr: PrFixture;
	let release = () => {};

	beforeEach(() => {
		pr = createPrFixture();
		gate.held = new Promise((r) => {
			release = r;
		});
		vi.mocked(writeFileAtomic).mockClear();
	});
	afterEach(async () => {
		release();
		gate.held = null;
		gate.trace = null;
		gate.traced = 0;
		gate.holds = /[\\/](seen|rereview)[\\/]/;
		await pr.cleanup();
	});

	it("a review opens while its seen note's write is held", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		expect(s.info().snapshotHead).toBe(pr.head());
		expect(heldWrites("seen")).toHaveLength(1);
	});

	it("the re-review answer comes while its cache write is held", async () => {
		const s = await Session.open(pr.arg, process.cwd());
		const key = s.snapshot().files[0]?.clusters[0]?.key;
		if (!key) throw new Error("no cluster");
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		await s.checkHead();
		for (;;) {
			const answer = await s.rereview(1, { head: newHead });
			if (!("pending" in answer)) {
				expect(answer).toMatchObject({ from: 1, toHead: newHead });
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(heldWrites("rereview")).toHaveLength(1);
	});

	it("close waits for a cache write a re-review job starts while it closes", async () => {
		// Only the cache: the seen note's write goes through.
		gate.holds = /[\\/]rereview[\\/]/;
		const s = await Session.open(pr.arg, process.cwd());
		const key = s.snapshot().files[0]?.clusters[0]?.key;
		if (!key) throw new Error("no cluster");
		await s.setStates(s.snapshot().revision, [{ key, state: "reviewed" }]);
		const newHead = pr.moveHead({ "later.txt": "later\n" });
		await s.checkHead();
		let endTrace = () => {};
		gate.trace = new Promise((r) => {
			endTrace = r;
		});
		expect(await s.rereview(1, { head: newHead })).toEqual({ pending: true });
		// Past every abort check: the trace is done, only its return waits.
		await vi.waitFor(() => expect(gate.traced).toBe(1), { timeout: 30_000 });
		let closed = false;
		const closing = s.close().then(() => {
			closed = true;
		});
		// The trace ends after close began; its cache write is held.
		endTrace();
		await vi.waitFor(() => expect(heldWrites("rereview")).toHaveLength(1));
		// Turns enough for the job, and a close that didn't wait, to end.
		for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
		expect(closed).toBe(false);
		release();
		await closing;
		expect(closed).toBe(true);
	});
});
