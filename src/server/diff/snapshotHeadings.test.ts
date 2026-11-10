import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import { buildAllHeadings, type GitHunkHeading } from "./headings.js";
import { buildSnapshot, loadFileHunks } from "./snapshot.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

vi.mock("./headings.js", async (original) => {
	const real = await original<typeof import("./headings.js")>();
	return { ...real, buildAllHeadings: vi.fn(real.buildAllHeadings) };
});
const run = vi.mocked(buildAllHeadings);

const body = (n: number) =>
	Array.from({ length: 12 }, (_, i) => `    x${i} = ${i === 8 ? n : 0}`);
const py = (n: number) =>
	`${["def work():", ...body(n), "    return x0"].join("\n")}\n`;

let fixture: GitFixture;
beforeAll(() => {
	fixture = createGitFixture([
		{ message: "base", files: { "a.py": py(1) } },
		{ message: "head", files: { "a.py": py(2) } },
	]);
});
afterAll(() => fixture.cleanup());

// Each test its own snapshot key: the same repo by another path spelling.
let spelling = 0;
const freshRepo = () => {
	spelling += 1;
	return `${fixture.path}${"/.".repeat(spelling)}`;
};
const snapshotAt = (repo: string) =>
	buildSnapshot(repo, fixture.shas[0] as string, fixture.shas[1] as string);

/** For loads that expect a heading: never cut short by the cap on a busy machine. */
const WAIT = { headingWaitMs: 60_000 };

/** A run that waits for `release()`, then answers as git would. */
function held() {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	run.mockImplementationOnce(async (...args) => {
		await gate;
		const real =
			await vi.importActual<typeof import("./headings.js")>("./headings.js");
		return real.buildAllHeadings(...args) as Promise<GitHunkHeading[][]>;
	});
	return { release };
}

// A block: beforeEach calls a returned function as its cleanup.
beforeEach(() => {
	run.mockClear();
});

describe("the snapshot's heading run", () => {
	it("a failed run: hunks come every time, without headings, from one run", async () => {
		run.mockRejectedValueOnce(new Error("git broke"));
		const repo = freshRepo();
		const snapshot = await snapshotAt(repo);
		for (let i = 0; i < 2; i++) {
			const { hunks } = await loadFileHunks(repo, snapshot, 0);
			expect(hunks).toHaveLength(1);
			expect(hunks[0]).not.toHaveProperty("heading");
		}
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("hunks never wait past the cap for a run that hasn't answered; later loads get its headings", async () => {
		const gate = held();
		const repo = freshRepo();
		const snapshot = await snapshotAt(repo);
		const first = await loadFileHunks(repo, snapshot, 0, {
			headingWaitMs: 0,
		});
		expect(first.hunks[0]).not.toHaveProperty("heading");
		gate.release();
		// Answers count, not time: wait for the released run as long as it takes.
		const later = await loadFileHunks(repo, snapshot, 0, WAIT);
		expect(later.hunks[0]?.heading).toBe("def work():");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("without headings, hunks don't wait for or start a run", async () => {
		const gate = held();
		const repo = freshRepo();
		const snapshot = await snapshotAt(repo);
		run.mockClear();
		// The held run never answers before this resolves.
		const { hunks } = await loadFileHunks(repo, snapshot, 0, {
			headings: false,
			headingWaitMs: 60_000,
		});
		expect(hunks).toHaveLength(1);
		expect(run).not.toHaveBeenCalled();
		gate.release();
	});

	it("keeps the last 8 snapshots' runs: an evicted one runs again", async () => {
		const repos = Array.from({ length: 9 }, freshRepo);
		const snapshots = [];
		for (const repo of repos) snapshots.push(await snapshotAt(repo));
		expect(run).toHaveBeenCalledTimes(9);
		// The newest 8 are cached.
		await loadFileHunks(repos[8] as string, snapshots[8] as never, 0);
		await loadFileHunks(repos[1] as string, snapshots[1] as never, 0);
		expect(run).toHaveBeenCalledTimes(9);
		// The first fell out: one new run, then cached again.
		const { hunks } = await loadFileHunks(
			repos[0] as string,
			snapshots[0] as never,
			0,
			WAIT,
		);
		expect(hunks[0]?.heading).toBe("def work():");
		await loadFileHunks(repos[0] as string, snapshots[0] as never, 0);
		expect(run).toHaveBeenCalledTimes(10);
	});
});
