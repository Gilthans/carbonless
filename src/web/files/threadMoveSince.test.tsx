// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fc from "fast-check";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type {
	DiffLine,
	FileHunks,
	FileView,
	ReviewThread,
} from "../../shared/types";
import { AgentPlacingProvider } from "../agent/placeable";
import type { RereviewTo } from "../api";
import { contextRanges } from "./contextRanges";
import { DiffBody } from "./DiffBody";
import { type PlacementInfo, PlacementProvider } from "./ThreadFate";
import {
	endMoveMode,
	lineAt,
	MoveWritesProvider,
	moveAnchorOf,
	moveEnd,
	moveTargetOf,
	useMoveWritesHost,
} from "./threadMove";
import { placeThreads, shownThreads, sinceLeftToNew } from "./threadPlacement";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * Thread moves in the since view (CAR-139, principle 9): the handle, a
 * drop and Place here work there as in the full diff; a drop stores the
 * full diff's lines (a removed row through its base line, never its own
 * number, the compared patch set's); a row that is no line of the base
 * or the head is no target; placements land on the rows the full diff's
 * lines are.
 */

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const PATH = "src/a.ts";

const line = (
	kind: DiffLine["kind"],
	oldNo: number | undefined,
	newNo: number | undefined,
	text: string,
	extra: Partial<DiffLine> = {},
): DiffLine => ({
	kind,
	...(oldNo === undefined ? {} : { oldNo }),
	...(newNo === undefined ? {} : { newNo }),
	text,
	...extra,
});

/*
 * The full diff (base → head): base lines 1–2 kept, base line 3 removed
 * (cluster k1), new lines 3–4 added. The since view (PS1 → head), PS1
 * numbering its old side two lines on from the base (the branch added
 * two lines at its top, gone since): its old 5 is base line 3 (baseNo),
 * its old 2 is one of the branch's own lines (no baseNo).
 */
const sinceHunks: FileHunks = {
	newLineCount: 4,
	hunks: [
		{
			oldStart: 1,
			oldCount: 5,
			newStart: 1,
			newCount: 4,
			lines: [
				line("context", 1, 1, "one"),
				line("del", 2, undefined, "branch's own", { clusterKey: "k1" }),
				line("context", 3, 2, "two"),
				line("del", 5, undefined, "three", { clusterKey: "k1", baseNo: 3 }),
				line("add", undefined, 3, "new three", { clusterKey: "k1" }),
				line("add", undefined, 4, "new four", { clusterKey: "k1" }),
			],
		},
	],
	pieces: [],
};

const file: FileView = {
	index: 0,
	path: PATH,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 2,
	deletions: 1,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [
		{
			key: "k1",
			kind: "lines",
			oldStart: 3,
			oldCount: 1,
			newStart: 3,
			newCount: 2,
			removed: ["three"],
			added: ["new three", "new four"],
			lines: 3,
			state: "unreviewed",
		},
	],
};

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
	id: "T1",
	path: PATH,
	line: 1,
	currentLine: 1,
	loaded: true,
	excerpt: "About line one",
	html: "<p>About line one</p>",
	body: "About line one",
	createdAt: "2026-01-01T00:00:00Z",
	lastActivityAt: "2026-01-01T00:00:00Z",
	author: "octo",
	bot: false,
	avatarUrl: "",
	participants: [],
	lastAuthor: { login: "octo", avatarUrl: "", bot: false },
	commentCount: 1,
	hasReply: false,
	outdated: false,
	resolved: false,
	code: null,
	anchor: {
		path: PATH,
		commit: H1,
		side: "RIGHT",
		line: 1,
		startSide: "RIGHT",
		startLine: 1,
		at: "2026-01-01T00:00:00Z",
	},
	commit: H1,
	subject: "line",
	attention: [],
	yourTurn: false,
	viewerCan: { reply: false, resolve: false, unresolve: false },
	...over,
});

const placedOn = (
	side: "LEFT" | "RIGHT",
	n: number,
	path = PATH,
): ThreadPlacement => ({
	kind: "placed",
	anchor: { path, startSide: side, startLine: n, side, line: n },
	changed: false,
});

const info = (over: Partial<PlacementInfo> = {}): PlacementInfo => ({
	placements: new Map([["T1", placedOn("RIGHT", 1)]]),
	moves: new Map(),
	pending: false,
	error: null,
	retry: () => {},
	readId: "r1",
	to: { patchset: 2 },
	moveTo: { patchset: 2 },
	viewedHead: H2,
	openedOn: () => 1,
	...over,
});

function Page(props: { value: PlacementInfo; children: ReactNode }) {
	const writes = useMoveWritesHost({
		readId: props.value.readId,
		to: props.value.moveTo,
	});
	return (
		<PlacementProvider value={props.value}>
			<AgentPlacingProvider value={{ placements: null, until: null }}>
				<MoveWritesProvider value={writes}>{props.children}</MoveWritesProvider>
			</AgentPlacingProvider>
		</PlacementProvider>
	);
}

