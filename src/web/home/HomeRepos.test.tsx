// @vitest-environment jsdom
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import { homeQuery, isPicked, repoKey } from "./homeApi";
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

// Each view repo is its own query (owner, 2026-11-01: "Every repo PR list
// should have its own tanstack query"), composed into the sections here.

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	focusManager.setFocused(undefined);
});

const section = (name: string) =>
	screen.getByRole("region", { name: new RegExp(`^${name}`) });
const titles = (name: string) =>
	within(section(name))
		.queryAllByTestId("home-row")
		.map((r) => within(r).getByRole("link").textContent?.replace(/^#\d+/, ""));
const repoGets = (calls: Call[], name?: string) =>
	calls.filter(
		(c) =>
			c.method === "GET" && c.url.startsWith(`/api/home/repos/${name ?? ""}`),
	);
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

describe("Home's repos", () => {
	it("composes the sections from every repo's rows: the viewer's turn first, then newest", async () => {
		fakeApi(
			view({
				reviewing: [
					row({
						number: 1,
						title: "API old",
						updatedAt: "2026-10-01T00:00:00Z",
					}),
					row({
						repo: "console",
						number: 2,
						title: "Console new",
						updatedAt: "2026-10-03T00:00:00Z",
					}),
					row({
						repo: "console",
						number: 3,
						title: "Console mine to do",
						updatedAt: "2026-09-01T00:00:00Z",
						turn: { kind: "people", logins: ["dan"] },
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		await waitFor(() =>
			expect(titles("Reviewing")).toEqual([
				"Console mine to do",
				"Console new",
				"API old",
			]),
		);
	});

	it("one repo's failure or wait never holds the others' rows; the failing one says why, with Retry", async () => {
		const console = held();
		const api = fakeApi(
			view(
				{
					mine: [
						row({ number: 1, title: "API change" }),
						row({ repo: "console", number: 2, title: "Console change" }),
					],
				},
				{
					view: {
						name: "My PRs",
						repos: ["acme/api", "acme/console", "acme/nowhere"],
					},
					repos: {
						"acme/nowhere": { error: "Not found on GitHub", failures: 1 },
					},
				},
			),
			{
				"GET /api/home/repos/acme/console": async () => {
					await console.gate;
					return repoAnswer(api.state.home, "acme/console");
				},
			},
		);
		renderWithQuery(<HomePage />);
		expect(await screen.findByText("API change")).toBeInTheDocument();
		// The held one: its chip spins, its rows aren't there yet.
		expect(chip("acme/console")).toHaveAttribute("data-state", "loading");
		within(chip("acme/console") as HTMLElement).getByRole("img", {
			name: "Loading acme/console",
		});
		expect(screen.queryByText("Console change")).toBeNull();
		// The failing one: its chip says why, Retry reads it from GitHub now.
		await waitFor(() =>
			expect(chip("acme/nowhere")).toHaveAttribute("data-state", "failed"),
		);
		within(chip("acme/nowhere") as HTMLElement).getByRole("img", {
			name: "acme/nowhere: Not found on GitHub",
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Retry acme/nowhere" }),
		);
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/nowhere").map((c) => c.url)).toContain(
				"/api/home/repos/acme/nowhere?fresh=1",
			),
		);
		console.release();
		expect(await screen.findByText("Console change")).toBeInTheDocument();
		expect(chip("acme/console")).toHaveAttribute("data-state", "ready");
	});

	it("while a repo's first read is out: a spinner by the view's name, sections show placeholders and no counts; then the real counts", async () => {
		const gate = held();
		const api = fakeApi(
			view({ mine: [row({ number: 1, title: "API change" })] }),
			{
				"GET /api/home/repos/acme/console": async () => {
					await gate.gate;
					return repoAnswer(api.state.home, "acme/console");
				},
			},
		);
		renderWithQuery(<HomePage />);
		expect(await screen.findByText("API change")).toBeInTheDocument();
		expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
		for (const name of ["Mine", "Reviewing", "Up for grabs", "Other open"]) {
			const s = section(name);
			within(s).getByRole("img", { name: "Loading" });
			// Never a count of rows still to come.
			expect(within(s).getByRole("heading").textContent).not.toMatch(/\d/);
			expect(within(s).getAllByTestId("row-skeleton").length).toBeGreaterThan(
				0,
			);
			expect(within(s).queryByTestId("section-none")).toBeNull();
		}
		gate.release();
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		expect(within(section("Mine")).getByRole("heading")).toHaveTextContent(
			/Mine\s*1/,
		);
		expect(within(section("Reviewing")).getByRole("heading")).toHaveTextContent(
			/Reviewing\s*0/,
		);
		expect(screen.queryAllByTestId("row-skeleton")).toHaveLength(0);
		within(section("Reviewing")).getByTestId("section-none");
		expect(within(section("Mine")).queryByTestId("section-none")).toBeNull();
	});

	it("before the view answers: placeholders in every section, no counts", async () => {
		const gate = held();
		const api = fakeApi(view(), {
			"GET /api/home": async () => {
				await gate.gate;
				const { sections: _, ...rest } = api.state.home;
				return rest;
			},
		});
		renderWithQuery(<HomePage />);
		await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(5));
		for (const s of screen.getAllByRole("region")) {
			expect(within(s).getByRole("heading").textContent).not.toMatch(/\d/);
			expect(within(s).getAllByTestId("row-skeleton").length).toBeGreaterThan(
				0,
			);
		}
		gate.release();
		await waitFor(() =>
			expect(screen.queryAllByTestId("row-skeleton")).toHaveLength(0),
		);
	});

	it("adding a repo reads only that repo, once the save lands", async () => {
		const api = fakeApi(
			view({ mine: [row({ number: 1, title: "API change" })] }),
			{
				"PUT /api/home/view": (call) => ({
					...api.state.home,
					view: {
						name: "My PRs",
						repos: (call.body as { repos: string[] }).repos,
					},
				}),
			},
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() => expect(repoGets(api.calls)).toHaveLength(2));
		await saveRepos(addRepo("acme/web"));
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/web")).toHaveLength(1),
		);
		// The others aren't asked again.
		expect(repoGets(api.calls)).toHaveLength(3);
	});

	it("removing a repo drops its rows at once and asks nothing; added back, its rows show at once and it is read again, once", async () => {
		const answers: ((r: Response) => void)[] = [];
		const api = fakeApi(
			view({
				mine: [
					row({ number: 1, title: "API change" }),
					row({ repo: "console", number: 2, title: "Console change" }),
				],
			}),
			{
				"PUT /api/home/view": (call) =>
					new Promise<Response>((done) => {
						answers.push(done);
					}).then(() =>
						Response.json({
							...api.state.home,
							view: {
								name: "My PRs",
								repos: (call.body as { repos: string[] }).repos,
							},
						}),
					),
			},
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("Console change");
		await waitFor(() => expect(repoGets(api.calls)).toHaveLength(2));
		await saveRepos(removeRepo("acme/console"));
		// Before the server answers.
		expect(screen.queryByText("Console change")).toBeNull();
		answers.shift()?.(new Response());
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		expect(repoGets(api.calls)).toHaveLength(2);
		await saveRepos(async (dialog) => {
			await userEvent.type(
				within(dialog).getByRole("combobox", { name: "Add a repo" }),
				"acme/console{Enter}",
			);
		});
		// From the cache, with the PUT still out; read again as it was picked.
		expect(screen.getByText("Console change")).toBeInTheDocument();
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/console")).toHaveLength(2),
		);
		answers.shift()?.(new Response());
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		// The save adds no read of its own.
		expect(repoGets(api.calls, "acme/console")).toHaveLength(2);
		expect(repoGets(api.calls, "acme/api")).toHaveLength(1);
	});

	it("Refresh reads every view repo from GitHub now", async () => {
		const api = fakeApi(view({ mine: [row()] }));
		renderWithQuery(<HomePage />);
		await screen.findByText("A change");
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(
				repoGets(api.calls)
					.map((c) => c.url)
					.filter((u) => u.endsWith("?fresh=1"))
					.sort(),
			).toEqual([
				"/api/home/repos/acme/api?fresh=1",
				"/api/home/repos/acme/console?fresh=1",
			]),
		);
		expect(api.calls.some((c) => c.url === "/api/home/refresh")).toBe(false);
	});

	it("an annotation reads only its repo again", async () => {
		const api = fakeApi(
			view({ mine: [row({ number: 1, title: "API change" })] }),
			{
				"POST /api/home/prs/acme/api/1/annotations": () => ({
					...row({ number: 1, title: "API change" }),
					annotations: { note: "later" },
				}),
			},
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() => expect(repoGets(api.calls)).toHaveLength(2));
		const r = screen.getByTestId("home-row");
		await userEvent.hover(r);
		await userEvent.click(within(r).getByRole("button", { name: "Note" }));
		const dialog = screen.getByRole("dialog", { name: "Note" });
		await userEvent.type(within(dialog).getByRole("textbox"), "later");
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/api")).toHaveLength(2),
		);
		expect(repoGets(api.calls, "acme/console")).toHaveLength(1);
	});

	it("coming back to the page reads the repos and the view again once stale", async () => {
		const api = fakeApi(
			view({ mine: [row({ number: 1, title: "API change" })] }),
		);
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() => expect(repoGets(api.calls)).toHaveLength(2));
		const views = () =>
			api.calls.filter((c) => c.method === "GET" && c.url === "/api/home")
				.length;
		const viewsBefore = views();
		// A focus right after the view's answer doesn't ask for it again.
		await act(async () => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
			await Promise.resolve();
		});
		// (A refetch would be under way by now.)
		expect(client.getQueryState(homeQuery.queryKey)?.fetchStatus).toBe("idle");
		expect(views()).toBe(viewsBefore);
		// An hour away (a locked phone): every answer is older than refresh.minutes.
		const old = Date.now() - 3_600_000;
		for (const name of ["acme/api", "acme/console"]) {
			client.setQueryData(repoKey(name), client.getQueryData(repoKey(name)), {
				updatedAt: old,
			});
		}
		client.setQueryData(
			homeQuery.queryKey,
			client.getQueryData(homeQuery.queryKey),
			{
				updatedAt: old,
			},
		);
		act(() => {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
		});
		await waitFor(() => expect(repoGets(api.calls)).toHaveLength(4));
		expect(views()).toBeGreaterThan(viewsBefore);
	});

	it("a repo never read (its first read failed) leaves the counts marked incomplete, never a bare 0 or none", async () => {
		fakeApi(
			view(
				{ mine: [row({ number: 1, title: "API change" })] },
				{
					repos: {
						"acme/console": {
							rows: [],
							refreshedAt: null,
							error: "Rate limited by GitHub",
							failures: 1,
						},
					},
				},
			),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() =>
			expect(chip("acme/console")).toHaveAttribute("data-state", "failed"),
		);
		for (const name of ["Mine", "Reviewing", "Up for grabs"]) {
			const s = section(name);
			// Focusable: a tap on a phone shows why.
			expect(
				within(s).getByRole("img", {
					name: "Without acme/console: Rate limited by GitHub",
				}),
			).toHaveAttribute("tabindex", "0");
			expect(within(s).queryByTestId("section-none")).toBeNull();
		}
		expect(within(section("Mine")).getByRole("heading")).toHaveTextContent(
			/Mine\s*1/,
		);
		expect(screen.queryAllByTestId("row-skeleton")).toHaveLength(0);
	});

	it("a repo that failed after a good read keeps its rows: counts complete, no marker", async () => {
		fakeApi(
			view(
				{ mine: [row({ number: 1, title: "API change" })] },
				{
					repos: {
						"acme/console": { error: "Rate limited by GitHub", failures: 1 },
					},
				},
			),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() =>
			expect(chip("acme/console")).toHaveAttribute("data-state", "failed"),
		);
		expect(
			within(section("Mine")).queryByRole("img", { name: /^Without / }),
		).toBeNull();
		within(section("Reviewing")).getByTestId("section-none");
	});

	it("while a repo still loads, the footers show no numbers either", async () => {
		const gate = held();
		const rows = inOrder([
			...Array.from({ length: 22 }, (_, i) =>
				row({ number: i + 1, title: `PR ${i + 1}` }),
			),
			row({ number: 99, title: "Away", hidden: "snoozed" }),
		]);
		const api = fakeApi(view({ other: rows }), {
			"GET /api/home/repos/acme/console": async () => {
				await gate.gate;
				return repoAnswer(api.state.home, "acme/console");
			},
		});
		renderWithQuery(<HomePage />);
		await screen.findByText("PR 1");
		const other = section("Other open");
		const foot = within(other).getByRole("button", { name: "show more" });
		expect(foot.textContent).not.toMatch(/\d/);
		const hidden = within(other).getByRole("button", { name: "snoozed" });
		expect(hidden.textContent).not.toMatch(/\d/);
		gate.release();
		await within(other).findByRole("button", { name: "show 2 more" });
		within(other).getByRole("button", { name: "1 snoozed" });
	});

	it("a repo added by a save not yet confirmed waits for the save: its chip says so, the counts don't spin for it", async () => {
		const put = held();
		// Its read, started as it was picked, still out too.
		const read = held();
		const api = fakeApi(
			view({ mine: [row({ number: 1, title: "API change" })] }),
			{
				"GET /api/home/repos/acme/web": async () => {
					await read.gate;
					return repoAnswer(api.state.home, "acme/web");
				},
				"PUT /api/home/view": async (call) => {
					await put.gate;
					return {
						...api.state.home,
						view: {
							name: "My PRs",
							repos: (call.body as { repos: string[] }).repos,
						},
					};
				},
			},
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		await saveRepos(addRepo("acme/web"));
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "saving"),
		);
		within(chip("acme/web") as HTMLElement).getByRole("img", {
			name: "Waiting for the save: acme/web",
		});
		expect(within(section("Mine")).getByRole("heading")).toHaveTextContent(
			/Mine\s*1/,
		);
		expect(screen.queryAllByTestId("row-skeleton")).toHaveLength(0);
		// Not read yet: no section claims to be complete or empty.
		for (const name of ["Mine", "Reviewing", "Other open"]) {
			const sign = within(section(name)).getByRole("img", {
				name: "Waiting for the save: acme/web",
			});
			expect(sign).toHaveAttribute("tabindex", "0");
			expect(within(section(name)).queryByTestId("section-none")).toBeNull();
		}
		put.release();
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "loading"),
		);
		read.release();
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "ready"),
		);
		expect(repoGets(api.calls, "acme/web")).toHaveLength(1);
	});

	it("Refresh reads fresh even while a timed read of the repo is out", async () => {
		const gate = held();
		let holdNext = false;
		const api = fakeApi(view({ mine: [row()] }), {
			"GET /api/home/repos/acme/api": async (call) => {
				if (holdNext && !call.url.includes("fresh=1")) {
					holdNext = false;
					await gate.gate;
				}
				return repoAnswer(api.state.home, "acme/api");
			},
		});
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("A change");
		holdNext = true;
		act(() => {
			void client.refetchQueries({ queryKey: repoKey("acme/api") });
		});
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/api")).toHaveLength(2),
		);
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/api").map((c) => c.url)).toContain(
				"/api/home/repos/acme/api?fresh=1",
			),
		);
		gate.release();
	});

	it("a repo re-added is read again as it's picked, and only then, even if the view's own read lands before the save's answer", async () => {
		const put = held();
		const api = fakeApi(
			view({
				mine: [
					row({ number: 1, title: "API change" }),
					row({ repo: "console", number: 2, title: "Console change" }),
				],
			}),
			{
				"PUT /api/home/view": async (call) => {
					const repos = (call.body as { repos: string[] }).repos;
					if (repos.includes("acme/console")) await put.gate;
					return { ...api.state.home, view: { name: "My PRs", repos } };
				},
			},
		);
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("Console change");
		await saveRepos(removeRepo("acme/console"));
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		const before = repoGets(api.calls, "acme/console").length;
		await saveRepos(addRepo("acme/console"));
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/console")).toHaveLength(before + 1),
		);
		// The server stored it; the view's timed read says so before the PUT answers.
		api.state.home = {
			...api.state.home,
			view: { name: "My PRs", repos: ["acme/api", "acme/console"] },
		};
		await act(() => client.refetchQueries({ queryKey: homeQuery.queryKey }));
		put.release();
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		expect(repoGets(api.calls, "acme/console")).toHaveLength(before + 1);
	});
});

