// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindReview, reviewApiPath } from "./api";
import { createAppRouter, notFoundReason } from "./router";

describe("review routes", () => {
	afterEach(() => {
		cleanup();
		document.head.querySelector('meta[name="crb-not-found"]')?.remove();
		vi.unstubAllGlobals();
	});

	it("asks the review's API under /api/r/<id>, bound once per page", () => {
		// Unbound (component tests): as is.
		expect(reviewApiPath("/api/session")).toBe("/api/session");
		expect(bindReview("01aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
		expect(reviewApiPath("/api/files/3/hunks?revision=r")).toBe(
			"/api/r/01aaaaaaaaaaaaaaaaaaaaaaaa/files/3/hunks?revision=r",
		);
		expect(bindReview("01aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
		// Another review needs a page of its own.
		expect(bindReview("01bbbbbbbbbbbbbbbbbbbbbbbb")).toBe(false);
		expect(reviewApiPath("/api/review")).toBe(
			"/api/r/01aaaaaaaaaaaaaaaaaaaaaaaa/review",
		);
	});

	it("reads why the server's 404 page is one", () => {
		expect(notFoundReason()).toBeNull();
		const meta = document.createElement("meta");
		meta.name = "crb-not-found";
		meta.content = "PR acme/widget#3 is already merged; nothing to review";
		document.head.append(meta);
		expect(notFoundReason()).toBe(
			"PR acme/widget#3 is already merged; nothing to review",
		);
	});

	const renderAt = (path: string) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 404 })),
		);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider router={createAppRouter({ initialPath: path })} />
			</QueryClientProvider>,
		);
	};

	it("a /pr/... address the server couldn't open shows why, and Home", async () => {
		const meta = document.createElement("meta");
		meta.name = "crb-not-found";
		meta.content = "PR acme/widget#3 is closed; reopen it on GitHub to review";
		document.head.append(meta);
		renderAt("/pr/acme/widget/3");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"PR acme/widget#3 is closed; reopen it on GitHub to review",
		);
		// In the PR's frame (its logo) and under the reason.
		for (const home of screen.getAllByRole("link", { name: "Home" })) {
			expect(home).toHaveAttribute("href", "/");
		}
	});

	it("matches its addresses case-sensitively, as the server does: /PR/... opens nothing", async () => {
		const routeOf = (path: string) =>
			createAppRouter({ initialPath: path })
				.matchRoutes(path)
				.map((match) => match.routeId);
		expect(routeOf("/pr/acme/widget/12")).toContain("/pr/$owner/$repo/$number");
		for (const path of ["/PR/acme/widget/12", "/Pr/acme/widget/12"]) {
			expect(routeOf(path), path).not.toContain("/pr/$owner/$repo/$number");
		}
		expect(routeOf("/R/01aaaaaaaaaaaaaaaaaaaaaaaa")).not.toContain("/r/$id");
		renderAt("/PR/acme/widget/12");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"No such page.",
		);
		const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
		for (const [url, init] of fetch.mock.calls) {
			expect(`${init?.method ?? "GET"} ${url}`).not.toMatch(/^POST .*reviews/);
		}
	});

	it("any other unknown address: no such page", async () => {
		renderAt("/nope");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"No such page.",
		);
	});
});
