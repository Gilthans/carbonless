// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	Progress,
	ReviewThread,
	SinceMark,
} from "../../shared/types";
import { contextRanges } from "./contextRanges";
import { DiffBody, type DiffThreads } from "./DiffBody";
import { GoneFile } from "./FileDiff";
import { FileTree } from "./FileTree";
import { ProgressBar } from "./ProgressBar";
import type { KindEntry } from "./since";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * The since view's pieces (design doc, "Since view and full diff"): the
 * kind rows and chips, a gone cluster's red block, the locked controls of
 * an earlier patch set, the tree's dots and filter, the bar's "to read".
 */

const cluster = (
	key: string,
	state: ClusterView["state"],
	carried?: ClusterView["carried"],
): ClusterView => ({
	key,
	kind: "lines",
	oldStart: 2,
	oldCount: 1,
	newStart: 2,
	newCount: 1,
	removed: ["old"],
	added: ["new"],
	lines: 2,
	state,
	...(carried ? { carried } : {}),
});

const line = (
	kind: DiffLine["kind"],
	oldNo: number | undefined,
	newNo: number | undefined,
	text: string,
	clusterKey?: string,
): DiffLine => ({
	kind,
	...(oldNo === undefined ? {} : { oldNo }),
	...(newNo === undefined ? {} : { newNo }),
	text,
	...(clusterKey === undefined ? {} : { clusterKey }),
});

/** An interdiff: k1 reworked (old line 2 → new line 2), g1 gone (old line 4). */
const sinceHunks: FileHunks = {
	newLineCount: 5,
	hunks: [
		{
			oldStart: 1,
			oldCount: 5,
			newStart: 1,
			newCount: 4,
			lines: [
				line("context", 1, 1, "a"),
				line("del", 2, undefined, "old", "k1"),
				line("add", undefined, 2, "new", "k1"),
				line("context", 3, 3, "c"),
				line("del", 4, undefined, "gone line", "g1"),
				line("context", 5, 4, "e"),
			],
		},
	],
	pieces: [
		{
			hunk: 0,
			line: 1,
			key: "k1",
			owns: [[0, 2]],
			old: [[2, 3]],
			new: [[2, 3]],
		},
		{
			hunk: 0,
			line: 4,
			key: "g1",
			owns: null,
			old: [[4, 5]],
			new: [],
			kind: "reverted",
		},
	],
};

const fileOf = (clusters: ClusterView[]): FileView => ({
	index: 0,
	path: "src/a.ts",
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 2,
	clusters,
	done: clusters.every((c) => c.state !== "unreviewed"),
	reviewed: clusters.every((c) => c.state === "reviewed"),
	crossedOff: false,
});

function renderBody(opts: {
	clusters: ClusterView[];
	hunks: FileHunks;
	from?: number;
	kinds?: Map<string, KindEntry>;
	readOnly?: boolean;
	sinceMarks?: SinceMark[];
}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			const body = url.pathname === "/api/files/0/hunks" ? opts.hunks : {};
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onToggle = vi.fn();
	const onCrossOff = vi.fn();
	const onSinceMark = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<DiffBody
				file={fileOf(opts.clusters)}
				revision="r2"
				onToggle={onToggle}
				onCrossOff={onCrossOff}
				from={opts.from}
				kinds={opts.kinds}
				readOnly={opts.readOnly}
				onSinceMark={onSinceMark}
				sinceMarks={opts.sinceMarks}
			/>
		</QueryClientProvider>,
	);
	return { onToggle, onCrossOff, onSinceMark };
}

const kinds = new Map<string, KindEntry>([
	["k1", { key: "k1", kind: "reworked" }],
	[
		"k2",
		{ key: "k2", kind: "carried", from: 1, state: "reviewed", rule: "exact" },
	],
	["g1", { key: "g1", kind: "gone", from: 1 }],
]);

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	// Expanded context is kept for the page (contextRanges): each test starts with none.
	contextRanges.reset();
});

