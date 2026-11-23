// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DiffLine,
	FileHunks,
	FileView,
	PrOverview,
	SessionInfo,
} from "../../shared/types";
import { contextRanges } from "../files/contextRanges";
import { DiffBody } from "../files/DiffBody";
import { setPicks } from "../files/linePicks";
import { SelectionBar } from "../files/SelectionBar";
import {
	EARLIER_ONLY,
	registerSelectionAction,
} from "../files/selectionActions";
import { ShortcutsProvider } from "../shortcuts";
import {
	ASK_AGENT_ACTION,
	anchorOf,
	getAgentComposers,
	openAgentComposer,
	resetAgentComposers,
} from "./askAgentAction";

vi.mock("../files/highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * CAR-252: Ask agent on a line the since view shows removed. That view
 * numbers its old side in the compared patch set; the agent's LEFT anchor
 * is the base's line (CAR-217's `baseNo`), so the agent reads that line
 * and the full diff shows the conversation on it. A line only the
 * compared patch set had (no base number) can't take a question.
 */

const PS1 = "a".repeat(40);
const HEAD = "b".repeat(40);
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
 * The since view (PS1 → head), PS1 numbering its old side two lines on
 * from the base: its old 5 is base line 3 (baseNo), its old 2 only PS1
 * had (no baseNo).
 */
const SINCE: FileHunks = {
	newLineCount: 4,
	hunks: [
		{
			oldStart: 1,
			oldCount: 5,
			newStart: 1,
			newCount: 4,
			lines: [
				line("context", 1, 1, "one"),
				line("del", 2, undefined, "branch's own", {
					clusterKey: "k1",
					baseNo: null,
				}),
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

function setup() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname === "/api/files/0/hunks") {
				return new Response(JSON.stringify(SINCE));
			}
			return new Response("{}", { status: 404 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(["overview"], {
		readId: "r",
		writes: "on",
		commentLeft: true,
		pendingReview: null,
	} as unknown as PrOverview);
	client.setQueryData(["session"], {
		snapshotHead: HEAD,
		viewer: "me",
		pr: { owner: "o", repo: "r", number: 1 },
		patchsets: [{ number: 1, head: PS1 }],
	} as unknown as SessionInfo);
	render(
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<section data-path={PATH}>
					<DiffBody
						file={file}
						revision="r1"
						onToggle={() => {}}
						onCrossOff={() => {}}
						from={1}
						kinds={new Map()}
						threads={{ readId: "r", snapshotHead: HEAD, threads: [] }}
					/>
				</section>
				<SelectionBar files={[file]} commit={HEAD} earlier={PS1} />
			</ShortcutsProvider>
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

const pickButton = (oldNo: number) =>
	document.querySelector(
		`tr[data-old-no="${oldNo}"] button[data-pick="LEFT:${oldNo}"]`,
	) as HTMLElement;

let removeAction: () => void = () => {};
beforeEach(() => {
	window.scrollTo = vi.fn();
	removeAction = registerSelectionAction(ASK_AGENT_ACTION);
	setPicks(null);
});
afterEach(() => {
	removeAction();
	cleanup();
	resetAgentComposers();
	setPicks(null);
	contextRanges.reset();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("Ask agent on a since view's removed line (CAR-252)", () => {
	it("asks on the base line (3), never the compared patch set's number (5); the composer opens under that row, named as this view numbers it", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(pickButton(5));
		const bar = within(await screen.findByTestId("selection-bar"));
		const ask = bar.getByRole("button", { name: "Ask agent" });
		expect(ask).not.toHaveAttribute("aria-disabled");
		await user.click(ask);
		const [composer] = getAgentComposers();
		expect(composer?.span).toMatchObject({
			path: PATH,
			commit: HEAD,
			startSide: "LEFT",
			startLine: 3,
			side: "LEFT",
			line: 3,
		});
		// What is sent to the agent: the base's line.
		expect(anchorOf(composer?.span as never)).toMatchObject({
			side: "LEFT",
			line: 3,
			startSide: "LEFT",
			startLine: 3,
		});
		const box = await screen.findByTestId("agent-composer");
		expect(box).toHaveTextContent("line 5, old");
		// Under the removed row it was asked on.
		const row = document.querySelector('tr[data-old-no="5"]') as HTMLElement;
		expect(row.compareDocumentPosition(box)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it("a composer stored on base line 3 shows under the since view's row old 5, not the row numbered 3", async () => {
		setup();
		await screen.findAllByTestId("diff-line");
		act(() => {
			openAgentComposer(
				{
					path: PATH,
					commit: HEAD,
					subject: "line",
					startSide: "LEFT",
					startLine: 3,
					side: "LEFT",
					line: 3,
					startCol: null,
					endCol: null,
				},
				"q1",
				"why?",
			);
		});
		const box = await screen.findByTestId("agent-composer");
		expect(box).toHaveTextContent("line 5, old");
		const removed = document.querySelector(
			'tr[data-old-no="5"]',
		) as HTMLElement;
		const next = document.querySelector('tr[data-old-no="3"]') as HTMLElement;
		expect(removed.compareDocumentPosition(box)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		// Not after row old 3 and before old 5 (its own number's row).
		expect(next.compareDocumentPosition(box)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(box.compareDocumentPosition(removed)).toBe(
			Node.DOCUMENT_POSITION_PRECEDING,
		);
	});

	it("a line only the compared patch set had: Ask agent off, with why; nothing opens", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(pickButton(2));
		const bar = within(await screen.findByTestId("selection-bar"));
		const ask = bar.getByRole("button", { name: "Ask agent" });
		expect(ask).toHaveAttribute("aria-disabled", "true");
		expect(ask).toHaveAccessibleDescription(EARLIER_ONLY);
		await user.click(ask);
		expect(getAgentComposers()).toEqual([]);
	});
});
