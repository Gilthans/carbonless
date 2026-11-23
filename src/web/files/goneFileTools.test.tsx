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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import type {
	DiffLine,
	FileHunks,
	PrOverview,
	ReviewThread,
	SessionInfo,
} from "../../shared/types";
import {
	ASK_AGENT_ACTION,
	getAgentComposers,
	resetAgentComposers,
} from "../agent/askAgentAction";
import { ShortcutsProvider } from "../shortcuts";
import { draftsFor } from "../threads/drafts";
import { getComposers, resetComposers } from "../threads/newThreads";
import { CODE_CELL, cellLine, inHunk } from "./codeSpan";
import { contextRanges } from "./contextRanges";
import type { DiffThreads } from "./DiffBody";
import { GoneFile } from "./FileDiff";
import { setPicks } from "./linePicks";
import { SelectionBar } from "./SelectionBar";
import { registerSelectionAction } from "./selectionActions";
import {
	endMoveMode,
	lineAt,
	type MoveWrites,
	MoveWritesProvider,
	NOT_IN_FULL_DIFF,
	startMoveMode,
} from "./threadMove";
import { earlierPending, type Placements } from "./threadPlacement";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * CAR-256: a since-view file the full diff doesn't have (GoneFile) gets the
 * tools any file's rows get: a selection's actions, composers, thread
 * bubbles; where GitHub has no line for a row, the action is off with why.
 */

const HEAD = "h".repeat(40);
const PS1 = "1".repeat(40);
const PATH = "src/undone.ts";
const INDEX = 3;

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

/**
 * The file back to the base's version since PS1 (the head has it, the
 * full diff doesn't): PS1's own line 2 removed (its line 2 on PS1's
 * commit), the base's line 2 back (the head's line 2).
 */
const HUNKS: FileHunks = {
	newLineCount: 3,
	hunks: [
		{
			oldStart: 1,
			oldCount: 3,
			newStart: 1,
			newCount: 3,
			lines: [
				line("context", 1, 1, "one"),
				line("del", 2, undefined, "ps1 own", {
					clusterKey: "g1",
					baseNo: null,
					psNo: 2,
				}),
				line("add", undefined, 2, "base two", { clusterKey: "g1" }),
				line("context", 3, 3, "three"),
			],
		},
	],
	pieces: [
		{
			hunk: 0,
			line: 1,
			key: "g1",
			owns: null,
			old: [[2, 3]],
			new: [[2, 3]],
			kind: "reverted",
		},
	],
};

const overview = () =>
	({
		readId: "r",
		writes: "on",
		commentLeft: true,
		pendingReview: null,
	}) as unknown as PrOverview;

/** A thread made on PS1's head on its line 2 (RIGHT), the removed row here. */
const ps1Thread = (): ReviewThread => ({
	id: "T1",
	loaded: true,
	path: PATH,
	line: 2,
	currentLine: null,
	excerpt: "why this line?",
	html: "<p>why this line?</p>",
	body: "why this line?",
	createdAt: "2026-01-01T00:00:00Z",
	lastActivityAt: "2026-01-01T00:00:00Z",
	author: "rev",
	avatarUrl: "",
	participants: [],
	lastAuthor: { login: "rev", avatarUrl: "", bot: false },
	bot: false,
	commentCount: 1,
	hasReply: false,
	outdated: true,
	resolved: false,
	code: null,
	anchor: {
		path: PATH,
		commit: PS1,
		side: "RIGHT",
		line: 2,
		startSide: "RIGHT",
		startLine: 2,
		at: "2026-01-01T00:00:00Z",
	},
	commit: PS1,
	subject: "line",
	attention: [],
	yourTurn: false,
	viewerCan: { reply: true, resolve: true, unresolve: false },
});

/** The tracer's word on the thread: its file is out of the comparison. */
const OUTSIDE: ThreadPlacement = {
	kind: "outside",
	path: PATH,
	fate: "reverted",
};

