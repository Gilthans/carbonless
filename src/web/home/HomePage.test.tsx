// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import { ago, fakeApi, person, renderWithQuery, row, view } from "./testing";

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
		await screen.findByText("PR 1");
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
				mine: [
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
				],
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
							},
							{
								id: "NEW",
								label: "head",
								pinnedHead: null,
								coverage: { done: 10, total: 10, unit: "files" },
								lastActedAt: ago(2),
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

	it("shows the last refresh, in warn with the reason when it failed", async () => {
		fakeApi(
			view(
				{ mine: [row()] },
				{ refreshedAt: ago(0.2), refreshError: "GitHub rate limit" },
			),
		);
		renderWithQuery(<HomePage />);
		const status = await screen.findByTestId("refresh-status");
		expect(status).toHaveClass("text-warn");
		within(status).getByRole("img", {
			name: "Refresh failed: GitHub rate limit",
		});
		expect(status.querySelector("time")).toBeInTheDocument();
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

	it("asks for a refresh on open when the last one is older than 30 s, and not when it's fresh", async () => {
		const stale = fakeApi(view({ mine: [row()] }, { refreshedAt: ago(1) }));
		const { unmount } = renderWithQuery(<HomePage />);
		await waitFor(() =>
			expect(
				stale.calls.some(
					(c) => c.method === "POST" && c.url === "/api/home/refresh",
				),
			).toBe(true),
		);
		unmount();
		const fresh = fakeApi(view({ mine: [row()] }, { refreshedAt: ago(0.1) }));
		renderWithQuery(<HomePage />);
		await screen.findByText("A change");
		expect(fresh.calls.some((c) => c.url === "/api/home/refresh")).toBe(false);
	});

	it("refreshes on the button", async () => {
		const api = fakeApi(view({ mine: [row()] }));
		renderWithQuery(<HomePage />);
		await screen.findByText("A change");
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(api.calls.some((c) => c.url === "/api/home/refresh")).toBe(true),
		);
	});
});