describe("DiffBody in the since view", () => {
	it("chips each cluster's kind; a gone cluster's lines are a red block, markable on their own, chipped reverted", async () => {
		const { onSinceMark } = renderBody({
			clusters: [
				cluster("k1", "unreviewed"),
				cluster("k2", "reviewed", { from: 1, rule: "exact" }),
			],
			hunks: sinceHunks,
			from: 1,
			kinds,
		});
		const rows = await screen.findAllByTestId("cluster-kind");
		expect(rows.map((r) => r.dataset.kind)).toEqual(["reworked", "gone"]);
		const chip = within(rows[0] as HTMLElement).getByTestId("kind-chip");
		expect(chip).toHaveTextContent("reworked");
		// Every piece is markable, with a box and a cross-off.
		expect(
			screen.getAllByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toHaveLength(2);
		expect(
			screen.getAllByRole("button", { name: "Cross off cluster" }),
		).toHaveLength(2);
		const gone = document.querySelector("tbody[data-gone]") as HTMLElement;
		expect(gone).not.toBeNull();
		const goneChips = within(gone).getAllByTestId("kind-chip");
		expect(goneChips.map((c) => c.dataset.kind)).toEqual(["gone", "reverted"]);
		expect(goneChips[1]).toHaveAccessibleDescription(
			"Back to the base's version since PS1",
		);
		expect(within(gone).getByText("gone line")).toBeInTheDocument();
		await userEvent.setup().click(within(gone).getByRole("checkbox"));
		expect(onSinceMark).toHaveBeenLastCalledWith(sinceHunks.pieces?.[1], false);
		// Its rail is red on the chip row and on every line.
		for (const rail of gone.querySelectorAll("td[aria-hidden]")) {
			expect(rail.className).toContain("bg-bad");
		}
		// The carried cluster has no lines here: nothing says "carried".
		expect(screen.queryByText("carried")).toBeNull();
	});

	it("the full diff chips a carried cluster, naming its source", async () => {
		renderBody({
			clusters: [cluster("k1", "reviewed", { from: 1, rule: "rename" })],
			hunks: {
				newLineCount: 3,
				hunks: [
					{
						oldStart: 1,
						oldCount: 3,
						newStart: 1,
						newCount: 3,
						lines: [
							line("context", 1, 1, "a"),
							line("del", 2, undefined, "old", "k1"),
							line("add", undefined, 2, "new", "k1"),
						],
					},
				],
			},
		});
		const row = await screen.findByTestId("cluster-kind");
		expect(row).toHaveAttribute("data-kind", "carried");
		const chip = within(row).getByTestId("kind-chip");
		expect(chip).toHaveTextContent("carried");
		expect(chip).toHaveAccessibleDescription(/PS1/);
		expect(chip).toHaveAccessibleDescription(/renamed/);
		// Still the reviewer's to untick.
		expect(
			screen.getByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeChecked();
	});

	it("an earlier patch set: the box and the cross-off are locked, and say why", async () => {
		const { onToggle } = renderBody({
			clusters: [cluster("k1", "reviewed")],
			hunks: sinceHunks,
			readOnly: true,
		});
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Cross off cluster" }),
		).toBeDisabled();
		await userEvent.setup().click(box);
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("a cluster the engine calls to read but the hunks don't show is counted, never 'nothing to read'", async () => {
		// k3: unreviewed on PS1, unchanged since: "new" to the engine, with no
		// lines in the interdiff (gap 5); k2 carried.
		renderBody({
			clusters: [
				cluster("k2", "reviewed", { from: 1, rule: "exact" }),
				cluster("k3", "unreviewed"),
			],
			hunks: { newLineCount: 5, hunks: [] },
			from: 1,
			kinds: new Map<string, KindEntry>([
				[
					"k2",
					{
						key: "k2",
						kind: "carried",
						from: 1,
						state: "reviewed",
						rule: "exact",
					},
				],
				["k3", { key: "k3", kind: "new" }],
			]),
		});
		const note = await screen.findByTestId("since-unshown");
		expect(note).toHaveTextContent(
			"1 to read · only in the full diff · 1 carried",
		);
		expect(screen.queryByTestId("since-empty")).toBeNull();
		expect(screen.queryByText(/Nothing to read/)).toBeNull();
	});

	it("a file the author left alone says so, with its carried count (never an empty table)", async () => {
		renderBody({
			clusters: [
				cluster("k1", "reviewed", { from: 1, rule: "exact" }),
				cluster("k2", "reviewed", { from: 1, rule: "exact" }),
			],
			hunks: { newLineCount: 5, hunks: [] },
			from: 1,
			kinds,
		});
		expect(await screen.findByTestId("since-empty")).toHaveTextContent(
			"Nothing to read since PS1 · 2 carried",
		);
		expect(screen.queryAllByTestId("diff-line")).toHaveLength(0);
	});
});

describe("the since view's gaps", () => {
	const HEAD = "h".repeat(40);
	const threadOn = (line: number): ReviewThread => ({
		id: `T${line}`,
		loaded: true,
		path: "src/a.ts",
		line,
		currentLine: line,
		excerpt: "hidden remark",
		html: "<p>hidden remark</p>",
		body: "hidden remark",
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
			path: "src/a.ts",
			commit: HEAD,
			side: "RIGHT",
			line,
			startSide: "RIGHT",
			startLine: line,
			at: "2026-01-01T00:00:00Z",
		},
		commit: HEAD,
		subject: "line",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: false, resolve: false, unresolve: false },
	});
	/**
	 * The server: the since view's context (`from=1`) has every line, PS1's
	 * numbering on the old side (one behind); the full diff's skips them all
	 * (they are the PR's own lines there), so a gap that asks it loads none.
	 */
	function renderGaps(hunks: FileHunks, threads?: ReviewThread[]) {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			const q = (k: string) => Number(url.searchParams.get(k));
			const body =
				url.pathname === "/api/files/0/hunks"
					? hunks
					: url.pathname === "/api/comments"
						? { threads: [] }
						: url.pathname === "/api/files/0/context"
							? url.searchParams.get("from") === "1"
								? Array.from(
										{ length: q("newTo") - q("newFrom") + 1 },
										(_, i) =>
											line(
												"context",
												q("newFrom") + i - 1,
												q("newFrom") + i,
												`pr line ${q("newFrom") + i}`,
											),
									)
								: []
							: {};
			return new Response(JSON.stringify(body), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const diffThreads: DiffThreads | undefined = threads
			? { readId: "r", snapshotHead: HEAD, threads }
			: undefined;
		render(
			<QueryClientProvider client={client}>
				<DiffBody
					file={fileOf([])}
					revision="r2"
					onToggle={vi.fn()}
					onCrossOff={vi.fn()}
					from={1}
					kinds={new Map()}
					threads={diffThreads}
				/>
			</QueryClientProvider>,
		);
		return fetchMock;
	}
	const oneHunk: FileHunks = {
		newLineCount: 12,
		hunks: [
			{
				oldStart: 5,
				oldCount: 1,
				newStart: 6,
				newCount: 2,
				lines: [
					line("context", 5, 6, "six"),
					line("add", undefined, 7, "seven", "k1"),
				],
			},
		],
		pieces: [],
	};

	it("a gap loads the interdiff's lines, numbered on both sides as the hunks are", async () => {
		const fetchMock = renderGaps(oneHunk);
		const user = userEvent.setup();
		const gap = (await screen.findAllByTestId("gap-row"))[0] as HTMLElement;
		expect(gap).toHaveTextContent("5 hidden lines");
		await user.click(
			within(gap).getByRole("button", { name: /Load 5 lines above/ }),
		);
		expect(await screen.findByText("pr line 2")).toBeInTheDocument();
		const row = screen.getByText("pr line 2").closest("tr") as HTMLElement;
		expect(row.dataset).toMatchObject({ oldNo: "1", newNo: "2" });
		const asked = fetchMock.mock.calls
			.map(([u]) => String(u))
			.filter((u) => u.includes("/context"));
		expect(asked).toEqual([
			"/api/files/0/context?revision=r2&newFrom=1&newTo=5&from=1",
		]);
		expect(screen.getAllByTestId("gap-row")).toHaveLength(1);
	});

	it("a held context answer spins in its gap row (never 'N hidden lines'), then the lines", async () => {
		const fetchMock = renderGaps(oneHunk);
		let release: () => void = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const answer = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			if (String(input).includes("/context")) await held;
			return (answer as typeof fetch)(input);
		});
		const user = userEvent.setup();
		const gap = (await screen.findAllByTestId("gap-row"))[0] as HTMLElement;
		await user.click(
			within(gap).getByRole("button", { name: /Load 5 lines above/ }),
		);
		expect(
			await within(gap).findByRole("status", { name: "Loading lines" }),
		).toBeInTheDocument();
		expect(gap).not.toHaveTextContent(/hidden line/);
		release();
		expect(await screen.findByText("pr line 2")).toBeInTheDocument();
		expect(screen.queryByRole("status", { name: "Loading lines" })).toBeNull();
	});

	it("a gap whose lines don't come back says so, with Retry (never 'N hidden lines' forever)", async () => {
		const fetchMock = renderGaps(oneHunk);
		// The server answers empty for this view's context.
		fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			const body = url.pathname === "/api/files/0/hunks" ? oneHunk : [];
			return new Response(JSON.stringify(body), { status: 200 });
		});
		const user = userEvent.setup();
		const gap = (await screen.findAllByTestId("gap-row"))[0] as HTMLElement;
		await user.click(
			within(gap).getByRole("button", { name: /Load 5 lines above/ }),
		);
		const alert = await within(gap).findByRole("alert");
		expect(alert).toHaveTextContent("Lines didn't load");
		const before = fetchMock.mock.calls.length;
		await user.click(within(alert).getByRole("button", { name: "Retry" }));
		await vi.waitFor(() =>
			expect(fetchMock.mock.calls.length).toBe(before + 1),
		);
		expect(await within(gap).findByRole("alert")).toBeInTheDocument();
	});

	it("a file the interdiff doesn't touch is one gap; a thread on a hidden line shows once it opens", async () => {
		renderGaps({ hunks: [], newLineCount: 30, wholeGap: true }, [threadOn(25)]);
		const user = userEvent.setup();
		const gap = await screen.findByTestId("gap-row");
		expect(gap).toHaveTextContent("30 hidden lines");
		// Not "line not in this diff": its gap holds it.
		expect(screen.queryByText(/line not in this diff/)).toBeNull();
		await user.click(
			within(gap).getByRole("button", {
				name: "1 comment on hidden lines 1–30",
			}),
		);
		expect(await screen.findByText("pr line 25")).toBeInTheDocument();
		// The thread opens on its line.
		const bubble = await screen.findByRole("button", {
			name: "1 comment on line 25",
		});
		expect(bubble).toHaveAttribute("aria-expanded", "true");
		expect(bubble.closest("tr")).toHaveTextContent("pr line 25");
	});
});

