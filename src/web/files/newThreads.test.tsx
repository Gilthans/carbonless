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
import { ShortcutsProvider } from "../shortcuts";
import { type LineTexts, spanTexts } from "../threads/draftMove";
import { draftsFor, newThreadKey } from "../threads/drafts";
import {
	getComposers,
	openComposer,
	resetComposers,
} from "../threads/newThreads";
import type { SpanRange } from "../threads/spanMarks";
import { ignoreWhitespace, showInvisibles, sideBySide } from "../viewSettings";
import { CODE_CELL, cellLine, spanOfRange } from "./codeSpan";
import { codeCellOf, DiffBody, type DiffThreads } from "./DiffBody";
import { FileDiff } from "./FileDiff";
import { getPicks, pickKey, setPicks } from "./linePicks";
import {
	currentView,
	HANDLE_GAP,
	pickAnchor,
	placeBar,
	resetPointer,
	SelectionBar,
	textGeometry,
} from "./SelectionBar";
import {
	type CodeSpan,
	commentAvailable,
	registerSelectionAction,
} from "./selectionActions";

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
		/** The diff shown is the viewed head's (default yes). */
		headSure?: boolean;
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
			<ShortcutsProvider>
				<section data-path={PATH}>
					<DiffBody
						file={file()}
						revision="r1"
						onToggle={() => {}}
						onCrossOff={() => {}}
						threads={threads}
						headSure={opts.headSure ?? true}
					/>
				</section>
				{opts.children}
				<SelectionBar files={[file()]} />
			</ShortcutsProvider>
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

/** Selects `r` in the document and lets the pointer go (the bar reads it). */
function selectAndRelease(r: Range) {
	act(() => {
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(r);
		document.dispatchEvent(new Event("pointerup"));
	});
}

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

describe("a selection's edges", () => {
	it("a start at the very end of the row above starts on the next row", async () => {
		setup();
		await loaded();
		const len = "line 6".length;
		expect(span(rangeOf(at("RIGHT", 6, len), at("RIGHT", 7, 3)))).toMatchObject(
			{
				startLine: 7,
				line: 7,
				startCol: 0,
				endCol: 3,
			},
		);
	});

	it("a start inside an opened thread's row starts on the row after it", async () => {
		const { user } = setup({ threads: [thread({ line: 6 })] });
		await loaded();
		await user.click(screen.getByRole("button", { name: /comment on line 6/ }));
		const threadRow = await screen.findByTestId("thread-row");
		const inThread = within(threadRow).getByText("Unresolved")
			.firstChild as Node;
		expect(span(rangeOf([inThread, 0], at("RIGHT", 7, 4)))).toMatchObject({
			startLine: 7,
			line: 7,
			startCol: 0,
			endCol: 4,
		});
	});
});

