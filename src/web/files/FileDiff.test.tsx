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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import { expectLoadingThen, heldJson } from "../../../test/loading";
import type { AgentThread } from "../../shared/agent";
import type { SincePiece } from "../../shared/pieces";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	ReviewView,
	SessionInfo,
	SinceMark,
} from "../../shared/types";
import { agentThreadsQuery } from "../agent/api";
import { AgentPlacingProvider } from "../agent/placeable";
import { reviewQuery, sessionQuery } from "../api";
import {
	type FindMark,
	resetShowInvisibles,
	setShowInvisibles,
} from "../code/Invisibles";
import { ignoreWhitespace, sideBySide } from "../viewSettings";
import { contextRanges } from "./contextRanges";
import type { DiffFind, DiffThreads } from "./DiffBody";
import { FileDiff, UNDO_ARM_MS } from "./FileDiff";
import type { Landing } from "./landing";
import { rendererPicks } from "./renderers";
import { SyncNotices } from "./SyncNotices";
import { type FileSince, unitsFile } from "./since";
import { threadFocus } from "./threadFocus";
import type { Placements } from "./threadPlacement";
import type { Unit } from "./unit";
import { stateSyncFor, useReviewView } from "./useSetStates";

/**
 * A diff line's code by its whole text: a pair's word marks split its text
 * into elements, which the default text match doesn't join.
 */
const codeLine = (text: string) => (_: string, el: Element | null) =>
	el?.hasAttribute("data-code") === true && el.textContent === text;

/** How the file's body shows it (FileDiff's `data-renderer`). */
const shown = () =>
	document
		.querySelector("section[data-renderer]")
		?.getAttribute("data-renderer");
/** The view switch's group (renderers/ViewSwitch), when there is one. */
const viewSwitch = () => screen.queryByRole("group", { name: "View" });
/** Picks a view in the switch; "Image" is its first image button. */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
	const group = viewSwitch();
	if (!group) throw new Error("no view switch");
	await user.click(
		within(group).getByRole("button", {
			name: name === "Image" ? /^(Slider|Image)$/ : name,
		}),
	);
}

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

const cluster = (
	key: string,
	over: Partial<ClusterView> = {},
): ClusterView => ({
	key,
	kind: "lines",
	oldStart: 5,
	oldCount: 1,
	newStart: 5,
	newCount: 1,
	removed: ["old five"],
	added: ["new five"],
	lines: 2,
	state: "unreviewed",
	...over,
});

const file = (
	clusters: ClusterView[],
	over: Partial<FileView> = {},
): FileView => ({
	index: 0,
	path: "src/a.ts",
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	clusters,
	done: clusters.every((c) => c.state !== "unreviewed"),
	reviewed: clusters.every((c) => c.state === "reviewed"),
	crossedOff: clusters.every((c) => c.state === "crossed-off"),
	...over,
});

const ctx = (oldNo: number, newNo: number): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text: `line ${newNo}`,
});

const hunks: FileHunks = {
	newLineCount: 50,
	hunks: [
		{
			oldStart: 2,
			oldCount: 7,
			newStart: 2,
			newCount: 7,
			lines: [
				ctx(2, 2),
				ctx(3, 3),
				ctx(4, 4),
				{ kind: "del", oldNo: 5, text: "old five", clusterKey: "k1" },
				{ kind: "add", newNo: 5, text: "new five", clusterKey: "k1" },
				ctx(6, 6),
				ctx(7, 7),
				ctx(8, 8),
			],
		},
	],
};

const view = (f: FileView): ReviewView => ({
	revision: "r1",
	patchset: 1,
	files: [f],
	progress: {
		clusters: { total: 1, reviewed: 1, crossedOff: 0 },
		lines: { total: 2, reviewed: 2, crossedOff: 0 },
		files: { total: 1, reviewed: 1, crossedOff: 0, done: 1 },
	},
});

/** FileDiff of the review's only file, as useReviewView shows it. */
type Extra = {
	onFinished?: () => void;
	ignoreMarksUntil?: number;
	/** The since view's units, counted by the meter. */
	counted?: FileView;
	/** The since view, "Ignore whitespace" on: how many units `counted` left out. */
	countedLeftOut?: number;
	/** The tracer's placements of the agent threads (FilesPage's read). */
	agentPlacements?: Placements;
	/** In a router (pieces that link: an unplaced row's "near N"). */
	router?: boolean;
	/** The agent placements are on their way. */
	agentPending?: boolean;
	/** The find's hits on the header's path. */
	pathFind?: readonly FindMark[];
	/** The since view: the compared patch set, and the file's pieces. */
	since?: number;
	sincePieces?: readonly SincePiece[];
	/** The PR's review threads. */
	threads?: DiffThreads;
	/** The engine's answer for the file (its chips; the since view's kinds). */
	sinceInfo?: FileSince;
	/** The find's view of the file's diff (a step bumps its stepSeq). */
	find?: DiffFind;
	/** A thread link landing in the file. */
	landing?: Landing;
};

function Shown({ unit, ...extra }: { unit: Unit } & Extra) {
	const { data } = useReviewView();
	const shown = data?.files[0];
	return (
		<>
			{shown && (
				<AgentPlacingProvider
					value={{
						placements: extra.agentPlacements ?? null,
						until: null,
						pending: extra.agentPending,
					}}
				>
					<FileDiff
						file={shown}
						revision="r1"
						unit={unit}
						onFinished={extra.onFinished}
						ignoreMarksUntil={extra.ignoreMarksUntil}
						counted={extra.counted}
						countedLeftOut={extra.countedLeftOut}
						pathFind={extra.pathFind}
						since={extra.since}
						sincePieces={extra.sincePieces}
						sinceMarks={data?.sinceMarks}
						threads={extra.threads}
						sinceInfo={extra.sinceInfo}
						find={extra.find}
						landing={extra.landing}
					/>
				</AgentPlacingProvider>
			)}
			<SyncNotices />
		</>
	);
}

type Result = { status: number; body: unknown };
type Handler = (
	url: URL,
	init?: RequestInit,
) => Result | Promise<Result> | Promise<Response>;

function setup(
	f: FileView,
	handler: Handler = () => ({ status: 404, body: {} }),
	fileHunks: FileHunks | (() => Promise<Response>) = hunks,
	unit: Unit = "clusters",
	extra: Extra = {},
) {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://test");
			// Held (test/loading.ts): answered when the test lets it go.
			if (
				url.pathname === "/api/files/0/hunks" &&
				typeof fileHunks === "function"
			) {
				return fileHunks();
			}
			const result =
				url.pathname === "/api/files/0/hunks"
					? { status: 200, body: fileHunks }
					: await handler(url, init);
			if (result instanceof Response) return result;
			return new Response(JSON.stringify(result.body), {
				status: result.status,
			});
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// Like the page: the file as the reviewer intends it (useReviewView),
	// read only when a test asks for it.
	queryClient.setQueryDefaults(reviewQuery().queryKey, {
		staleTime: Number.POSITIVE_INFINITY,
	});
	queryClient.setQueryData(reviewQuery().queryKey, view(f));
	const shown = (props: Extra = extra) => (
		<QueryClientProvider client={queryClient}>
			<Shown unit={unit} {...props} />
		</QueryClientProvider>
	);
	const rendered = render(extra.router ? inRouter(shown) : shown());
	/** New props from the page (a find's step, a landing), as it rerenders. */
	const update = (next: Partial<Extra>) => {
		Object.assign(extra, next);
		rendered.rerender(shown({ ...extra }));
	};
	/** Shows `next` as the server's file, like a reread does. */
	const rerender = (next: FileView) =>
		act(async () => {
			queryClient.setQueryData(reviewQuery().queryKey, view(next));
			// The query cache notifies on a timeout.
			await new Promise((r) => setTimeout(r, 0));
		});
	const sync = () => stateSyncFor(queryClient).getState();
	const posts = () =>
		fetchMock.mock.calls
			.filter(([, init]) => init?.method === "POST")
			.map(([input, init]) => ({
				path: String(input),
				body: JSON.parse(String(init?.body)),
			}));
	const paths = () => fetchMock.mock.calls.map(([input]) => String(input));
	return {
		fetchMock,
		queryClient,
		rendered,
		sync,
		posts,
		paths,
		rerender,
		update,
		user: userEvent.setup(),
	};
}

/**
 * The file actions' click guards read `performance.now()`: the tests step
 * it by hand (`tick`), so a stalled machine can't flip them.
 */
let clock = 1000;
const tick = (ms = UNDO_ARM_MS) => {
	clock += ms;
};

/**
 * A reset's two clicks: the first asks (the button's name becomes the
 * question), the second, once it takes clicks again, does it.
 */
async function confirmClick(
	user: ReturnType<typeof userEvent.setup>,
	button: HTMLElement,
	question: RegExp = /^Remove all .* markings from this file\?$/,
) {
	await user.click(button);
	expect(button).toHaveAccessibleName(question);
	tick();
	await user.click(button);
}

