// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CodeAnchor,
	DiffLine,
	FileHunks,
	FileView,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../shared/types";
import { draftsFor, newThreadKey } from "../threads/drafts";
import {
	getComposers,
	openComposer,
	resetComposers,
} from "../threads/newThreads";
import { ignoreWhitespace, showInvisibles } from "../viewSettings";
import { CODE_CELL, spanOfRange } from "./codeSpan";
import { codeCellOf, DiffBody, type DiffThreads } from "./DiffBody";
import { FileDiff } from "./FileDiff";
import { getPicks, setPicks } from "./linePicks";
import { SelectionBar } from "./SelectionBar";
import { type CodeSpan, registerSelectionAction } from "./selectionActions";

vi.mock("./highlight", () => ({
	languageFor: () => "ts",
	// One line comes highlighted, to cut a selection across tokens.
	highlightLine: async (text: string) =>
		text === "const x = 2;"
			? [
					{ content: "const", offset: 0, color: "#ff0000" },
					{ content: " x", offset: 5, color: "#00ff00" },
					{ content: " = 2;", offset: 7 },
				]
			: [],
}));

const HEAD = "h".repeat(40);
const PATH = "src/a.ts";

const ctx = (
	oldNo: number,
	newNo: number,
	text = `line ${newNo}`,
): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text,
});
const del = (oldNo: number, text: string): DiffLine => ({
	kind: "del",
	oldNo,
	text,
	clusterKey: "k",
});
const add = (newNo: number, text: string): DiffLine => ({
	kind: "add",
	newNo,
	text,
	clusterKey: "k",
});

/** One hunk at new 1–9 (a gap of 10–30 after it). */
const HUNKS: FileHunks = {
	newLineCount: 30,
	hunks: [
		{
			oldStart: 1,
			oldCount: 8,
			newStart: 1,
			newCount: 9,
			lines: [
				ctx(1, 1),
				ctx(2, 2, "a😀b"),
				del(3, "\tconst y = 2;"),
				del(4, "const x = 1;"),
				add(3, "  const y = 2;"),
				add(4, "const x = 2;"),
				add(5, "tail"),
				ctx(5, 6),
				ctx(6, 7),
				ctx(7, 8),
				ctx(8, 9),
			],
		},
	],
};

const file = (over: Partial<FileView> = {}): FileView => ({
	index: 0,
	path: PATH,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 3,
	deletions: 2,
	clusters: [
		{
			key: "k",
			kind: "lines",
			oldStart: 3,
			oldCount: 2,
			newStart: 3,
			newCount: 3,
			removed: [],
			added: [],
			lines: 5,
			state: "unreviewed",
		},
	],
	done: false,
	reviewed: false,
	crossedOff: false,
	...over,
});

let ids = 0;
const thread = (anchor: Partial<CodeAnchor>): ReviewThread => {
	ids += 1;
	const side = anchor.side ?? "RIGHT";
	const line = anchor.line ?? 1;
	return {
		id: `T${ids}`,
		loaded: true,
		path: PATH,
		line,
		currentLine: line,
		excerpt: "c",
		html: "<p>c</p>",
		body: "c",
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
			startSide: anchor.startSide ?? side,
			startLine: anchor.startLine ?? line,
			at: "2026-01-01T00:00:00Z",
			...anchor,
		},
		commit: HEAD,
		subject: "line",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: false },
	};
};

const overview = (over: Partial<PrOverview> = {}) =>
	({
		readId: "r",
		writes: "on",
		commentLeft: true,
		pendingReview: null,
		...over,
	}) as PrOverview;

let client: QueryClient;

