// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SincePiece } from "../../../../shared/pieces";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
} from "../../../../shared/types";
import { ignoreWhitespace } from "../../../viewSettings";
import type { KindEntry } from "../../since";
import { type DocFixture, docFixture, type Edit } from "./docFixture";
import { MarkdownView } from "./MarkdownView";

/*
 * The Rendered view (CAR-167, spec "The Rendered view"): one box per unit
 * on the block(s) holding its lines, the bars' tones, folds, whitespace
 * boxes, and the coverage invariant: the units with a box are exactly the
 * file's (principle 2), in the full diff and the since view.
 */

const OLD = [
	"# Title", // 1
	"",
	"Intro old words here.", // 3
	"",
	"- one", // 5
	"- two",
	"",
	"```", // 8
	"code old",
	"```",
	"", // 11
	"## Gone",
	"",
	"Para A", // 14
	"",
	"## Install", // 16
	"",
	"## Usage", // 18
	"",
	"Para D", // 20
	"",
	"Para E", // 22
	"",
	"Line one x", // 24
	"line two",
	"line three y", // 26
];
const NEW = [
	"# Title", // 1
	"",
	"Intro new words here.", // 3
	"",
	"- one", // 5
	"- two",
	"- three", // 7
	"",
	"```", // 9
	"code new",
	"```",
	"", // 12
	"Para A", // 13
	"",
	"## Install", // 15
	"",
	"## Usage", // 17
	"",
	"Para D", // 19
	"",
	"Para  E", // 21
	"",
	"Line one X", // 23
	"line two",
	"line three Y", // 25
];
const EDITS: Edit[] = [
	{ key: "k1", old: [3, 4], new: [3, 4] },
	{ key: "k2", new: [7, 8] },
	{ key: "k3", old: [9, 10], new: [10, 11] },
	{ key: "k4", old: [12, 14] },
	{ key: "k5", old: [22, 23], new: [21, 22], whitespaceOnly: true },
	{ key: "k6", old: [24, 25], new: [23, 24] },
	{ key: "k7", old: [26, 27], new: [25, 26] },
];

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	ignoreWhitespace.set(false);
});

/** Serves the fixture's hunks and context; `hold` keeps them back. */
function serve(fx: { hunks: FileHunks; context: DiffLine[] }) {
	const fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://test");
		const body = url.pathname.endsWith("/hunks")
			? fx.hunks
			: url.pathname.endsWith("/context")
				? fx.context
				: {};
		return new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

function show(
	fx: DocFixture,
	opts: {
		from?: number;
		kinds?: Map<string, KindEntry>;
		readOnly?: boolean;
		onShowText?: () => void;
		onToggle?: (c: ClusterView, piece?: unknown) => void;
		onSinceMark?: (p: SincePiece, cross: boolean) => void;
		sideBySide?: boolean;
	} = {},
) {
	serve(fx);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MarkdownView
				file={fx.file}
				revision="r1"
				sideBySide={opts.sideBySide ?? false}
				readOnly={opts.readOnly}
				onToggle={opts.onToggle ?? (() => {})}
				onCrossOff={() => {}}
				view={<span>switch</span>}
				onShowText={opts.onShowText ?? (() => {})}
				from={opts.from}
				kinds={opts.kinds}
				onSinceMark={opts.onSinceMark}
			/>
		</QueryClientProvider>,
	);
}

const doc = async () => {
	await screen.findByTestId("md-doc");
	return screen.getByTestId("md-doc");
};
const boxOf = (root: HTMLElement, key: string) =>
	root.querySelector<HTMLElement>(`[data-testid="md-box"][data-unit="${key}"]`);
const rowOf = (root: HTMLElement, key: string) =>
	boxOf(root, key)?.closest<HTMLElement>('[data-testid="md-block"]') ?? null;
const unitsShown = (root: HTMLElement) =>
	[...root.querySelectorAll('[data-testid="md-box"]')].map((b) =>
		b.getAttribute("data-unit"),
	);