describe("a cluster in pieces", () => {
	/** k: ten lines added at new 2–11 in this snapshot; the since view shows three runs of it. */
	const ten = (over: Partial<ClusterView> = {}): ClusterView => ({
		key: "k",
		kind: "lines",
		oldStart: 1,
		oldCount: 0,
		newStart: 2,
		newCount: 10,
		removed: [],
		added: Array.from({ length: 10 }, (_, i) => `n${i + 2}`),
		lines: 10,
		state: "unreviewed",
		...over,
	});
	/** New lines 3, 7 and 10 changed since PS1; the rest carried, as context. */
	const pieceHunks: FileHunks = {
		newLineCount: 12,
		hunks: [
			{
				oldStart: 1,
				oldCount: 11,
				newStart: 1,
				newCount: 12,
				lines: [
					line("context", 2, 2, "n2"),
					line("del", 3, undefined, "was 3", "k"),
					line("add", undefined, 3, "n3", "k"),
					line("context", 4, 4, "n4"),
					line("context", 6, 6, "n6"),
					line("del", 7, undefined, "was 7", "k"),
					line("add", undefined, 7, "n7", "k"),
					line("context", 8, 8, "n8"),
					line("context", 9, 9, "n9"),
					line("add", undefined, 10, "n10", "k"),
					line("context", 10, 11, "n11"),
					// Only a line that left: none of k's lines.
					line("del", 11, undefined, "gone for good", "k"),
					line("context", 12, 12, "end"),
				],
			},
		],
		pieces: [
			{
				hunk: 0,
				line: 1,
				key: "k",
				owns: [[0, 5]],
				old: [[3, 4]],
				new: [[3, 4]],
			},
			{
				hunk: 0,
				line: 5,
				key: "k",
				owns: [[5, 8]],
				old: [[7, 8]],
				new: [[7, 8]],
			},
			{ hunk: 0, line: 9, key: "k", owns: [[8, 10]], old: [], new: [[10, 11]] },
			{
				hunk: 0,
				line: 11,
				key: "k",
				owns: null,
				old: [[11, 12]],
				new: [],
				kind: "removed",
			},
		],
	};
	const kindsOfK = new Map<string, KindEntry>([
		["k", { key: "k", kind: "reworked" }],
	]);
	const boxes = () =>
		screen.findAllByRole("checkbox", { name: "Mark cluster reviewed" });

	it("each piece has its own checkbox, cross-off and state; one with none of the cluster's lines too, chipped removed", async () => {
		renderBody({
			// The second piece owns new lines 7–9 (indexes 5–7), the third is crossed off.
			clusters: [ten({ reviewedLines: [[5, 8]], crossedLines: [[8, 10]] })],
			hunks: pieceHunks,
			from: 1,
			kinds: kindsOfK,
			sinceMarks: [
				{
					since: 1,
					path: "src/a.ts",
					reviewed: { old: [[11, 12]], new: [] },
					crossed: { old: [], new: [] },
				},
			],
		});
		const all = await boxes();
		expect(all).toHaveLength(3);
		expect(all.map((b) => (b as HTMLInputElement).checked)).toEqual([
			false,
			true,
			true,
		]);
		const crossed = screen.getByRole("checkbox", { name: "Undo cross-off" });
		expect(crossed.closest("tbody")).toHaveTextContent("n10");
		expect(
			screen.getAllByRole("button", { name: "Cross off cluster" }),
		).toHaveLength(4);
		// No piece shows as mixed.
		for (const b of all) expect(b).not.toHaveAttribute("aria-checked");
		const removed = screen.getByText("gone for good").closest("tbody");
		expect(removed?.querySelector("input")).toBeChecked();
		expect(
			within(removed as HTMLElement).getByTestId("kind-chip"),
		).toHaveTextContent("removed");
	});

	it("ticking or crossing off a piece sends the cluster and the lines it owns, nothing else; a piece of its own sends itself", async () => {
		const whole = ten();
		const rendered = renderBody({
			clusters: [whole],
			hunks: pieceHunks,
			from: 1,
			kinds: kindsOfK,
		});
		const { onToggle } = rendered;
		const { onCrossOff, onSinceMark } = rendered;
		const all = await boxes();
		const user = userEvent.setup();
		await user.click(all[0] as HTMLElement);
		expect(onToggle).toHaveBeenLastCalledWith(whole, [[0, 5]]);
		await user.click(all[2] as HTMLElement);
		expect(onToggle).toHaveBeenLastCalledWith(whole, [[8, 10]]);
		const crosses = screen.getAllByRole("button", {
			name: "Cross off cluster",
		});
		await user.click(crosses[1] as HTMLElement);
		expect(onCrossOff).toHaveBeenLastCalledWith(whole, [[5, 8]]);
		await user.click(all[3] as HTMLElement);
		expect(onSinceMark).toHaveBeenLastCalledWith(pieceHunks.pieces?.[3], false);
		await user.click(crosses[3] as HTMLElement);
		expect(onSinceMark).toHaveBeenLastCalledWith(pieceHunks.pieces?.[3], true);
	});

	it("the full diff shows a partly reviewed cluster mixed, its reviewed lines railed green, and a click is the whole cluster's", async () => {
		const whole = ten({ reviewedLines: [[5, 8]] });
		const { onToggle } = renderBody({
			clusters: [whole],
			hunks: {
				newLineCount: 12,
				hunks: [
					{
						oldStart: 1,
						oldCount: 2,
						newStart: 1,
						newCount: 12,
						lines: [
							line("context", 1, 1, "a"),
							...whole.added.map((t, i) =>
								line("add", undefined, i + 2, t, "k"),
							),
							line("context", 2, 12, "end"),
						],
					},
				],
			},
		});
		const [box] = await boxes();
		expect(box).toHaveAttribute("aria-checked", "mixed");
		expect((box as HTMLInputElement).indeterminate).toBe(true);
		expect(box).not.toBeChecked();
		const reviewed = [
			...document.querySelectorAll('tr[data-testid="diff-line"]'),
		]
			.filter((r) => r.hasAttribute("data-reviewed"))
			.map((r) => r.getAttribute("data-new-no"));
		expect(reviewed).toEqual(["7", "8", "9"]);
		await userEvent.setup().click(box as HTMLElement);
		expect(onToggle).toHaveBeenLastCalledWith(whole);
	});
});