function setup(
	opts: {
		threads?: ReviewThread[];
		overview?: Partial<PrOverview>;
		children?: ReactNode;
	} = {},
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname === "/api/files/0/hunks") {
				return new Response(JSON.stringify(HUNKS));
			}
			if (url.pathname === "/api/files/0/context") {
				const from = Number(url.searchParams.get("newFrom"));
				const to = Number(url.searchParams.get("newTo"));
				const lines = [];
				for (let n = from; n <= to; n++) lines.push(ctx(n - 1, n));
				return new Response(JSON.stringify(lines));
			}
			return new Response("{}", { status: 404 });
		}),
	);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// Like the page once the session is known (useThreadWritesSetup).
	draftsFor(client).bind("k");
	client.setQueryData(["overview"], overview(opts.overview));
	client.setQueryData(["session"], {
		snapshotHead: HEAD,
		viewer: "me",
		pr: { owner: "o", repo: "r", number: 1 },
	} as SessionInfo);
	const threads: DiffThreads = {
		readId: "r",
		snapshotHead: HEAD,
		threads: opts.threads ?? [],
	};
	const ui = (
		<QueryClientProvider client={client}>
			<section data-path={PATH}>
				<DiffBody
					file={file()}
					revision="r1"
					onToggle={() => {}}
					onCrossOff={() => {}}
					threads={threads}
				/>
			</section>
			{opts.children}
			<SelectionBar files={[file()]} />
		</QueryClientProvider>
	);
	const r = render(ui);
	return { ...r, user: userEvent.setup(), threads };
}

/** The code cell of the row numbered `line` on `side`. */
const cell = (
	side: "LEFT" | "RIGHT",
	line: number,
	root: ParentNode = document,
) =>
	root.querySelector(
		`tr[data-${side === "LEFT" ? "old" : "new"}-no="${line}"] > [${CODE_CELL}][data-side="${side}"]`,
	) as HTMLElement;

/** The point `col` characters into a cell's code (its text nodes in order). */
function point(el: Element, col: number): [Node, number] {
	const code = el.querySelector("[data-code]") as Element;
	const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
	let left = col;
	let last: Text | null = null;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		if (left < t.data.length) return [t, left];
		left -= t.data.length;
		last = t;
	}
	return last ? [last, last.data.length] : [code, 0];
}

function rangeOf(
	from: [Element, number] | [Node, number],
	to: [Element, number] | [Node, number],
): Range {
	const r = document.createRange();
	r.setStart(from[0], from[1]);
	r.setEnd(to[0], to[1]);
	return r;
}

/** A row's key: its code cell's side and the row's number on that side. */
const rowKey = (row: HTMLElement) => {
	const side = (row.querySelector(`[${CODE_CELL}]`) as HTMLElement).dataset
		.side;
	return `${side}:${side === "LEFT" ? row.dataset.oldNo : row.dataset.newNo}`;
};

const at = (side: "LEFT" | "RIGHT", line: number, col: number) =>
	point(cell(side, line), col);

const span = (r: Range) => spanOfRange(r, HEAD)?.span ?? null;

beforeEach(() => {
	showInvisibles.set(true);
	ignoreWhitespace.set(false);
	window.scrollTo = vi.fn();
	resetComposers();
	setPicks(null);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	showInvisibles.reset();
	ignoreWhitespace.reset();
	vi.restoreAllMocks();
});

const loaded = () => screen.findAllByTestId("diff-line");

