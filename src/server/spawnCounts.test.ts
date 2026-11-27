import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import {
	countTable,
	measureOpen,
	type StepCount,
} from "../../test/spawn-count";
import { seedStartedReviews } from "../../test/started-seed";

// Real git and fake-gh processes: see GIT_TEST_TIMEOUTS; a whole open three times.
vi.setConfig({ ...GIT_TEST_TIMEOUTS, testTimeout: 240_000 });

/*
 * CAR-320: the git and gh processes behind opening and reading a review
 * don't grow with the PR (files, threads) or the review (patch sets). Each
 * costs ~90 ms to start on Windows. `pnpm spawn-counts` prints the table
 * (CRB_SPAWN_TABLE=<files>x<threads>).
 */

const byStep = (steps: StepCount[]) =>
	Object.fromEntries(steps.map((s) => [s.step, s.shapes.length]));

const table = process.env.CRB_SPAWN_TABLE;

describe.runIf(table)("spawn counts table", () => {
	it("prints the processes per step", async () => {
		const [files = 40, threads = 15] = (table ?? "")
			.split("x")
			.map((n) => Number(n) || undefined);
		const counts = await measureOpen({ files, threads });
		const text = `${files} files, ${threads} threads, 3 patch sets\n\n${countTable(
			{
				first: counts.first,
				restart: counts.restart,
				reload: counts.reload,
			},
			Boolean(process.env.CRB_SPAWN_CALLS),
		)}\n`;
		const out = process.env.CRB_SPAWN_OUT;
		if (out) writeFileSync(out, text);
		else process.stdout.write(`\n${text}`);
	});
});

describe.skipIf(table)("spawn counts don't grow with the PR", () => {
	// Each thread on a file of its own (a thread sharing a file and a
	// commit with another needs no read of its own), and both sizes with the
	// listed-first ten threads and the rest each on all three commits:
	// GitHub's thread texts come in two reads (those ten, then the rest),
	// the threads' code in a batch for each, per commit.
	it("4x the files and threads: the same processes per step", async () => {
		const small = await measureOpen({ files: 15, threads: 15 });
		const large = await measureOpen({ files: 60, threads: 60 });
		for (const phase of ["first", "restart", "reload"] as const) {
			expect(byStep(large[phase]), phase).toEqual(byStep(small[phase]));
		}
	});
});

describe.skipIf(table)("spawn counts don't grow with other reviews", () => {
	// Principle 3: working on one review doesn't get slower as others pile
	// up. The review's page reads (and Home's view) after a restart, with
	// K and 4K other started reviews of the same reviewer in its clone
	// (CAR-324).
	it("4x the other started reviews in the clone: the same processes per step", async () => {
		const withOthers = (k: number) =>
			measureOpen({ files: 15, threads: 15 }, (clone, slug) => {
				seedStartedReviews(clone, {
					owner: "acme",
					repo: "widget",
					slug,
					k,
					from: 5000,
				});
			});
		const few = await withOthers(10);
		const many = await withOthers(40);
		for (const phase of ["restart", "reload"] as const) {
			expect(byStep(many[phase]), phase).toEqual(byStep(few[phase]));
		}
	});
});