describe("ProgressBar's to-read slot", () => {
	const sample: Progress = {
		clusters: { total: 4, reviewed: 2, crossedOff: 0 },
		lines: { total: 8, reviewed: 4, crossedOff: 0 },
		files: { total: 2, reviewed: 1, crossedOff: 0, done: 1 },
	};
	it("says how much needs eyes, spins while the engine computes, shows nothing without a comparison", () => {
		const { rerender } = render(
			<ProgressBar
				progress={sample}
				unit="clusters"
				onUnitChange={() => {}}
				toRead={5}
			/>,
		);
		expect(screen.getByTestId("to-read")).toHaveTextContent("5 to read");
		expect(
			screen.getByRole("progressbar", { name: "Review progress" }),
		).toHaveAttribute("aria-valuetext", expect.stringContaining("5 to read"));
		rerender(
			<ProgressBar
				progress={sample}
				unit="clusters"
				onUnitChange={() => {}}
				toRead={null}
			/>,
		);
		expect(
			screen.getByRole("status", { name: "Counting what is to read" }),
		).toBeInTheDocument();
		expect(screen.queryByText(/0 to read/)).toBeNull();
		rerender(
			<ProgressBar progress={sample} unit="clusters" onUnitChange={() => {}} />,
		);
		expect(screen.queryByTestId("to-read")).toBeNull();
	});
	it("shows the note it is given under the counts", () => {
		render(
			<ProgressBar
				progress={sample}
				unit="clusters"
				onUnitChange={() => {}}
				note={<p data-testid="note">as reviewed · read-only</p>}
			/>,
		);
		expect(screen.getByTestId("note")).toHaveTextContent("read-only");
	});
});

