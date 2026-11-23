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
import type { CodeSpan } from "../files/selectionActions";
import { ShortcutsProvider } from "../shortcuts";
import { type LineTexts, spanTexts } from "./draftMove";
import { draftsFor } from "./drafts";
import { resetComposers } from "./newThreads";

vi.mock("../files/highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * CAR-254: an unsent comment draft on a line the since view shows
 * removed. That view numbers its old side in the compared patch set;
 * a draft keeps GitHub's line (the base's, CAR-217's `baseNo`), shows on
 * the removed row that is that line, and an orphan draft from an earlier
 * head moves along only when the lines at its base line read the same,
 * read on that row (never at the since view's own number).
 */

const OLD_HEAD = "c".repeat(40);
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
 * had (no baseNo). Its old 3 ("two") is another line than base 3.
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

const leftSpan = (n: number, commit = HEAD): CodeSpan => ({
	path: PATH,
	commit,
	subject: "line",
	startSide: "LEFT",
	startLine: n,
	side: "LEFT",
	line: n,
	startCol: null,
	endCol: null,
});

/** What the since view's row old 5 (base 3) reads: its line and context. */
const ROW5 = spanTexts(SINCE.hunks, leftSpan(5) as never) as LineTexts;

let client: QueryClient;

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
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	draftsFor(client).bind("k");
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
						headSure
					/>
				</section>
				<SelectionBar files={[file]} commit={HEAD} earlier={PS1} />
			</ShortcutsProvider>
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

const row = (oldNo: number) =>
	document.querySelector(`tr[data-old-no="${oldNo}"]`) as HTMLElement;

/** `el` comes after row old 5 and before the next row. */
function underRow5(el: Element) {
	expect(row(5).compareDocumentPosition(el)).toBe(
		Node.DOCUMENT_POSITION_FOLLOWING,
	);
	const next = document.querySelector('tr[data-new-no="3"]') as HTMLElement;
	expect(next.compareDocumentPosition(el)).toBe(
		Node.DOCUMENT_POSITION_PRECEDING,
	);
}

beforeEach(() => {
	window.scrollTo = vi.fn();
	resetComposers();
	setPicks(null);
});
afterEach(() => {
	cleanup();
	resetComposers();
	setPicks(null);
	contextRanges.reset();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("a draft on a since view's removed line (CAR-254)", () => {
	it("is stored on the base line (3), never the compared patch set's number (5), with that row's text; it shows under that row, named as this view numbers it", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(
			row(5).querySelector('button[data-pick="LEFT:5"]') as HTMLElement,
		);
		const bar = within(await screen.findByTestId("selection-bar"));
		await user.click(bar.getByRole("button", { name: "Comment" }));
		const composer = await screen.findByTestId("new-thread");
		expect(composer).toHaveTextContent("line 5, old");
		await user.type(
			within(composer).getByRole("textbox", { name: "Comment" }),
			"why?",
		);
		const [draft] = draftsFor(client)
			.get()
			.filter((d) => d.create);
		expect(draft?.create).toMatchObject({
			commit: HEAD,
			startSide: "LEFT",
			startLine: 3,
			side: "LEFT",
			line: 3,
		});
		expect(draft?.create?.texts).toEqual(ROW5);
		underRow5(composer);
	});

	it("an orphan from an earlier head on base line 3 moves to this head when row old 5 reads the same; it keeps line 3 and shows under that row", async () => {
		setup();
		await screen.findAllByTestId("diff-line");
		act(() =>
			draftsFor(client).setNew(
				"moved",
				leftSpan(3, OLD_HEAD) as never,
				"still true",
				ROW5,
			),
		);
		const box = await screen.findByRole("textbox", { name: "Comment" });
		expect(box).toHaveValue("still true");
		expect(draftsFor(client).newThread("moved")?.create).toMatchObject({
			commit: HEAD,
			startLine: 3,
			line: 3,
		});
		expect(screen.queryByTestId("orphan-draft")).toBeNull();
		underRow5(screen.getByTestId("new-thread"));
	});

	it("is never read at the since view's own number: one written on what row old 3 reads stays an orphan", async () => {
		setup();
		await screen.findAllByTestId("diff-line");
		act(() =>
			draftsFor(client).setNew(
				"other",
				leftSpan(3, OLD_HEAD) as never,
				"about two",
				spanTexts(SINCE.hunks, leftSpan(3) as never) as LineTexts,
			),
		);
		expect(await screen.findByTestId("orphan-draft")).toHaveTextContent(
			"about two",
		);
		expect(draftsFor(client).newThread("other")?.create?.commit).toBe(OLD_HEAD);
	});

	it("an orphan on a base line no row of the since view shows stays an orphan (fails closed)", async () => {
		setup();
		await screen.findAllByTestId("diff-line");
		act(() =>
			draftsFor(client).setNew(
				"away",
				leftSpan(2, OLD_HEAD) as never,
				"elsewhere",
				ROW5,
			),
		);
		expect(await screen.findByTestId("orphan-draft")).toHaveTextContent(
			"elsewhere",
		);
		expect(draftsFor(client).newThread("away")?.create?.commit).toBe(OLD_HEAD);
	});
});
