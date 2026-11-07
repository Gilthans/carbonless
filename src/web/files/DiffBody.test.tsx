// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldJson } from "../../../test/loading";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	ReviewThread,
} from "../../shared/types";
import { openComposer, resetComposers } from "../threads/newThreads";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { contextRanges } from "./contextRanges";
import {
	DiffBody,
	type DiffFind,
	type DiffThreads,
	type FileLead,
	LANDED_MS,
	numberDigits,
} from "./DiffBody";
import type { Landing } from "./landing";
import { setPicks } from "./linePicks";
import type { CodeSpan } from "./selectionActions";
import { ThreadBubble } from "./ThreadBubble";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

const HEAD = "h".repeat(40);
const PATH = "src/a.ts";

const cluster = (
	key: string,
	over: Partial<ClusterView> = {},
): ClusterView => ({
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

const file = (clusters: ClusterView[]): FileView => ({
	index: 0,
	path: PATH,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 4,
	deletions: 4,
	clusters,
	done: false,
	reviewed: false,
	crossedOff: false,
});

const ctx = (oldNo: number, newNo: number): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text: `line ${newNo}`,
});
const del = (oldNo: number, text: string, clusterKey: string): DiffLine => ({
	kind: "del",
	oldNo,
	text,
	clusterKey,
});
const add = (newNo: number, text: string, clusterKey: string): DiffLine => ({
	kind: "add",
	newNo,
	text,
	clusterKey,
});

/**
 * Two clusters: lines 2–4 re-indented (whitespace only), line 8 really
 * changed with line 9 re-indented (mixed).
 */
const hunks: FileHunks = {
	newLineCount: 12,
	hunks: [
		{
			oldStart: 1,
			oldCount: 12,
			newStart: 1,
			newCount: 12,
			lines: [
				ctx(1, 1),
				del(2, "\tif (a) {", "ws"),
				del(3, "\t\treturn b;\r", "ws"),
				del(4, "\t}", "ws"),
				add(2, "  if (a) {", "ws"),
				add(3, "    return b;", "ws"),
				add(4, "  }", "ws"),
				ctx(5, 5),
				ctx(6, 6),
				ctx(7, 7),
				del(8, "const x = 1;", "mixed"),
				del(9, "\tconst y = 2;", "mixed"),
				add(8, "const x = 2;", "mixed"),
				add(9, "  const y = 2;", "mixed"),
				ctx(10, 10),
				ctx(11, 11),
				ctx(12, 12),
			],
		},
	],
};

const clusters = [
	cluster("ws", {
		oldStart: 2,
		oldCount: 3,
		newStart: 2,
		newCount: 3,
		lines: 6,
	}),
	cluster("mixed", {
		oldStart: 8,
		oldCount: 2,
		newStart: 8,
		newCount: 2,
		lines: 4,
	}),
];

let ids = 0;
const thread = (side: "LEFT" | "RIGHT", line: number): ReviewThread => {
	ids += 1;
	return {
		id: `T${ids}`,
		loaded: true,
		path: PATH,
		line,
		currentLine: line,
		excerpt: "a comment",
		html: "<p>a comment</p>",
		body: "a comment",
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "rev",
		avatarUrl: "",
		participants: [],
		bot: false,
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: {
			path: PATH,
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
		viewerCan: { reply: false, resolve: false, unresolve: false },
	};
};

function setup(
	opts: {
		threads?: ReviewThread[];
		landing?: Landing;
		clusters?: ClusterView[];
		hunks?: FileHunks;
		lead?: FileLead;
		/** Two files' tables in one tree (the same file twice). */
		twice?: boolean;
		/** The page's query client, kept when a file closes and opens again. */
		queryClient?: QueryClient;
		/** The find's view of the file. */
		find?: DiffFind;
		/** The hunks' answer, when the test holds it. */
		hunksResponse?: Promise<Response>;
	} = {},
) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://test");
		if (url.pathname === "/api/files/0/hunks" && opts.hunksResponse) {
			return opts.hunksResponse;
		}
		const body =
			url.pathname === "/api/files/0/hunks"
				? (opts.hunks ?? hunks)
				: url.pathname === "/api/comments"
					? { threads: [] }
					: url.pathname === "/api/files/0/context"
						? Array.from(
								{
									length:
										Number(url.searchParams.get("newTo")) -
										Number(url.searchParams.get("newFrom")) +
										1,
								},
								(_, i) => {
									const n = Number(url.searchParams.get("newFrom")) + i;
									return ctx(n, n);
								},
							)
						: {};
		return new Response(JSON.stringify(body), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const queryClient =
		opts.queryClient ??
		new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	const onToggle = vi.fn();
	const onCrossOff = vi.fn();
	const threads: DiffThreads | undefined = opts.threads
		? { readId: "r", snapshotHead: HEAD, threads: opts.threads }
		: undefined;
	const fileView = file(opts.clusters ?? clusters);
	const tree = (find: DiffFind | undefined) => {
		const body = (
			<DiffBody
				file={fileView}
				revision="r1"
				onToggle={onToggle}
				onCrossOff={onCrossOff}
				threads={threads}
				landing={opts.landing}
				lead={opts.lead}
				find={find}
			/>
		);
		return (
			<QueryClientProvider client={queryClient}>
				{body}
				{opts.twice && body}
			</QueryClientProvider>
		);
	};
	const { container, rerender } = render(tree(opts.find));
	const rows = () =>
		Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid="diff-line"]'),
		).map((row) => ({
			kind: row.dataset.kind,
			old: row.dataset.oldNo ?? "",
			new: row.dataset.newNo ?? "",
			// After the sign (or a bubble's count before it).
			text: (row.querySelector("td:last-child")?.textContent ?? "")
				.replace(/^.*?[+−~ ]/, "")
				.trim(),
		}));
	const collapsed = () =>
		Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid="ws-cluster"]'),
		);
	const calls = () => fetchMock.mock.calls.map(([input]) => String(input));
	return {
		onToggle,
		onCrossOff,
		rows,
		collapsed,
		calls,
		user: userEvent.setup(),
		/** DiffBody's own root element. */
		root: container.firstElementChild as HTMLElement,
		/** The same DiffBody with another find. */
		refind: (find: DiffFind | undefined) => rerender(tree(find)),
	};
}

