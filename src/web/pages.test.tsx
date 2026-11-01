// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen } from "../../test/loading";
import type { SessionInfo } from "../shared/types";
import { createAppRouter } from "./router";

// The Overview's code arrives when the test lets it go.
let loadPage: () => void = () => {};
vi.mock("./overview/OverviewPage", async () => {
	await new Promise<void>((resolve) => {
		loadPage = resolve;
	});
	return {
		OverviewPage: () => <p>The overview</p>,
	};
});

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
	asOf: null,
	pinnedHead: null,
};

describe("KeptPages", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("while a page's code loads: a spinner, never a blank page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("/session")
					? new Response(JSON.stringify(info))
					: new Response("{}", { status: 404 }),
			),
		);
		vi.stubGlobal("scrollTo", vi.fn());
		render(
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider
					router={createAppRouter({
						initialPath: "/r/01testreview0000000000000a",
					})}
				/>
			</QueryClientProvider>,
		);
		await screen.findByRole("heading", { level: 1, name: "Add widget cache" });
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading the page" }),
			release: () => loadPage(),
			result: () => screen.queryByText("The overview"),
		});
		expect(screen.getByRole("main")).toBeInTheDocument();
	});
});
