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
 * quadratic step put back (one pass per file) measured 4.6x. CI is
 * noisier: caretAfterTyping, markdownEscape and colorPieces (2.5) and the
 * editorconfig globs (2.25) read 1.76-1.88 there over 78 runs, before the
 * sides were sized warm, and take a wider limit, each between CI's noise
 * and a probe's quadratic (CAR-188; the readings are in each test's
 * comment). The others keep 2. Where linear itself reads well above 1x
 * (more rows cost more each, in memory), the check grows to 8x, so the
 * limit can sit between them with room on both sides (placeOrphans:
 * limit 3, CAR-300).
 */

/** CPU µs (user + system) this thread spends in `run`. */
export function cpuOf(run: () => void): number {
	const before = process.threadCpuUsage();
	run();
	const spent = process.threadCpuUsage(before);
	return spent.user + spent.system;
}

/** As `cpuOf`, for work that awaits (only this thread's CPU counts). */
async function cpuOfAsync(run: () => Promise<unknown>): Promise<number> {
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
	/** How many runs `best` and `ref` are each of (the floor's repeats). */
	times: number;
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
 * the warm reference takes `MIN_SIDE_MICROS` (the less of two reads: one
 * slowed by load would size it too small); `best` and `ref` are then of
 * that many runs. Sized on a cold first run instead, a reference sped up
 * once warm ran under the floor: CI read a 2.06x ratio of 22.7 ms to 11.0 ms
 * where its other runs read 0.84-1.6x (CAR-188).
 */
export function bestCpuRatio(
	run: () => void,
	reference: () => void,
	rounds = 5,
): CpuRatio {
	run();
	reference();
	let times = 1;
	const sized = () =>
		Math.min(cpuOf(repeat(times, reference)), cpuOf(repeat(times, reference)));
	while (sized() < MIN_SIDE_MICROS) times *= 2;
	const runs = repeat(times, run);
	const references = repeat(times, reference);
	let best = Number.POSITIVE_INFINITY;
	let ref = Number.POSITIVE_INFINITY;
	for (let round = 0; round < rounds; round++) {
		best = Math.min(best, cpuOf(runs));
		ref = Math.min(ref, cpuOf(references));
	}
	return { best, ref, ratio: best / ref, times };
}

/** As `bestCpuRatio` (sized the same way), for work that awaits. */
export async function bestCpuRatioAsync(
	run: () => Promise<unknown>,
	reference: () => Promise<unknown>,
	rounds = 5,
): Promise<CpuRatio> {
	await run();
	await reference();
	let times = 1;
	const sized = async () =>
		Math.min(
			await cpuOfAsync(repeatAsync(times, reference)),
			await cpuOfAsync(repeatAsync(times, reference)),
		);
	while ((await sized()) < MIN_SIDE_MICROS) times *= 2;
	const runs = repeatAsync(times, run);
	const references = repeatAsync(times, reference);
	let best = Number.POSITIVE_INFINITY;
	let ref = Number.POSITIVE_INFINITY;
	for (let round = 0; round < rounds; round++) {
		best = Math.min(best, await cpuOfAsync(runs));
		ref = Math.min(ref, await cpuOfAsync(references));
	}
	return { best, ref, ratio: best / ref, times };
}

/** `body`, `times` times over, one after the other. */
const repeatAsync =
	(times: number, body: () => Promise<unknown>) => async () => {
		for (let i = 0; i < times; i++) await body();
	};

/** `body`, `times` times over. */
export const repeat = (times: number, body: () => void) => () => {
	for (let i = 0; i < times; i++) body();
};
