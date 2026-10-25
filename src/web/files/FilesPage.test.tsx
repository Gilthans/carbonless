// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileView, ReviewView } from "../../shared/types";
import { FilesPage } from "./FilesPage";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

const counts = { total: 0, reviewed: 0, crossedOff: 0 };
const emptyReview: ReviewView = {
	revision: "r1",
	patchset: null,
	files: [],
	progress: { clusters: counts, lines: counts, files: { ...counts, done: 0 } },
};

const oneFile: FileView = {
	index: 0,
	path: "a.txt",
	status: "modified",
	binary: false,
	submodule: false,
	additions: 1,
	deletions: 1,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [
		{
			key: "k1",
			kind: "lines",
			oldStart: 2,
			oldCount: 1,
			newStart: 2,
			newCount: 1,
			removed: ["a"],
			added: ["b"],
			lines: 2,
			state: "unreviewed",
		},
	],
};

const otherFile: FileView = { ...oneFile, index: 1, path: "b.txt" };
const noHunks = { newLineCount: 0, hunks: [] };

function renderPage(
	responses: Record<string, () => { status: number; body: unknown }>,
) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const path = new URL(String(input), "http://test").pathname;
		const respond = responses[path];
		const result = respond ? respond() : { status: 404, body: {} };
		return new Response(JSON.stringify(result.body), { status: result.status });
	});
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>
			<FilesPage />
		</QueryClientProvider>,
	);
	return fetchMock;
}

