// Mutation testing of the review-coverage logic (`pnpm mutation`; CAR-263,
// docs/test-profiling.md, "Mutation testing"): Stryker plants small bugs
// (a flipped condition, an off-by-one) in the code that decides what is
// reviewed and unreviewed (CLAUDE.md principle 2) and checks that a unit
// test fails on each. Runs in the test queue (scripts/queue.mjs), so its
// Vitest child runs pass vitest.config.ts's queue guard.
import { availableParallelism } from "node:os";
import { queuedWorkers } from "./scripts/queue-guard.mjs";

// The slot's share of the cores, decided once here and written into this
// run's queue ticket; the child runners then mustn't rewrite it (each loads
// vitest.config.ts, whose queuedWorkers would), so the ticket's path stays
// with this process only. Stryker runs each child with one Vitest worker.
const concurrency = queuedWorkers(availableParallelism()) ?? 1;
delete process.env.CRB_QUEUE_MY_TICKET;

export default {
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "vitest.config.ts", related: false },
	coverageAnalysis: "perTest",
	concurrency,
	// Module-level mutants (constants) would rerun every test file each;
	// the logic under test is in functions.
	ignoreStatic: true,
	// A loaded, shared machine: be generous before calling a mutant a hang.
	timeoutFactor: 3,
	timeoutMS: 20_000,
	// What decides coverage, and only that (I/O around it left out).
	mutate: [
		// The coverage join: clusters from git, states from the reviewer.
		"src/server/review/coverage.ts",
		// Events folded into each cluster's state.
		"src/server/review/fold.ts",
		"src/server/review/splitCarry.ts",
		// Which state changes the store takes (recordStates, carrySplits,
		// sinceMarkOk, checkWritable), not the git ref plumbing.
		"src/server/review/reviews.ts:353-636",
		"src/server/review/reviews.ts:769-818",
		// Carrying marks across pushes: the engine, past its git readers.
		"src/server/rereview/engine.ts:282-1814",
		"src/server/rereview/shape.ts",
		"src/server/rereview/interdiff.ts",
		"src/shared/rereview/carry.ts",
		"src/shared/rereview/overlay.ts",
		// What a unit of review is.
		"src/server/diff/clusters.ts",
		// Marks by lines and pieces, and the counts.
		"src/shared/pieces.ts",
		"src/shared/progress.ts",
		"src/shared/lineRanges.ts",
		// The page: what's left, a file finished, counts and pending marks.
		"src/web/files/fileFinish.ts",
		"src/web/files/since.ts",
		"src/web/files/unit.ts",
		"src/web/files/stateSync.ts:531-614",
	],
	// The unit tests of those files (not the slow end-to-end-ish ones that
	// only pass through them, like session.test.ts).
	testFiles: [
		"src/server/review/{coverage,fold,splitCarry,reviews}.test.ts",
		"src/server/rereview/*.test.ts",
		"src/server/{lineCarry,orphanLines}.test.ts",
		"src/server/diff/{clusters,files,hunks,snapshot}.test.ts",
		"src/shared/{pieces,progress,lineRanges}.test.ts",
		"src/shared/rereview/*.test.ts",
		"src/web/files/{fileFinish,since,unit,stateSync}.test.ts",
		"src/web/files/{useSetStates,sinceView,markable,markable.property}.test.tsx",
	],
	ignorePatterns: [".crb-dev", "test-results", "playwright-report", "reports"],
	reporters: ["clear-text", "progress", "html", "json"],
	htmlReporter: { fileName: "reports/mutation/mutation.html" },
	jsonReporter: { fileName: "reports/mutation/mutation.json" },
	// Stryker rewrites tsconfig.json's out-of-tree paths through the
	// TypeScript JS API, which TypeScript 7 (native) no longer has; ours has
	// none to rewrite, so it is pointed at no file.
	tsconfigFile: "no-tsconfig-to-rewrite.json",
	tempDirName: ".stryker-tmp",
	cleanTempDir: "always",
};
