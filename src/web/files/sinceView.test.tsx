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
} from "../../shared/types";
import { DiffBody } from "./DiffBody";
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
			/>
		</QueryClientProvider>,
	);
	return { onToggle, onCrossOff };
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
});

describe("DiffBody in the since view", () => {
	it("chips each cluster's kind; a gone cluster is a red block with no controls, never counted", async () => {
		renderBody({
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
		// The reworked cluster is this snapshot's: markable.
		expect(
			screen.getAllByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toHaveLength(1);
		const gone = document.querySelector("tbody[data-gone]") as HTMLElement;
		expect(gone).not.toBeNull();
		expect(within(gone).queryByRole("checkbox")).toBeNull();
		expect(within(gone).getByText("gone line")).toBeInTheDocument();
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
