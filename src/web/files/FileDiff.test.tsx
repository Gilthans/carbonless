// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	ReviewView,
} from "../../shared/types";
import { reviewQuery } from "../api";
import { FileDiff } from "./FileDiff";
import type { Unit } from "./unit";

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

type Result = { status: number; body: unknown };
type Handler = (url: URL, init?: RequestInit) => Result | Promise<Result>;

function setup(
	f: FileView,
	handler: Handler = () => ({ status: 404, body: {} }),
	fileHunks: FileHunks = hunks,
	unit: Unit = "clusters",
) {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://test");
			const result =
				url.pathname === "/api/files/0/hunks"
					? { status: 200, body: fileHunks }
					: await handler(url, init);
			return new Response(JSON.stringify(result.body), {
				status: result.status,
			});
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onStaleChange = vi.fn();
	const tree = (shown: FileView) => (
		<QueryClientProvider client={queryClient}>
			<FileDiff
				file={shown}
				revision="r1"
				unit={unit}
				onStaleChange={onStaleChange}
			/>
		</QueryClientProvider>
	);
	const rendered = render(tree(f));
	/** Shows `next` as the file, like the page does after a write. */
	const rerender = (next: FileView) => rendered.rerender(tree(next));
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
		onStaleChange,
		posts,
		paths,
		rerender,
		user: userEvent.setup(),
	};
}

describe("FileDiff", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
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
		expect(await screen.findByText("new five")).toBeInTheDocument();
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
			expect(queryClient.getQueryData(reviewQuery.queryKey)).toEqual(
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

	it("shows other errors inline and keeps the checkbox unchecked", async () => {
		const { user, onStaleChange } = setup(file([cluster("k1")]), () => ({
			status: 500,
			body: { error: "git exploded" },
		}));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
		await user.click(box);
		expect(await screen.findByRole("alert")).toHaveTextContent("git exploded");
		expect(box).not.toBeChecked();
		expect(onStaleChange).not.toHaveBeenCalledWith(true);
	});

	it("reports a stale snapshot", async () => {
		const { user, onStaleChange } = setup(file([cluster("k1")]), () => ({
			status: 409,
			body: { error: "stale" },
		}));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		await waitFor(() => expect(onStaleChange).toHaveBeenCalledWith(true));
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

	it("stops a split batch at the first failed request", async () => {
		const f = file(
			Array.from({ length: 1500 }, (_, i) =>
				cluster(`k${i}`, { state: "crossed-off", reason: "generated" }),
			),
		);
		const { posts, user } = setup(f, () => ({
			status: 500,
			body: { error: "boom" },
		}));
		await user.click(screen.getByRole("button", { name: "Undo cross-off" }));
		expect(await screen.findByText(/boom/)).toBeInTheDocument();
		expect(posts()).toHaveLength(1);
		expect(posts()[0]?.body.changes).toHaveLength(1000);
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
			"3 of 8 lines reviewed, 2 crossed off",
		);
		cleanup();
		setup(f, undefined, hunks, "files");
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
		expect(progress).toHaveAttribute("aria-valuetext", "done · 1 crossed off");
	});

	it("tabs through the header in the narrow layout's order: path first", async () => {
		const { user } = setup(file([cluster("k1")]));
		await user.tab();
		expect(screen.getByTestId("file-path")).toHaveFocus();
		await user.tab();
		expect(screen.getByRole("button", { name: "Expand file" })).toHaveFocus();
		// The icons that only carry a tooltip are focusable so touch and
		// keyboard users can read it: status, count, then the actions.
		await user.tab();
		expect(screen.getByRole("img", { name: "not started" })).toHaveFocus();
		await user.tab();
		expect(screen.getByRole("img", { name: "1 cluster" })).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveFocus();
		await user.tab();
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toHaveFocus();
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
		await user.click(undo);
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

		rerender(crossedOff);
		// The same button, now undoing.
		const undo = screen.getByRole("button", { name: "Undo cross-off" });
		expect(undo).toBe(cross);
		expect(undo).toHaveAttribute("aria-pressed", "true");
		await waitFor(() => expect(undo).toBeEnabled());
		await user.click(undo);
		await waitFor(() =>
			expect(posts()[1]?.body.changes).toEqual([
				{ key: "k2", state: "unreviewed" },
			]),
		);

		rerender(before);
		expect(
			screen.getByRole("button", { name: "Cross off file" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
	});

	it("disables the file actions when there's nothing to do", () => {
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
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeDisabled();
		expect(screen.queryByRole("button", { name: "Undo cross-off" })).toBeNull();
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

	it("counts the file's changes in the selected unit", () => {
		const f = file([cluster("k1"), cluster("k2")], {
			additions: 4,
			deletions: 2,
		});
		const header = () => document.querySelector("header") as HTMLElement;
		setup(f, undefined, hunks, "lines");
		expect(header()).toHaveTextContent("+4 −2");
		cleanup();
		setup(f, undefined, hunks, "clusters");
		expect(header()).not.toHaveTextContent("+4");
		expect(screen.getByRole("img", { name: "2 clusters" })).toHaveTextContent(
			"2",
		);
		cleanup();
		setup(f, undefined, hunks, "files");
		expect(header()).not.toHaveTextContent("+4");
		expect(screen.queryByRole("img", { name: /clusters$/ })).toBeNull();
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
			</QueryClientProvider>
		);
		const { rerender } = render(shown(false));
		await userEvent.click(screen.getByRole("button", { name: "Expand file" }));
		expect(onExpandedChange).toHaveBeenLastCalledWith(true);
		// Still closed until the owner opens it.
		expect(screen.queryByRole("checkbox")).toBeNull();
		rerender(shown(true));
		expect(await screen.findByText("new five")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: "Collapse file" }),
		);
		expect(onExpandedChange).toHaveBeenLastCalledWith(false);
	});

	it("disables the file actions while a write is pending", async () => {
		let answer: (() => void) | undefined;
		const f = file([cluster("k1"), cluster("k2")]);
		const { user } = setup(
			f,
			() =>
				new Promise<Result>((resolve) => {
					answer = () => resolve({ status: 200, body: view(f) });
				}),
		);
		await user.click(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Cross off file" }),
			).toBeDisabled(),
		);
		expect(
			screen.getByRole("button", { name: "Mark remaining reviewed" }),
		).toBeDisabled();
		answer?.();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Cross off file" }),
			).toBeEnabled(),
		);
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
		void queryClient.prefetchQuery(reviewQuery);
		await waitFor(() => expect(answerRead).toBeDefined());
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		await waitFor(() =>
			expect(queryClient.getQueryData(reviewQuery.queryKey)).toEqual(after),
		);
		answerRead?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(queryClient.getQueryData(reviewQuery.queryKey)).toEqual(after);
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

	it("keeps lines the server didn't return loadable", async () => {
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
		expect(screen.getByText("32 hidden lines")).toBeInTheDocument();
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
		expect(
			screen.getAllByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toHaveLength(2);
	});
});
