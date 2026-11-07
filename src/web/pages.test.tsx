// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
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
	patchsets: [],
	lastSeen: null,
};

describe("KeptPages", () => {
	afterEach(() => {
		vi.useRealTimers();
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
		// Only timeouts are faked: the test moves the clock itself.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		render(
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider
					router={createAppRouter({
						initialPath: "/r/01testreview0000000000000a",
					})}
				/>
			</QueryClientProvider>,
		);
		// The header doesn't wait on the page's code: it shows while the code
		// is held, on a clock that never reaches the router's 1 s pendingMs.
		const header = () =>
			screen.queryByRole("heading", { level: 1, name: "Add widget cache" });
		for (let ms = 0; ms < 900 && !header(); ms += 50) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50);
			});
		}
		expect(header()).toBeInTheDocument();
		expect(
			screen.getByRole("status", { name: "Loading the page" }),
		).toBeInTheDocument();
		vi.useRealTimers();
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading the page" }),
			release: () => loadPage(),
			result: () => screen.queryByText("The overview"),
		});
		expect(screen.getByRole("main")).toBeInTheDocument();
	});
});
