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
const gate = vi.hoisted(() => ({ held: null as Promise<void> | null }));
const BEST_EFFORT = /[\\/](seen|rereview)[\\/]/;
vi.mock("./atomicFile", async (original) => {
	const real = await original<typeof import("./atomicFile")>();
	return {
		...real,
		writeFileAtomic: vi.fn(
			async (...args: Parameters<typeof real.writeFileAtomic>) => {
				if (BEST_EFFORT.test(args[0])) await gate.held;
				return real.writeFileAtomic(...args);
			},
		),
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
});
