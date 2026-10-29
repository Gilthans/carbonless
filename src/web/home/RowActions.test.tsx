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
import type { HomeRow } from "../../shared/home";
import { HomePage } from "./HomePage";
import { homeQuery } from "./homeApi";
import { snoozePresets } from "./snooze";
import {
	ago,
	type Call,
	fakeApi,
	person,
	renderWithQuery,
	row,
	view,
} from "./testing";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const ANNOTATE = "POST /api/home/prs/acme/api/7/annotations";

const base = row({
	number: 7,
	title: "Seven",
	author: person("tomer"),
	turn: { kind: "people", logins: ["noa"] },
	people: { noa: person("noa") },
});

/** Home with one row in Reviewing; annotations answer `answer(op)`. */
function setup(answer: (call: Call) => HomeRow = () => base, r = base) {
	const api = fakeApi(view({ reviewing: [r] }), {
		[ANNOTATE]: (call) => answer(call),
	});
	const { client } = renderWithQuery(<HomePage />);
	return { ...api, client };
}

const posted = (api: ReturnType<typeof setup>) =>
	api.calls
		.filter((c) => `${c.method} ${c.url}` === ANNOTATE)
		.map((c) => c.body);

const gets = (api: ReturnType<typeof setup>) =>
	api.calls.filter((c) => c.method === "GET" && c.url === "/api/home").length;