describe("FileTree in a comparison", () => {
	const files = [
		fileOf([cluster("k1", "unreviewed")]),
		{
			...fileOf([cluster("k2", "reviewed", { from: 1, rule: "exact" })]),
			index: 1,
			path: "src/b.ts",
		},
	];
	it("dots the files that need eyes yellow and the fully carried ones green, in the name too", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
				eyesOf={(f) => (f.index === 0 ? "read" : "carried")}
			/>,
		);
		const a = screen.getByRole("button", { name: /a\.ts/ });
		const b = screen.getByRole("button", { name: /b\.ts/ });
		expect(within(a).getByTestId("tree-eyes")).toHaveAttribute(
			"data-eyes",
			"read",
		);
		expect(within(b).getByTestId("tree-eyes")).toHaveAttribute(
			"data-eyes",
			"carried",
		);
		expect(a).toHaveAccessibleName(/needs eyes/);
		expect(b).toHaveAccessibleName(/carried/);
	});
	it("has no dots and no filter outside a comparison", () => {
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
			/>,
		);
		expect(screen.queryAllByTestId("tree-eyes")).toHaveLength(0);
		expect(screen.queryByTestId("needs-eyes")).toBeNull();
	});
	it("the needs-eyes filter is a pressed toggle, shown even without folders", async () => {
		const onChange = vi.fn();
		render(
			<FileTree
				files={files}
				unit="clusters"
				current={null}
				onSelect={() => {}}
				eyesOf={() => "read"}
				filter={{ on: false, onChange }}
			/>,
		);
		const toggle = screen.getByTestId("needs-eyes");
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		await userEvent.setup().click(toggle);
		expect(onChange).toHaveBeenCalledWith(true);
	});
});