describe("Ignore whitespace and GitHub's order", () => {
	it("a range whose start comes after its end in GitHub's order goes the way GitHub takes it, as whole lines", async () => {
		ignoreWhitespace.set(true);
		setup();
		await loaded();
		// Del "\tconst y = 2;" (3) and add "  const y = 2;" (3) are a pair,
		// shown where the add goes: ahead of del 4 in display, after it on GitHub.
		const pair = cell("RIGHT", 3);
		expect(pair.closest("tr")?.getAttribute("data-kind")).toBe("ws");
		const found = spanOfRange(rangeOf(point(pair, 2), at("LEFT", 4, 3)), HEAD);
		// Old 4 first, then new 3; the selected characters (a tail of one
		// line, a head of the other) fit no marker on the swapped ends. The
		// cells stay as shown (the bar sits by them).
		expect(found).toEqual({
			span: {
				path: PATH,
				commit: HEAD,
				subject: "line",
				startSide: "LEFT",
				startLine: 4,
				side: "RIGHT",
				line: 3,
				startCol: null,
				endCol: null,
			},
			inDiff: true,
			cells: { head: pair, last: cell("LEFT", 4) },
		});
		expect(
			commentAvailable(found?.span as CodeSpan, {
				writes: "on",
				commentLeft: true,
				file: { binary: false, submodule: false },
			}),
		).toBe(true);
		// The other way round is in GitHub's order: as selected, with its columns.
		expect(
			spanOfRange(rangeOf(at("LEFT", 4, 0), at("RIGHT", 4, 3)), HEAD)?.span,
		).toMatchObject({
			startSide: "LEFT",
			startLine: 4,
			side: "RIGHT",
			line: 4,
			startCol: 0,
			endCol: 3,
		});
	});

	it("a selection from the ~ row through the deleted row below it: Comment is on and opens on old 4 – new 3", async () => {
		ignoreWhitespace.set(true);
		const { user } = setup();
		await loaded();
		selectAndRelease(rangeOf(at("RIGHT", 3, 2), at("LEFT", 4, 3)));
		const bar = await screen.findByTestId("selection-bar");
		const comment = within(bar).getByRole("button", { name: "Comment" });
		expect(comment).not.toHaveAttribute("aria-disabled");
		await user.click(comment);
		expect(getComposers()).toMatchObject([
			{
				span: {
					startSide: "LEFT",
					startLine: 4,
					side: "RIGHT",
					line: 3,
					startCol: null,
					endCol: null,
				},
			},
		]);
		const composer = await screen.findByTestId("new-thread-row");
		expect(within(composer).getByText("old 4 – new 3")).toBeInTheDocument();
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

	it("the painted rows are the anchor's: context into a deletion (RIGHT→LEFT)", async () => {
		setup({
			threads: [
				thread({ startSide: "RIGHT", startLine: 2, side: "LEFT", line: 3 }),
			],
		});
		await loaded();
		expect(commented()).toEqual(["RIGHT:2", "LEFT:3"]);
	});

	it("the painted rows are the anchor's: a LEFT start on context, as the server maps GitHub's", async () => {
		setup({
			threads: [
				thread({ startSide: "LEFT", startLine: 2, side: "LEFT", line: 4 }),
			],
		});
		await loaded();
		expect(commented()).toEqual(["RIGHT:2", "LEFT:3", "LEFT:4"]);
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

	it("lines picked from an old number to a new one paint those rows while the comment is written", async () => {
		const { user } = setup();
		await loaded();
		press(number("LEFT", 4).closest("td") as Element);
		press(number("RIGHT", 4).closest("td") as Element, { shiftKey: true });
		const bar = await screen.findByTestId("selection-bar");
		await user.click(within(bar).getByRole("button", { name: "Comment" }));
		await screen.findByTestId("new-thread-row");
		expect(
			[...document.querySelectorAll<HTMLElement>("tr[data-commented]")].map(
				rowKey,
			),
		).toEqual(["LEFT:4", "RIGHT:3", "RIGHT:4"]);
	});

	it("starting a text selection lets picked lines go", async () => {
		setup();
		await loaded();
		press(number("RIGHT", 6).closest("td") as Element);
		expect(pickedKeys()).toEqual(["RIGHT:6"]);
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		await vi.waitFor(() => expect(pickedKeys()).toEqual([]));
		expect(getPicks()).toBeNull();
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

	it("c starts a comment on what is selected; not while typing, nor where Comment is off", async () => {
		const { user } = setup();
		await loaded();
		await user.keyboard("c");
		expect(getComposers()).toEqual([]);
		pick([6, 7]);
		await screen.findByTestId("selection-bar");
		await user.keyboard("c");
		expect(getComposers()).toMatchObject([
			{ span: { startLine: 6, line: 7, startCol: null } },
		]);
		// Typing "c" in the composer is just text.
		const box = await screen.findByRole("textbox", { name: "Comment" });
		await user.type(box, "c");
		expect(box).toHaveValue("c");
		expect(getComposers()).toHaveLength(1);
	});

	it("c does nothing where Comment is off", async () => {
		const { user } = setup({ overview: { writes: "as-of" } });
		await loaded();
		pick([6]);
		await screen.findByTestId("selection-bar");
		await user.keyboard("c");
		expect(getComposers()).toEqual([]);
	});

	it("Escape puts the bar away for a text selection until the selection changes", async () => {
		const { user } = setup();
		await loaded();
		selectAndRelease(rangeOf(at("RIGHT", 7, 0), at("RIGHT", 7, 4)));
		expect(await screen.findByTestId("selection-bar")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByTestId("selection-bar")).toBeNull();
		// The selection itself stays; another one brings the bar back.
		expect(document.getSelection()?.toString()).toBe("line");
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 4)));
		expect(await screen.findByTestId("selection-bar")).toBeInTheDocument();
	});

	it("after Escape, the same lines picked again bring the bar (and c) back", async () => {
		const { user } = setup();
		await loaded();
		pick([6]);
		await screen.findByTestId("selection-bar");
		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("selection-bar")).toBeNull();
		pick([6]);
		expect(await screen.findByTestId("selection-bar")).toBeInTheDocument();
		await user.keyboard("c");
		expect(getComposers()).toMatchObject([{ span: { line: 6 } }]);
	});

	it("the first Tab isn't taken from inside a dialog", async () => {
		const { user } = setup({
			children: (
				<div role="dialog" aria-label="Settings">
					<button type="button">Theme</button>
					<button type="button">Next</button>
				</div>
			),
		});
		await loaded();
		pick([6]);
		const bar = await screen.findByTestId("selection-bar");
		screen.getByRole("button", { name: "Theme" }).focus();
		await user.tab();
		expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
		expect(
			within(bar).getByRole("button", { name: "Comment" }),
		).not.toHaveFocus();
	});

	it("the first Tab after a selection goes to the bar", async () => {
		const { user } = setup();
		await loaded();
		selectAndRelease(rangeOf(at("RIGHT", 7, 0), at("RIGHT", 7, 4)));
		const bar = await screen.findByTestId("selection-bar");
		await user.tab();
		expect(within(bar).getByRole("button", { name: "Comment" })).toHaveFocus();
		// (That the selection stays is checked in a real browser: e2e.)
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

	const OLD = "e".repeat(40);

	it("a draft from an earlier head moves to this one when its lines read the same", async () => {
		setup();
		await loaded();
		act(() =>
			draftsFor(client).setNew(
				"moved",
				{ ...lineSpan, commit: OLD } as never,
				"still true",
				spanTexts(HUNKS.hunks, lineSpan as SpanRange) as LineTexts,
			),
		);
		const box = await screen.findByRole("textbox", { name: "Comment" });
		expect(box).toHaveValue("still true");
		expect(draftsFor(client).newThread("moved")?.create?.commit).toBe(HEAD);
		expect(screen.queryByTestId("orphan-draft")).toBeNull();
	});

	it("one whose lines read differently now stays an orphan, written on an earlier version", async () => {
		setup();
		await loaded();
		act(() =>
			draftsFor(client).setNew(
				"changed",
				{ ...lineSpan, commit: OLD } as never,
				"from before",
				{
					...(spanTexts(HUNKS.hunks, lineSpan as SpanRange) as LineTexts),
					lines: ["const x = 3;"],
				},
			),
		);
		const orphan = await screen.findByTestId("orphan-draft");
		expect(orphan).toHaveTextContent("from before");
		expect(orphan).toHaveTextContent("Written on an earlier version");
		expect(draftsFor(client).newThread("changed")?.create?.commit).toBe(OLD);
	});

	it("one whose line is past the file's end says its lines are gone", async () => {
		setup();
		await loaded();
		act(() =>
			draftsFor(client).setNew(
				"gone",
				{ ...lineSpan, commit: OLD, startLine: 40, line: 40 } as never,
				"lost line",
				{ lines: ["x"], before: [], after: [] },
			),
		);
		const orphan = await screen.findByTestId("orphan-draft");
		expect(orphan).toHaveTextContent("Lines gone");
		expect(orphan).toHaveTextContent("lost line");
	});

	it("doesn't move while the diff shown is still the earlier head's (a Refresh's moment)", async () => {
		setup({ headSure: false });
		await loaded();
		act(() =>
			draftsFor(client).setNew(
				"early",
				{ ...lineSpan, commit: OLD } as never,
				"wait",
				spanTexts(HUNKS.hunks, lineSpan as SpanRange) as LineTexts,
			),
		);
		expect(await screen.findByTestId("orphan-draft")).toHaveTextContent("wait");
		await new Promise((r) => setTimeout(r, 30));
		expect(draftsFor(client).newThread("early")?.create?.commit).toBe(OLD);
	});

	it("doesn't move onto old lines this head can't comment on", async () => {
		setup({ overview: { commentLeft: false } });
		await loaded();
		const left: CodeSpan = {
			...lineSpan,
			startSide: "LEFT",
			side: "LEFT",
			startLine: 4,
			line: 4,
			startCol: null,
			endCol: null,
		};
		act(() =>
			draftsFor(client).setNew(
				"left",
				{ ...left, commit: OLD } as never,
				"old side",
				spanTexts(HUNKS.hunks, left as SpanRange) as LineTexts,
			),
		);
		expect(await screen.findByTestId("orphan-draft")).toHaveTextContent(
			"old side",
		);
		expect(draftsFor(client).newThread("left")?.create?.commit).toBe(OLD);
	});

	it("keeps its lines' text with the draft as it is typed", async () => {
		const { user } = setup();
		await loaded();
		act(() => {
			openComposer(lineSpan, "t1");
		});
		await user.type(
			await screen.findByRole("textbox", { name: "Comment" }),
			"x",
		);
		expect(draftsFor(client).newThread("t1")?.create?.texts).toEqual({
			lines: ["const x = 2;"],
			before: ["\tconst y = 2;", "const x = 1;", "  const y = 2;"],
			after: ["tail", "line 6", "line 7"],
		});
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

	/** FileDiff with these hunks, open or not, and these threads. */
	const renderFile = (
		over: Partial<FileView>,
		opts: {
			expanded?: boolean;
			hunks?: FileHunks;
			threads?: ReviewThread[];
			overview?: Partial<PrOverview>;
		} = {},
	) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input), "http://test");
				if (url.pathname.endsWith("/hunks")) {
					return new Response(
						JSON.stringify(opts.hunks ?? { hunks: [], newLineCount: 0 }),
					);
				}
				if (url.pathname.endsWith("/context")) {
					const from = Number(url.searchParams.get("newFrom"));
					const to = Number(url.searchParams.get("newTo"));
					const lines = [];
					for (let n = from; n <= to; n++) lines.push(ctx(n, n));
					return new Response(JSON.stringify(lines));
				}
				return new Response("{}", { status: 404 });
			}),
		);
		client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(["overview"], overview(opts.overview));
		client.setQueryData(["session"], { snapshotHead: HEAD } as SessionInfo);
		const user = userEvent.setup();
		const threads: DiffThreads = {
			readId: "r",
			snapshotHead: HEAD,
			threads: opts.threads ?? [],
		};
		const ui = (expanded: boolean) => (
			<QueryClientProvider client={client}>
				<FileDiff
					file={file(over)}
					revision="r1"
					unit="clusters"
					threads={threads}
					expanded={opts.expanded === undefined ? undefined : expanded}
					onExpandedChange={(next) => {
						result.rerender(ui(next));
					}}
				/>
			</QueryClientProvider>
		);
		const result = render(ui(opts.expanded ?? false));
		return { user, ...result };
	};
	const fileThread = (): ReviewThread => ({
		...thread({}),
		anchor: null,
		subject: "file",
		line: null,
		currentLine: null,
	});

	it.each(kinds)(
		"a %s file: its open diff's first row has the file bubble, which opens the composer",
		async (_, over) => {
			const { user } = renderFile(over, { expanded: true });
			const bubble = await screen.findByRole("button", {
				name: "Comment on file",
			});
			expect(bubble.closest("tr")).not.toBeNull();
			// Nowhere in the header.
			expect(
				screen.getByRole("banner").querySelector("[data-testid=thread-bubble]"),
			).toBeNull();
			await user.click(bubble);
			const area = await screen.findByTestId("file-threads");
			expect(within(area).getByText("whole file")).toBeInTheDocument();
			expect(getComposers()).toMatchObject([
				{ span: { path: PATH, commit: HEAD, subject: "file" } },
			]);
		},
	);

	it("the file bubble sits on the diff's first row, its threads right under it", async () => {
		const { user } = renderFile(
			{},
			{ expanded: true, hunks: HUNKS, threads: [fileThread()] },
		);
		const bubble = await screen.findByRole("button", {
			name: "1 comment on this file",
		});
		const rows = [...document.querySelectorAll("tbody > tr")];
		expect(rows[0]?.contains(bubble)).toBe(true);
		expect(bubble).toHaveAttribute("aria-expanded", "false");
		await user.click(bubble);
		expect(bubble).toHaveAttribute("aria-expanded", "true");
		const row = screen.getByTestId("file-threads");
		expect(rows[0]?.nextElementSibling).toBe(row);
		expect(within(row).getAllByTestId("files-thread")).toHaveLength(1);
		// With threads, Comment on file is a button in the row.
		expect(getComposers()).toEqual([]);
		await user.click(
			within(row).getByRole("button", { name: "Comment on file" }),
		);
		expect(getComposers()).toMatchObject([{ span: { subject: "file" } }]);
		expect(
			await within(row).findByRole("textbox", { name: "Comment" }),
		).toBeInTheDocument();
	});

	it("side by side, a file comment's composer spans its row across the table, as its posted thread will; a line's keeps its side and width", async () => {
		sideBySide.set(true);
		try {
			const { user } = renderFile({}, { expanded: true, hunks: HUNKS });
			await user.click(
				await screen.findByRole("button", { name: "Comment on file" }),
			);
			const row = await screen.findByTestId("file-threads");
			expect(row.querySelector("td")?.colSpan).toBe(6);
			const card = within(row).getByTestId("new-thread");
			// Not capped to a line composer's width: it fills the row.
			expect(card.className).not.toMatch(/max-w-/);
			act(() => {
				openComposer({
					path: PATH,
					commit: HEAD,
					subject: "line",
					startSide: "LEFT",
					startLine: 4,
					side: "LEFT",
					line: 4,
				});
			});
			const line = await screen.findByTestId("new-thread-row");
			// Under the left side: the card, then the right side's blank.
			expect(
				[...line.querySelectorAll(":scope > td")].map(
					(td) => (td as HTMLTableCellElement).colSpan,
				),
			).toEqual([1, 1, 2, 2]);
			expect(line.lastElementChild).toHaveClass("bg-band");
			expect(within(line).getByTestId("new-thread").className).toMatch(
				/max-w-\[40rem\]/,
			);
		} finally {
			sideBySide.reset();
		}
	});

	/** A hunk at new lines 5–6, the gap of lines 1–4 above it. */
	const LATER: FileHunks = {
		newLineCount: 6,
		hunks: [
			{
				oldStart: 5,
				oldCount: 1,
				newStart: 5,
				newCount: 2,
				lines: [ctx(5, 5), add(6, "new")],
			},
		],
	};
	const firstRow = () => document.querySelector("table tr") as HTMLElement;

	it("stays on the first row when the gap above the first hunk is all loaded", async () => {
		const { user } = renderFile({}, { expanded: true, hunks: LATER });
		await screen.findByTestId("gap-row");
		expect(
			within(firstRow()).getByRole("button", { name: "Comment on file" }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Load .* above/ }));
		await screen.findByText("line 1");
		expect(screen.queryByTestId("gap-row")).not.toBeInTheDocument();
		expect(firstRow().dataset.newNo).toBe("1");
		expect(
			within(firstRow()).getByRole("button", { name: "Comment on file" }),
		).toBeInTheDocument();
	});

	it("shares a row with a line's bubble: side by side, each opening its own threads", async () => {
		const { user } = renderFile(
			{},
			{
				expanded: true,
				hunks: LATER,
				threads: [fileThread(), thread({ line: 1 })],
			},
		);
		await user.click(
			await screen.findByRole("button", { name: /Load .* above/ }),
		);
		await screen.findByText("line 1");
		const row = firstRow();
		expect(row.dataset.newNo).toBe("1");
		const bubbles = within(row).getAllByTestId("thread-bubble");
		expect(bubbles.map((b) => b.getAttribute("aria-label"))).toEqual([
			"1 comment on this file",
			"1 comment on line 1",
		]);
		// One slot holds both, so they never sit on each other.
		expect(bubbles[0]?.parentElement).toBe(bubbles[1]?.parentElement);
		await user.click(bubbles[1] as HTMLElement);
		expect(screen.getByTestId("thread-row")).toBeInTheDocument();
		expect(screen.queryByTestId("file-threads")).not.toBeInTheDocument();
		await user.click(bubbles[0] as HTMLElement);
		expect(row.nextElementSibling).toBe(screen.getByTestId("file-threads"));
	});

	it("closed, a line past the end: the header's count opens the file, then the flagged file bubble once the diff says so, focused", async () => {
		const { user } = renderFile(
			{},
			{ expanded: false, hunks: HUNKS, threads: [thread({ line: 50 })] },
		);
		await user.click(
			screen.getByRole("button", { name: "1 comment in this file" }),
		);
		const bubble = await screen.findByRole("button", {
			name: "1 comment on this file, line not in this diff",
		});
		await vi.waitFor(() =>
			expect(bubble).toHaveAttribute("aria-expanded", "true"),
		);
		expect(bubble).toHaveFocus();
	});

	it("closed, the header counts the file's threads; it opens the file and the file bubble", async () => {
		const { user } = renderFile(
			{},
			{ expanded: false, hunks: HUNKS, threads: [fileThread()] },
		);
		expect(
			screen.queryByRole("button", { name: "Comment on file" }),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "1 comment in this file" }),
		);
		expect(
			await screen.findByRole("button", { name: "1 comment on this file" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			within(screen.getByTestId("file-threads")).getAllByTestId("files-thread"),
		).toHaveLength(1);
	});

	it("a file comment written on an earlier head moves to this one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ hunks: [], newLineCount: 0 })),
			),
		);
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		draftsFor(client).bind("k");
		client.setQueryData(["overview"], overview());
		client.setQueryData(["session"], { snapshotHead: HEAD } as SessionInfo);
		draftsFor(client).setNew(
			"f1",
			{ path: PATH, commit: "e".repeat(40), subject: "file" },
			"about the file",
		);
		render(
			<QueryClientProvider client={client}>
				<FileDiff file={file()} revision="r1" unit="clusters" />
			</QueryClientProvider>,
		);
		expect(await screen.findByRole("textbox", { name: "Comment" })).toHaveValue(
			"about the file",
		);
		expect(draftsFor(client).newThread("f1")?.create?.commit).toBe(HEAD);
	});

	it("is off, with the reason, when writing is off", async () => {
		const { user } = renderFile(
			{},
			{ expanded: true, overview: { writes: "viewer" } },
		);
		// The outline bubble says why; it opens its row, not a composer.
		await user.click(
			await screen.findByRole("button", {
				name: "Comment on file — Comments are off when viewing as someone else",
			}),
		);
		expect(getComposers()).toEqual([]);
		const button = within(screen.getByTestId("file-threads")).getByRole(
			"button",
			{ name: "Comment on file" },
		);
		expect(button).toHaveAttribute("aria-disabled", "true");
		expect(button).toHaveAccessibleDescription(
			"Comments are off when viewing as someone else",
		);
	});
});

