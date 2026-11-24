// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSearch, stringifySearch } from "../search";
import { HomePage, HomeRoute, parseHomeSearch } from "./HomePage";
import {
	type Call,
	fakeApi,
	held,
	inOrder,
	renderWithQuery,
	repoAnswer,
	row,
	view,
} from "./testing";

// A view repo's chip filters Home to that repo (owner, 2026-11-24: "When
// clicking on one, it filters only PRs from that repo. Clicking again
// resets to all the repos.").

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const section = (name: string) =>
	screen.getByRole("region", { name: new RegExp(`^${name}`) });
const titles = (name: string) =>
	within(section(name))
		.queryAllByTestId("home-row")
		.map((r) => within(r).getByRole("link").textContent?.replace(/^#\d+/, ""));
const count = (name: string) =>
	within(section(name)).getByRole("heading").textContent?.match(/\d+$/)?.[0];
const toggle = (name: string) => screen.getByRole("button", { name });
const chip = (name: string) =>
	screen.getAllByTestId("view-repo").find((c) => c.textContent === name);

async function saveRepos(change: (dialog: HTMLElement) => Promise<void>) {
	await userEvent.click(
		await screen.findByRole("button", { name: "Edit repos" }),
	);
	const dialog = screen.getByRole("dialog", { name: "My PRs" });
	await change(dialog);
	await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
}
const addRepo = (name: string) => async (dialog: HTMLElement) => {
	const field = within(dialog).getByRole("combobox", { name: "Add a repo" });
	await userEvent.type(field, `${name}{Enter}`);
};
const removeRepo = (name: string) => async (dialog: HTMLElement) => {
	await userEvent.click(
		within(dialog).getByRole("button", { name: `Remove ${name}` }),
	);
};

/** Home at `path`, routed as the app routes it (the address holds the filter). */
function renderAt(path: string) {
	const root = createRootRoute({ component: () => <Outlet /> });
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/",
				validateSearch: parseHomeSearch,
				component: HomeRoute,
			}),
		]),
		history: createMemoryHistory({ initialEntries: [path] }),
		parseSearch,
		stringifySearch,
	});
	renderWithQuery(<RouterProvider router={router} />);
	return router;
}

const twoRepos = () =>
	view({
		mine: inOrder([
			row({ number: 1, title: "API mine" }),
			row({ repo: "console", number: 2, title: "Console mine" }),
		]),
		reviewing: inOrder([
			row({ repo: "console", number: 3, title: "Console reviewing" }),
		]),
		other: inOrder([row({ number: 4, title: "API other" })]),
	});

