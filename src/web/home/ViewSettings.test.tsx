// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
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

/** The view's repo chips on Home. */
const chips = () =>
	screen.queryAllByTestId("view-repo").map((c) => c.textContent);

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
	it("lists the server's started-review repos the view doesn't, in its order", () => {
		// As the server sends it: no rows outside the view, the repos apart.
		const home = view(
			{ mine: [started("acme", "api", 2)] },
			{ startedRepos: ["far/away", "acme/api", "near/by"] },
		);
		expect(suggestedRepos(home)).toEqual(["far/away", "near/by"]);
	});
});

describe("ViewSettings", () => {
	it("removes, adds by URL or suggestion, and saves through PUT /api/home/view", async () => {
		const api = fakeApi(view({}, { startedRepos: ["far/away"] }), {
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

	it("a removed repo of a started review comes back as a one-click chip", async () => {
		fakeApi(
			view(
				{ reviewing: [started("acme", "console", 3)] },
				{ startedRepos: ["acme/console"] },
			),
			{
				"PUT /api/home/view": () => new Promise<Response>(() => {}),
			},
		);
		renderWithQuery(<HomePage />);
		const edit = async () => {
			await userEvent.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			return screen.getByRole("dialog", { name: "My PRs" });
		};
		let dialog = await edit();
		expect(
			within(dialog).queryByRole("list", { name: "Suggested" }),
		).toBeNull();
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/console" }),
		);
		// Within the dialog too, before Save.
		expect(
			within(dialog).getByRole("button", { name: "Add acme/console" }),
		).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		dialog = await edit();
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Add acme/console" }),
		);
		expect(
			within(within(dialog).getByRole("list", { name: "Repos in this view" }))
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["acme/api", "acme/console"]);
	});

	it("Save closes at once and shows the new view: removed rows go before the server answers, started ones too, a spinner while it saves", async () => {
		let answer: (r: Response) => void = () => {};
		const api = fakeApi(
			view({
				mine: [
					row({ number: 1, title: "API change" }),
					row({ repo: "console", number: 2, title: "Console change" }),
				],
				reviewing: [started("acme", "console", 3), started("acme", "api", 4)],
			}),
			{
				"PUT /api/home/view": () =>
					new Promise<Response>((done) => {
						answer = done;
					}),
			},
		);
		const { client } = renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/console" }),
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		// At once, with the PUT still out.
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByText("Console change")).toBeNull();
		expect(screen.getByText("API change")).toBeInTheDocument();
		// A started PR of the removed repo goes too (owner, 2026-11-01: "only
		// prs from the selected repos should appear"); one of a kept repo stays.
		expect(screen.queryByText("#3")).toBeNull();
		expect(screen.getByText("#4")).toBeInTheDocument();
		expect(chips()).toEqual(["acme/api"]);
		expect(screen.getByRole("status", { name: "Saving" })).toBeInTheDocument();
		expect(api.calls.find((c) => c.method === "PUT")?.body).toEqual({
			repos: ["acme/api"],
		});
		// A read of the old view meanwhile doesn't bring the rows back.
		await client.refetchQueries({ queryKey: ["home"] });
		expect(screen.queryByText("Console change")).toBeNull();
		expect(screen.queryByText("#3")).toBeNull();
		answer(
			Response.json(
				view(
					{ mine: [row({ number: 1, title: "API change" })] },
					{ view: { name: "My PRs", repos: ["acme/api"] } },
				),
			),
		);
		await waitFor(() =>
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
		);
		expect(screen.queryByText("Console change")).toBeNull();
		expect(screen.queryByTestId("save-delayed")).toBeNull();
	});

	it("an unconfirmed save shows the delayed warning after 5 s, gone once it lands", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let answer: (r: Response) => void = () => {};
			fakeApi(view(), {
				"PUT /api/home/view": () =>
					new Promise<Response>((done) => {
						answer = done;
					}),
			});
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			renderWithQuery(<HomePage />);
			await user.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await user.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			await act(() => vi.advanceTimersByTimeAsync(4000));
			expect(screen.queryByTestId("save-delayed")).toBeNull();
			await act(() => vi.advanceTimersByTimeAsync(1500));
			expect(screen.getByTestId("save-delayed")).toHaveTextContent(
				"Saving My PRs…",
			);
			expect(
				screen.getByRole("img", { name: "Saving is delayed" }),
			).toBeInTheDocument();
			answer(
				Response.json(
					view({}, { view: { name: "My PRs", repos: ["acme/api"] } }),
				),
			);
			await waitFor(() =>
				expect(screen.queryByTestId("save-delayed")).toBeNull(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a transient failure on its own, saying why it waits", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let failing = true;
			const api = fakeApi(view(), {
				"PUT /api/home/view": () =>
					failing
						? new Response(JSON.stringify({ error: "busy" }), { status: 503 })
						: view({}, { view: { name: "My PRs", repos: ["acme/api"] } }),
			});
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			renderWithQuery(<HomePage />);
			await user.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await user.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			await act(() => vi.advanceTimersByTimeAsync(5500));
			const puts = () => api.calls.filter((c) => c.method === "PUT").length;
			expect(puts()).toBeGreaterThanOrEqual(2);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.getByTestId("save-delayed")).toHaveTextContent("busy");
			// Still the new view meanwhile.
			expect(chips()).toEqual(["acme/api"]);
			failing = false;
			await act(() => vi.advanceTimersByTimeAsync(8000));
			await waitFor(() =>
				expect(screen.queryByTestId("save-delayed")).toBeNull(),
			);
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a refused save says why and restores the last saved view; Retry sends it again", async () => {
		let refuse = true;
		const api = fakeApi(
			view({
				mine: [row({ repo: "console", number: 2, title: "Console change" })],
			}),
			{
				"PUT /api/home/view": (call) =>
					refuse
						? new Response(
								JSON.stringify({
									error: "Repository acme/nope not found on GitHub",
								}),
								{ status: 400 },
							)
						: view(
								{},
								{
									view: {
										name: "My PRs",
										repos: (call.body as { repos: string[] }).repos,
									},
								},
							),
			},
		);
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Remove acme/console" }),
		);
		await userEvent.type(
			within(dialog).getByRole("combobox", { name: "Add a repo" }),
			"acme/nope{Enter}",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		const failed = await screen.findByTestId("view-save-failed");
		expect(failed).toHaveRole("alert");
		expect(failed).toHaveTextContent(
			"Repository acme/nope not found on GitHub",
		);
		// The last saved view, rows and chips.
		expect(screen.getByText("Console change")).toBeInTheDocument();
		expect(chips()).toEqual(["acme/api", "acme/console"]);
		expect(screen.queryByRole("status", { name: "Saving" })).toBeNull();
		// Refused: never sent again on its own.
		expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
		refuse = false;
		await userEvent.click(
			within(failed).getByRole("button", { name: "Retry saving" }),
		);
		await waitFor(() =>
			expect(screen.queryByTestId("view-save-failed")).toBeNull(),
		);
		expect(api.calls.filter((c) => c.method === "PUT").at(-1)?.body).toEqual({
			repos: ["acme/api", "acme/nope"],
		});
		await waitFor(() => expect(chips()).toEqual(["acme/api", "acme/nope"]));
	});

	describe("two saves in a row", () => {
		/** PUTs answer in turn: `answers[i]` for the i-th, held until called. */
		function twoSaves() {
			const held: ((r: Response) => void)[] = [];
			const api = fakeApi(view(), {
				"PUT /api/home/view": () =>
					new Promise<Response>((done) => {
						held.push(done);
					}),
			});
			const bodies = () =>
				api.calls
					.filter((c) => c.method === "PUT")
					.map((c) => (c.body as { repos: string[] }).repos);
			return { api, held, bodies };
		}
		async function edit(change: (dialog: HTMLElement) => Promise<void>) {
			await userEvent.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await change(dialog);
			await userEvent.click(
				within(dialog).getByRole("button", { name: "Save" }),
			);
		}
		const removeConsole = (dialog: HTMLElement) =>
			userEvent.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
		const addWeb = (dialog: HTMLElement) =>
			userEvent.type(
				within(dialog).getByRole("combobox", { name: "Add a repo" }),
				"acme/web{Enter}",
			);
		const saved = (repos: string[]) =>
			Response.json(view({}, { view: { name: "My PRs", repos } }));

		it("the first refused while the second waits: no card, the second lands, the first never again", async () => {
			const { held, bodies } = twoSaves();
			renderWithQuery(<HomePage />);
			await edit(removeConsole);
			await waitFor(() => expect(held).toHaveLength(1));
			await edit(addWeb);
			expect(chips()).toEqual(["acme/api", "acme/web"]);
			held[0]?.(
				new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
			);
			await waitFor(() => expect(held).toHaveLength(2));
			held[1]?.(saved(["acme/api", "acme/web"]));
			await waitFor(() =>
				expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
			);
			expect(screen.queryByTestId("view-save-failed")).toBeNull();
			expect(chips()).toEqual(["acme/api", "acme/web"]);
			expect(bodies()).toEqual([["acme/api"], ["acme/api", "acme/web"]]);
		});

		it("the first failing transiently while the second waits: the newest goes next, the first never again", async () => {
			const { held, bodies } = twoSaves();
			renderWithQuery(<HomePage />);
			await edit(removeConsole);
			await waitFor(() => expect(held).toHaveLength(1));
			await edit(addWeb);
			held[0]?.(
				new Response(JSON.stringify({ error: "busy" }), { status: 503 }),
			);
			await waitFor(() => expect(held).toHaveLength(2));
			held[1]?.(saved(["acme/api", "acme/web"]));
			await waitFor(() =>
				expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
			);
			await new Promise((r) => setTimeout(r, 1500));
			expect(bodies()).toEqual([["acme/api"], ["acme/api", "acme/web"]]);
			expect(chips()).toEqual(["acme/api", "acme/web"]);
		});

		it("the first lands while the second waits: the second stays shown, then lands", async () => {
			const { held, bodies } = twoSaves();
			renderWithQuery(<HomePage />);
			await edit(removeConsole);
			await waitFor(() => expect(held).toHaveLength(1));
			await edit(addWeb);
			held[0]?.(saved(["acme/api"]));
			await waitFor(() => expect(held).toHaveLength(2));
			// The first's answer is in, the newer list still over it.
			expect(chips()).toEqual(["acme/api", "acme/web"]);
			expect(
				screen.getByRole("status", { name: "Saving" }),
			).toBeInTheDocument();
			held[1]?.(saved(["acme/api", "acme/web"]));
			await waitFor(() =>
				expect(screen.queryByRole("status", { name: "Saving" })).toBeNull(),
			);
			expect(chips()).toEqual(["acme/api", "acme/web"]);
			expect(screen.queryByTestId("view-save-failed")).toBeNull();
			expect(bodies()).toEqual([["acme/api"], ["acme/api", "acme/web"]]);
		});

		it("a refusal shown, then a newer save: the card goes, and its Retry can't come back", async () => {
			const { held } = twoSaves();
			renderWithQuery(<HomePage />);
			await edit(removeConsole);
			await waitFor(() => expect(held).toHaveLength(1));
			held[0]?.(
				new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
			);
			await screen.findByTestId("view-save-failed");
			await edit(addWeb);
			expect(screen.queryByTestId("view-save-failed")).toBeNull();
		});
	});

	it("a long outage keeps retrying behind the red 'still retrying' card and never rolls the view back", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let failing = true;
			const api = fakeApi(view(), {
				"PUT /api/home/view": () =>
					failing
						? new Response(JSON.stringify({ error: "busy" }), { status: 503 })
						: view({}, { view: { name: "My PRs", repos: ["acme/api"] } }),
			});
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			renderWithQuery(<HomePage />);
			await user.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await user.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			const puts = () => api.calls.filter((c) => c.method === "PUT").length;
			// 1 + 2 + 4 + 8 s of backoff: the 5th failure.
			await act(() => vi.advanceTimersByTimeAsync(16_000));
			const stalled = screen.getByTestId("view-save-stalled");
			expect(stalled).toHaveRole("alert");
			expect(stalled).toHaveTextContent("busy");
			expect(
				within(stalled).getByRole("img", {
					name: "Not saved yet, still retrying",
				}),
			).toBeInTheDocument();
			expect(screen.queryByTestId("save-delayed")).toBeNull();
			// A minute more: still the new view, still asking.
			const n = puts();
			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(puts()).toBeGreaterThan(n);
			expect(chips()).toEqual(["acme/api"]);
			expect(screen.queryByTestId("view-save-failed")).toBeNull();
			expect(
				screen.getByRole("status", { name: "Saving" }),
			).toBeInTheDocument();
			failing = false;
			await act(() => vi.advanceTimersByTimeAsync(31_000));
			await waitFor(() =>
				expect(screen.queryByTestId("view-save-stalled")).toBeNull(),
			);
			expect(chips()).toEqual(["acme/api"]);
			expect(screen.queryByRole("status", { name: "Saving" })).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("Retry on the 'still retrying' card starts over: not red, the next wait 1 s", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const api = fakeApi(view(), {
				"PUT /api/home/view": () =>
					new Response(JSON.stringify({ error: "busy" }), { status: 503 }),
			});
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			renderWithQuery(<HomePage />);
			await user.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await user.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			await act(() => vi.advanceTimersByTimeAsync(16_000));
			const puts = () => api.calls.filter((c) => c.method === "PUT").length;
			await user.click(
				within(screen.getByTestId("view-save-stalled")).getByRole("button", {
					name: "Retry saving",
				}),
			);
			const n = await waitFor(() => {
				const now = puts();
				expect(screen.queryByTestId("view-save-stalled")).toBeNull();
				return now;
			});
			await act(() => vi.advanceTimersByTimeAsync(1100));
			expect(puts()).toBeGreaterThan(n);
		} finally {
			vi.useRealTimers();
		}
	});

	it("Retry on the 'still retrying' card asks at once", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			let failing = true;
			const api = fakeApi(view(), {
				"PUT /api/home/view": () =>
					failing
						? new Response(JSON.stringify({ error: "busy" }), { status: 503 })
						: view({}, { view: { name: "My PRs", repos: ["acme/api"] } }),
			});
			const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
			renderWithQuery(<HomePage />);
			await user.click(
				await screen.findByRole("button", { name: "Edit repos" }),
			);
			const dialog = screen.getByRole("dialog", { name: "My PRs" });
			await user.click(
				within(dialog).getByRole("button", { name: "Remove acme/console" }),
			);
			await user.click(within(dialog).getByRole("button", { name: "Save" }));
			await act(() => vi.advanceTimersByTimeAsync(16_000));
			const stalled = screen.getByTestId("view-save-stalled");
			failing = false;
			const n = api.calls.filter((c) => c.method === "PUT").length;
			await user.click(
				within(stalled).getByRole("button", { name: "Retry saving" }),
			);
			await waitFor(() =>
				expect(api.calls.filter((c) => c.method === "PUT").length).toBe(n + 1),
			);
			await waitFor(() =>
				expect(screen.queryByTestId("view-save-stalled")).toBeNull(),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("Dismiss drops a refused save", async () => {
		fakeApi(view(), {
			"PUT /api/home/view": () =>
				new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
		});
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Edit repos" }),
		);
		const dialog = screen.getByRole("dialog", { name: "My PRs" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		const failed = await screen.findByTestId("view-save-failed");
		await userEvent.click(
			within(failed).getByRole("button", { name: "Dismiss" }),
		);
		expect(screen.queryByTestId("view-save-failed")).toBeNull();
	});

	it("opens with an empty repo input each time, whatever was typed before Cancel", async () => {
		fakeApi(view());
		renderWithQuery(<HomePage />);
		const edit = await screen.findByRole("button", { name: "Edit repos" });
		await userEvent.click(edit);
		let dialog = screen.getByRole("dialog", { name: "My PRs" });
		let field = within(dialog).getByRole("combobox", { name: "Add a repo" });
		await userEvent.type(field, "garbage{Enter}");
		expect(field).toHaveAttribute("aria-invalid", "true");
		await userEvent.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);
		await userEvent.click(edit);
		dialog = screen.getByRole("dialog", { name: "My PRs" });
		field = within(dialog).getByRole("combobox", { name: "Add a repo" });
		expect(field).toHaveValue("");
		expect(field).not.toHaveAttribute("aria-invalid");
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
			// A spinner until the answer is in, then its options.
			await within(group).findByRole("option");
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
			await within(dialog).findByRole("option");
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

		it("spins while the answer for what's typed is coming; an empty answer says no matches", async () => {
			let release: () => void = () => {};
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const { dialog, field } = await open(
				() => gate.then(() => repos([])) as unknown as SearchResult,
			);
			await userEvent.type(field, "zzz");
			const group = await within(dialog).findByRole("group", { name: "Repos" });
			expect(group).toHaveAttribute("aria-busy", "true");
			expect(within(dialog).queryByTestId("suggestions-empty")).toBeNull();
			release();
			expect(
				await within(dialog).findByTestId("suggestions-empty"),
			).toHaveTextContent("No matches");
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