describe("placeBar (desktop): never over the selection when it can help it", () => {
	const rect = (left: number, top: number, w: number, h: number) =>
		new DOMRect(left, top, w, h);
	const size = { w: 50, h: 46 };
	const view = { w: 1200, h: 800 };

	it("below the selection's end", () => {
		const first = rect(100, 100, 300, 20);
		const last = rect(100, 140, 200, 20);
		expect(
			placeBar(
				{ first, last, box: rect(100, 100, 300, 60), anchor: 300 },
				size,
				view,
			),
		).toEqual({ top: 166, left: 275 });
	});

	it("above its start when there's no room below", () => {
		const first = rect(100, 600, 300, 20);
		const last = rect(100, 770, 200, 20);
		expect(
			placeBar(
				{ first, last, box: rect(100, 600, 300, 190), anchor: 300 },
				size,
				view,
			).top,
		).toBe(600 - 6 - 46);
	});

	it("beside a selection taller than the screen, at its visible end", () => {
		const first = rect(100, -300, 600, 20);
		const last = rect(100, 1200, 600, 20);
		const at = placeBar(
			{ first, last, box: rect(100, -300, 600, 1520), anchor: 700 },
			size,
			view,
		);
		expect(at.left).toBe(706);
		expect(at.top + size.h).toBeLessThanOrEqual(view.h);
	});
});

