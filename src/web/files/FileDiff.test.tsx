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
	render(
		<QueryClientProvider client={queryClient}>
			<FileDiff file={f} revision="r1" onStaleChange={onStaleChange} />
		</QueryClientProvider>,
	);
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
		expect(screen.getByText("src/a.ts")).toBeInTheDocument();
		expect(screen.getByText("0 of 1 clusters reviewed")).toBeInTheDocument();
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

	it("crosses off a file only with a reason, keeping reviewed clusters", async () => {
		const f = file([
			cluster("k0", { state: "reviewed" }),
			cluster("k1"),
			{ ...cluster("r"), kind: "file", label: "Renamed from b.ts", lines: 0 },
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Cross off file…" }));
		const dialog = screen.getByRole("dialog", { name: "Cross off file" });
		await user.type(within(dialog).getByLabelText("Reason"), "   ");
		await user.click(within(dialog).getByRole("button", { name: "Cross off" }));
		expect(
			await within(dialog).findByText("A reason is required"),
		).toBeInTheDocument();
		expect(posts()).toEqual([]);
		await user.click(
			within(dialog).getByRole("button", { name: "rename only" }),
		);
		await user.click(within(dialog).getByRole("button", { name: "Cross off" }));
		await waitFor(() =>
			expect(posts()[0]?.body.changes).toEqual([
				{ key: "k1", state: "crossed-off", reason: "rename only" },
				{ key: "r", state: "crossed-off", reason: "rename only" },
			]),
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
			cluster("k3"),
			cluster("k4", { state: "crossed-off", reason: "generated" }),
		]);
		const { posts, user } = setup(f, () => ({ status: 200, body: view(f) }));
		await user.click(screen.getByRole("button", { name: "Undo cross-off" }));
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
