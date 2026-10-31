// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../shared/home";
import { HomePage } from "./HomePage";
import {
	ago,
	type Call,
	emptySearch,
	fakeApi,
	renderWithQuery,
	row,
	view,
} from "./testing";
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
		const field = within(dialog).getByRole("combobox", { name: "Add a repo" });
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
			within(dialog).getByRole("combobox", { name: "Add a repo" }),
			"acme/api{Enter}",
		);
		expect(
			within(
				within(dialog).getByRole("list", { name: "Repos in this view" }),
			).getAllByRole("listitem"),
		).toHaveLength(1);
	});

	describe("repo suggestions", () => {
		const repos = (names: string[], reposPending = false): SearchResult => ({
			...emptySearch,
			repos: names.map((name) => ({
				name,
				inView: name === "acme/api",
				openCount: null,
			})),
			// Ignored: the input suggests repos only.
			prs: [
				{
					owner: "acme",
					repo: "api",
					number: 3,
					title: "A console PR",
					author: { login: "noa", avatarUrl: "" },
					state: "OPEN",
					updatedAt: ago(3),
					hidden: null,
				},
			],
			pending: reposPending,
			reposPending,
		});
		const open = async (answer: (q: string) => SearchResult) => {
			const api = fakeApi(view(), {
				"GET /api/home/search": (call: Call) =>
					answer(new URL(call.url, "http://x").searchParams.get("q") ?? ""),
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
			const field = within(dialog).getByRole("combobox", {
				name: "Add a repo",
			});
			return { api, dialog, field };
		};
		const listed = (dialog: HTMLElement) =>
			within(within(dialog).getByRole("list", { name: "Repos in this view" }))
				.getAllByRole("listitem")
				.map((li) => li.textContent);

		it("suggests the viewer's repos as you type, repos only, minus the listed ones; arrows and Enter add one", async () => {
			const all = ["acme/api", "acme/apiary", "acme/console", "acme/connect"];
			const { api, dialog, field } = await open((q) =>
				repos(all.filter((n) => n.includes(q))),
			);
			await userEvent.type(field, "con");
			const list = await within(dialog).findByRole("listbox");
			expect(field).toHaveAttribute("aria-expanded", "true");
			expect(field).toHaveAttribute("aria-controls", list.id);
			const group = within(list).getByRole("group", { name: "Repos" });
			// acme/console is in the view already.
			expect(
				within(group)
					.getAllByRole("option")
					.map((o) => o.textContent),
			).toEqual(["acme/connect"]);
			expect(
				within(list).queryByRole("group", { name: "Pull requests" }),
			).toBeNull();
			const asked = api.calls.filter((c) =>
				c.url.startsWith("/api/home/search"),
			);
			expect(
				new URL(asked.at(-1)?.url ?? "", "http://x").searchParams.get("only"),
			).toBe("repos");
			// Typed text that isn't a repo: nothing highlighted until the arrows.
			expect(within(group).getByRole("option")).toHaveAttribute(
				"aria-selected",
				"false",
			);
			await userEvent.keyboard("{ArrowDown}");
			expect(field).toHaveAttribute(
				"aria-activedescendant",
				within(group).getByRole("option").id,
			);
			await userEvent.keyboard("{Enter}");
			expect(listed(dialog)).toEqual([
				"acme/api",
				"acme/console",
				"acme/connect",
			]);
			expect(field).toHaveValue("");
			// A click adds one too.
			await userEvent.type(field, "api");
			await userEvent.click(
				await within(dialog).findByRole("option", { name: "acme/apiary" }),
			);
			expect(listed(dialog)).toContain("acme/apiary");
		});

		it("a typed owner/repo that isn't suggested is still added; Escape closes the list, not the dialog", async () => {
			const { dialog, field } = await open(() => repos(["acme/zebra"]));
			await userEvent.type(field, "acme/zed");
			await within(dialog).findByRole("listbox");
			await userEvent.keyboard("{Escape}");
			expect(within(dialog).queryByRole("listbox")).toBeNull();
			expect(
				screen.getByRole("dialog", { name: "My PRs" }),
			).toBeInTheDocument();
			await userEvent.keyboard("{ArrowDown}");
			await within(dialog).findByRole("listbox");
			await userEvent.keyboard("{Escape}{Enter}");
			expect(listed(dialog)).toContain("acme/zed");
		});

		it("spins while the viewer's repos load", async () => {
			const { dialog, field } = await open(() => repos(["acme/console"], true));
			await userEvent.type(field, "c");
			const group = await within(dialog).findByRole("group", { name: "Repos" });
			expect(group).toHaveAttribute("aria-busy", "true");
			expect(group.querySelector(".animate-spin")).not.toBeNull();
		});
	});
});
