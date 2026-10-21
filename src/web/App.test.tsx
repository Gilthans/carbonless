// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Comparison } from "../shared/types";
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

const comparison: Comparison = {
	repoPath: "/repos/example",
	base: {
		sha: "a".repeat(40),
		shortSha: "aaaaaaa",
		subject: "Base subject",
		author: "Ada",
		date: "2026-01-01T00:00:00Z",
	},
	head: {
		sha: "b".repeat(40),
		shortSha: "bbbbbbb",
		subject: "Head subject",
		author: "Grace",
		date: "2026-01-02T00:00:00Z",
	},
};

describe("App", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("shows both commits", async () => {
		mockFetch(200, comparison);
		renderApp();

		const base = await screen.findByRole("region", { name: "Base" });
		expect(within(base).getByText("aaaaaaa")).toBeInTheDocument();
		expect(within(base).getByText("Base subject")).toBeInTheDocument();

		const head = screen.getByRole("region", { name: "Head" });
		expect(within(head).getByText("Head subject")).toBeInTheDocument();
		expect(screen.getByTestId("repo-path")).toHaveTextContent("/repos/example");
	});

	it("shows the server's error message", async () => {
		mockFetch(400, { error: "unknown revision" });
		renderApp();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"unknown revision",
		);
	});
});
