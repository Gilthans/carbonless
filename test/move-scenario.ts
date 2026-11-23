/**
 * Random files of functions with lines edited in place, functions and
 * lines deleted, one block moved, and decoys, for the tracer's property
 * test (src/shared/rereview/placement.test.ts, CAR-95): every thread lands
 * on its true line or nowhere, at today's tuning and at its neighbouring
 * settings.
 *
 * Statements share a pool of boilerplate lines (`t.Parallel()`, `ctx :=
 * context.Background()`, `if err != nil {` ...), so equal lines occur all
 * over the file, as in real code. Decoys are whole new functions put in
 * slots chosen far from every line the edit touched (DECOY_DISTANCE):
 * near home, a copy and an in-place edit read the same ("copy it, then
 * edit the original": the in-place line is right, a unit test's case).
 */
import fc from "fast-check";
import type { MapHunk } from "../src/shared/tracer/lineMapper.js";

/** A statement of its own words (`id`): unlike every other one. */
const stmt = (id: number) =>
	`\tvalue${id}a := compute${id}b(input${id}c, option${id}d)`;

/** The same statement with one word changed: alike it (0.75). */
const edited = (t: string, to = "setting") =>
	t.replace(/option(\d+)d/u, `${to}$1e`);

/** Lines many functions share. */
const BOILERPLATE = [
	"\tt.Parallel()",
	"\tctx := context.Background()",
	"\tctx, cancel := context.WithTimeout(ctx, defaultTimeout)",
	"\tdefer cancel()",
	"\trequire.NoError(t, err)",
];

export const DECOY_DISTANCE = 8;

export interface MoveDraw {
	/** Per function, per body line: a statement (-1) or a boilerplate line. */
	functions: number[][];
	/** Statement lines edited in place (indices among all statement lines). */
	edits: number[];
	/** For each edit, whether a neighbouring statement is deleted too. */
	dropNeighbour: boolean[];
	/** Functions deleted whole (indices). */
	deleted: number[];
	/** The moved block: function, first body line, length; target function. */
	move: { fn: number; at: number; k: number; to: number } | null;
	/** Decoy kinds to try, in order, each in a far slot when one is left. */
	decoys: Decoy[];
	/** Which slot (index among the far ones) each decoy takes. */
	slots: number[];
}

type Decoy =
	| "copy-edited"
	| "copy-function"
	| "boilerplate-function"
	| "second-block"
	| "near-block"
	| "block-line";

type Line = {
	text: string;
	/** The old index it was kept from (git's context); null: new. */
	src: number | null;
	/** The old index it carries (kept, edited or moved); null: none. */
	truth: number | null;
	/** It belongs to what the edit touched (home of an edit, move or deletion). */
	home?: boolean;
	/** A line gone (deleted or moved away): kept as a marker until the end. */
	hole?: boolean;
};

let ids = 0;