describe("GoneFile: a whole file undone since the compared patch set", () => {
	it("each of its pieces is markable on its own, with its cross-off and a reverted chip; a tick sends that piece's mark", async () => {
		const posts: unknown[] = [];
		const goneHunks: FileHunks = {
			newLineCount: 0,
			hunks: [
				{
					oldStart: 1,
					oldCount: 2,
					newStart: 0,
					newCount: 0,
					lines: [
						line("del", 1, undefined, "only then", "g1"),
						line("del", 2, undefined, "also then", "g1"),
					],
				},
			],
			pieces: [
				{
					hunk: 0,
					line: 0,
					key: "g1",
					owns: null,
					old: [[1, 3]],
					new: [],
					kind: "reverted",
				},
			],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://test");
				if (init?.method === "POST") {
					posts.push(JSON.parse(String(init.body)));
					return new Response(JSON.stringify({}), { status: 500 });
				}
				const body = url.pathname === "/api/files/3/hunks" ? goneHunks : {};
				return new Response(JSON.stringify(body), { status: 200 });
			}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<GoneFile
					index={3}
					path="src/undone.ts"
					revision="r2"
					since={1}
					info={{
						kinds: new Map([["g1", { key: "g1", kind: "gone", from: 1 }]]),
						conflict: false,
						counts: {
							reworked: 0,
							new: 0,
							gone: 1,
							carried: 0,
							reverted: 0,
							removed: 0,
							unticked: 0,
						},
						left: { units: 1, lines: 2 },
					}}
				/>
			</QueryClientProvider>,
		);
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box).toBeEnabled();
		expect(
			screen.getByRole("button", { name: "Cross off cluster" }),
		).toBeEnabled();
		const chips = screen.getAllByTestId("kind-chip").map((c) => c.dataset.kind);
		expect(chips).toContain("reverted");
		await user.click(box);
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toMatchObject({
			revision: "r2",
			changes: [
				{
					key: "since:1:src/undone.ts",
					state: "reviewed",
					sinceMark: {
						since: 1,
						path: "src/undone.ts",
						reviewed: { old: [[1, 3]], new: [] },
						crossed: { old: [], new: [] },
					},
				},
			],
		});
	});
});
