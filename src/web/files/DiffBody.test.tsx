// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	ReviewThread,
} from "../../shared/types";
import { ignoreWhitespace, showInvisibles } from "../viewSettings";
import { DiffBody, type DiffThreads, LANDED_MS } from "./DiffBody";
import type { Landing } from "./landing";

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
	} = {},
) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://test");
		const body =
			url.pathname === "/api/files/0/hunks" ? (opts.hunks ?? hunks) : {};
		return new Response(JSON.stringify(body), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onToggle = vi.fn();
	const onCrossOff = vi.fn();
	const threads: DiffThreads | undefined = opts.threads
		? { readId: "r", snapshotHead: HEAD, threads: opts.threads }
		: undefined;
	render(
		<QueryClientProvider client={queryClient}>
			<DiffBody
				file={file(opts.clusters ?? clusters)}
				revision="r1"
				onToggle={onToggle}
				onCrossOff={onCrossOff}
				threads={threads}
				landing={opts.landing}
			/>
		</QueryClientProvider>,
	);
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
});
