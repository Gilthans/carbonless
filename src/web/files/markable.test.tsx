// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectUnits,
	isolationProblems,
	statesOf,
	type UnitState,
	unitProblems,
} from "../../../test/markable";
import { MarkableDiff, type MarkStore } from "../../../test/markable-harness";
import { sincePieces } from "../../shared/pieces";
import type { ClusterView, DiffLine, FileHunks } from "../../shared/types";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { READ_ONLY_TIP, UNTICK_TO_CROSS } from "./DiffBody";
import { GoneFile } from "./FileDiff";
import type { KindEntry } from "./since";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * The invariant (docs/product-rules.md, "Every visible cluster is
 * individually markable"): in every view, every unit that shows a change
 * has its own reviewed checkbox and cross-off button; using one changes
 * that unit's state and no other's, and the state is there again after a
 * remount. Run over a table of synthetic diffs in both views, unified and
 * side by side, with "Ignore whitespace" off and on, wide and phone.
 */

type Spec =
	| ["ctx", string]
	| ["del", string, string?]
	| ["add", string, string?]
	| ["del-nl", string, string?]
	| ["add-nl", string, string?];

/** One hunk from a top-down list of lines, numbered from line 1. */
function hunkOf(spec: Spec[]): FileHunks {
	let oldNo = 1;
	let newNo = 1;
	const lines: DiffLine[] = spec.map(([kind, text, key]) => {
		const keyed = key === undefined ? {} : { clusterKey: key };
		if (kind === "ctx") {
			return { kind: "context", oldNo: oldNo++, newNo: newNo++, text };
		}
		const noNewline = kind.endsWith("-nl") ? { noNewline: true } : {};
		if (kind.startsWith("del")) {
			return { kind: "del", oldNo: oldNo++, text, ...keyed, ...noNewline };
		}
		return { kind: "add", newNo: newNo++, text, ...keyed, ...noNewline };
	});
	return {
		newLineCount: newNo - 1,
		hunks: [
			{
				oldStart: 1,
				oldCount: oldNo - 1,
				newStart: 1,
				newCount: newNo - 1,
				lines,
			},
		],
	};
}

const NO_HUNKS: FileHunks = { hunks: [], newLineCount: 0 };

const lines = (key: string, over: Partial<ClusterView> = {}): ClusterView => ({
	key,
	kind: "lines",
	oldStart: 1,
	oldCount: 1,
	newStart: 1,
	newCount: 1,
	removed: [],
	added: [],
	lines: 2,
	state: "unreviewed",
	...over,
});

const fileLevel = (key: string, label: string): ClusterView => ({
	key,
	kind: "file",
	label,
	oldStart: 0,
	oldCount: 0,
	newStart: 0,
	newCount: 0,
	removed: [],
	added: [],
	lines: 0,
	state: "unreviewed",
});

interface Case {
	name: string;
	clusters: ClusterView[];
	hunks: FileHunks;
	/** The since view: from PS1, with these kinds (its pieces: sincePieces). */
	kinds?: Map<string, KindEntry>;
}

const kindsOf = (entries: [string, KindEntry["kind"]][]) =>
	new Map<string, KindEntry>(
		entries.map(([key, kind]) => [
			key,
			kind === "gone" || kind === "carried"
				? { key, kind, from: 1 }
				: { key, kind },
		]),
	);

const FULL: Case[] = [
	{
		name: "a partly reviewed cluster (mixed: one piece ticked in the since view)",
		clusters: [lines("k1", { reviewedLines: [[1, 2]] }), lines("k2")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b", "k1"],
			["add", "B", "k1"],
			["ctx", "c"],
			["add", "d", "k2"],
		]),
	},
	{
		name: "two modified clusters in one hunk",
		clusters: [lines("k1"), lines("k2")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b", "k1"],
			["add", "B", "k1"],
			["ctx", "c"],
			["ctx", "d"],
			["del", "e", "k2"],
			["add", "E", "k2"],
			["ctx", "f"],
		]),
	},
	{
		name: "two clusters with no line between them",
		clusters: [lines("k1"), lines("k2")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b", "k1"],
			["add", "B", "k1"],
			["del", "c", "k2"],
			["add", "C", "k2"],
			["ctx", "d"],
		]),
	},
	{
		name: "an added-only and a removed-only cluster",
		clusters: [lines("k1"), lines("k2")],
		hunks: hunkOf([
			["ctx", "a"],
			["add", "new line", "k1"],
			["ctx", "b"],
			["del", "gone line", "k2"],
			["ctx", "c"],
		]),
	},
	{
		name: "a whitespace-only cluster and a mixed one",
		clusters: [lines("ws"), lines("mixed")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "\tif (a) {", "ws"],
			["del", "\t}", "ws"],
			["add", "  if (a) {", "ws"],
			["add", "  }", "ws"],
			["ctx", "b"],
			["del", "const x = 1;", "mixed"],
			["del", "\tconst y = 2;", "mixed"],
			["add", "const x = 2;", "mixed"],
			["add", "  const y = 2;", "mixed"],
			["ctx", "c"],
		]),
	},
	{
		name: "a removed line whose whitespace twin is another cluster's",
		clusters: [lines("k1"), lines("k2")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "\tmoved();", "k1"],
			["ctx", "b"],
			["add", "  moved();", "k2"],
			["ctx", "c"],
		]),
	},
	{
		name: "a cluster losing the final newline",
		clusters: [lines("k1")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "end", "k1"],
			["add-nl", "end", "k1"],
		]),
	},
	{
		name: "a binary file",
		clusters: [fileLevel("f", "Binary file changed")],
		hunks: NO_HUNKS,
	},
	{
		name: "a rename only",
		clusters: [fileLevel("f", "Renamed from src/old.ts")],
		hunks: NO_HUNKS,
	},
	{
		name: "a mode change",
		clusters: [fileLevel("f", "Mode changed 100644 → 100755")],
		hunks: NO_HUNKS,
	},
	{
		name: "a submodule",
		clusters: [fileLevel("f", "Submodule moved 1111111 → 2222222")],
		hunks: NO_HUNKS,
	},
	{
		name: "an empty file added",
		clusters: [fileLevel("f", "Empty file added")],
		hunks: NO_HUNKS,
	},
	{
		name: "a rename with an edit",
		clusters: [fileLevel("f", "Renamed from src/old.ts"), lines("k1")],
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b", "k1"],
			["add", "B", "k1"],
			["ctx", "c"],
		]),
	},
	{
		name: "a carried cluster, a crossed-off one with its reason, a reviewed one",
		clusters: [
			lines("k1", { state: "reviewed", carried: { from: 1, rule: "exact" } }),
			lines("k2", { state: "crossed-off", reason: "generated" }),
			lines("k3", { state: "reviewed" }),
		],
		hunks: hunkOf([
			["del", "a", "k1"],
			["add", "A", "k1"],
			["ctx", "b"],
			["del", "c", "k2"],
			["add", "C", "k2"],
			["ctx", "d"],
			["add", "e", "k3"],
		]),
	},
];

