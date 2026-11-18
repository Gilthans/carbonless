// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import type { SpanAgentThread } from "../../shared/agent";
import type { MovedInfo } from "../../shared/rereview/moves";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type { PlacementsAnswer, ReviewThread } from "../../shared/types";
import { AgentPlacingProvider } from "../agent/placeable";
import { placementsQuery } from "../api";
import {
	PlacementChip,
	type PlacementInfo,
	PlacementProvider,
	UnplacedRow,
} from "./ThreadFate";
import {
	endMoveMode,
	getMoving,
	MoveBar,
	MoveWritesProvider,
	movedTip,
	useAgentMove,
	useMoveWritesHost,
} from "./threadMove";
import { githubRows } from "./threadRows";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * Thread moves on the page (CAR-139): the handle only where a move can
 * go, move mode (its bar, Escape and ✕ writing nothing), the `moved`
 * chip's tooltip, Undo's optimistic update and its rollback, the Threads
 * tab's cue; text from GitHub stays text.
 */

const HOSTILE = '<img src=x onerror="window.pwned=1">';
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

const thread = (extra: Partial<ReviewThread> = {}): ReviewThread => ({
	id: "T1",
	path: "src/a.ts",
	line: 3,
	currentLine: 88,
	loaded: true,
	excerpt: `Look here ${HOSTILE}`,
	html: "",
	body: "",
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
		path: "src/a.ts",
		commit: H1,
		side: "RIGHT",
		line: 3,
		startSide: "RIGHT",
		startLine: 3,
		at: "2026-01-01T00:00:00Z",
	},
	commit: H1,
	subject: "line",
	attention: [],
	yourTurn: false,
	viewerCan: { reply: false, resolve: false, unresolve: false },
	...extra,
});

const unplaced: ThreadPlacement = {
	kind: "unplaced",
	fate: "deleted",
	path: "src/a.ts",
	nearest: null,
};
const MOVE_ID = "01jmove0000000000000000001";
const moved = (over: Partial<MovedInfo> = {}): MovedInfo => ({
	id: MOVE_ID,
	on: { patchset: 2 },
	at: "2026-01-02T00:00:00Z",
	here: true,
	path: "src/a.ts",
	...over,
});

const info = (over: Partial<PlacementInfo> = {}): PlacementInfo => ({
	placements: new Map([["T1", unplaced]]),
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

/** The page's providers, with the writes hook live (FilesPage's own). */
function Page(props: {
	value: PlacementInfo;
	children: ReactNode;
	agent?: Parameters<typeof AgentPlacingProvider>[0]["value"];
}) {
	const writes = useMoveWritesHost({
		readId: props.value.readId,
		to: props.value.moveTo,
	});
	return (
		<PlacementProvider value={props.value}>
			<AgentPlacingProvider
				value={props.agent ?? { placements: null, until: null }}
			>
				<MoveWritesProvider value={writes}>{props.children}</MoveWritesProvider>
			</AgentPlacingProvider>
		</PlacementProvider>
	);
}

let client: QueryClient;
function show(value: PlacementInfo, ui: ReactNode, agent?: never) {
	return render(
		<QueryClientProvider client={client}>
			{inRouter(() => (
				<Page value={value} agent={agent}>
					{ui}
				</Page>
			))}
		</QueryClientProvider>,
	);
}

const row = (t = thread()) => (
	<UnplacedRow thread={t} readId="r1" fate="deleted" dropPath="src/a.ts" />
);

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
	cleanup();
	endMoveMode();
	vi.unstubAllGlobals();
});