describe("DiffBody with Ignore whitespace", () => {
	beforeEach(() => {
		showInvisibles.set(false);
		ignoreWhitespace.set(true);
		window.scrollTo = vi.fn();
	});
	afterEach(() => {
		cleanup();
		contextRanges.reset();
		vi.unstubAllGlobals();
		localStorage.clear();
		showInvisibles.reset();
		ignoreWhitespace.reset();
	});

	it("collapses a whitespace-only cluster to one row with its controls, and pairs lines in a mixed one", async () => {
		const { rows, collapsed, onToggle, calls, user } = setup();
		await screen.findByText("Whitespace only · 6 lines");
		// The whitespace-only cluster is one collapsed row; the mixed one
		// keeps its real change as add/del rows among whitespace-only rows.
		expect(collapsed()).toHaveLength(1);
		expect(rows()).toEqual([
			{ kind: "context", old: "1", new: "1", text: "line 1" },
			{ kind: "context", old: "5", new: "5", text: "line 5" },
			{ kind: "context", old: "6", new: "6", text: "line 6" },
			{ kind: "context", old: "7", new: "7", text: "line 7" },
			{ kind: "del", old: "8", new: "", text: "const x = 1;" },
			{ kind: "add", old: "", new: "8", text: "const x = 2;" },
			{ kind: "ws", old: "9", new: "9", text: "const y = 2;" },
			{ kind: "context", old: "10", new: "10", text: "line 10" },
			{ kind: "context", old: "11", new: "11", text: "line 11" },
			{ kind: "context", old: "12", new: "12", text: "line 12" },
		]);
		expect(
			screen.getAllByRole("img", { name: "Whitespace only" }),
		).toHaveLength(1);
		// Every cluster keeps its checkbox; nothing is toggled without a click.
		const boxes = screen.getAllByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(boxes).toHaveLength(2);
		expect(onToggle).not.toHaveBeenCalled();
		expect(calls()).toEqual(["/api/files/0/hunks?revision=r1"]);
		const row = collapsed()[0] as HTMLElement;
		await user.click(
			within(row).getByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		expect(onToggle).toHaveBeenCalledWith(clusters[0]);

		// Expanding shows the pairs below the row: both numbers, the new text.
		// The chevron and the text are one disclosure button, named by its
		// visible text; `aria-expanded` carries the state.
		const expand = within(row).getByRole("button", {
			name: "Whitespace only · 6 lines",
		});
		expect(expand).not.toHaveAttribute("aria-label");
		expect(expand).toHaveAttribute("aria-expanded", "false");
		// Besides the cluster's cross-off control, it's the row's only button.
		expect(
			within(row)
				.getAllByRole("button")
				.map((b) => b.getAttribute("aria-label") ?? b.textContent),
		).toEqual(["Cross off cluster", "Whitespace only · 6 lines"]);
		// It controls the rows' container (the cluster's tbody).
		const controls = expand.getAttribute("aria-controls") ?? "";
		expect(document.getElementById(controls)).toBe(row.closest("tbody"));
		await user.click(expand);
		expect(expand).toHaveAttribute("aria-expanded", "true");
		expect(
			document.getElementById(controls)?.querySelectorAll('[data-kind="ws"]'),
		).toHaveLength(3);
		expect(rows().slice(1, 4)).toEqual([
			{ kind: "ws", old: "2", new: "2", text: "if (a) {" },
			{ kind: "ws", old: "3", new: "3", text: "return b;" },
			{ kind: "ws", old: "4", new: "4", text: "}" },
		]);
		expect(row).toHaveAttribute("data-expanded");
		// The same button, still named by its text, collapses them.
		await user.click(
			within(row).getByRole("button", { name: "Whitespace only · 6 lines" }),
		);
		expect(expand).toHaveAttribute("aria-expanded", "false");
		expect(row).not.toHaveAttribute("data-expanded");
		expect(rows()).toHaveLength(10);

		// Clicking the words themselves (not the chevron) toggles too.
		const text = within(row).getByText("Whitespace only · 6 lines");
		expect(text.tagName).not.toBe("BUTTON");
		expect(text.closest("button")).toBe(expand);
		await user.click(text);
		expect(expand).toHaveAttribute("aria-expanded", "true");
		expect(rows().filter((r) => r.kind === "ws")).toHaveLength(4);
		await user.click(text);
		expect(expand).toHaveAttribute("aria-expanded", "false");
		expect(rows()).toHaveLength(10);

		// Off: every line as it is, re-rendered in place without a fetch.
		act(() => ignoreWhitespace.set(false));
		expect(collapsed()).toHaveLength(0);
		expect(rows().map((r) => r.kind)).toEqual([
			"context",
			"del",
			"del",
			"del",
			"add",
			"add",
			"add",
			"context",
			"context",
			"context",
			"del",
			"del",
			"add",
			"add",
			"context",
			"context",
			"context",
		]);
		expect(screen.queryByRole("img", { name: "Whitespace only" })).toBeNull();
		expect(calls()).toEqual(["/api/files/0/hunks?revision=r1"]);
		// On again: collapsed again.
		act(() => ignoreWhitespace.set(true));
		expect(collapsed()).toHaveLength(1);
		expect(rows()).toHaveLength(10);
	});

	it("shows a whitespace-only pair's invisibles when hidden characters are on", async () => {
		const { rows } = setup();
		await screen.findByText("Whitespace only · 6 lines");
		act(() => showInvisibles.set(true));
		const pair = document.querySelector('[data-kind="ws"]');
		expect(pair?.querySelectorAll('[data-inv="space"]')).toHaveLength(1);
		expect(pair?.querySelector('[data-inv="eol"]')).not.toBeNull();
		expect(rows()).toHaveLength(10);
	});

	it("keeps a whitespace-only cluster open when a thread sits on one of its lines, on either side", async () => {
		const { rows, collapsed } = setup({ threads: [thread("LEFT", 3)] });
		await screen.findByText("Whitespace only · 6 lines");
		expect(collapsed()[0]).toHaveAttribute("data-expanded");
		const pair = rows()[2];
		expect(pair).toEqual({
			kind: "ws",
			old: "3",
			new: "3",
			text: expect.stringContaining("return b;"),
		});
		const row = document.querySelector('[data-kind="ws"][data-old-no="3"]');
		expect(row).toHaveAttribute("data-commented");
		// The thread is on the pair's old side, and says so.
		expect(
			within(row as HTMLElement).getByTestId("thread-bubble"),
		).toHaveAccessibleName("1 comment on old line 3");
		// Nothing can hide the bubble: no collapse, and no chevron, while
		// it's there: the pinned row's text is a plain span, not a button.
		const pinnedRow = collapsed()[0] as HTMLElement;
		expect(
			within(pinnedRow)
				.getAllByRole("button")
				.map((b) => b.getAttribute("aria-label")),
		).toEqual(["Cross off cluster"]);
		expect(
			screen.queryByRole("button", { name: "Whitespace only · 6 lines" }),
		).toBeNull();
		const text = within(pinnedRow).getByText("Whitespace only · 6 lines");
		expect(text.closest("button")).toBeNull();
		expect(pinnedRow.querySelector("svg")).toBeNull();
	});

	it("turning Ignore whitespace on after focusing a number in a whitespace-only cluster keeps one number button in the tab order", async () => {
		ignoreWhitespace.set(false);
		setup();
		const old3 = await screen.findByRole("button", { name: "Old line 3" });
		old3.focus();
		// On: the cluster collapses, and the focused number with it.
		act(() => ignoreWhitespace.set(true));
		await screen.findByText("Whitespace only · 6 lines");
		expect(screen.queryByRole("button", { name: "Old line 3" })).toBeNull();
		const stops = [
			...document.querySelectorAll<HTMLButtonElement>("button[data-pick]"),
		].filter((b) => b.tabIndex === 0);
		expect(stops).toHaveLength(1);
	});

	for (const view of ["unified", "side-by-side"] as const) {
		it(`keeps a whitespace-only cluster open while one of its lines is picked (${view})`, async () => {
			sideBySide.set(view === "side-by-side");
			try {
				const { collapsed } = setup();
				await screen.findByText("Whitespace only · 6 lines");
				expect(collapsed()[0]).not.toHaveAttribute("data-expanded");
				// The pair's old line, picked (by its number, linePicks.ts).
				const line = {
					side: "LEFT" as const,
					line: 3,
					len: 1,
					hunk: "h0",
					order: 2,
					path: PATH,
				};
				act(() =>
					setPicks({ path: PATH, anchor: line, focus: line, lines: [line] }),
				);
				expect(collapsed()[0]).toHaveAttribute("data-expanded");
				// Shown: a `~` row, or a pair row with a `~` cell on each side.
				const row = document.querySelector(
					'[data-testid="diff-line"][data-old-no="3"]',
				);
				expect(row).not.toBeNull();
				expect(row?.querySelector('[data-kind="ws"]') ?? row).toHaveAttribute(
					"data-kind",
					"ws",
				);
				expect(row?.closest("table")).toHaveAttribute("data-view", view);
				// Pinned: no button to collapse it.
				expect(
					screen.queryByRole("button", { name: "Whitespace only · 6 lines" }),
				).toBeNull();
				act(() => setPicks(null));
				// Let go: the rows stay under the reviewer, the button is back.
				expect(collapsed()[0]).toHaveAttribute("data-expanded");
				expect(
					screen.getByRole("button", { name: "Whitespace only · 6 lines" }),
				).toHaveAttribute("aria-expanded", "true");
			} finally {
				setPicks(null);
				sideBySide.reset();
			}
		});
	}

	it("names a thread on a pair's new side by its new number", async () => {
		const { rows } = setup({ threads: [thread("RIGHT", 2)] });
		await screen.findByText("Whitespace only · 6 lines");
		expect(rows()[1]?.kind).toBe("ws");
		const row = document.querySelector('[data-kind="ws"][data-new-no="2"]');
		expect(
			within(row as HTMLElement).getByTestId("thread-bubble"),
		).toHaveAccessibleName("1 comment on line 2");
	});

	it("keeps a whitespace-only cluster open while one of its lines is landed on", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { rows, collapsed } = setup({
				landing: { path: PATH, line: 4, side: "RIGHT", index: 0, seq: 1 },
			});
			await screen.findByText("Whitespace only · 6 lines");
			expect(collapsed()[0]).toHaveAttribute("data-expanded");
			expect(rows().filter((r) => r.kind === "ws")).toHaveLength(4);
			expect(
				document.querySelector('[data-kind="ws"][data-new-no="4"]'),
			).toHaveAttribute("data-landed");
			expect(screen.queryByTestId("landing-hint")).toBeNull();
			expect(
				screen.queryByRole("button", { name: "Whitespace only · 6 lines" }),
			).toBeNull();
			// Once the highlight has faded the rows stay where the reviewer
			// landed, and the chevron is back to collapse them.
			act(() => {
				vi.advanceTimersByTime(LANDED_MS + 1100);
			});
			expect(collapsed()[0]).toHaveAttribute("data-expanded");
			expect(rows().filter((r) => r.kind === "ws")).toHaveLength(4);
			expect(
				document.querySelector('[data-kind="ws"][data-new-no="4"]'),
			).not.toHaveAttribute("data-landed");
			const hide = screen.getByRole("button", {
				name: "Whitespace only · 6 lines",
			});
			expect(hide).toHaveAttribute("aria-expanded", "true");
			await userEvent
				.setup({ advanceTimers: vi.advanceTimersByTime })
				.click(hide);
			expect(collapsed()[0]).not.toHaveAttribute("data-expanded");
			expect(rows().filter((r) => r.kind === "ws")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows a line whose twin is a context line or in another cluster as a one-sided row", async () => {
		// Git's shape for a re-indented block whose `}` byte-matched another.
		const split: FileHunks = {
			newLineCount: 12,
			hunks: [
				{
					oldStart: 7,
					oldCount: 6,
					newStart: 7,
					newCount: 6,
					lines: [
						ctx(7, 7),
						del(8, "  if (x) {", "A"),
						add(8, "    if (x) {", "A"),
						add(9, "    }", "A"),
						add(10, "    sum += 1;", "A"),
						{ kind: "context", oldNo: 9, newNo: 11, text: "  }" },
						del(10, "  sum += 1;", "B"),
						del(11, "}", "B"),
						ctx(12, 12),
					],
				},
			],
		};
		const { rows, collapsed, user } = setup({
			hunks: split,
			clusters: [
				cluster("A", {
					oldStart: 8,
					oldCount: 1,
					newStart: 8,
					newCount: 3,
					lines: 4,
				}),
				cluster("B", {
					oldStart: 10,
					oldCount: 2,
					newStart: 12,
					newCount: 0,
					lines: 2,
				}),
			],
		});
		await screen.findByText("Whitespace only · 4 lines");
		expect(screen.getByText("Whitespace only · 2 lines")).toBeInTheDocument();
		expect(collapsed()).toHaveLength(2);
		expect(rows().map((r) => r.kind)).toEqual([
			"context",
			"context",
			"context",
		]);
		for (const button of screen.getAllByRole("button", {
			name: /^Whitespace only · \d+ lines$/,
		})) {
			expect(button).toHaveAttribute("aria-expanded", "false");
			await user.click(button);
			expect(button).toHaveAttribute("aria-expanded", "true");
		}
		const sides = Array.from(
			document.querySelectorAll<HTMLElement>('[data-kind="ws"]'),
		).map((row) => [
			row.dataset.ws,
			row.dataset.oldNo ?? "",
			row.dataset.newNo ?? "",
		]);
		expect(sides).toEqual([
			["pair", "8", "8"],
			["new", "", "9"],
			["new", "", "10"],
			["old", "10", ""],
			["old", "11", ""],
		]);
		expect(rows().filter((r) => r.kind === "add" || r.kind === "del")).toEqual(
			[],
		);
		expect(
			screen.getAllByRole("img", { name: "Whitespace only" }),
		).toHaveLength(5);
	});

	it("renders a crossed-off whitespace-only cluster's note on its row", async () => {
		const { collapsed } = setup({
			clusters: [
				{
					...(clusters[0] as ClusterView),
					state: "crossed-off",
					reason: "gen",
				},
				clusters[1] as ClusterView,
			],
		});
		await screen.findByText("Whitespace only · 6 lines");
		expect(collapsed()[0]).toHaveTextContent("Crossed off: gen");
		expect(
			within(collapsed()[0] as HTMLElement).getByRole("checkbox", {
				name: "Undo cross-off",
			}),
		).toBeInTheDocument();
	});

	it("keeps the controls, the collapsed row's words and a cross-off note out of a text selection", async () => {
		setup({
			clusters: [
				{
					...(clusters[0] as ClusterView),
					state: "crossed-off",
					reason: "gen",
				},
				clusters[1] as ClusterView,
			],
		});
		await screen.findByText("Whitespace only · 6 lines");
		// Every cluster's controls cell (the checkbox and the ⊘), on the
		// collapsed row and on a line row.
		const cells = screen
			.getAllByRole("checkbox")
			.map((box) => box.closest("td") as HTMLElement);
		expect(cells).toHaveLength(2);
		for (const cell of cells) expect(cell).toHaveClass("select-none");
		for (const cell of cells) {
			expect(within(cell).getByText("⊘").closest("td")).toBe(cell);
		}
		expect(
			screen.getByText("Whitespace only · 6 lines").closest("td"),
		).toHaveClass("select-none");
		expect(screen.getByText("Crossed off: gen")).toHaveClass("select-none");
	});
});

/** A 2 removed / 3 added cluster between context lines 4 and 8 (side by side). */
const pairHunks = (over: Partial<DiffLine>[] = []): FileHunks => ({
	newLineCount: 12,
	hunks: [
		{
			oldStart: 4,
			oldCount: 4,
			newStart: 4,
			newCount: 5,
			lines: [
				ctx(4, 4),
				{ ...del(5, "old five", "c"), ...over[0] },
				{ ...del(6, "old six", "c"), ...over[1] },
				{ ...add(5, "new five", "c"), ...over[2] },
				{ ...add(6, "new six", "c"), ...over[3] },
				{ ...add(7, "new seven", "c"), ...over[4] },
				ctx(8, 8),
			],
		},
	],
});
const pairCluster = (over: Partial<ClusterView> = {}) =>
	cluster("c", {
		oldStart: 5,
		oldCount: 2,
		newStart: 5,
		newCount: 3,
		lines: 5,
		...over,
	});

describe("DiffBody side by side", () => {
	beforeEach(() => {
		showInvisibles.set(false);
		sideBySide.set(true);
		window.scrollTo = vi.fn();
	});
	afterEach(() => {
		cleanup();
		contextRanges.reset();
		vi.unstubAllGlobals();
		localStorage.clear();
		showInvisibles.reset();
		ignoreWhitespace.reset();
		sideBySide.reset();
		resetComposers();
	});

	const lineRows = () =>
		Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid="diff-line"]'),
		);
	const numbers = (row: HTMLElement) => [
		row.dataset.oldNo ?? "",
		row.dataset.newNo ?? "",
	];
	const code = (row: HTMLElement, side: "LEFT" | "RIGHT") =>
		row.querySelector<HTMLElement>(
			`td[data-testid="code"][data-side="${side}"]`,
		);
	const number = (row: HTMLElement, side: "LEFT" | "RIGHT") =>
		row.querySelector<HTMLElement>(
			`td[data-testid="${side === "LEFT" ? "old" : "new"}"]`,
		);
	const colSpans = (testId: string) =>
		Array.from(
			document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
		).map((row) =>
			Array.from(row.querySelectorAll("td")).map((td) => td.colSpan),
		);
	/**
	 * A thread or composer row's cells: each one's span, which holds the
	 * card and which is the blank over the other side (-1: none).
	 */
	const tail = (row: HTMLElement) => {
		const cells = Array.from(
			row.querySelectorAll<HTMLTableCellElement>(":scope > td"),
		);
		return {
			spans: cells.map((td) => td.colSpan),
			card: cells.findIndex((td) =>
				td.querySelector(
					'[data-testid="files-thread"], [data-testid="new-thread"]',
				),
			),
			blank: cells.findIndex(
				(td) => td.classList.contains("bg-band") && td.childElementCount === 0,
			),
		};
	};
	const span = (side: "LEFT" | "RIGHT", line: number): CodeSpan => ({
		path: PATH,
		commit: HEAD,
		subject: "line",
		startSide: side,
		startLine: line,
		side,
		line,
		startCol: null,
		endCol: null,
	});
	const bubble = (row: HTMLElement, side: "LEFT" | "RIGHT") =>
		within(code(row, side) as HTMLElement).getByRole("button", {
			name: /comment/,
		});

	it("lays a 2/3 cluster out as three pair rows, the third with a blank left side", async () => {
		const { calls } = setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		expect(document.querySelector("table")).toHaveAttribute(
			"data-view",
			"side-by-side",
		);
		const rows = lineRows();
		expect(rows.map((r) => r.dataset.kind)).toEqual([
			"context",
			"pair",
			"pair",
			"pair",
			"context",
		]);
		expect(rows.map(numbers)).toEqual([
			["4", "4"],
			["5", "5"],
			["6", "6"],
			["", "7"],
			["8", "8"],
		]);
		const [, first, second, third] = rows as HTMLElement[];
		for (const row of [first, second] as HTMLElement[]) {
			expect(row.querySelectorAll("td[data-blank]")).toHaveLength(0);
			expect(code(row, "LEFT")).toHaveAttribute("data-kind", "del");
			expect(code(row, "RIGHT")).toHaveAttribute("data-kind", "add");
		}
		expect(code(first as HTMLElement, "LEFT")).toHaveTextContent("old five");
		expect(code(first as HTMLElement, "RIGHT")).toHaveTextContent("new five");
		// The blank side: both its cells say so, with no number, sign, text or side.
		const blanks = (third as HTMLElement).querySelectorAll<HTMLElement>(
			"td[data-blank]",
		);
		expect(Array.from(blanks).map((td) => td.dataset.testid)).toEqual([
			"old",
			"code",
		]);
		for (const td of Array.from(blanks)) {
			expect(td.textContent).toBe("");
			expect(td).not.toHaveAttribute("data-side");
			expect(td).toHaveClass("bg-band");
		}
		expect(code(third as HTMLElement, "LEFT")).toBeNull();
		expect(code(third as HTMLElement, "RIGHT")).toHaveTextContent("new seven");
		expect(number(third as HTMLElement, "RIGHT")).toHaveTextContent("7");
		// The cluster's controls sit on its first pair row.
		expect(
			within(first as HTMLElement).getByRole("checkbox", {
				name: "Mark cluster reviewed",
			}),
		).toBeInTheDocument();
		expect(
			screen.getAllByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toHaveLength(1);
		expect(calls()).toEqual(["/api/files/0/hunks?revision=r1"]);
	});

	it("shows a context line on both sides, each cell with its side", async () => {
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const row = lineRows()[0] as HTMLElement;
		expect(row.dataset.kind).toBe("context");
		const left = code(row, "LEFT");
		const right = code(row, "RIGHT");
		expect(left).toHaveAttribute("data-kind", "context");
		expect(right).toHaveAttribute("data-kind", "context");
		expect(left?.textContent).toBe(right?.textContent);
		expect(left).toHaveTextContent("line 4");
		expect(number(row, "LEFT")).toHaveAttribute("data-side", "LEFT");
		expect(number(row, "LEFT")).toHaveTextContent("4");
		expect(number(row, "RIGHT")).toHaveAttribute("data-side", "RIGHT");
		expect(number(row, "RIGHT")).toHaveTextContent("4");
		// Six columns: rail, controls, old number, old code, new number, new code.
		expect(
			Array.from(row.querySelectorAll("td")).map((td) => td.dataset.testid),
		).toEqual([undefined, undefined, "old", "code", "new", "code"]);
		// Code wraps in its cell, top-aligned next to its number however tall
		// the other side makes the row; the table never scrolls sideways.
		expect(left).toHaveClass("whitespace-pre-wrap", "align-top");
		expect(right).toHaveClass("align-top");
		expect(document.querySelector("table")).toHaveClass(
			"w-full",
			"table-fixed",
		);
		expect(document.querySelector("table")).not.toHaveClass("min-w-full");
	});

	it("paints each side's cells: the add/del tint, and the reviewed fade", async () => {
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const row = lineRows()[1] as HTMLElement;
		expect(code(row, "LEFT")).toHaveClass("bg-del");
		expect(code(row, "RIGHT")).toHaveClass("bg-add");
		expect(number(row, "LEFT")).toHaveClass("bg-del-gutter", "text-del-ink");
		expect(number(row, "RIGHT")).toHaveClass("bg-add-gutter", "text-add-ink");
		expect(row).not.toHaveAttribute("data-reviewed");
		cleanup();
		setup({
			hunks: pairHunks(),
			clusters: [pairCluster({ state: "reviewed" })],
		});
		await screen.findByText("new seven");
		const done = lineRows()[1] as HTMLElement;
		expect(done).toHaveAttribute("data-reviewed");
		expect(code(done, "LEFT")).toHaveClass("bg-del-done");
		expect(code(done, "LEFT")).not.toHaveClass("bg-del");
		expect(code(done, "RIGHT")).toHaveClass("bg-add-done");
		expect(number(done, "LEFT")).toHaveClass("bg-del-done", "text-del-ink");
		expect(number(done, "RIGHT")).toHaveClass("bg-add-done", "text-add-ink");
	});

	it("puts a thread's bubble in the cell of its side and opens its row under the pair, left side first", async () => {
		const { user } = setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("RIGHT", 6), thread("LEFT", 6)],
		});
		await screen.findByText("new seven");
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-new-no="6"]',
		) as HTMLElement;
		expect(row).toHaveAttribute("data-old-no", "6");
		expect(row).toHaveAttribute("data-commented");
		const left = code(row, "LEFT") as HTMLElement;
		const right = code(row, "RIGHT") as HTMLElement;
		expect(left).toHaveAttribute("data-commented");
		expect(right).toHaveAttribute("data-commented");
		expect(left).toHaveClass("thread-mark-cell");
		expect(number(row, "LEFT")).toHaveClass("thread-mark-cell");
		const leftBubble = within(left).getByRole("button", { name: /comment/ });
		const rightBubble = within(right).getByRole("button", { name: /comment/ });
		expect(leftBubble).toHaveAccessibleName("1 comment on old line 6");
		expect(rightBubble).toHaveAccessibleName("1 comment on line 6");
		expect(screen.getAllByTestId("thread-bubble")).toHaveLength(2);
		expect(screen.queryByTestId("thread-row")).toBeNull();
		// The other pair rows have no bubble and no mark.
		expect(lineRows()[1]).not.toHaveAttribute("data-commented");

		await user.click(leftBubble);
		expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
		const opened = screen.getByTestId("thread-row");
		expect(row.nextElementSibling).toBe(opened);
		expect(tail(opened)).toEqual({ spans: [1, 1, 2, 2], card: 2, blank: 3 });
		expect(leftBubble).toHaveAttribute("aria-expanded", "true");
		expect(rightBubble).toHaveAttribute("aria-expanded", "false");

		await user.click(rightBubble);
		const both = screen.getAllByTestId("thread-row");
		expect(both).toHaveLength(2);
		expect(row.nextElementSibling).toBe(both[0]);
		expect(both[0]?.nextElementSibling).toBe(both[1]);
		expect(leftBubble).toHaveAttribute(
			"aria-controls",
			both[0]?.getAttribute("id"),
		);
		expect(rightBubble).toHaveAttribute(
			"aria-controls",
			both[1]?.getAttribute("id"),
		);

		// Keyed by line, the open rows survive a switch to unified and back.
		act(() => sideBySide.set(false));
		expect(document.querySelector("table")).toHaveAttribute(
			"data-view",
			"unified",
		);
		expect(screen.getAllByTestId("thread-row")).toHaveLength(2);
		act(() => sideBySide.set(true));
		expect(screen.getAllByTestId("thread-row")).toHaveLength(2);
	});

	it("gives a context line its bubble in both cells, for a thread on its old side, and marks both cells", async () => {
		setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("LEFT", 4)],
		});
		await screen.findByText("new seven");
		const row = lineRows()[0] as HTMLElement;
		expect(row.dataset.kind).toBe("context");
		expect(row).toHaveAttribute("data-commented");
		// The same thread from either side, each named by the number beside it.
		expect(screen.getAllByTestId("thread-bubble")).toHaveLength(2);
		expect(bubble(row, "LEFT")).toHaveAccessibleName("1 comment on old line 4");
		expect(bubble(row, "RIGHT")).toHaveAccessibleName("1 comment on line 4");
		const right = code(row, "RIGHT") as HTMLElement;
		expect(code(row, "LEFT")).toHaveAttribute("data-commented");
		expect(right).toHaveAttribute("data-commented");
		expect(code(row, "LEFT")).toHaveClass("thread-mark-cell");
		expect(right).toHaveClass("thread-mark-cell");
	});

	it("opens a thread's row under its side: the card over that side's two columns, a blank over the other's", async () => {
		const { user } = setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("RIGHT", 6), thread("LEFT", 6)],
		});
		await screen.findByText("new seven");
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-new-no="6"]',
		) as HTMLElement;
		await user.click(bubble(row, "RIGHT"));
		const right = screen.getByTestId("thread-row");
		expect(row.nextElementSibling).toBe(right);
		expect(tail(right)).toEqual({ spans: [1, 1, 2, 2], card: 3, blank: 2 });
		// The card is its side's half: no sticky visible-width trick here.
		expect(right.querySelector(".sticky")).toBeNull();
		// The rail cell carries the cluster's state on beside it.
		expect(within(right).getByTestId("thread-rail")).toHaveClass(
			"bg-unreviewed",
		);

		await user.click(bubble(row, "LEFT"));
		const both = screen.getAllByTestId("thread-row");
		expect(both.map(tail)).toEqual([
			{ spans: [1, 1, 2, 2], card: 2, blank: 3 },
			{ spans: [1, 1, 2, 2], card: 3, blank: 2 },
		]);

		// Unified: across the table, as before.
		act(() => sideBySide.set(false));
		expect(screen.getAllByTestId("thread-row").map(tail)).toEqual([
			{ spans: [5], card: 0, blank: -1 },
			{ spans: [5], card: 0, blank: -1 },
		]);
		expect(
			screen.getAllByTestId("thread-row")[0]?.querySelector(".sticky"),
		).not.toBeNull();
	});

	it("opens a context line's threads under the bubble clicked, whichever side they name; either bubble closes them", async () => {
		const { user } = setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("LEFT", 4), thread("RIGHT", 4)],
		});
		await screen.findByText("new seven");
		const row = lineRows()[0] as HTMLElement;
		expect(row.dataset.kind).toBe("context");
		const left = bubble(row, "LEFT");
		const right = bubble(row, "RIGHT");
		expect(left).toHaveAccessibleName("2 comments on old line 4");
		await user.click(right);
		let opened = screen.getByTestId("thread-row");
		expect(row.nextElementSibling).toBe(opened);
		expect(tail(opened)).toEqual({ spans: [1, 1, 2, 2], card: 3, blank: 2 });
		expect(within(opened).getAllByTestId("files-thread")).toHaveLength(2);
		// Both bubbles stand for the one row of threads.
		for (const b of [left, right]) {
			expect(b).toHaveAttribute("aria-expanded", "true");
			expect(b).toHaveAttribute("aria-controls", opened.id);
		}
		await user.click(left);
		expect(screen.queryByTestId("thread-row")).toBeNull();
		expect(right).toHaveAttribute("aria-expanded", "false");
		await user.click(left);
		expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
		opened = screen.getByTestId("thread-row");
		expect(tail(opened)).toEqual({ spans: [1, 1, 2, 2], card: 2, blank: 3 });
		expect(right).toHaveAttribute("aria-controls", opened.id);
		await user.click(right);
		expect(screen.queryByTestId("thread-row")).toBeNull();
	});

	it("puts a composer under the side its span ends on", async () => {
		setup({ hunks: pairHunks(), clusters: [pairCluster()], threads: [] });
		await screen.findByText("new seven");
		act(() => {
			openComposer(span("RIGHT", 6));
		});
		const right = await screen.findByTestId("new-thread-row");
		expect(right.previousElementSibling).toHaveAttribute("data-new-no", "6");
		expect(tail(right)).toEqual({ spans: [1, 1, 2, 2], card: 3, blank: 2 });
		expect(right.querySelector(".sticky")).toBeNull();
		act(() => {
			openComposer(span("LEFT", 5));
		});
		const rows = screen.getAllByTestId("new-thread-row");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.previousElementSibling).toHaveAttribute("data-old-no", "5");
		expect(rows.map(tail)).toEqual([
			{ spans: [1, 1, 2, 2], card: 2, blank: 3 },
			{ spans: [1, 1, 2, 2], card: 3, blank: 2 },
		]);
		act(() => sideBySide.set(false));
		expect(screen.getAllByTestId("new-thread-row").map(tail)).toEqual([
			{ spans: [5], card: 0, blank: -1 },
			{ spans: [5], card: 0, blank: -1 },
		]);
	});

	it("on a phone keeps a thread's row and a composer across the table", async () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches: false,
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		const { user } = setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("RIGHT", 6)],
		});
		await screen.findByText("new seven");
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-new-no="6"]',
		) as HTMLElement;
		// On a phone the bubble sits in its own row under the line's.
		await user.click(
			within(row.nextElementSibling as HTMLElement).getByRole("button", {
				name: /comment/,
			}),
		);
		const opened = screen.getByTestId("thread-row");
		expect(tail(opened)).toEqual({ spans: [6], card: 0, blank: -1 });
		expect(within(opened).getByTestId("thread-rail")).toHaveClass(
			"bg-unreviewed",
		);
		act(() => {
			openComposer(span("LEFT", 5));
		});
		const composer = await screen.findByTestId("new-thread-row");
		expect(tail(composer)).toEqual({ spans: [6], card: 0, blank: -1 });
	});

	it("on a phone, composers on both sides of a pair row share one row across the table", async () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches: false,
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		setup({ hunks: pairHunks(), clusters: [pairCluster()], threads: [] });
		await screen.findByText("new seven");
		act(() => {
			openComposer(span("LEFT", 5));
			openComposer(span("RIGHT", 5));
		});
		const rows = await screen.findAllByTestId("new-thread-row");
		expect(rows).toHaveLength(1);
		const row = rows[0] as HTMLElement;
		expect(row.previousElementSibling).toHaveAttribute("data-old-no", "5");
		expect(row.previousElementSibling).toHaveAttribute("data-new-no", "5");
		expect(tail(row)).toEqual({ spans: [6], card: 0, blank: -1 });
		expect(within(row).getAllByTestId("new-thread")).toHaveLength(2);
	});

	describe("bubbles on a phone", () => {
		const phone = () =>
			vi.stubGlobal(
				"matchMedia",
				(query: string) =>
					({
						matches: false,
						media: query,
						addEventListener: () => {},
						removeEventListener: () => {},
					}) as unknown as MediaQueryList,
			);
		const byNew = (n: number) =>
			document.querySelector<HTMLElement>(
				`[data-testid="diff-line"][data-new-no="${n}"]`,
			) as HTMLElement;
		/** The bubbles of a bubble row's side, by name. */
		const sideBubbles = (row: Element, side: "LEFT" | "RIGHT") =>
			Array.from(
				row.querySelectorAll(
					`[data-bubbles="${side}"] [data-testid="thread-bubble"]`,
				),
			).map((b) => b.getAttribute("aria-label"));
		/** No room kept for bubbles in either code cell. */
		const unpadded = (row: HTMLElement) => {
			for (const side of ["LEFT", "RIGHT"] as const) {
				const cell = code(row, side);
				if (!cell) continue;
				expect(cell).not.toHaveClass("pr-12");
				expect(cell).not.toHaveClass("pr-24");
				expect(cell.querySelector('[data-testid="thread-bubble"]')).toBeNull();
			}
		};

		it("moves a right cell's bubble to a row of its own under the pair row, on the right", async () => {
			phone();
			const { user } = setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("RIGHT", 6)],
			});
			await screen.findByText("new seven");
			const row = byNew(6);
			unpadded(row);
			const bubbles = row.nextElementSibling as HTMLElement;
			expect(bubbles).toHaveAttribute("data-testid", "bubble-row");
			expect(sideBubbles(bubbles, "RIGHT")).toEqual(["1 comment on line 6"]);
			expect(sideBubbles(bubbles, "LEFT")).toEqual([]);
			expect(bubbles.querySelector('[data-bubbles="RIGHT"]')).toHaveClass(
				"justify-end",
			);
			// No line and no thread row: the scroll anchor, the line picks and
			// the floating cluster controls (they stop at thread rows) pass it by.
			expect(
				bubbles.matches(
					'[data-testid="diff-line"], [data-testid="thread-row"], [data-old-no], [data-new-no]',
				),
			).toBe(false);
			expect(
				bubbles.querySelector('[data-testid="code"], button[data-pick]'),
			).toBeNull();
			// The cluster's rail carries on beside it.
			expect(bubbles.querySelector("td")).toHaveClass("bg-unreviewed");
			// It opens its thread right under the bubble row, as before.
			const button = within(bubbles).getByRole("button", {
				name: "1 comment on line 6",
			});
			expect(button).toHaveAttribute("aria-expanded", "false");
			await user.click(button);
			const opened = screen.getByTestId("thread-row");
			expect(bubbles.nextElementSibling).toBe(opened);
			expect(button).toHaveAttribute("aria-expanded", "true");
			expect(button).toHaveAttribute("aria-controls", opened.id);
			await user.click(button);
			expect(screen.queryByTestId("thread-row")).toBeNull();
		});

		it("crossing the breakpoint gives focus back to the bubble that has it, not one another file's table had before", async () => {
			// A media query the test flips, telling every table.
			let wide = true;
			const listeners = new Set<() => void>();
			vi.stubGlobal(
				"matchMedia",
				(query: string) =>
					({
						get matches() {
							return wide;
						},
						media: query,
						addEventListener: (_: string, l: () => void) => listeners.add(l),
						removeEventListener: (_: string, l: () => void) =>
							listeners.delete(l),
					}) as unknown as MediaQueryList,
			);
			const flip = () =>
				act(() => {
					wide = !wide;
					for (const l of listeners) l();
				});
			// Two files' tables, the same thread in each, one commit for both.
			setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("RIGHT", 6)],
				twice: true,
			});
			await waitFor(() =>
				expect(screen.getAllByTestId("thread-bubble")).toHaveLength(2),
			);
			const tables = () => Array.from(document.querySelectorAll("table"));
			const bubbleIn = (t: number) =>
				tables()[t]?.querySelector<HTMLElement>(
					'[data-testid="thread-bubble"]',
				) as HTMLElement;
			act(() => bubbleIn(0).focus());
			act(() => bubbleIn(1).focus());
			flip();
			expect(bubbleIn(1).closest('[data-testid="bubble-row"]')).not.toBeNull();
			expect(bubbleIn(1)).toHaveFocus();
			flip();
			expect(bubbleIn(1)).toHaveFocus();
			// Focus gone with its bubble's table: nothing takes it later.
			// (The blur and the resize are separate tasks.)
			await act(async () => bubbleIn(1).blur());
			flip();
			expect(document.activeElement).toBe(document.body);
		});

		it("gives a context line's threads one bubble, on the right of its bubble row", async () => {
			phone();
			setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("LEFT", 4)],
			});
			await screen.findByText("new seven");
			const row = lineRows()[0] as HTMLElement;
			unpadded(row);
			const bubbles = row.nextElementSibling as HTMLElement;
			expect(sideBubbles(bubbles, "RIGHT")).toEqual(["1 comment on line 4"]);
			expect(sideBubbles(bubbles, "LEFT")).toEqual([]);
			expect(screen.getAllByTestId("thread-bubble")).toHaveLength(1);
		});

		it("puts a left cell's bubble on the left, and both sides' in one row", async () => {
			phone();
			setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("LEFT", 5), thread("LEFT", 6), thread("RIGHT", 6)],
			});
			await screen.findByText("new seven");
			const five = byNew(5);
			unpadded(five);
			const fiveBubbles = five.nextElementSibling as HTMLElement;
			expect(fiveBubbles).toHaveAttribute("data-testid", "bubble-row");
			expect(sideBubbles(fiveBubbles, "LEFT")).toEqual([
				"1 comment on old line 5",
			]);
			expect(sideBubbles(fiveBubbles, "RIGHT")).toEqual([]);
			expect(
				fiveBubbles.querySelector('[data-bubbles="LEFT"]'),
			).not.toHaveClass("justify-end");

			const six = byNew(6);
			unpadded(six);
			const sixBubbles = six.nextElementSibling as HTMLElement;
			expect(sixBubbles).toHaveAttribute("data-testid", "bubble-row");
			expect(sideBubbles(sixBubbles, "LEFT")).toEqual([
				"1 comment on old line 6",
			]);
			expect(sideBubbles(sixBubbles, "RIGHT")).toEqual(["1 comment on line 6"]);
			expect(screen.getAllByTestId("bubble-row")).toHaveLength(2);
		});

		it("moves the file bubble on the first row to its bubble row, the file's threads under it", async () => {
			phone();
			const { user } = setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("RIGHT", 1)],
				lead: {
					bubble: (
						<ThreadBubble
							inline
							file
							threads={[]}
							label="Comment on file"
							open
							onToggle={() => {}}
						/>
					),
					row: (columns) => (
						<tr data-testid="file-threads-row">
							<td colSpan={columns} />
						</tr>
					),
				},
			});
			await screen.findByText("new seven");
			// The first row is the gap's until its lines load: then line 1's.
			const gap = screen.getAllByTestId("gap-row")[0] as HTMLElement;
			await user.click(
				within(gap).getAllByRole("button", { name: /above/ })[0] as HTMLElement,
			);
			await screen.findAllByText("line 1");
			const first = lineRows()[0] as HTMLElement;
			expect(first).toHaveAttribute("data-new-no", "1");
			unpadded(first);
			const bubbles = first.nextElementSibling as HTMLElement;
			expect(bubbles).toHaveAttribute("data-testid", "bubble-row");
			expect(sideBubbles(bubbles, "RIGHT")).toEqual([
				"Comment on file",
				"1 comment on line 1",
			]);
			expect(bubbles.nextElementSibling).toHaveAttribute(
				"data-testid",
				"file-threads-row",
			);
		});

		it("keeps bubbles in their cells on a wide screen and in unified", async () => {
			setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("RIGHT", 6), thread("LEFT", 5)],
			});
			await screen.findByText("new seven");
			expect(screen.queryByTestId("bubble-row")).toBeNull();
			expect(code(byNew(6), "RIGHT")).toHaveClass("pr-12");
			expect(code(byNew(5), "LEFT")).toHaveClass("pr-12");
			cleanup();
			phone();
			sideBySide.set(false);
			setup({
				hunks: pairHunks(),
				clusters: [pairCluster()],
				threads: [thread("RIGHT", 6)],
			});
			await screen.findByText("new seven");
			expect(screen.queryByTestId("bubble-row")).toBeNull();
			expect(screen.getAllByTestId("thread-bubble")).toHaveLength(1);
		});
	});

	it("lands on one cell of a pair row, and on both cells of a context row", async () => {
		setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			landing: { path: PATH, line: 6, side: "LEFT", index: 0, seq: 1 },
		});
		await screen.findByText("new seven");
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-landed]',
		) as HTMLElement;
		expect(row).toHaveAttribute("data-old-no", "6");
		expect(code(row, "LEFT")).toHaveAttribute("data-landed");
		expect(code(row, "LEFT")).toHaveClass("mark-tint-cell");
		expect(number(row, "LEFT")).toHaveClass("mark-tint-cell");
		expect(code(row, "RIGHT")).not.toHaveAttribute("data-landed");
		expect(code(row, "RIGHT")).not.toHaveClass("mark-tint-cell");
		expect(number(row, "RIGHT")).not.toHaveClass("mark-tint-cell");
		// The accent rail is the row's.
		expect(row.className).toMatch(/first-child\]:bg-accent/);
		expect(window.scrollTo).toHaveBeenCalled();
		cleanup();
		setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			landing: { path: PATH, line: 4, side: "RIGHT", index: 0, seq: 2 },
		});
		await screen.findByText("new seven");
		const ctxRow = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-landed]',
		) as HTMLElement;
		expect(ctxRow.dataset.kind).toBe("context");
		expect(code(ctxRow, "LEFT")).toHaveAttribute("data-landed");
		expect(code(ctxRow, "RIGHT")).toHaveAttribute("data-landed");
	});

	it("notes a missing final newline under the side that lacks it", async () => {
		setup({
			hunks: pairHunks([{}, { noNewline: true }]),
			clusters: [pairCluster()],
		});
		await screen.findByText("new seven");
		const notes = screen.getAllByText("\\ No newline at end of file");
		expect(notes).toHaveLength(1);
		const note = notes[0]?.closest("tr") as HTMLElement;
		expect(note).toHaveAttribute("data-testid", "no-newline");
		expect(lineRows()[2]?.nextElementSibling).toBe(note);
		// Rail, controls, old number, old code, new number, new code: the note
		// sits in the code cell of its side, and those cells name no side (only
		// code cells do).
		const sideCells = (tr: HTMLElement) => {
			const tds = tr.querySelectorAll("td");
			expect(tds).toHaveLength(6);
			expect(tr.querySelectorAll("[data-side]")).toHaveLength(0);
			return [tds[3]?.textContent, tds[5]?.textContent];
		};
		expect(sideCells(note)).toEqual(["\\ No newline at end of file", ""]);
		cleanup();
		setup({
			hunks: pairHunks([{}, { noNewline: true }, {}, {}, { noNewline: true }]),
			clusters: [pairCluster()],
		});
		await screen.findByText("new seven");
		// Old 6 is in the second pair row, new 7 in the third: a note under each.
		const rows = screen
			.getAllByText("\\ No newline at end of file")
			.map((el) => el.closest("tr") as HTMLElement);
		expect(rows).toHaveLength(2);
		expect(lineRows()[2]?.nextElementSibling).toBe(rows[0]);
		expect(lineRows()[3]?.nextElementSibling).toBe(rows[1]);
		expect(sideCells(rows[0] as HTMLElement)).toEqual([
			"\\ No newline at end of file",
			"",
		]);
		expect(sideCells(rows[1] as HTMLElement)).toEqual([
			"",
			"\\ No newline at end of file",
		]);
		cleanup();
		// A context line lacking it: on both sides.
		const lastLine: FileHunks = {
			newLineCount: 2,
			hunks: [
				{
					oldStart: 1,
					oldCount: 2,
					newStart: 1,
					newCount: 2,
					lines: [
						del(1, "a", "c"),
						add(1, "b", "c"),
						{ ...ctx(2, 2), noNewline: true },
					],
				},
			],
		};
		setup({ hunks: lastLine, clusters: [pairCluster()] });
		await screen.findAllByText("line 2");
		const ctxNotes = screen.getAllByText("\\ No newline at end of file");
		expect(ctxNotes).toHaveLength(2);
		const ctxNote = ctxNotes[0]?.closest("tr") as HTMLElement;
		expect(ctxNotes[1]?.closest("tr")).toBe(ctxNote);
		expect(sideCells(ctxNote)).toEqual([
			"\\ No newline at end of file",
			"\\ No newline at end of file",
		]);
	});

	it("marks only the cell of the thread's side", async () => {
		setup({
			hunks: pairHunks(),
			clusters: [pairCluster()],
			threads: [thread("RIGHT", 6)],
		});
		await screen.findByText("new seven");
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-new-no="6"]',
		) as HTMLElement;
		expect(row).toHaveAttribute("data-commented");
		expect(code(row, "RIGHT")).toHaveAttribute("data-commented");
		expect(code(row, "RIGHT")).toHaveClass("thread-mark-cell");
		expect(number(row, "RIGHT")).toHaveClass("thread-mark-cell");
		expect(code(row, "LEFT")).not.toHaveAttribute("data-commented");
		expect(code(row, "LEFT")).not.toHaveClass("thread-mark-cell");
		expect(number(row, "LEFT")).not.toHaveClass("thread-mark-cell");
		expect(screen.getAllByTestId("thread-bubble")).toHaveLength(1);
		expect(
			code(row, "LEFT")?.querySelector('[data-testid="thread-bubble"]'),
		).toBeNull();
	});

	it("keeps a thread opened on the old side of a unified ~ pair open after the switch", async () => {
		// Opened in unified under the key its threads end on (LEFT:9, not the
		// row's first key), so the left cell of the side-by-side pair reads it.
		sideBySide.set(false);
		ignoreWhitespace.set(true);
		const { user } = setup({ threads: [thread("LEFT", 9)] });
		await screen.findByText("Whitespace only · 6 lines");
		const bubble = screen.getByRole("button", {
			name: "1 comment on old line 9",
		});
		await user.click(bubble);
		expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
		const unifiedRow = document.querySelector(
			'[data-testid="diff-line"][data-old-no="9"]',
		);
		expect(unifiedRow?.nextElementSibling).toBe(
			screen.getByTestId("thread-row"),
		);
		act(() => sideBySide.set(true));
		expect(screen.getAllByTestId("thread-row")).toHaveLength(1);
		const row = document.querySelector<HTMLElement>(
			'[data-testid="diff-line"][data-old-no="9"]',
		) as HTMLElement;
		expect(row.dataset.kind).toBe("pair");
		expect(row.nextElementSibling).toBe(screen.getByTestId("thread-row"));
		const left = within(code(row, "LEFT") as HTMLElement).getByTestId(
			"thread-bubble",
		);
		expect(left).toHaveAttribute("aria-expanded", "true");
		expect(left).toHaveAttribute(
			"aria-controls",
			screen.getByTestId("thread-row").id,
		);
		// And it closes from there.
		await user.click(left);
		expect(screen.queryByTestId("thread-row")).toBeNull();
		act(() => sideBySide.set(false));
		expect(screen.queryByTestId("thread-row")).toBeNull();
	});

	it("with Ignore whitespace on, keeps a whitespace pair as one row with each side's own text, between positional pairs", async () => {
		ignoreWhitespace.set(true);
		const composed: FileHunks = {
			newLineCount: 5,
			hunks: [
				{
					oldStart: 1,
					oldCount: 5,
					newStart: 1,
					newCount: 5,
					lines: [
						ctx(1, 1),
						del(2, "d1", "m"),
						del(3, "\td2", "m"),
						del(4, "d3", "m"),
						add(2, "a1", "m"),
						add(3, "  d2", "m"),
						add(4, "a3", "m"),
						ctx(5, 5),
					],
				},
			],
		};
		setup({
			hunks: composed,
			clusters: [
				cluster("m", {
					oldStart: 2,
					oldCount: 3,
					newStart: 2,
					newCount: 3,
					lines: 6,
				}),
			],
		});
		await screen.findByText("a3");
		const rows = lineRows();
		expect(rows.map((r) => r.dataset.kind)).toEqual([
			"context",
			"pair",
			"pair",
			"pair",
			"context",
		]);
		expect(rows.map(numbers)).toEqual([
			["1", "1"],
			["2", "2"],
			["3", "3"],
			["4", "4"],
			["5", "5"],
		]);
		const ws = rows[2] as HTMLElement;
		expect(code(ws, "LEFT")).toHaveAttribute("data-kind", "ws");
		expect(code(ws, "RIGHT")).toHaveAttribute("data-kind", "ws");
		// Each side's own text, whitespace and all.
		expect(code(ws, "LEFT")?.textContent).toBe("~\td2");
		expect(code(ws, "RIGHT")?.textContent).toBe("~  d2");
		expect(code(ws, "LEFT")).toHaveClass("bg-band");
		expect(
			screen.getAllByRole("img", { name: "Whitespace only" }),
		).toHaveLength(2);
		expect(code(rows[1] as HTMLElement, "LEFT")).toHaveTextContent("d1");
		expect(code(rows[1] as HTMLElement, "RIGHT")).toHaveTextContent("a1");
		expect(code(rows[3] as HTMLElement, "LEFT")).toHaveTextContent("d3");
		expect(code(rows[3] as HTMLElement, "RIGHT")).toHaveTextContent("a3");
	});

	it("with Ignore whitespace on, a whitespace-only cluster is still one collapsed row over the whole table", async () => {
		ignoreWhitespace.set(true);
		const { collapsed, user } = setup();
		await screen.findByText("Whitespace only · 6 lines");
		expect(collapsed()).toHaveLength(1);
		expect(colSpans("ws-cluster")).toEqual([[1, 1, 4]]);
		expect(lineRows().map((r) => r.dataset.kind)).toEqual([
			"context",
			"context",
			"context",
			"context",
			"pair",
			"pair",
			"context",
			"context",
			"context",
		]);
		const expand = screen.getByRole("button", {
			name: "Whitespace only · 6 lines",
		});
		await user.click(expand);
		const shown = lineRows().slice(1, 4);
		expect(shown.map((r) => r.dataset.kind)).toEqual(["pair", "pair", "pair"]);
		expect(shown.map(numbers)).toEqual([
			["2", "2"],
			["3", "3"],
			["4", "4"],
		]);
		for (const row of shown) {
			expect(code(row, "LEFT")).toHaveAttribute("data-kind", "ws");
			expect(code(row, "RIGHT")).toHaveAttribute("data-kind", "ws");
		}
		// The expanded state survives a switch to unified and back.
		act(() => sideBySide.set(false));
		expect(collapsed()[0]).toHaveAttribute("data-expanded");
		expect(lineRows()).toHaveLength(13);
		act(() => sideBySide.set(true));
		expect(collapsed()[0]).toHaveAttribute("data-expanded");
		expect(lineRows()).toHaveLength(12);
	});

	it("keeps expanded context when the file closes and opens again", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const open = () =>
			setup({ hunks: { ...hunks, newLineCount: 20 }, queryClient });
		const first = open();
		const gap = (await screen.findAllByTestId("gap-row"))[0] as HTMLElement;
		await first.user.click(
			within(gap).getAllByRole("button", { name: /below/ })[0] as HTMLElement,
		);
		await waitFor(() =>
			expect(document.querySelector('tr[data-new-no="13"]')).not.toBeNull(),
		);
		const loads = (calls: string[]) =>
			calls.filter((url) => url.includes("/context")).length;
		expect(loads(first.calls())).toBe(1);

		// The file closes (DiffBody unmounts) and opens again.
		cleanup();
		const again = open();
		await waitFor(() =>
			expect(document.querySelector('tr[data-new-no="13"]')).not.toBeNull(),
		);
		expect(loads(again.calls())).toBe(0);
	});

	it("spans every table-wide row over six columns, five in unified", async () => {
		ignoreWhitespace.set(true);
		// A longer file: a gap row below the hunk.
		const { user } = setup({
			hunks: { ...hunks, newLineCount: 20 },
			threads: [thread("RIGHT", 8)],
		});
		await screen.findByText("Whitespace only · 6 lines");
		await user.click(screen.getByRole("button", { name: /comment on line 8/ }));
		const spans = () => ({
			header: Array.from(
				document.querySelectorAll<HTMLTableCellElement>(
					"tbody > tr > td[colspan]",
				),
			)
				.filter((td) => td.parentElement?.textContent?.startsWith("@@"))
				.map((td) => td.colSpan),
			gap: colSpans("gap-row"),
			ws: colSpans("ws-cluster"),
			thread: colSpans("thread-row"),
		});
		// A thread's row takes its side's two columns, under the rail and controls.
		expect(spans()).toEqual({
			header: [6],
			gap: [[2, 4]],
			ws: [[1, 1, 4]],
			thread: [[1, 1, 2, 2]],
		});
		act(() => sideBySide.set(false));
		expect(spans()).toEqual({
			header: [5],
			gap: [[2, 3]],
			ws: [[1, 1, 3]],
			thread: [[5]],
		});
	});

	it("sizes the number columns by the file's largest line number, three digits at least", async () => {
		setup({
			hunks: { ...pairHunks(), newLineCount: 1200 },
			clusters: [pairCluster()],
		});
		await screen.findByText("new seven");
		// The table says how wide (`--num-w`); every number cell, blank ones
		// too, and side by side the number columns themselves, take it.
		const width = () =>
			document.querySelector("table")?.style.getPropertyValue("--num-w");
		const sized = () => {
			const cells = document.querySelectorAll<HTMLElement>(
				'td[data-testid="old"], td[data-testid="new"]',
			);
			return (
				cells.length > 0 &&
				[...cells].every(
					(el) =>
						el.className.includes("w-[var(--num-w,3rem)]") &&
						el.className.includes(
							"pointer-coarse:w-[max(3rem,var(--num-w,3rem))]",
						),
				)
			);
		};
		expect(width()).toBe("calc(4ch + 1rem)");
		expect(document.querySelectorAll("col")).toHaveLength(6);
		expect(
			[...document.querySelectorAll("col")].filter((c) =>
				c.className.includes("--num-w"),
			),
		).toHaveLength(2);
		// Blank number cells (a side with no line) are sized like the rest.
		expect(
			document.querySelectorAll('td[data-blank][data-testid="old"]').length,
		).toBeGreaterThan(0);
		expect(sized()).toBe(true);
		cleanup();
		setup({
			hunks: { ...pairHunks(), newLineCount: 80 },
			clusters: [pairCluster()],
		});
		await screen.findByText("new seven");
		expect(width()).toBe("calc(3ch + 1rem)");
		expect(sized()).toBe(true);
		// Unified too.
		act(() => sideBySide.set(false));
		expect(width()).toBe("calc(3ch + 1rem)");
		expect(sized()).toBe(true);
		// A deleted tail numbers higher on the old side than the new file is long.
		cleanup();
		setup({
			hunks: {
				newLineCount: 3,
				hunks: [
					{
						oldStart: 1,
						oldCount: 1001,
						newStart: 1,
						newCount: 3,
						lines: [ctx(1, 1), ctx(2, 2), ctx(3, 3), del(1001, "gone", "c")],
					},
				],
			},
			clusters: [pairCluster()],
		});
		await screen.findByText("gone");
		expect(width()).toBe("calc(4ch + 1rem)");
	});

	it("keeps unified's markup, its code cell naming its side", async () => {
		act(() => sideBySide.set(false));
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		expect(document.querySelector("table")).toHaveAttribute(
			"data-view",
			"unified",
		);
		expect(document.querySelector("table")).toHaveClass("min-w-full");
		const sides = lineRows().map((row) => [
			row.dataset.kind,
			row.querySelector('td[data-testid="code"]')?.getAttribute("data-side"),
			row.querySelectorAll("td").length,
		]);
		expect(sides).toEqual([
			["context", "RIGHT", 5],
			["del", "LEFT", 5],
			["del", "LEFT", 5],
			["add", "RIGHT", 5],
			["add", "RIGHT", 5],
			["add", "RIGHT", 5],
			["context", "RIGHT", 5],
		]);
		expect(document.querySelectorAll("td[data-blank]")).toHaveLength(0);
	});

	/** Selects `el`'s contents (or nothing) and tells the document, as a browser would. */
	const select = (el: Element | null) => {
		const selection = window.getSelection();
		selection?.removeAllRanges();
		if (el) {
			const range = document.createRange();
			range.selectNodeContents(el);
			selection?.addRange(range);
		}
		document.dispatchEvent(new Event("selectionchange"));
	};
	const selecting = () =>
		document.querySelector("table")?.getAttribute("data-selecting") ?? null;

	it("marks the table with the side a text selection starts on, and clears it when the selection goes", async () => {
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const row = lineRows()[1] as HTMLElement;
		expect(selecting()).toBeNull();
		// The pointer goes down on the new side: the old side is off limits
		// at once, before any selection exists.
		fireEvent.pointerDown(code(row, "RIGHT") as HTMLElement);
		expect(selecting()).toBe("new");
		// The caret the browser places on mouse down is a collapsed selection:
		// while the pointer is down it doesn't clear the mark, or a fast drag
		// could reach the other side before the first move's selection sets
		// the mark again.
		select(null);
		expect(selecting()).toBe("new");
		// A selection on that side keeps the mark once the pointer is up.
		fireEvent.pointerUp(document.body);
		select(code(row, "RIGHT"));
		expect(selecting()).toBe("new");
		// Collapsed with the pointer up: the mark goes, so the next drag can
		// start on either side.
		select(null);
		expect(selecting()).toBeNull();
		// A selection whose anchor is in an old-side cell marks the old side.
		select(code(row, "LEFT"));
		expect(selecting()).toBe("old");
		// Anchored outside this table: not ours.
		const elsewhere = document.createElement("p");
		elsewhere.textContent = "outside";
		document.body.append(elsewhere);
		select(elsewhere);
		expect(selecting()).toBeNull();
		elsewhere.remove();
	});

	it("ignores a pointer down on a number cell: it can't start a selection, so nothing would clear the mark", async () => {
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const row = lineRows()[1] as HTMLElement;
		fireEvent.pointerDown(number(row, "RIGHT") as HTMLElement);
		fireEvent.pointerUp(document.body);
		expect(selecting()).toBeNull();
		fireEvent.pointerDown(number(row, "LEFT") as HTMLElement);
		expect(selecting()).toBeNull();
	});

	it("never marks a unified table", async () => {
		act(() => sideBySide.set(false));
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const [, delRow, , addRow] = lineRows() as HTMLElement[];
		fireEvent.pointerDown(
			(addRow as HTMLElement).querySelector(
				'td[data-testid="code"]',
			) as HTMLElement,
		);
		expect(selecting()).toBeNull();
		select((delRow as HTMLElement).querySelector('td[data-testid="code"]'));
		expect(selecting()).toBeNull();
	});

	it("drops the mark and its document listener on the switch to unified and on unmount", async () => {
		const added = vi.spyOn(document, "addEventListener");
		const removed = vi.spyOn(document, "removeEventListener");
		setup({ hunks: pairHunks(), clusters: [pairCluster()] });
		await screen.findByText("new seven");
		const ours = ["selectionchange", "pointerup", "pointercancel"];
		const listeners = (spy: typeof added) =>
			spy.mock.calls
				.filter(([type]) => ours.includes(type))
				.map(([type, listener]) => [type, listener]);
		expect(listeners(added).map(([type]) => type)).toEqual(ours);
		const row = lineRows()[1] as HTMLElement;
		select(code(row, "LEFT"));
		expect(selecting()).toBe("old");
		act(() => sideBySide.set(false));
		expect(selecting()).toBeNull();
		expect(listeners(removed)).toEqual(listeners(added));
		act(() => sideBySide.set(true));
		expect(listeners(added)).toHaveLength(ours.length * 2);
		cleanup();
		expect(listeners(removed)).toEqual(listeners(added));
	});
});