describe("a selection's span", () => {
	it("inside one added line: RIGHT, its new number, UTF-16 columns", async () => {
		setup();
		await loaded();
		expect(span(rangeOf(at("RIGHT", 5, 1), at("RIGHT", 5, 3)))).toEqual({
			path: PATH,
			commit: HEAD,
			subject: "line",
			startSide: "RIGHT",
			startLine: 5,
			side: "RIGHT",
			line: 5,
			startCol: 1,
			endCol: 3,
		});
	});

	it("a deleted line is LEFT by its old number; a context line RIGHT by its new one", async () => {
		setup();
		await loaded();
		expect(span(rangeOf(at("LEFT", 4, 0), at("LEFT", 4, 5)))).toMatchObject({
			startSide: "LEFT",
			startLine: 4,
			side: "LEFT",
			line: 4,
			startCol: 0,
			endCol: 5,
		});
		expect(span(rangeOf(at("RIGHT", 7, 2), at("RIGHT", 7, 4)))).toMatchObject({
			side: "RIGHT",
			line: 7,
			startCol: 2,
			endCol: 4,
		});
		// The side is the cell's; the line its row's number on that side.
		expect(cell("RIGHT", 7).dataset.side).toBe("RIGHT");
		expect(cell("RIGHT", 7).closest("tr")?.dataset.oldNo).toBe("6");
	});

	it("across rows and sides: from a deleted line into an added one", async () => {
		setup();
		await loaded();
		expect(span(rangeOf(at("LEFT", 4, 6), at("RIGHT", 3, 4)))).toMatchObject({
			startSide: "LEFT",
			startLine: 4,
			side: "RIGHT",
			line: 3,
			startCol: 6,
			endCol: 4,
		});
	});

	it("context then a deleted line: the context line stays RIGHT (RIGHT→LEFT)", async () => {
		setup();
		await loaded();
		expect(span(rangeOf(at("RIGHT", 2, 0), at("LEFT", 3, 3)))).toMatchObject({
			startSide: "RIGHT",
			startLine: 2,
			side: "LEFT",
			line: 3,
		});
	});

	it("across a highlighting token boundary", async () => {
		setup();
		await loaded();
		const c = cell("RIGHT", 4);
		await vi.waitFor(() =>
			expect(c.querySelectorAll("[data-code] span[style]").length).toBe(2),
		);
		expect(span(rangeOf(point(c, 2), point(c, 6)))).toMatchObject({
			line: 4,
			startCol: 2,
			endCol: 6,
		});
	});

	it("counts a tab and its invisibles marker as the one character it is", async () => {
		setup();
		await loaded();
		const c = cell("LEFT", 3);
		// The marker's glyph is CSS: the DOM holds the tab itself.
		expect(c.querySelector('[data-inv="tab"]')).not.toBeNull();
		expect(span(rangeOf(point(c, 1), point(c, 6)))).toMatchObject({
			startCol: 1,
			endCol: 6,
		});
		// Starting inside the marker's own character.
		const tab = c.querySelector('[data-inv="tab"] > span')?.firstChild as Node;
		expect(span(rangeOf([tab, 0], point(c, 6)))).toMatchObject({
			startCol: 0,
			endCol: 6,
		});
	});

	it("counts a non-BMP character as two UTF-16 units", async () => {
		setup();
		await loaded();
		const c = cell("RIGHT", 2);
		// "a😀b": b is at 3.
		expect(span(rangeOf(point(c, 3), point(c, 4)))).toMatchObject({
			startCol: 3,
			endCol: 4,
		});
	});

	it("whole lines have no columns; edges outside the code clamp to it", async () => {
		setup();
		await loaded();
		const row = (side: "LEFT" | "RIGHT", n: number) =>
			cell(side, n).closest("tr") as HTMLElement;
		// From the line number of 6 to the start of 8: lines 6–7.
		const s = span(rangeOf([row("RIGHT", 6), 0], at("RIGHT", 8, 0)));
		expect(s).toMatchObject({
			startLine: 6,
			line: 7,
			startCol: null,
			endCol: null,
		});
		// A collapsed selection, or none in code: no span.
		expect(span(rangeOf(at("RIGHT", 6, 2), at("RIGHT", 6, 2)))).toBeNull();
	});

	it("stays in one file: a selection running into the next is clamped", async () => {
		setup({
			children: (
				<section data-path="other.ts">
					<table>
						<tbody>
							<tr data-new-no="1">
								<td
									{...{ [CODE_CELL]: "" }}
									data-side="RIGHT"
									data-len="5"
									data-hunk="h0"
								>
									<span data-code="">other</span>
								</td>
							</tr>
						</tbody>
					</table>
				</section>
			),
		});
		await loaded();
		const other = document.querySelector(
			'[data-path="other.ts"] [data-code]',
		) as Element;
		const s = span(rangeOf(at("RIGHT", 9, 2), [other.firstChild as Node, 3]));
		expect(s).toMatchObject({ path: PATH, startLine: 9, line: 9, startCol: 2 });
	});

	it("a range ending in expanded context is flagged as outside GitHub's diff; that context is RIGHT by its new number", async () => {
		const { user } = setup();
		await loaded();
		await user.click(screen.getByRole("button", { name: /Load .* below/ }));
		await screen.findByText("line 12");
		const c = cell("RIGHT", 12);
		expect(c.dataset.hunk).toBe("g1");
		const found = spanOfRange(rangeOf(at("RIGHT", 9, 0), point(c, 2)), HEAD);
		expect(found).toMatchObject({
			span: { startLine: 9, line: 12 },
			inDiff: false,
		});
	});

	it("whitespace rows: a pair by its new side, a lone line by its own", () => {
		expect(codeCellOf({ kind: "ws", oldNo: 4, newNo: 5, text: "x" })).toEqual({
			side: "RIGHT",
			line: 5,
		});
		expect(codeCellOf({ kind: "ws", oldNo: 4, text: "x" })).toEqual({
			side: "LEFT",
			line: 4,
		});
		expect(codeCellOf({ kind: "ws", newNo: 7, text: "x" })).toEqual({
			side: "RIGHT",
			line: 7,
		});
	});
});