function setup(threads: ReviewThread[] = [], placements?: Placements) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname === `/api/files/${INDEX}/hunks`) {
				return new Response(JSON.stringify(HUNKS));
			}
			return new Response("{}", { status: 404 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	draftsFor(client).bind("k");
	client.setQueryData(["overview"], overview());
	client.setQueryData(["session"], {
		snapshotHead: HEAD,
		viewer: "me",
		pr: { owner: "o", repo: "r", number: 1 },
		patchsets: [{ number: 1, head: PS1 }],
	} as unknown as SessionInfo);
	const placed = placements ?? new Map();
	const diffThreads: DiffThreads = {
		readId: "r",
		snapshotHead: HEAD,
		// The outside thread isn't among the shown threads (shownThreads).
		threads: [],
		placements: placed,
		earlierPending: earlierPending(threads, HEAD, placed, PS1),
	};
	const moves: MoveWrites = {
		to: { patchset: 2 },
		move: vi.fn(),
		undo: vi.fn(),
		failure: () => undefined,
		dismiss: vi.fn(),
		busy: () => false,
	};
	render(
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<MoveWritesProvider value={moves}>
					<GoneFile
						index={INDEX}
						path={PATH}
						revision="r2"
						since={1}
						pieces={HUNKS.pieces}
						expanded
						threads={diffThreads}
						headSure
					/>
					<SelectionBar
						files={[]}
						commit={HEAD}
						headSure
						earlier={PS1}
						gonePaths={new Set([PATH])}
					/>
				</MoveWritesProvider>
			</ShortcutsProvider>
		</QueryClientProvider>,
	);
	return { user: userEvent.setup(), moves };
}

/** The row numbered `n` on a side, and its code cell there. */
const row = (side: "LEFT" | "RIGHT", n: number) =>
	document.querySelector(
		`tr[data-${side === "LEFT" ? "old" : "new"}-no="${n}"]`,
	) as HTMLElement;
const cell = (side: "LEFT" | "RIGHT", n: number) =>
	row(side, n).querySelector(
		`[${CODE_CELL}][data-side="${side}"]`,
	) as HTMLElement;

/** Picks a row by a press on its number (as a reviewer does). */
function pickRow(side: "LEFT" | "RIGHT", n: number) {
	const number = row(side, n).querySelector(
		`[data-testid="${side === "LEFT" ? "old" : "new"}"]`,
	) as Element;
	fireEvent.pointerDown(number, {
		pointerType: "mouse",
		button: 0,
		buttons: 1,
	});
	fireEvent.pointerUp(window);
}

let removeAsk: () => void = () => {};
beforeEach(() => {
	window.scrollTo = vi.fn();
	resetComposers();
	resetAgentComposers();
	setPicks(null);
	removeAsk = registerSelectionAction(ASK_AGENT_ACTION);
});
afterEach(() => {
	removeAsk();
	endMoveMode();
	cleanup();
	vi.unstubAllGlobals();
	contextRanges.reset();
	localStorage.clear();
});

const loaded = () => screen.findAllByTestId("diff-line");

describe("a gone file's rows (CAR-256)", () => {
	it("say what GitHub has of them: none of the head's lines, PS1's own on its commit", async () => {
		setup();
		await loaded();
		const head = cellLine(cell("RIGHT", 2));
		expect(head).toMatchObject({ path: PATH, gone: true, line: 2 });
		expect(head && inHunk(head)).toBe(false);
		const context = cellLine(cell("RIGHT", 1));
		expect(context && inHunk(context)).toBe(false);
		const own = cellLine(cell("LEFT", 2));
		expect(own).toMatchObject({ gone: true, base: null, ps: 2 });
		expect(own && inHunk(own)).toBe(true);
	});

	it("a head line: Comment off with why (GitHub's diff hasn't it), Ask agent opens its composer in the file", async () => {
		const { user } = setup();
		await loaded();
		pickRow("RIGHT", 2);
		const bar = within(await screen.findByTestId("selection-bar"));
		const comment = bar.getByRole("button", { name: "Comment" });
		expect(comment).toHaveAttribute("aria-disabled", "true");
		expect(comment).toHaveAccessibleDescription(
			"GitHub only takes comments on lines in the diff",
		);
		await user.click(comment);
		expect(getComposers()).toEqual([]);
		const ask = bar.getByRole("button", { name: "Ask agent" });
		expect(ask).not.toHaveAttribute("aria-disabled");
		await user.click(ask);
		expect(getAgentComposers().map((c) => c.span)).toEqual([
			expect.objectContaining({
				path: PATH,
				commit: HEAD,
				side: "RIGHT",
				line: 2,
			}),
		]);
		const section = screen.getByRole("region", { name: PATH });
		expect(
			await within(section).findByRole("textbox", { name: /Ask/ }),
		).toBeInTheDocument();
		// Its Comment instead is off too, with why.
		const instead = within(section).getByTestId("agent-composer-comment");
		expect(instead).toHaveAttribute("aria-disabled", "true");
		expect(instead).toHaveAccessibleDescription(
			"GitHub only takes comments on lines in the diff",
		);
	});

	it("a line only PS1 had: Comment opens its composer in the file, on PS1's commit at its line there", async () => {
		const { user } = setup();
		await loaded();
		pickRow("LEFT", 2);
		const bar = within(await screen.findByTestId("selection-bar"));
		const comment = bar.getByRole("button", { name: "Comment" });
		expect(comment).not.toHaveAttribute("aria-disabled");
		await user.click(comment);
		expect(getComposers().map((c) => c.span)).toEqual([
			expect.objectContaining({
				path: PATH,
				commit: PS1,
				earlier: true,
				side: "RIGHT",
				line: 2,
			}),
		]);
		const section = screen.getByRole("region", { name: PATH });
		expect(await within(section).findByTestId("new-thread")).toBeVisible();
	});

	it("a thread made on PS1's head on that line, its file outside the comparison: its bubble on the removed row", async () => {
		const t = ps1Thread();
		const { user } = setup([t], new Map([[t.id, OUTSIDE]]));
		await loaded();
		expect(row("LEFT", 2)).toHaveAttribute("data-commented", "");
		const bubble = within(row("LEFT", 2)).getByRole("button", {
			name: /^1 comment/,
		});
		await user.click(bubble);
		expect(await screen.findAllByTestId("files-thread")).toHaveLength(1);
	});

	it("is no place for a thread: a drop finds no line, Place here is off with why", async () => {
		const t = ps1Thread();
		const { user, moves } = setup([t], new Map([[t.id, OUTSIDE]]));
		await loaded();
		const original = document.elementFromPoint;
		document.elementFromPoint = () => row("RIGHT", 2);
		try {
			expect(lineAt(0, 0, PATH)).toBeNull();
		} finally {
			document.elementFromPoint = original;
		}
		act(() =>
			startMoveMode({
				thread: { id: t.id, source: "github" },
				words: "why this line?",
			}),
		);
		pickRow("RIGHT", 2);
		const place = within(await screen.findByTestId("selection-bar")).getByRole(
			"button",
			{ name: "Place here" },
		);
		expect(place).toHaveAttribute("aria-disabled", "true");
		expect(place).toHaveAccessibleDescription(NOT_IN_FULL_DIFF);
		await user.click(place);
		expect(moves.move).not.toHaveBeenCalled();
	});
});