describe("side by side (the cells contract)", () => {
	beforeEach(() => sideBySide.set(true));
	afterEach(() => sideBySide.reset());

	/** The code cells carrying `attr`, as `side:line` of the line each stands for. */
	const cellsWith = (attr: string, root: ParentNode = document) =>
		[...root.querySelectorAll(`[${CODE_CELL}][${attr}]`)].map((c) => {
			const l = cellLine(c);
			return l ? pickKey(l) : "?";
		});
	const row = (side: "LEFT" | "RIGHT", n: number) =>
		document.querySelector(
			`tr[data-${side === "LEFT" ? "old" : "new"}-no="${n}"]`,
		) as HTMLElement;
	const number = (side: "LEFT" | "RIGHT", n: number) =>
		row(side, n).querySelector(
			`td[data-testid="${side === "LEFT" ? "old" : "new"}"]`,
		) as HTMLElement;
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

	it("the keyboard: Up/Down stay in their column through context rows, Left/Right switch sides on every row, Shift extends", async () => {
		const { user } = setup();
		await loaded();
		const button = (side: "LEFT" | "RIGHT", n: number) =>
			within(number(side, n)).getByRole("button");
		button("LEFT", 3).focus();
		// Down: the next old line, not this row's new one.
		await user.keyboard("{ArrowDown}");
		expect(button("LEFT", 4)).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(button("RIGHT", 4)).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(button("LEFT", 4)).toHaveFocus();
		// Up the new column from new 4: new 3.
		await user.keyboard("{ArrowRight}{ArrowUp}");
		expect(button("RIGHT", 3)).toHaveFocus();
		// Shift+Down extends the pick down the column; Shift+Left across.
		await user.keyboard("{Enter}");
		await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
		expect(button("RIGHT", 4)).toHaveFocus();
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual([
			"RIGHT:3",
			"RIGHT:4",
		]);
		await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
		expect(button("LEFT", 4)).toHaveFocus();
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual([
			"LEFT:4",
			"RIGHT:3",
		]);
	});

	it("a pick remembers the number column its focus was picked from: the bar goes by that side", async () => {
		const { user } = setup();
		await loaded();
		// A removed line, by its old number: the left.
		press(number("LEFT", 3));
		expect(getPicks()).toMatchObject({
			focus: { side: "LEFT", line: 3 },
			column: "LEFT",
		});
		// Extended to an added line's new number: the focus is on the right.
		press(number("RIGHT", 4), { shiftKey: true });
		expect(getPicks()).toMatchObject({
			focus: { side: "RIGHT", line: 4 },
			column: "RIGHT",
		});
		// A context line by its old number: a RIGHT line, picked on the left.
		press(number("LEFT", 5));
		expect(getPicks()).toMatchObject({
			focus: { side: "RIGHT", line: 6 },
			column: "LEFT",
		});
		// From the keyboard: Shift+Right extends to the new column.
		within(number("LEFT", 4)).getByRole("button").focus();
		await user.keyboard("{Enter}{Shift>}{ArrowRight}{/Shift}");
		expect(getPicks()?.column).toBe("RIGHT");
	});

	it("a pick made in unified by a removed line's blank new number: side by side, the bar goes by the left", async () => {
		sideBySide.set(false);
		setup();
		await loaded();
		const removed = row("LEFT", 3);
		expect(removed).not.toHaveAttribute("data-new-no");
		press(removed.querySelector('td[data-testid="new"]') as Element);
		// Unified number cells name no side: no column.
		expect(getPicks()).toMatchObject({ focus: { side: "LEFT", line: 3 } });
		expect(getPicks()?.column).toBeUndefined();
		act(() => sideBySide.set(true));
		const pair = row("LEFT", 3);
		expect(pair.closest("table")?.dataset.view).toBe("side-by-side");
		const at = (el: Element, left: number) => {
			el.getBoundingClientRect = () => new DOMRect(left, 100, 38, 20);
		};
		at(number("LEFT", 3), 60);
		at(pair.querySelector('td[data-testid="new"]') as Element, 498);
		vi.stubGlobal("visualViewport", {
			offsetLeft: 0,
			offsetTop: 0,
			width: 1000,
			height: 800,
		});
		// Placed again on the next scroll: by the old number, the focus's side.
		fireEvent.scroll(window);
		const bar = await screen.findByTestId("selection-bar");
		await vi.waitFor(() => expect(bar.style.left).toBe(`${60 + 38 + 6}px`));
	});

	it("Down from an old number goes on down the old numbers through context rows (past the row with no old line)", async () => {
		const { user } = setup();
		await loaded();
		const button = (side: "LEFT" | "RIGHT", n: number) =>
			within(number(side, n)).getByRole("button");
		button("LEFT", 4).focus();
		// New 5 has no old line: on to the context rows' old numbers.
		await user.keyboard("{ArrowDown}");
		expect(button("LEFT", 5)).toHaveFocus();
		await user.keyboard("{ArrowDown}");
		expect(button("LEFT", 6)).toHaveFocus();
		// Up goes back the same way, still in the old column.
		await user.keyboard("{ArrowUp}{ArrowUp}");
		expect(button("LEFT", 4)).toHaveFocus();
		// Up the old column onto the context rows above the pairs.
		await user.keyboard("{ArrowUp}{ArrowUp}");
		expect(button("LEFT", 2)).toHaveFocus();
	});

	it("Left/Right on a context row switch between its two numbers", async () => {
		const { user } = setup();
		await loaded();
		const button = (side: "LEFT" | "RIGHT", n: number) =>
			within(number(side, n)).getByRole("button");
		button("RIGHT", 6).focus();
		await user.keyboard("{ArrowLeft}");
		expect(button("LEFT", 5)).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(button("LEFT", 5)).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(button("RIGHT", 6)).toHaveFocus();
	});

	it("a context row has a pick button on both numbers: each named and picking its one RIGHT line, one tab stop between them", async () => {
		const { user } = setup();
		await loaded();
		const buttons = [
			...row("RIGHT", 6).querySelectorAll<HTMLButtonElement>(
				"button[data-pick]",
			),
		];
		expect(buttons).toHaveLength(2);
		expect(buttons.map((b) => b.dataset.pick)).toEqual(["RIGHT:6", "RIGHT:6"]);
		// Each named by the number it shows (old 5, new 6), for voice control.
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Old line 5",
			"Line 6",
		]);
		const left = within(number("LEFT", 5)).getByRole("button");
		left.focus();
		await user.keyboard("{Enter}");
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual(["RIGHT:6"]);
		expect(cellsWith("data-picked")).toEqual(["RIGHT:6", "RIGHT:6"]);
		expect(left).toHaveAttribute("aria-pressed", "true");
		// The focused one is the file's one tab stop.
		const stops = [
			...document.querySelectorAll<HTMLButtonElement>("button[data-pick]"),
		].filter((b) => b.tabIndex === 0);
		expect(stops).toEqual([left]);
		// A mouse press on it picks the same line and keeps focus on it.
		press(number("LEFT", 5));
		expect(getPicks()).toBeNull();
		press(number("LEFT", 5));
		expect(left).toHaveFocus();
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual(["RIGHT:6"]);
		// Its other number moves the pick to that column; the same one again
		// clears it.
		expect(getPicks()?.column).toBe("LEFT");
		press(number("RIGHT", 6));
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual(["RIGHT:6"]);
		expect(getPicks()?.column).toBe("RIGHT");
		press(number("LEFT", 5));
		expect(getPicks()?.column).toBe("LEFT");
		press(number("LEFT", 5));
		expect(getPicks()).toBeNull();
	});

	it("switching to unified after focusing a context row's left number keeps one number button in the tab order", async () => {
		setup();
		await loaded();
		within(number("LEFT", 5)).getByRole("button").focus();
		act(() => sideBySide.set(false));
		await screen.findByRole("table");
		expect(document.querySelector("table")?.dataset.view).toBe("unified");
		const stops = [
			...document.querySelectorAll<HTMLButtonElement>("button[data-pick]"),
		].filter((b) => b.tabIndex === 0);
		expect(stops).toHaveLength(1);
	});

	it("a pick from a context row's left number to a deleted line extends in GitHub's order", async () => {
		const { user } = setup();
		await loaded();
		within(number("LEFT", 2)).getByRole("button").focus();
		await user.keyboard("{Enter}");
		press(number("LEFT", 4), { shiftKey: true });
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual([
			"RIGHT:2",
			"LEFT:3",
			"LEFT:4",
		]);
	});

	it("every code cell carries its side, a blank cell neither a side nor the cell mark", async () => {
		setup();
		await loaded();
		expect(document.querySelector("table")?.dataset.view).toBe("side-by-side");
		const cells = [...document.querySelectorAll(`[${CODE_CELL}]`)];
		expect(cells.length).toBeGreaterThan(0);
		for (const c of cells) {
			expect(["LEFT", "RIGHT"]).toContain(c.getAttribute("data-side"));
		}
		const blank = row("RIGHT", 5).querySelector("td[data-blank]") as Element;
		expect(blank.hasAttribute(CODE_CELL)).toBe(false);
		expect(blank.hasAttribute("data-side")).toBe(false);
		expect(row("RIGHT", 5).dataset.oldNo).toBeUndefined();
	});

	it("a span reads the side from the cell: a pair's right cell RIGHT by the new number, its left LEFT by the old one, a context line RIGHT from either cell", async () => {
		setup();
		await loaded();
		expect(span(rangeOf(at("RIGHT", 4, 0), at("RIGHT", 4, 5)))).toMatchObject({
			startSide: "RIGHT",
			startLine: 4,
			side: "RIGHT",
			line: 4,
			startCol: 0,
			endCol: 5,
		});
		expect(span(rangeOf(at("LEFT", 4, 0), at("LEFT", 4, 5)))).toMatchObject({
			startSide: "LEFT",
			startLine: 4,
			side: "LEFT",
			line: 4,
		});
		// The context line old 5 / new 6, in its left cell.
		const leftContext = row("RIGHT", 6).querySelector(
			`[${CODE_CELL}][data-side="LEFT"]`,
		) as HTMLElement;
		expect(leftContext.dataset.kind).toBe("context");
		expect(
			span(rangeOf(point(leftContext, 0), point(leftContext, 3))),
		).toMatchObject({
			startSide: "RIGHT",
			startLine: 6,
			side: "RIGHT",
			line: 6,
		});
		// Across the table with no side being selected: the cells in the
		// order shown, a range across sides.
		expect(span(rangeOf(at("LEFT", 3, 1), at("RIGHT", 4, 2)))).toMatchObject({
			startSide: "LEFT",
			startLine: 3,
			side: "RIGHT",
			line: 4,
			startCol: 1,
			endCol: 2,
		});
	});

	it("while one side is being selected, the other side's cells are left out of the span", async () => {
		setup();
		await loaded();
		const table = document.querySelector("table") as HTMLElement;
		fireEvent.pointerDown(cell("RIGHT", 3), {
			pointerType: "mouse",
			button: 0,
		});
		expect(table.dataset.selecting).toBe("new");
		// Ending at the start of the next right cell: the span ends on new
		// line 3, not on the old line between them in the DOM.
		expect(span(rangeOf(at("RIGHT", 3, 0), at("RIGHT", 4, 0)))).toMatchObject({
			startSide: "RIGHT",
			startLine: 3,
			side: "RIGHT",
			line: 3,
			startCol: null,
			endCol: null,
		});
		fireEvent.pointerUp(document);
		fireEvent.pointerDown(cell("LEFT", 3), { pointerType: "mouse", button: 0 });
		expect(table.dataset.selecting).toBe("old");
		expect(span(rangeOf(at("LEFT", 3, 0), at("LEFT", 4, 0)))).toMatchObject({
			startSide: "LEFT",
			startLine: 3,
			side: "LEFT",
			line: 3,
		});
		fireEvent.pointerUp(document);
	});

	it("a number picks the line on its side, and paints that side's cells only; a context row's numbers pick its one RIGHT line", async () => {
		setup();
		await loaded();
		press(number("LEFT", 3));
		expect(cellsWith("data-picked")).toEqual(["LEFT:3"]);
		expect(document.querySelectorAll("tr[data-picked]")).toHaveLength(1);
		expect(number("LEFT", 3)).toHaveAttribute("data-picked", "true");
		expect(number("RIGHT", 3)).not.toHaveAttribute("data-picked");
		expect(cell("LEFT", 3)).toHaveClass("line-picked-cell");
		expect(cell("RIGHT", 3)).not.toHaveClass("line-picked-cell");
		// Each side's number is its own button; the pick's button took focus.
		expect(
			within(row("RIGHT", 3)).getByRole("button", { name: "Old line 3" }),
		).toHaveFocus();
		expect(
			within(row("RIGHT", 3)).getByRole("button", { name: "Line 3" }),
		).toBeInTheDocument();
		// Extended to a new number: the cells between, in the order shown.
		press(number("RIGHT", 4), { shiftKey: true });
		expect(cellsWith("data-picked")).toEqual([
			"LEFT:3",
			"RIGHT:3",
			"LEFT:4",
			"RIGHT:4",
		]);
		expect(getPicks()).toMatchObject({
			anchor: { side: "LEFT", line: 3 },
			focus: { side: "RIGHT", line: 4 },
		});
		// A context line (old 5 / new 6) is one line: either number picks
		// RIGHT:6, both its cells show it, and the pressed number's button
		// takes focus.
		press(number("LEFT", 5));
		expect(cellsWith("data-picked")).toEqual(["RIGHT:6", "RIGHT:6"]);
		expect(getPicks()?.lines).toEqual([
			expect.objectContaining({ side: "RIGHT", line: 6 }),
		]);
		expect(
			within(row("RIGHT", 6)).getByRole("button", { name: "Old line 5" }),
		).toHaveAttribute("data-pick", "RIGHT:6");
		expect(within(number("LEFT", 5)).getByRole("button")).toHaveFocus();
	});

	it("picks extend in GitHub's order, not the order shown: new 3 then old 4 is old 4 → new 3 and Comment is on; old 3 → old 4 washes no right-side cell", async () => {
		const { user } = setup();
		await loaded();
		// Anchored on the right, extended to the left of the pair below: the
		// shown order would be RIGHT:3 then LEFT:4, which GitHub refuses as
		// backwards; GitHub's order of the hunk is del 4 then add 3.
		press(number("RIGHT", 3));
		press(number("LEFT", 4), { shiftKey: true });
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual([
			"LEFT:4",
			"RIGHT:3",
		]);
		expect(cellsWith("data-picked")).toEqual(["RIGHT:3", "LEFT:4"]);
		const bar = await screen.findByTestId("selection-bar");
		const comment = within(bar).getByRole("button", { name: "Comment" });
		expect(comment).not.toHaveAttribute("aria-disabled");
		await user.click(comment);
		expect(getComposers()).toMatchObject([
			{ span: { startSide: "LEFT", startLine: 4, side: "RIGHT", line: 3 } },
		]);
		await screen.findByTestId("new-thread-row");
		expect(
			within(screen.getByTestId("new-thread-row")).getByText("old 4 – new 3"),
		).toBeInTheDocument();
		act(() => resetComposers());
		// Two old lines: only they are picked, not the new line shown between them.
		press(number("LEFT", 3));
		press(number("LEFT", 4), { shiftKey: true });
		expect(cellsWith("data-picked")).toEqual(["LEFT:3", "LEFT:4"]);
		expect(getPicks()?.lines.map((l) => pickKey(l))).toEqual([
			"LEFT:3",
			"LEFT:4",
		]);
	});

	it("Comment on lines picked from an old number to a new one: the span crosses sides, the composer sits under the pair row and the range paints each side's cells", async () => {
		const { user } = setup();
		await loaded();
		press(number("LEFT", 3));
		press(number("RIGHT", 4), { shiftKey: true });
		const bar = await screen.findByTestId("selection-bar");
		await user.click(within(bar).getByRole("button", { name: "Comment" }));
		expect(getComposers()).toMatchObject([
			{
				span: {
					startSide: "LEFT",
					startLine: 3,
					side: "RIGHT",
					line: 4,
					startCol: null,
					endCol: null,
				},
			},
		]);
		expect(cellsWith("data-picked")).toEqual([]);
		const composer = await screen.findByTestId("new-thread-row");
		expect(composer.previousElementSibling).toBe(row("RIGHT", 4));
		expect(within(composer).getByText("old 3 – new 4")).toBeInTheDocument();
		expect(
			within(composer).getByRole("textbox", { name: "Comment" }),
		).toHaveFocus();
		expect(cellsWith("data-commented")).toEqual([
			"LEFT:3",
			"RIGHT:3",
			"LEFT:4",
			"RIGHT:4",
		]);
		expect(document.querySelectorAll("tr[data-commented]")).toHaveLength(2);
	});

	it("a thread's span is painted in the cell of its side only; a context line's in both its cells", async () => {
		setup({
			threads: [
				thread({ line: 4, startCol: 0, endCol: 5 }),
				thread({ line: 6, startCol: 0, endCol: 4 }),
			],
		});
		await loaded();
		const marked = (c: Element) =>
			[...c.querySelectorAll("[data-span-mark]")]
				.map((m) => m.textContent)
				.join("");
		expect(marked(cell("RIGHT", 4))).toBe("const");
		expect(marked(cell("LEFT", 4))).toBe("");
		expect(cellsWith("data-commented", row("RIGHT", 4))).toEqual(["RIGHT:4"]);
		const context = row("RIGHT", 6);
		expect(cellsWith("data-commented", context)).toEqual([
			"RIGHT:6",
			"RIGHT:6",
		]);
		for (const c of context.querySelectorAll(`[${CODE_CELL}]`)) {
			expect(marked(c)).toBe("line");
		}
	});
});