const SINCE: Case[] = [
	{
		name: "a whole file undone (GoneFile's body: no cluster of this snapshot)",
		clusters: [],
		kinds: kindsOf([["g1", "gone"]]),
		hunks: hunkOf([
			["del", "reviewed on PS1", "g1"],
			["del", "and undone since", "g1"],
		]),
	},
	{
		name: "a reworked cluster and a new one",
		clusters: [lines("k1"), lines("k2"), lines("k3")],
		kinds: kindsOf([
			["k1", "reworked"],
			["k2", "new"],
			["k3", "carried"],
		]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b v1", "k1"],
			["add", "b v2", "k1"],
			["ctx", "c"],
			["add", "d", "k2"],
			["ctx", "e"],
		]),
	},
	{
		name: "a conflicted file (its own diff, keyed on both sides)",
		clusters: [lines("k1")],
		kinds: kindsOf([["k1", "reworked"]]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "base b", "k1"],
			["add", "ours b", "k1"],
			["ctx", "c"],
		]),
	},
	{
		name: "a reworked cluster that is whitespace only since",
		clusters: [lines("k1")],
		kinds: kindsOf([["k1", "reworked"]]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "\tx();", "k1"],
			["add", "  x();", "k1"],
			["ctx", "b"],
		]),
	},
	{
		name: "a file-level cluster (no interdiff lines)",
		clusters: [fileLevel("f", "Mode changed 100644 → 100755")],
		kinds: kindsOf([["f", "new"]]),
		hunks: NO_HUNKS,
	},
	{
		name: "one cluster reworked in three pieces",
		// PS1 added a block; PS2 edits three of its lines (the owner's
		// case): one PS2 cluster, three pieces.
		clusters: [
			lines("k1", {
				oldStart: 1,
				oldCount: 0,
				newStart: 2,
				newCount: 8,
				added: ["2 v2", "3", "4", "5", "6 v2", "7", "8", "9 v2"],
				lines: 8,
			}),
		],
		kinds: kindsOf([["k1", "reworked"]]),
		hunks: hunkOf([
			["ctx", "1"],
			["del", "2 v1", "k1"],
			["add", "2 v2", "k1"],
			["ctx", "3"],
			["ctx", "4"],
			["ctx", "5"],
			["del", "6 v1", "k1"],
			["add", "6 v2", "k1"],
			["ctx", "7"],
			["ctx", "8"],
			["del", "9 v1", "k1"],
			["add", "9 v2", "k1"],
			["ctx", "10"],
		]),
	},
	{
		name: "a removal-only piece (lines PS1 added, reverted since)",
		clusters: [lines("k1")],
		kinds: kindsOf([["k1", "reworked"]]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b v1", "k1"],
			["add", "b v2", "k1"],
			["ctx", "c"],
			["del", "added on PS1"],
			["del", "and reverted"],
			["ctx", "d"],
		]),
	},
	{
		name: "a gone block",
		clusters: [lines("k1")],
		kinds: kindsOf([
			["k1", "reworked"],
			["g1", "gone"],
		]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "b v1", "k1"],
			["add", "b v2", "k1"],
			["ctx", "c"],
			["del", "reviewed on PS1, gone", "g1"],
			["ctx", "d"],
		]),
	},
	{
		name: "a cluster whose removed lines interleave with a gone one's",
		clusters: [lines("k1")],
		kinds: kindsOf([
			["k1", "reworked"],
			["g1", "gone"],
		]),
		hunks: hunkOf([
			["ctx", "a"],
			["del", "g one", "g1"],
			["del", "k one", "k1"],
			["del", "g two", "g1"],
			["add", "k new", "k1"],
			["ctx", "b"],
		]),
	},
];

