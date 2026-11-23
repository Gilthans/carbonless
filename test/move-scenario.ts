/**
 * Random files with one block moved, lines edited in place and decoys, for
 * the tracer's property test (src/shared/rereview/placement.test.ts,
 * CAR-95): every thread lands on its true line or nowhere, at today's
 * tuning and at its neighbouring settings.
 */
import fc from "fast-check";
import type { MapHunk } from "../src/shared/tracer/lineMapper.js";

/** A statement of its own words (`id`): unlike every other one. */
const stmt = (id: number) =>
	`\tvalue${id}a := compute${id}b(input${id}c, option${id}d)`;

/** The same statement with one word changed: alike it (0.75). */
const edited = (t: string) => t.replace(/option(\d+)d/u, "setting$1e");

/**
 * Decoys keep this many lines away from the block's old place and from
 * edited lines: near home, a copy and an in-place edit read the same
 * ("copy it, then edit the original": the in-place line is right, a unit
 * test's case), so only far decoys test "never jump to a look-alike".
 */
export const DECOY_DISTANCE = 10;

export interface MoveDraw {
	n: number;
	edits: number[];
	from: number;
	k: number;
	to: number;
	copies: number[];
	second: number | null;
	near: number | null;
}

type Line = {
	text: string;
	/** The old index it was kept from (git's context); null: new. */
	src: number | null;
	/** The old index it carries (kept, edited or moved); null: a decoy. */
	truth: number | null;
	/** A decoy's group (one copy of something). */
	group?: number;
};

/**
 * `n` statements (a `}` every fifth line); `edits` edited in place; a block
 * of `k` lines from `from` moved to `to` (an index among the lines left);
 * decoys: an exact copy of each edited line's old text, a second copy of
 * the moved block, a near-copy of it (each line edited). The new file, its
 * hunks (kept lines in order: a valid -U0 diff), each old line's true new
 * line (absent: gone), and whether the draw is fair (no decoy within
 * DECOY_DISTANCE of home, of an edited or moved line, or of another
 * decoy).
 */
export function moveScenario(o: MoveDraw) {
	const old = Array.from({ length: o.n }, (_, i) =>
		i % 5 === 4 ? "}" : stmt(i),
	);
	const block = new Set(
		Array.from({ length: o.k }, (_, j) => o.from + j).filter((i) => i < o.n),
	);
	const edits = new Set(o.edits.filter((i) => !block.has(i) && old[i] !== "}"));
	const rest: Line[] = [];
	const moved: Line[] = [];
	old.forEach((text, i) => {
		if (block.has(i)) moved.push({ text, src: null, truth: i });
		else if (edits.has(i))
			rest.push({ text: edited(text), src: null, truth: i });
		else rest.push({ text, src: i, truth: i });
	});
	// Where the block was: a marker, dropped below.
	const hole: Line = { text: "", src: null, truth: -1 };
	const firstAfter = rest.findIndex(
		(l) => l.truth !== null && l.truth > o.from,
	);
	rest.splice(firstAfter === -1 ? rest.length : firstAfter, 0, hole);
	const insert = (at: number, lines: Line[]) =>
		rest.splice(Math.min(at, rest.length), 0, ...lines);
	insert(o.to, moved);
	const decoy = (text: string, group: number): Line => ({
		text,
		src: null,
		truth: null,
		group,
	});
	if (o.second !== null)
		insert(
			o.second,
			moved.map((l) => decoy(l.text, 1)),
		);
	if (o.near !== null)
		insert(
			o.near,
			moved.map((l) => decoy(l.text === "}" ? "}" : edited(l.text), 2)),
		);
	[...edits].forEach((i, j) => {
		insert(o.copies[j] ?? 0, [decoy(old[i] as string, 3 + j)]);
	});
	// Fair: every decoy far from home, from what it copies and from other
	// decoys (two copies side by side make a longer block of their own).
	const others = (g: number | undefined) =>
		rest.flatMap((l, j) =>
			l === hole ||
			(l.truth !== null && l.src === null) ||
			(l.truth === null && l.group !== g)
				? [j]
				: [],
		);
	const fair = rest.every(
		(l, j) =>
			l.truth !== null ||
			others(l.group).every((h) => Math.abs(h - j) > DECOY_DISTANCE),
	);
	rest.splice(rest.indexOf(hole), 1);
	const now = rest.map((l) => l.text);
	const truth = new Map<number, number>();
	rest.forEach((l, j) => {
		if (l.truth !== null) truth.set(l.truth + 1, j + 1);
	});
	// Hunks between kept lines (in order: only moved and new lines broke).
	const hunks: MapHunk[] = [];
	let po = 0;
	let pn = 0;
	const kept = rest.flatMap((l, j) =>
		l.src === null ? [] : [[l.src + 1, j + 1] as [number, number]],
	);
	for (const [ko, kn] of [...kept, [old.length + 1, now.length + 1]]) {
		const oc = (ko as number) - po - 1;
		const nc = (kn as number) - pn - 1;
		if (oc > 0 || nc > 0) {
			hunks.push({
				oldStart: oc > 0 ? po + 1 : po,
				oldCount: oc,
				newStart: nc > 0 ? pn + 1 : pn,
				newCount: nc,
			});
		}
		po = ko as number;
		pn = kn as number;
	}
	return { old, now, hunks, truth, fair };
}

/** Draws for moveScenario: room enough for far decoys. */
export const moveDraws: fc.Arbitrary<MoveDraw> = fc
	.integer({ min: 40, max: 90 })
	.chain((n) =>
		fc.record({
			n: fc.constant(n),
			edits: fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), {
				maxLength: 3,
			}),
			from: fc.integer({ min: 0, max: n - 2 }),
			k: fc.integer({ min: 2, max: 5 }),
			to: fc.integer({ min: 0, max: n }),
			copies: fc.array(fc.integer({ min: 0, max: n + 5 }), {
				minLength: 3,
				maxLength: 3,
			}),
			second: fc.option(fc.integer({ min: 0, max: n + 5 })),
			near: fc.option(fc.integer({ min: 0, max: n + 5 })),
		}),
	);
