// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router";

const ID = "01cccccccccccccccccccccccc";

/** The routers rendered by the running test. */
const routers: ReturnType<typeof createAppRouter>[] = [];

afterEach(async () => {
	// A load still in flight (a page's code loading) commits through the
	// unmounted router once it ends, after this file's jsdom may be gone:
	// every test ends with its router settled.
	for (const router of routers.splice(0)) {
		await waitFor(() => expect(router.state.status).toBe("idle"));
	}
	cleanup();
	for (const name of ["crb-not-found", "crb-pr-title"]) {
		document.head.querySelector(`meta[name="${name}"]`)?.remove();
	}
	vi.unstubAllGlobals();
});

function meta(name: string, content: string) {
	const m = document.createElement("meta");
	m.name = name;
	m.content = content;
	document.head.append(m);
}

/** POST /api/reviews answers `open` (held until `release` when asked); the rest 404. */
function serve(open: () => Response, held = false) {
	let release = () => {};
	const gate = held
		? new Promise<void>((done) => {
				release = done;
			})
		: Promise.resolve();
	const fetch = vi.fn(async (input: string, init?: RequestInit) => {
		if (input === "/api/reviews" && init?.method === "POST") {
			await gate;
			return open();
		}
		return new Response("{}", { status: 404 });
	});
	vi.stubGlobal("fetch", fetch);
	return { fetch, release: () => release() };
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

function renderAt(path: string) {
	const router = createAppRouter({ initialPath: path });
	// As main.tsx renders it: StrictMode mounts the page twice.
	render(
		<StrictMode>
			<QueryClientProvider client={new QueryClient()}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</StrictMode>,
	);
	routers.push(router);
	return router;
}

describe("/pr/<owner>/<repo>/<n>", () => {
	it("shows the PR loading at once, opens its review, and goes on to it in place", async () => {
		meta("crb-pr-title", "Add widget cache");
		const api = serve(
			() => json(200, { id: ID, url: `http://x/r/${ID}` }),
			true,
		);
		const router = renderAt("/pr/acme/widget/7?head=abc1234");
		const loading = await screen.findByTestId("opening");
		expect(loading).toHaveTextContent("Add widget cache");
		expect(loading).toHaveTextContent("acme/widget");
		expect(loading).toHaveTextContent("#7");
		expect(screen.getByRole("status")).toHaveTextContent("Opening");
		expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
			"href",
			"/",
		);
		api.release();
		// Arrived: the review's page loaded, not just the address changed.
		await waitFor(() =>
			expect(router.state.resolvedLocation?.pathname).toBe(`/r/${ID}`),
		);
		// In place: Back skips the loading page.
		expect(router.history.length).toBe(1);
		const posts = api.fetch.mock.calls.filter(
			([url]) => url === "/api/reviews",
		);
		// Asked once, even though React mounts the page twice in dev.
		expect(posts).toHaveLength(1);
		expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
			pr: "acme/widget#7",
			head: "abc1234",
		});
	});

	it("pins an all-digit head as typed (not read as a number)", async () => {
		const api = serve(() => json(200, { id: ID }));
		const router = renderAt("/pr/acme/widget/7?head=1234567");
		await waitFor(() =>
			expect(router.state.resolvedLocation?.pathname).toBe(`/r/${ID}`),
		);
		const post = api.fetch.mock.calls.find(([url]) => url === "/api/reviews");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({
			pr: "acme/widget#7",
			head: "1234567",
		});
	});

	it("shows a title with markup in it as its text", async () => {
		const evil = '"><script>alert(1)</script>&amp; <b>bold</b>';
		meta("crb-pr-title", evil);
		serve(() => json(200, { id: ID }), true);
		renderAt("/pr/acme/widget/7");
		const loading = await screen.findByTestId("opening");
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(evil);
		expect(loading.querySelector("script, b")).toBeNull();
	});

	it("without a known title, names the PR by repo and number", async () => {
		serve(() => json(200, { id: ID }), true);
		renderAt("/pr/acme/widget/7");
		const loading = await screen.findByTestId("opening");
		expect(loading).toHaveTextContent("acme/widget");
		expect(loading).toHaveTextContent("#7");
	});

	it("a PR that can't be opened says why on the same page, and links Home", async () => {
		serve(() =>
			json(409, {
				error: "PR acme/widget#99 not found",
				code: "refused",
			}),
		);
		renderAt("/pr/acme/widget/99");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"PR acme/widget#99 not found",
		);
		expect(
			screen.getAllByRole("link", { name: "Home" }).length,
		).toBeGreaterThan(0);
	});

	it("an address the server already refused asks nothing", async () => {
		meta("crb-not-found", "Not a PR: acme/widget#0");
		const api = serve(() => json(200, { id: ID }));
		renderAt("/pr/acme/widget/0");
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"Not a PR: acme/widget#0",
		);
		// Nothing about the PR (every page asks about crb's updates).
		expect(
			api.fetch.mock.calls.filter(([url]) => url !== "/api/update"),
		).toEqual([]);
	});

	it("another failure shows the error and stays", async () => {
		serve(() => json(500, { error: "git fetch failed" }));
		renderAt("/pr/acme/widget/7");
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"git fetch failed",
		);
	});
});