/**
 * A placeholder line cluster (no lines given) takes its lines from the
 * hunks' lines of its key, numbered as there: what the server's clusters
 * say of the same diff.
 */
function derived(c: Case): ClusterView[] {
	const all = c.hunks.hunks.flatMap((h) => h.lines);
	return c.clusters.map((cl) => {
		if (cl.kind !== "lines" || cl.added.length + cl.removed.length > 0) {
			return cl;
		}
		const dels = all.filter((l) => l.kind === "del" && l.clusterKey === cl.key);
		const adds = all.filter((l) => l.kind === "add" && l.clusterKey === cl.key);
		return {
			...cl,
			oldStart: dels[0]?.oldNo ?? 0,
			oldCount: dels.length,
			newStart: adds[0]?.newNo ?? 0,
			newCount: adds.length,
			removed: dels.map((l) => l.text),
			added: adds.map((l) => l.text),
			lines: dels.length + adds.length,
		};
	});
}

/** The since view's hunks as the server sends them: with their pieces. */
function served(c: Case, clusters: ClusterView[]): FileHunks {
	if (!c.kinds) return c.hunks;
	return {
		...c.hunks,
		// A shown removed line sits in the base where the since view numbers it.
		pieces: sincePieces(c.hunks.hunks, clusters, () => ({
			baseNo: (l) => l.oldNo,
		})),
	};
}

function mount(c: Case, store: MarkStore = new Map(), readOnly = false) {
	const clusters = derived(c);
	const hunks = served(c, clusters);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			const body = url.pathname.endsWith("/hunks") ? hunks : {};
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<MarkableDiff
				path="src/a.ts"
				clusters={clusters}
				store={store}
				from={c.kinds ? 1 : undefined}
				kinds={c.kinds}
				readOnly={readOnly}
			/>
		</QueryClientProvider>,
	);
	return { ...view, store };
}

/** The diff has rendered (its hunks, or its file-level rows). */
async function loaded(c: Case) {
	await waitFor(() => {
		expect(document.querySelector('[aria-busy="true"]')).toBeNull();
		expect(collectUnits(document.body).length).toBeGreaterThan(0);
	});
	if (c.hunks.hunks.length > 0) await screen.findAllByTestId("diff-line");
}

