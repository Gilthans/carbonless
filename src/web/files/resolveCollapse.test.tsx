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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../shared/types";
import { overlayThreads, useThreadWrites } from "../threads/threadWrites";
import { sideBySide } from "../viewSettings";
import { DiffBody } from "./DiffBody";
import { FileDiff } from "./FileDiff";
import {
	closeResolved,
	forBubble,
	hiddenIn,
	pinTarget,
	settleWatch,
} from "./resolveCollapse";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

const HEAD = "h".repeat(40);
const PATH = "src/a.ts";

const thread = (
	id: string,
	line: number,
	over: Partial<ReviewThread> = {},
): ReviewThread => ({
	id,
	loaded: true,
	path: PATH,
	line,
	currentLine: line,
	excerpt: "a comment",
	html: "<p>a comment</p>",
	body: "a comment",
	createdAt: "2026-01-01T00:00:00Z",
	lastActivityAt: "2026-01-01T00:00:00Z",
	author: `rev-${id}`,
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
	viewerCan: { reply: true, resolve: true, unresolve: true },
	...over,
});

describe("closeResolved", () => {
	const a = thread("A", 1);
	const b = thread("B", 1);
	it("hides the resolved one while others show; closes the bubble on the last", () => {
		const first = closeResolved(new Map(), "k", a, [a, b]);
		expect(first.closeBubble).toBe(false);
		expect([...first.hidden]).toEqual([["A", "k"]]);
		const shown = [b];
		const last = closeResolved(first.hidden, "k", b, shown);
		expect(last.closeBubble).toBe(true);
		// Opened again, the bubble shows all its threads.
		expect(last.hidden.size).toBe(0);
	});

	it("never hides a thread that isn't resolved", () => {
		const hidden = new Map([["A", "k"]]);
		expect(hiddenIn(hidden, a)).toBe(false);
		expect(hiddenIn(hidden, { ...a, resolved: true })).toBe(true);
	});

	it("forgets a toggled bubble's threads only", () => {
		const hidden = new Map([
			["A", "k"],
			["B", "j"],
		]);
		expect([...forBubble(hidden, "k")]).toEqual([["B", "j"]]);
		expect(forBubble(hidden, "x")).toBe(hidden);
	});
});

describe("settleWatch", () => {
	const view = (over: object) => ({
		threadId: "A",
		replies: [],
		edits: [],
		deletes: [],
		action: null,
		resumed: false,
		delayed: false,
		waiting: null,
		stalled: null,
		refused: [],
		...over,
	});
	it("reopens a refused resolve, keeps one on its way, drops one GitHub has", () => {
		const watch = new Map([
			["A", "a"],
			["B", "b"],
			["C", "c"],
		]);
		const threads = new Map([
			[
				"A",
				view({
					resolved: true,
					refused: [
						{
							key: "resolve",
							action: "Resolve",
							error: new Error("no"),
							resolved: true,
							at: "",
						},
					],
				}),
			],
			["B", view({ threadId: "B", resolved: true })],
		]);
		const settled = settleWatch(watch, { threads } as never);
		expect(settled.reopen).toEqual([{ id: "A", key: "a" }]);
		expect([...settled.watch]).toEqual([["B", "b"]]);
	});

	it("keeps watching a refused resolve that is being retried", () => {
		const watch = new Map([["A", "a"]]);
		const threads = new Map([
			[
				"A",
				view({
					resolved: true,
					refused: [
						{
							key: "resolve",
							action: "Resolve",
							error: new Error("no"),
							resolved: true,
							at: "",
							retrying: true,
						},
					],
				}),
			],
		]);
		const settled = settleWatch(watch, { threads } as never);
		expect(settled.reopen).toEqual([]);
		expect(settled.watch).toBe(watch);
	});
});

