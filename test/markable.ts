/*
 * The "every visible cluster is individually markable" invariant
 * (docs/product-rules.md), read off a rendered diff the same way in jsdom
 * (component tests) and on a live page (e2e, through page.evaluate).
 *
 * A unit is a `<tbody>` of the diff that shows a change: a changed row
 * (added, removed, whitespace-only, a side-by-side pair), a collapsed
 * whitespace-only cluster, or a file-level cluster's row (it has the
 * controls). Each unit must have exactly one reviewed checkbox and one
 * cross-off button of its own, enabled (except on an earlier patch set,
 * read-only by design), and using them must change that unit's state and
 * no other's (checked by the callers, which can click).
 *
 * `collectUnits` must stay self-contained (no imports, no helpers outside
 * it): Playwright serialises it into the page.
 */

export type UnitState = "reviewed" | "crossed-off" | "unreviewed";

export interface UnitReport {
	/** Its place among the units, top down (also its `data-markable-unit`). */
	index: number;
	/** What it shows: its first changed line's code, else its text. */
	label: string;
	/** Reviewed checkboxes ("Mark cluster reviewed" / "Undo cross-off"). */
	boxes: number;
	/** Cross-off buttons. */
	crosses: number;
	boxDisabled: boolean;
	crossDisabled: boolean;
	/** The state its checkbox shows; null without one. */
	state: UnitState | null;
	/** A gone block (the compared patch set's). */
	gone: boolean;
}

/** The diff's units under `root`, each tagged `data-markable-unit="<index>"`. */
export function collectUnits(root: Element): UnitReport[] {
	const BOX =
		'input[type="checkbox"][aria-label="Mark cluster reviewed"], input[type="checkbox"][aria-label="Undo cross-off"]';
	const CROSS = 'button[aria-label="Cross off cluster"]';
	const CHANGED =
		'tr[data-testid="diff-line"]:not([data-kind="context"]), tr[data-testid="ws-cluster"]';
	const units: UnitReport[] = [];
	for (const body of Array.from(root.querySelectorAll("tbody"))) {
		const changed = body.querySelector(CHANGED);
		const boxes = Array.from(body.querySelectorAll<HTMLInputElement>(BOX));
		const crosses = Array.from(body.querySelectorAll<HTMLButtonElement>(CROSS));
		if (!changed && boxes.length === 0 && crosses.length === 0) {
			body.removeAttribute("data-markable-unit");
			continue;
		}
		const index = units.length;
		body.setAttribute("data-markable-unit", String(index));
		const box = boxes[0];
		const code = changed
			? Array.from(changed.querySelectorAll('[data-testid="code"]'))
					.map((c) => c.textContent ?? "")
					.join(" | ")
			: "";
		const label = (code || body.textContent || "").trim().slice(0, 80);
		units.push({
			index,
			label,
			boxes: boxes.length,
			crosses: crosses.length,
			boxDisabled: box?.disabled ?? false,
			crossDisabled: crosses[0]?.disabled ?? false,
			state: box
				? box.checked
					? "reviewed"
					: box.indeterminate
						? "crossed-off"
						: "unreviewed"
				: null,
			gone: body.hasAttribute("data-gone"),
		});
	}
	return units;
}

/**
 * What is wrong with the units' controls, one line each (empty: none).
 * `readOnly`: an earlier patch set, where every control is locked.
 */
export function unitProblems(
	units: UnitReport[],
	opts: { readOnly?: boolean } = {},
): string[] {
	const problems: string[] = [];
	for (const u of units) {
		const name = `unit ${u.index} (${JSON.stringify(u.label)}${u.gone ? ", gone" : ""})`;
		if (u.boxes !== 1) problems.push(`${name}: ${u.boxes} reviewed checkboxes`);
		if (u.crosses !== 1)
			problems.push(`${name}: ${u.crosses} cross-off buttons`);
		if (u.boxes === 0) continue;
		if (opts.readOnly) {
			if (!u.boxDisabled) problems.push(`${name}: live checkbox, read-only`);
			if (!u.crossDisabled) problems.push(`${name}: live cross-off, read-only`);
		} else {
			if (u.boxDisabled) problems.push(`${name}: checkbox disabled`);
			// A reviewed cluster is unticked first (R21): its cross-off is off.
			if (u.crossDisabled && u.state !== "reviewed") {
				problems.push(`${name}: cross-off disabled`);
			}
		}
	}
	return problems;
}

/** The units' states, top down. */
export const statesOf = (units: UnitReport[]): (UnitState | null)[] =>
	units.map((u) => u.state);

/**
 * After using unit `index`'s control: what differs from `expected` (the
 * states before, with unit `index` at the state it should now have).
 */
export function isolationProblems(
	index: number,
	before: (UnitState | null)[],
	after: (UnitState | null)[],
	want: UnitState,
): string[] {
	if (after.length !== before.length) {
		return [
			`unit ${index}: the diff had ${before.length} units, then ${after.length}`,
		];
	}
	const problems: string[] = [];
	after.forEach((state, i) => {
		const expected = i === index ? want : before[i];
		if (state !== expected) {
			problems.push(
				`marking unit ${index} ${want} left unit ${i} ${state}, not ${expected}`,
			);
		}
	});
	return problems;
}
