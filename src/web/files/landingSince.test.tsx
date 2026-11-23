// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../test/in-router";
import type {
	DiffLine,
	FileHunks,
	FileView,
	SessionInfo,
} from "../../shared/types";
import { sessionQuery } from "../api";
import { contextRanges } from "./contextRanges";
import { DiffBody } from "./DiffBody";
import { type Landing, landingRow } from "./landing";
import { sinceLeft } from "./threadPlacement";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * A thread link's landing on an old line (`?side=LEFT&line=N`) in the
 * since view (CAR-253): N is a base line (GitHub's LEFT), while the since
 * view numbers its old side in the compared patch set. It lands where the
 * line's thread shows (threadPlacement.ts sinceLeft): the head line the
 * full diff keeps it as, else the removed row whose base line it is; with
 * neither, it says so and links to the full diff.
 */

const PATH = "src/a.ts";
/** PS1's head (the compared patch set's). */
const H1 = "a".repeat(40);

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
 * The full diff (base → head): base lines 1–2 kept, base lines 3–4
 * removed (cluster k1), new lines 3–4 added. The since view (PS1 → head),
 * PS1 numbering its old side two lines on from the base (the branch added
 * two lines at its top, gone since): its old 5 is base line 3 (baseNo),
 * its old 2 one of the branch's own lines (no baseNo; PS1's line 2,
 * psNo). Base line 4 was gone by PS1 already: no row of the since view is
 * it. The head's lines 5 to 20 are unchanged since PS1: no row either.
 */
const sinceHunks: FileHunks = {
	newLineCount: 20,
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
					psNo: 2,
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
	deletions: 2,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [
		{
			key: "k1",
			kind: "lines",
			oldStart: 3,
			oldCount: 2,
			newStart: 3,
			newCount: 2,
			removed: ["three", "four"],
			added: ["new three", "new four"],
			lines: 4,
			state: "unreviewed",
		},
	],
};

describe("landingRow: a link's line on the view's rows", () => {
	const left = sinceLeft(file.clusters, sinceHunks.hunks);

	it("a base line only the removed row shows: that row, by its own number", () => {
		expect(landingRow("LEFT", 3, left)).toEqual({ old: true, line: 5 });
	});

	it("a base line the full diff keeps: the head line it became (where its thread shows)", () => {
		expect(landingRow("LEFT", 2, left)).toEqual({ old: false, line: 2 });
		expect(landingRow("LEFT", 1, left)).toEqual({ old: false, line: 1 });
	});

	it("a base line no row of the view is: none", () => {
		expect(landingRow("LEFT", 4, left)).toBeNull();
	});

	it("a RIGHT line, and any line of the full diff, as given", () => {
		expect(landingRow("RIGHT", 3, left)).toEqual({ old: false, line: 3 });
		expect(landingRow("LEFT", 3, undefined)).toEqual({ old: true, line: 3 });
		expect(landingRow("RIGHT", 3, undefined)).toEqual({ old: false, line: 3 });
	});
});

function renderSince(landing: Landing) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
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
	client.setQueryData(sessionQuery.queryKey, {
		patchsets: [{ number: 1, head: H1 }],
	} as unknown as SessionInfo);
	render(
		<QueryClientProvider client={client}>
			{inRouter(() => (
				<section data-path={PATH}>
					<DiffBody
						file={file}
						revision="r2"
						onToggle={vi.fn()}
						onCrossOff={vi.fn()}
						from={1}
						kinds={new Map()}
						landing={landing}
					/>
				</section>
			))}
		</QueryClientProvider>,
	);
}

const landedRow = () =>
	document.querySelector<HTMLElement>(
		'tr[data-testid="diff-line"][data-landed]',
	);

beforeEach(() => {
	contextRanges.reset();
	vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("the since view lands a LEFT link on the base line's row", () => {
	const at = (
		n: number,
		side: "LEFT" | "RIGHT" = "LEFT",
		more: Partial<Landing> = {},
	): Landing => ({
		path: PATH,
		line: n,
		side,
		index: 0,
		seq: 1,
		...more,
	});

	it("on the removed row whose base line it is, not the row numbered N", async () => {
		renderSince(at(3));
		await screen.findByText("new four");
		const row = await vi.waitFor(() => landedRow() ?? Promise.reject());
		expect(row).toHaveAttribute("data-old-no", "5");
		expect(row).toHaveTextContent("three");
		expect(screen.queryByTestId("landing-hint")).toBeNull();
	});

	it("on the head line a kept base line became", async () => {
		renderSince(at(2));
		await screen.findByText("new four");
		const row = await vi.waitFor(() => landedRow() ?? Promise.reject());
		expect(row).toHaveAttribute("data-new-no", "2");
		expect(row).toHaveTextContent("two");
	});

	it("a RIGHT line as it is", async () => {
		renderSince(at(3, "RIGHT"));
		await screen.findByText("new four");
		const row = await vi.waitFor(() => landedRow() ?? Promise.reject());
		expect(row).toHaveAttribute("data-new-no", "3");
	});

	it("says a base line no row is isn't in this view, with the way to the full diff", async () => {
		renderSince(at(4));
		await screen.findByText("new four");
		const hint = await screen.findByTestId("landing-hint");
		expect(hint).toHaveTextContent("Old line 4 isn't in this view");
		// The status is the text alone; the link is beside it, not in it.
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Old line 4 isn't in this view");
		expect(status).not.toHaveTextContent("Full diff");
		expect(landedRow()).toBeNull();
		const link = screen.getByTestId("landing-full-diff");
		const href = new URL(link.getAttribute("href") ?? "", "http://test");
		expect(href.pathname).toBe("/r/01testreview0000000000000a/files");
		expect(Object.fromEntries(href.searchParams)).toMatchObject({
			path: PATH,
			line: "4",
			side: "LEFT",
			from: "branch",
		});
	});

	it("says a RIGHT line no row is (unchanged since) isn't in this view, with the way to the full diff", async () => {
		renderSince(at(10, "RIGHT"));
		await screen.findByText("new four");
		const hint = await screen.findByTestId("landing-hint");
		expect(hint).toHaveTextContent("Line 10 isn't in this view");
		const link = screen.getByTestId("landing-full-diff");
		const href = new URL(link.getAttribute("href") ?? "", "http://test");
		expect(Object.fromEntries(href.searchParams)).toMatchObject({
			path: PATH,
			line: "10",
			side: "RIGHT",
			from: "branch",
		});
	});

	it("a link to a line only the compared patch set had (on its commit) lands on the removed row showing it", async () => {
		renderSince(at(2, "RIGHT", { moved: true, commit: H1 }));
		await screen.findByText("new four");
		const row = await vi.waitFor(() => landedRow() ?? Promise.reject());
		expect(row).toHaveAttribute("data-old-no", "2");
		expect(row).toHaveTextContent("branch's own");
		expect(screen.queryByTestId("landing-hint")).toBeNull();
	});

	it("a moved link on another commit still says so", async () => {
		renderSince(at(2, "RIGHT", { moved: true, commit: "c".repeat(40) }));
		await screen.findByText("new four");
		expect(await screen.findByTestId("landing-hint")).toHaveTextContent(
			"Line 2 is from another commit",
		);
		expect(landedRow()).toBeNull();
	});
});