/** The new file, its -U0 hunks, each old line's true new line (absent: gone). */
export function moveScenario(d: MoveDraw) {
	ids = 1000;
	const old: string[] = [];
	const fnOf: number[] = [];
	const statements: number[] = [];
	const bodies: number[][] = [];
	d.functions.forEach((body, f) => {
		old.push(`func f${f}(t *testing.T) {`);
		fnOf.push(f);
		const lines: number[] = [];
		body.forEach((b) => {
			if (b < 0) {
				statements.push(old.length);
				old.push(stmt(old.length));
			} else old.push(BOILERPLATE[b % BOILERPLATE.length] as string);
			lines.push(old.length - 1);
			fnOf.push(f);
		});
		bodies.push(lines);
		old.push("}", "");
		fnOf.push(f, f);
	});
	const deletedFns = new Set(d.deleted.filter((f) => f < d.functions.length));
	const move =
		d.move && !deletedFns.has(d.move.fn) && !deletedFns.has(d.move.to)
			? d.move
			: null;
	const block = new Set<number>();
	if (move) {
		const body = bodies[move.fn] ?? [];
		for (let i = 0; i < move.k; i++) {
			const at = body[move.at + i];
			if (at !== undefined) block.add(at);
		}
		if (block.size < 2) block.clear();
	}
	const edits = new Map<number, boolean>();
	d.edits.forEach((e, j) => {
		const at = statements[e % Math.max(1, statements.length)];
		if (at === undefined || block.has(at) || deletedFns.has(fnOf[at] as number))
			return;
		edits.set(at, d.dropNeighbour[j] ?? false);
	});
	// A dropped neighbour: the next statement line of the same function.
	const dropped = new Set<number>();
	for (const [at, drop] of edits) {
		if (!drop) continue;
		const next = at + 1;
		if (
			fnOf[next] === fnOf[at] &&
			statements.includes(next) &&
			!edits.has(next) &&
			!block.has(next)
		)
			dropped.add(next);
	}
	const rest: Line[] = [];
	old.forEach((text, i) => {
		const f = fnOf[i] as number;
		if (deletedFns.has(f) || dropped.has(i)) {
			rest.push({ text: "", src: null, truth: null, home: true, hole: true });
			return;
		}
		if (block.has(i)) {
			rest.push({ text: "", src: null, truth: null, home: true, hole: true });
			return;
		}
		if (edits.has(i)) {
			rest.push({ text: edited(text), src: null, truth: i, home: true });
			return;
		}
		rest.push({ text, src: i, truth: i });
	});
	// Holes (deleted, dropped, moved away) stay as markers until the end.
	const moved: Line[] = [...block]
		.sort((a, b) => a - b)
		.map((i) => ({ text: old[i] as string, src: null, truth: i, home: true }));
	if (move && moved.length > 0) {
		// Into the target function's body, after its header.
		const header = rest.findIndex(
			(l) => l.src !== null && l.text === `func f${move.to}(t *testing.T) {`,
		);
		if (header !== -1) rest.splice(header + 1, 0, ...moved);
		else moved.length = 0;
	}
	// Decoys: whole new functions in far slots (between functions).
	const functionOf = (body: string[]): Line[] => [
		{ text: `func g${ids++}(t *testing.T) {`, src: null, truth: null },
		...body.map((text) => ({ text, src: null, truth: null })),
		{ text: "}", src: null, truth: null },
		{ text: "", src: null, truth: null },
	];
	const editedAt = [...edits.keys()];
	const deletedBodies = [...deletedFns].map((f) => bodies[f] ?? []);
	d.decoys.forEach((kind, j) => {
		let body: string[] | null = null;
		const e = editedAt[j % Math.max(1, editedAt.length)];
		if (kind === "copy-edited" && e !== undefined) {
			body = [stmt(ids++), old[e] as string, stmt(ids++)];
		} else if (kind === "copy-function" && e !== undefined) {
			// The edited line's function, copied, the line edited another way
			// (a moved block's lines left out: a copy of them is second-block).
			body = (bodies[fnOf[e] as number] ?? [])
				.filter((i) => !block.has(i))
				.map((i) =>
					i === e ? edited(old[i] as string, "other") : (old[i] as string),
				);
		} else if (kind === "boilerplate-function") {
			// A deleted function's boilerplate pair in unrelated new code, the
			// pair no more than half its lines (more: its body did move).
			const src = deletedBodies[j % Math.max(1, deletedBodies.length)] ?? [];
			const pair = src.filter((i) => !statements.includes(i)).slice(0, 2);
			if (pair.length > 0 && pair.length * 2 <= src.length + 1)
				body = [...pair.map((i) => old[i] as string), stmt(ids++), stmt(ids++)];
		} else if (kind === "second-block" && moved.length > 0) {
			body = [stmt(ids++), ...moved.map((l) => l.text), stmt(ids++)];
		} else if (kind === "near-block" && moved.length > 0) {
			body = [
				stmt(ids++),
				...moved.map((l) => edited(l.text, "near")),
				stmt(ids++),
			];
		} else if (kind === "block-line" && moved.length > 0) {
			body = [stmt(ids++), moved[0]?.text as string, stmt(ids++)];
		}
		if (!body) return;
		// A decoy holding, in a row, most of a deleted function (its header
		// counted) is that function moved, not a decoy (CAR-95: a block that
		// carries most of its hunk moves).
		const decoy = body;
		const carriesDeleted = deletedBodies.some((b) => {
			const texts = b.map((i) => old[i] as string);
			for (let from = 0; from < texts.length; from++) {
				for (let to = from + 1; to <= texts.length; to++) {
					if ((to - from) * 2 <= texts.length + 1) continue;
					const run = texts.slice(from, to);
					for (let at = 0; at + run.length <= decoy.length; at++) {
						if (run.every((t, i) => decoy[at + i] === t)) return true;
					}
				}
			}
			return false;
		});
		if (carriesDeleted) return;
		const homes = rest.flatMap((l, i) => (l.home ? [i] : []));
		// Slots: just before a kept function header, far from every home.
		const slots = rest.flatMap((l, i) =>
			l.src !== null &&
			/^func f\d+/u.test(l.text) &&
			homes.every((h) => Math.abs(h - i) > DECOY_DISTANCE)
				? [i]
				: [],
		);
		slots.push(rest.length);
		const at = slots[(d.slots[j] ?? 0) % slots.length] as number;
		if (
			at === rest.length &&
			homes.some((h) => rest.length - h <= DECOY_DISTANCE)
		)
			return;
		const lines = functionOf(body);
		for (const l of lines) l.home = true;
		rest.splice(at, 0, ...lines);
	});
	const kept = rest.filter((l) => !l.hole);
	const now = kept.map((l) => l.text);
	const truth = new Map<number, number>();
	kept.forEach((l, j) => {
		if (l.truth !== null) truth.set(l.truth + 1, j + 1);
	});
	// Hunks between kept lines (in order: only moved and new lines broke).
	const hunks: MapHunk[] = [];
	let po = 0;
	let pn = 0;
	const pairs = kept.flatMap((l, j) =>
		l.src === null ? [] : [[l.src + 1, j + 1] as [number, number]],
	);
	for (const [ko, kn] of [...pairs, [old.length + 1, now.length + 1]]) {
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
	return { old, now, hunks, truth };
}

const DECOYS: Decoy[] = [
	"copy-edited",
	"copy-function",
	"boilerplate-function",
	"second-block",
	"near-block",
	"block-line",
];

/** Draws for moveScenario: every draw is used (no rejection). */
export const moveDraws: fc.Arbitrary<MoveDraw> = fc
	.array(
		fc.array(
			fc.oneof(
				{ weight: 3, arbitrary: fc.constant(-1) },
				{ weight: 2, arbitrary: fc.nat({ max: BOILERPLATE.length - 1 }) },
			),
			{ minLength: 2, maxLength: 6 },
		),
		{ minLength: 6, maxLength: 14 },
	)
	.chain((functions) => {
		const n = functions.length;
		return fc.record({
			functions: fc.constant(functions),
			edits: fc.uniqueArray(fc.nat({ max: 60 }), { maxLength: 3 }),
			dropNeighbour: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
			deleted: fc.uniqueArray(fc.nat({ max: n - 1 }), { maxLength: 2 }),
			move: fc.option(
				fc.record({
					fn: fc.nat({ max: n - 1 }),
					at: fc.nat({ max: 4 }),
					k: fc.integer({ min: 2, max: 4 }),
					to: fc.nat({ max: n - 1 }),
				}),
			),
			decoys: fc.array(fc.constantFrom(...DECOYS), { maxLength: 4 }),
			slots: fc.array(fc.nat({ max: 20 }), { minLength: 4, maxLength: 4 }),
		});
	});