describe("FilesPage", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("says when the PR changes no files", async () => {
		renderPage({ "/api/review": () => ({ status: 200, body: emptyReview }) });
		expect(
			await screen.findByText("This PR changes no files."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("progressbar", { name: "Review progress" }),
		).toHaveAttribute("aria-valuenow", "100");
	});

	it("reloads and says so when the snapshot moved, until a write is stored", async () => {
		let reads = 0;
		let writes = 0;
		const fetchMock = renderPage({
			"/api/review": () => {
				reads++;
				return { status: 200, body: { ...emptyReview, files: [oneFile] } };
			},
			"/api/files/0/hunks": () => ({
				status: 200,
				body: {
					newLineCount: 3,
					hunks: [
						{
							oldStart: 1,
							oldCount: 3,
							newStart: 1,
							newCount: 3,
							lines: [
								{ kind: "context", oldNo: 1, newNo: 1, text: "x" },
								{ kind: "del", oldNo: 2, text: "a", clusterKey: "k1" },
								{ kind: "add", newNo: 2, text: "b", clusterKey: "k1" },
								{ kind: "context", oldNo: 3, newNo: 3, text: "y" },
							],
						},
					],
				},
			}),
			"/api/review/states": () =>
				writes++ === 0
					? { status: 409, body: { error: "stale" } }
					: { status: 200, body: { ...emptyReview, files: [oneFile] } },
		});
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: "Expand file" }),
		);
		await user.click(
			await screen.findByRole("checkbox", { name: "Mark cluster reviewed" }),
		);
		expect(
			await screen.findByText("The review moved to a new snapshot; reloaded."),
		).toBeInTheDocument();
		await vi.waitFor(() => expect(reads).toBe(2));
		expect(fetchMock).toHaveBeenCalled();
		// The next stored write clears the notice.
		const box = screen.getByRole("checkbox", { name: "Mark cluster reviewed" });
		await vi.waitFor(() => expect(box).toBeEnabled());
		await user.click(box);
		await vi.waitFor(() =>
			expect(
				screen.queryByText("The review moved to a new snapshot; reloaded."),
			).toBeNull(),
		);
	});

	it("remembers the unit and counts the file tree in it", async () => {
		renderPage({
			"/api/review": () => ({
				status: 200,
				body: { ...emptyReview, files: [oneFile] },
			}),
		});
		const user = userEvent.setup();
		const tree = await screen.findByTestId("file-tree");
		const bar = () =>
			within(tree).getByRole("progressbar", { name: "File progress" });
		expect(screen.getByRole("radio", { name: "Lines" })).toBeChecked();
		expect(bar()).toHaveAttribute("aria-valuetext", "0 of 2 lines reviewed");
		expect(tree).toHaveTextContent("+1 −1");
		await user.click(screen.getByRole("radio", { name: "Files" }));
		expect(bar()).toHaveAttribute("aria-valuetext", "0 of 1 files reviewed");
		expect(tree).not.toHaveTextContent("+1");
		expect(localStorage.getItem("crb.files.unit")).toBe("files");
		cleanup();
		renderPage({
			"/api/review": () => ({
				status: 200,
				body: { ...emptyReview, files: [oneFile] },
			}),
		});
		expect(await screen.findByRole("radio", { name: "Files" })).toBeChecked();
		localStorage.clear();
	});

	it("opens one file at a time", async () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		renderPage({
			"/api/review": () => ({
				status: 200,
				body: { ...emptyReview, files: [oneFile, otherFile] },
			}),
			"/api/files/0/hunks": () => ({ status: 200, body: noHunks }),
			"/api/files/1/hunks": () => ({ status: 200, body: noHunks }),
		});
		const user = userEvent.setup();
		const a = await screen.findByRole("region", { name: "a.txt" });
		const b = screen.getByRole("region", { name: "b.txt" });
		await user.click(within(a).getByRole("button", { name: "Expand file" }));
		expect(
			within(a).getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
		await user.click(within(b).getByRole("button", { name: "Expand file" }));
		expect(
			within(b).getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
		expect(
			within(a).getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
		// Opening by its header doesn't jump to it.
		expect(scrolled).not.toHaveBeenCalled();
		await user.click(within(b).getByRole("button", { name: "Collapse file" }));
		expect(
			within(b).getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
		expect(
			within(a).getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
	});

	it("picking a file in the tree opens it, closes the others and scrolls to it", async () => {
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		renderPage({
			"/api/review": () => ({
				status: 200,
				body: { ...emptyReview, files: [oneFile, otherFile] },
			}),
			"/api/files/0/hunks": () => ({ status: 200, body: noHunks }),
			"/api/files/1/hunks": () => ({ status: 200, body: noHunks }),
		});
		const user = userEvent.setup();
		const a = await screen.findByRole("region", { name: "a.txt" });
		const b = screen.getByRole("region", { name: "b.txt" });
		await user.click(within(a).getByRole("button", { name: "Expand file" }));
		const tree = screen.getByTestId("file-tree");
		await user.click(within(tree).getByRole("button", { name: /b\.txt/ }));
		expect(
			within(b).getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
		expect(
			within(a).getByRole("button", { name: "Expand file" }),
		).toBeInTheDocument();
		await vi.waitFor(() => expect(scrolled).toHaveBeenCalled());
		expect(scrolled.mock.contexts.at(-1)).toBe(b);
		expect(scrolled.mock.calls.at(-1)?.[0]).toMatchObject({ block: "start" });
		// Picking the open file keeps it open.
		await user.click(within(tree).getByRole("button", { name: /b\.txt/ }));
		expect(
			within(b).getByRole("button", { name: "Collapse file" }),
		).toBeInTheDocument();
	});

	it("on a narrow screen, opens the file tree from a floating button", async () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches: false,
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		renderPage({
			"/api/review": () => ({
				status: 200,
				body: { ...emptyReview, files: [oneFile] },
			}),
		});
		const user = userEvent.setup();
		const button = await screen.findByRole("button", { name: "Files" });
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(button);
		const sheet = screen.getByRole("dialog", { name: "Files" });
		await user.click(within(sheet).getByRole("button", { name: /a\.txt/ }));
		await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await vi.waitFor(() => expect(scrolled).toHaveBeenCalled());
	});
});