/** The since view's DiffBody (PS1 → head) with T1 carried onto head line 1. */
function renderSince(value = info()) {
	const posts: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname.endsWith("/moves") && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return new Response("{}", { status: 500 });
			}
			const body =
				url.pathname === "/api/files/0/hunks"
					? sinceHunks
					: url.pathname === "/api/comments"
						? { threads: [] }
						: {};
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const placements = value.placements;
	const threads = shownThreads([thread()], H2, placements, null);
	render(
		<QueryClientProvider client={client}>
			{inRouter(() => (
				<Page value={value}>
					<section data-path={PATH}>
						<DiffBody
							file={file}
							revision="r2"
							onToggle={vi.fn()}
							onCrossOff={vi.fn()}
							from={1}
							kinds={new Map()}
							threads={{
								readId: "r1",
								snapshotHead: H2,
								threads,
								placements,
							}}
						/>
					</section>
				</Page>
			))}
		</QueryClientProvider>,
	);
	return posts;
}

const rowOf = (attr: "old" | "new", n: number) =>
	document.querySelector<HTMLElement>(
		`tr[data-testid="diff-line"][data-${attr}-no="${n}"]`,
	) as HTMLElement;

/** Drags `handle` onto `target` (elementFromPoint stands for layout). */
function dragOnto(handle: HTMLElement, target: HTMLElement) {
	const original = document.elementFromPoint;
	document.elementFromPoint = () => target;
	const at = { clientX: 100, clientY: 100, button: 0, pointerId: 1 };
	try {
		act(() => {
			handle.dispatchEvent(
				new MouseEvent("pointerdown", {
					...at,
					clientX: 0,
					clientY: 0,
					bubbles: true,
				}),
			);
		});
		act(() => {
			handle.dispatchEvent(
				new MouseEvent("pointermove", { ...at, bubbles: true }),
			);
		});
		// Under the drag: outlined only when it is a target.
		const outlined = target.getAttribute("data-drop-line") === "true";
		act(() => {
			handle.dispatchEvent(
				new MouseEvent("pointerup", { ...at, bubbles: true }),
			);
		});
		return outlined;
	} finally {
		document.elementFromPoint = original;
	}
}

beforeEach(() => {
	contextRanges.reset();
});
afterEach(() => {
	cleanup();
	endMoveMode();
	vi.unstubAllGlobals();
});

describe("where moves write: only the target decides", () => {
	const latest = 2;
	it.each<[string, RereviewTo, number | null]>([
		["the latest patch set", { patchset: 2 }, 2],
		["a head that is no patch set yet", { head: H2 }, null],
	])(
		"%s takes moves, in the full diff and the since view alike",
		(_, to, ps) => {
			// No comparison base among the inputs: the since view (base PS1)
			// writes where the full diff does.
			expect(moveTargetOf(to, { patchset: ps }, latest)).toEqual(to);
		},
	);

	it("an earlier patch set, or placements not in yet: none", () => {
		expect(moveTargetOf({ patchset: 1 }, { patchset: 1 }, latest)).toBeNull();
		expect(moveTargetOf({ patchset: 2 }, null, latest)).toBeNull();
		expect(moveTargetOf(null, { patchset: 2 }, latest)).toBeNull();
	});
});

describe("a row as a move's end (moveEnd)", () => {
	it("a new line is the target's, in either view", () => {
		expect(moveEnd({ oldNo: 5, newNo: 3 }, "RIGHT", true)).toEqual({
			side: "RIGHT",
			line: 3,
		});
		expect(moveEnd({ newNo: 3 }, "RIGHT", false)).toEqual({
			side: "RIGHT",
			line: 3,
		});
	});

	it("the full diff's old line is the base's as it is", () => {
		expect(moveEnd({ oldNo: 5 }, "LEFT", false)).toEqual({
			side: "LEFT",
			line: 5,
		});
	});

	it("the since view's removed line: its base line, never its own number; none without one", () => {
		expect(moveEnd({ oldNo: 5, baseNo: 3 }, "LEFT", true)).toEqual({
			side: "LEFT",
			line: 3,
		});
		expect(moveEnd({ oldNo: 2 }, "LEFT", true)).toBeNull();
	});
});