describe("the bar sits by the selection (desktop)", () => {
	const rect = (left: number, top: number, w: number, h: number) =>
		new DOMRect(left, top, w, h);
	const size = { w: 46, h: 46 };
	const view = { w: 1400, h: 900 };
	// Lines 3 to 5 of a diff: each row 20px, its code from x=496.
	const code = (top: number) => rect(496, top + 3, 400, 14);
	const cells = { head: code(326), last: code(366) };
	// What Chrome reports for a drag from line 3 col 2 to line 5 col 13:
	// the text, and the boxes of row 4 (the table wide) and its cells.
	const rects = [
		rect(511, 329, 100, 14),
		rect(329, 346, 1046, 20),
		rect(425, 346, 48, 20),
		rect(496, 349, 400, 14),
		rect(329, 366, 4, 20),
		rect(481, 369, 7, 14),
		rect(496, 369, 94, 14),
	];
	const bar = (reversed: boolean) => {
		const g = textGeometry(rects, cells, reversed);
		return {
			g,
			at: placeBar({ ...g, box: rect(329, 329, 1046, 54) }, size, view),
		};
	};

	it("forward: just below the last line, centered where the selection ends", () => {
		const { g, at } = bar(false);
		expect(g.last).toMatchObject({ left: 496, right: 590 });
		expect(at.top).toBe(366 + 3 + 14 + 6);
		expect(at.left).toBe(590 - 23);
	});

	it("backwards: below the last line, centered where the drag ended (its start)", () => {
		const { g, at } = bar(true);
		expect(g.first).toMatchObject({ left: 511, right: 611 });
		expect(at.top).toBe(366 + 3 + 14 + 6);
		expect(at.left).toBe(511 - 23);
	});

	it("never anchors on a row's own box or a bubble at the cell's end", () => {
		const bubble = rect(1300, 369, 40, 14);
		const g = textGeometry([...rects, bubble], cells, false);
		expect(g.last.right).toBe(590);
	});

	it("a last line with nothing of its text in the range stands at its code's start", () => {
		const g = textGeometry([rect(511, 329, 100, 14)], cells, false);
		expect(g.last).toMatchObject({ left: 496, right: 496 });
	});

	it("picked lines: just below the last row, right of its number (the numbers below stay free to extend the pick)", () => {
		const last = rect(329, 366, 1046, 20);
		const at = placeBar(
			{
				first: rect(329, 326, 1046, 20),
				last,
				box: rect(329, 326, 1046, 60),
				// Right of the number cell (x 405 to 445).
				anchor: 445 + 6,
				after: true,
			},
			size,
			view,
		);
		expect(at).toEqual({ top: 386 + 6, left: 451 });
	});
});