/** The tooltip showing (one at a time; hidden from AT when it repeats a name). */
const openTip = () => document.querySelector('[role="tooltip"]:not([hidden])');

const unitEl = (i: number) => {
	collectUnits(document.body);
	const el = document.querySelector(`[data-markable-unit="${i}"]`);
	if (!el) throw new Error(`no unit ${i}`);
	return el;
};
const boxOf = (i: number) =>
	unitEl(i).querySelector<HTMLInputElement>('input[type="checkbox"]');
const crossOf = (i: number) =>
	unitEl(i).querySelector<HTMLButtonElement>(
		'button[aria-label="Cross off cluster"]',
	);

/** Uses `control` of unit `i`, then checks only unit `i` moved, to `want`. */
async function use(
	i: number,
	control: "box" | "cross",
	want: UnitState,
): Promise<void> {
	const before = statesOf(collectUnits(document.body));
	const el = control === "box" ? boxOf(i) : crossOf(i);
	if (!el) throw new Error(`unit ${i} has no ${control}`);
	act(() => {
		fireEvent.click(el);
	});
	// Its own message, so a failure says which unit moved, in full.
	await waitFor(() => {
		const problems = isolationProblems(
			i,
			before,
			statesOf(collectUnits(document.body)),
			want,
		);
		if (problems.length > 0) throw new Error(problems.join("\n"));
	});
}

/**
 * The invariant on the rendered diff: each unit's own controls, each
 * control changing its unit alone (tick, untick, cross off, undo), and
 * the states as left after a remount.
 */
async function expectEveryUnitMarkable(c: Case) {
	const { store, unmount } = mount(c);
	await loaded(c);
	const units = collectUnits(document.body);
	expect(unitProblems(units)).toEqual([]);
	for (const u of units) {
		const now = statesOf(collectUnits(document.body))[u.index];
		if (now === "reviewed") {
			await use(u.index, "box", "unreviewed");
			await use(u.index, "box", "reviewed");
		} else if (now === "mixed") {
			await use(u.index, "box", "reviewed");
			await use(u.index, "box", "unreviewed");
		} else if (now === "crossed-off") {
			await use(u.index, "box", "unreviewed");
			await use(u.index, "cross", "crossed-off");
		} else {
			await use(u.index, "box", "reviewed");
			await use(u.index, "box", "unreviewed");
			await use(u.index, "cross", "crossed-off");
			await use(u.index, "box", "unreviewed");
		}
	}
	// Each unit left in its own state: tick every other one, then remount.
	for (const u of units) {
		if (u.index % 2 === 0 && boxOf(u.index)?.checked === false) {
			const crossed = boxOf(u.index)?.indeterminate;
			await use(u.index, "box", crossed ? "unreviewed" : "reviewed");
		}
	}
	const left = statesOf(collectUnits(document.body));
	unmount();
	mount(c, store);
	await loaded(c);
	expect(statesOf(collectUnits(document.body))).toEqual(left);
}

const SHAPES = [
	{ name: "unified", side: false, ws: false, wide: true },
	{ name: "unified, ignore whitespace", side: false, ws: true, wide: true },
	{ name: "side by side", side: true, ws: false, wide: true },
	{
		name: "side by side on a phone, ignore whitespace",
		side: true,
		ws: true,
		wide: false,
	},
] as const;

const media = (wide: boolean) =>
	vi.stubGlobal(
		"matchMedia",
		(query: string) =>
			({
				matches: wide,
				media: query,
				addEventListener: () => {},
				removeEventListener: () => {},
			}) as unknown as MediaQueryList,
	);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	ignoreWhitespace.reset();
	sideBySide.reset();
	showInvisibles.reset();
});

for (const shape of SHAPES) {
	describe(`every unit is markable on its own (${shape.name})`, () => {
		beforeEach(() => {
			window.scrollTo = vi.fn();
			media(shape.wide);
			sideBySide.set(shape.side);
			ignoreWhitespace.set(shape.ws);
		});
		for (const [view, cases] of [
			["full diff", FULL],
			["since view", SINCE],
		] as const) {
			for (const c of cases) {
				it(`${view}: ${c.name}`, () => expectEveryUnitMarkable(c));
			}
		}
	});
}

