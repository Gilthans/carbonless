// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../shared/home";
import { ShortcutsProvider } from "../shortcuts";
import { goTo } from "./homeApi";
import { OpenBox } from "./OpenBox";
import { parseOpenInput } from "./openInput";
import {
	ago,
	type Call,
	emptySearch,
	fakeApi,
	person,
	renderWithQuery,
	shownTooltip,
	view,
} from "./testing";

vi.mock("./homeApi", async (original) => ({
	...(await original<typeof import("./homeApi")>()),
	goTo: vi.fn(),
}));

beforeEach(() => vi.mocked(goTo).mockClear());
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const pr = (
	repo: string,
	number: number,
	title: string,
	over: Partial<SearchResult["prs"][number]> = {},
): SearchResult["prs"][number] => {
	const [owner = "", name = ""] = repo.split("/");
	return {
		owner,
		repo: name,
		number,
		title,
		author: person("noa"),
		state: "OPEN",
		updatedAt: ago(12),
		hidden: null,
		...over,
	};
};

/** The search answers by query; each call is recorded. */
function setup(answer: (q: string) => SearchResult) {
	const api = fakeApi(view(), {
		"GET /api/home/search": (call: Call) =>
			answer(new URL(call.url, "http://x").searchParams.get("q") ?? ""),
	});
	renderWithQuery(
		<ShortcutsProvider>
			<OpenBox />
		</ShortcutsProvider>,
	);
	return api;
}

const searches = (api: ReturnType<typeof setup>) =>
	api.calls
		.filter((c) => c.url.startsWith("/api/home/search"))
		.map((c) => new URL(c.url, "http://x").searchParams.get("q"));

const mixed = (q: string): SearchResult =>
	q.startsWith("acme/console ")
		? {
				repos: [],
				prs: [
					pr("acme/console", 920, "Side-by-side diff"),
					pr("acme/console", 884, "Collapse the sidebar", {
						state: "MERGED",
					}),
				].filter((p) =>
					q
						.slice("acme/console ".length)
						.trim()
						.split(/\s+/)
						.filter(Boolean)
						.every((w) => p.title.toLowerCase().includes(w)),
				),
				scope: "acme/console",
				pending: false,
				reposPending: false,
			}
		: {
				repos: [
					{ name: "acme/console", inView: true, openCount: 7 },
					{ name: "acme/connect", inView: false, openCount: null },
				],
				prs: [
					pr("acme/api", 4812, "Consolidate config loaders"),
					pr("acme/api", 4790, "Rename tenant", { hidden: "snoozed" }),
				],
				scope: null,
				pending: false,
				reposPending: false,
			};

const box = () => screen.getByRole("combobox", { name: "Open a pull request" });

describe("parseOpenInput", () => {
	it("reads URLs, owner/repo#n, a repo with words, a number after a repo, and free text", () => {
		expect(parseOpenInput("https://github.com/Acme/API/pull/12/files")).toEqual(
			{ kind: "pr", owner: "Acme", repo: "API", number: 12 },
		);
		expect(parseOpenInput("acme/api#12")).toEqual({
			kind: "pr",
			owner: "acme",
			repo: "api",
			number: 12,
		});
		expect(parseOpenInput("acme/api #9")).toMatchObject({
			kind: "pr",
			number: 9,
		});
		expect(parseOpenInput("acme/api 9")).toMatchObject({
			kind: "pr",
			number: 9,
		});
		expect(parseOpenInput("acme/api side diff")).toEqual({
			kind: "scoped",
			repo: "acme/api",
			words: "side diff",
		});
		expect(parseOpenInput("acme/api ")).toEqual({
			kind: "scoped",
			repo: "acme/api",
			words: "",
		});
		expect(parseOpenInput("acme/api")).toEqual({
			kind: "text",
			text: "acme/api",
		});
		expect(parseOpenInput("  con ")).toEqual({ kind: "text", text: "con" });
	});

	it("a bare number, with or without #, is a number; 0 or 10 digits stay text", () => {
		for (const q of ["123", "#123", "  123 ", " #123"]) {
			expect(parseOpenInput(q), q).toEqual({
				kind: "number",
				number: 123,
				text: q.trim(),
			});
		}
		expect(parseOpenInput("0")).toEqual({ kind: "text", text: "0" });
		expect(parseOpenInput("1234567890")).toMatchObject({ kind: "text" });
		expect(parseOpenInput("#12a")).toMatchObject({ kind: "text" });
		// The kinds that open at once are unchanged.
		expect(parseOpenInput("acme/api#123")).toMatchObject({ kind: "pr" });
		expect(parseOpenInput("acme/api 123")).toMatchObject({ kind: "pr" });
	});
});