describe("pickAnchor: the bar starts right of the row's numbers", () => {
	const cellAt = (id: string, left: number, w: number) => {
		const td = document.createElement("td");
		td.dataset.testid = id;
		td.getBoundingClientRect = () => new DOMRect(left, 0, w, 20);
		return td;
	};

	it("a removed line's pick: right of the new-number column, not over it", () => {
		const row = document.createElement("tr");
		const old = cellAt("old", 377, 38);
		old.append(
			Object.assign(document.createElement("button"), { type: "button" }),
		);
		old.querySelector("button")?.setAttribute("data-pick", "LEFT:10");
		row.append(old, cellAt("new", 415, 38));
		expect(pickAnchor(row)).toBe(415 + 38 + 6);
	});

	/** A side-by-side pair row: old number, old code, new number, new code. */
	const pairRow = (view: "side-by-side" | "unified") => {
		const table = document.createElement("table");
		table.dataset.view = view;
		const row = document.createElement("tr");
		row.append(
			cellAt("old", 60, 38),
			cellAt("code", 98, 400),
			cellAt("new", 498, 38),
			cellAt("code", 536, 400),
		);
		table.append(row);
		return row;
	};

	it("side by side: by the side the pick was made on, right of that side's number", () => {
		expect(pickAnchor(pairRow("side-by-side"), "LEFT")).toBe(60 + 38 + 6);
		expect(pickAnchor(pairRow("side-by-side"), "RIGHT")).toBe(498 + 38 + 6);
		// No column known: as unified.
		expect(pickAnchor(pairRow("side-by-side"))).toBe(498 + 38 + 6);
	});

	it("unified: right of the new numbers whichever column was picked", () => {
		expect(pickAnchor(pairRow("unified"), "LEFT")).toBe(498 + 38 + 6);
	});
});