describe("the handle", () => {
	it("shows on a traced review thread where moves go: 40px, named, with its tooltip", async () => {
		show(info(), row());
		const handle = await screen.findByTestId("move-handle");
		expect(handle.getAttribute("aria-label")).toBe("Move thread");
		expect(handle.className).toContain("h-10");
		expect(handle.className).toContain("w-10");
	});

	it.each([
		[
			"moves are off here (an earlier patch set, the since view)",
			info({ moveTo: null }),
		],
		["the placements aren't in yet", info({ placements: null, pending: true })],
		["the thread was opened on the viewed head", info({ viewedHead: H1 })],
	])("none when %s", async (_, value) => {
		show(value, row());
		await screen.findByTestId("unplaced-thread");
		expect(screen.queryByTestId("move-handle")).toBeNull();
	});

	it("none on a file thread", async () => {
		show(info(), row(thread({ anchor: null, subject: "file" })));
		await screen.findByTestId("unplaced-thread");
		expect(screen.queryByTestId("move-handle")).toBeNull();
	});

	it("a thread opened on the viewed head that was moved elsewhere keeps its handle", async () => {
		show(
			info({
				viewedHead: H1,
				moves: new Map([["T1", moved({ here: false })]]),
			}),
			row(),
		);
		expect(await screen.findByTestId("move-handle")).toBeTruthy();
	});

	it("an agent thread on lines gets the same handle; one on a file none", async () => {
		const agentThread = (subject: "line" | "file"): SpanAgentThread =>
			({
				id: "01jagent000000000000000001",
				anchor:
					subject === "line"
						? {
								subject,
								path: "src/a.ts",
								commit: H1,
								side: "RIGHT",
								line: 3,
								startSide: "RIGHT",
								startLine: 3,
							}
						: { subject, path: "src/a.ts", commit: H1 },
				openedBy: "human",
				at: "2026-01-01T00:00:00Z",
				messages: [
					{ id: "m1", by: "human", at: "2026-01-01T00:00:00Z", text: HOSTILE },
				],
				resolved: false,
				waiting: false,
				unread: false,
			}) as SpanAgentThread;
		function Probe({ t }: { t: SpanAgentThread }) {
			const move = useAgentMove(t, "src/a.ts");
			return <div data-testid="probe">{move.handle}</div>;
		}
		const placing = {
			placements: new Map([["01jagent000000000000000001", unplaced]]),
			until: null,
		};
		show(info(), <Probe t={agentThread("line")} />, placing as never);
		expect(await screen.findByTestId("move-handle")).toBeTruthy();
		cleanup();
		show(info(), <Probe t={agentThread("file")} />, placing as never);
		await screen.findByTestId("probe");
		expect(screen.queryByTestId("move-handle")).toBeNull();
	});
});

