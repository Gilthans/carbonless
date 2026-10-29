// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import { ago, fakeApi, renderWithQuery, row, view } from "./testing";
import { parseRepo, suggestedRepos } from "./ViewSettings";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const started = (owner: string, repo: string, number: number) =>
	row({
		owner,
		repo,
		number,
		reviews: [
			{
				id: `R${number}`,
				label: "head",
				pinnedHead: null,
				coverage: { done: 1, total: 2, unit: "lines" },
				lastActedAt: ago(5),
				headMoved: false,
			},
		],
	});

describe("parseRepo", () => {
	it("takes owner/repo or a GitHub URL, lowercased", () => {
		expect(parseRepo(" Acme/API ")).toBe("acme/api");
		expect(parseRepo("https://github.com/acme/api")).toBe("acme/api");
		expect(parseRepo("github.com/acme/api.git")).toBe("acme/api");
		expect(parseRepo("https://github.com/acme/api/pull/12")).toBe("acme/api");
		expect(parseRepo("acme")).toBeNull();
		expect(parseRepo("acme/api/extra")).toBeNull();
		expect(parseRepo("https://example.com/acme/api")).toBeNull();
		expect(parseRepo("")).toBeNull();
	});
});

describe("suggestedRepos", () => {
	it("lists repos of started reviews outside the view, once each", () => {
		const home = view({
			mine: [started("far", "away", 1), started("acme", "api", 2)],
			reviewing: [started("Far", "Away", 3), row({ owner: "x", repo: "y" })],
		});
		expect(suggestedRepos(home)).toEqual(["far/away"]);
	});
});

describe("ViewSettings", () => {
	it("removes, adds by URL or suggestion, and saves through PUT /api/home/view", async () => {
		const api = fakeApi(view({ mine: [started("far", "away", 1)] }), {
			"PUT /api/home/view": (call) =>
				view(
					{},
					{
						view: {
							name: "My PRs",
							repos: (call.body as { repos: string[] }).repos,
						},
					},
				),
		});
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/console" }),
		);
		const field = within(dialog).getByRole("textbox", { name: "Add a repo" });
		await userEvent.type(field, "nope{Enter}");
		expect(field).toHaveAttribute("aria-invalid", "true");
		await userEvent.clear(field);
		await userEvent.type(field, "https://github.com/Acme/Web{Enter}");
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Add far/away" }),
		);
		expect(
			within(within(dialog).getByRole("list", { name: "Repos in this view" }))
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["acme/api", "acme/web", "far/away"]);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
				repos: ["acme/api", "acme/web", "far/away"],
			}),
		);
		// The answer is the page's new view.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("acme/web")).toBeInTheDocument();
	});

	it("Cancel keeps the view as it was", async () => {
		const api = fakeApi(view());
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/api" }),
		);
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
		expect(screen.getByText("acme/api")).toBeInTheDocument();
	});

	it("compares repos without case, so a hand-edited Acme/API isn't added twice", async () => {
		fakeApi(view({}, { view: { name: "My PRs", repos: ["Acme/API"] } }));
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.type(
			within(dialog).getByRole("textbox", { name: "Add a repo" }),
			"acme/api{Enter}",
		);
		expect(
			within(
				within(dialog).getByRole("list", { name: "Repos in this view" }),
			).getAllByRole("listitem"),
		).toHaveLength(1);
	});
});
