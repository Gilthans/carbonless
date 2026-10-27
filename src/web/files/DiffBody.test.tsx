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
import { DiffBody, type DiffThreads } from "./DiffBody";
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
		const expand = within(row).getByRole("button", {
			name: "Show whitespace-only lines",
		});
		expect(expand).toHaveAttribute("aria-expanded", "false");
		await user.click(expand);
		expect(expand).toHaveAttribute("aria-expanded", "true");
		expect(rows().slice(1, 4)).toEqual([
			{ kind: "ws", old: "2", new: "2", text: "if (a) {" },
			{ kind: "ws", old: "3", new: "3", text: "return b;" },
			{ kind: "ws", old: "4", new: "4", text: "}" },
		]);
		expect(
			within(row).getByRole("button", { name: "Hide whitespace-only lines" }),
		).toBeInTheDocument();
		await user.click(
			within(row).getByRole("button", { name: "Hide whitespace-only lines" }),
		);
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
		expect(
			within(row as HTMLElement).getByTestId("thread-bubble"),
		).toBeInTheDocument();
		// Nothing can hide the bubble: no collapse while it's there.
		expect(
			screen.queryByRole("button", { name: "Show whitespace-only lines" }),
		).toBeNull();
	});

	it("keeps a whitespace-only cluster open when one of its lines is landed on", async () => {
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