describe("Home repo filter", () => {
	it("a chip toggles: only its repo's rows and counts in every section; another switches; again shows all", async () => {
		fakeApi(twoRepos());
		const router = renderAt("/");
		expect(await screen.findByText("Console reviewing")).toBeInTheDocument();
		await waitFor(() => expect(count("Mine")).toBe("2"));
		const api = toggle("acme/api");
		const console = toggle("acme/console");
		expect(api).toHaveAttribute("aria-pressed", "false");
		expect(console).toHaveAttribute("aria-pressed", "false");

		await userEvent.click(api);
		expect(api).toHaveAttribute("aria-pressed", "true");
		expect(console).toHaveAttribute("aria-pressed", "false");
		expect(titles("Mine")).toEqual(["API mine"]);
		expect(count("Mine")).toBe("1");
		expect(titles("Reviewing")).toEqual([]);
		// Empty under the filter reads as any empty section.
		within(section("Reviewing")).getByTestId("section-none");
		expect(titles("Other open")).toEqual(["API other"]);
		expect(router.state.location.search).toEqual({ repo: "acme/api" });

		await userEvent.click(console);
		expect(api).toHaveAttribute("aria-pressed", "false");
		expect(console).toHaveAttribute("aria-pressed", "true");
		expect(titles("Mine")).toEqual(["Console mine"]);
		expect(titles("Reviewing")).toEqual(["Console reviewing"]);
		expect(titles("Other open")).toEqual([]);
		expect(router.state.location.search).toEqual({ repo: "acme/console" });

		await userEvent.click(console);
		expect(console).toHaveAttribute("aria-pressed", "false");
		expect(titles("Mine")).toEqual(["API mine", "Console mine"]);
		expect(titles("Reviewing")).toEqual(["Console reviewing"]);
		expect(titles("Other open")).toEqual(["API other"]);
		expect(router.state.location.search).toEqual({});
	});

	it("the tooltip says what a click does", async () => {
		fakeApi(twoRepos());
		renderAt("/");
		await screen.findByText("Console reviewing");
		expect(toggle("acme/api")).toHaveAccessibleDescription(
			"Show only acme/api",
		);
		await userEvent.click(toggle("acme/api"));
		expect(toggle("acme/api")).toHaveAccessibleDescription("Show all repos");
	});

	it("the address holds it: ?repo= filters at load (any case), back restores the previous state", async () => {
		fakeApi(twoRepos());
		const router = renderAt("/?repo=ACME/Console");
		expect(await screen.findByText("Console reviewing")).toBeInTheDocument();
		expect(toggle("acme/console")).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByText("API mine")).toBeNull();
		await userEvent.click(toggle("acme/console"));
		expect(await screen.findByText("API mine")).toBeInTheDocument();
		act(() => router.history.back());
		await waitFor(() => expect(screen.queryByText("API mine")).toBeNull());
		expect(toggle("acme/console")).toHaveAttribute("aria-pressed", "true");
	});

	it("a ?repo= outside the view is ignored and dropped: every repo shows", async () => {
		fakeApi(twoRepos());
		const router = renderAt("/?repo=acme/nowhere");
		expect(await screen.findByText("API mine")).toBeInTheDocument();
		expect(screen.getByText("Console mine")).toBeInTheDocument();
		for (const name of ["acme/api", "acme/console"]) {
			expect(toggle(name)).toHaveAttribute("aria-pressed", "false");
		}
		await waitFor(() => expect(router.state.location.search).toEqual({}));
		// Replaced, not pushed: back doesn't bring it again.
		expect(router.history.length).toBe(1);
	});

	it("while the filtered repo's first read is out, its sections show loading, never empty, whatever the others answered", async () => {
		const gate = held();
		const api = fakeApi(twoRepos(), {
			"GET /api/home/repos/acme/console": async () => {
				await gate.gate;
				return repoAnswer(api.state.home, "acme/console");
			},
		});
		renderAt("/?repo=acme/console");
		await waitFor(() =>
			expect(screen.getAllByTestId("view-repo")[1]).toHaveAttribute(
				"data-state",
				"loading",
			),
		);
		await waitFor(() =>
			expect(
				(api.calls as Call[]).some((c) => c.url === "/api/home/repos/acme/api"),
			).toBe(true),
		);
		for (const name of ["Mine", "Reviewing", "Other open"]) {
			within(section(name)).getByRole("img", { name: "Loading" });
			expect(within(section(name)).queryByTestId("section-none")).toBeNull();
			expect(
				within(section(name)).getByRole("heading").textContent,
			).not.toMatch(/\d/);
		}
		expect(screen.queryByText("API mine")).toBeNull();
		gate.release();
		expect(await screen.findByText("Console reviewing")).toBeInTheDocument();
		expect(count("Mine")).toBe("1");
		expect(screen.queryByText("API mine")).toBeNull();
	});

	it("filtered to a repo a save is still adding: its sections show loading, never a 0, until its rows are in", async () => {
		const put = held();
		// Its read too: one picked in the settings is read at once, and
		// with its rows in it would no longer be pending.
		const read = held();
		const api = fakeApi(
			view({
				mine: inOrder([
					row({ number: 1, title: "API mine" }),
					row({ repo: "web", number: 2, title: "Web mine" }),
				]),
			}),
			{
				"GET /api/home/repos/acme/web": async () => {
					await read.gate;
					return repoAnswer(api.state.home, "acme/web");
				},
				"PUT /api/home/view": async (call) => {
					await put.gate;
					const repos = (call.body as { repos: string[] }).repos;
					api.state.home = {
						...api.state.home,
						view: { name: "My PRs", repos },
					};
					const { sections: _, repos: __, ...rest } = api.state.home;
					return rest;
				},
			},
		);
		renderAt("/");
		await screen.findByText("API mine");
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		await saveRepos(addRepo("acme/web"));
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "saving"),
		);
		await userEvent.click(toggle("acme/web"));
		expect(toggle("acme/web")).toHaveAttribute("aria-pressed", "true");
		for (const name of ["Mine", "Reviewing", "Other open"]) {
			within(section(name)).getByRole("img", { name: "Loading" });
			expect(
				within(section(name)).getByRole("heading").textContent,
			).not.toMatch(/\d/);
			expect(within(section(name)).queryByTestId("section-none")).toBeNull();
		}
		expect(screen.queryByText("API mine")).toBeNull();
		put.release();
		// Saved, its first read still out: still loading.
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "loading"),
		);
		within(section("Mine")).getByRole("img", { name: "Loading" });
		expect(
			within(section("Mine")).getByRole("heading").textContent,
		).not.toMatch(/\d/);
		read.release();
		expect(await screen.findByText("Web mine")).toBeInTheDocument();
		await waitFor(() => expect(count("Mine")).toBe("1"));
		expect(screen.queryByText("API mine")).toBeNull();
	});

	it("the filtered repo leaving the view drops the filter once the save is in; a refused save keeps it", async () => {
		const put = held();
		let refuse = true;
		const api = fakeApi(twoRepos(), {
			"PUT /api/home/view": async (call) => {
				await put.gate;
				if (refuse) {
					return new Response(JSON.stringify({ error: "nope" }), {
						status: 400,
					});
				}
				const repos = (call.body as { repos: string[] }).repos;
				api.state.home = {
					...api.state.home,
					view: { name: "My PRs", repos },
				};
				const { sections: _, repos: __, ...rest } = api.state.home;
				return rest;
			},
		});
		const router = renderAt("/?repo=acme/console");
		expect(await screen.findByText("Console mine")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);

		// Refused: the view comes back, the filter with it.
		await saveRepos(removeRepo("acme/console"));
		await waitFor(() => expect(chip("acme/console")).toBeUndefined());
		expect(router.state.location.search).toEqual({ repo: "acme/console" });
		put.release();
		await waitFor(() =>
			expect(toggle("acme/console")).toHaveAttribute("aria-pressed", "true"),
		);
		expect(router.state.location.search).toEqual({ repo: "acme/console" });
		expect(screen.queryByText("API mine")).toBeNull();

		// Stored: every repo's rows, the address without it.
		refuse = false;
		await saveRepos(removeRepo("acme/console"));
		await waitFor(() => expect(router.state.location.search).toEqual({}));
		expect(await screen.findByText("API mine")).toBeInTheDocument();
		expect(screen.queryByText("Console mine")).toBeNull();
		expect(chip("acme/console")).toBeUndefined();
	});

	it("a failed chip keeps its alert and Retry; Retry doesn't toggle the filter", async () => {
		const api = fakeApi(
			view(
				{ mine: inOrder([row({ number: 1, title: "API mine" })]) },
				{
					view: { name: "My PRs", repos: ["acme/api", "acme/nowhere"] },
					repos: {
						"acme/nowhere": { error: "Not found on GitHub", failures: 1 },
					},
				},
			),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API mine");
		const nowhere = await screen.findByRole("button", { name: "acme/nowhere" });
		await screen.findByRole("img", {
			name: "acme/nowhere: Not found on GitHub",
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Retry acme/nowhere" }),
		);
		await waitFor(() =>
			expect(api.calls.map((c) => c.url)).toContain(
				"/api/home/repos/acme/nowhere?fresh=1",
			),
		);
		expect(nowhere).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByText("API mine")).toBeInTheDocument();
		// It may be pressed itself: its alert and Retry stay.
		await userEvent.click(nowhere);
		expect(nowhere).toHaveAttribute("aria-pressed", "true");
		expect(screen.queryByText("API mine")).toBeNull();
		screen.getByRole("img", { name: "acme/nowhere: Not found on GitHub" });
		screen.getByRole("button", { name: "Retry acme/nowhere" });
	});
});