describe("pieces: one reworked cluster in three pieces", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
	});
	it("ticking one piece of a three-piece cluster ticks it alone; the full diff shows the cluster mixed, then reviewed once every line is", async () => {
		const c = SINCE.find(
			(x) => x.name === "one cluster reworked in three pieces",
		) as Case;
		const { store, unmount } = mount(c);
		await loaded(c);
		expect(collectUnits(document.body)).toHaveLength(3);
		await use(1, "box", "reviewed");
		expect(statesOf(collectUnits(document.body))).toEqual([
			"unreviewed",
			"reviewed",
			"unreviewed",
		]);
		unmount();
		// The full diff of the same cluster, under the same marks.
		const full: Case = {
			name: "its full diff",
			clusters: c.clusters,
			hunks: hunkOf([
				["ctx", "1"],
				...(c.clusters[0] as ClusterView).added.map(
					(t): Spec => ["add", t, "k1"],
				),
				["ctx", "10"],
			]),
		};
		const second = mount(full, store);
		await loaded(full);
		expect(statesOf(collectUnits(document.body))).toEqual(["mixed"]);
		// Ticking the rest of its pieces leaves lines no piece shows (3, 4, 5,
		// 7, 8: unchanged since a line never reviewed): still mixed.
		second.unmount();
		mount(c, store);
		await loaded(c);
		await use(0, "box", "reviewed");
		await use(2, "box", "reviewed");
		cleanup();
		mount(full, store);
		await loaded(full);
		expect(statesOf(collectUnits(document.body))).toEqual(["mixed"]);
		await use(0, "box", "reviewed");
		expect(statesOf(collectUnits(document.body))).toEqual(["reviewed"]);
	});
});

describe("the designed exception: an earlier patch set, read-only", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
	});
	for (const c of [FULL[0], FULL[6], SINCE[0]] as Case[]) {
		it(`every unit's controls are locked and say why: ${c.name}`, async () => {
			mount(c, new Map(), true);
			await loaded(c);
			const units = collectUnits(document.body);
			expect(units.length).toBeGreaterThan(0);
			expect(unitProblems(units, { readOnly: true })).toEqual([]);
			const user = userEvent.setup();
			for (const u of units) {
				const box = boxOf(u.index) as HTMLInputElement;
				await user.hover(box.closest("label") as HTMLElement);
				await waitFor(() => expect(openTip()).toHaveTextContent(READ_ONLY_TIP));
				await user.unhover(box.closest("label") as HTMLElement);
				const cross = crossOf(u.index) as HTMLButtonElement;
				await user.hover(cross.parentElement as HTMLElement);
				await waitFor(() => expect(openTip()).toHaveTextContent(READ_ONLY_TIP));
				await user.unhover(cross.parentElement as HTMLElement);
			}
		});
	}
});

describe("a disabled control says why", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
	});
	it("a reviewed cluster's cross-off is off until it is unticked, and says so on hover and to AT", async () => {
		const c: Case = {
			name: "reviewed",
			clusters: [lines("k1", { state: "reviewed" })],
			hunks: hunkOf([
				["del", "a", "k1"],
				["add", "A", "k1"],
			]),
		};
		mount(c);
		await loaded(c);
		const cross = crossOf(0) as HTMLButtonElement;
		expect(cross).toBeDisabled();
		expect(cross).toHaveAccessibleDescription(UNTICK_TO_CROSS);
		await userEvent.setup().hover(cross.parentElement as HTMLElement);
		await waitFor(() => expect(openTip()).toHaveTextContent(UNTICK_TO_CROSS));
	});
	it("an earlier patch set's cross-off names the lock to AT", async () => {
		mount(FULL[0] as Case, new Map(), true);
		await loaded(FULL[0] as Case);
		expect(crossOf(0)).toHaveAccessibleDescription(READ_ONLY_TIP);
	});
});

