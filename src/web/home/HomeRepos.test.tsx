// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import {
	type Call,
	fakeApi,
	held,
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

	it("removing a repo drops its rows at once and asks nothing; added back, its rows show at once and it is read again", async () => {
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
		// From the cache, with the PUT still out.
		expect(screen.getByText("Console change")).toBeInTheDocument();
		expect(repoGets(api.calls, "acme/console")).toHaveLength(1);
		answers.shift()?.(new Response());
		await waitFor(() =>
			expect(repoGets(api.calls, "acme/console")).toHaveLength(2),
		);
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
});