describe("placeBar on a phone: clear of the handles, inside what the screen shows", () => {
	const rect = (left: number, top: number, w: number, h: number) =>
		new DOMRect(left, top, w, h);
	const size = { w: 46, h: 46 };

	it("text: below the last line by the handle's room, centred where it ends", () => {
		const last = rect(20, 300, 120, 20);
		expect(
			placeBar(
				{ first: last, last, box: last, anchor: 140 },
				size,
				{ w: 360, h: 740 },
				HANDLE_GAP,
			),
		).toEqual({ top: 320 + HANDLE_GAP, left: 140 - 23 });
	});

	it("pinch-zoomed: inside the visual viewport, not the layout one", () => {
		// The screen shows x 200–380, y 300–500 of the page.
		const view = { left: 200, top: 300, w: 180, h: 200 };
		const last = rect(150, 340, 100, 20);
		const at = placeBar(
			{ first: last, last, box: last, anchor: 160 },
			size,
			view,
			HANDLE_GAP,
		);
		expect(at).toEqual({ top: 360 + HANDLE_GAP, left: 208 });
		// Past the right edge: kept in.
		const far = placeBar(
			{ first: last, last, box: last, anchor: 900 },
			size,
			view,
			HANDLE_GAP,
		);
		expect(far.left + size.w).toBeLessThanOrEqual(380 - 8);
	});

	it("no room below in the view: above the start, inside the view", () => {
		const view = { left: 0, top: 100, w: 360, h: 300 };
		const first = rect(20, 260, 120, 20);
		const last = rect(20, 360, 120, 20);
		const at = placeBar(
			{ first, last, box: rect(20, 260, 300, 120), anchor: 140 },
			size,
			view,
			HANDLE_GAP,
		);
		expect(at.top).toBe(260 - 6 - 46);
		expect(at.top).toBeGreaterThanOrEqual(100 + 8);
	});

	it("reads the visual viewport", () => {
		vi.stubGlobal("visualViewport", {
			offsetLeft: 12,
			offsetTop: 340,
			width: 180,
			height: 370,
		});
		expect(currentView()).toEqual({ left: 12, top: 340, w: 180, h: 370 });
	});
});

