// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../shared/types";
import { App } from "./App";

function renderApp() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>,
	);
}

function mockFetch(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status })),
	);
}

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: "b".repeat(40),
	currentHead: "b".repeat(40),
	headMoved: false,
	patchset: null,
};

describe("App", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("shows the PR title", async () => {
		mockFetch(200, info);
		renderApp();
		expect(
			await screen.findByRole("heading", { name: "Add widget cache" }),
		).toBeInTheDocument();
	});

	it("shows the server's error message", async () => {
		mockFetch(502, { error: "gh is not logged in" });
		renderApp();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"gh is not logged in",
		);
	});
});