describe("FileDiff", () => {
	// Code reads as plain text here; invisibles get their own test below.
	beforeEach(() => {
		setShowInvisibles(false);
		clock = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		resetShowInvisibles();
		contextRanges.reset();
		ignoreWhitespace.reset();
		cleanup();
		vi.unstubAllGlobals();
	});

	it("paints find marks on the header's path", () => {
		setup(
			file([cluster("k1")], { path: "src/save.ts" }),
			undefined,
			undefined,
			"clusters",
			{ pathFind: [{ from: 4, to: 8, current: true }] },
		);
		const path = screen.getByTestId("file-path");
		expect(path.querySelector("[data-find-current]")).toHaveTextContent("save");
		expect(path).toHaveTextContent("src/save.ts");
	});

	it("starts collapsed and fetches hunks only on expand", async () => {
		const { paths, user } = setup(file([cluster("k1")]));
		expect(screen.getByTestId("file-path")).toHaveTextContent("src/a.ts");
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 1 cluster");
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(paths()).toEqual([]);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(paths()).toEqual(["/api/files/0/hunks?revision=r1"]);
		expect(screen.getByText("@@ -2,7 +2,7 @@")).toBeInTheDocument();
	});

	it("posts reviewed with the rendered revision and shows the server's answer", async () => {
		const reviewed = file([cluster("k1", { state: "reviewed" })]);
		const { posts, user, queryClient } = setup(file([cluster("k1")]), () => ({
			status: 200,
			body: view(reviewed),
		}));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box).not.toBeChecked();
		await user.click(box);
		await waitFor(() =>
			expect(posts()).toEqual([
				{
					path: "/api/review/states",
					body: { revision: "r1", changes: [{ key: "k1", state: "reviewed" }] },
				},
			]),
		);
		await waitFor(() =>
			expect(queryClient.getQueryData(reviewQuery().queryKey)).toEqual(
				view(reviewed),
			),
		);
	});

	it("undoes a reviewed cluster", async () => {
		const { posts, user } = setup(
			file([cluster("k1", { state: "reviewed" })]),
			() => ({
				status: 200,
				body: view(file([cluster("k1")])),
			}),
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box).toBeChecked();
		await user.click(box);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "unreviewed" },
			]),
		);
	});

	it("shows a change at once and keeps it when its save fails, with Retry", async () => {
		let fail = true;
		const reviewed = file([cluster("k1", { state: "reviewed" })]);
		const { user, posts, sync } = setup(file([cluster("k1")]), (url) =>
			url.pathname === "/api/review"
				? { status: 200, body: view(file([cluster("k1")])) }
				: fail
					? { status: 400, body: { error: "git exploded" } }
					: { status: 200, body: view(reviewed) },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		await user.click(box);
		// Checked before the server answers.
		expect(box).toBeChecked();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("git exploded");
		expect(alert).toHaveTextContent("Reviewed · src/a.ts");
		// The reread server view doesn't roll it back.
		await new Promise((r) => setTimeout(r, 20));
		expect(box).toBeChecked();
		expect(sync().stale).toBeNull();
		fail = false;
		await user.click(screen.getByRole("button", { name: "Retry saving" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(posts()).toHaveLength(2);
		expect(posts()[1]?.body.changes).toEqual([
			{ key: "k1", state: "reviewed" },
		]);
		expect(box).toBeChecked();
	});

	it("reports a stale snapshot and drops the change", async () => {
		const two = file([cluster("k1"), cluster("k2", { newStart: 30 })]);
		const { user, sync } = setup(two, (url) =>
			url.pathname === "/api/review"
				? { status: 200, body: view(two) }
				: { status: 409, body: { error: "stale" } },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = (
			await screen.findAllByRole("checkbox", {
				name: "Mark cluster reviewed",
			})
		)[0] as HTMLElement;
		await user.click(box);
		await waitFor(() => expect(sync().stale).toEqual({ dropped: 1 }));
		expect(box).not.toBeChecked();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("marks the remaining clusters reviewed", async () => {
		const f = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2"),
			cluster("k3", { state: "crossed-off", reason: "generated" }),
			cluster("k4"),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "reviewed" },
				{ key: "k4", state: "reviewed" },
			]),
		);
	});

	describe("in the since view, the file's pieces no cluster owns (CAR-155)", () => {
		// A gone cluster's removed lines, and a cluster's own piece.
		const gonePiece: SincePiece = {
			hunk: 0,
			line: 0,
			key: "g1",
			owns: null,
			old: [[10, 12]],
			new: [],
			kind: "removed",
		};
		const ownPiece: SincePiece = {
			hunk: 0,
			line: 3,
			key: "k2",
			owns: [[0, 2]],
			old: [[5, 6]],
			new: [[5, 6]],
		};
		const pieces = [gonePiece, ownPiece];
		const goneMark = (kind: "reviewed" | "crossed"): SinceMark => ({
			since: 1,
			path: "src/a.ts",
			reviewed: { old: kind === "reviewed" ? [[10, 12]] : [], new: [] },
			crossed: { old: kind === "crossed" ? [[10, 12]] : [], new: [] },
		});

		it("✓ marks the unreviewed clusters and the since-only pieces, nothing else", async () => {
			const f = file([cluster("k1", { state: "reviewed" }), cluster("k2")]);
			const { posts, user } = setup(
				f,
				() => ({ status: 200, body: view(f) }),
				hunks,
				"clusters",
				{ since: 1, sincePieces: pieces },
			);
			await user.click(
				screen.getByRole("button", { name: "Mark remaining reviewed" }),
			);
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual([
					{ key: "k2", state: "reviewed" },
					{
						key: "since:1:src/a.ts",
						state: "reviewed",
						sinceMark: goneMark("reviewed"),
					},
				]),
			);
		});

		it("⊘ crosses off a piece left when every cluster is marked; the file isn't finished till then", async () => {
			const f = file([cluster("k1", { state: "reviewed" })]);
			const { posts, user } = setup(
				f,
				() => ({ status: 200, body: view(f) }),
				hunks,
				"clusters",
				{ since: 1, sincePieces: [gonePiece] },
			);
			// Something is left: no reset, the marks mark it.
			expect(
				screen.queryByRole("button", { name: "Unmark reviewed" }),
			).toBeNull();
			await user.click(screen.getByRole("button", { name: "Cross off file" }));
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual([
					{
						key: "since:1:src/a.ts",
						state: "crossed-off",
						sinceMark: goneMark("crossed"),
					},
				]),
			);
		});

		it.each([
			["reviewed", "Unmark reviewed", "Mark remaining reviewed", "reviewed"],
			["crossed", "Undo cross-off", "Cross off file", "crossed-off"],
		] as const)(
			"a cluster left with a piece already %s: no reset, the header marks only the cluster",
			async (kind, resetName, markName, state) => {
				const f = file([cluster("k2")]);
				const { queryClient, posts, user } = setup(
					f,
					() => ({ status: 200, body: view(f) }),
					hunks,
					"clusters",
					{ since: 1, sincePieces: [gonePiece] },
				);
				await act(async () => {
					queryClient.setQueryData(reviewQuery().queryKey, {
						...view(f),
						sinceMarks: [goneMark(kind)],
					});
					await new Promise((r) => setTimeout(r, 0));
				});
				expect(screen.queryByRole("button", { name: resetName })).toBeNull();
				await user.click(screen.getByRole("button", { name: markName }));
				await waitFor(() =>
					expect(posts()[0]?.body.changes).toEqual([{ key: "k2", state }]),
				);
			},
		);

		it("✓ on an open file whose clusters are done finishes it by its pieces left, and moves on (CAR-159)", async () => {
			const f = file([cluster("k1", { state: "reviewed" })]);
			const onFinished = vi.fn();
			const { posts, user } = setup(
				f,
				() => ({ status: 200, body: view(f) }),
				hunks,
				"clusters",
				{ since: 1, sincePieces: [gonePiece], onFinished },
			);
			await user.click(screen.getByRole("button", { name: "Expand file" }));
			await screen.findAllByText(codeLine("new five"));
			await user.click(
				screen.getByRole("button", { name: "Mark remaining reviewed" }),
			);
			expect(onFinished).toHaveBeenCalledTimes(1);
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual([
					{
						key: "since:1:src/a.ts",
						state: "reviewed",
						sinceMark: goneMark("reviewed"),
					},
				]),
			);
		});

		it("once the pieces are marked too, the reset takes back clusters and pieces of its kind", async () => {
			const f = file([cluster("k1", { state: "reviewed" })]);
			const { queryClient, posts, user } = setup(
				f,
				() => ({ status: 200, body: view(f) }),
				hunks,
				"clusters",
				{ since: 1, sincePieces: [gonePiece] },
			);
			await act(async () => {
				queryClient.setQueryData(reviewQuery().queryKey, {
					...view(f),
					sinceMarks: [goneMark("reviewed")],
				});
				await new Promise((r) => setTimeout(r, 0));
			});
			// The button just swapped in: it takes clicks once armed.
			tick();
			await confirmClick(
				user,
				screen.getByRole("button", { name: "Unmark reviewed" }),
			);
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual([
					{ key: "k1", state: "unreviewed" },
					{
						key: "since:1:src/a.ts",
						state: "unreviewed",
						sinceMark: {
							since: 1,
							path: "src/a.ts",
							reviewed: { old: [], new: [] },
							crossed: { old: [], new: [] },
						},
					},
				]),
			);
		});
	});

	it("in the since view, marking the last cluster keeps the file open while a removed piece is left; marking the piece moves on (CAR-159)", async () => {
		// k1's lines, then a removed piece no cluster owns (old line 7).
		const sinceHunks: FileHunks = {
			newLineCount: 50,
			hunks: [
				{
					oldStart: 4,
					oldCount: 5,
					newStart: 4,
					newCount: 4,
					lines: [
						ctx(4, 4),
						{ kind: "del", oldNo: 5, text: "old five", clusterKey: "k1" },
						{ kind: "add", newNo: 5, text: "new five", clusterKey: "k1" },
						ctx(6, 6),
						{ kind: "del", oldNo: 7, text: "gone seven", clusterKey: "g1" },
						ctx(8, 7),
					],
				},
			],
			pieces: [
				{
					hunk: 0,
					line: 1,
					key: "k1",
					owns: [[0, 2]],
					old: [[5, 6]],
					new: [[5, 6]],
				},
				{
					hunk: 0,
					line: 4,
					key: "g1",
					owns: null,
					old: [[7, 8]],
					new: [],
					kind: "removed",
				},
			],
		};
		const f = file([cluster("k1")]);
		const onFinished = vi.fn();
		const { posts, rerender, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			sinceHunks,
			"clusters",
			{ onFinished, since: 1, sincePieces: sinceHunks.pieces },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const boxes = await screen.findAllByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(boxes).toHaveLength(2);
		// The cluster: the removed piece is still left.
		await user.click(boxes[0] as HTMLElement);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(onFinished).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
		// The cluster reviewed: the piece is the last thing left.
		await rerender(file([cluster("k1", { state: "reviewed" })]));
		const piece = screen.getByText(codeLine("gone seven")).closest("tbody");
		await user.click(
			within(piece as HTMLElement).getByRole("checkbox", {
				name: "Mark cluster reviewed",
			}),
		);
		expect(onFinished).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(posts()).toHaveLength(2));
		expect(posts()[1]?.body.changes).toEqual([
			{
				key: "since:1:src/a.ts",
				state: "reviewed",
				sinceMark: {
					since: 1,
					path: "src/a.ts",
					reviewed: { old: [[7, 8]], new: [] },
					crossed: { old: [], new: [] },
				},
			},
		]);
	});

	it("splits a batch over 1000 clusters into sequential requests", async () => {
		const many = Array.from({ length: 2500 }, (_, i) => cluster(`k${i}`));
		const f = file(many);
		let inFlight = 0;
		let maxInFlight = 0;
		const { posts, user } = setup(f, async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return { status: 200, body: view(f) };
		});
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(3));
		const batches = posts().map((p) => p.body.changes as { key: string }[]);
		expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
		expect(batches.flat().map((c) => c.key)).toEqual(many.map((c) => c.key));
		expect(posts().every((p) => p.body.revision === "r1")).toBe(true);
		expect(maxInFlight).toBe(1);
	});

	it("stores the rest of a refused batch, keeping only the refused change", async () => {
		const f = file(
			Array.from({ length: 1500 }, (_, i) =>
				cluster(`k${i}`, { state: "crossed-off", reason: "generated" }),
			),
		);
		const { posts, user, sync } = setup(f, (url, init) => {
			if (url.pathname === "/api/review") return { status: 200, body: view(f) };
			const { changes } = JSON.parse(String(init?.body)) as {
				changes: { key: string }[];
			};
			return changes.some((c) => c.key === "k1234")
				? { status: 400, body: { error: "Unknown cluster key: k1234" } }
				: { status: 200, body: view(f) };
		});
		await confirmClick(
			user,
			screen.getByRole("button", { name: "Undo cross-off" }),
		);
		const alert = await screen.findByRole("alert");
		await waitFor(() =>
			expect(alert).toHaveTextContent("Unreviewed · src/a.ts"),
		);
		expect(alert).toHaveTextContent("Unknown cluster key: k1234");
		// No request is ever over the limit, and the refused key is isolated in
		// a few halvings, not one request per change.
		const sizes = posts().map((p) => p.body.changes.length as number);
		expect(Math.max(...sizes)).toBe(1000);
		expect(posts().length).toBeLessThan(30);
		await waitFor(() =>
			expect(screen.queryByTestId("save-delayed")).toBeNull(),
		);
		await waitFor(() => expect([...sync().pending.keys()]).toEqual(["k1234"]));
		const sent = posts().flatMap((p) => p.body.changes as { key: string }[]);
		// Every other change was sent (and stored); the refused one alone.
		expect(new Set(sent.map((c) => c.key)).size).toBe(1500);
		expect(
			posts().filter(
				(p) => p.body.changes.length === 1 && p.body.changes[0].key === "k1234",
			),
		).toHaveLength(1);
	});

	it("resends the rest at once when the server names the refused change", async () => {
		const f = file(
			Array.from({ length: 1500 }, (_, i) =>
				cluster(`k${i}`, { state: "crossed-off", reason: "generated" }),
			),
		);
		const { posts, user, sync } = setup(f, (url, init) => {
			if (url.pathname === "/api/review") return { status: 200, body: view(f) };
			const { changes } = JSON.parse(String(init?.body)) as {
				changes: { key: string }[];
			};
			return changes.some((c) => c.key === "k1234")
				? {
						status: 400,
						body: {
							error: "No cluster k1234 in this snapshot",
							keys: ["k1234"],
						},
					}
				: { status: 200, body: view(f) };
		});
		await confirmClick(
			user,
			screen.getByRole("button", { name: "Undo cross-off" }),
		);
		await waitFor(() => expect([...sync().pending.keys()]).toEqual(["k1234"]));
		// 1000 (ok), 500 with k1234 (refused), then its other 499 in one.
		expect(posts().map((p) => p.body.changes.length)).toEqual([1000, 500, 499]);
		expect(screen.getByRole("alert")).toHaveTextContent(
			"Unreviewed · src/a.ts",
		);
	});

	it("crosses off a file at once, without a reason, keeping reviewed clusters", async () => {
		const f = file([
			cluster("k0", { state: "reviewed" }),
			cluster("k1"),
			{ ...cluster("r"), kind: "file", label: "Renamed from b.ts", lines: 0 },
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Cross off file" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "crossed-off" },
				{ key: "r", state: "crossed-off" },
			]),
		);
	});

	it("crosses off one cluster, and undoes it to unreviewed", async () => {
		const f = file([cluster("k1")]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const control = await screen.findByRole("button", {
			name: "Cross off cluster",
		});
		expect(control).toHaveAttribute("aria-pressed", "false");
		await user.click(control);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "crossed-off" },
			]),
		);
		cleanup();

		const crossed = file([cluster("k1", { state: "crossed-off" })]);
		const second = setup(crossed, () => ({ status: 200, body: view(f) }));
		await second.user.click(
			screen.getByRole("button", { name: "Expand file" }),
		);
		const pressed = await screen.findByRole("button", {
			name: "Cross off cluster",
		});
		expect(pressed).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Crossed off")).toBeInTheDocument();
		await second.user.click(pressed);
		await waitFor(() =>
			expect(second.posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "unreviewed" },
			]),
		);
	});

	it("can't cross off a reviewed cluster", async () => {
		setup(file([cluster("k1", { state: "reviewed" })]));
		await userEvent.click(screen.getByRole("button", { name: "Expand file" }));
		expect(
			await screen.findByRole("button", { name: "Cross off cluster" }),
		).toBeDisabled();
	});

	it("shows the file's progress in the selected unit", () => {
		const f = file([
			cluster("k1", { state: "reviewed", lines: 3 }),
			cluster("k2", { state: "crossed-off", lines: 2 }),
			cluster("k3", { lines: 5 }),
		]);
		setup(f, undefined, hunks, "lines");
		const progress = screen.getByRole("progressbar", { name: "File progress" });
		expect(progress).toHaveTextContent("3 / 8 lines");
		expect(progress).toHaveAttribute(
			"aria-valuetext",
			"partly done · 1 line added, 1 deleted · 3 clusters · 3 of 8 lines reviewed, 2 crossed off",
		);
		cleanup();
		setup(f, undefined, hunks, "files");
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 1");
	});

	it("in the since view the meter counts the file's units (its pieces), not its clusters", () => {
		const f = file([cluster("k1", { lines: 10 })]);
		// Three pieces of k1, one reviewed; and a reverted piece.
		const units = unitsFile(f, [
			{
				index: 0,
				path: "src/a.ts",
				kind: "reworked",
				lines: 2,
				state: "reviewed",
				open: 0,
			},
			{
				index: 0,
				path: "src/a.ts",
				kind: "reworked",
				lines: 2,
				state: "unreviewed",
				open: 2,
			},
			{
				index: 0,
				path: "src/a.ts",
				kind: "reworked",
				lines: 1,
				state: "unreviewed",
				open: 1,
			},
			{
				index: 0,
				path: "src/a.ts",
				kind: "reverted",
				lines: 3,
				state: "unreviewed",
				open: 3,
			},
		]);
		setup(f, undefined, hunks, "clusters", { counted: units });
		const progress = screen.getByRole("progressbar", { name: "File progress" });
		expect(progress).toHaveTextContent("1 / 4");
		cleanup();
		setup(f, undefined, hunks, "lines", { counted: units });
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("2 / 8 lines");
		cleanup();
		// A fully carried file in the since view: nothing to read, no numbers.
		setup(f, undefined, hunks, "clusters", {
			counted: unitsFile(f, []),
		});
		const empty = screen.getByRole("progressbar", { name: "File progress" });
		expect(empty).toHaveTextContent("Nothing to read");
		expect(empty).not.toHaveTextContent(/\d/);
		cleanup();
		// The full diff: its one cluster.
		setup(f, undefined, hunks, "clusters");
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 1");
	});

	it("doesn't show a renamed and edited file as finished while the rename is unreviewed", () => {
		const f = file([
			{ ...cluster("r"), kind: "file", label: "Renamed from b.ts", lines: 0 },
			cluster("k1", { state: "reviewed", lines: 3 }),
		]);
		setup(f, undefined, hunks, "lines");
		const progress = screen.getByRole("progressbar", { name: "File progress" });
		expect(progress).toHaveTextContent("3 / 3 lines · 1 cluster left");
		expect(progress).toHaveAttribute("aria-valuenow", "99");
		const reviewed = progress.querySelector<HTMLElement>(
			'[data-part="reviewed"]',
		);
		expect(Number.parseFloat(reviewed?.style.width ?? "100")).toBeLessThan(100);
	});

	it("shows a status phrase for a pure rename in lines", () => {
		setup(
			file([
				{ ...cluster("r"), kind: "file", label: "Renamed from b.ts", lines: 0 },
			]),
			undefined,
			hunks,
			"lines",
		);
		const progress = screen.getByRole("progressbar", { name: "File progress" });
		expect(progress).toHaveTextContent("1 cluster left");
		expect(progress).not.toHaveTextContent("0 / 1");
		expect(progress).toHaveAttribute("aria-valuenow", "0");
	});

	it("says done and how much was crossed off for a partly crossed-off file", () => {
		const f = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { state: "crossed-off" }),
		]);
		setup(f, undefined, hunks, "files");
		const progress = screen.getByRole("progressbar", { name: "File progress" });
		expect(progress).toHaveTextContent("done · 1 crossed off");
		expect(progress).toHaveAttribute(
			"aria-valuetext",
			"1 line added, 1 deleted · 2 clusters · done · 1 crossed off",
		);
	});

	it("tabs through the header in the narrow layout's order: path first", async () => {
		const { user } = setup(file([cluster("k1")]));
		await user.tab();
		expect(screen.getByTestId("file-path")).toHaveFocus();
		await user.tab();
		expect(screen.getByRole("button", { name: "Expand file" })).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toHaveFocus();
		// Status, count and progress are one stop, with one tooltip.
		await user.tab();
		const summary = screen.getByRole("progressbar", { name: "File progress" });
		expect(summary).toHaveFocus();
		const open = [...document.querySelectorAll("[role=tooltip]")].filter(
			(t) => !t.hasAttribute("hidden"),
		);
		expect(open).toHaveLength(1);
		expect(open[0]).toHaveTextContent(
			"not started · 1 line added, 1 deleted · 1 cluster · 0 of 1 cluster reviewed",
		);
		await user.tab();
		expect(document.body).toHaveFocus();
	});

	it("puts the full path in a scroll box", () => {
		setup(file([cluster("k1")], { path: "a/very/long/path/to/the/file.ts" }));
		const path = screen.getByTestId("file-path");
		expect(path).toHaveTextContent("a/very/long/path/to/the/file.ts");
		expect(path).not.toHaveAttribute("title");
	});

	it("undoes a cross-off to unreviewed, never reviewed", async () => {
		const { posts, user } = setup(
			file([cluster("k1", { state: "crossed-off", reason: "generated" })]),
			() => ({ status: 200, body: view(file([cluster("k1")])) }),
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", { name: "Undo cross-off" });
		expect(box).toHaveAccessibleDescription("Crossed off: generated");
		expect(box).not.toBeChecked();
		expect((box as HTMLInputElement).indeterminate).toBe(true);
		await user.click(box);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "unreviewed" },
			]),
		);
	});

	it("undoes the file's cross-offs, and only those", async () => {
		const f = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { state: "crossed-off", reason: "generated" }),
			cluster("k3", { state: "reviewed" }),
			cluster("k4", { state: "crossed-off" }),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		expect(screen.queryByRole("button", { name: "Cross off file" })).toBeNull();
		const undo = screen.getByRole("button", { name: "Undo cross-off" });
		expect(undo).toHaveAttribute("aria-pressed", "true");
		expect(undo).toHaveAccessibleDescription(
			"Set crossed-off clusters back to unreviewed",
		);
		await confirmClick(
			user,
			undo,
			/^Remove all crossed-off markings from this file\?$/,
		);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "unreviewed" },
				{ key: "k4", state: "unreviewed" },
			]),
		);
	});

	it("has no file-level undo without cross-offs", () => {
		setup(file([cluster("k1")]));
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
	});

	it("keeps crossing off while anything is unreviewed, even with cross-offs", async () => {
		const f = file([cluster("k1", { state: "crossed-off" }), cluster("k2")]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
		const cross = screen.getByRole("button", { name: "Cross off file" });
		expect(cross).toHaveAttribute("aria-pressed", "false");
		await user.click(cross);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "crossed-off" },
			]),
		);
	});

	it("flips the file's cross-off button to undo and back", async () => {
		const before = file([cluster("k1", { state: "reviewed" }), cluster("k2")]);
		const crossedOff = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { state: "crossed-off" }),
		]);
		const { posts, rerender, user } = setup(before, () => ({
			status: 200,
			body: view(before),
		}));
		const cross = screen.getByRole("button", { name: "Cross off file" });
		expect(cross).toHaveAttribute("aria-pressed", "false");
		expect(cross).toHaveAccessibleDescription(
			"Mark all unreviewed clusters as not needing review",
		);
		await user.click(cross);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "crossed-off" },
			]),
		);

		await rerender(crossedOff);
		// The same button, now undoing.
		const undo = screen.getByRole("button", { name: "Undo cross-off" });
		expect(undo).toBe(cross);
		expect(undo).toHaveAttribute("aria-pressed", "true");
		await waitFor(() => expect(undo).toBeEnabled());
		// Right after it swaps in, a click (a double click's second) does nothing.
		await user.click(undo);
		await new Promise((r) => setTimeout(r, 50));
		expect(posts()).toHaveLength(1);
		tick();
		await confirmClick(user, undo);
		await waitFor(() =>
			expect(posts()[1]?.body.changes).toEqual([
				{ key: "k2", state: "unreviewed" },
			]),
		);

		await rerender(before);
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
	});

	it("takes a cross-off at once when it comes back right after the undo swapped in (CAR-257)", async () => {
		const before = file([cluster("k1", { state: "reviewed" }), cluster("k2")]);
		const crossedOff = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { state: "crossed-off" }),
		]);
		const { posts, rerender, user } = setup(before, () => ({
			status: 200,
			body: view(before),
		}));
		const cross = screen.getByRole("button", { name: "Cross off file" });
		await user.click(cross);
		await waitFor(() => expect(posts()).toHaveLength(1));
		await rerender(crossedOff);
		expect(cross).toHaveAccessibleName("Undo cross-off");
		// Undone elsewhere (the cluster's own box) within the undo's guard: the
		// cross-off is back, and the guard went with the undo it was for.
		await rerender(before);
		expect(cross).toHaveAccessibleName("Cross off file");
		expect(cross).not.toHaveAttribute("data-clicks-from");
		await user.click(cross);
		await waitFor(() =>
			expect(posts()[1]?.body.changes).toEqual([
				{ key: "k2", state: "crossed-off" },
			]),
		);
	});

	it.each([
		{
			undo: "Undo cross-off",
			back: "Cross off file",
			finished: [
				cluster("k1", { state: "reviewed" }),
				cluster("k2", { state: "crossed-off" }),
			],
			reset: [cluster("k1", { state: "reviewed" }), cluster("k2")],
			resetChanges: [{ key: "k2", state: "unreviewed" }],
			markChanges: [{ key: "k2", state: "crossed-off" }],
		},
		{
			undo: "Unmark reviewed",
			back: "Mark remaining reviewed",
			finished: [cluster("k1", { state: "reviewed" })],
			reset: [cluster("k1")],
			resetChanges: [{ key: "k1", state: "unreviewed" }],
			markChanges: [{ key: "k1", state: "reviewed" }],
		},
	])(
		"a double click on $undo's confirm leaves the file reset; $back takes a click after the wait (CAR-272)",
		async ({ undo, back, finished, reset, resetChanges, markChanges }) => {
			// The server answers the reset, then the mark.
			let answered = 0;
			const { posts, user } = setup(file(finished), () => ({
				status: 200,
				body: view(file(answered++ === 0 ? reset : finished)),
			}));
			const button = screen.getByRole("button", { name: undo });
			await confirmClick(user, button);
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual(resetChanges),
			);
			// The action the reset's own click brought back, in the same place.
			expect(button).toHaveAccessibleName(back);
			expect(button).toHaveAttribute(
				"data-clicks-from",
				String(clock + UNDO_ARM_MS),
			);
			// The double click's second click: nothing happens.
			await user.click(button);
			expect(button).toHaveAccessibleName(back);
			expect(button).toHaveAttribute("aria-pressed", "false");
			expect(posts()).toHaveLength(1);
			// Once the wait is over, a click marks again.
			tick();
			await user.click(button);
			await waitFor(() =>
				expect(posts()[1]?.body.changes).toEqual(markChanges),
			);
			await waitFor(() => expect(button).toHaveAccessibleName(undo));
			expect(posts()).toHaveLength(2);
		},
	);

	it("disables cross off once all is reviewed; mark flips to unmark", () => {
		setup(
			file([
				cluster("k1", { state: "reviewed" }),
				cluster("k2", { state: "reviewed" }),
			]),
		);
		const cross = screen.getByRole("button", { name: "Cross off file" });
		expect(cross).toBeDisabled();
		expect(cross).toHaveAttribute("aria-pressed", "false");
		expect(
			screen.queryByRole("button", { name: "Mark remaining reviewed" }),
		).toBeNull();
		const unmark = screen.getByRole("button", { name: "Unmark reviewed" });
		expect(unmark).toBeEnabled();
		expect(unmark).toHaveAttribute("aria-pressed", "true");
		expect(unmark).toHaveAccessibleDescription(
			"Set reviewed clusters back to unreviewed",
		);
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
	});

	it("tints a finished file's header green, and drops it once it isn't", async () => {
		const unfinished = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2"),
		]);
		const { rerender, user } = setup(unfinished);
		const header = () =>
			document.querySelector("section > header") as HTMLElement;
		const finished = (el: HTMLElement) => ({
			marked: el.hasAttribute("data-finished"),
			wash: el.classList.contains("bg-ok-wash"),
			raised: el.classList.contains("bg-raised"),
		});
		expect(finished(header())).toEqual({
			marked: false,
			wash: false,
			raised: true,
		});
		// Reviewed and crossed off counts as finished.
		await rerender(
			file([
				cluster("k1", { state: "reviewed" }),
				cluster("k2", { state: "crossed-off" }),
			]),
		);
		expect(finished(header())).toEqual({
			marked: true,
			wash: true,
			raised: false,
		});
		// Opaque while it sticks over the diff.
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(header().className).toContain("sticky");
		expect(finished(header()).wash).toBe(true);
		// All crossed off: green, and still the purple undo.
		await rerender(file([cluster("k1", { state: "crossed-off" })]));
		expect(finished(header()).wash).toBe(true);
		expect(
			screen.getByRole("button", { name: "Undo cross-off" }),
		).toHaveAttribute("aria-pressed", "true");
		// An undo: back to exactly today's header.
		await rerender(unfinished);
		expect(finished(header())).toEqual({
			marked: false,
			wash: false,
			raised: true,
		});
	});

	it("disables mark remaining reviewed once nothing is unreviewed", () => {
		setup(file([cluster("k1", { state: "crossed-off" })]));
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Undo cross-off" }),
		).toBeEnabled();
	});

	it("marks the header with the file's kind of change", async () => {
		setup(file([cluster("k1")], { status: "added", deletions: 0 }));
		const section = screen.getByRole("region", { name: "src/a.ts" });
		expect(within(section).getByRole("img", { name: "Added" })).toBeVisible();
		// Touch and keyboard: the path's tooltip (it takes focus) says it too.
		act(() => screen.getByRole("group", { name: "Path: src/a.ts" }).focus());
		const tip = [...document.querySelectorAll('[role="tooltip"]')].filter(
			(t) => !t.hasAttribute("hidden"),
		);
		expect(tip).toHaveLength(1);
		expect(tip[0]).toHaveTextContent("Added · src/a.ts");
		cleanup();
		setup(file([cluster("k1")], { status: "renamed", oldPath: "src/old.ts" }));
		expect(
			screen.getByRole("img", { name: "Renamed from src/old.ts" }),
		).toBeVisible();
	});

	it("names the file actions and explains them in a short tooltip", async () => {
		const { user } = setup(file([cluster("k1")]));
		const mark = screen.getByRole("button", {
			name: "Mark remaining reviewed",
		});
		expect(mark).toBeEnabled();
		expect(mark).not.toHaveAttribute("title");
		expect(mark).toHaveAccessibleDescription(
			"Mark all unreviewed clusters as reviewed",
		);
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveAccessibleDescription(
			"Mark all unreviewed clusters as not needing review",
		);
		// Focus shows it at once.
		act(() => mark.focus());
		expect(screen.getByRole("tooltip")).toHaveTextContent(
			"Mark all unreviewed clusters as reviewed",
		);
		act(() => mark.blur());
		// Hover shows it after the delay.
		await user.hover(mark);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"Mark all unreviewed clusters as reviewed",
		);
		// Inline, never behind a menu.
		expect(screen.queryByRole("button", { name: "File actions" })).toBeNull();
		cleanup();
		setup(file([cluster("k1", { state: "crossed-off" })]));
		expect(
			screen.getByRole("button", { name: "Undo cross-off" }),
		).toHaveAccessibleDescription(
			"Set crossed-off clusters back to unreviewed",
		);
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toHaveAccessibleDescription("Nothing unreviewed");
		cleanup();
		setup(file([cluster("k1", { state: "reviewed" })]));
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveAccessibleDescription("Nothing unreviewed");
	});

	it("has nothing to do, in neutral words, for a file without clusters", async () => {
		const { user } = setup(file([]));
		const cross = screen.getByRole("button", { name: "Cross off file" });
		const mark = screen.getByRole("button", {
			name: "Mark remaining reviewed",
		});
		for (const b of [cross, mark]) {
			expect(b).toBeDisabled();
			expect(b).toHaveAccessibleDescription("No clusters in this file");
		}
		// A disabled button still explains itself on hover (its wrapper takes it).
		const wrapper = cross.parentElement;
		if (!wrapper) throw new Error("no wrapper");
		await user.hover(wrapper);
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			"No clusters in this file",
		);
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
	});

	it("shows the same change counts in every unit; only progress follows it", () => {
		const f = file(
			[cluster("k1", { state: "reviewed", lines: 4 }), cluster("k2")],
			{
				additions: 4,
				deletions: 2,
			},
		);
		const header = () => document.querySelector("header") as HTMLElement;
		const progress = () =>
			screen.getByRole("progressbar", { name: "File progress" });
		const shown: Record<string, string> = {
			lines: "4 / 6 lines",
			clusters: "1 / 2 clusters",
			files: "0 / 1",
		};
		for (const unit of ["lines", "clusters", "files"] as const) {
			setup(f, undefined, hunks, unit);
			expect(header()).toHaveTextContent("+4 −2");
			// The counts are decorative: the summary stop names them.
			const clusters = [...header().querySelectorAll("[aria-hidden]")].find(
				(el) => el.textContent === "2" && el.querySelector("svg"),
			);
			expect(clusters).toBeDefined();
			expect(screen.queryByRole("img", { name: "2 clusters" })).toBeNull();
			expect(progress()).toHaveAttribute(
				"aria-valuetext",
				expect.stringContaining("4 lines added, 2 deleted · 2 clusters · "),
			);
			expect(progress()).toHaveTextContent(shown[unit] as string);
			cleanup();
		}
	});

	it("can be opened and closed by its owner", async () => {
		const onExpandedChange = vi.fn();
		const queryClient = new QueryClient();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(hunks), { status: 200 })),
		);
		const shown = (expanded: boolean) => (
			<QueryClientProvider client={queryClient}>
				<FileDiff
					file={file([cluster("k1")])}
					revision="r1"
					unit="clusters"
					expanded={expanded}
					onExpandedChange={onExpandedChange}
				/>
				<SyncNotices />
			</QueryClientProvider>
		);
		const { rerender } = render(shown(false));
		await userEvent.click(screen.getByRole("button", { name: "Expand file" }));
		expect(onExpandedChange).toHaveBeenLastCalledWith(true, false);
		// Still closed until the owner opens it.
		expect(screen.queryByRole("checkbox")).toBeNull();
		await rerender(shown(true));
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "Collapse file" }),
		);
		expect(onExpandedChange).toHaveBeenLastCalledWith(false, false);
	});

	/**
	 * Saves that answer `status` (400: a failure retrying won't fix), the
	 * first only once `answer` is called.
	 */
	const heldSave = (f: FileView, status: number) => {
		let answer: (() => void) | undefined;
		let released = false;
		const result = setup(f, async (url) => {
			if (url.pathname === "/api/review") return { status: 200, body: view(f) };
			// Only the first write is held; the ones it splits into answer at once.
			if (!released) {
				await new Promise<void>((r) => {
					answer = () => {
						released = true;
						r();
					};
				});
			}
			return status === 200
				? { status, body: view(f) }
				: { status, body: { error: "boom" } };
		});
		return {
			...result,
			answer: async () => {
				await waitFor(() => expect(answer).toBeDefined());
				await act(async () => answer?.());
			},
		};
	};

	it.each([["Mark remaining reviewed"], ["Cross off file"]])(
		"collapses the file at once on %s",
		async (name) => {
			const f = file([cluster("k1"), cluster("k2")]);
			const { posts, user, answer } = heldSave(f, 200);
			await user.click(screen.getByRole("button", { name: "Expand file" }));
			expect(await screen.findAllByText(codeLine("new five"))).not.toHaveLength(
				0,
			);
			await user.click(screen.getByRole("button", { name }));
			// Closed before the save answers, focus on its toggle.
			const toggle = screen.getByRole("button", { name: "Expand file" });
			expect(toggle).toHaveFocus();
			expect(screen.queryByText(codeLine("new five"))).toBeNull();
			await answer();
			await waitFor(() => expect(posts()).toHaveLength(1));
			expect(
				screen.getByRole("button", { name: "Expand file" }),
			).toBeInTheDocument();
		},
	);

	it.each([["Mark remaining reviewed"], ["Cross off file"]])(
		"reopens the file when %s fails",
		async (name) => {
			const f = file([cluster("k1"), cluster("k2")]);
			const { user, answer } = heldSave(f, 400);
			await user.click(screen.getByRole("button", { name: "Expand file" }));
			await user.click(screen.getByRole("button", { name }));
			expect(
				screen.getByRole("button", { name: "Expand file" }),
			).toBeInTheDocument();
			await answer();
			expect(await screen.findByText(/boom/)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Collapse file" }),
			).toBeInTheDocument();
			expect(await screen.findAllByText(codeLine("new five"))).not.toHaveLength(
				0,
			);
		},
	);

	it("doesn't reopen the file when the snapshot moved", async () => {
		const f = file([cluster("k1")]);
		const { user, answer, sync } = heldSave(f, 409);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await answer();
		await waitFor(() => expect(sync().stale).not.toBeNull());
		expect(
			screen.getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
	});

	it("leaves a closed file closed when its file-wide save fails", async () => {
		const f = file([cluster("k1")]);
		const { user, answer } = heldSave(f, 400);
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await answer();
		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
	});

	it.each([
		["Mark cluster reviewed", "checkbox"],
		["Cross off cluster", "button"],
	] as const)("closes the file when %s finishes it", async (name, role) => {
		const f = file([cluster("k1")]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(await screen.findByRole(role, { name }));
		// At once, before the save answers; focus on its toggle.
		const toggle = screen.getByRole("button", { name: "Expand file" });
		expect(toggle).toHaveFocus();
		await waitFor(() => expect(posts()).toHaveLength(1));
	});

	it("moves on (onFinished) when the reviewer's mark finishes the file", async () => {
		// k2 lies outside the diff's hunk: k1 alone has a box.
		const other = cluster("k2", { newStart: 40, oldStart: 40 });
		const f = file([cluster("k1"), other]);
		const onFinished = vi.fn();
		const { posts, rerender, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			hunks,
			"clusters",
			{ onFinished },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		// One of two unreviewed: not finished yet.
		await user.click(box);
		await waitFor(() => expect(posts()).toHaveLength(1));
		// Unmarking never moves on.
		await user.click(box);
		await waitFor(() => expect(posts()).toHaveLength(2));
		expect(onFinished).not.toHaveBeenCalled();
		// k2 reviewed (elsewhere): marking k1 finishes the file.
		await rerender(file([cluster("k1"), { ...other, state: "reviewed" }]));
		await user.click(box);
		expect(onFinished).toHaveBeenCalledTimes(1);
	});

	it("doesn't move on when a closed file is finished from its header", async () => {
		const f = file([cluster("k1")]);
		const onFinished = vi.fn();
		const { posts, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			hunks,
			"clusters",
			{ onFinished },
		);
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(onFinished).not.toHaveBeenCalled();
	});

	it("doesn't move on when a write from elsewhere finishes the file", async () => {
		const f = file([cluster("k1")]);
		const onFinished = vi.fn();
		const { rerender, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			hunks,
			"clusters",
			{ onFinished },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await screen.findAllByText(codeLine("new five"));
		await rerender(file([cluster("k1", { state: "reviewed" })]));
		expect(onFinished).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
	});

	it.each([
		["Undo cross-off", "crossed-off", "crossed-off"],
		["Unmark reviewed", "reviewed", "reviewed"],
	] as const)(
		"%s asks first, then resets the file",
		async (name, state, word) => {
			const f = file([cluster("k1", { state }), cluster("k2", { state })]);
			const onFinished = vi.fn();
			const { posts, user } = setup(
				f,
				() => ({ status: 200, body: view(f) }),
				hunks,
				"clusters",
				{ onFinished },
			);
			const button = screen.getByRole("button", { name });
			await user.click(button);
			// Asked: named and shown as the question; nothing written.
			const question = `Remove all ${word} markings from this file?`;
			expect(button).toHaveAccessibleName(question);
			expect(button).toHaveAttribute("data-armed");
			const tip = screen.getByText(question, { selector: "[role=tooltip]" });
			expect(tip).toBeVisible();
			expect(posts()).toHaveLength(0);
			// A double click's second click doesn't answer it.
			await user.click(button);
			expect(posts()).toHaveLength(0);
			expect(button).toHaveAccessibleName(question);
			tick();
			await user.click(button);
			await waitFor(() =>
				expect(posts()[0]?.body.changes).toEqual([
					{ key: "k1", state: "unreviewed" },
					{ key: "k2", state: "unreviewed" },
				]),
			);
			expect(posts()).toHaveLength(1);
			expect(onFinished).not.toHaveBeenCalled();
		},
	);

	it("drops the question on Escape, blur or a press elsewhere", async () => {
		const f = file([cluster("k1", { state: "reviewed" })]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		const button = screen.getByRole("button", { name: "Unmark reviewed" });
		const ask = async () => {
			await user.click(button);
			expect(button).toHaveAttribute("data-armed");
		};
		await ask();
		await user.keyboard("{Escape}");
		expect(button).toHaveAccessibleName("Unmark reviewed");
		tick();
		await ask();
		await user.tab();
		expect(button).toHaveAccessibleName("Unmark reviewed");
		tick();
		await ask();
		await user.click(document.body);
		expect(button).toHaveAccessibleName("Unmark reviewed");
		// Asked again from scratch: the old question doesn't carry over.
		tick();
		await user.click(button);
		expect(posts()).toHaveLength(0);
	});

	it("a file finished by both kinds resets each kind from its own button", async () => {
		const f = file([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { state: "crossed-off" }),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await confirmClick(
			user,
			screen.getByRole("button", { name: "Unmark reviewed" }),
		);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "unreviewed" },
			]),
		);
	});

	it("a question asked before the file was unfinished elsewhere doesn't come back armed", async () => {
		const finished = file([cluster("k1", { state: "reviewed" })]);
		const { posts, rerender, user } = setup(finished, () => ({
			status: 200,
			body: view(finished),
		}));
		const button = screen.getByRole("button", { name: "Unmark reviewed" });
		await user.click(button);
		expect(button).toHaveAttribute("data-armed");
		// Another tab's write: unfinished, then finished again.
		await rerender(file([cluster("k1")]));
		expect(button).toHaveAccessibleName("Mark remaining reviewed");
		await rerender(finished);
		expect(button).toHaveAccessibleName("Unmark reviewed");
		expect(button).not.toHaveAttribute("data-armed");
		expect(
			screen.queryByText("Remove all reviewed markings from this file?", {
				selector: "[role=tooltip]:not([hidden])",
			}),
		).toBeNull();
		// One click only asks again.
		tick();
		await user.click(button);
		expect(button).toHaveAttribute("data-armed");
		expect(posts()).toHaveLength(0);
	});

	it("ignores marks while a move-on just opened it (ignoreMarksUntil)", async () => {
		const other = cluster("k2", { newStart: 40, oldStart: 40 });
		const f = file([cluster("k1"), other]);
		const { posts, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			hunks,
			"clusters",
			{ ignoreMarksUntil: 1000 + UNDO_ARM_MS },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		// A double click's second click, landing on this file: nothing marked.
		await user.click(box);
		expect(box).not.toBeChecked();
		await user.click(screen.getByRole("button", { name: "Cross off cluster" }));
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await user.click(screen.getByRole("button", { name: "Cross off file" }));
		expect(posts()).toHaveLength(0);
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 2 clusters");
		// Once it's over, a click marks.
		tick();
		await user.click(box);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(posts()[0]?.body.changes).toEqual([
			{ key: "k1", state: "reviewed" },
		]);
	});

	it("ignores marks a moment after a move-on's lines arrive late", async () => {
		const other = cluster("k2", { newStart: 40, oldStart: 40 });
		const f = file([cluster("k1"), other]);
		const lines = heldJson();
		const { posts, user } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			() => lines.response,
			"clusters",
			{ ignoreMarksUntil: 1000 + UNDO_ARM_MS },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		// The page's wait is over before the lines are in.
		tick(2 * UNDO_ARM_MS);
		lines.release(hunks);
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		// They showed up under the pointer just now: not marked.
		await user.click(box);
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		expect(posts()).toHaveLength(0);
		expect(box).not.toBeChecked();
		tick();
		await user.click(box);
		await waitFor(() => expect(posts()).toHaveLength(1));
	});

	it("can't reset a file that isn't finished: it marks the rest", () => {
		setup(file([cluster("k1", { state: "reviewed" }), cluster("k2")]));
		expect(
			screen.queryByRole("button", { name: "Unmark reviewed" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeEnabled();
	});

	it("keeps the file open after undoing a cross-off", async () => {
		const f = file([
			cluster("k1", { state: "crossed-off", reason: "generated" }),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await confirmClick(
			user,
			screen.getByRole("button", { name: "Undo cross-off" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		expect(
			screen.getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
	});

	it("says a reopen after a failed save isn't the reviewer's doing", async () => {
		let answer: (() => void) | undefined;
		const f = file([cluster("k1")]);
		const onExpandedChange = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "POST") {
					await new Promise<void>((r) => {
						answer = r;
					});
					return new Response(JSON.stringify({ error: "boom" }), {
						status: 400,
					});
				}
				return new Response(JSON.stringify(hunks), { status: 200 });
			}),
		);
		const queryClient = new QueryClient();
		const shown = (expanded: boolean) => (
			<QueryClientProvider client={queryClient}>
				<FileDiff
					file={f}
					revision="r1"
					unit="clusters"
					expanded={expanded}
					onExpandedChange={onExpandedChange}
				/>
				<SyncNotices />
			</QueryClientProvider>
		);
		const { rerender } = render(shown(true));
		await userEvent.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		// Closed by the reviewer's action.
		expect(onExpandedChange).toHaveBeenLastCalledWith(false, false);
		await rerender(shown(false));
		await waitFor(() => expect(answer).toBeDefined());
		await act(async () => answer?.());
		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		// Reopened automatically: flagged so it doesn't count as opening it.
		expect(onExpandedChange).toHaveBeenLastCalledWith(true, true);
	});

	it("doesn't reopen a failed file the reviewer already reopened", async () => {
		let answer: (() => void) | undefined;
		const f = file([cluster("k1")]);
		const onExpandedChange = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "POST") {
					await new Promise<void>((r) => {
						answer = r;
					});
					return new Response(JSON.stringify({ error: "boom" }), {
						status: 400,
					});
				}
				return new Response(JSON.stringify(hunks), { status: 200 });
			}),
		);
		const queryClient = new QueryClient();
		const shown = (expanded: boolean) => (
			<QueryClientProvider client={queryClient}>
				<FileDiff
					file={f}
					revision="r1"
					unit="clusters"
					expanded={expanded}
					onExpandedChange={onExpandedChange}
				/>
				<SyncNotices />
			</QueryClientProvider>
		);
		const { rerender } = render(shown(true));
		await userEvent.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		expect(onExpandedChange).toHaveBeenLastCalledWith(false, false);
		await rerender(shown(false));
		// The reviewer opened it again before the save failed.
		await rerender(shown(true));
		await waitFor(() => expect(answer).toBeDefined());
		await act(async () => answer?.());
		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		expect(onExpandedChange).toHaveBeenCalledTimes(1);
	});

	it("leaves a failed file closed when the reviewer opened another", async () => {
		let answer: (() => void) | undefined;
		const f = file([cluster("k1")]);
		const onExpandedChange = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "POST") {
					await new Promise<void>((r) => {
						answer = r;
					});
					return new Response(JSON.stringify({ error: "boom" }), {
						status: 400,
					});
				}
				return new Response(JSON.stringify(hunks), { status: 200 });
			}),
		);
		const queryClient = new QueryClient();
		const shown = (expanded: boolean, otherOpen: boolean) => (
			<QueryClientProvider client={queryClient}>
				<FileDiff
					file={f}
					revision="r1"
					unit="clusters"
					expanded={expanded}
					otherOpen={otherOpen}
					onExpandedChange={onExpandedChange}
				/>
				<SyncNotices />
			</QueryClientProvider>
		);
		const { rerender } = render(shown(true, false));
		await userEvent.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		expect(onExpandedChange).toHaveBeenLastCalledWith(false, false);
		await rerender(shown(false, false));
		// The reviewer opened the next file before the save failed.
		await rerender(shown(false, true));
		await waitFor(() => expect(answer).toBeDefined());
		await act(async () => answer?.());
		// The error shows in the closed section; nothing reopens it.
		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		expect(onExpandedChange).toHaveBeenCalledTimes(1);
	});

	it("doesn't wait for a write: the file's actions follow the intended state", async () => {
		let answer: (() => void) | undefined;
		const f = file([cluster("k1"), cluster("k2")]);
		const crossed = file([
			cluster("k1", { state: "crossed-off" }),
			cluster("k2", { state: "crossed-off" }),
		]);
		const { user, posts } = setup(
			f,
			() =>
				new Promise<Result>((resolve) => {
					answer = () => resolve({ status: 200, body: view(crossed) });
				}),
		);
		const cross = screen.getByRole("button", { name: "Cross off file" });
		await user.click(cross);
		// At once, while the write is out: crossed off, and the undo in its place.
		expect(cross).toHaveAccessibleName("Undo cross-off");
		expect(cross).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeDisabled();
		expect(document.querySelector("section > header")).toHaveAttribute(
			"data-finished",
		);
		// A double click's second click doesn't undo it, or even ask.
		await user.click(cross);
		expect(cross).toHaveAccessibleName("Undo cross-off");
		tick();
		// Undone while the first write is still out: queued behind it.
		await confirmClick(user, cross);
		expect(cross).toHaveAccessibleName("Cross off file");
		expect(posts()).toHaveLength(1);
		await act(async () => answer?.());
		await waitFor(() => expect(posts()).toHaveLength(2));
		expect(posts()[1]?.body.changes).toEqual([
			{ key: "k1", state: "unreviewed" },
			{ key: "k2", state: "unreviewed" },
		]);
		// The first write's answer doesn't overwrite the undo.
		expect(cross).toHaveAccessibleName("Cross off file");
	});

	it("keeps a file closed and retries while saving fails transiently", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let failing = true;
			const f = file([cluster("k1")]);
			const done = file([cluster("k1", { state: "reviewed" })]);
			const { posts } = setup(f, () =>
				failing
					? { status: 503, body: { error: "busy" } }
					: { status: 200, body: view(done) },
			);
			const user = userEvent.setup({
				advanceTimers: vi.advanceTimersByTime,
			});
			await user.click(screen.getByRole("button", { name: "Expand file" }));
			await user.click(
				screen.getByRole("button", { name: "Mark remaining reviewed" }),
			);
			await act(() => vi.advanceTimersByTimeAsync(3500));
			expect(posts().length).toBeGreaterThanOrEqual(2);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(
				screen.getByRole("button", { name: "Expand file" }),
			).toBeInTheDocument();
			await act(() => vi.advanceTimersByTimeAsync(2000));
			expect(screen.getByTestId("save-delayed")).toHaveTextContent(
				"Saving 1 change…",
			);
			failing = false;
			await act(() => vi.advanceTimersByTimeAsync(8000));
			expect(screen.queryByTestId("save-delayed")).toBeNull();
			expect(
				screen.getByRole("button", { name: "Expand file" }),
			).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a write's answer over a review read that was answered before it", async () => {
		const before = view(file([cluster("k1")]));
		const after = view(file([cluster("k1", { state: "reviewed" })]));
		let answerRead: (() => void) | undefined;
		const { user, queryClient } = setup(file([cluster("k1")]), async (url) => {
			if (url.pathname === "/api/review") {
				await new Promise<void>((resolve) => {
					answerRead = resolve;
				});
				return { status: 200, body: before };
			}
			return { status: 200, body: after };
		});
		void queryClient.refetchQueries({ queryKey: reviewQuery().queryKey });
		await waitFor(() => expect(answerRead).toBeDefined());
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		await waitFor(() =>
			expect(queryClient.getQueryData(reviewQuery().queryKey)).toEqual(after),
		);
		answerRead?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(queryClient.getQueryData(reviewQuery().queryKey)).toEqual(after);
	});

	it("while a file's lines load: a spinner, never an empty diff", async () => {
		const lines = heldJson();
		const { user } = setup(
			file([cluster("k1")]),
			undefined,
			() => lines.response,
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading diff" }),
			empty: [
				// No rows, no gap counts: nothing reads as an empty file.
				() => screen.queryByText(/hidden lines?$/),
				() => screen.queryByText("line 2"),
				() => screen.queryByText("Loading diff…"),
			],
			release: () => lines.release(hunks),
			result: () => screen.queryByText(codeLine("new five")),
		});
	});

	it("while a gap's lines load: a spinner in its row, never its bare count", async () => {
		const context = heldJson();
		const { user } = setup(file([cluster("k1")]), () => context.response);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByText("42 hidden lines")).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: "Load 20 lines below" }),
		);
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading lines" }),
			empty: [
				// The gap's own count isn't shown as if nothing were coming.
				() => screen.queryByText("42 hidden lines"),
				() => screen.queryByText("Loading…"),
			],
			release: () =>
				context.release(
					Array.from({ length: 20 }, (_, i) => ctx(9 + i, 9 + i)),
				),
			result: () => screen.queryByText("line 28"),
		});
	});

	it("retries a context range that failed", async () => {
		let calls = 0;
		const { user } = setup(file([cluster("k1")]), (url) => {
			calls++;
			if (calls === 1) return { status: 500, body: { error: "git hiccup" } };
			const from = Number(url.searchParams.get("newFrom"));
			const to = Number(url.searchParams.get("newTo"));
			const lines = [];
			for (let n = from; n <= to; n++) lines.push(ctx(n, n));
			return { status: 200, body: lines };
		});
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("button", { name: "Load 20 lines below" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("git hiccup");
		expect(screen.queryByText("Loading…")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("line 28")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps lines the server didn't return loadable, and says they didn't load", async () => {
		const { user } = setup(file([cluster("k1")]), () => ({
			status: 200,
			body: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((n) => ctx(n, n)),
		}));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("button", { name: "Load 20 lines below" }),
		);
		expect(await screen.findByText("line 18")).toBeInTheDocument();
		expect(screen.queryByText("Loading…")).toBeNull();
		// Never a silent "32 hidden lines": the row says so, with Retry.
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("Lines didn't load");
		expect(
			within(alert).getByRole("button", { name: "Retry" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Load 20 lines below" }),
		).toBeInTheDocument();
	});

	it("loads 20 more lines below a hunk", async () => {
		const { paths, user } = setup(file([cluster("k1")]), (url) => {
			const from = Number(url.searchParams.get("newFrom"));
			const to = Number(url.searchParams.get("newTo"));
			const lines = [];
			for (let n = from; n <= to; n++) lines.push(ctx(n, n));
			return { status: 200, body: lines };
		});
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("button", { name: "Load 20 lines below" }),
		);
		expect(await screen.findByText("line 28")).toBeInTheDocument();
		expect(paths()).toContain(
			"/api/files/0/context?revision=r1&newFrom=9&newTo=28",
		);
		expect(screen.queryByText("line 29")).toBeNull();
	});

	it("renders git's no-newline marker and file-level clusters", async () => {
		const f = file([
			{
				...cluster("m"),
				kind: "file",
				label: "Mode changed 100644 → 100755",
				lines: 0,
			},
			cluster("k1"),
		]);
		const [first] = hunks.hunks;
		if (!first) throw new Error("fixture has a hunk");
		const lines = first.lines.map((l) =>
			l.kind === "add" ? { ...l, noNewline: true } : l,
		);
		setup(f, undefined, { ...hunks, hunks: [{ ...first, lines }] });
		await userEvent.click(screen.getByRole("button", { name: "Expand file" }));
		expect(
			await screen.findByText("Mode changed 100644 → 100755"),
		).toBeInTheDocument();
		expect(
			screen.getByText("\\ No newline at end of file"),
		).toBeInTheDocument();
		// With hidden characters shown, every line ends in \n but the one without a newline.
		act(() => setShowInvisibles(true));
		const ends = Array.from(
			document.querySelectorAll<HTMLElement>('[data-testid="diff-line"]'),
		).map(
			(row) =>
				row.querySelector<HTMLElement>('[data-inv="eol"]')?.dataset.glyph ??
				null,
		);
		const kinds = lines.map((l) => l.kind);
		expect(ends).toEqual(kinds.map((k) => (k === "add" ? null : "\\n")));
		expect(
			screen.getAllByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toHaveLength(2);
	});

	it("marks a whitespace-only cluster reviewed from its collapsed row, and only on a click", async () => {
		ignoreWhitespace.set(true);
		// A second cluster keeps the file open once k1 is marked.
		const other = cluster("k2", { newStart: 40, oldStart: 40 });
		const ws = { whitespaceOnly: true as const };
		const reviewed = file([cluster("k1", { state: "reviewed", ...ws }), other]);
		const [first] = hunks.hunks;
		if (!first) throw new Error("fixture has a hunk");
		const lines = first.lines.map((l) =>
			l.kind === "add" ? { ...l, text: "  old five" } : l,
		);
		const { posts, paths, user } = setup(
			file([cluster("k1", ws), other]),
			() => ({ status: 200, body: view(reviewed) }),
			{ ...hunks, hunks: [{ ...first, lines }] },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const row = await screen.findByTestId("ws-cluster");
		expect(row).toHaveTextContent("Whitespace only · 2 lines");
		expect(screen.queryByText("old five")).toBeNull();
		expect(paths()).toEqual(["/api/files/0/hunks?revision=r1"]);
		expect(posts()).toEqual([]);
		const box = within(row).getByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box).not.toBeChecked();
		await user.click(box);
		await waitFor(() =>
			expect(posts()).toEqual([
				{
					path: "/api/review/states",
					body: { revision: "r1", changes: [{ key: "k1", state: "reviewed" }] },
				},
			]),
		);
		await waitFor(() => expect(box).toBeChecked());
		expect(screen.getByTestId("ws-cluster")).toHaveAttribute("data-reviewed");
		// Its mark is stored, but with the switch on the header counts k2 alone.
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 1 cluster");
		ignoreWhitespace.set(false);
		await waitFor(() =>
			expect(
				screen.getByRole("progressbar", { name: "File progress" }),
			).toHaveTextContent("1 / 2 clusters"),
		);
	});

	const LEFT_OUT = "1 whitespace-only cluster not counted";

	it("the header's `~` (CAR-184): a tap shows its tooltip and leaves a closed file closed; the header elsewhere still opens it", async () => {
		ignoreWhitespace.set(true);
		const ws = { whitespaceOnly: true as const };
		const other = cluster("k2", { newStart: 40, oldStart: 40 });
		const { paths, user } = setup(file([cluster("k1", ws), other]));
		const header = screen.getByTestId("file-path").closest("header");
		if (!header) throw new Error("no header");
		const tilde = within(header).getByRole("img", { name: LEFT_OUT });
		await user.click(tilde);
		expect(screen.getByRole("button", { name: "Expand file" })).toBeVisible();
		expect(paths()).toEqual([]);
		await user.click(header);
		expect(
			await screen.findByRole("button", { name: "Collapse file" }),
		).toBeVisible();
		// Off: nothing left out, no `~`.
		act(() => ignoreWhitespace.set(false));
		await waitFor(() =>
			expect(within(header).queryByRole("img", { name: LEFT_OUT })).toBeNull(),
		);
	});

	it("a file without whitespace-only clusters never shows the `~`", () => {
		ignoreWhitespace.set(true);
		setup(file([cluster("k1")]));
		expect(screen.queryByRole("img", { name: LEFT_OUT })).toBeNull();
	});

	it("in the since view, a header that reads done because a whitespace-only cluster is left out shows the `~` (B1)", () => {
		ignoreWhitespace.set(true);
		const ws = { whitespaceOnly: true as const };
		// A carried, reviewed change; the re-indent the only thing since.
		const f = file([
			cluster("k1", {
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			}),
			cluster("k2", { newStart: 40, oldStart: 40, ...ws }),
		]);
		// Its units with the whitespace-only one left out: none.
		setup(f, undefined, undefined, "clusters", {
			counted: unitsFile(f, []),
			countedLeftOut: 1,
			since: 1,
		});
		const header = screen.getByTestId("file-path").closest("header");
		if (!header) throw new Error("no header");
		expect(header).toHaveAttribute("data-finished");
		expect(within(header).getByRole("img", { name: LEFT_OUT })).toBeVisible();
	});

	it("in the since view, a file of nothing but whitespace-only units reads unfinished, counts them, and shows no `~`: state and counts agree (CAR-218)", () => {
		ignoreWhitespace.set(true);
		const ws = { whitespaceOnly: true as const };
		// The snapshot says done once its re-indent is left out; the since
		// units (countedFileUnits) say the re-indent is all there is to read.
		const f = file([
			cluster("k1", {
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			}),
			cluster("k2", { newStart: 40, oldStart: 40, ...ws }),
		]);
		setup(f, undefined, undefined, "clusters", {
			counted: unitsFile(f, [
				{
					index: 0,
					path: "src/a.ts",
					kind: "reworked",
					lines: 2,
					state: "unreviewed",
					open: 2,
					whitespaceOnly: true,
				},
			]),
			countedLeftOut: 0,
			since: 1,
		});
		const header = screen.getByTestId("file-path").closest("header");
		if (!header) throw new Error("no header");
		expect(header).not.toHaveAttribute("data-finished");
		expect(within(header).queryByRole("img", { name: LEFT_OUT })).toBeNull();
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 1");
	});
});

describe("FileDiff: agent threads asked on an earlier head", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("are still reachable in the file's lead, marked outdated", async () => {
		const user = userEvent.setup();
		const { queryClient } = setup(file([cluster("k1")]));
		const earlier: AgentThread = {
			id: "A1",
			anchor: {
				subject: "line",
				path: "src/a.ts",
				commit: "e".repeat(40),
				side: "RIGHT",
				line: 5,
				startSide: "RIGHT",
				startLine: 5,
			},
			openedBy: "human",
			at: "2026-11-07T10:00:00Z",
			messages: [
				{ id: "m1", by: "human", at: "2026-11-07T10:00:00Z", text: "Why?" },
			],
			resolved: false,
			waiting: false,
			unread: false,
		};
		await act(async () => {
			queryClient.setQueryData(sessionQuery.queryKey, {
				snapshotHead: "f".repeat(40),
			} as SessionInfo);
			queryClient.setQueryData(agentThreadsQuery.queryKey, {
				threads: [earlier],
			});
			await new Promise((r) => setTimeout(r, 0));
		});
		// Closed: the header counts it.
		const closed = await screen.findByTestId("agent-bubble");
		expect(closed).toHaveAccessibleName("1 agent thread in this file");
		await user.click(closed);
		// Open: in the lead row, the card says it is from an earlier version.
		const card = await screen.findByTestId("agent-thread");
		expect(
			within(card).getByRole("img", {
				name: "Asked on an earlier version (eeeeeee)",
			}),
		).toBeTruthy();
		expect(
			screen
				.getAllByTestId("agent-bubble")
				.some((b) => b.getAttribute("aria-label")?.includes("on this file")),
		).toBe(true);
	});
});

describe("FileDiff: agent threads traced into the viewed head", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	const OLD = "e".repeat(40);
	const NOW = "f".repeat(40);
	const asked = (
		id: string,
		line: number,
		more: Partial<AgentThread> = {},
	): AgentThread => ({
		id,
		anchor: {
			subject: "line",
			path: "src/a.ts",
			commit: OLD,
			side: "RIGHT",
			line,
			startSide: "RIGHT",
			startLine: line,
		},
		openedBy: "human",
		at: "2026-11-07T10:00:00Z",
		messages: [
			{
				id: "m1",
				by: "human",
				at: "2026-11-07T10:00:00Z",
				text: `About ${line}?`,
			},
		],
		resolved: false,
		waiting: false,
		unread: false,
		...more,
	});
	const deleted = {
		kind: "unplaced",
		fate: "deleted",
		path: "src/a.ts",
		nearest: { side: "RIGHT", line: 4 },
	} as const;
	async function show(threads: AgentThread[], agentPlacements: Placements) {
		const { queryClient } = setup(
			file([cluster("k1")]),
			undefined,
			hunks,
			"clusters",
			{ agentPlacements, router: true },
		);
		await act(async () => {
			queryClient.setQueryData(sessionQuery.queryKey, {
				snapshotHead: NOW,
			} as SessionInfo);
			queryClient.setQueryData(agentThreadsQuery.queryKey, { threads });
			await new Promise((r) => setTimeout(r, 0));
		});
	}

	it("one whose line was deleted is an unplaced row in the lead: the fate sentence, the Original Reviewed Change, its agent card; resolved ones after, muted", async () => {
		const user = userEvent.setup();
		const code: AgentThread["code"] = {
			anchor: {
				path: "src/a.ts",
				commit: OLD,
				side: "RIGHT",
				line: 5,
				startSide: "RIGHT",
				startLine: 5,
				at: "2026-11-07T10:00:00Z",
			},
			source: "clone",
			rows: [
				{ kind: "context", oldNo: 4, newNo: 4, text: "four", marked: false },
				{ kind: "add", oldNo: null, newNo: 5, text: "five", marked: true },
			],
		};
		await show(
			[asked("R", 6, { resolved: true }), asked("A", 5, { code })],
			new Map([
				["A", deleted],
				["R", deleted],
			]),
		);
		// The closed header counts the unresolved one; it opens the file
		// and its lead.
		await user.click(
			await screen.findByRole("button", {
				name: /^1 agent thread in this file/,
			}),
		);
		const rows = await screen.findAllByTestId("agent-unplaced");
		expect(rows.map((r) => r.dataset.thread)).toEqual(["A", "R"]);
		const [open, quiet] = rows as [HTMLElement, HTMLElement];
		expect(open).toHaveAttribute("data-fate", "deleted");
		expect(within(open).getByTestId("unplaced-fate")).toHaveTextContent(
			"Commented line has been deleted since the review",
		);
		expect(within(open).getByTestId("original-code-title")).toHaveTextContent(
			"Original Reviewed Change",
		);
		expect(within(open).getByTestId("original-code-label")).toHaveTextContent(
			"src/a.ts · line 5",
		);
		// The nearest surviving line, as a review thread's row has it.
		expect(within(open).getByTestId("near-line")).toHaveTextContent("near 4");
		const card = within(open).getByTestId("agent-thread");
		expect(card).toHaveClass("border-agent-edge");
		expect(within(card).queryByTestId("agent-outdated")).toBeNull();
		// In its bordered row box, as a review thread's.
		expect(open).toHaveClass("rounded-md", "border", "border-line");
		// Resolved: after the rest, one quiet line (the fate sentence) that
		// expands to the full row and collapses again, as a review thread's.
		expect(quiet).toHaveAttribute("data-resolved", "true");
		const collapsed = within(quiet).getByTestId("unplaced-collapsed");
		expect(collapsed).toHaveAccessibleName(
			"Resolved thread by you: Commented line has been deleted since the review. Expand",
		);
		expect(within(quiet).queryByTestId("agent-thread")).toBeNull();
		await user.click(collapsed);
		const full = screen
			.getAllByTestId("agent-unplaced")
			.find((r) => r.dataset.thread === "R") as HTMLElement;
		expect(within(full).getByTestId("unplaced-fate")).toHaveTextContent(
			"Commented line has been deleted since the review",
		);
		expect(within(full).getByTestId("agent-thread")).toBeTruthy();
		await user.click(within(full).getByRole("button", { name: "Collapse" }));
		expect(
			within(
				screen
					.getAllByTestId("agent-unplaced")
					.find((r) => r.dataset.thread === "R") as HTMLElement,
			).getByTestId("unplaced-collapsed"),
		).toBeTruthy();
		expect(screen.queryByTestId("agent-outdated")).toBeNull();
	});

	it("while their placements load, a file whose agent threads wait shows a spinner in its agent bubble (closed and open), never an outdated thread", async () => {
		const user = userEvent.setup();
		const { queryClient } = setup(
			file([cluster("k1")]),
			undefined,
			hunks,
			"clusters",
			{ agentPending: true },
		);
		await act(async () => {
			queryClient.setQueryData(sessionQuery.queryKey, {
				snapshotHead: NOW,
			} as SessionInfo);
			queryClient.setQueryData(agentThreadsQuery.queryKey, {
				threads: [asked("W", 5)],
			});
			await new Promise((r) => setTimeout(r, 0));
		});
		const closed = await screen.findByTestId("agent-bubble");
		expect(closed).toHaveAccessibleName("Placing agent threads in this file");
		expect(closed).toHaveAttribute("aria-busy", "true");
		await user.click(closed);
		const open = await screen.findByRole("button", {
			name: "Placing agent threads on this file",
		});
		expect(open).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByTestId("agent-thread")).toBeNull();
		expect(screen.queryByTestId("agent-outdated")).toBeNull();
	});

	it("one traced onto a line is not in the lead; one the tracer has no place for (failed, not in yet) stays there, outdated", async () => {
		const user = userEvent.setup();
		await show(
			[asked("ON", 5), asked("LOST", 6)],
			new Map([
				[
					"ON",
					{
						kind: "placed",
						anchor: {
							path: "src/a.ts",
							startSide: "RIGHT",
							startLine: 6,
							side: "RIGHT",
							line: 6,
						},
						changed: false,
					},
				],
			]),
		);
		await user.click(
			await screen.findByRole("button", {
				name: /^2 agent threads in this file/,
			}),
		);
		const lead = await screen.findAllByTestId("agent-thread");
		expect(lead.map((c) => c.dataset.thread)).toEqual(["LOST"]);
		expect(
			within(lead[0] as HTMLElement).getByRole("img", {
				name: "Asked on an earlier version (eeeeeee)",
			}),
		).toBeTruthy();
	});
});