describe("number columns: as wide as the file's largest line number needs", () => {
	const hunk = (
		oldStart: number,
		oldCount: number,
		newStart: number,
		newCount: number,
	) => ({ oldStart, oldCount, newStart, newCount, lines: [] });

	it("three digits at least", () => {
		expect(numberDigits(undefined)).toBe(3);
		expect(numberDigits({ hunks: [hunk(1, 1, 1, 2)], newLineCount: 9 })).toBe(
			3,
		);
	});

	it("four or five digits by the longer side, old or new", () => {
		expect(
			numberDigits({ hunks: [hunk(1, 1, 1, 1)], newLineCount: 1200 }),
		).toBe(4);
		// The old file was longer: 900 lines plus the 9,200 a hunk removed.
		expect(
			numberDigits({ hunks: [hunk(10, 9300, 10, 100)], newLineCount: 900 }),
		).toBe(5);
		expect(
			numberDigits({ hunks: [hunk(1, 1, 1, 1)], newLineCount: 12345 }),
		).toBe(5);
	});

	it("sizes the cells from it; touch keeps 48px", async () => {
		const client = new QueryClient();
		client.setQueryData(["hunks", "r1", 0], {
			hunks: [
				{
					oldStart: 1,
					oldCount: 0,
					newStart: 1,
					newCount: 1,
					lines: [{ kind: "add", newNo: 1, text: "x" }],
				},
			],
			newLineCount: 1500,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 404 })),
		);
		render(
			<QueryClientProvider client={client}>
				<DiffBody
					file={{
						index: 0,
						path: PATH,
						status: "added",
						binary: false,
						submodule: false,
						additions: 1,
						deletions: 0,
						clusters: [],
						done: false,
						reviewed: false,
						crossedOff: false,
					}}
					revision="r1"
					onToggle={() => {}}
					onCrossOff={() => {}}
				/>
			</QueryClientProvider>,
		);
		const row = await screen.findByTestId("diff-line");
		expect(row.closest("table")?.style.getPropertyValue("--num-w")).toBe(
			"calc(4ch + 1rem)",
		);
		const number = within(row).getByTestId("new");
		expect(number.className).toContain("w-[var(--num-w,3rem)]");
		expect(number.className).toContain(
			"pointer-coarse:w-[max(3rem,var(--num-w,3rem))]",
		);
	});
});

