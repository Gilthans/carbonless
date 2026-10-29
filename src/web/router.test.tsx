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
		expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("any other unknown address: no such page", async () => {
		renderAt("/nope");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"No such page.",
		);
	});
});
