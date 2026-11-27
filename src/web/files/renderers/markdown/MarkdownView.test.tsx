// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentThread, SpanAgentThread } from "../../../../shared/agent";
import type { SincePiece } from "../../../../shared/pieces";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../../../shared/types";
import {
	openAgentComposer,
	resetAgentComposers,
} from "../../../agent/askAgentAction";
import { type AgentPlaceable, agentPlaceable } from "../../../agent/placeable";
import { overviewQuery, sessionQuery } from "../../../api";
import {
	getComposers,
	openComposer,
	resetComposers,
} from "../../../threads/newThreads";
import { ignoreWhitespace, showInvisibles } from "../../../viewSettings";
import type { DiffFind } from "../../DiffBody";
import type { KindEntry } from "../../since";
import { placeThreads, sinceEarlier, sinceLeft } from "../../threadPlacement";
import { type DocFixture, docFixture, type Edit } from "./docFixture";
import type { ImageFile } from "./images";
import { MarkdownView } from "./MarkdownView";
import { renderBlocks } from "./renderBlocks";
import { alignTables } from "./tableAlign";

// Spied on, still the renderer: a mark mustn't render the document again.
vi.mock("./renderBlocks", async (importOriginal) => {
	const real = await importOriginal<typeof import("./renderBlocks")>();
	return { ...real, renderBlocks: vi.fn(real.renderBlocks) };
});

// Spied on, still the aligner: it runs again only when the tables may differ.
vi.mock("./tableAlign", async (importOriginal) => {
	const real = await importOriginal<typeof import("./tableAlign")>();
	return { ...real, alignTables: vi.fn(real.alignTables) };
});

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
	resetComposers();
	resetAgentComposers();
	vi.unstubAllGlobals();
	ignoreWhitespace.set(false);
});