describe("OpenBox", () => {
	it("opens a pasted URL or owner/repo#n on Enter", async () => {
		setup(mixed);
		await userEvent.click(box());
		await userEvent.paste("https://github.com/acme/api/pull/12");
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/api/12");
		await userEvent.clear(box());
		await userEvent.type(box(), "other/thing#3{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/other/thing/3");
	});

	it("shows repos and pull requests as you type, as a combobox", async () => {
		const api = setup(mixed);
		expect(box()).toHaveAttribute("aria-expanded", "false");
		await userEvent.type(box(), "con");
		const list = await screen.findByRole("listbox");
		expect(box()).toHaveAttribute("aria-expanded", "true");
		expect(box()).toHaveAttribute("aria-controls", list.id);
		const repos = within(list).getByRole("group", { name: "Repos" });
		const prs = within(list).getByRole("group", { name: "Pull requests" });
		expect(
			within(repos)
				.getAllByRole("option")
				.map((o) => o.textContent),
		).toEqual([
			expect.stringContaining("acme/console"),
			expect.stringContaining("acme/connect"),
		]);
		within(repos).getByText("7 open");
		within(repos).getByText("not in view");
		expect(within(prs).getAllByRole("option")).toHaveLength(2);
		within(prs).getByText("snoozed");
		expect(searches(api).at(-1)).toBe("con");
	});

	it("Tab on a repo fills 'owner/repo ' and lists its PRs; words narrow them; Enter opens one", async () => {
		setup(mixed);
		await userEvent.type(box(), "con");
		await screen.findByRole("group", { name: "Repos" });
		await userEvent.keyboard("{Tab}");
		expect(box()).toHaveValue("acme/console ");
		expect(box()).toHaveFocus();
		const scoped = await screen.findByRole("group", {
			name: "acme/console · latest activity",
		});
		expect(within(scoped).getAllByRole("option")).toHaveLength(2);
		await userEvent.type(box(), "diff side");
		await waitFor(() =>
			expect(
				within(screen.getByRole("listbox")).getAllByRole("option"),
			).toHaveLength(1),
		);
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/console/920");
	});

	it("Enter on a repo fills it too, and a number after it opens that PR", async () => {
		setup(mixed);
		await userEvent.type(box(), "con");
		await screen.findByRole("group", { name: "Repos" });
		await userEvent.keyboard("{Enter}");
		expect(box()).toHaveValue("acme/console ");
		expect(goTo).not.toHaveBeenCalled();
		await userEvent.type(box(), "#9{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/console/9");
	});

	it("Backspace over the space leaves the repo", async () => {
		setup(mixed);
		await userEvent.type(box(), "acme/console ");
		await screen.findByRole("group", { name: /^acme\/console ·/ });
		await userEvent.keyboard("{Backspace}");
		expect(box()).toHaveValue("acme/console");
		await screen.findByRole("group", { name: "Repos" });
	});

	it("arrows move the highlight, a click opens a PR", async () => {
		setup(mixed);
		await userEvent.type(box(), "con");
		const list = await screen.findByRole("listbox");
		const options = within(list).getAllByRole("option");
		expect(options[0]).toHaveAttribute("aria-selected", "true");
		expect(box()).toHaveAttribute("aria-activedescendant", options[0]?.id);
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		expect(options[2]).toHaveAttribute("aria-selected", "true");
		expect(box()).toHaveAttribute("aria-activedescendant", options[2]?.id);
		await userEvent.keyboard("{ArrowUp}");
		expect(options[1]).toHaveAttribute("aria-selected", "true");
		await userEvent.click(options[3] as HTMLElement);
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/api/4790");
	});

	it("spins while the first answer for what's typed is coming; an empty answer says no matches", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		setup(
			() =>
				gate.then(() => ({
					...emptySearch,
				})) as unknown as SearchResult,
		);
		const status = screen.getByRole("status");
		await userEvent.type(box(), "zzz");
		await waitFor(() => expect(status).toHaveTextContent("Searching GitHub"));
		expect(screen.queryByTestId("suggestions-empty")).toBeNull();
		release();
		expect(await screen.findByTestId("suggestions-empty")).toHaveTextContent(
			"No matches",
		);
		expect(status).toHaveTextContent("");
	});

	it("asks again while a GitHub search is pending, with a spinner", async () => {
		let calls = 0;
		const api = setup(() => {
			calls++;
			return calls === 1
				? {
						repos: [],
						prs: [],
						scope: "far/away",
						pending: true,
						reposPending: false,
					}
				: {
						repos: [],
						prs: [pr("far/away", 5, "Found later")],
						scope: "far/away",
						pending: false,
						reposPending: false,
					};
		});
		// One live region, mounted from the start, outside the listbox.
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("");
		await userEvent.type(box(), "far/away x");
		await waitFor(() => expect(status).toHaveTextContent("Searching GitHub"));
		expect(status.closest("[role=listbox]")).toBeNull();
		// The scoped PRs' heading spins too.
		const scoped = await screen.findByRole("group", { name: /^far\/away ·/ });
		expect(scoped).toHaveAttribute("aria-busy", "true");
		expect(scoped.querySelector(".animate-spin")).not.toBeNull();
		await screen.findByText("Found later", undefined, { timeout: 3000 });
		expect(status).toHaveTextContent("");
		expect(screen.getByRole("group", { name: /^far\/away ·/ })).toHaveAttribute(
			"aria-busy",
			"false",
		);
		expect(screen.getByRole("status")).toBe(status);
		expect(
			searches(api).filter((q) => q === "far/away x").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("Repos shows a spinner while the viewer's repos load, with the known ones under it", async () => {
		let calls = 0;
		setup(() => {
			calls++;
			const loading = calls === 1;
			return {
				repos: [
					{ name: "acme/console", inView: true, openCount: 7 },
					...(loading
						? []
						: [{ name: "acme/connect", inView: false, openCount: null }]),
				],
				prs: [],
				scope: null,
				pending: loading,
				reposPending: loading,
			};
		});
		const status = screen.getByRole("status");
		await userEvent.type(box(), "con");
		const list = await screen.findByRole("listbox");
		const repos = within(list).getByRole("group", { name: "Repos" });
		expect(repos).toHaveAttribute("aria-busy", "true");
		expect(repos.querySelector(".animate-spin")).not.toBeNull();
		expect(within(repos).getAllByRole("option")).toHaveLength(1);
		expect(status).toHaveTextContent("Loading your repos");
		await waitFor(
			() => expect(within(repos).getAllByRole("option")).toHaveLength(2),
			{ timeout: 3000 },
		);
		expect(repos).toHaveAttribute("aria-busy", "false");
		expect(repos.querySelector(".animate-spin")).toBeNull();
		expect(status).toHaveTextContent("");
	});

	it("Repos shows its heading and spinner before any repo is known", async () => {
		setup(() => ({
			repos: [],
			prs: [pr("acme/api", 1, "Console fix")],
			scope: null,
			pending: true,
			reposPending: true,
		}));
		await userEvent.type(box(), "con");
		const list = await screen.findByRole("listbox");
		const repos = within(list).getByRole("group", { name: "Repos" });
		expect(repos).toHaveAttribute("aria-busy", "true");
		expect(within(repos).queryAllByRole("option")).toHaveLength(0);
		const prs = within(list).getByRole("group", { name: "Pull requests" });
		expect(prs).toHaveAttribute("aria-busy", "false");
		// The first option is the PR: the highlight skips the empty group.
		expect(box()).toHaveAttribute(
			"aria-activedescendant",
			within(prs).getByRole("option").id,
		);
	});

	it("a bare number lists that PR per repo under its own heading, first; Enter opens the first", async () => {
		const api = setup(() => ({
			repos: [],
			prs: [pr("acme/api", 9, "Bump to 123")],
			scope: null,
			numbered: {
				number: 123,
				prs: [
					pr("acme/api", 123, "Side diff"),
					pr("acme/web", 123, "Dark mode", { state: "MERGED" }),
				],
				pending: false,
			},
			pending: false,
			reposPending: false,
		}));
		await userEvent.type(box(), "#123");
		const list = await screen.findByRole("listbox");
		const groups = within(list).getAllByRole("group");
		expect(groups).toHaveLength(2);
		const numbered = within(list).getByRole("group", { name: "#123" });
		expect(groups[0]).toBe(numbered);
		const rows = within(numbered).getAllByRole("option");
		expect(rows.map((r) => r.textContent)).toEqual([
			expect.stringContaining("acme/apiSide diff"),
			expect.stringContaining("acme/webDark mode"),
		]);
		within(list).getByRole("group", { name: "Pull requests" });
		expect(box()).toHaveAttribute("aria-activedescendant", rows[0]?.id);
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/api/123");
		await userEvent.keyboard("{ArrowDown}{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/web/123");
		expect(searches(api)).toContain("#123");
	});

	it("a bare number's group spins while its PRs are read, never empty", async () => {
		// Pending until the test has seen the spinner (the box asks again
		// every 700 ms: a call count would race it).
		let released = false;
		setup(() => {
			const loading = !released;
			return {
				repos: [],
				prs: [],
				scope: null,
				numbered: {
					number: 7,
					prs: loading ? [] : [pr("acme/web", 7, "Found later")],
					pending: loading,
				},
				pending: loading,
				reposPending: false,
			};
		});
		await userEvent.type(box(), "7");
		const list = await screen.findByRole("listbox");
		const group = within(list).getByRole("group", { name: "#7" });
		expect(group).toHaveAttribute("aria-busy", "true");
		expect(group.querySelector(".animate-spin")).not.toBeNull();
		expect(screen.queryByTestId("suggestions-empty")).toBeNull();
		released = true;
		await within(group).findByText("Found later", undefined, { timeout: 3000 });
		expect(group).toHaveAttribute("aria-busy", "false");
	});

	it("a bare number never shows, nor opens on Enter, an older number's answer", async () => {
		const api = setup((q) => ({
			repos: [],
			prs: [],
			scope: null,
			numbered: {
				number: Number(q.replace("#", "")),
				prs: q === "12" ? [pr("acme/api", 12, "Twelve")] : [],
				pending: q !== "12",
			},
			pending: q !== "12",
			reposPending: false,
		}));
		await userEvent.type(box(), "12");
		await screen.findByRole("option", { name: /Twelve/ });
		// "123" isn't asked yet (the debounce): "12"'s answer is the only one.
		await userEvent.type(box(), "3{Enter}");
		expect(goTo).not.toHaveBeenCalled();
		expect(screen.queryByRole("option", { name: /Twelve/ })).toBeNull();
		await screen.findByRole("group", { name: "#123" });
		expect(searches(api)).toContain("123");
	});

	it("while a bare number's PRs are read, title matches wait: Enter opens nothing else", async () => {
		let released = false;
		setup(() => {
			const loading = !released;
			return {
				repos: [],
				prs: [pr("acme/api", 9, "Bump to v40")],
				scope: null,
				numbered: {
					number: 40,
					prs: loading ? [] : [pr("acme/web", 40, "Forty")],
					pending: loading,
				},
				pending: loading,
				reposPending: false,
			};
		});
		await userEvent.type(box(), "40");
		const group = await screen.findByRole("group", { name: "#40" });
		expect(group).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByRole("option", { name: /Bump to v40/ })).toBeNull();
		await userEvent.keyboard("{Enter}");
		expect(goTo).not.toHaveBeenCalled();
		released = true;
		// In: the number's PR first and highlighted, the title match below.
		const forty = await screen.findByRole(
			"option",
			{ name: /Forty/ },
			{ timeout: 3000 },
		);
		await screen.findByRole("option", { name: /Bump to v40/ });
		expect(box()).toHaveAttribute("aria-activedescendant", forty.id);
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/web/40");
	});

	it("a bare number's rows coming in above the highlighted one leave the highlight where it was", async () => {
		let released = false;
		setup(() => {
			const loading = !released;
			return {
				repos: [],
				prs: [],
				scope: null,
				numbered: {
					number: 7,
					prs: [
						...(loading ? [] : [pr("acme/web", 7, "Fetched later")]),
						pr("other/tool", 7, "Known at once"),
					],
					pending: loading,
				},
				pending: loading,
				reposPending: false,
			};
		});
		await userEvent.type(box(), "7");
		const known = await screen.findByRole("option", { name: /Known at once/ });
		expect(box()).toHaveAttribute("aria-activedescendant", known.id);
		expect(screen.getByRole("group", { name: "#7" })).toHaveAttribute(
			"aria-busy",
			"true",
		);
		released = true;
		await screen.findByRole(
			"option",
			{ name: /Fetched later/ },
			{ timeout: 3000 },
		);
		const knownNow = screen.getByRole("option", { name: /Known at once/ });
		expect(box()).toHaveAttribute("aria-activedescendant", knownNow.id);
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/other/tool/7");
	});

	it("a refined text's answer starts at its own first option, not the older text's", async () => {
		setup((q) => ({
			repos: [],
			prs:
				q === "con"
					? [pr("acme/api", 1, "Console A"), pr("acme/api", 2, "Config B")]
					: [
							pr("acme/api", 2, "Config B"),
							pr("acme/api", 3, "Confirm X"),
							pr("acme/api", 1, "Console A conf"),
						],
			scope: null,
			pending: false,
			reposPending: false,
		}));
		await userEvent.type(box(), "con");
		const a = await screen.findByRole("option", { name: /Console A/ });
		expect(box()).toHaveAttribute("aria-activedescendant", a.id);
		await userEvent.type(box(), "f");
		await screen.findByRole("option", { name: /Confirm X/ });
		const b = screen.getByRole("option", { name: /Config B/ });
		expect(box()).toHaveAttribute("aria-activedescendant", b.id);
		await userEvent.keyboard("{Enter}");
		expect(goTo).toHaveBeenLastCalledWith("/pr/acme/api/2");
	});

	it("/ focuses the box and Escape closes the list", async () => {
		setup(mixed);
		await userEvent.keyboard("/");
		expect(box()).toHaveFocus();
		expect(box()).toHaveValue("");
		await userEvent.keyboard("con");
		await screen.findByRole("listbox");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(box()).toHaveAttribute("aria-expanded", "false");
	});

	it("lists its keys in the ? help under Home", async () => {
		setup(mixed);
		await userEvent.keyboard("?");
		const help = screen.getByTestId("shortcuts-help");
		const home = within(help).getByRole("region", { name: "Home" });
		for (const label of [
			"Open a pull request",
			"Close the list",
			"Next suggestion",
			"Open the suggestion",
			"Complete a repo",
		]) {
			within(home).getByText(label);
		}
	});

	it("dates a PR with RelativeTime and names its state with a tooltip", async () => {
		setup(mixed);
		await userEvent.type(box(), "acme/console ");
		const merged = (await screen.findAllByRole("option"))[1] as HTMLElement;
		const time = merged.querySelector("time");
		expect(time).toHaveAttribute("datetime", ago(12));
		const icon = within(merged).getByRole("img", { name: "Merged" });
		await userEvent.hover(icon);
		expect(await shownTooltip()).toHaveTextContent("Merged");
	});

	it("shows a failed GitHub search in the list and stops the spinner", async () => {
		setup(() => ({
			repos: [],
			prs: [pr("far/away", 5, "Cached one")],
			scope: "far/away",
			pending: false,
			reposPending: false,
			error: "gh: rate limited",
		}));
		await userEvent.type(box(), "far/away x");
		const list = await screen.findByRole("listbox");
		await within(list).findByText("Cached one");
		expect(list.contains(screen.getByRole("alert"))).toBe(false);
		expect(screen.getByRole("alert")).toHaveTextContent("gh: rate limited");
		expect(screen.getByRole("status")).toHaveTextContent("");
	});
});