describe("move mode", () => {
	it("a press opens it: the bar shows the thread's first words as text; ✕ leaves with nothing written", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const user = userEvent.setup();
		show(
			info(),
			<>
				<MoveBar />
				{row()}
			</>,
		);
		await user.click(await screen.findByTestId("move-handle"));
		const bar = screen.getByTestId("move-bar");
		expect(bar.textContent).toContain("Pick a line");
		expect(screen.getByTestId("move-bar-words").textContent).toBe(
			`Look here ${HOSTILE}`,
		);
		expect(bar.querySelector("img")).toBeNull();
		expect(getMoving()?.thread).toEqual({ source: "github", id: "T1" });
		const cancel = screen.getByRole("button", { name: "Cancel move" });
		expect(cancel.className).toContain("h-10");
		await user.click(cancel);
		expect(screen.queryByTestId("move-bar")).toBeNull();
		expect(getMoving()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("Enter on the handle opens it; Escape leaves with nothing written", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const user = userEvent.setup();
		show(
			info(),
			<>
				<MoveBar />
				{row()}
			</>,
		);
		(await screen.findByTestId("move-handle")).focus();
		await user.keyboard("{Enter}");
		expect(screen.getByTestId("move-bar")).toBeTruthy();
		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("move-bar")).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("the moved chip", () => {
	it("says where the move was made, and GitHub's own line or outdated", () => {
		expect(movedTip(moved())).toBe("Moved here by you on PS2");
		expect(movedTip(moved({ here: false }))).toBe(
			"Moved by you on PS2, followed here",
		);
		expect(movedTip(moved({ on: { head: H2 } }))).toBe(
			"Moved here by you on bbbbbbb",
		);
		expect(movedTip(moved(), { line: 88, outdated: false })).toBe(
			"Moved here by you on PS2 · GitHub: line 88",
		);
		expect(movedTip(moved(), { line: null, outdated: true })).toBe(
			"Moved here by you on PS2 · GitHub: outdated",
		);
	});

	it("shows on a moved thread with a 40px named Undo where writes go; on the Overview (no writes), the chip alone", async () => {
		const value = info({ moves: new Map([["T1", moved()]]) });
		show(value, <PlacementChip thread={thread()} />);
		expect((await screen.findByTestId("moved-chip")).textContent).toContain(
			"moved",
		);
		const undo = screen.getByRole("button", { name: "Undo move" });
		expect(undo.className).toContain("h-10");
		expect(undo.className).toContain("w-10");
		cleanup();
		show({ ...value, moveTo: null }, <PlacementChip thread={thread()} />);
		await screen.findByTestId("moved-chip");
		expect(screen.queryByRole("button", { name: "Undo move" })).toBeNull();
	});

	it("none on a thread not moved, and none while the placements load", async () => {
		show(info(), <PlacementChip thread={thread()} />);
		expect(screen.queryByTestId("moved-chip")).toBeNull();
		cleanup();
		show(
			info({ placements: null, moves: null, pending: true }),
			<PlacementChip thread={thread()} />,
		);
		expect(await screen.findByTestId("placement-slot")).toBeTruthy();
		expect(screen.queryByTestId("moved-chip")).toBeNull();
	});
});

describe("an unplaced moved thread", () => {
	it("shows its chip and Undo, and the lines it was moved to as its Original Reviewed Change, as text", async () => {
		const old = {
			side: "RIGHT" as const,
			startLine: 7,
			line: 7,
			text: [HOSTILE],
		};
		show(
			info({
				placements: new Map([["T1", { ...unplaced, old }]]),
				moves: new Map([["T1", moved({ here: false, path: "src/b.ts" })]]),
			}),
			row(),
		);
		const r = await screen.findByTestId("unplaced-thread");
		expect(r.querySelector('[data-testid="moved-chip"]')).toBeTruthy();
		expect(screen.getByRole("button", { name: "Undo move" })).toBeTruthy();
		expect(screen.getByTestId("original-code-label").textContent).toBe(
			"PS2 · src/b.ts · line 7",
		);
		expect(r.textContent).toContain(HOSTILE);
		expect(r.querySelector("img")).toBeNull();
	});
});

describe("Undo", () => {
	const answer = (m?: MovedInfo): PlacementsAnswer => ({
		readId: "r1",
		revision: "rev",
		patchset: 2,
		threads: [
			{
				id: "T1",
				placement: {
					kind: "placed",
					anchor: {
						path: "src/a.ts",
						startSide: "RIGHT",
						startLine: 9,
						side: "RIGHT",
						line: 9,
					},
					changed: false,
				},
				...(m ? { moved: m } : {}),
			},
		],
	});

	/** Reads the placements query the way FilesPage does: its moves to the provider. */
	function Live() {
		const data = client.getQueryData(
			placementsQuery("r1", { patchset: 2 }).queryKey,
		) as PlacementsAnswer | undefined;
		const moves = new Map(
			(data?.threads ?? []).flatMap((t) => (t.moved ? [[t.id, t.moved]] : [])),
		);
		return (
			<Page
				value={info({
					moves,
					placements: new Map(
						(data?.threads ?? []).map((t) => [t.id, t.placement]),
					),
				})}
			>
				<PlacementChip thread={thread()} />
			</Page>
		);
	}

	it("a refused undo (409) rolls back and says so under the card; nothing to retry", async () => {
		const { queryKey } = placementsQuery("r1", { patchset: 2 });
		client.setQueryData(queryKey, answer(moved()));
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "No live move" }), {
					status: 409,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const user = userEvent.setup();
		const view = render(
			<QueryClientProvider client={client}>
				{inRouter(() => (
					<Live />
				))}
			</QueryClientProvider>,
		);
		await user.click(await screen.findByRole("button", { name: "Undo move" }));
		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain(`/moves/${MOVE_ID}`);
		expect(init.method).toBe("DELETE");
		// Still moved: the server said no.
		view.rerender(
			<QueryClientProvider client={client}>
				{inRouter(() => (
					<Live />
				))}
			</QueryClientProvider>,
		);
		const data = client.getQueryData(queryKey) as PlacementsAnswer;
		expect(data.threads[0]?.moved?.id).toBe(MOVE_ID);
	});

	it("a move then its Undo: the placement is moved at once, then back at once, before any answer", async () => {
		const { queryKey } = placementsQuery("r1", { patchset: 2 });
		client.setQueryData(queryKey, answer());
		let resolveMove: (r: Response) => void = () => {};
		const fetch = vi.fn(
			(url: string) =>
				new Promise<Response>((resolve) => {
					if (url.endsWith("/moves")) resolveMove = resolve;
					else
						resolve(
							new Response(
								JSON.stringify({
									undone: MOVE_ID,
									thread: { source: "github", id: "T1" },
								}),
								{
									status: 200,
									headers: { "content-type": "application/json" },
								},
							),
						);
				}),
		);
		vi.stubGlobal("fetch", fetch);
		let writes: ReturnType<typeof useMoveWritesHost> | null = null;
		function Grab() {
			writes = useMoveWritesHost({ readId: "r1", to: { patchset: 2 } });
			return null;
		}
		render(
			<QueryClientProvider client={client}>
				<Grab />
			</QueryClientProvider>,
		);
		const to3 = {
			path: "src/a.ts",
			startSide: "RIGHT" as const,
			startLine: 3,
			side: "RIGHT" as const,
			line: 3,
		};
		act(() => writes?.move({ source: "github", id: "T1" }, to3));
		const during = client.getQueryData(queryKey) as PlacementsAnswer;
		expect(during.threads[0]?.placement).toMatchObject({ anchor: { line: 3 } });
		expect(during.threads[0]?.moved?.here).toBe(true);
		const body = JSON.parse(
			String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
		);
		// The client names the target; the snapshot is the server's.
		expect(body).toEqual({
			thread: { source: "github", id: "T1" },
			to: { patchset: 2 },
			anchor: to3,
		});
		await act(async () => {
			resolveMove(
				new Response(
					JSON.stringify({
						move: MOVE_ID,
						thread: { source: "github", id: "T1" },
						placement: { kind: "placed", anchor: to3, changed: false },
						moved: moved(),
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			);
		});
		await waitFor(() =>
			expect(
				(client.getQueryData(queryKey) as PlacementsAnswer).threads[0]?.moved
					?.id,
			).toBe(MOVE_ID),
		);
		act(() => writes?.undo({ source: "github", id: "T1" }, MOVE_ID));
		const undone = client.getQueryData(queryKey) as PlacementsAnswer;
		expect(undone.threads[0]?.moved).toBeUndefined();
		expect(undone.threads[0]?.placement).toMatchObject({ anchor: { line: 9 } });
	});
});

describe("the Threads tab", () => {
	it("a moved thread's row carries the moved cue; others don't", () => {
		const rows = githubRows([thread(), thread({ id: "T2" })], new Map(), {
			moved: new Map([["T1", moved()]]),
		});
		expect(rows.find((r) => r.id === "T1")?.moved).toBe(true);
		expect(rows.find((r) => r.id === "T2")?.moved).toBeUndefined();
	});
});