/** Serves the fixture's hunks and context; `hold` keeps them back. */
function serve(fx: { hunks: FileHunks; context: DiffLine[] }) {
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		// A write (Resolve) is on its way until the test ends.
		if (init?.method === "POST") return new Promise<Response>(() => {});
		const url = new URL(String(input), "http://test");
		const body = url.pathname.endsWith("/hunks")
			? fx.hunks
			: url.pathname.endsWith("/context")
				? fx.context
				: url.pathname === "/api/comments"
					? { threads: [] }
					: {};
		return new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

type ShowOpts = {
	from?: number;
	kinds?: Map<string, KindEntry>;
	readOnly?: boolean;
	onShowText?: () => void;
	onToggle?: (c: ClusterView, piece?: unknown) => void;
	onSinceMark?: (p: SincePiece, cross: boolean) => void;
	sideBySide?: boolean;
	/** The PR's review threads on the viewed head, placed as FileDiff places them. */
	threads?: ReviewThread[];
	find?: DiffFind;
	findSpent?: boolean;
	onFindText?: () => void;
	/** The since view's compared patch set's head (CAR-233). */
	earlierHead?: string;
	/** The reviewer's agent threads on the viewed head, placed as FileDiff places them. */
	agentThreads?: AgentThread[];
	/** The review's files, for images. */
	files?: ImageFile[];
	/** The file as the page has it now (a tick reads the review again). */
	file?: DocFixture["file"];
};

const HEAD = "h".repeat(40);

function show(fx: DocFixture, opts: ShowOpts = {}) {
	serve(fx);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(sessionQuery.queryKey, {
		snapshotHead: HEAD,
		patchsets: opts.earlierHead
			? [{ number: opts.from ?? 1, head: opts.earlierHead }]
			: [],
	} as unknown as SessionInfo);
	client.setQueryData(overviewQuery.queryKey, {
		writes: "on",
		commentLeft: true,
	} as unknown as PrOverview);
	const tree = (o: ShowOpts) => {
		// As FileDiff places them: on the hunks and the whole document.
		const placement = o.threads
			? placeThreads({
					threads: o.threads,
					path: fx.file.path,
					snapshotHead: HEAD,
					hunks: fx.hunks,
					loadedContext: fx.context,
					...(o.from === undefined
						? {}
						: {
								sinceLeft: sinceLeft(fx.file.clusters, fx.hunks.hunks),
								...(o.earlierHead
									? {
											sinceEarlier: sinceEarlier(o.earlierHead, fx.hunks.hunks),
										}
									: {}),
							}),
				})
			: undefined;
		const agentPlacement = o.agentThreads
			? placeThreads<AgentPlaceable>({
					threads: o.agentThreads.map((t) =>
						agentPlaceable(t as SpanAgentThread),
					),
					path: fx.file.path,
					snapshotHead: HEAD,
					hunks: fx.hunks,
					loadedContext: fx.context,
				})
			: undefined;
		return (
			<QueryClientProvider client={client}>
				<MarkdownView
					file={o.file ?? fx.file}
					revision="r1"
					sideBySide={o.sideBySide ?? false}
					readOnly={o.readOnly}
					onToggle={o.onToggle ?? (() => {})}
					onCrossOff={() => {}}
					view={<span>switch</span>}
					onShowText={o.onShowText ?? (() => {})}
					from={o.from}
					kinds={o.kinds}
					onSinceMark={o.onSinceMark}
					threads={
						o.threads
							? { readId: "r", snapshotHead: HEAD, threads: o.threads }
							: undefined
					}
					placement={placement}
					agentPlacement={agentPlacement}
					find={o.find}
					findSpent={o.findSpent}
					onFindText={o.onFindText}
					files={o.files}
				/>
			</QueryClientProvider>
		);
	};
	const result = render(tree(opts));
	return {
		...result,
		/** New props, as the page rerenders it (a find's step). */
		update: (next: Partial<ShowOpts>) => {
			Object.assign(opts, next);
			result.rerender(tree(opts));
		},
	};
}

/** A line thread ending on `line` of `side`, on the viewed head. */
const lineThread = (
	id: string,
	side: "LEFT" | "RIGHT",
	line: number,
	path = "README.md",
): ReviewThread =>
	({
		id,
		loaded: true,
		path,
		line,
		currentLine: line,
		excerpt: `About ${id}`,
		html: `<p>About ${id}</p>`,
		body: `About ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "rev",
		bot: false,
		avatarUrl: "",
		participants: [],
		lastAuthor: { login: "rev", avatarUrl: "", bot: false },
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: {
			path,
			commit: HEAD,
			side,
			line,
			startSide: side,
			startLine: line,
			at: "2026-01-01T00:00:00Z",
		},
		commit: HEAD,
		subject: "line",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: true },
	}) as unknown as ReviewThread;

/** The row (a block, or a fold) whose gutter holds a bubble of `n` comments. */
const bubbleRows = (root: HTMLElement) =>
	[...root.querySelectorAll('[data-testid="thread-bubble"]')].map((b) =>
		b.closest("[data-row]")?.getAttribute("data-row"),
	);
const rowByKey = (root: HTMLElement, key: string) =>
	root.querySelector<HTMLElement>(`[data-row="${key}"]`);
/** The row a box's unit is on, by its key (`c<i>`, `s<block>`). */
const keyOfUnit = (root: HTMLElement, unit: string) =>
	rowOf(root, unit)?.getAttribute("data-row");

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

	it("tables are aligned again when the document's rows change (a fold opened), not on every render", async () => {
		const { update } = show(docFixture(OLD, NEW, EDITS));
		await doc();
		const calls = () => vi.mocked(alignTables).mock.calls.length;
		const first = calls();
		expect(first).toBeGreaterThan(0);
		update({ findSpent: true });
		update({ findSpent: false });
		expect(calls()).toBe(first);
		await userEvent.click(screen.getByTestId("md-fold"));
		expect(calls()).toBeGreaterThan(first);
	});

	it.each([
		["full diff", false],
		["since view", true],
	])("%s: a tick doesn't align the tables again", async (_, since) => {
		const fx = docFixture(OLD, NEW, EDITS, { since });
		const { update } = show(fx, since ? { from: 1 } : {});
		await doc();
		const calls = () => vi.mocked(alignTables).mock.calls.length;
		const first = calls();
		expect(first).toBeGreaterThan(0);
		// The page reads the review again: new clusters, one reviewed.
		update({
			file: {
				...fx.file,
				clusters: fx.file.clusters.map((c) =>
					c.key === "k1" ? { ...c, state: "reviewed" as const } : { ...c },
				),
			},
		});
		await waitFor(() =>
			expect(
				screen
					.getAllByRole("checkbox")
					.some((b) => (b as HTMLInputElement).checked),
			).toBe(true),
		);
		expect(calls()).toBe(first);
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
		const cols = changed.querySelectorAll(".md-body[data-col]");
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

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"side by side on desktop (%s): each box on the new column; a removal's on the old (the only one)",
		async (_, since) => {
			vi.stubGlobal(
				"matchMedia",
				vi.fn(() => ({
					matches: true,
					addEventListener: () => {},
					removeEventListener: () => {},
				})),
			);
			show(
				docFixture(OLD, NEW, EDITS, { since }),
				since ? { sideBySide: true, from: 1 } : { sideBySide: true },
			);
			const root = await doc();
			const unit = (i: number) => (since ? `p:${i}:0` : (EDITS[i]?.key ?? ""));
			const colOf = (i: number) =>
				boxOf(root, unit(i))?.closest(".md-gutter")?.getAttribute("data-col");
			for (const i of [0, 1, 2, 4, 5, 6]) expect(colOf(i), unit(i)).toBe("new");
			expect(colOf(3)).toBe("old");
			// The new column's gutter sits between the two bodies.
			const row = rowOf(root, unit(0)) as HTMLElement;
			expect(
				[...row.children].map(
					(c) => `${c.className.split(" ")[0]}:${c.getAttribute("data-col")}`,
				),
			).toEqual([
				"md-gutter:old",
				"md-body:old",
				"md-gutter:new",
				"md-body:new",
			]);
			expectCoverage(
				root,
				EDITS.map((_, i) => unit(i)),
			);
		},
	);

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"side by side on a phone (%s): old and new columns, each its own marks, the controls in a row of their own above",
		async (_, since) => {
			vi.stubGlobal(
				"matchMedia",
				vi.fn(() => ({
					matches: false,
					addEventListener: () => {},
					removeEventListener: () => {},
				})),
			);
			show(
				docFixture(OLD, NEW, EDITS, { since }),
				since ? { sideBySide: true, from: 1 } : { sideBySide: true },
			);
			const root = await doc();
			const unit = (i: number) => (since ? `p:${i}:0` : (EDITS[i]?.key ?? ""));
			// No merged rendering anywhere.
			expect(root.querySelector('[data-col="doc"]')).toBeNull();
			const row = rowOf(root, unit(0)) as HTMLElement;
			expect(
				[...row.children]
					.filter((c) => !c.matches('[data-testid="md-threads"]'))
					.map(
						(c) => `${c.className.split(" ")[0]}:${c.getAttribute("data-col")}`,
					),
			).toEqual(["md-controls:controls", "md-body:old", "md-body:new"]);
			const [oldCol, newCol] = row.querySelectorAll(".md-body[data-col]");
			expect(oldCol?.querySelector("del.md-del")).toHaveTextContent("old");
			expect(oldCol?.querySelector("ins")).toBeNull();
			expect(newCol?.querySelector("ins.md-ins")).toHaveTextContent("new");
			expect(newCol?.querySelector("del")).toBeNull();
			// Every box in its row's controls, none in a column; a removal's
			// says it is the old side's.
			for (const i of EDITS.keys()) {
				const box = boxOf(root, unit(i));
				expect(box?.closest(".md-controls"), unit(i)).not.toBeNull();
				expect(box?.closest(".md-body"), unit(i)).toBeNull();
			}
			expect(
				boxOf(root, unit(3))
					?.closest(".md-controls")
					?.getAttribute("data-side"),
			).toBe("old");
			const removed = rowOf(root, unit(3)) as HTMLElement;
			const [rOld, rNew] = removed.querySelectorAll(".md-body[data-col]");
			expect(rOld?.querySelector(".md-old")).not.toBeNull();
			expect(rNew?.childElementCount).toBe(0);
			expect(root.querySelector(".md-gutter")).toBeNull();
			expectCoverage(
				root,
				EDITS.map((_, i) => unit(i)),
			);
		},
	);

	it("a mark (the review read again: new clusters, a new file list) renders no block again", async () => {
		const fx = docFixture(OLD, NEW, EDITS);
		serve(fx);
		const client = new QueryClient();
		const at = (clusters: ClusterView[]) => (
			<QueryClientProvider client={client}>
				<MarkdownView
					file={{ ...fx.file, clusters }}
					revision="r1"
					sideBySide={false}
					onToggle={() => {}}
					onCrossOff={() => {}}
					view={null}
					onShowText={() => {}}
					files={[{ ...fx.file }]}
				/>
			</QueryClientProvider>
		);
		const view = render(at(fx.file.clusters));
		const root = await doc();
		const rendered = vi.mocked(renderBlocks).mock.calls.length;
		expect(rendered).toBeGreaterThan(0);
		view.rerender(
			at(
				fx.file.clusters.map((c) =>
					c.key === "k1" ? { ...c, state: "reviewed" as const } : c,
				),
			),
		);
		await waitFor(() =>
			expect(boxOf(root, "k1")?.querySelector("input")).toBeChecked(),
		);
		expect(vi.mocked(renderBlocks).mock.calls.length).toBe(rendered);
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

describe("MarkdownView: gallery #61 lists.md, full diff and since view", () => {
	const LOLD = [
		"- Set up a Tidewater account with the crew role", // 1
		"- Read the lifejacket drill card", // 2
		"- Find your locker on the car deck",
		"",
		"- Mooring lines", // 5
		"  - Bow line",
		"  - Stern line", // 7
		"  - Spring lines",
	];
	const LNEW = [
		"- Set up a Tidewater account with the deckhand or purser role", // 1
		"- Find your locker on the car deck",
		"",
		"- Mooring lines", // 4
		"  - Bow line",
		"  - Spring lines",
		"  - Heaving line", // 7
	];
	const LEDITS: Edit[] = [
		{ key: "set", old: [1, 2], new: [1, 2] },
		{ key: "read", old: [2, 3] },
		{ key: "stern", old: [7, 8] },
		{ key: "heave", new: [7, 8] },
	];

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"%s: the removed item sits after the changed one, as in the base; nested items render nested",
		async (_, since) => {
			show(docFixture(LOLD, LNEW, LEDITS, { since }), since ? { from: 1 } : {});
			const root = await doc();
			const unit = (i: number) => (since ? `p:${i}:0` : (LEDITS[i]?.key ?? ""));
			const rows = [
				...root.querySelectorAll<HTMLElement>('[data-testid="md-block"]'),
			];
			const at = (i: number) =>
				rows.indexOf(rowOf(root, unit(i)) as HTMLElement);
			expect(at(1)).toBe(at(0) + 1);
			expect(rowOf(root, unit(1))).toHaveAttribute("data-tone", "removed");
			// Stern (struck) and Heaving (new) one list deeper than Mooring lines.
			for (const i of [2, 3]) {
				const li = rowOf(root, unit(i))?.querySelector(".md-content li li");
				expect(li, unit(i)).toHaveTextContent(i === 2 ? "Stern" : "Heaving");
			}
			expectCoverage(
				root,
				LEDITS.map((_, i) => unit(i)),
			);
		},
	);
});

describe("MarkdownView: gallery #61 images, full diff and since view (CAR-167 QA)", () => {
	// md/images.md's last image, PS1 → head: another image under the same
	// alt; md/inline.md's route map, base → head: only its alt changed (an
	// image not in the PR, a placeholder on both sides).
	const image = (index: number, path: string, status: ImageFile["status"]) => ({
		index,
		path: `md/${path}`,
		status,
		binary: true,
		submodule: false,
	});
	const FILES: ImageFile[] = [
		image(1, "img/departures.png", "modified"),
		image(2, "img/timetable-export.png", "added"),
	];
	const IOLD = [
		"Intro.",
		"",
		"![Timetable export dialog](img/timetable-export.png)",
		"",
		"The export dialog is new in this release.",
	];
	const INEW = [
		"Intro.",
		"",
		"![Timetable export dialog](img/departures.png)",
		"",
		"The export dialog is new in this release.",
	];
	const imgEdit: Edit[] = [{ key: "img", old: [3, 4], new: [3, 4] }];
	const params = (src: string | null | undefined) =>
		Object.fromEntries(new URL(src ?? "", "http://test").searchParams);

	it.each([
		["full diff", undefined],
		["since view", 1],
	])(
		"%s: a removed image loads from the old side, the added one from the new",
		async (_, from) => {
			// The timetable export image the base lacks: the full diff marks
			// it modified here so both sides exist; the since view keeps it
			// added, as its old side is the compared patch set's, which has it.
			const files =
				from === undefined
					? FILES.map((f) => ({ ...f, status: "modified" as const }))
					: FILES;
			show(
				docFixture(IOLD, INEW, imgEdit, {
					path: "md/images.md",
					since: from !== undefined,
				}),
				{ files, ...(from === undefined ? {} : { from }) },
			);
			const root = await doc();
			const row = rowOf(root, from === undefined ? "img" : "p:0:0");
			const removed = row?.querySelector("del.md-del img");
			const added = row?.querySelector("ins.md-ins img");
			expect(params(removed?.getAttribute("src"))).toMatchObject({
				side: "old",
				...(from === undefined ? {} : { from: String(from) }),
			});
			expect(removed?.getAttribute("src")).toContain("/files/2/blob");
			expect(params(added?.getAttribute("src"))).toMatchObject({
				side: "new",
			});
			expect(added?.getAttribute("src")).toContain("/files/1/blob");
		},
	);

	it.each([
		["full diff", undefined, "Not loaded"],
		["since view", 1, "Not at this patch set"],
	])(
		"%s: an image that fails to load becomes a still placeholder, never a broken image",
		async (_, from, why) => {
			// The since view's removed timetable export, missing at the
			// compared patch set: its blob doesn't load.
			const files =
				from === undefined
					? FILES.map((f) => ({ ...f, status: "modified" as const }))
					: FILES;
			show(
				docFixture(IOLD, INEW, imgEdit, {
					path: "md/images.md",
					since: from !== undefined,
				}),
				{ files, ...(from === undefined ? {} : { from }) },
			);
			const root = await doc();
			const row = rowOf(root, from === undefined ? "img" : "p:0:0");
			const removed = row?.querySelector("del.md-del img");
			expect(removed).not.toBeNull();
			removed?.dispatchEvent(new Event("error"));
			expect(row?.querySelector("del.md-del img")).toBeNull();
			const still = row?.querySelector("del.md-del .md-local-image");
			expect(still).toHaveAttribute("title", why);
			expect(still).toHaveAttribute(
				"aria-label",
				`Timetable export dialog, img/timetable-export.png: ${why.toLowerCase()}`,
			);
			// The added image, loaded, stays an image.
			expect(row?.querySelector("ins.md-ins img")).not.toBeNull();
		},
	);

	const ROLD = [
		"Intro.",
		"",
		"![Route map of the three ports](img/route-map.png)",
	];
	const RNEW = [
		"Intro.",
		"",
		"![Route map: Strandkaien, Nordnes and Askøy](img/route-map.png)",
	];
	it.each([
		["full diff", false],
		["since view", true],
	])(
		"%s: an alt-only change of an image not in the PR shows each side's alt",
		async (_, since) => {
			show(
				docFixture(ROLD, RNEW, [{ key: "map", old: [3, 4], new: [3, 4] }], {
					path: "md/inline.md",
					since,
				}),
				{ files: FILES, ...(since ? { from: 1 } : {}) },
			);
			const root = await doc();
			const row = rowOf(root, since ? "p:0:0" : "map");
			const old = row?.querySelector(".md-local-image");
			const stills = [...(row?.querySelectorAll(".md-local-image") ?? [])];
			expect(stills).toHaveLength(2);
			const [was, now] = stills;
			expect(was?.closest("del.md-del, .md-old")).not.toBeNull();
			expect(now?.closest("del.md-del, .md-old")).toBeNull();
			expect(was?.querySelector(".md-image-alt")).toHaveTextContent(
				"Route map of the three ports",
			);
			expect(now?.querySelector(".md-image-alt")).toHaveTextContent(
				"Route map: Strandkaien, Nordnes and Askøy",
			);
			expect(old?.querySelector(".md-image-path")).toHaveTextContent(
				"img/route-map.png",
			);
		},
	);
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

	it('clusters to read that only the full diff shows: said as in the line view, never "Nothing to read"', async () => {
		const fx = docFixture(NEW, NEW, [], { since: true });
		const unshown: ClusterView = {
			key: "u1",
			kind: "lines",
			oldStart: 3,
			oldCount: 1,
			newStart: 3,
			newCount: 1,
			removed: ["x"],
			added: ["y"],
			lines: 2,
			state: "unreviewed",
		};
		show(
			{
				...fx,
				file: { ...fx.file, clusters: [unshown] },
				hunks: { ...fx.hunks, hunks: [], pieces: [] },
			},
			{
				from: 1,
				kinds: new Map([
					["u1", { key: "u1", kind: "reworked", from: 1 } as KindEntry],
				]),
			},
		);
		await doc();
		expect(screen.getByTestId("since-unshown")).toHaveTextContent(
			"1 to read · only in the full diff",
		);
		expect(screen.queryByTestId("since-empty")).toBeNull();
	});

	describe('"not reviewed in PS1" rows (CAR-216 orphans, CAR-328)', () => {
		// The head; the compared patch set's side is the same but for line 8.
		const HEAD_MD = [
			"# Title", // 1
			"",
			"New para one.", // 3: an orphan, "Old para one." in the base
			"",
			"- item a", // 5
			"- item b", // 6: "- item gone" was under it in the base (orphan)
			"",
			"Last para.", // 8: "Final para." at PS1 (the interdiff's change)
		];
		const OLD_MD = [...HEAD_MD.slice(0, 7), "Final para."];
		const ctx = (n: number): DiffLine => ({
			kind: "context",
			oldNo: n,
			newNo: n,
			text: HEAD_MD[n - 1] as string,
		});
		const cluster = (
			key: string,
			o: Partial<ClusterView> & Pick<ClusterView, "removed" | "added">,
		): ClusterView => ({
			key,
			kind: "lines",
			oldStart: 0,
			oldCount: o.removed.length,
			newStart: 0,
			newCount: o.added.length,
			lines: o.removed.length + o.added.length,
			state: "unreviewed",
			...o,
		});
		/** As the server sends them: placeOrphans' rows, sincePieces' pieces. */
		const orphanFixture = (): DocFixture => {
			const hunk = {
				oldStart: 1,
				oldCount: 8,
				newStart: 1,
				newCount: 8,
				lines: [
					ctx(1),
					ctx(2),
					// An orphan pair: the removed line has its base number only.
					{
						kind: "del",
						text: "Old para one.",
						clusterKey: "k1",
						baseNo: 3,
						orphan: true,
					},
					{
						kind: "add",
						newNo: 3,
						text: "New para one.",
						clusterKey: "k1",
						orphan: true,
					},
					ctx(4),
					ctx(5),
					ctx(6),
					// A removal only: no number on either side here.
					{
						kind: "del",
						text: "- item gone",
						clusterKey: "k3",
						baseNo: 7,
						orphan: true,
					},
					ctx(7),
					{
						kind: "del",
						oldNo: 8,
						text: "Final para.",
						clusterKey: "k2",
						baseNo: 9,
					},
					{ kind: "add", newNo: 8, text: "Last para.", clusterKey: "k2" },
				] as DiffLine[],
			};
			const pieces: SincePiece[] = [
				{
					hunk: 0,
					line: 2,
					key: "k1",
					orphan: true,
					owns: [[0, 2]],
					old: [],
					new: [[3, 4]],
				},
				{
					hunk: 0,
					line: 7,
					key: "k3",
					orphan: true,
					owns: [[0, 1]],
					old: [],
					new: [],
				},
				{
					hunk: 0,
					line: 9,
					key: "k2",
					owns: [[0, 2]],
					old: [[8, 9]],
					new: [[8, 9]],
				},
			];
			const fx = docFixture(OLD_MD, HEAD_MD, [], { since: true });
			return {
				file: {
					...fx.file,
					clusters: [
						cluster("k1", {
							oldStart: 3,
							newStart: 3,
							removed: ["Old para one."],
							added: ["New para one."],
						}),
						cluster("k3", {
							oldStart: 7,
							newStart: 6,
							removed: ["- item gone"],
							added: [],
						}),
						cluster("k2", {
							oldStart: 9,
							newStart: 8,
							removed: ["Old final."],
							added: ["Last para."],
						}),
					],
				},
				hunks: {
					hunks: [hunk],
					newLineCount: HEAD_MD.length,
					pieces,
					markdownBlocks: true,
				},
				// The context route: the interdiff's unchanged lines, all of them.
				context: [1, 2, 3, 4, 5, 6, 7].map(ctx),
			};
		};
		const kinds = new Map<string, KindEntry>(
			["k1", "k2", "k3"].map((k) => [
				k,
				{ key: k, kind: "reworked", from: 1 } as KindEntry,
			]),
		);

		it("render: each orphan run on its block with its box, its lines as source under it; nothing dropped", async () => {
			const onShowText = vi.fn();
			const onToggle = vi.fn();
			const fx = orphanFixture();
			show(fx, { from: 1, kinds, onShowText, onToggle, sideBySide: true });
			const root = await doc();
			expect(onShowText).not.toHaveBeenCalled();
			expectCoverage(root, ["p:0:2", "p:0:7", "p:0:9"]);
			// The orphan pair: on the paragraph at line 3 (block 1).
			const para = rowOf(root, "p:0:2") as HTMLElement;
			expect(para).toHaveAttribute("data-block", "1");
			expect(para.querySelector('[data-kind="unreviewed"]')).toHaveTextContent(
				"not reviewed in PS1",
			);
			const lines = (row: HTMLElement) =>
				[
					...row.querySelectorAll<HTMLElement>(
						'[data-testid="md-orphan"] [data-testid="md-hidden-line"]',
					),
				].map((l) => `${l.dataset.kind}:${l.textContent?.slice(1)}`);
			expect(lines(para)).toEqual(["del:Old para one.", "add:New para one."]);
			// The removal only: on the item above it ("- item b", block 3).
			const list = rowOf(root, "p:0:7") as HTMLElement;
			expect(list).toHaveAttribute("data-block", "3");
			expect(lines(list)).toEqual(["del:- item gone"]);
			// The interdiff's own change: as before, no orphan rows.
			const last = rowOf(root, "p:0:9") as HTMLElement;
			expect(last.querySelector('[data-testid="md-orphan"]')).toBeNull();
			// Its box ticks its piece of the cluster.
			await userEvent.click(
				boxOf(root, "p:0:7")?.querySelector("input") as HTMLInputElement,
			);
			expect(onToggle).toHaveBeenCalledWith(fx.file.clusters[1], [[0, 1]]);
		});

		it("a removal-only orphan with no new line to sit by fails closed to Text", async () => {
			const onShowText = vi.fn();
			const fx = orphanFixture();
			// Its row gone from the hunks: no place for it.
			const pieces = (fx.hunks.pieces ?? []).map((p) =>
				p.key === "k3" ? { ...p, hunk: 5 } : p,
			);
			show(
				{ ...fx, hunks: { ...fx.hunks, pieces } },
				{ from: 1, kinds, onShowText },
			);
			await waitFor(() => expect(onShowText).toHaveBeenCalled());
		});
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

describe("MarkdownView: threads, block comments, find", () => {
	it("a line thread shows under the block holding its line; every placed thread shows once, none dropped", async () => {
		const threads = [
			// "- three", the added item (k2).
			lineThread("onAdded", "RIGHT", 7),
			// "Para A": an unchanged block.
			lineThread("onSame", "RIGHT", 13),
			// The blank line after the fence: with the fence's block (k3).
			lineThread("onBlank", "RIGHT", 12),
			// "## Gone", removed (k4): its removal row.
			lineThread("onRemoved", "LEFT", 12),
			// An unchanged old line: the new line it is ("Para D").
			lineThread("onOldSame", "LEFT", 20),
			// Inside the fold ("## Usage"): on the fold while it is closed.
			lineThread("inFold", "RIGHT", 17),
		];
		show(docFixture(OLD, NEW, EDITS), { threads });
		const root = await doc();
		const k2 = keyOfUnit(root, "k2");
		const k3 = keyOfUnit(root, "k3");
		const k4 = keyOfUnit(root, "k4");
		expect(bubbleRows(root).sort()).toEqual(
			[k2, "s6", k3, k4, "s9", "f7"].sort(),
		);
		// Every thread on some row's bubble: one comment each.
		const bubbles = [...root.querySelectorAll('[data-testid="thread-bubble"]')];
		expect(bubbles.map((b) => b.getAttribute("aria-label"))).toEqual(
			bubbles.map(() => "1 comment on this block"),
		);
		// The fold opened: the thread goes with its block.
		await userEvent.click(screen.getByTestId("md-fold"));
		expect(bubbleRows(root)).toContain("s8");
		expect(bubbleRows(root)).not.toContain("f7");
	});

	it("a bubble opens its block's threads under it", async () => {
		show(docFixture(OLD, NEW, EDITS), {
			threads: [lineThread("t1", "RIGHT", 7)],
		});
		const root = await doc();
		const row = rowByKey(root, keyOfUnit(root, "k2") as string) as HTMLElement;
		const bubble = row.querySelector(
			'[data-testid="thread-bubble"]',
		) as HTMLElement;
		expect(row.querySelector('[data-testid="files-thread"]')).toBeNull();
		await userEvent.click(bubble);
		expect(bubble).toHaveAttribute("aria-expanded", "true");
		expect(
			row.querySelector('[data-testid="md-threads"] [data-thread="t1"]'),
		).toBeTruthy();
	});

	it("a comment button on each changed block (none on unchanged ones) opens a composer on its last cluster's changed lines, under the block", async () => {
		show(docFixture(OLD, NEW, EDITS));
		const root = await doc();
		const comments = [...root.querySelectorAll('[data-testid="md-comment"]')];
		const changeRows = [
			...root.querySelectorAll(
				'[data-testid="md-block"]:not([data-tone="same"])',
			),
		];
		expect(comments).toHaveLength(changeRows.length);
		for (const r of root.querySelectorAll('[data-tone="same"]')) {
			expect(r.querySelector('[data-testid="md-comment"]')).toBeNull();
		}
		// The added item: new line 7.
		const added = rowOf(root, "k2") as HTMLElement;
		await userEvent.click(
			added.querySelector('[data-testid="md-comment"]') as HTMLElement,
		);
		expect(getComposers().at(-1)?.span).toMatchObject({
			path: "README.md",
			commit: HEAD,
			subject: "line",
			startSide: "RIGHT",
			startLine: 7,
			side: "RIGHT",
			line: 7,
		});
		expect(await within(added).findByRole("textbox")).toBeInTheDocument();
		// The last of two clusters on one block: k7's line only.
		await userEvent.click(
			rowOf(root, "k7")?.querySelector(
				'[data-testid="md-comment"]',
			) as HTMLElement,
		);
		expect(getComposers().at(-1)?.span).toMatchObject({
			startSide: "RIGHT",
			startLine: 25,
			line: 25,
		});
		// A removal-only block: its old lines.
		await userEvent.click(
			rowOf(root, "k4")?.querySelector(
				'[data-testid="md-comment"]',
			) as HTMLElement,
		);
		expect(getComposers().at(-1)?.span).toMatchObject({
			startSide: "LEFT",
			startLine: 12,
			side: "LEFT",
			line: 13,
		});
	});

	it("read-only: the comment button says why, and opens nothing", async () => {
		show(docFixture(OLD, NEW, EDITS), { readOnly: true });
		const root = await doc();
		const button = rowOf(root, "k2")?.querySelector(
			'[data-testid="md-comment"]',
		) as HTMLElement;
		expect(button).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(button);
		expect(getComposers()).toHaveLength(0);
	});

	const LINKED_OLD = [
		"# T",
		"",
		"See [docs](https://example.com/guide) here.",
		"",
		"Para",
	];
	const LINKED_NEW = [
		"# T",
		"",
		"See [docs](https://example.com/guide) now.",
		"",
		"Para",
	];
	const findAt = (
		line: number,
		word: string,
		stepSeq: number,
		text = LINKED_NEW,
	): DiffFind => {
		const from = (text[line - 1] ?? "").indexOf(word);
		return {
			marksOf: (side, n) =>
				side === "RIGHT" && n === line
					? [{ from, to: from + word.length, current: true }]
					: [],
			current: { old: false, line },
			shown: true,
			stepSeq,
		};
	};

	it("find: a step lands on the block holding its hit; a hit only in a link's URL shows Text, once per step", async () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		const onFindText = vi.fn();
		const fx = docFixture(LINKED_OLD, LINKED_NEW, [
			{ key: "k", old: [3, 4], new: [3, 4] },
		]);
		const { update } = show(fx, { onFindText });
		const root = await doc();
		update({ find: findAt(3, "docs", 1) });
		await waitFor(() => expect(scrolled).toHaveBeenCalled());
		const row = rowOf(root, "k") as HTMLElement;
		expect(scrolled.mock.contexts.at(-1)).toBe(row);
		expect(row).toHaveAttribute("data-find-current", "true");
		expect(onFindText).not.toHaveBeenCalled();
		update({ find: findAt(3, "example", 2) });
		await waitFor(() => expect(onFindText).toHaveBeenCalledTimes(1));
	});

	it("find: mounted on a fresh step to a URL hit, it shows Text; on a spent one (FileDiff's), it stays", async () => {
		Element.prototype.scrollIntoView = vi.fn();
		const fx = docFixture(LINKED_OLD, LINKED_NEW, [
			{ key: "k", old: [3, 4], new: [3, 4] },
		]);
		const onFindText = vi.fn();
		show(fx, { onFindText, find: findAt(3, "example", 4) });
		await doc();
		await waitFor(() => expect(onFindText).toHaveBeenCalledTimes(1));
		cleanup();
		const spentText = vi.fn();
		show(fx, {
			onFindText: spentText,
			findSpent: true,
			find: findAt(3, "example", 4),
		});
		await doc();
		await new Promise((r) => setTimeout(r, 0));
		expect(spentText).not.toHaveBeenCalled();
	});

	it("find: a hit in a folded block opens the fold and lands there", async () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		const onFindText = vi.fn();
		const { update } = show(docFixture(OLD, NEW, EDITS), { onFindText });
		const root = await doc();
		update({ find: findAt(15, "Install", 1, NEW) });
		await waitFor(() =>
			expect(scrolled.mock.contexts.at(-1)).toBe(rowByKey(root, "s7")),
		);
		expect(screen.queryByTestId("md-fold")).toBeNull();
		expect(onFindText).not.toHaveBeenCalled();
	});
});

describe("MarkdownView, since view: threads and block comments", () => {
	it("threads show under their block in the since view", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		show(fx, {
			from: 1,
			threads: [lineThread("t1", "RIGHT", 3), lineThread("t2", "RIGHT", 13)],
		});
		const root = await doc();
		expect(bubbleRows(root).sort()).toEqual(
			[keyOfUnit(root, "p:0:0"), "s6"].sort(),
		);
	});

	it("a comment on a removal-only block posts on its base line (CAR-217)", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		// The compared patch set's old 12-13 are the base's 112-113, which
		// the full diff removes (its cluster k4, in the base's numbers).
		for (const l of fx.hunks.hunks[3]?.lines ?? []) {
			if (l.oldNo !== undefined) l.baseNo = l.oldNo + 100;
		}
		fx.file.clusters = fx.file.clusters.map((c) =>
			c.key === "k4" ? { ...c, oldStart: 112 } : c,
		);
		show(fx, { from: 1 });
		const root = await doc();
		const row = rowOf(root, "p:3:0") as HTMLElement;
		await userEvent.click(
			row.querySelector('[data-testid="md-comment"]') as HTMLElement,
		);
		expect(getComposers().at(-1)?.span).toMatchObject({
			commit: HEAD,
			startSide: "LEFT",
			startLine: 112,
			side: "LEFT",
			line: 113,
		});
		// Its composer is under the block that was clicked.
		expect(await within(row).findByRole("textbox")).toBeInTheDocument();
	});

	it("a comment on lines only the earlier patch set had posts on that patch set's commit (CAR-233)", async () => {
		const EARLIER = "e".repeat(40);
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		for (const l of fx.hunks.hunks[3]?.lines ?? []) {
			if (l.oldNo !== undefined) {
				l.baseNo = null;
				l.psNo = l.oldNo + 30;
			}
		}
		show(fx, { from: 1, earlierHead: EARLIER });
		const root = await doc();
		const row = rowOf(root, "p:3:0") as HTMLElement;
		await userEvent.click(
			row.querySelector('[data-testid="md-comment"]') as HTMLElement,
		);
		expect(getComposers().at(-1)?.span).toMatchObject({
			commit: EARLIER,
			earlier: true,
			startSide: "RIGHT",
			startLine: 42,
			side: "RIGHT",
			line: 43,
		});
		expect(await within(row).findByRole("textbox")).toBeInTheDocument();
	});

	it("a removed line GitHub has no line for: the button says why, and opens nothing", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		for (const l of fx.hunks.hunks[3]?.lines ?? []) {
			if (l.oldNo !== undefined) l.baseNo = null;
		}
		show(fx, { from: 1 });
		const root = await doc();
		const button = rowOf(root, "p:3:0")?.querySelector(
			'[data-testid="md-comment"]',
		) as HTMLElement;
		expect(button).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(button);
		expect(getComposers()).toHaveLength(0);
	});

	it("an earlier-only removal of 3 lines posts on that patch set's commit; mixed with base lines it is refused, as the line view refuses it", async () => {
		const EARLIER = "e".repeat(40);
		const OLD3 = ["# T", "", "one", "two", "three", "", "Para"];
		const NEW3 = ["# T", "", "Para"];
		const make = () =>
			docFixture(OLD3, NEW3, [{ key: "k", old: [3, 7] }], { since: true });
		let fx = make();
		for (const l of fx.hunks.hunks[0]?.lines ?? []) {
			if (l.oldNo !== undefined) {
				l.baseNo = null;
				l.psNo = l.oldNo + 10;
			}
		}
		show(fx, { from: 1, earlierHead: EARLIER });
		let root = await doc();
		let button = rowOf(root, "p:0:0")?.querySelector(
			'[data-testid="md-comment"]',
		) as HTMLElement;
		expect(button).not.toHaveAttribute("aria-disabled");
		await userEvent.click(button);
		expect(getComposers().at(-1)?.span).toMatchObject({
			commit: EARLIER,
			earlier: true,
			startLine: 13,
			line: 16,
		});
		cleanup();
		resetComposers();
		// Its ends only PS1's (one run there: 13, 14), its middle lines the
		// base's: mixed commits, refused (the ends alone would pass).
		fx = make();
		for (const l of fx.hunks.hunks[0]?.lines ?? []) {
			if (l.oldNo === undefined) continue;
			if (l.oldNo === 4 || l.oldNo === 5) l.baseNo = l.oldNo;
			else {
				l.baseNo = null;
				l.psNo = l.oldNo === 3 ? 13 : 14;
			}
		}
		show(fx, { from: 1, earlierHead: EARLIER });
		root = await doc();
		button = rowOf(root, "p:0:0")?.querySelector(
			'[data-testid="md-comment"]',
		) as HTMLElement;
		expect(button).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(button);
		expect(getComposers()).toHaveLength(0);
	});
});

describe("MarkdownView: comments being written in a fold", () => {
	it("a comment on a line of a folded block with no threads there shows on the fold's row, never nowhere", async () => {
		openComposer({
			path: "README.md",
			commit: HEAD,
			subject: "line",
			startSide: "RIGHT",
			startLine: 17,
			side: "RIGHT",
			line: 17,
		});
		show(docFixture(OLD, NEW, EDITS));
		const root = await doc();
		const fold = rowByKey(root, "f7") as HTMLElement;
		expect(fold).toBeTruthy();
		expect(fold.querySelector('[data-testid="md-fold"]')).toBeTruthy();
		expect(await within(fold).findByRole("textbox")).toBeInTheDocument();
	});
});

/** An agent thread asked on `line` of the viewed head. */
const agentThread = (line: number): AgentThread =>
	({
		id: `A${line}`,
		anchor: {
			subject: "line",
			path: "README.md",
			commit: HEAD,
			side: "RIGHT",
			line,
			startSide: "RIGHT",
			startLine: line,
		},
		openedBy: "human",
		at: "2026-11-07T10:00:00Z",
		messages: [
			{ id: "m1", by: "human", at: "2026-11-07T10:00:00Z", text: "why?" },
		],
		resolved: false,
		waiting: true,
		unread: false,
	}) as AgentThread;

describe("MarkdownView: Resolve and the agent's threads, as in the line view", () => {
	it("Resolve closes a thread under a block down to its bubble; opened again, it shows", async () => {
		window.scrollTo = vi.fn();
		window.scrollBy = vi.fn();
		show(docFixture(OLD, NEW, EDITS), {
			threads: [lineThread("t1", "RIGHT", 7)],
		});
		const root = await doc();
		const row = rowOf(root, "k2") as HTMLElement;
		const bubble = within(row).getByTestId("thread-bubble");
		await userEvent.click(bubble);
		expect(within(row).getByTestId("files-thread")).toBeInTheDocument();
		await userEvent.click(within(row).getByRole("button", { name: "Resolve" }));
		expect(within(row).queryByTestId("files-thread")).toBeNull();
		expect(bubble).toHaveAttribute("aria-expanded", "false");
		await waitFor(() => expect(bubble).toHaveFocus());
		await userEvent.click(bubble);
		expect(within(row).getByTestId("files-thread")).toBeInTheDocument();
	});

	it("an agent thread on a line shows under its block with its own bubble, once; in a fold, on the fold's row", async () => {
		show(docFixture(OLD, NEW, EDITS), {
			agentThreads: [agentThread(7), agentThread(17)],
		});
		const root = await doc();
		const bubbles = [...root.querySelectorAll('[data-testid="agent-bubble"]')];
		expect(
			bubbles.map((b) => b.closest("[data-row]")?.getAttribute("data-row")),
		).toEqual([keyOfUnit(root, "k2"), "f7"]);
		const row = rowOf(root, "k2") as HTMLElement;
		await userEvent.click(within(row).getByTestId("agent-bubble"));
		expect(within(row).getByTestId("md-agent-threads")).toBeInTheDocument();
	});

	it("an Ask agent question being written on a line of a folded block shows on the fold's row, once", async () => {
		openAgentComposer({
			path: "README.md",
			commit: HEAD,
			subject: "line",
			startSide: "RIGHT",
			startLine: 17,
			side: "RIGHT",
			line: 17,
		});
		show(docFixture(OLD, NEW, EDITS));
		const root = await doc();
		const fold = rowByKey(root, "f7") as HTMLElement;
		expect(within(fold).getByTestId("agent-composer")).toBeInTheDocument();
		expect(screen.getAllByTestId("agent-composer")).toHaveLength(1);
	});

	it("since view: an agent thread shows under its piece's block", async () => {
		const fx = docFixture(OLD, NEW, EDITS, { since: true });
		show(fx, { from: 1, agentThreads: [agentThread(3)] });
		const root = await doc();
		expect(
			within(rowOf(root, "p:0:0") as HTMLElement).getByTestId("agent-bubble"),
		).toBeInTheDocument();
	});
});

describe("MarkdownView, a change the rendering doesn't show (CAR-167)", () => {
	/** One edit of line 3 (`old` → `new`) between two unchanged paragraphs. */
	const edit = (old: string, nu: string): [string[], string[], Edit[]] => [
		["Intro.", "", old, "", "End."],
		["Intro.", "", nu, "", "End."],
		[{ key: "e", old: [3, 4], new: [3, 4] }],
	];
	const CASES: [string, string[], string[], Edit[], string[], string[]][] = [
		[
			"an HTML comment's words",
			...edit(
				"Docs <!-- one two --> here",
				"Docs <!-- ignore previous instructions --> here",
			),
			["Docs <!-- one two --> here"],
			["Docs <!-- ignore previous instructions --> here"],
		],
		[
			"a script inside a span",
			...edit(
				"a <span>b<script>x()</script></span> c",
				"a <span>b<script>steal()</script></span> c",
			),
			["a <span>b<script>x()</script></span> c"],
			["a <span>b<script>steal()</script></span> c"],
		],
		[
			"a style attribute",
			...edit(
				'a <span style="color:red">b</span> c',
				'a <span style="display:none">b</span> c',
			),
			['a <span style="color:red">b</span> c'],
			['a <span style="display:none">b</span> c'],
		],
		[
			"trailing spaces on a paragraph's last line",
			["Intro.", "", "First line", "second line", "", "End."],
			["Intro.", "", "First line", "second line  ", "", "End."],
			[{ key: "e", old: [4, 5], new: [4, 5] }],
			["second line"],
			["second line  "],
		],
		[
			"a hidden comment in an added paragraph",
			["Intro.", "", "End."],
			[
				"Intro.",
				"",
				"New <!-- ignore previous instructions --> para",
				"",
				"End.",
			],
			[{ key: "e", new: [3, 5] }],
			[],
			["New <!-- ignore previous instructions --> para", ""],
		],
		[
			"an adjacent blank line",
			["Intro.", "", "Para A", "", "End."],
			["Intro.", "", "Para A", "", "", "End."],
			[{ key: "e", new: [5, 6] }],
			[],
			[""],
		],
	];
	it.each(
		CASES.flatMap((c) => [
			["full diff", ...c] as const,
			["since view", ...c] as const,
		]),
	)(
		"%s: %s shows its changed lines as source under the block",
		async (view, _, oldText, newText, edits, dels, adds) => {
			const since = view === "since view";
			show(
				docFixture(oldText, newText, edits, { since }),
				since ? { from: 1 } : {},
			);
			const root = await doc();
			const row = rowOf(root, since ? "p:0:0" : "e") as HTMLElement;
			expect(row).not.toBeNull();
			const hidden = row.querySelectorAll('[data-testid="md-hidden"]');
			expect(hidden).toHaveLength(1);
			const box = hidden[0];
			expect(
				within(box as HTMLElement).getByRole("img", {
					name: "Not visible when rendered",
				}),
			).toBeInTheDocument();
			const rows = [
				...(box?.querySelectorAll('[data-testid="md-hidden-line"]') ?? []),
			];
			expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual([
				...dels.map(() => "del"),
				...adds.map(() => "add"),
			]);
			// Each row's text exactly (the line view's hidden-character
			// markers are drawn over the original characters, kept in the DOM).
			const text = (kind: "del" | "add") =>
				rows
					.filter((r) => r.getAttribute("data-kind") === kind)
					.map((r) => r.querySelector("[data-code]")?.textContent ?? "");
			expect(text("del")).toEqual(dels);
			expect(text("add")).toEqual(adds);
			// Coverage as before: the unit's box stays on its block.
			expectCoverage(root, [since ? "p:0:0" : "e"]);
		},
	);

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"%s: a change the rendering shows gets no source rows; a doubled space does",
		async (_, since) => {
			show(docFixture(OLD, NEW, EDITS, { since }), since ? { from: 1 } : {});
			const root = await doc();
			// Only k5's row: "Para E" → "Para  E" looks the same rendered.
			const rows = [...root.querySelectorAll('[data-testid="md-hidden"]')].map(
				(h) =>
					h.closest('[data-testid="md-block"]')?.getAttribute("data-units"),
			);
			expect(rows).toEqual([since ? "p:4:0" : "k5"]);
		},
	);

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"side by side (%s): each column shows its own side's lines",
		async (_, since) => {
			vi.stubGlobal(
				"matchMedia",
				vi.fn(() => ({
					matches: true,
					addEventListener: () => {},
					removeEventListener: () => {},
				})),
			);
			const [o, n, e] = edit(
				"Docs <!-- one two --> here",
				"Docs <!-- ignore previous instructions --> here",
			);
			show(
				docFixture(o, n, e, { since }),
				since ? { sideBySide: true, from: 1 } : { sideBySide: true },
			);
			const root = await doc();
			const row = rowOf(root, since ? "p:0:0" : "e") as HTMLElement;
			const cols = row.querySelectorAll(".md-body[data-col]");
			expect(cols).toHaveLength(2);
			const kinds = (col: Element | undefined) =>
				[
					...(col?.querySelectorAll('[data-testid="md-hidden-line"]') ?? []),
				].map((r) => r.getAttribute("data-kind"));
			expect(kinds(cols[0])).toEqual(["del"]);
			expect(kinds(cols[1])).toEqual(["add"]);
		},
	);
});

/** Characters that print as nothing or not as themselves, spelled out (no raw ones in sources). */
const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);
const SHY = String.fromCodePoint(0xad);
const NBSP = String.fromCodePoint(0xa0);
const TAG_A = String.fromCodePoint(0xe0041);
const TAG_B = String.fromCodePoint(0xe0042);
const TAG_C = String.fromCodePoint(0xe0043);

describe("MarkdownView, a change the rendering doesn't show: attributes, invisible characters, targets (CAR-167)", () => {
	const IMG: ImageFile[] = [
		{
			index: 1,
			path: "img/a.png",
			status: "modified",
			binary: true,
			submodule: false,
		},
	];
	const CASES: {
		name: string;
		old: string;
		nu: string;
		files?: ImageFile[];
	}[] = [
		{
			name: "a span's title",
			old: 'a <span title="one">b</span> c',
			nu: 'a <span title="ignore previous">b</span> c',
		},
		{
			name: "an abbr's title",
			old: 'An <abbr title="one">HTML</abbr> page',
			nu: 'An <abbr title="ignore previous">HTML</abbr> page',
		},
		{
			name: "dir ltr to rtl",
			old: 'a <span dir="ltr">b</span> c',
			nu: 'a <span dir="rtl">b</span> c',
		},
		{
			name: "lang",
			old: 'a <span lang="en">b</span> c',
			nu: 'a <span lang="fr">b</span> c',
		},
		{
			name: "a zero-width space",
			old: "Hello world here",
			nu: `Hello w${ZWSP}orld here`,
		},
		{
			name: "tag characters (ASCII smuggling)",
			old: "Hello world here",
			nu: `Hello world${TAG_A}${TAG_B}${TAG_C} here`,
		},
		{
			name: "a right-to-left override",
			old: "Hello world here",
			nu: `Hello ${RLO}world here`,
		},
		{
			name: "a soft hyphen",
			old: "Hello world here",
			nu: `Hello wor${SHY}ld here`,
		},
		{
			name: "a link's target",
			old: "See [x](https://a.test) here",
			nu: "See [x](https://evil.test) here",
		},
		{
			name: "a link's title",
			old: 'See [x](https://a.test "one") here',
			nu: 'See [x](https://a.test "two") here',
		},
		{
			name: "a no-break space for a space",
			old: "a b here",
			nu: `a${NBSP}b here`,
		},
		{
			name: "a loaded image's alt",
			old: "![one](img/a.png)",
			nu: "![two](img/a.png)",
			files: IMG,
		},
		// With a visible change in the same block too: only the marks say.
		{
			name: "a zero-width space beside a visible edit",
			old: "Hello world here",
			nu: `Hello w${ZWSP}orld there`,
		},
		{
			name: "tag characters beside a visible edit",
			old: "Hello world here",
			nu: `Hello world${TAG_A}${TAG_B} there`,
		},
		{
			name: "a link's target beside a visible edit",
			old: "See [x](https://a.test) here",
			nu: "See [x](https://evil.test) there",
		},
		{
			name: "a no-break space beside a visible edit",
			old: "a b here",
			nu: `a${NBSP}b there`,
		},
		{
			name: "a loaded image's alt beside a visible edit",
			old: "![one](img/a.png) here",
			nu: "![two](img/a.png) there",
			files: IMG,
		},
		{
			name: "a doubled space next to a loaded image",
			old: "![a](img/a.png) text",
			nu: "![a](img/a.png)  text",
			files: IMG,
		},
	];
	const fixture = (c: (typeof CASES)[number], since: boolean) =>
		docFixture(
			["Intro.", "", c.old, "", "End."],
			["Intro.", "", c.nu, "", "End."],
			[{ key: "e", old: [3, 4], new: [3, 4] }],
			{ since },
		);

	it.each(
		CASES.flatMap((c) => [
			["full diff", c.name, c] as const,
			["since view", c.name, c] as const,
		]),
	)("%s: %s shows its changed lines as source", async (view, _, c) => {
		const since = view === "since view";
		show(fixture(c, since), {
			...(since ? { from: 1 } : {}),
			...(c.files ? { files: c.files } : {}),
		});
		const root = await doc();
		const row = rowOf(root, since ? "p:0:0" : "e") as HTMLElement;
		const hidden = row.querySelector('[data-testid="md-hidden"]');
		expect(hidden).not.toBeNull();
		const text = (kind: string) =>
			[
				...(hidden?.querySelectorAll(
					`[data-testid="md-hidden-line"][data-kind="${kind}"] [data-code]`,
				) ?? []),
			].map((l) => l.textContent);
		expect(text("del")).toEqual([c.old]);
		expect(text("add")).toEqual([c.nu]);
	});

	it.each([
		["full diff", false],
		["since view", true],
	])(
		"%s: the source rows draw hidden characters even with the setting off",
		async (_, since) => {
			showInvisibles.set(false);
			try {
				show(
					fixture(
						{ name: "", old: "Hello world.", nu: "Hello world.  " },
						since,
					),
					since ? { from: 1 } : {},
				);
				const root = await doc();
				const line = root.querySelector(
					'[data-testid="md-hidden-line"][data-kind="add"]',
				);
				// The trailing spaces: the change itself.
				expect(line?.querySelector('[data-inv="space"]')).not.toBeNull();
			} finally {
				showInvisibles.set(true);
			}
		},
	);
});
