/**
 * Random files of functions with lines edited in place, functions and
 * lines deleted, one block moved, and decoys, for the tracer's property
 * test (src/shared/rereview/placement.test.ts, CAR-95): every thread lands
 * on its true line or nowhere, at today's tuning and at its neighbouring
 * settings.
 *
 * Statements share a pool of boilerplate lines (`t.Parallel()`, `ctx :=
 * context.Background()`, ...), so equal lines occur all over the file, as
 * in real code. Decoys are whole new functions put in slots chosen far
 * from every line the edit touched (DECOY_DISTANCE): near home, a copy and
 * an in-place edit read the same ("copy it, then edit the original": the
 * in-place line is right, a unit test's case).
 *
 * Where the tracer's rules make a decoy a real move, its truth says so
 * rather than the decoy being dropped: a deleted function's whole body in
 * new code (its header follows it), lines dropped from a kept function
 * found again as a run that is their whole hunk (an extracted method). A
 * thread then may land there or nowhere. Everything short of that (half
 * the lines, most of them, a boilerplate pair) has no truth: unplaced.
 */
import fc from "fast-check";
import type { MapHunk } from "../src/shared/tracer/lineMapper.js";

/** A statement of its own words (`id`): unlike every other one. */
const stmt = (id: number) =>
	`\tvalue${id}a := compute${id}b(input${id}c, option${id}d)`;

/**
 * The statement edited: one word (alike, 0.75), two words (0.5), or
 * rewritten (`size` 2: nothing alike).
 */
const edited = (t: string, to = "setting", size = 0) => {
	if (size === 2)
		return t.replace(/value(\d+)a := .*/u, `rewritten$1 = other(${to})`);
	const one = t.replace(/option(\d+)d/u, `${to}$1e`);
	return size === 1 ? one.replace(/input(\d+)c/u, `${to}In$1`) : one;
};

/** Lines many functions share. */
const BOILERPLATE = [
	"\tt.Parallel()",
	"\tctx := context.Background()",
	"\tctx, cancel := context.WithTimeout(ctx, defaultTimeout)",
	"\tdefer cancel()",
	"\trequire.NoError(t, err)",
];

export const DECOY_DISTANCE = 8;

export type Decoy =
	| "copy-edited"
	| "copy-function"
	| "boilerplate-function"
	| "function-body"
	| "drop-and-copy"
	| "second-block"
	| "near-block"
	| "block-line";

export interface MoveDraw {
	/** Per function, per body line: a statement (-1) or a boilerplate line. */
	functions: number[][];
	/** Statement lines edited in place (indices among all statement lines). */
	edits: number[];
	/** Per edit: its size (0 one word, 1 two words, 2 rewritten). */
	sizes: number[];
	/** For each edit, whether a neighbouring statement is deleted too. */
	dropNeighbour: boolean[];
	/** Functions deleted whole (indices). */
	deleted: number[];
	/** The moved block: function, first body line, length; target function. */
	move: { fn: number; at: number; k: number; to: number } | null;
	/**
	 * Lines dropped from a kept function (boilerplate too): function, first
	 * body line, how many dropped, how many of them copied into new code.
	 */
	drop: { fn: number; at: number; d: number; c: number } | null;
	/** Decoy kinds to try, in order, each in a far slot when one is left. */
	decoys: Decoy[];
	/** Which slot (index among the far ones) each decoy takes. */
	slots: number[];
}

type Line = {
	text: string;
	/** The old index it was kept from (git's context); null: new. */
	src: number | null;
	/** The old index it carries (kept, edited or moved); null: none. */
	truth: number | null;
	/** Old indices a real move may also carry here (see the file's doc). */
	also?: number[];
	/** It belongs to what the edit touched (home of an edit, move or deletion). */
	home?: boolean;
	/** A line gone (deleted or moved away): kept as a marker until the end. */
	hole?: boolean;
};

let ids = 0;

/**
 * The new file, its -U0 hunks, each old line's acceptable new lines (its
 * true line, and any line a real move may carry it to; absent: none), and
 * the decoys put in.
 */