/** The coverage invariant: the units with a box are exactly these keys. */
const expectCoverage = (root: HTMLElement, keys: string[]) =>
	expect(new Set(unitsShown(root))).toEqual(new Set(keys));

describe("MarkdownView, full diff", () => {
	it("puts each cluster's box on the block(s) holding its lines, one box each, in source order", async () => {
		const fx = docFixture(OLD, NEW, EDITS);
		show(fx);
		const root = await doc();
		expect(unitsShown(root)).toEqual([
			"k1",
			"k2",
			"k3",
			"k4",
			"k5",
			"k6",
			"k7",
		]);
		expectCoverage(
			root,
			fx.file.clusters.map((c) => c.key),
		);
		// New blocks (0-based): 0 title, 1 intro, 2-4 list items, 5 fence,
		// 6 Para A, 7 Install, 8 Usage, 9 Para D, 10 Para E, 11 the last paragraph.
		expect(rowOf(root, "k1")).toHaveAttribute("data-block", "1");
		expect(rowOf(root, "k2")).toHaveAttribute("data-block", "4");
		expect(rowOf(root, "k3")).toHaveAttribute("data-block", "5");
		// A removal-only block where it was: before Para A, on the old side.
		expect(rowOf(root, "k4")).not.toHaveAttribute("data-block");
		expect(rowOf(root, "k4")).toHaveAttribute("data-old-block", "5");
		// Two edits in one block: one row, two boxes, in source order.
		expect(rowOf(root, "k6")).toBe(rowOf(root, "k7"));
		expect(rowOf(root, "k6")).toHaveAttribute("data-block", "11");
		expect(rowOf(root, "k6")?.getAttribute("data-units")).toBe("k6 k7");
		const rows = [...root.querySelectorAll('[data-testid="md-block"]')];
		expect(rows.indexOf(rowOf(root, "k4") as HTMLElement)).toBeLessThan(
			rows.findIndex((r) => r.textContent?.includes("Para A")),
		);
	});

	it("tones: added green, removed red and struck, changed amber with words marked; a fence old struck above new", async () => {
		show(docFixture(OLD, NEW, EDITS));
		const root = await doc();
		const added = rowOf(root, "k2") as HTMLElement;
		expect(added).toHaveAttribute("data-tone", "added");
		expect(added.querySelector(".md-added")).toHaveTextContent("three");
		const removed = rowOf(root, "k4") as HTMLElement;
		expect(removed).toHaveAttribute("data-tone", "removed");
		expect(removed.querySelector(".md-old h2")).toHaveTextContent("Gone");
		const changed = rowOf(root, "k1") as HTMLElement;
		expect(changed).toHaveAttribute("data-tone", "changed");
		expect(changed.querySelector("del.md-del")).toHaveTextContent("old");
		expect(changed.querySelector("ins.md-ins")).toHaveTextContent("new");
		expect(changed.querySelector(".md-old")).toBeNull();
		const fence = rowOf(root, "k3") as HTMLElement;
		expect(fence.querySelector(".md-old pre")).toHaveTextContent("code old");
		expect(fence.querySelector(".md-new pre")).toHaveTextContent("code new");
		expect(fence.querySelector("ins.md-ins")).toBeNull();
	});

	it("folds a run of more than 3 unchanged blocks into a row naming its headings; it expands in place and never holds a change", async () => {
		show(docFixture(OLD, NEW, EDITS));
		const root = await doc();
		const fold = screen.getByTestId("md-fold");
		expect(fold).toHaveTextContent("2 unchanged");
		expect(fold).toHaveTextContent("Install");
		expect(fold).toHaveTextContent("Usage");
		expect(
			fold.closest(".md-fold-row")?.querySelector('[data-testid="md-box"]'),
		).toBeNull();
		// The fold sits between the blocks kept by each change.
		expect(root.textContent).toContain("Para A");
		expect(root.querySelector("h2")?.textContent).not.toBe("Install");
		await userEvent.click(fold);
		expect(screen.queryByTestId("md-fold")).toBeNull();
		expect([...root.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(
			expect.arrayContaining(["Install", "Usage"]),
		);
		expectCoverage(
			root,
			EDITS.map((e) => e.key),
		);
	});

	it("a whitespace-only cluster gets its own box with the ~; none with Ignore whitespace on", async () => {
		show(docFixture(OLD, NEW, EDITS));
		let root = await doc();
		const ws = boxOf(root, "k5") as HTMLElement;
		expect(ws).toHaveAttribute("data-ws", "true");
		expect(
			ws.querySelector('[aria-label="Whitespace only"]'),
		).toHaveTextContent("~");
		cleanup();
		ignoreWhitespace.set(true);
		show(docFixture(OLD, NEW, EDITS));
		root = await doc();
		expect(boxOf(root, "k5")).toBeNull();
		expectCoverage(
			root,
			EDITS.filter((e) => !e.whitespaceOnly).map((e) => e.key),
		);
	});

	it("read-only: every box is locked", async () => {
		show(docFixture(OLD, NEW, EDITS), { readOnly: true });
		const root = await doc();
		const boxes = [
			...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
		];
		expect(boxes).toHaveLength(EDITS.length);
		for (const b of boxes) expect(b).toBeDisabled();
	});

	it("a tick calls the cluster's own toggle", async () => {
		const onToggle = vi.fn();
		const fx = docFixture(OLD, NEW, EDITS);
		show(fx, { onToggle });
		const root = await doc();
		await userEvent.click(
			boxOf(root, "k6")?.querySelector("input") as HTMLInputElement,
		);
		expect(onToggle).toHaveBeenCalledWith(fx.file.clusters[5]);
	});

	it("a document it can't rebuild whole goes to Text, never shown with a gap", async () => {
		const fx = docFixture(OLD, NEW, EDITS);
		const onShowText = vi.fn();
		show({ ...fx, context: fx.context.slice(1) }, { onShowText });
		await waitFor(() => expect(onShowText).toHaveBeenCalled());
		expect(screen.queryByTestId("md-doc")).toBeNull();
	});

	it("an added file: every block green and boxed; a deleted file: every block red and struck", async () => {
		const lines = ["# New", "", "Text.", "", "- a"];
		show(docFixture([], lines, [{ key: "a1", new: [1, 6] }]));
		let root = await doc();
		let rows = [...root.querySelectorAll('[data-testid="md-block"]')];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveAttribute("data-tone", "added");
		expect(rows[0]).toHaveAttribute("data-block", "0,1,2");
		expectCoverage(root, ["a1"]);
		cleanup();
		show(docFixture(lines, [], [{ key: "d1", old: [1, 6] }]));
		root = await doc();
		rows = [...root.querySelectorAll('[data-testid="md-block"]')];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveAttribute("data-tone", "removed");
		expect(rows[0]?.querySelector(".md-old h1")).toHaveTextContent("New");
		expectCoverage(root, ["d1"]);
	});

	it("side by side on desktop: old and new columns, words marked on each", async () => {
		const matchMedia = vi.fn(() => ({
			matches: true,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		vi.stubGlobal("matchMedia", matchMedia);
		show(docFixture(OLD, NEW, EDITS), { sideBySide: true });
		const root = await doc();
		const changed = rowOf(root, "k1") as HTMLElement;
		const cols = changed.querySelectorAll(".grid > div");
		expect(cols).toHaveLength(2);
		expect(cols[0]?.querySelector("del.md-del")).toHaveTextContent("old");
		expect(cols[0]?.querySelector("ins")).toBeNull();
		expect(cols[1]?.querySelector("ins.md-ins")).toHaveTextContent("new");
		expect(cols[1]?.querySelector("del")).toBeNull();
		expectCoverage(
			root,
			EDITS.map((e) => e.key),
		);
	});

	it("loading shows the skeleton, never an empty document", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const fx = docFixture(OLD, NEW, EDITS);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				await gate;
				const url = new URL(String(input), "http://test");
				const body = url.pathname.endsWith("/hunks") ? fx.hunks : fx.context;
				return new Response(JSON.stringify(body), {
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<MarkdownView
					file={fx.file}
					revision="r1"
					sideBySide={false}
					onToggle={() => {}}
					onCrossOff={() => {}}
					view={null}
					onShowText={() => {}}
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByTestId("md-loading")).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(
			screen.getByRole("status", { name: "Loading document" }),
		).toBeTruthy();
		expect(screen.queryByTestId("md-doc")).toBeNull();
		release();
		await doc();
		expect(screen.queryByTestId("md-loading")).toBeNull();
	});
});

describe("MarkdownView, since view", () => {
	it("one box per piece on its block; a tick marks that piece of its cluster; kind chips as the line view's", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		const onToggle = vi.fn();
		const kinds = new Map<string, KindEntry>([
			["k1", { key: "k1", kind: "reworked", from: 1 } as KindEntry],
			["k2", { key: "k2", kind: "new", from: 1 } as KindEntry],
		]);
		show(fx, { from: 1, kinds, onToggle });
		const root = await doc();
		const pieces = fx.hunks.pieces ?? [];
		expect(unitsShown(root)).toEqual(
			pieces.map((p) => `p:${p.hunk}:${p.line}`),
		);
		expect(rowOf(root, "p:0:0")).toHaveAttribute("data-block", "1");
		expect(
			rowOf(root, "p:0:0")?.querySelector('[data-kind="reworked"]'),
		).toBeTruthy();
		expect(
			rowOf(root, "p:1:0")?.querySelector('[data-kind="new"]'),
		).toBeTruthy();
		// A piece of removals only: struck, red, chipped removed.
		expect(rowOf(root, "p:3:0")).toHaveAttribute("data-tone", "removed");
		expect(
			rowOf(root, "p:3:0")?.querySelector('[data-kind="removed"]'),
		).toBeTruthy();
		await userEvent.click(
			boxOf(root, "p:5:0")?.querySelector("input") as HTMLInputElement,
		);
		expect(onToggle).toHaveBeenCalledWith(fx.file.clusters[5], pieces[5]?.owns);
		expect(screen.queryByTestId("since-empty")).toBeNull();
	});

	it("a piece no cluster owns (reverted) shows struck and red with its own since box", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		const pieces = (fx.hunks.pieces ?? []).map((p) =>
			p.key === "k4" ? { ...p, owns: null, kind: "reverted" as const } : p,
		);
		const onSinceMark = vi.fn();
		show({ ...fx, hunks: { ...fx.hunks, pieces } }, { from: 1, onSinceMark });
		const root = await doc();
		const row = rowOf(root, "p:3:0") as HTMLElement;
		expect(row).toHaveAttribute("data-tone", "removed");
		expect(row.querySelector('[data-kind="reverted"]')).toBeTruthy();
		await userEvent.click(row.querySelector("input") as HTMLInputElement);
		expect(onSinceMark).toHaveBeenCalledWith(pieces[3], false);
		expectCoverage(
			root,
			pieces.map((p) => `p:${p.hunk}:${p.line}`),
		);
	});

	it("a whitespace-only piece gets its ~ box, left out with Ignore whitespace; two pieces of one block share its row", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		const keys = (fx.hunks.pieces ?? []).map((p) => `p:${p.hunk}:${p.line}`);
		show(fx, { from: 1 });
		let root = await doc();
		expect(boxOf(root, "p:4:0")).toHaveAttribute("data-ws", "true");
		expect(rowOf(root, "p:5:0")).toBe(rowOf(root, "p:6:0"));
		expectCoverage(root, keys);
		cleanup();
		ignoreWhitespace.set(true);
		show(fx, { from: 1 });
		root = await doc();
		expect(boxOf(root, "p:4:0")).toBeNull();
		expectCoverage(
			root,
			keys.filter((k) => k !== "p:4:0"),
		);
	});

	it("a file the author left alone since says so", async () => {
		const fx = docFixture(NEW, NEW, [], { since: true });
		show({ ...fx, hunks: { ...fx.hunks, hunks: [], pieces: [] } }, { from: 1 });
		await doc();
		expect(screen.getByTestId("since-empty")).toHaveTextContent(
			"Nothing to read since PS1",
		);
	});
});