describe("a file the viewed snapshot no longer changes (GoneFile)", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
	});
	// Its body is the interdiff's gone pieces, each markable on its own (the
	// same DiffBody as the table's "whole file undone" case, which checks
	// that ticking one ticks it alone).
	it("every gone piece has its own controls", async () => {
		const c: Case = {
			name: "gone file",
			clusters: [],
			kinds: kindsOf([["g1", "gone"]]),
			hunks: hunkOf([
				["del", "reviewed on PS1", "g1"],
				["ctx", "kept"],
				["del", "and undone since", "g1"],
			]),
		};
		const hunks = served(c, []);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(hunks), { status: 200 })),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<GoneFile
					index={1}
					path="src/gone.ts"
					revision="r"
					since={1}
					info={{
						kinds: c.kinds as Map<string, KindEntry>,
						conflict: false,
						counts: {
							reworked: 0,
							new: 0,
							gone: 2,
							carried: 0,
							reverted: 0,
							removed: 0,
							unticked: 0,
						},
						left: { units: 2, lines: 2 },
					}}
				/>
			</QueryClientProvider>,
		);
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Expand file" }));
		await screen.findAllByTestId("diff-line");
		const units = collectUnits(document.body);
		expect(units).toHaveLength(2);
		expect(unitProblems(units)).toEqual([]);
	});
});

/** Two units whose boxes share one state: what the isolation check exists to catch. */
function SharedBox() {
	const [on, setOn] = useState(false);
	const row = (text: string) => (
		<tbody>
			<tr data-testid="diff-line" data-kind="add">
				<td>
					<input
						type="checkbox"
						aria-label="Mark cluster reviewed"
						checked={on}
						onChange={() => setOn(!on)}
					/>
					<button type="button" aria-label="Cross off cluster" />
				</td>
				<td data-testid="code">{text}</td>
			</tr>
		</tbody>
	);
	return (
		<table>
			{row("a")}
			{row("b")}
		</table>
	);
}

describe("the helper itself", () => {
	it("fails fast, saying which unit moved, when two units share one control", async () => {
		render(<SharedBox />);
		const started = Date.now();
		await expect(use(0, "box", "reviewed")).rejects.toThrow(
			/marking unit 0 reviewed left unit 1 reviewed, not unreviewed/,
		);
		// The helper's own wait (4 s), not a hang.
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("reads a crossed-off box by its name and a mixed box as mixed, not crossed off", () => {
		document.body.innerHTML = `<table>
			<tbody><tr data-testid="diff-line" data-kind="add"><td>
				<input type="checkbox" aria-label="Undo cross-off">
				<button aria-label="Cross off cluster"></button></td></tr></tbody>
			<tbody><tr data-testid="diff-line" data-kind="add"><td>
				<input type="checkbox" aria-label="Mark cluster reviewed" aria-checked="mixed">
				<button aria-label="Cross off cluster"></button></td></tr></tbody>
		</table>`;
		for (const box of document.querySelectorAll("input")) {
			box.indeterminate = true;
		}
		expect(statesOf(collectUnits(document.body))).toEqual([
			"crossed-off",
			"mixed",
		]);
		document.body.innerHTML = "";
	});

	it("flags a disabled control that gives no reason (no description)", () => {
		document.body.innerHTML = `<table>
			<tbody><tr data-testid="diff-line" data-kind="add"><td>
				<input type="checkbox" aria-label="Mark cluster reviewed" checked>
				<button aria-label="Cross off cluster" disabled></button></td></tr></tbody>
			<tbody><tr data-testid="diff-line" data-kind="add"><td>
				<input type="checkbox" aria-label="Mark cluster reviewed" checked>
				<button aria-label="Cross off cluster" disabled aria-describedby="why"></button>
				<span id="why">Reviewed: untick to cross off</span></td></tr></tbody>
		</table>`;
		expect(unitProblems(collectUnits(document.body))).toEqual([
			'unit 0 ("a"): cross-off disabled with no reason'.replace('"a"', '""'),
		]);
		document.body.innerHTML = "";
	});
});

describe("near misses, pinned", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
	});
	it("a line whose key the review doesn't list shows unreviewed, with no control (unreachable: the server keys every line from the snapshot)", async () => {
		const c: Case = {
			name: "ghost",
			clusters: [lines("k1")],
			hunks: hunkOf([
				["del", "a", "k1"],
				["add", "A", "k1"],
				["ctx", "b"],
				["add", "ghost line", "ghost"],
			]),
		};
		mount(c);
		await loaded(c);
		const units = collectUnits(document.body);
		expect(units.map((u) => [u.state, u.boxes])).toEqual([
			["unreviewed", 1],
			[null, 0],
		]);
		// Its rail still reads unreviewed (fail closed, principle 2).
		const rail = unitEl(1).querySelector("td[aria-hidden]") as HTMLElement;
		expect(rail.className).toMatch(/bg-/);
		expect(rail.className).not.toMatch(/bg-ok/);
	});
});