describe("the since view: the handle, a drop and Place here", () => {
	async function openCard() {
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: /1 comment on line 1/ }),
		);
		return screen.findByTestId("move-handle");
	}

	it("a carried thread's card has the handle there", async () => {
		renderSince();
		expect(await openCard()).toHaveAccessibleName("Move thread");
	});

	it("a drop on a new line stores the target's line", async () => {
		const posts = renderSince();
		const handle = await openCard();
		expect(dragOnto(handle, rowOf("new", 4))).toBe(true);
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toMatchObject({
			anchor: {
				path: PATH,
				startSide: "RIGHT",
				startLine: 4,
				side: "RIGHT",
				line: 4,
			},
		});
	});

	it("a drop on a removed base line stores the base's number (3), never the since view's (5)", async () => {
		const posts = renderSince();
		const handle = await openCard();
		const removed = rowOf("old", 5);
		expect(removed.dataset.baseNo).toBe("3");
		expect(dragOnto(handle, removed)).toBe(true);
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toMatchObject({
			anchor: { startSide: "LEFT", startLine: 3, side: "LEFT", line: 3 },
		});
	});

	it("a line of neither the base nor the head is no target: no outline, nothing sent", async () => {
		const posts = renderSince();
		const handle = await openCard();
		expect(dragOnto(handle, rowOf("old", 2))).toBe(false);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(posts).toEqual([]);
	});

	it("Place here's anchor: picked numbers through the same rows (moveAnchorOf)", async () => {
		renderSince();
		await screen.findAllByTestId("diff-line");
		const span = (
			startSide: "LEFT" | "RIGHT",
			startLine: number,
			side: "LEFT" | "RIGHT",
			l: number,
		) => ({ path: PATH, startSide, startLine, side, line: l });
		expect(moveAnchorOf(span("RIGHT", 3, "RIGHT", 4))).toEqual(
			span("RIGHT", 3, "RIGHT", 4),
		);
		expect(moveAnchorOf(span("LEFT", 5, "LEFT", 5))).toEqual(
			span("LEFT", 3, "LEFT", 3),
		);
		expect(moveAnchorOf(span("LEFT", 2, "LEFT", 2))).toBeNull();
		// A range starting on such a line isn't a place either.
		expect(moveAnchorOf(span("LEFT", 2, "RIGHT", 3))).toBeNull();
		// A number no row shows: never taken as the base's.
		expect(moveAnchorOf(span("LEFT", 9, "LEFT", 9))).toBeNull();
	});

	it("the full diff's rows: as picked (no interdiff to map through)", () => {
		document.body.innerHTML = `<section data-path="${PATH}"><table><tbody>
			<tr data-testid="diff-line" data-old-no="7"><td>x</td></tr>
		</tbody></table></section>`;
		const s = {
			path: PATH,
			startSide: "LEFT" as const,
			startLine: 7,
			side: "LEFT" as const,
			line: 7,
		};
		expect(moveAnchorOf(s)).toEqual(s);
		const row = document.querySelector("tr") as HTMLElement;
		const original = document.elementFromPoint;
		document.elementFromPoint = () => row;
		try {
			expect(lineAt(0, 0, PATH)?.anchor).toEqual(s);
		} finally {
			document.elementFromPoint = original;
		}
		document.body.innerHTML = "";
	});

	it("a thread moved onto a removed base line shows on that row, in the since view too", async () => {
		renderSince(info({ placements: new Map([["T1", placedOn("LEFT", 3)]]) }));
		const removed = await waitFor(() => {
			const r = rowOf("old", 5);
			expect(r).toBeTruthy();
			return r;
		});
		expect(
			await within(removed).findByRole("button", {
				name: /1 comment on old line 5/,
			}),
		).toBeInTheDocument();
		// Not on the row merely numbered 3 on either side.
		expect(screen.queryByRole("button", { name: /line 3/ })).toBeNull();
	});
});

describe("placements in the since view (placeThreads, leftToNew)", () => {
	it("property: each thread lands once; a RIGHT line on its row, a removed base line on the row that is it", () => {
		const rows = sinceHunks.hunks.flatMap((h) => h.lines);
		const leftToNew = sinceLeftToNew(file.clusters);
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						side: fc.constantFrom("LEFT" as const, "RIGHT" as const),
						line: fc.integer({ min: 1, max: 8 }),
						startBack: fc.integer({ min: 0, max: 2 }),
					}),
					{ maxLength: 8 },
				),
				(list) => {
					const threads = list.map((x, i) =>
						thread({
							id: `T${i}`,
							anchor: {
								path: PATH,
								commit: H2,
								side: x.side,
								line: x.line,
								startSide: x.side,
								startLine: Math.max(1, x.line - x.startBack),
								at: "2026-01-01T00:00:00Z",
							},
							commit: H2,
						}),
					);
					const p = placeThreads({
						threads,
						path: PATH,
						snapshotHead: H2,
						hunks: sinceHunks,
						loadedContext: [],
						leftToNew,
					});
					const where = new Map<string, string[]>();
					const add = (id: string | undefined, at: string) =>
						where.set(id ?? "", [...(where.get(id ?? "") ?? []), at]);
					for (const [key, ts] of p.end) for (const t of ts) add(t.id, key);
					for (const [g, ts] of p.gaps)
						for (const t of ts) add(t.id, `gap${g}`);
					for (const h of p.header) add(h.thread.id, "header");
					for (const f of p.fates) add(f.thread.id, "fate");
					list.forEach((x, i) => {
						const at = where.get(`T${i}`) ?? [];
						expect(at).toHaveLength(1);
						const [key] = at;
						if (x.side === "RIGHT" && x.line <= 4) {
							expect(key).toBe(`RIGHT:${x.line}`);
						} else if (x.side === "LEFT" && x.line <= 3) {
							const head = leftToNew(x.line);
							const removed = rows.find((r) => r.baseNo === x.line);
							expect(key).toBe(
								head !== null
									? `RIGHT:${head}`
									: removed
										? `LEFT:${removed.oldNo}`
										: "header",
							);
						}
					});
				},
			),
			{ numRuns: 300 },
		);
	});
});