describe("RowActions", () => {
	it("snoozes to a preset, waking on activity by default, and updates the row in place", async () => {
		const api = setup((call) => ({
			...base,
			hidden: "snoozed",
			annotations: {
				snooze: {
					until: (call.body as { until: string }).until,
					wakeOnActivity: true,
					at: ago(0),
				},
			},
		}));
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
		const pop = screen.getByRole("dialog", { name: "Snooze" });
		expect(
			within(pop).getByRole("switch", { name: "Wake on activity too" }),
		).toHaveAttribute("aria-checked", "true");
		await userEvent.click(
			within(pop).getByRole("button", { name: /Tomorrow/ }),
		);
		await waitFor(() => expect(posted(api)).toHaveLength(1));
		const tomorrow = snoozePresets(new Date())[0]?.until.toISOString();
		expect(posted(api)[0]).toEqual({
			op: "snooze",
			until: tomorrow,
			wakeOnActivity: true,
		});
		// Moved behind the footer from the answer, without reloading Home.
		await screen.findByRole("button", { name: "1 snoozed" });
		expect(screen.queryByText("Seven")).toBeNull();
		expect(gets(api)).toBe(1);
	});

	it("snoozes without activity when the switch is off", async () => {
		const api = setup();
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
		const pop = screen.getByRole("dialog", { name: "Snooze" });
		await userEvent.click(within(pop).getByRole("switch"));
		await userEvent.click(
			within(pop).getByRole("button", { name: /In 3 days/ }),
		);
		await waitFor(() => expect(posted(api)).toHaveLength(1));
		expect(posted(api)[0]).toMatchObject({ wakeOnActivity: false });
	});

	it("snoozes to a picked date, at 09:00 local", async () => {
		const api = setup();
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Snooze" }));
		const pop = screen.getByRole("dialog", { name: "Snooze" });
		await userEvent.click(
			within(pop).getByRole("button", { name: /Pick a date/ }),
		);
		const next = new Date();
		next.setDate(next.getDate() + 10);
		const ymd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
		await userEvent.type(within(pop).getByLabelText("Snooze until"), ymd);
		await userEvent.click(
			within(pop).getByRole("button", { name: "Snooze to this date" }),
		);
		await waitFor(() => expect(posted(api)).toHaveLength(1));
		const until = new Date(
			next.getFullYear(),
			next.getMonth(),
			next.getDate(),
			9,
		);
		expect(posted(api)[0]).toMatchObject({
			op: "snooze",
			until: until.toISOString(),
		});
	});

	it("waits on the author, the reviewers and the turn's people (once each), me or a typed login", async () => {
		const api = setup(() => base, {
			...base,
			reviewers: ["noa", "ido"],
			turn: { kind: "people", logins: ["noa", "liat"] },
			people: { noa: person("noa"), ido: person("ido"), liat: person("liat") },
		});
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		let pop = screen.getByRole("dialog", { name: "Waiting on" });
		const names = within(pop)
			.getAllByRole("button")
			.map((b) => b.textContent);
		expect(names).toEqual([
			"Me",
			"tomerauthor",
			"noareviewer",
			"idoreviewer",
			"liat",
		]);
		await userEvent.click(within(pop).getByRole("button", { name: /tomer/ }));
		await waitFor(() => expect(posted(api)).toHaveLength(1));
		expect(posted(api)[0]).toEqual({ op: "wait", who: "tomer" });

		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		pop = screen.getByRole("dialog", { name: "Waiting on" });
		await userEvent.type(
			within(pop).getByLabelText("Someone else"),
			"@gil{Enter}",
		);
		await waitFor(() => expect(posted(api)).toHaveLength(2));
		expect(posted(api)[1]).toEqual({ op: "wait", who: "gil" });
	});

	it("saves a note and clears it", async () => {
		const api = setup((call) => ({
			...base,
			annotations: { note: (call.body as { text: string }).text || undefined },
		}));
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Note" }));
		let pop = screen.getByRole("dialog", { name: "Note" });
		await userEvent.type(within(pop).getByRole("textbox"), "needs the QA VM");
		await userEvent.click(within(pop).getByRole("button", { name: "Save" }));
		await screen.findByRole("img", { name: "Note: needs the QA VM" });
		expect(posted(api)[0]).toEqual({ op: "note", text: "needs the QA VM" });

		await userEvent.click(screen.getByRole("button", { name: "Note" }));
		pop = screen.getByRole("dialog", { name: "Note" });
		expect(within(pop).getByRole("textbox")).toHaveValue("needs the QA VM");
		await userEvent.click(within(pop).getByRole("button", { name: "Clear" }));
		await waitFor(() =>
			expect(screen.queryByRole("img", { name: /^Note:/ })).toBeNull(),
		);
		expect(posted(api)[1]).toEqual({ op: "note", text: "" });
	});

	it("wakes a hidden row with Wake up", async () => {
		const snoozed: HomeRow = {
			...base,
			hidden: "snoozed",
			annotations: {
				snooze: {
					until: new Date(Date.now() + 86_400_000).toISOString(),
					wakeOnActivity: true,
					at: ago(10),
				},
			},
		};
		const api = setup(() => base, snoozed);
		await userEvent.click(
			await screen.findByRole("button", { name: "1 snoozed" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Wake up" }));
		await waitFor(() => expect(posted(api)).toEqual([{ op: "wake" }]));
		expect(await screen.findByTestId("home-row")).toHaveTextContent("Seven");
		expect(screen.queryByRole("button", { name: /snoozed/ })).toBeNull();
	});

	it("on touch, a 40px ⋯ button opens the same three in a bottom sheet", async () => {
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches:
						!query.includes("hover: hover") && !query.includes("min-width"),
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		const api = setup();
		await screen.findByText("Seven");
		expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
		const more = screen.getByRole("button", { name: "Actions for #7" });
		expect(more).toHaveClass("h-10", "w-10");
		await userEvent.click(more);
		const sheet = screen.getByRole("dialog", { name: "#7" });
		await userEvent.click(within(sheet).getByRole("button", { name: "Note" }));
		await userEvent.type(within(sheet).getByRole("textbox"), "x");
		await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(posted(api)).toEqual([{ op: "note", text: "x" }]),
		);
	});

	it("offers the reviewers when the turn is the author's alone", async () => {
		setup(() => base, {
			...base,
			reviewers: ["noa"],
			turn: { kind: "people", logins: ["tomer"] },
			people: { noa: person("noa") },
		});
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		within(screen.getByRole("dialog", { name: "Waiting on" })).getByRole(
			"button",
			{ name: /noa/ },
		);
	});

	it("marks the current wait and clears it, also a 'me' wait that never hides the row", async () => {
		const mine: HomeRow = {
			...base,
			annotations: { waiting: { who: "dan", at: ago(5) } },
		};
		const api = setup(() => base, mine);
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		const pop = screen.getByRole("dialog", { name: "Waiting on" });
		expect(within(pop).getByRole("button", { name: "Me" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await userEvent.click(within(pop).getByRole("button", { name: "Clear" }));
		await waitFor(() => expect(posted(api)).toEqual([{ op: "wake" }]));
	});

	it("has no Clear while nothing is waited on", async () => {
		setup();
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		const pop = screen.getByRole("dialog", { name: "Waiting on" });
		expect(within(pop).queryByRole("button", { name: "Clear" })).toBeNull();
	});

	it("raises an open popover above the rows after it", async () => {
		setup();
		await screen.findByText("Seven");
		const snooze = screen.getByRole("button", { name: "Snooze" });
		const wrapper = snooze.closest("[data-row-actions]");
		expect(wrapper).toHaveClass("z-10");
		await userEvent.click(snooze);
		// Above every row's z-10 icons, which share its stacking context.
		expect(wrapper).toHaveClass("z-30");
		expect(wrapper).not.toHaveClass("z-10");
	});

	it("Escape closes a popover and focus goes back to its button", async () => {
		setup();
		await screen.findByText("Seven");
		const snooze = screen.getByRole("button", { name: "Snooze" });
		await userEvent.click(snooze);
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Snooze" })).toBeNull();
		expect(snooze).toHaveFocus();
	});

	it("focuses the section's footer when a row moves behind it", async () => {
		setup(() => ({
			...base,
			hidden: "waiting",
			annotations: { waiting: { who: "noa", at: ago(0) } },
		}));
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		await userEvent.click(
			within(screen.getByRole("dialog", { name: "Waiting on" })).getByRole(
				"button",
				{ name: /noa/ },
			),
		);
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "1 waiting" })).toHaveFocus(),
		);
	});

	it("an older GET /api/home in flight can't undo a write on screen", async () => {
		let release: (v: unknown) => void = () => {};
		const api = setup(() => ({
			...base,
			annotations: { note: "kept" },
		}));
		await screen.findByText("Seven");
		const old = view({ reviewing: [base] });
		api.fetch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve(
							new Response(JSON.stringify(old), {
								headers: { "content-type": "application/json" },
							}),
						);
				}),
		);
		// A refetch starts (the poll, a focus) and hangs.
		act(() => {
			void api.client.refetchQueries({ queryKey: homeQuery.queryKey });
		});
		await userEvent.click(screen.getByRole("button", { name: "Note" }));
		const pop = screen.getByRole("dialog", { name: "Note" });
		fireEvent.change(within(pop).getByRole("textbox"), {
			target: { value: "kept" },
		});
		await userEvent.click(within(pop).getByRole("button", { name: "Save" }));
		await screen.findByRole("img", { name: "Note: kept" });
		await act(async () => {
			release(undefined);
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(screen.getByRole("img", { name: "Note: kept" })).toBeInTheDocument();
	});

	it("'Me' waits on the viewer's own login", async () => {
		const api = setup();
		await screen.findByText("Seven");
		await userEvent.click(screen.getByRole("button", { name: "Waiting on" }));
		await userEvent.click(
			within(screen.getByRole("dialog", { name: "Waiting on" })).getByRole(
				"button",
				{ name: "Me" },
			),
		);
		await waitFor(() =>
			expect(posted(api)).toEqual([{ op: "wait", who: "dan" }]),
		);
	});
});