describe("painting a thread's span", () => {
	const markedText = () =>
		[...document.querySelectorAll("[data-span-mark]")]
			.map((m) => m.textContent)
			.join("|");
	const commented = () =>
		[...document.querySelectorAll<HTMLElement>("tr[data-commented]")].map((r) =>
			cellKey(r),
		);
	const cellKey = rowKey;

	it("paints exactly the span's characters on top of its lines", async () => {
		setup({
			threads: [
				thread({
					startSide: "LEFT",
					startLine: 4,
					side: "RIGHT",
					line: 3,
					startCol: 6,
					endCol: 4,
				}),
			],
		});
		await loaded();
		expect(commented()).toEqual(["LEFT:4", "RIGHT:3"]);
		// The two leading spaces are their own (invisibles) marker.
		expect(markedText()).toBe("x = 1;|  |co");
	});

	it("falls back to the lines when the columns don't fit", async () => {
		setup({ threads: [thread({ line: 5, startCol: 1, endCol: 99 })] });
		await loaded();
		expect(commented()).toEqual(["RIGHT:5"]);
		expect(markedText()).toBe("");
	});

	it.each([
		["a context row", { line: 7 }, ["RIGHT:7"]],
		["an added row", { line: 5 }, ["RIGHT:5"]],
		["a deleted row", { side: "LEFT", line: 4 }, ["LEFT:4"]],
		[
			"added rows",
			{ startLine: 3, line: 5 },
			["RIGHT:3", "RIGHT:4", "RIGHT:5"],
		],
	] as const)("the painted rows are the anchor's: %s", async (_, a, keys) => {
		setup({ threads: [thread(a)] });
		await loaded();
		expect(commented()).toEqual(keys);
	});

	it("the painted rows are the anchor's: a whitespace pair (by its new number)", async () => {
		ignoreWhitespace.set(true);
		setup({ threads: [thread({ line: 3, startCol: 2, endCol: 7 })] });
		await loaded();
		const row = cell("RIGHT", 3).closest("tr") as HTMLElement;
		expect(row.dataset.kind).toBe("ws");
		expect(commented()).toEqual(["RIGHT:3"]);
		expect(markedText()).toBe("const");
	});

	it("the painted rows are the anchor's: expanded context", async () => {
		const { user } = setup({ threads: [thread({ startLine: 11, line: 12 })] });
		await loaded();
		await user.click(screen.getByRole("button", { name: /comment/ }));
		await screen.findByText("line 12");
		expect(commented()).toEqual(["RIGHT:11", "RIGHT:12"]);
	});
});

