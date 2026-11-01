// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import {
	ago,
	fakeApi,
	inOrder,
	person,
	renderWithQuery,
	row,
	shownTooltip,
	view,
} from "./testing";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const section = (name: string) =>
	screen.getByRole("region", { name: new RegExp(`^${name}`) });

describe("HomePage", () => {
	it("shows the five sections in order with their labels", async () => {
		fakeApi(view({ mine: [row()] }));
		renderWithQuery(<HomePage />);
		const headings = await screen.findAllByRole("heading", { level: 2 });
		expect(headings.map((h) => h.textContent?.replace(/\d+$/, ""))).toEqual([
			"Mine",
			"Reviewing",
			"Up for grabs",
			"Other open",
			"Recently closed",
		]);
	});

	it("folds a section past 20 rows behind 'show N more', never changing its count", async () => {
		const rows = Array.from({ length: 25 }, (_, i) =>
			row({ number: i + 1, title: `PR ${i + 1}` }),
		);
		fakeApi(view({ other: rows }));
		renderWithQuery(<HomePage />);
		await screen.findByText("PR 25");
		const other = section("Other open");
		expect(within(other).getAllByTestId("home-row")).toHaveLength(20);
		expect(within(other).getByRole("heading")).toHaveTextContent("25");
		await userEvent.click(
			within(other).getByRole("button", { name: "show 5 more" }),
		);
		expect(within(other).getAllByTestId("home-row")).toHaveLength(25);
		expect(within(other).getByRole("heading")).toHaveTextContent("25");
	});

	it("keeps hidden rows behind a footer that counts them and reveals them in place", async () => {
		const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
		fakeApi(
			view({
				mine: inOrder([
					row({ number: 1, title: "Visible" }),
					row({
						number: 2,
						title: "Snoozed one",
						hidden: "snoozed",
						annotations: {
							snooze: { until, wakeOnActivity: true, at: ago(10) },
						},
					}),
					row({
						number: 3,
						title: "Snoozed two",
						hidden: "snoozed",
						annotations: {
							snooze: { until, wakeOnActivity: false, at: ago(10) },
						},
					}),
					row({
						number: 4,
						title: "Waiting one",
						hidden: "waiting",
						annotations: { waiting: { who: "noa", at: ago(10) } },
						people: { noa: person("noa") },
					}),
				]),
				reviewing: [
					row({
						number: 5,
						title: "Waits alone",
						hidden: "waiting",
						annotations: { waiting: { who: "noa", at: ago(10) } },
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("Visible");
		const mine = section("Mine");
		expect(within(mine).getByRole("heading")).toHaveTextContent("1");
		expect(screen.queryByText("Snoozed one")).toBeNull();
		const foot = within(mine).getByRole("button", {
			name: "2 snoozed · 1 waiting",
		});
		expect(foot).toHaveAttribute("aria-expanded", "false");
		// Only the parts that aren't zero.
		within(section("Reviewing")).getByRole("button", { name: "1 waiting" });

		await userEvent.click(foot);
		expect(foot).toHaveAttribute("aria-expanded", "true");
		const hidden = within(mine).getAllByTestId("home-row-hidden");
		expect(hidden).toHaveLength(3);
		const [s1, s2, w1] = hidden as [HTMLElement, HTMLElement, HTMLElement];
		expect(
			within(s1).getByRole("img", {
				name: /^Snoozed until .*, or sooner on activity$/,
			}),
		).toBeInTheDocument();
		expect(
			within(s2).getByRole("img", {
				name: /^Snoozed until \d{4}(?!.*activity)/,
			}),
		).toBeInTheDocument();
		expect(
			within(w1).getByRole("img", { name: "Waiting on noa" }),
		).toBeInTheDocument();
		for (const h of hidden) {
			within(h).getByRole("button", { name: "Wake up" });
		}
	});

	it("shows a row's repo, number, title, pills, status icons, turn and age", async () => {
		fakeApi(
			view({
				reviewing: [
					row({
						number: 4835,
						title: "Rate-limit gh polling",
						draft: true,
						annotations: { note: "awaiting Tomer's decision" },
						checks: "passing",
						decision: "changes-requested",
						unresolvedThreads: 2,
						turn: { kind: "people", logins: ["dan", "noa"] },
						people: { dan: person("dan"), noa: person("noa") },
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const r = (await screen.findAllByTestId("home-row"))[0] as HTMLElement;
		expect(r).toHaveTextContent("acme/api");
		expect(r).toHaveTextContent("#4835");
		expect(
			within(r).getByRole("link", { name: /Rate-limit gh polling/ }),
		).toHaveAttribute("href", "/pr/acme/api/4835");
		expect(within(r).getByText("Draft")).toBeInTheDocument();
		expect(
			within(r).getByRole("img", { name: "Note: awaiting Tomer's decision" }),
		).toBeInTheDocument();
		for (const name of [
			"Checks passing",
			"Changes requested",
			"2 unresolved threads",
			"Author: tomer",
		]) {
			expect(within(r).getByRole("img", { name })).toBeInTheDocument();
		}
		const turn = within(r).getByRole("img", { name: "Turn: you, noa" });
		expect(within(turn).getByTestId("avatar-dan")).toHaveAttribute(
			"data-me",
			"true",
		);
		expect(within(turn).getByTestId("avatar-noa")).not.toHaveAttribute(
			"data-me",
		);
		expect(r.querySelector("time")).toHaveTextContent("1 hour ago");
	});

	it("shows a note on its own line under the title, one line at most, the whole of it in its tooltip", async () => {
		const note = "first line of a long note\nsecond line\nthird";
		fakeApi(
			view({
				other: [row({ title: "Migrate alerts", annotations: { note } })],
			}),
		);
		renderWithQuery(<HomePage />);
		const r = (await screen.findAllByTestId("home-row"))[0] as HTMLElement;
		const shown = within(r).getByTestId("row-note");
		const title = within(r).getByRole("link", { name: /Migrate alerts/ });
		// Not beside the title: on a line of its own, after the title's.
		expect(shown.contains(title)).toBe(false);
		expect(title.parentElement?.contains(shown)).toBe(false);
		expect(
			title.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(shown).toHaveClass("truncate");
		expect(within(shown).getByRole("img")).toHaveAccessibleName(
			`Note: ${note}`,
		);
		within(shown).getByRole("img").focus();
		const tip = await shownTooltip();
		expect(tip.textContent).toBe(`Note: ${note}`);
		// Its lines kept, not run together.
		expect(tip.querySelector(".whitespace-pre-line")).not.toBeNull();
	});

	it("shows every title in full, wrapping inside the row, a long word too", async () => {
		const long = `Refactor ${"configurationloader".repeat(6)} and more words after it`;
		fakeApi(view({ other: [row({ number: 7, title: long })] }));
		renderWithQuery(<HomePage />);
		const link = await screen.findByRole("link", { name: new RegExp(long) });
		// jsdom has no layout (the e2e measures): never cut, always wrapping.
		expect(link).toHaveTextContent(long);
		expect(link).not.toHaveClass("truncate");
		expect(link).toHaveClass("[overflow-wrap:anywhere]");
		expect(link.parentElement).not.toHaveClass("truncate");
	});

	it("names the row's columns in one header, aligned with them on wide screens", async () => {
		fakeApi(
			view({
				reviewing: [
					row({
						number: 3,
						turn: { kind: "people", logins: ["noa"] },
						reviews: [
							{
								id: "R1",
								label: "head",
								pinnedHead: null,
								coverage: { done: 1, total: 2, unit: "lines" },
								lastActedAt: ago(5),
								headMoved: false,
							},
						],
					}),
				],
				other: [row({ number: 4 })],
			}),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("#3");
		const headers = screen.getAllByTestId("home-columns");
		expect(headers).toHaveLength(1);
		const header = headers[0] as HTMLElement;
		// Only where the rows are columns (lg up); a phone's stacked rows have none.
		expect(header).toHaveClass("hidden", "lg:flex");
		const cols = [...header.querySelectorAll<HTMLElement>("[data-col]")];
		expect(cols.map((c) => c.textContent)).toEqual([
			"Repo",
			"Pull request",
			"Status",
			"Turn",
			"Reviewed",
			"Updated",
		]);
		const width = (el: Element) =>
			[...el.classList].filter((c) => /^lg:(w-|flex-1)/.test(c)).join(" ");
		for (const r of screen.getAllByTestId("home-row")) {
			for (const col of cols) {
				const cell = r.querySelector(`[data-col="${col.dataset.col}"]`);
				expect(cell, col.dataset.col).not.toBeNull();
				expect(width(cell as Element), col.dataset.col).toBe(width(col));
				expect(width(col)).not.toBe("");
			}
		}
	});

	it("leaves the author out on Mine, and says 'no reviewer' for an untaken PR", async () => {
		fakeApi(
			view({
				mine: [row({ title: "Mine", author: person("dan") })],
				grabs: [
					row({ number: 2, title: "Free", turn: { kind: "no-reviewer" } }),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("Free");
		expect(
			within(section("Mine")).queryByRole("img", { name: /^Author/ }),
		).toBeNull();
		expect(
			within(section("Up for grabs")).getByText("no reviewer"),
		).toBeInTheDocument();
	});

	it("shows a started review's coverage next to the age, and opens that review", async () => {
		fakeApi(
			view({
				reviewing: [
					row({
						reviews: [
							{
								id: "01REV",
								label: "head",
								pinnedHead: null,
								coverage: { done: 37, total: 120, unit: "lines" },
								lastActedAt: ago(5),
								headMoved: false,
							},
						],
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const r = (await screen.findAllByTestId("home-row"))[0] as HTMLElement;
		expect(
			within(r).getByRole("img", { name: "37 of 120 lines reviewed" }),
		).toHaveTextContent("37 / 120");
		expect(r.querySelector("time")).toHaveTextContent("1 hour ago");
		expect(within(r).getByRole("link", { name: /A change/ })).toHaveAttribute(
			"href",
			"/r/01REV",
		);
		expect(within(r).queryAllByTestId("home-subrow")).toHaveLength(0);
	});

	it("lists several started reviews as sub-rows, newest activity first", async () => {
		fakeApi(
			view({
				mine: [
					row({
						author: person("dan"),
						reviews: [
							{
								id: "OLD",
								label: "abc1234",
								pinnedHead: "abc1234".padEnd(40, "0"),
								coverage: { done: 3, total: 10, unit: "files" },
								lastActedAt: ago(300),
								headMoved: false,
							},
							{
								id: "NEW",
								label: "head",
								pinnedHead: null,
								coverage: { done: 10, total: 10, unit: "files" },
								lastActedAt: ago(2),
								headMoved: false,
							},
						],
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const subs = await screen.findAllByTestId("home-subrow");
		expect(
			subs.map((s) => within(s).getByRole("link").getAttribute("href")),
		).toEqual(["/r/NEW", "/r/OLD"]);
		expect(subs[0]).toHaveTextContent("head");
		expect(
			within(subs[1] as HTMLElement).getByRole("img", {
				name: "Pinned head abc1234",
			}),
		).toBeInTheDocument();
		expect(
			within(subs[1] as HTMLElement).getByRole("img", {
				name: "3 of 10 files reviewed",
			}),
		).toBeInTheDocument();
		// The PR row opens the plain review.
		const r = screen.getAllByTestId("home-row")[0] as HTMLElement;
		expect(within(r).getAllByRole("link")[0]).toHaveAttribute("href", "/r/NEW");
	});

	it("links a merged PR with nothing to review to GitHub", async () => {
		fakeApi(
			view({
				closed: [
					row({
						title: "Gone in",
						state: "MERGED",
						closedAt: ago(60),
						openable: false,
					}),
					row({
						number: 2,
						title: "Dropped",
						state: "CLOSED",
						closedAt: ago(60),
						openable: false,
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const link = await screen.findByRole("link", { name: /Gone in/ });
		expect(link).toHaveAttribute("href", "https://github.com/acme/api/pull/1");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAccessibleDescription(
			"Merged, nothing to review here. Open on GitHub",
		);
		const closed = section("Recently closed");
		within(closed).getByRole("img", { name: "Merged" });
		within(closed).getByRole("img", { name: "Closed" });
	});

	it("marks a row that woke in the last day", async () => {
		fakeApi(view({ mine: [row({ woke: { at: ago(30), by: "activity" } })] }));
		renderWithQuery(<HomePage />);
		expect(
			await screen.findByRole("img", { name: "Woke: activity" }),
		).toBeInTheDocument();
	});

	it("shows the oldest repo read, in warn with the reasons when one failed", async () => {
		fakeApi(
			view(
				{ mine: [row()] },
				{
					repos: {
						"acme/api": { refreshedAt: ago(0.2) },
						"acme/console": {
							refreshedAt: ago(5),
							error: "Rate limited by GitHub",
							failures: 1,
						},
					},
				},
			),
		);
		renderWithQuery(<HomePage />);
		const status = await screen.findByTestId("refresh-status");
		await waitFor(() => expect(status).toHaveClass("text-warn"));
		within(status).getByRole("img", {
			name: "Refresh failed: acme/console: Rate limited by GitHub",
		});
		expect(status.querySelector("time")).toHaveTextContent("5 minutes ago");
		// The rows stay.
		expect(screen.getByText("A change")).toBeInTheDocument();
	});

	it("shows the config's problems", async () => {
		fakeApi(
			view(
				{},
				{ configProblems: ['views[0].repos: "nope" is not owner/repo'] },
			),
		);
		renderWithQuery(<HomePage />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			'"nope" is not owner/repo',
		);
	});

	it("offers to add repos to an empty view", async () => {
		fakeApi(view({}, { view: { name: "My PRs", repos: [] } }));
		renderWithQuery(<HomePage />);
		await userEvent.click(
			await screen.findByRole("button", { name: "Add repos" }),
		);
		expect(screen.getByRole("dialog", { name: "My PRs" })).toBeInTheDocument();
	});

	it("lets a phone row's second line wrap, even the worst case", async () => {
		const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
		const busy = row({
			number: 4835,
			title: "Rate-limit gh polling per repo",
			checks: "running",
			decision: "changes-requested",
			unresolvedThreads: 12,
			turn: { kind: "people", logins: ["dan", "noa", "ido"] },
			people: { dan: person("dan"), noa: person("noa"), ido: person("ido") },
			reviews: [
				{
					id: "R1",
					label: "head",
					pinnedHead: null,
					coverage: { done: 1037, total: 12120, unit: "lines" },
					lastActedAt: ago(5),
					headMoved: false,
				},
			],
		});
		const hidden = row({
			number: 9,
			hidden: "snoozed",
			annotations: { snooze: { until, wakeOnActivity: true, at: ago(9) } },
		});
		fakeApi(view({ reviewing: [busy, hidden] }));
		renderWithQuery(<HomePage />);
		await screen.findByText("Rate-limit gh polling per repo");
		await userEvent.click(screen.getByRole("button", { name: "1 snoozed" }));
		// jsdom has no layout: the 360px check is the e2e's. Here, every row's
		// meta line may wrap until the row is columns (nowrap only from lg up).
		for (const r of [
			screen.getByTestId("home-row"),
			screen.getByTestId("home-row-hidden"),
		]) {
			const meta = within(r).getByTestId("row-meta");
			expect(meta).toHaveClass("flex-wrap", "lg:flex-nowrap");
			expect(meta).not.toHaveClass("flex-nowrap");
		}
	});

	it("counts a hidden row of an unknown kind in the footer, with Wake up", async () => {
		fakeApi(
			view({
				other: inOrder([
					row({ number: 1, title: "Muted", hidden: "muted" as "snoozed" }),
					row({ number: 2, title: "Snoozed, no date", hidden: "snoozed" }),
				]),
			}),
		);
		renderWithQuery(<HomePage />);
		const foot = await screen.findByRole("button", {
			name: "1 snoozed · 1 hidden",
		});
		await userEvent.click(foot);
		const hidden = screen.getAllByTestId("home-row-hidden");
		expect(hidden.map((h) => h.textContent)).toEqual([
			expect.stringContaining("Muted"),
			expect.stringContaining("Snoozed, no date"),
		]);
		for (const h of hidden) within(h).getByRole("button", { name: "Wake up" });
	});

	it("shows the fold and the hidden footer together", async () => {
		const rows = inOrder([
			...Array.from({ length: 22 }, (_, i) =>
				row({ number: i + 1, title: `PR ${i + 1}` }),
			),
			row({ number: 99, title: "Away", hidden: "waiting" }),
		]);
		fakeApi(view({ other: rows }));
		renderWithQuery(<HomePage />);
		await screen.findByText("PR 1");
		const other = section("Other open");
		expect(within(other).getByRole("heading")).toHaveTextContent("22");
		within(other).getByRole("button", { name: "show 2 more" });
		await userEvent.click(
			within(other).getByRole("button", { name: "1 waiting" }),
		);
		expect(within(other).getAllByTestId("home-row")).toHaveLength(20);
		within(other).getByText("Away");
	});

	it("opens the reason badge's tooltip on keyboard focus", async () => {
		const until = new Date(Date.now() + 9 * 86_400_000).toISOString();
		fakeApi(
			view({
				mine: [
					row({
						woke: { at: ago(30), by: "time" },
					}),
					row({
						number: 2,
						hidden: "snoozed",
						annotations: {
							snooze: { until, wakeOnActivity: false, at: ago(9) },
						},
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const woke = await screen.findByRole("img", { name: "Woke: time" });
		expect(woke).toHaveAttribute("tabindex", "0");
		await userEvent.click(screen.getByRole("button", { name: "1 snoozed" }));
		const badge = screen.getByRole("img", { name: /^Snoozed until/ });
		expect(badge).toHaveAttribute("tabindex", "0");
		act(() => badge.focus());
		expect(await shownTooltip()).toHaveTextContent(/^Snoozed until \d{4}/);
	});

	it("says 'no reviewer' in muted, and the logo link has a Home tooltip", async () => {
		fakeApi(view({ grabs: [row({ turn: { kind: "no-reviewer" } })] }));
		renderWithQuery(<HomePage />);
		expect(await screen.findByText("no reviewer")).toHaveClass("text-muted");
		const logo = screen.getByRole("link", { name: "Home" });
		await userEvent.hover(logo);
		expect(await shownTooltip()).toHaveTextContent("Home");
	});

	it("flags a review whose PR got new commits, on the row or its sub-row", async () => {
		const review = (id: string, headMoved: boolean, minutes: number) => ({
			id,
			label: id === "P" ? "abc1234" : "head",
			pinnedHead: id === "P" ? "abc1234".padEnd(40, "0") : null,
			coverage: { done: 1, total: 4, unit: "lines" as const },
			lastActedAt: ago(minutes),
			headMoved,
		});
		fakeApi(
			view({
				reviewing: inOrder([
					row({ number: 1, title: "One", reviews: [review("A", true, 5)] }),
					row({
						number: 2,
						title: "Two",
						reviews: [review("B", false, 5), review("P", true, 50)],
					}),
				]),
			}),
		);
		renderWithQuery(<HomePage />);
		await screen.findByText("One");
		const [one, two] = screen.getAllByTestId("home-row") as [
			HTMLElement,
			HTMLElement,
		];
		within(one).getByRole("img", { name: "New commits since your review" });
		expect(
			within(two).queryByRole("img", { name: "New commits since your review" }),
		).toBeNull();
		const [b, p] = screen.getAllByTestId("home-subrow") as [
			HTMLElement,
			HTMLElement,
		];
		expect(
			within(b).queryByRole("img", { name: "New commits since your review" }),
		).toBeNull();
		within(p).getByRole("img", { name: "New commits since your review" });
	});

	it("the viewer's own PR with no reviewer is their turn, to request one", async () => {
		fakeApi(
			view({
				mine: [
					row({
						author: person("dan"),
						turn: { kind: "people", logins: ["dan"], label: "request" },
					}),
				],
			}),
		);
		renderWithQuery(<HomePage />);
		const turn = await screen.findByRole("img", {
			name: "No reviewer: request one",
		});
		expect(within(turn).getByTestId("avatar-dan")).toHaveAttribute(
			"data-me",
			"true",
		);
		expect(turn).toHaveTextContent("you");
		await userEvent.hover(turn);
		expect(await shownTooltip()).toHaveTextContent("No reviewer: request one");
	});
});