describe("pinTarget", () => {
	it("keeps a bubble in view where it was", () => {
		expect(pinTarget({ top: 300, press: 600, closed: true }, 100)).toBe(300);
	});
	it("brings a bubble above the view to where Resolve was pressed, once closed", () => {
		expect(pinTarget({ top: -400, press: 600, closed: true }, 100)).toBe(600);
		expect(pinTarget({ top: -400, press: 20, closed: true }, 100)).toBe(100);
		// Still open for its other threads: left as it is.
		expect(pinTarget({ top: -400, press: 600, closed: false }, 100)).toBe(-400);
	});
});

const ctx = (oldNo: number, newNo: number): DiffLine => ({
	kind: "context",
	oldNo,
	newNo,
	text: `line ${newNo}`,
});

const hunks: FileHunks = {
	newLineCount: 6,
	hunks: [
		{
			oldStart: 1,
			oldCount: 5,
			newStart: 1,
			newCount: 6,
			lines: [
				ctx(1, 1),
				ctx(2, 2),
				{ kind: "add", newNo: 3, text: "added", clusterKey: "c" },
				ctx(3, 4),
				ctx(4, 5),
				ctx(5, 6),
			],
		},
	],
};

const file: FileView = {
	index: 0,
	path: PATH,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 0,
	clusters: [
		{
			key: "c",
			kind: "lines",
			oldStart: 3,
			oldCount: 0,
			newStart: 3,
			newCount: 1,
			removed: [],
			added: [],
			lines: 1,
			state: "unreviewed",
		} as ClusterView,
	],
	done: false,
	reviewed: false,
	crossedOff: false,
};

/** The threads as FilesPage gives them: a resolve on its way shows at once. */
function Overlaid(props: { threads: ReviewThread[]; whole?: boolean }) {
	const writes = useThreadWrites();
	const threads = {
		readId: "r",
		snapshotHead: HEAD,
		threads: overlayThreads(props.threads, writes),
	};
	if (props.whole) {
		return (
			<FileDiff
				file={file}
				revision="r1"
				unit="clusters"
				expanded
				threads={threads}
				headSure
			/>
		);
	}
	return (
		<DiffBody
			file={file}
			revision="r1"
			onToggle={() => {}}
			onCrossOff={() => {}}
			threads={{
				readId: "r",
				snapshotHead: HEAD,
				threads: overlayThreads(props.threads, writes),
			}}
		/>
	);
}

let resolveAnswer: () => Promise<Response>;
let resolveCalls: unknown[];