describe("DiffBody find", () => {
	beforeEach(() => {
		showInvisibles.set(false);
		window.scrollTo = vi.fn();
	});
	afterEach(() => {
		cleanup();
		contextRanges.reset();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		localStorage.clear();
		showInvisibles.reset();
		ignoreWhitespace.reset();
		sideBySide.reset();
	});

	/** A find whose current hit is `current`, with no marks. */
	const findAt = (
		current: DiffFind["current"],
		stepSeq = 0,
		marksOf: DiffFind["marksOf"] = () => [],
	): DiffFind => ({ marksOf, current, stepSeq });

	it("paints the find's marks on each line's cell and the current hit's row", async () => {
		setup({
			find: findAt({ old: false, line: 8 }, 0, (side, line) =>
				side === "RIGHT" && line === 8
					? [{ from: 6, to: 7, current: true }]
					: side === "LEFT" && line === 8
						? [{ from: 6, to: 7, current: false }]
						: [],
			),
		});
		await screen.findByText("line 12");
		const added = document.querySelector('tr[data-new-no="8"]') as HTMLElement;
		expect(added).toHaveAttribute("data-find-current");
		expect(added).toHaveClass("mark-tint");
		expect(added.querySelector("[data-find-current]")?.textContent).toBe("x");
		const deleted = document.querySelector(
			'tr[data-old-no="8"]:not([data-new-no])',
		) as HTMLElement;
		expect(deleted.querySelector("[data-find-mark]")?.textContent).toBe("x");
		expect(deleted).not.toHaveAttribute("data-find-current");
		expect(deleted.querySelector("[data-find-current]")).toBeNull();
		expect(deleted).not.toHaveClass("mark-tint");
		// No other row is current.
		expect(document.querySelectorAll("tr[data-find-current]")).toHaveLength(1);
	});

	it("side by side, the current hit paints its side's cell; a context line both cells", async () => {
		sideBySide.set(true);
		const code = (row: Element, side: "LEFT" | "RIGHT") =>
			row.querySelector(`td[data-testid="code"][data-side="${side}"]`);
		const { refind } = setup({ find: findAt({ old: true, line: 8 }) });
		// A context line shows on both sides.
		await screen.findAllByText("line 12");
		const pair = document.querySelector('tr[data-old-no="8"]') as HTMLElement;
		expect(pair).toHaveAttribute("data-new-no", "8");
		expect(code(pair, "LEFT")).toHaveAttribute("data-find-current");
		expect(code(pair, "LEFT")).toHaveClass("mark-tint-cell");
		expect(code(pair, "RIGHT")).not.toHaveAttribute("data-find-current");
		expect(code(pair, "RIGHT")).not.toHaveClass("mark-tint-cell");
		expect(document.querySelectorAll("td[data-find-current]")).toHaveLength(1);
		refind(findAt({ old: false, line: 5 }));
		const row5 = document.querySelector('tr[data-new-no="5"]') as HTMLElement;
		expect(row5.dataset.kind).toBe("context");
		expect(code(row5, "LEFT")).toHaveAttribute("data-find-current");
		expect(code(row5, "RIGHT")).toHaveAttribute("data-find-current");
		expect(code(row5, "LEFT")).toHaveClass("mark-tint-cell");
		expect(code(row5, "RIGHT")).toHaveClass("mark-tint-cell");
		expect(code(pair, "LEFT")).not.toHaveAttribute("data-find-current");
	});

	it("a step scrolls the current hit's row under the sticky stack once the hunks are in", async () => {
		const held = heldJson();
		const current = { old: false, line: 8 };
		const { root, refind } = setup({
			find: findAt(current, 1),
			hunksResponse: held.response,
		});
		// The sticky stack: the app header and the files bar.
		root.style.setProperty("--app-header", "48px");
		root.style.setProperty("--files-bar", "40px");
		vi.spyOn(
			HTMLTableRowElement.prototype,
			"getBoundingClientRect",
		).mockImplementation(function (this: HTMLTableRowElement) {
			return {
				top: this.dataset.newNo === "8" && !this.dataset.oldNo ? 500 : 0,
			} as DOMRect;
		});
		await waitFor(() =>
			expect(screen.queryByText("line 12")).not.toBeInTheDocument(),
		);
		expect(window.scrollTo).not.toHaveBeenCalled();
		await act(async () => held.release(hunks));
		await screen.findByText("line 12");
		await waitFor(() => expect(window.scrollTo).toHaveBeenCalledTimes(1));
		// A few lines of context above it stay in view (useLanding's 60).
		expect(window.scrollTo).toHaveBeenCalledWith({ top: 500 - 48 - 40 - 60 });
		// The same step again (any re-render) doesn't scroll.
		refind(findAt({ ...current }, 1));
		expect(window.scrollTo).toHaveBeenCalledTimes(1);
		// The next step does.
		refind(findAt(current, 2));
		expect(window.scrollTo).toHaveBeenCalledTimes(2);
	});

	it("a collapsed whitespace-only cluster holding the current hit opens", async () => {
		ignoreWhitespace.set(true);
		const { collapsed } = setup({ find: findAt({ old: false, line: 3 }) });
		await screen.findByText("Whitespace only · 6 lines");
		expect(collapsed()[0]).toHaveAttribute("data-expanded");
		const row = document.querySelector('tr[data-new-no="3"]') as HTMLElement;
		expect(row).not.toBeNull();
		expect(row).toHaveAttribute("data-find-current");
	});
});