describe("picking lines by their numbers", () => {
	const number = (side: "LEFT" | "RIGHT", n: number) =>
		within(cell(side, n).closest("tr") as HTMLElement).getByRole("button", {
			name: `${side === "LEFT" ? "Old line" : "Line"} ${n}`,
		});
	const pickedKeys = () =>
		[...document.querySelectorAll<HTMLElement>("tr[data-picked]")].map(rowKey);
	const press = (el: Element, init: Partial<PointerEventInit> = {}) => {
		fireEvent.pointerDown(el, {
			pointerType: "mouse",
			button: 0,
			buttons: 1,
			...init,
		});
		fireEvent.pointerUp(window);
		fireEvent.click(el, { detail: 1, ...init });
	};

	it("a click picks a line, shift-click extends, a click on it alone clears", async () => {
		setup();
		await loaded();
		press(number("RIGHT", 6).closest("td") as Element);
		expect(pickedKeys()).toEqual(["RIGHT:6"]);
		press(number("RIGHT", 8).closest("td") as Element, { shiftKey: true });
		expect(pickedKeys()).toEqual(["RIGHT:6", "RIGHT:7", "RIGHT:8"]);
		press(number("RIGHT", 7).closest("td") as Element);
		expect(pickedKeys()).toEqual(["RIGHT:7"]);
		press(number("RIGHT", 7).closest("td") as Element);
		expect(pickedKeys()).toEqual([]);
	});

	it("dragging down the numbers extends", async () => {
		setup();
		await loaded();
		const td = (n: number) => number("RIGHT", n).closest("td") as Element;
		fireEvent.pointerDown(td(6), {
			pointerType: "mouse",
			button: 0,
			buttons: 1,
		});
		fireEvent.pointerEnter(td(7), { buttons: 1 });
		fireEvent.pointerEnter(td(9), { buttons: 1 });
		fireEvent.pointerUp(window);
		expect(pickedKeys()).toEqual(["RIGHT:6", "RIGHT:7", "RIGHT:8", "RIGHT:9"]);
		// Moving after letting go changes nothing.
		fireEvent.pointerEnter(td(1), { buttons: 0 });
		expect(pickedKeys()).toHaveLength(4);
	});

	it("on touch a second tap extends", async () => {
		setup();
		await loaded();
		const tap = (el: Element) => {
			fireEvent.pointerDown(el, { pointerType: "touch" });
			fireEvent.click(el, { detail: 1 });
		};
		tap(number("LEFT", 3).closest("td") as Element);
		expect(pickedKeys()).toEqual(["LEFT:3"]);
		tap(number("RIGHT", 4).closest("td") as Element);
		expect(pickedKeys()).toEqual(["LEFT:3", "LEFT:4", "RIGHT:3", "RIGHT:4"]);
	});

	it("the keyboard: one tab stop, Up/Down move, Shift extends, Enter picks, Escape clears", async () => {
		const { user } = setup();
		await loaded();
		const stops = [...document.querySelectorAll("button[data-pick]")].filter(
			(b) => (b as HTMLElement).tabIndex === 0,
		);
		expect(stops).toEqual([number("RIGHT", 1)]);
		number("RIGHT", 1).focus();
		await user.keyboard("{ArrowDown}");
		expect(number("RIGHT", 2)).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(pickedKeys()).toEqual(["RIGHT:2"]);
		await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
		expect(number("LEFT", 3)).toHaveFocus();
		expect(pickedKeys()).toEqual(["RIGHT:2", "LEFT:3"]);
		// The bar is up for the picked lines; Escape lets them go.
		expect(await screen.findByTestId("selection-bar")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(pickedKeys()).toEqual([]);
		expect(getPicks()).toBeNull();
	});

	it("picked lines make a whole-line span; Comment opens a composer there", async () => {
		const { user } = setup();
		await loaded();
		press(number("RIGHT", 6).closest("td") as Element);
		press(number("RIGHT", 7).closest("td") as Element, { shiftKey: true });
		const bar = await screen.findByTestId("selection-bar");
		await user.click(within(bar).getByRole("button", { name: "Comment" }));
		expect(getComposers()).toMatchObject([
			{
				span: {
					path: PATH,
					commit: HEAD,
					subject: "line",
					startSide: "RIGHT",
					startLine: 6,
					side: "RIGHT",
					line: 7,
					startCol: null,
					endCol: null,
				},
			},
		]);
		expect(pickedKeys()).toEqual([]);
		// Under the span's last row, the span painted, the box focused.
		const composer = await screen.findByTestId("new-thread-row");
		expect(
			(composer.previousElementSibling as HTMLElement).querySelector(
				`[${CODE_CELL}]`,
			),
		).toBe(cell("RIGHT", 7));
		expect(within(composer).getByText("lines 6–7, new")).toBeInTheDocument();
		expect(
			within(composer).getByRole("textbox", { name: "Comment" }),
		).toHaveFocus();
		expect([...document.querySelectorAll("tr[data-commented]")].length).toBe(2);
	});
});

describe("the selection bar", () => {
	const pick = (lines: number[]) =>
		act(() =>
			setPicks({
				path: PATH,
				anchor: {
					side: "RIGHT",
					line: lines[0] as number,
					len: 6,
					hunk: "h0",
					path: PATH,
				},
				focus: {
					side: "RIGHT",
					line: lines[lines.length - 1] as number,
					len: 6,
					hunk: "h0",
					path: PATH,
				},
				lines: lines.map((line) => ({
					side: "RIGHT",
					line,
					len: 6,
					hunk: "h0",
					path: PATH,
				})),
			}),
		);

	it("keeps Comment visible but off, with the reason, where writing is off", async () => {
		const { user } = setup({ overview: { writes: "as-of" } });
		await loaded();
		pick([6]);
		const button = within(await screen.findByTestId("selection-bar")).getByRole(
			"button",
			{ name: "Comment" },
		);
		expect(button).toHaveAttribute("aria-disabled", "true");
		await user.click(button);
		expect(getComposers()).toEqual([]);
		expect(button).toHaveAccessibleDescription(
			"Comments are off as of a cutoff",
		);
	});

	it("says why a line of expanded context is off", async () => {
		const { user } = setup();
		await loaded();
		await user.click(screen.getByRole("button", { name: /Load .* below/ }));
		await screen.findByText("line 12");
		const td = (cell("RIGHT", 12).closest("tr") as HTMLElement).querySelector(
			'[data-testid="new"]',
		) as Element;
		fireEvent.pointerDown(td, { pointerType: "mouse", button: 0, buttons: 1 });
		fireEvent.pointerUp(window);
		const button = within(await screen.findByTestId("selection-bar")).getByRole(
			"button",
			{ name: "Comment" },
		);
		expect(button).toHaveAccessibleDescription(
			"GitHub only takes comments on lines in the diff",
		);
	});

	it("picks may cross sides: an old number to a new one is LEFT→RIGHT", async () => {
		const { user } = setup();
		await loaded();
		const td = (side: "LEFT" | "RIGHT", n: number) =>
			(cell(side, n).closest("tr") as HTMLElement).querySelector(
				`[data-testid="${side === "LEFT" ? "old" : "new"}"]`,
			) as Element;
		fireEvent.pointerDown(td("LEFT", 4), {
			pointerType: "mouse",
			button: 0,
			buttons: 1,
		});
		fireEvent.pointerUp(window);
		fireEvent.pointerDown(td("RIGHT", 4), {
			pointerType: "mouse",
			button: 0,
			buttons: 1,
			shiftKey: true,
		});
		fireEvent.pointerUp(window);
		const bar = await screen.findByTestId("selection-bar");
		await user.click(within(bar).getByRole("button", { name: "Comment" }));
		expect(getComposers()[0]?.span).toMatchObject({
			startSide: "LEFT",
			startLine: 4,
			side: "RIGHT",
			line: 4,
			startCol: null,
		});
	});

	it("says why old lines are off with a pinned head that moved", async () => {
		setup({ overview: { commentLeft: false } });
		await loaded();
		act(() =>
			setPicks({
				path: PATH,
				anchor: { side: "LEFT", line: 4, len: 12, hunk: "h0", path: PATH },
				focus: { side: "LEFT", line: 4, len: 12, hunk: "h0", path: PATH },
				lines: [{ side: "LEFT", line: 4, len: 12, hunk: "h0", path: PATH }],
			}),
		);
		const button = within(await screen.findByTestId("selection-bar")).getByRole(
			"button",
			{ name: "Comment" },
		);
		expect(button).toHaveAccessibleDescription(
			"Old lines can't take comments with this pinned head",
		);
	});

	it("a registered action shows beside Comment and gets the span", async () => {
		const started: CodeSpan[] = [];
		const remove = registerSelectionAction({
			id: "ask",
			icon: () => null,
			label: "Ask",
			available: () => true,
			start: (s) => started.push(s),
		});
		try {
			const { user } = setup();
			await loaded();
			pick([8]);
			const bar = await screen.findByTestId("selection-bar");
			await user.click(within(bar).getByRole("button", { name: "Ask" }));
			expect(started).toMatchObject([{ line: 8, startLine: 8 }]);
		} finally {
			remove();
		}
	});

	it("a mouse press on the bar keeps the selection", async () => {
		setup();
		await loaded();
		pick([6]);
		const bar = await screen.findByTestId("selection-bar");
		const down = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		bar.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
	});
});

describe("the composer", () => {
	const lineSpan: CodeSpan = {
		path: PATH,
		commit: HEAD,
		subject: "line",
		startSide: "RIGHT",
		startLine: 4,
		side: "RIGHT",
		line: 4,
		startCol: 0,
		endCol: 5,
	};

	it("quotes the span, keeps a draft from the first keystroke, and restores it after a reload", async () => {
		const { user, unmount } = setup();
		await loaded();
		act(() => {
			openComposer(lineSpan, "c1");
		});
		const box = await screen.findByRole("textbox", { name: "Comment" });
		expect(screen.getByTestId("new-thread-quote")).toHaveTextContent("const");
		expect(screen.getByText("line 4, new")).toBeInTheDocument();
		// Opening alone stores nothing.
		expect(draftsFor(client).get()).toEqual([]);
		await user.type(box, "W");
		expect(draftsFor(client).newThread("c1")).toMatchObject({
			text: "W",
			create: { line: 4, startCol: 0, endCol: 5 },
		});
		unmount();
		resetComposers();
		// A reload: a new page, the same storage.
		const stored = localStorage.length;
		expect(stored).toBeGreaterThan(0);
		const again = setup();
		await loaded();
		expect(
			await within(again.container).findByRole("textbox", { name: "Comment" }),
		).toHaveValue("W");
	});

	it("Escape cancels, asking first when something was typed", async () => {
		const { user } = setup();
		await loaded();
		act(() => {
			openComposer(lineSpan, "c2");
		});
		const box = await screen.findByRole("textbox", { name: "Comment" });
		await user.type(box, "keep");
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		await user.keyboard("{Escape}");
		expect(confirm).toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(
			"keep",
		);
		confirm.mockReturnValue(true);
		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("new-thread")).toBeNull();
		expect(draftsFor(client).get()).toEqual([]);
	});

	it("an empty composer closes without asking", async () => {
		const { user } = setup();
		await loaded();
		act(() => {
			openComposer(lineSpan, "c3");
		});
		await screen.findByRole("textbox", { name: "Comment" });
		const confirm = vi.spyOn(window, "confirm");
		await user.keyboard("{Escape}");
		expect(confirm).not.toHaveBeenCalled();
		expect(screen.queryByTestId("new-thread")).toBeNull();
	});

	it("a draft on another head is kept as an orphan with its text", async () => {
		setup();
		await loaded();
		act(() =>
			draftsFor(client).setNew(
				"old",
				{ ...lineSpan, commit: "e".repeat(40) } as never,
				"from before",
			),
		);
		const orphan = await screen.findByTestId("orphan-draft");
		expect(orphan).toHaveTextContent("from before");
		expect(orphan).toHaveTextContent("Lines gone");
	});

	it("posting shows it as sending; a refusal is back in the box with why", async () => {
		const { user } = setup();
		await loaded();
		let answer: (r: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(input: RequestInfo | URL) =>
					new Promise<Response>((resolve) => {
						if (String(input) === "/api/threads") answer = resolve;
						else resolve(new Response("{}", { status: 404 }));
					}),
			),
		);
		act(() => {
			openComposer(lineSpan, "c4");
		});
		const box = await screen.findByRole("textbox", { name: "Comment" });
		await user.type(box, "why?");
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(await screen.findByTestId("new-thread-sending")).toHaveTextContent(
			"why?",
		);
		expect(screen.getByLabelText("Sending")).toBeInTheDocument();
		await act(async () => {
			answer(
				new Response(JSON.stringify({ error: "no", code: "gone" }), {
					status: 404,
				}),
			);
		});
		expect(await screen.findByTestId("new-thread-error")).toHaveTextContent(
			"GitHub doesn't take a comment on this line",
		);
		expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(
			"why?",
		);
		expect(draftsFor(client).newThread("c4")?.create?.sending).toBeUndefined();
		expect(
			draftsFor(client)
				.get()
				.map((d) => d.threadId),
		).toEqual([newThreadKey("c4")]);
	});
});

