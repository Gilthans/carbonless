/**
 * Relative CPU checks (CLAUDE.md: a speed property is measured in CPU time,
 * against a reference measured in the same test). An absolute budget holds
 * on the machine it was measured on and fails on a slower or contended CPU
 * (a CI runner); a ratio to a reference run in the same test, in turn with
 * it, moves much less, because both slow down together (CAR-115, CAR-67).
 *
 * A scaling check runs the input 4x as large against four runs of the
 * quarter: the same work in all, so linear is about 1x and quadratic 4x.
 * Their limit of 2 sits between the two: the ratios measured 0.77–1.23 on
 * the dev machine, idle and with a busy loop per core (CAR-67), and a
 * quadratic step put back (one pass per file) measured 4.6x.
 */

/** CPU µs (user + system) this thread spends in `run`. */
export function cpuOf(run: () => void): number {
	const before = process.threadCpuUsage();
	run();
	const spent = process.threadCpuUsage(before);
	return spent.user + spent.system;
}

/** As `cpuOf`, for work that awaits (only this thread's CPU counts). */
export async function cpuOfAsync(run: () => Promise<unknown>): Promise<number> {
	const before = process.threadCpuUsage();
	await run();
	const spent = process.threadCpuUsage(before);
	return spent.user + spent.system;
}

export type CpuRatio = {
	/** Best CPU µs of `run`. */
	best: number;
	/** Best CPU µs of `reference`. */
	ref: number;
	/** `best / ref`. */
	ratio: number;
};

/**
 * The least CPU µs a measured side of `bestCpuRatio` spends: below a few
 * milliseconds the clock's grain and one interruption decide the ratio.
 */
const MIN_SIDE_MICROS = 20_000;

/**
 * CPU of `run` against `reference`, after a warm-up of each: the best of
 * `rounds` (load only adds time), the two taken in turn so they see the
 * same load. A cheap pair runs both the same number of times over, until
 * the reference takes `MIN_SIDE_MICROS`; `best` and `ref` are then of that
 * many runs.
 */
export function bestCpuRatio(
	run: () => void,
	reference: () => void,
	rounds = 5,
): CpuRatio {
	run();
	let times = 1;
	while (cpuOf(repeat(times, reference)) < MIN_SIDE_MICROS) times *= 2;
	const runs = repeat(times, run);
	const references = repeat(times, reference);
	let best = Number.POSITIVE_INFINITY;
	let ref = Number.POSITIVE_INFINITY;
	for (let round = 0; round < rounds; round++) {
		best = Math.min(best, cpuOf(runs));
		ref = Math.min(ref, cpuOf(references));
	}
	return { best, ref, ratio: best / ref };
}

/** As `bestCpuRatio`, for work that awaits. */
export async function bestCpuRatioAsync(
	run: () => Promise<unknown>,
	reference: () => Promise<unknown>,
	rounds = 5,
): Promise<CpuRatio> {
	await run();
	await reference();
	let best = Number.POSITIVE_INFINITY;
	let ref = Number.POSITIVE_INFINITY;
	for (let round = 0; round < rounds; round++) {
		best = Math.min(best, await cpuOfAsync(run));
		ref = Math.min(ref, await cpuOfAsync(reference));
	}
	return { best, ref, ratio: best / ref };
}

/** `body`, `times` times over. */
export const repeat = (times: number, body: () => void) => () => {
	for (let i = 0; i < times; i++) body();
};