export function moveScenario(d: MoveDraw) {
	ids = 1000;
	const old: string[] = [];
	const fnOf: number[] = [];
	const statements: number[] = [];
	const bodies: number[][] = [];
	const headers: number[] = [];
	d.functions.forEach((body, f) => {
		headers.push(old.length);
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
	// Lines dropped from a kept function, boilerplate too (not the block's).
	const dropped = new Set<number>();
	const dropSpan: number[] = [];
	// (Not in the moved block's functions: the block landing where lines
	// were dropped, with the same boilerplate, is that line's place again.)
	if (
		d.drop &&
		!deletedFns.has(d.drop.fn) &&
		d.drop.fn !== move?.fn &&
		d.drop.fn !== move?.to
	) {
		const body = bodies[d.drop.fn] ?? [];
		for (let i = 0; i < d.drop.d; i++) {
			const at = body[d.drop.at + i];
			if (at === undefined || block.has(at)) break;
			dropSpan.push(at);
		}
		// Keep one line of the function: it stays (the F1 shape).
		if (dropSpan.length >= body.length)
			dropSpan.length = Math.max(0, body.length - 1);
		for (const at of dropSpan) dropped.add(at);
	}
	const edits = new Map<number, { drop: boolean; size: number }>();
	d.edits.forEach((e, j) => {
		const at = statements[e % Math.max(1, statements.length)];
		if (
			at === undefined ||
			block.has(at) ||
			dropped.has(at) ||
			deletedFns.has(fnOf[at] as number)
		)
			return;
		edits.set(at, { drop: d.dropNeighbour[j] ?? false, size: d.sizes[j] ?? 0 });
	});
	// A dropped neighbour: the next statement line of the same function.
	const neighbourOf = new Map<number, number>();
	for (const [at, e] of edits) {
		if (!e.drop) continue;
		const next = at + 1;
		if (
			fnOf[next] === fnOf[at] &&
			statements.includes(next) &&
			!edits.has(next) &&
			!block.has(next)
		) {
			dropped.add(next);
			neighbourOf.set(at, next);
		}
	}
	const rest: Line[] = [];
	old.forEach((text, i) => {
		const f = fnOf[i] as number;
		if (deletedFns.has(f) || dropped.has(i) || block.has(i)) {
			rest.push({ text: "", src: null, truth: null, home: true, hole: true });
			return;
		}
		const e = edits.get(i);
		if (e) {
			rest.push({
				text: edited(text, "setting", e.size),
				src: null,
				truth: i,
				home: true,
			});
			return;
		}
		rest.push({ text, src: i, truth: i });
	});
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
	const fresh = (text: string, also?: number[]): Line => ({
		text,
		src: null,
		truth: null,
		...(also ? { also } : {}),
	});
	const functionOf = (body: Line[]): Line[] => [
		fresh(`func g${ids++}(t *testing.T) {`),
		...body,
		fresh("}"),
		fresh(""),
	];
	const editedAt = [...edits.keys()];
	const deletedList = [...deletedFns];
	const put: Decoy[] = [];
	d.decoys.forEach((kind, j) => {
		let body: Line[] | null = null;
		const e = editedAt[j % Math.max(1, editedAt.length)];
		const gone = deletedList[j % Math.max(1, deletedList.length)];
		if (kind === "copy-edited" && e !== undefined) {
			body = [fresh(stmt(ids++)), fresh(old[e] as string), fresh(stmt(ids++))];
		} else if (
			kind === "copy-function" &&
			e !== undefined &&
			(edits.get(e)?.size ?? 0) < 2
		) {
			// (Not for a line rewritten beyond likeness: with its dropped
			// neighbour, the copy holds its whole hunk, a real move.)
			// The edited line's function, copied, the line edited another way,
			// with the neighbour its edit dropped (C3); its lines other changes
			// removed left out (with them, the copy holds what those changes
			// removed: a real move, or another decoy kind).
			body = (bodies[fnOf[e] as number] ?? [])
				.filter(
					(i) =>
						i === e ||
						i === neighbourOf.get(e) ||
						(!block.has(i) && !dropped.has(i) && !edits.has(i)),
				)
				.map((i) =>
					fresh(
						i === e ? edited(old[i] as string, "other") : (old[i] as string),
					),
				);
		} else if (kind === "boilerplate-function" && gone !== undefined) {
			// A deleted function's boilerplate lines in unrelated new code.
			const src = (bodies[gone] ?? []).filter((i) => !statements.includes(i));
			if (src.length > 0)
				body = [
					...src.slice(0, 3).map((i) => fresh(old[i] as string)),
					fresh(stmt(ids++)),
				];
		} else if (kind === "function-body" && gone !== undefined) {
			// A deleted function's whole body, in a row in new code: its block
			// moved; the header follows its body.
			const src = bodies[gone] ?? [];
			if (src.length >= 2) {
				const header = headers[gone] as number;
				body = src.map((i, k) =>
					fresh(old[i] as string, k === 0 ? [i, header] : [i]),
				);
			}
		} else if (kind === "drop-and-copy" && dropSpan.length >= 2) {
			// Lines dropped from a kept function, `c` of them copied.
			const c = Math.max(1, Math.min(d.drop?.c ?? 1, dropSpan.length));
			const whole = c === dropSpan.length;
			body = [
				fresh(stmt(ids++)),
				...dropSpan
					.slice(0, c)
					.map((i) => fresh(old[i] as string, whole ? [i] : undefined)),
				fresh(stmt(ids++)),
			];
		} else if (kind === "second-block" && moved.length > 0) {
			body = [
				fresh(stmt(ids++)),
				...moved.map((l) => fresh(l.text)),
				fresh(stmt(ids++)),
			];
		} else if (kind === "near-block" && moved.length > 0) {
			body = [
				fresh(stmt(ids++)),
				...moved.map((l) => fresh(edited(l.text, "near"))),
				fresh(stmt(ids++)),
			];
		} else if (kind === "block-line" && moved.length > 0) {
			body = [
				fresh(stmt(ids++)),
				fresh(moved[0]?.text as string),
				fresh(stmt(ids++)),
			];
		}
		if (!body) return;
		const homes = rest.flatMap((l, i) => (l.home ? [i] : []));
		// Slots: just before a kept function header, far from every home.
		const slots = rest.flatMap((l, i) =>
			l.src !== null &&
			/^func f\d+/u.test(l.text) &&
			homes.every((h) => Math.abs(h - i) > DECOY_DISTANCE)
				? [i]
				: [],
		);
		if (homes.every((h) => rest.length - h > DECOY_DISTANCE))
			slots.push(rest.length);
		if (slots.length === 0) return;
		const at = slots[(d.slots[j] ?? 0) % slots.length] as number;
		const lines = functionOf(body);
		for (const l of lines) l.home = true;
		rest.splice(at, 0, ...lines);
		put.push(kind);
	});
	const kept = rest.filter((l) => !l.hole);
	const now = kept.map((l) => l.text);
	const truth = new Map<number, number[]>();
	kept.forEach((l, j) => {
		if (l.truth !== null) truth.set(l.truth + 1, [j + 1]);
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
	// A deleted function's whole body found in a row among the decoys (a
	// boilerplate decoy that happens to be all of it): its block moved, and
	// its header follows it.
	for (const f of deletedFns) {
		const body = (bodies[f] ?? []).map((i) => old[i] as string);
		if (body.length < 2) continue;
		for (let j = 0; j + body.length <= kept.length; j++) {
			const run = kept.slice(j, j + body.length);
			if (
				run.every(
					(l, k) => l.src === null && l.truth === null && l.text === body[k],
				)
			) {
				(run[0] as Line).also = [
					...((run[0] as Line).also ?? []),
					headers[f] as number,
				];
				run.forEach((l, k) => {
					l.also = [...(l.also ?? []), (bodies[f] ?? [])[k] as number];
				});
			}
		}
	}
	// The dropped lines found together, all of them, among any decoy's
	// lines (another decoy that happens to hold them): an extracted block.
	if (dropSpan.length >= 2) {
		const texts = dropSpan.map((i) => old[i] as string);
		for (let j = 0; j + texts.length <= kept.length; j++) {
			const run = kept.slice(j, j + texts.length);
			if (
				run.every(
					(l, k) => l.src === null && l.truth === null && l.text === texts[k],
				)
			) {
				run.forEach((l, k) => {
					const o = dropSpan[k] as number;
					if (!(l.also ?? []).includes(o)) l.also = [...(l.also ?? []), o];
				});
			}
		}
	}
	// A real move's lines: acceptable too. For lines dropped from a kept
	// function, only when the copy is their whole hunk (an extracted method).
	const hunkOf = (o: number) =>
		hunks.find((h) => o + 1 >= h.oldStart && o + 1 < h.oldStart + h.oldCount);
	kept.forEach((l, j) => {
		for (const o of l.also ?? []) {
			if (dropped.has(o)) {
				const h = hunkOf(o);
				const span = new Set(dropSpan);
				const own =
					h !== undefined &&
					Array.from(
						{ length: h.oldCount },
						(_, k) => h.oldStart - 1 + k,
					).every(
						(i) =>
							span.has(i) ||
							!/\w/u.test(old[i] ?? "") ||
							// Edited in place, alike: its partner stays at home.
							(edits.get(i)?.size ?? 2) < 2,
					);
				if (!own) continue;
			}
			const list = truth.get(o + 1) ?? [];
			list.push(j + 1);
			truth.set(o + 1, list);
		}
	});
	return { old, now, hunks, truth, put };
}

const DECOYS: Decoy[] = [
	"copy-edited",
	"copy-function",
	"boilerplate-function",
	"function-body",
	"drop-and-copy",
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
			sizes: fc.array(fc.nat({ max: 2 }), { minLength: 3, maxLength: 3 }),
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
			drop: fc.option(
				fc.record({
					fn: fc.nat({ max: n - 1 }),
					at: fc.nat({ max: 3 }),
					d: fc.integer({ min: 2, max: 4 }),
					c: fc.integer({ min: 1, max: 4 }),
				}),
			),
			decoys: fc.array(fc.constantFrom(...DECOYS), { maxLength: 4 }),
			slots: fc.array(fc.nat({ max: 20 }), { minLength: 4, maxLength: 4 }),
		});
	});