describe("Comment on file", () => {
	const kinds: [string, Partial<FileView>][] = [
		["text", {}],
		["empty", { additions: 0, deletions: 0, clusters: [] }],
		["binary", { binary: true, clusters: [] }],
		[
			"renamed-only",
			{ status: "renamed", oldPath: "src/old.ts", clusters: [] },
		],
		["mode-only", { oldMode: "100644", newMode: "100755", clusters: [] }],
		["deleted", { status: "deleted" }],
		["submodule", { submodule: true, clusters: [] }],
		[
			"symlink",
			{ status: "type-changed", oldMode: "100644", newMode: "120000" },
		],
	];

	it.each(kinds)(
		"is in the header of a %s file, open or not, and opens the composer there",
		async (_, over) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ hunks: [], newLineCount: 0 })),
				),
			);
			client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			client.setQueryData(["overview"], overview());
			client.setQueryData(["session"], { snapshotHead: HEAD } as SessionInfo);
			const user = userEvent.setup();
			render(
				<QueryClientProvider client={client}>
					<FileDiff file={file(over)} revision="r1" unit="clusters" />
				</QueryClientProvider>,
			);
			const button = screen.getByRole("button", { name: "Comment on file" });
			expect(button).not.toHaveAttribute("aria-disabled");
			await user.click(button);
			const area = await screen.findByTestId("file-new-threads");
			expect(within(area).getByText("whole file")).toBeInTheDocument();
			expect(getComposers()).toMatchObject([
				{ span: { path: PATH, commit: HEAD, subject: "file" } },
			]);
		},
	);

	it("is off, with the reason, when writing is off", () => {
		client = new QueryClient();
		client.setQueryData(["overview"], overview({ writes: "viewer" }));
		client.setQueryData(["session"], { snapshotHead: HEAD } as SessionInfo);
		render(
			<QueryClientProvider client={client}>
				<FileDiff file={file()} revision="r1" unit="clusters" />
			</QueryClientProvider>,
		);
		const button = screen.getByRole("button", { name: "Comment on file" });
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveAccessibleDescription(
			"Comments are off when viewing as someone else",
		);
	});
});