function setup(threads: ReviewThread[], whole = false) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname.endsWith("/resolved")) {
				resolveCalls.push(JSON.parse(String(init?.body)));
				return resolveAnswer();
			}
			const body =
				url.pathname === "/api/files/0/hunks"
					? hunks
					: url.pathname === "/api/comments"
						? { threads: [] }
						: {};
			return new Response(JSON.stringify(body), { status: 200 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(["overview"], {
		readId: "r",
		writes: "on",
		pendingReview: null,
	} as unknown as PrOverview);
	client.setQueryData(["session"], {
		viewer: "octo",
		snapshotHead: HEAD,
	} as SessionInfo);
	render(
		<QueryClientProvider client={client}>
			<Overlaid threads={threads} whole={whole} />
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

const bubbleOn = (line: number) => {
	const row = document.querySelector<HTMLElement>(
		`[data-testid="diff-line"][data-new-no="${line}"]`,
	) as HTMLElement;
	// Side by side, a context line's bubble is in both cells: the right one.
	const all = within(row).getAllByTestId("thread-bubble");
	return all[all.length - 1] as HTMLElement;
};
const opened = () =>
	screen
		.queryAllByTestId("files-thread")
		.map((t) => t.getAttribute("aria-label"));

describe.each([
	["unified", false],
	["side by side", true],
])("Resolve in Files changed (%s)", (_, sbs) => {
	beforeEach(() => {
		sideBySide.set(sbs);
		window.scrollTo = vi.fn();
		window.scrollBy = vi.fn();
		resolveCalls = [];
		// On its way until the test says.
		resolveAnswer = () => new Promise(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		localStorage.clear();
		sideBySide.reset();
	});

	it("closes the resolved thread only, then the bubble on the last; opened again, both show resolved", async () => {
		const user = setup([thread("A", 4), thread("B", 4)]);
		await screen.findByText("added");
		await user.click(bubbleOn(4));
		expect(opened()).toEqual([
			"Unresolved thread by rev-A",
			"Unresolved thread by rev-B",
		]);
		const [first] = screen.getAllByRole("button", { name: "Resolve" });
		await user.click(first as HTMLElement);
		expect(resolveCalls).toEqual([{ resolved: true }]);
		// The other stays open; focus is on the bubble.
		expect(opened()).toEqual(["Unresolved thread by rev-B"]);
		await waitFor(() => expect(bubbleOn(4)).toHaveFocus());
		await user.click(screen.getByRole("button", { name: "Resolve" }));
		expect(screen.queryByTestId("thread-row")).toBeNull();
		const bubble = bubbleOn(4);
		expect(bubble).toHaveAttribute("aria-expanded", "false");
		expect(bubble).toHaveAccessibleName("2 comments on line 4, resolved");
		await waitFor(() => expect(bubble).toHaveFocus());
		await user.click(bubble);
		expect(opened()).toEqual([
			"Resolved thread by rev-A",
			"Resolved thread by rev-B",
		]);
	});

	it("leaves a thread open on Unresolve", async () => {
		const user = setup([thread("A", 4, { resolved: true })]);
		await screen.findByText("added");
		await user.click(bubbleOn(4));
		await user.click(screen.getByRole("button", { name: "Unresolve" }));
		expect(resolveCalls).toEqual([{ resolved: false }]);
		expect(opened()).toEqual(["Unresolved thread by rev-A"]);
	});

	it("opens the thread again when GitHub refuses the resolve", async () => {
		let refuse: () => void = () => {};
		resolveAnswer = () =>
			new Promise((done) => {
				refuse = () =>
					done(
						new Response(JSON.stringify({ error: "Not allowed" }), {
							status: 403,
						}),
					);
			});
		const user = setup([thread("A", 4)]);
		await screen.findByText("added");
		await user.click(bubbleOn(4));
		await user.click(screen.getByRole("button", { name: "Resolve" }));
		expect(screen.queryByTestId("thread-row")).toBeNull();
		await waitFor(() => expect(resolveCalls).toHaveLength(1));
		refuse();
		// Open again, as the reviewer intended it (the notice lists why).
		await waitFor(() => expect(opened()).toEqual(["Resolved thread by rev-A"]));
		expect(bubbleOn(4)).toHaveAttribute("aria-expanded", "true");
	});

	it("keeps a thread open when its reply box holds a draft", async () => {
		const user = setup([thread("A", 4)]);
		await screen.findByText("added");
		await user.click(bubbleOn(4));
		await user.type(screen.getByRole("textbox", { name: "Reply" }), "wip");
		await user.click(screen.getByRole("button", { name: "Resolve" }));
		expect(resolveCalls).toEqual([{ resolved: true }]);
		expect(opened()).toEqual(["Resolved thread by rev-A"]);
		expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("wip");
	});
});

describe("Resolve on a file comment", () => {
	beforeEach(() => {
		window.scrollTo = vi.fn();
		window.scrollBy = vi.fn();
		resolveCalls = [];
		resolveAnswer = () => new Promise(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it("closes the file bubble's thread to it, focused", async () => {
		const fileThread = thread("F", 0, {
			subject: "file",
			line: null,
			currentLine: null,
			anchor: null,
		} as unknown as Partial<ReviewThread>);
		const user = setup([fileThread], true);
		await screen.findByText("added");
		const bubble = screen.getByRole("button", { name: /on this file/ });
		await user.click(bubble);
		expect(opened()).toEqual(["Unresolved thread by rev-F"]);
		await user.click(screen.getByRole("button", { name: "Resolve" }));
		expect(resolveCalls).toEqual([{ resolved: true }]);
		expect(opened()).toEqual([]);
		expect(bubble).toHaveAccessibleName(/resolved/);
		await waitFor(() => expect(bubble).toHaveFocus());
		await user.click(bubble);
		expect(opened()).toEqual(["Resolved thread by rev-F"]);
	});
});