// Owner, 2026-11-02: "after a repo is selected into the view, the tanstack
// query for it should start populating in the background. That way, by the
// time I hit save it could be ready or almost ready."
describe("a repo picked in the view settings", () => {
	/** The view with acme/web's rows, PUT storing what it's sent. */
	function pickApi(handlers: Parameters<typeof fakeApi>[1] = {}) {
		const api = fakeApi(
			view({
				mine: [
					row({ number: 1, title: "API change" }),
					row({ repo: "web", number: 3, title: "Web change" }),
				],
			}),
			{
				"PUT /api/home/view": (call) => {
					const repos = (call.body as { repos: string[] }).repos;
					api.state.home = {
						...api.state.home,
						view: { name: "My PRs", repos },
					};
					const { sections: _, repos: __, ...rest } = api.state.home;
					return rest;
				},
				...handlers,
			},
		);
		return api;
	}
	async function openSettings() {
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		return screen.getByRole("dialog", { name: "My PRs" });
	}
	/** Nothing of acme/web on the page: no chip, row or spinner for it. */
	function nothingShown() {
		expect(chip("acme/web")).toBeUndefined();
		expect(screen.queryByText("Web change")).toBeNull();
		expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
	}

	it("starts its read as it's picked, shows nothing until saved, and the save uses that answer", async () => {
		const gate = held();
		const api = pickApi({
			"GET /api/home/repos/acme/web": async () => {
				await gate.gate;
				return repoAnswer(api.state.home, "acme/web");
			},
		});
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		const dialog = await openSettings();
		// Typing alone asks nothing; accepting the chip does.
		const field = within(dialog).getByRole("combobox", { name: "Add a repo" });
		await userEvent.type(field, "acme/web");
		expect(repoGets(api.calls, "acme/web")).toHaveLength(0);
		await userEvent.type(field, "{Enter}");
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/web")).toHaveLength(1),
		);
		expect(repoGets(api.calls, "acme/web")[0]?.url).toBe(
			"/api/home/repos/acme/web",
		);
		nothingShown();
		gate.release();
		await waitFor(() =>
			expect(api.fetch.mock.results.length).toBe(api.calls.length),
		);
		nothingShown();
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(await screen.findByText("Web change")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "ready"),
		);
		expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
		expect(repoGets(api.calls, "acme/web")).toHaveLength(1);
	});

	it("saved while its read is still out: the page joins that read", async () => {
		const gate = held();
		const api = pickApi({
			"GET /api/home/repos/acme/web": async () => {
				await gate.gate;
				return repoAnswer(api.state.home, "acme/web");
			},
		});
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		const dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "loading"),
		);
		gate.release();
		expect(await screen.findByText("Web change")).toBeInTheDocument();
		expect(repoGets(api.calls, "acme/web")).toHaveLength(1);
	});

	it("a pick GitHub doesn't know fails quietly; saving it reads again, fresh, and then says why", async () => {
		const api = pickApi();
		api.state.home = {
			...api.state.home,
			repos: {
				"acme/nowhere": {
					rows: [],
					refreshedAt: null,
					error: "Not found on GitHub",
					failures: 1,
				},
			},
		};
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		const dialog = await openSettings();
		await addRepo("acme/nowhere")(dialog);
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/nowhere")).toHaveLength(1),
		);
		await waitFor(() =>
			expect(api.fetch.mock.results.length).toBe(api.calls.length),
		);
		// Quietly: nothing on the page says it failed.
		expect(screen.queryByText(/Not found on GitHub/)).toBeNull();
		expect(
			screen.queryByRole("img", { name: /Not found on GitHub/ }),
		).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/nowhere").map((c) => c.url)).toEqual([
				"/api/home/repos/acme/nowhere",
				"/api/home/repos/acme/nowhere?fresh=1",
			]),
		);
		await waitFor(() =>
			expect(chip("acme/nowhere")).toHaveAttribute("data-state", "failed"),
		);
		within(section("Mine")).getByRole("img", {
			name: "Without acme/nowhere: Not found on GitHub",
		});
	});

	it("a pick whose read fails after the save landed is read again, fresh, never shown failed meanwhile", async () => {
		const first = held();
		const second = held();
		const failed = {
			repo: "acme/nowhere",
			rows: [],
			refreshedAt: null,
			error: "Not found on GitHub",
			failures: 1,
		};
		const api = pickApi({
			"GET /api/home/repos/acme/nowhere": async (call) => {
				await (call.url.endsWith("fresh=1") ? second : first).gate;
				return failed;
			},
		});
		renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		const dialog = await openSettings();
		await addRepo("acme/nowhere")(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		first.release();
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/nowhere").map((c) => c.url)).toEqual([
				"/api/home/repos/acme/nowhere",
				"/api/home/repos/acme/nowhere?fresh=1",
			]),
		);
		// The pick's failure isn't the saved repo's answer: still loading.
		expect(chip("acme/nowhere")).toHaveAttribute("data-state", "loading");
		second.release();
		await waitFor(() =>
			expect(chip("acme/nowhere")).toHaveAttribute("data-state", "failed"),
		);
	});

	it("removed from the draft, or the settings cancelled: nothing on the page; picked again, its answer is there at once", async () => {
		const api = pickApi();
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		let dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await waitFor(() =>
			expect(client.getQueryData(repoKey("acme/web"))).toBeDefined(),
		);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/web" }),
		);
		nothingShown();
		await addRepo("acme/web")(dialog);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		nothingShown();
		expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
		// Picked and saved again later: its rows show at once, from the cache.
		dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(screen.getByText("Web change")).toBeInTheDocument();
	});

	it("a pick removed from the draft, or the settings cancelled, is forgotten: a later save reads it like any added repo", async () => {
		pickApi();
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		let dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		expect(isPicked(client, "acme/web")).toBe(true);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/web" }),
		);
		expect(isPicked(client, "acme/web")).toBe(false);
		await addRepo("acme/web")(dialog);
		await addRepo("acme/infra")(dialog);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		expect(isPicked(client, "acme/web")).toBe(false);
		expect(isPicked(client, "acme/infra")).toBe(false);
		dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await userEvent.keyboard("{Escape}");
		expect(isPicked(client, "acme/web")).toBe(false);
		// Saved: the pick stays until the save's answer settles it.
		dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		expect(isPicked(client, "acme/web")).toBe(false);
		expect(chip("acme/web")).toBeDefined();
	});

	it("cancelling the settings while an earlier save is out keeps that save's pick: still one read", async () => {
		const put = held();
		const api = pickApi({
			"PUT /api/home/view": async (call) => {
				await put.gate;
				const repos = (call.body as { repos: string[] }).repos;
				api.state.home = { ...api.state.home, view: { name: "My PRs", repos } };
				const { sections: _, repos: __, ...rest } = api.state.home;
				return rest;
			},
		});
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		let dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		dialog = await openSettings();
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		expect(isPicked(client, "acme/web")).toBe(true);
		put.release();
		await waitFor(() =>
			expect(chip("acme/web")).toHaveAttribute("data-state", "ready"),
		);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Loading" })).toBeNull(),
		);
		expect(repoGets(api.calls, "acme/web")).toHaveLength(1);
	});

	it("a pick's read is cancellable (Refresh drops a read that's out)", async () => {
		const gate = held();
		const api = pickApi({
			"GET /api/home/repos/acme/web": async () => {
				await gate.gate;
				return repoAnswer(api.state.home, "acme/web");
			},
		});
		const { client } = renderWithQuery(<HomePage />);
		await screen.findByText("API change");
		const dialog = await openSettings();
		await addRepo("acme/web")(dialog);
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/web")).toHaveLength(1),
		);
		const i = api.calls.findIndex((c) =>
			c.url.startsWith("/api/home/repos/acme/web"),
		);
		const signal = (api.fetch.mock.calls[i]?.[1] as RequestInit | undefined)
			?.signal;
		expect(signal?.aborted).toBe(false);
		await act(() => client.cancelQueries({ queryKey: repoKey("acme/web") }));
		expect(signal?.aborted).toBe(true);
		gate.release();
	});
});
