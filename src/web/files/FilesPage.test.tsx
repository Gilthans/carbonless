// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
			screen.getByRole("progressbar", { name: "Clusters" }),
		).toHaveAttribute("aria-valuenow", "100");
	});

	it("reloads and says so when the snapshot moved", async () => {
		let reads = 0;
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
			"/api/review/states": () => ({ status: 409, body: { error: "stale" } }),
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
	});
});
