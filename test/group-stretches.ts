import type { HunkItems, LinePair } from "../src/shared/hunkPairs";
import type { DiffLine } from "../src/shared/types";

/**
 * A random stretch (removed lines, then added ones) with random items over
 * it, as hunkItems could give them: pairs and groups (splits and joins,
 * runs of 2–5), never crossing, each line in one at most, with gaps of
 * unpaired lines between. For the layout properties (pairOrder.test.ts,
 * sideBySide.test.ts): the lines' texts mean nothing.
 */
export function stretchWithItems(
	rand: (n: number) => number,
	key = "k",
): { dels: DiffLine[]; adds: DiffLine[]; items: HunkItems } {
	const dels: DiffLine[] = [];
	const adds: DiffLine[] = [];
	const items: HunkItems = { pairs: [], groups: [] };
	const d = (): DiffLine => {
		const l: DiffLine = {
			kind: "del",
			oldNo: dels.length + 1,
			text: `d${dels.length + 1}`,
			clusterKey: key,
		};
		dels.push(l);
		return l;
	};
	const a = (): DiffLine => {
		const l: DiffLine = {
			kind: "add",
			newNo: adds.length + 1,
			text: `a${adds.length + 1}`,
			clusterKey: key,
		};
		adds.push(l);
		return l;
	};
	const steps = rand(5);
	for (let s = 0; s < steps; s++) {
		for (let i = rand(3); i > 0; i--) d();
		for (let i = rand(3); i > 0; i--) a();
		const kind = rand(4);
		if (kind === 1) items.pairs.push([d(), a()] as LinePair);
		else if (kind === 2) {
			const one = d();
			const run = Array.from({ length: 2 + rand(4) }, a);
			items.groups.push({ one, run });
		} else if (kind === 3) {
			const run = Array.from({ length: 2 + rand(4) }, d);
			items.groups.push({ one: a(), run });
		}
	}
	for (let i = rand(3); i > 0; i--) d();
	for (let i = rand(3); i > 0; i--) a();
	return { dels, adds, items };
}

/** A seeded `rand(n)`: 0 ≤ result < n. */
export function seeded(seed: number): (n: number) => number {
	let s = seed;
	return (n: number) => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return (s >>> 8) % n;
	};
}