/** A review thread on line 5 of img/icon.svg, on `head` (or on the file). */
const svgLineThread = (
	head: string,
	id = "T1",
	subject: "line" | "file" = "line",
) =>
	({
		id,
		loaded: true,
		path: "img/icon.svg",
		line: 5,
		currentLine: 5,
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
		anchor:
			subject === "file"
				? null
				: {
						path: "img/icon.svg",
						commit: head,
						side: "RIGHT",
						line: 5,
						startSide: "RIGHT",
						startLine: 5,
						at: "2026-01-01T00:00:00Z",
					},
		commit: head,
		subject,
		attention: [],
		yourTurn: false,
		viewerCan: { reply: false, resolve: false, unresolve: false },
	}) as unknown as DiffThreads["threads"][number];

describe("FileDiff: the renderer seam", () => {
	beforeEach(() => {
		setShowInvisibles(false);
		vi.spyOn(performance, "now").mockImplementation(() => 1000);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		rendererPicks.reset();
		sideBySide.reset();
		resetShowInvisibles();
		contextRanges.reset();
		cleanup();
		vi.unstubAllGlobals();
	});

	const binaryCluster = (): ClusterView => ({
		...cluster("bin"),
		kind: "file",
		label: "Binary file changed",
		lines: 0,
	});
	const png = (over: Partial<FileView> = {}) =>
		file([binaryCluster()], {
			path: "img/logo.png",
			binary: true,
			additions: 0,
			deletions: 0,
			...over,
		});
	const binaryHunks: FileHunks = { newLineCount: 0, hunks: [] };
	const hunkReads = (paths: () => string[]) =>
		paths().filter((p) => p.startsWith("/api/files/0/hunks"));

	it("an open PNG shows the view switch in its toolbar; a .ts file has none, and no new row", async () => {
		const { user } = setup(png(), undefined, binaryHunks);
		expect(shown()).toBe("image");
		// Closed: no switch (the header holds no chip any more).
		expect(viewSwitch()).toBeNull();
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const group = await screen.findByRole("group", { name: "View" });
		expect(screen.getByTestId("image-view")).toContainElement(group);
		const buttons = within(group).getAllByRole("button");
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Slider",
			"Fade",
			"Binary",
		]);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"true",
			"false",
			"false",
		]);
		cleanup();
		const ts = setup(file([cluster("k1")]));
		await ts.user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(shown()).toBe("text");
		expect(viewSwitch()).toBeNull();
		expect(screen.queryByTestId("view-bar")).toBeNull();
	});

	/** The switch's buttons' names, in order. */
	const switchNames = () =>
		within(viewSwitch() as HTMLElement)
			.getAllByRole("button")
			.map((b) => b.getAttribute("aria-label"));

	it.each([
		["an added PNG", { status: "added" as const }, false],
		["a deleted PNG", { status: "deleted" as const }, false],
		["a PNG side by side", {}, true],
		[
			"a PNG renamed with the same blob",
			{
				status: "renamed" as const,
				oldPath: "img/old.png",
				sameBlob: true as const,
			},
			false,
		],
	])(
		"%s: [Image, Binary] in Image view and on Binary's row",
		async (_, over, sbs) => {
			sideBySide.set(sbs);
			const { user } = setup(png(over), undefined, binaryHunks);
			await user.click(screen.getByRole("button", { name: "Expand file" }));
			expect(switchNames()).toEqual(["Image", "Binary"]);
			await pick(user, "Binary");
			expect(shown()).toBe("binary");
			expect(
				within(screen.getByTestId("view-bar"))
					.getAllByRole("button")
					.map((b) => b.getAttribute("aria-label")),
			).toEqual(["Image", "Binary"]);
			sideBySide.reset();
		},
	);

	it("Fade from Binary goes back to Image in Fade; the switch stays on Binary's own row", async () => {
		const { user } = setup(png(), undefined, binaryHunks);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await pick(user, "Binary");
		expect(shown()).toBe("binary");
		const bar = screen.getByTestId("view-bar");
		expect(within(bar).getByRole("button", { name: "Binary" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		// Just the control: no dimensions or fit button.
		expect(within(bar).getAllByRole("button")).toHaveLength(3);
		await user.click(within(bar).getByRole("button", { name: "Fade" }));
		expect(shown()).toBe("image");
		expect(screen.queryByTestId("view-bar")).toBeNull();
		expect(
			within(screen.getByTestId("image-view")).getByRole("button", {
				name: "Fade",
			}),
		).toHaveAttribute("aria-pressed", "true");
		expect(localStorage.getItem("crb.image.mode")).toContain("fade");
		expect(rendererPicks.get("img/logo.png")).toBe("image");
	});

	it("picking Binary on a PNG renders today's binary rows and persists per path", async () => {
		const { user, paths, posts } = setup(png(), undefined, binaryHunks);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		// Image: the file-level row, and no lines read.
		expect(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeInTheDocument();
		expect(hunkReads(paths)).toEqual([]);
		await pick(user, "Binary");
		expect(screen.queryByRole("menu")).toBeNull();
		expect(shown()).toBe("binary");
		// Binary: today's DiffBody, its hunks read as before.
		await waitFor(() =>
			expect(hunkReads(paths)).toEqual(["/api/files/0/hunks?revision=r1"]),
		);
		expect(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		).not.toBeChecked();
		expect(screen.getByText("Binary file changed")).toBeInTheDocument();
		// Kept per path, as data; no review state written.
		expect(
			JSON.parse(localStorage.getItem("crb.files.renderer") ?? ""),
		).toEqual({ "img/logo.png": "binary" });
		expect(rendererPicks.get("img/logo.png")).toBe("binary");
		expect(rendererPicks.get("img/other.png")).toBeUndefined();
		expect(posts()).toEqual([]);
	});

	it("a pick for another path leaves this file as it claims", () => {
		rendererPicks.set("img/other.png", "binary");
		setup(png(), undefined, binaryHunks);
		expect(shown()).toBe("image");
	});

	it("DiffBody linesHidden fetches no hunks and keeps the file-level checkbox", async () => {
		// An SVG: text, line clusters, a file-level one (its mode changed).
		const svg = file(
			[
				cluster("k1"),
				{
					...cluster("mode"),
					kind: "file",
					label: "Mode 100644 → 100755",
					lines: 0,
				},
			],
			{ path: "img/icon.svg" },
		);
		const { user, paths } = setup(svg);
		expect(shown()).toBe("image");
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		expect(box.closest("tr")).toHaveTextContent("Mode 100644 → 100755");
		// One box: the line cluster has no row here (the header's action
		// covers it), and no line, spinner or error stands in.
		expect(screen.getAllByRole("checkbox")).toHaveLength(1);
		expect(screen.queryByText(codeLine("new five"))).toBeNull();
		// The only busy region is the image's own stage (ImageView).
		expect(screen.queryByRole("status", { name: "Loading diff" })).toBeNull();
		for (const busy of document.querySelectorAll('[aria-busy="true"]')) {
			expect(busy).toHaveAttribute("data-testid", "image-stage");
		}
		expect(hunkReads(paths)).toEqual([]);
		// The header's action still counts the line cluster.
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 2 clusters");
		// Text: the lines, read as today.
		await pick(user, "Text");
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(hunkReads(paths)).toEqual(["/api/files/0/hunks?revision=r1"]);
	});

	it("an SVG's line thread lists under the header in Image view, never dropped", async () => {
		const head = "h".repeat(40);
		const t = svgLineThread(head);
		const { user, paths } = setup(
			file([cluster("k1")], { path: "img/icon.svg" }),
			undefined,
			undefined,
			"clusters",
			{ threads: { readId: "r", snapshotHead: head, threads: [t] } },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		// The file's bubble holds it, flagged as not on a line.
		const bubble = await screen.findByRole("button", {
			name: /^1 comment on this file.*line not in this diff/,
		});
		await user.click(bubble);
		expect(bubble).toHaveAttribute("aria-expanded", "true");
		expect(hunkReads(paths)).toEqual([]);
	});

	it("since view, lines hidden: an SVG with nothing left to read says so, never an empty table", async () => {
		const svg = file(
			[
				cluster("k1", {
					state: "reviewed",
					carried: { from: 1, rule: "exact" },
				}),
			],
			{
				path: "img/icon.svg",
			},
		);
		const { user, paths } = setup(svg, undefined, undefined, "clusters", {
			since: 1,
			sincePieces: [],
		});
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByTestId("since-empty")).toHaveTextContent(
			"Nothing to read since PS1",
		);
		expect(hunkReads(paths)).toEqual([]);
	});

	it("since view, lines hidden: no lines note, and the header still counts the unshown clusters and pieces", async () => {
		const svg = file([cluster("k1")], { path: "img/icon.svg" });
		const gone: SincePiece = {
			hunk: 0,
			line: 0,
			key: "g1",
			owns: null,
			old: [[10, 12]],
			new: [],
			kind: "removed",
		};
		const unit = (state: "unreviewed" | "reviewed") => ({
			index: 0,
			path: "img/icon.svg",
			kind: "reworked" as const,
			lines: 2,
			state,
			open: state === "unreviewed" ? 2 : 0,
		});
		// k1 (reworked) and the removed piece: two units, both open.
		const counted = unitsFile(svg, [unit("unreviewed"), unit("unreviewed")]);
		const sinceInfo: FileSince = {
			kinds: new Map([["k1", { key: "k1", kind: "reworked" }]]),
			conflict: false,
			counts: {
				reworked: 1,
				new: 0,
				gone: 0,
				carried: 0,
				reverted: 0,
				removed: 1,
				unticked: 0,
			},
			left: { units: 2, lines: 4 },
		};
		const { user, paths } = setup(svg, undefined, undefined, "clusters", {
			since: 1,
			sincePieces: [gone],
			counted,
			sinceInfo,
		});
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("0 / 2");
		// The header's action covers them: Mark remaining reviewed is live.
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeEnabled();
		expect(screen.queryByTestId("since-unshown")).toBeNull();
		expect(screen.queryByTestId("since-empty")).toBeNull();
		expect(hunkReads(paths)).toEqual([]);
	});

	it("an LFS pointer shows the LFS icon and no view switch", async () => {
		const { user } = setup(
			file([cluster("k1")], { path: "img/big.png", lfs: true }),
			undefined,
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(viewSwitch()).toBeNull();
		const icon = screen.getByRole("img", { name: "Git LFS pointer" });
		expect(icon).toBeInTheDocument();
	});

	it("a plain file shows no LFS icon", () => {
		setup(png());
		expect(screen.queryByRole("img", { name: "Git LFS pointer" })).toBeNull();
	});
});

/*
 * Review and comments in the image view (CAR-38 task 5). The image view's
 * review control is the header's existing action (FileMarkActions): no new
 * write path. An SVG keeps its line clusters; in Image view one press
 * covers every unit the view shows.
 */
describe("FileDiff: review in the image view", () => {
	beforeEach(() => {
		setShowInvisibles(false);
		clock = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		rendererPicks.reset();
		threadFocus.reset();
		resetShowInvisibles();
		contextRanges.reset();
		cleanup();
		vi.unstubAllGlobals();
	});

	const SVG = "img/icon.svg";
	const svg = (clusters: ClusterView[]) => file(clusters, { path: SVG });
	const hunkReads = (paths: () => string[]) =>
		paths().filter((p) => p.startsWith("/api/files/0/hunks"));

	it("SVG in Image view: Mark remaining reviewed ticks every shown line cluster, and nothing else", async () => {
		const f = svg([
			cluster("k1"),
			cluster("k2", { newStart: 10, state: "reviewed" }),
			cluster("k3", {
				newStart: 20,
				state: "crossed-off",
				reason: "generated",
			}),
			cluster("k4", { newStart: 30 }),
		]);
		const { posts, user, paths } = setup(f, () => ({
			status: 200,
			body: view(f),
		}));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		// The open ones only: what's reviewed or crossed off stays as it is.
		expect(posts()[0]).toEqual({
			path: "/api/review/states",
			body: {
				revision: "r1",
				changes: [
					{ key: "k1", state: "reviewed" },
					{ key: "k4", state: "reviewed" },
				],
			},
		});
		// Image view read no lines to do it.
		expect(hunkReads(paths)).toEqual([]);
	});

	it("SVG with some clusters ticked in Text view: the header shows the mixed state and a press ticks only the open ones", async () => {
		const mixed = svg([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { newStart: 20 }),
		]);
		const done = svg([
			cluster("k1", { state: "reviewed" }),
			cluster("k2", { newStart: 20, state: "reviewed" }),
		]);
		let answer = done;
		const { posts, user, rerender } = setup(mixed, () => ({
			status: 200,
			body: view(answer),
		}));
		// Ticked line by line in Text view first.
		rendererPicks.set(SVG, "text");
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		await pick(user, "Image");
		expect(shown()).toBe("image");
		// Mixed: part done, and the action still marks (no reset while
		// anything is open).
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("1 / 2 clusters");
		expect(
			screen.queryByRole("button", { name: "Unmark reviewed" }),
		).toBeNull();
		const markButton = screen.getByRole("button", {
			name: "Mark remaining reviewed",
		});
		expect(markButton).toHaveAttribute("aria-pressed", "false");
		await user.click(markButton);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "reviewed" },
			]),
		);
		// All reviewed: the press unticks them all (asking first).
		await rerender(done);
		answer = mixed;
		tick();
		const undo = await screen.findByRole("button", {
			name: "Unmark reviewed",
		});
		expect(undo).toHaveAttribute("aria-pressed", "true");
		await confirmClick(user, undo);
		await waitFor(() =>
			expect(posts()[1]?.body.changes).toEqual([
				{ key: "k1", state: "unreviewed" },
				{ key: "k2", state: "unreviewed" },
			]),
		);
	});

	it("since view: an image's header action writes the since units only", async () => {
		// A gone cluster's removed lines (no cluster owns them), and k2's
		// own piece; k1 was reviewed (carried) and isn't in the interdiff.
		const gonePiece: SincePiece = {
			hunk: 0,
			line: 0,
			key: "g1",
			owns: null,
			old: [[10, 12]],
			new: [],
			kind: "removed",
		};
		const ownPiece: SincePiece = {
			hunk: 0,
			line: 3,
			key: "k2",
			owns: [[0, 2]],
			old: [[5, 6]],
			new: [[5, 6]],
		};
		const f = svg([
			cluster("k1", {
				state: "reviewed",
				carried: { from: 1, rule: "exact" },
			}),
			cluster("k2"),
		]);
		const { posts, user, paths } = setup(
			f,
			() => ({ status: 200, body: view(f) }),
			hunks,
			"clusters",
			{ since: 1, sincePieces: [gonePiece, ownPiece] },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k2", state: "reviewed" },
				{
					key: `since:1:${SVG}`,
					state: "reviewed",
					sinceMark: {
						since: 1,
						path: SVG,
						reviewed: { old: [[10, 12]], new: [] },
						crossed: { old: [], new: [] },
					},
				},
			]),
		);
		expect(posts()).toHaveLength(1);
		expect(hunkReads(paths)).toEqual([]);
	});

	/** The find's view of the file with its current hit on new `line`. */
	const stepped = (line: number, stepSeq: number): DiffFind => ({
		marksOf: () => [],
		current: { old: false, line },
		shown: true,
		stepSeq,
	});

	it("a find step onto an SVG line in Image view shows it as Text for the view; the pick is unchanged, Image returns", async () => {
		const { user, update, paths } = setup(svg([cluster("k1")]));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		expect(screen.getByTestId("image-view")).toBeInTheDocument();
		// Marks alone (typing) change nothing.
		update({ find: { ...stepped(5, 0), current: null } });
		expect(shown()).toBe("image");
		// A step onto line 5: Text, its lines read, the line there.
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(hunkReads(paths)).toEqual(["/api/files/0/hunks?revision=r1"]);
		expect(screen.queryByTestId("image-view")).toBeNull();
		// The stored pick is untouched.
		expect(rendererPicks.get(SVG)).toBeUndefined();
		expect(localStorage.getItem("crb.files.renderer")).toBeNull();
		// The same step again (a rerender) doesn't switch back or again.
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		// Image again: back to the image, still nothing stored.
		await pick(user, "Image");
		expect(shown()).toBe("image");
		expect(screen.getByTestId("image-view")).toBeInTheDocument();
		expect(rendererPicks.get(SVG)).toBeUndefined();
		// A later step switches again.
		update({ find: stepped(5, 2) });
		expect(shown()).toBe("text");
	});

	it("a thread link to an SVG line in Image view shows it as Text for the view, not stored", async () => {
		const { user, update } = setup(svg([cluster("k1")]));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		// A link to the file alone (no line) keeps the image.
		update({ landing: { path: SVG, index: 0, seq: 1 } });
		expect(shown()).toBe("image");
		update({
			landing: { path: SVG, line: 5, side: "RIGHT", index: 0, seq: 2 },
		});
		expect(shown()).toBe("text");
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		expect(rendererPicks.get(SVG)).toBeUndefined();
	});

	it("a Threads tab row for an SVG line's thread in Image view shows Text for the view; its line's card takes it", async () => {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
		vi.spyOn(window, "scrollTo").mockImplementation(() => {});
		const head = "h".repeat(40);
		const { user } = setup(svg([cluster("k1")]), undefined, hunks, "clusters", {
			threads: {
				readId: "r",
				snapshotHead: head,
				threads: [svgLineThread(head), svgLineThread(head, "F1", "file")],
			},
		});
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		// A file comment's row keeps the image: its card is the file bubble's.
		act(() => {
			threadFocus.request({ id: "F1" });
		});
		expect(shown()).toBe("image");
		await waitFor(() => expect(threadFocus.get()).toBeNull());
		// A line thread's row: Text, and the card on its line takes it.
		act(() => {
			threadFocus.request({ id: "T1" });
		});
		expect(shown()).toBe("text");
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		await waitFor(() => expect(threadFocus.get()).toBeNull());
		expect(
			screen.queryByRole("button", {
				name: /line not in this diff/,
			}),
		).toBeNull();
		expect(rendererPicks.get(SVG)).toBeUndefined();
	});

	it("picking Image after a thread link's Text shows no hint and doesn't scroll", async () => {
		const scrolls = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
		const { user, update } = setup(svg([cluster("k1")]));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		update({
			landing: { path: SVG, line: 5, side: "RIGHT", index: 0, seq: 1 },
		});
		expect(await screen.findByText(codeLine("new five"))).toBeInTheDocument();
		await waitFor(() => expect(scrolls).toHaveBeenCalled());
		expect(screen.queryByTestId("landing-hint")).toBeNull();
		scrolls.mockClear();
		await pick(user, "Image");
		expect(shown()).toBe("image");
		// The same landing, still the page's, isn't replayed on the image.
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByTestId("landing-hint")).toBeNull();
		expect(scrolls).not.toHaveBeenCalled();
		// Nor after closing and reopening the file there.
		await user.click(screen.getByRole("button", { name: "Collapse file" }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await new Promise((r) => setTimeout(r, 20));
		expect(screen.queryByTestId("landing-hint")).toBeNull();
		expect(scrolls).not.toHaveBeenCalled();
	});

	it("mounted with a step or a landing already given (a new snapshot), it stays Image", async () => {
		const { user, update } = setup(
			svg([cluster("k1")]),
			undefined,
			hunks,
			"clusters",
			{
				find: stepped(5, 3),
				landing: { path: SVG, line: 5, side: "RIGHT", index: 0, seq: 2 },
			},
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		// A step after it mounted still switches.
		update({ find: stepped(5, 4) });
		expect(shown()).toBe("text");
	});

	it("a switch ended by the pick changing elsewhere doesn't come back", async () => {
		const { update } = setup(svg([cluster("k1")]));
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		// Another tab picks Text, then Image: the image, not the old switch.
		act(() => rendererPicks.set(SVG, "text"));
		expect(shown()).toBe("text");
		act(() => rendererPicks.set(SVG, "image"));
		expect(shown()).toBe("image");
	});

	it("since view: a find step onto an SVG line shows Text and reads the interdiff's lines", async () => {
		const { user, update, paths } = setup(
			svg([cluster("k1")]),
			undefined,
			hunks,
			"clusters",
			{ since: 1, sincePieces: [] },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		expect(shown()).toBe("image");
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		await waitFor(() =>
			expect(hunkReads(paths)).toEqual([
				"/api/files/0/hunks?revision=r1&from=1",
			]),
		);
		expect(rendererPicks.get(SVG)).toBeUndefined();
	});

	it("a find step onto a .ts file changes nothing: no switch, no image", () => {
		const { update } = setup(file([cluster("k1")]));
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		expect(viewSwitch()).toBeNull();
		expect(screen.queryByTestId("image-view")).toBeNull();
		expect(localStorage.getItem("crb.files.renderer")).toBeNull();
	});

	it("a find step onto a PNG changes nothing (no Text for a binary)", async () => {
		const png = file(
			[
				{
					...cluster("bin"),
					kind: "file",
					label: "Binary file changed",
					lines: 0,
				},
			],
			{ path: "img/logo.png", binary: true, additions: 0, deletions: 0 },
		);
		const { update } = setup(png, undefined, { newLineCount: 0, hunks: [] });
		update({ find: stepped(1, 1) });
		expect(shown()).toBe("image");
	});

	it("while a find step's Text holds, the row shows Text pressed, and pressing it again stores nothing", async () => {
		const { user, update } = setup(svg([cluster("k1")]));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		const bar = screen.getByTestId("view-bar");
		const text = within(bar).getByRole("button", { name: "Text" });
		expect(text).toHaveAttribute("aria-pressed", "true");
		expect(within(bar).getByRole("button", { name: "Slider" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		await user.click(text);
		expect(shown()).toBe("text");
		expect(rendererPicks.get(SVG)).toBeUndefined();
		expect(localStorage.getItem("crb.files.renderer")).toBeNull();
	});

	it("Text picked and stored stays Text after a step; picking Image stores Image", async () => {
		rendererPicks.set(SVG, "text");
		const { user, update } = setup(svg([cluster("k1")]));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		update({ find: stepped(5, 1) });
		expect(shown()).toBe("text");
		await pick(user, "Image");
		expect(shown()).toBe("image");
		expect(rendererPicks.get(SVG)).toBe("image");
	});
});
