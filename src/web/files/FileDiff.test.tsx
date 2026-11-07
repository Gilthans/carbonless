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
import { expectLoadingThen, heldJson } from "../../../test/loading";
import type {
	ClusterView,
	DiffLine,
	FileHunks,
	FileView,
	ReviewView,
} from "../../shared/types";
import { reviewQuery } from "../api";
import { resetShowInvisibles, setShowInvisibles } from "../code/Invisibles";
import { ignoreWhitespace } from "../viewSettings";
import { FileDiff, UNDO_ARM_MS } from "./FileDiff";
import { SyncNotices } from "./SyncNotices";
import type { Unit } from "./unit";
import { stateSyncFor, useReviewView } from "./useSetStates";

/**
 * A diff line's code by its whole text: a pair's word marks split its text
 * into elements, which the default text match doesn't join.
 */
const codeLine = (text: string) => (_: string, el: Element | null) =>
	el?.hasAttribute("data-code") === true && el.textContent === text;

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
function Shown({ unit }: { unit: Unit }) {
	const { data } = useReviewView();
	const shown = data?.files[0];
	return (
		<>
			{shown && <FileDiff file={shown} revision="r1" unit={unit} />}
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
	const rendered = render(
		<QueryClientProvider client={queryClient}>
			<Shown unit={unit} />
		</QueryClientProvider>,
	);
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
		user: userEvent.setup(),
	};
}

describe("FileDiff", () => {
	// Code reads as plain text here; invisibles get their own test below.
	beforeEach(() => setShowInvisibles(false));
	afterEach(() => {
		localStorage.clear();
		resetShowInvisibles();
		ignoreWhitespace.reset();
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
		const { user, sync } = setup(file([cluster("k1")]), (url) =>
			url.pathname === "/api/review"
				? { status: 200, body: view(file([cluster("k1")])) }
				: { status: 409, body: { error: "stale" } },
		);
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		const box = await screen.findByRole("checkbox", {
			name: "Mark cluster reviewed",
		});
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
		await user.click(screen.getByRole("button", { name: "Undo cross-off" }));
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
		await user.click(screen.getByRole("button", { name: "Undo cross-off" }));
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
		await new Promise((r) => setTimeout(r, UNDO_ARM_MS));
		await user.click(undo);
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

	it("keeps the file open after marking its last cluster by hand", async () => {
		const f = file([cluster("k1")]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		await waitFor(() => expect(posts()).toHaveLength(1));
		await waitFor(() =>
			expect(
				screen.getByRole("checkbox", { name: "Mark cluster reviewed" }),
			).toBeEnabled(),
		);
		expect(
			screen.getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
	});

	it("keeps the file open after undoing a cross-off", async () => {
		const f = file([
			cluster("k1", { state: "crossed-off", reason: "generated" }),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Expand file" }));
		await user.click(screen.getByRole("button", { name: "Undo cross-off" }));
		await waitFor(() => expect(posts()).toHaveLength(1));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Undo cross-off" }),
			).toBeEnabled(),
		);
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
		// A double click's second click doesn't undo it.
		await user.click(cross);
		expect(cross).toHaveAccessibleName("Undo cross-off");
		await new Promise((r) => setTimeout(r, UNDO_ARM_MS));
		// Undone while the first write is still out: queued behind it.
		await user.click(cross);
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
		const reviewed = file([cluster("k1", { state: "reviewed" })]);
		const [first] = hunks.hunks;
		if (!first) throw new Error("fixture has a hunk");
		const lines = first.lines.map((l) =>
			l.kind === "add" ? { ...l, text: "  old five" } : l,
		);
		const { posts, paths, user } = setup(
			file([cluster("k1")]),
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
		expect(
			screen.getByRole("progressbar", { name: "File progress" }),
		).toHaveTextContent("1 / 1 cluster");
	});
});