describe("the selection bar on a phone", () => {
	beforeEach(() => resetPointer());
	/** Rows 20px from y=100, numbers at x 40–78, code from x 90. */
	const geometry = () => {
		const rowTop = (el: Element) => {
			const tr = el.closest("tr");
			const n = Number(tr?.dataset.newNo ?? tr?.dataset.oldNo);
			return Number.isNaN(n) ? null : 100 + 20 * n;
		};
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
			function (this: Element) {
				const top = rowTop(this);
				if (top === null) return new DOMRect();
				if (this.matches("tr")) return new DOMRect(0, top, 360, 20);
				if (this.matches('td[data-testid="new"]')) {
					return new DOMRect(40, top, 38, 20);
				}
				if (this.matches("[data-code]")) {
					return new DOMRect(90, top + 3, 260, 14);
				}
				return new DOMRect();
			},
		);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.dataset.testid === "selection-bar" ? 46 : 0;
			},
		);
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.dataset.testid === "selection-bar" ? 46 : 0;
			},
		);
	};
	/** A screen `view` tall; narrow (portrait) unless `wide`; coarse unless not. */
	const phone = (
		view: { top: number; height: number },
		opts: { wide?: boolean; coarse?: boolean } = {},
	) => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches: query.includes("pointer: coarse")
						? (opts.coarse ?? true)
						: (opts.wide ?? false),
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		vi.stubGlobal("visualViewport", {
			offsetLeft: 0,
			offsetTop: view.top,
			width: 360,
			height: view.height,
			addEventListener: () => {},
			removeEventListener: () => {},
		});
		window.scrollBy = vi.fn();
	};
	const placed = (bar: HTMLElement) => ({
		top: Number.parseFloat(bar.style.top),
		left: Number.parseFloat(bar.style.left),
	});

	it("text: floats below the last line, the end handle's room under it, no quote", async () => {
		phone({ top: 0, height: 740 });
		setup();
		await loaded();
		geometry();
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		const bar = await screen.findByTestId("selection-bar");
		// Line 8's code: y 263–277, from x 90 (no range rects in jsdom).
		await vi.waitFor(() =>
			expect(placed(bar)).toEqual({ top: 277 + HANDLE_GAP, left: 90 - 23 }),
		);
		expect(bar).toHaveClass("fixed");
		expect(bar).not.toHaveClass("inset-x-0");
		expect(bar.textContent).toBe("");
		expect(window.scrollBy).not.toHaveBeenCalled();
		expect(
			document.documentElement.style.getPropertyValue("--selection-bar"),
		).toBe("");
	});

	it("picked lines: just below the last one, right of its number (no handles)", async () => {
		phone({ top: 0, height: 740 });
		setup();
		await loaded();
		geometry();
		act(() =>
			setPicks({
				path: PATH,
				anchor: { side: "RIGHT", line: 6, len: 6, hunk: "h0", path: PATH },
				focus: { side: "RIGHT", line: 7, len: 6, hunk: "h0", path: PATH },
				lines: [6, 7].map((line) => ({
					side: "RIGHT" as const,
					line,
					len: 6,
					hunk: "h0",
					path: PATH,
				})),
			}),
		);
		const bar = await screen.findByTestId("selection-bar");
		// Row 7: y 240–260; its number ends at x 78.
		await vi.waitFor(() =>
			expect(placed(bar)).toEqual({ top: 260 + 6, left: 78 + 6 }),
		);
	});

	it("no room under the selection: the page moves up once to make it", async () => {
		// The screen shows y 0–300: line 8 ends at 277.
		phone({ top: 0, height: 300 });
		setup();
		await loaded();
		geometry();
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		const bar = await screen.findByTestId("selection-bar");
		await vi.waitFor(() =>
			expect(window.scrollBy).toHaveBeenCalledWith({
				top: 277 + HANDLE_GAP + 46 + 8 - 300,
				behavior: "instant",
			}),
		);
		// Handles dragged (the same selection read again): not again.
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 4)));
		await vi.waitFor(() => expect(placed(bar).top).toBeGreaterThan(0));
		expect(window.scrollBy).toHaveBeenCalledTimes(1);
	});

	const pickRows = (lines: number[]) =>
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
					side: "RIGHT" as const,
					line,
					len: 6,
					hunk: "h0",
					path: PATH,
				})),
			}),
		);

	it("by touch, not by width: a phone in landscape keeps the handle's room", async () => {
		phone({ top: 0, height: 740 }, { wide: true, coarse: true });
		setup();
		await loaded();
		geometry();
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		const bar = await screen.findByTestId("selection-bar");
		await vi.waitFor(() => expect(placed(bar).top).toBe(277 + HANDLE_GAP));
	});

	it("a mouse in a narrow window: the desktop's gap, no page scroll", async () => {
		phone({ top: 0, height: 300 }, { coarse: false });
		setup();
		await loaded();
		geometry();
		fireEvent.pointerDown(cell("RIGHT", 8), { pointerType: "mouse" });
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		const bar = await screen.findByTestId("selection-bar");
		// No room below (300): above the start, as on a desktop.
		await vi.waitFor(() => expect(placed(bar).top).toBe(263 - 6 - 46));
		expect(window.scrollBy).not.toHaveBeenCalled();
		expect(
			document.documentElement.style.getPropertyValue("--selection-room"),
		).toBe("");
	});

	it("the last press decides: a touch on a fine-pointer screen gets the handle's room", async () => {
		phone({ top: 0, height: 740 }, { wide: true, coarse: false });
		setup();
		await loaded();
		geometry();
		fireEvent.pointerDown(cell("RIGHT", 8), { pointerType: "touch" });
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		const bar = await screen.findByTestId("selection-bar");
		await vi.waitFor(() => expect(placed(bar).top).toBe(277 + HANDLE_GAP));
	});

	it("pads the list's end by the bar's room while a selection is up, by touch", async () => {
		phone({ top: 0, height: 740 });
		const { user } = setup();
		await loaded();
		geometry();
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		await screen.findByTestId("selection-bar");
		const room = () =>
			document.documentElement.style.getPropertyValue("--selection-room");
		await vi.waitFor(() => expect(room()).toBe(`${HANDLE_GAP + 46 + 8}px`));
		await user.keyboard("{Escape}");
		await vi.waitFor(() => expect(room()).toBe(""));
	});

	it("never scrolls under a finger: it waits for the finger to lift", async () => {
		phone({ top: 0, height: 300 });
		setup();
		await loaded();
		geometry();
		fireEvent.touchStart(document.body, { touches: [{}] });
		act(() => {
			const selection = document.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
			// A long press: the selection settles, the finger still down.
			document.dispatchEvent(new Event("selectionchange"));
		});
		await screen.findByTestId("selection-bar", {}, { timeout: 2000 });
		await new Promise((r) => setTimeout(r, 50));
		expect(window.scrollBy).not.toHaveBeenCalled();
		fireEvent.touchEnd(document.body, { touches: [] });
		await vi.waitFor(() => expect(window.scrollBy).toHaveBeenCalledTimes(1));
	});

	it("picks giving way to a text selection: the text gets its own scroll-once", async () => {
		phone({ top: 0, height: 300 });
		setup();
		await loaded();
		geometry();
		// Row 7 ends at 260: 6 + 46 + 8 under it passes 300 by 20.
		pickRows([6, 7]);
		await screen.findByTestId("selection-bar");
		await vi.waitFor(() =>
			expect(window.scrollBy).toHaveBeenCalledWith({
				top: 20,
				behavior: "instant",
			}),
		);
		selectAndRelease(rangeOf(at("RIGHT", 8, 0), at("RIGHT", 8, 3)));
		await vi.waitFor(() =>
			expect(window.scrollBy).toHaveBeenLastCalledWith({
				top: 277 + HANDLE_GAP + 46 + 8 - 300,
				behavior: "instant",
			}),
		);
		expect(window.scrollBy).toHaveBeenCalledTimes(2);
	});
});
