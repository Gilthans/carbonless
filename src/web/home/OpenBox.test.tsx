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
	fakeApi,
	person,
	renderWithQuery,
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

	it("asks again while a GitHub search is pending, with a spinner", async () => {
		let calls = 0;
		const api = setup(() => {
			calls++;
			return calls === 1
				? { repos: [], prs: [], scope: "far/away", pending: true }
				: {
						repos: [],
						prs: [pr("far/away", 5, "Found later")],
						scope: "far/away",
						pending: false,
					};
		});
		await userEvent.type(box(), "far/away x");
		expect(
			await screen.findByRole("status", { name: "Searching GitHub" }),
		).toBeInTheDocument();
		await screen.findByText("Found later", undefined, { timeout: 3000 });
		expect(
			screen.queryByRole("status", { name: "Searching GitHub" }),
		).toBeNull();
		expect(
			searches(api).filter((q) => q === "far/away x").length,
		).toBeGreaterThanOrEqual(2);
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
});
