// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen, heldJson } from "../../test/loading";
import type { UpdateInfo } from "../shared/update";
import type { UpdateNotes } from "../shared/whatsNew";
import { ToastStack } from "./Toasts";
import { UpdateToast } from "./UpdateToast";

vi.mock("./files/useSetStates", () => ({ useUnsaved: () => false }));

const OFFER: UpdateInfo = {
	current: "0.3.0",
	available: "0.5.0",
	releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.5.0",
	oneClick: true,
	command: "npm install -g carbonless-review@0.5.0",
	state: "idle",
	failed: null,
	commit: "c".repeat(40),
	channel: "latest",
	install: "npm",
	byHand: false,
	byHandReason: null,
	byHandManager: null,
	lastChecked: "2026-11-12T10:00:00.000Z",
	checkError: null,
	checksOff: null,
	withdrawn: null,
};

const NOTES: UpdateNotes = {
	current: "0.3.0",
	available: "0.5.0",
	older: false,
	dropped: 0,
	sections: [
		{
			version: "0.5.0",
			date: "2026-12-01T12:00:00.000Z",
			released: true,
			uncovered: [],
			notes: [
				{
					id: "CAR-38",
					kind: "new",
					prs: [118],
					text: "Images show before and after side by side.",
				},
				{
					id: "CAR-184",
					kind: "fixed",
					prs: [130],
					text: "Ignore whitespace also applies to the verdict. It used to show every re-indented line there too.",
				},
			],
		},
		{
			version: "0.4.0",
			date: "2026-11-20T10:00:00.000Z",
			released: true,
			uncovered: [],
			notes: [],
		},
	],
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A fake crb: /api/update answers `info`, the notes' GET `notes()`, their POST `retry()`. */
function serve(opts: {
	info?: UpdateInfo;
	notes: () => Promise<Response> | Response;
	retry?: () => Response;
}) {
	const asked: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			asked.push(`${method} ${url}`);
			if (url === "/api/update" && method === "POST") {
				return json(202, { ...(opts.info ?? OFFER), state: "restarting" });
			}
			if (url === "/api/update") return json(200, opts.info ?? OFFER);
			if (url === "/api/update/notes" && method === "POST") {
				return opts.retry?.() ?? json(404, {});
			}
			if (url === "/api/update/notes") return opts.notes();
			if (url === "/api/version") throw new TypeError("Failed to fetch");
			return json(404, {});
		}),
	);
	return asked;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ToastStack>
				<UpdateToast />
			</ToastStack>
		</QueryClientProvider>,
	);
}

/** The text of every tooltip showing now. */
const shownTips = () =>
	[...document.querySelectorAll<HTMLElement>('[role="tooltip"]')]
		.filter((t) => !t.hidden)
		.map((t) => t.textContent ?? "");

async function openModal() {
	await userEvent.click(
		await screen.findByRole("button", { name: /^Update available/ }),
	);
	return screen.getByTestId("whats-new");
}

describe("What's new", () => {
	it("loading: skeleton and spinner, never an empty list, Update already there; then every version newest first", async () => {
		const held = heldJson();
		serve({ notes: () => held.response });
		show();
		const modal = await openModal();
		const body = within(modal).getByTestId("whats-new-body");
		await expectLoadingThen({
			loading: () => within(modal).queryByTestId("notes-loading"),
			empty: [
				() => within(modal).queryByText("No user-facing changes"),
				() => within(modal).queryByRole("alert"),
			],
			release: () => {
				expect(body.getAttribute("aria-busy")).toBe("true");
				expect(
					within(modal).getByRole("status", { name: "Loading notes" }),
				).toBeTruthy();
				expect(
					within(modal).getByRole("button", { name: "Update to v0.5.0" }),
				).toBeEnabled();
				held.release(NOTES);
			},
			result: () => within(modal).queryAllByTestId("notes-version")[0] ?? null,
		});
		expect(body.getAttribute("aria-busy")).toBeNull();
		expect(
			within(modal).queryByRole("status", { name: "Loading notes" }),
		).toBeNull();
		expect(
			within(modal)
				.getAllByTestId("notes-version")
				.map((s) => s.dataset.version),
		).toEqual(["0.5.0", "0.4.0"]);
		expect(within(modal).getByTestId("whats-new-range").textContent).toBe(
			"v0.3.0 → v0.5.0",
		);
		expect(
			within(modal).getByRole("link", { name: "#118" }).getAttribute("href"),
		).toBe("https://github.com/Gilthans/carbonless/pull/118");
		expect(
			within(modal)
				.getAllByRole("link", { name: "Release on GitHub" })[0]
				?.getAttribute("href"),
		).toBe("https://github.com/Gilthans/carbonless/releases/tag/v0.5.0");
		expect(within(modal).getAllByRole("img", { name: "New" })).toHaveLength(1);
		expect(within(modal).getAllByRole("img", { name: "Fixed" })).toHaveLength(
			1,
		);
		// A version whose tickets all said none.
		expect(within(modal).getByText("No user-facing changes")).toBeTruthy();
	});

	it("a long note: its first sentence, the rest behind its own Show more", async () => {
		serve({ notes: () => json(200, NOTES) });
		show();
		const modal = await openModal();
		const fixed = (await within(modal).findAllByTestId("release-note"))[1];
		if (!fixed) throw new Error("no note");
		expect(within(fixed).getByTestId("release-note-text").textContent).toBe(
			"Ignore whitespace also applies to the verdict.",
		);
		await userEvent.click(
			within(fixed).getByRole("button", { name: /Show more/ }),
		);
		expect(within(fixed).getByTestId("release-note-text").textContent).toBe(
			NOTES.sections[0]?.notes[1]?.text,
		);
		expect(
			within(fixed).getByRole("button", { name: /Show less/ }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("failed: a warn notice with the reason, Retry and the release; Update still works; Retry loads them", async () => {
		const asked = serve({
			notes: () => json(502, { error: "Registry timed out" }),
			retry: () => json(200, NOTES),
		});
		show();
		const modal = await openModal();
		const alert = await within(modal).findByRole("alert");
		expect(alert.textContent).toContain(
			"Notes didn't load: Registry timed out",
		);
		expect(
			within(alert).getByRole("link", { name: "Release on GitHub" }),
		).toHaveAttribute("href", OFFER.releaseUrl);
		expect(within(modal).queryByText("No user-facing changes")).toBeNull();
		expect(
			within(modal).getByRole("button", { name: "Update to v0.5.0" }),
		).toBeEnabled();
		await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
		await within(modal).findAllByTestId("notes-version");
		expect(within(modal).queryByRole("alert")).toBeNull();
		expect(asked).toContain("POST /api/update/notes");
	});

	it("Update in the modal: closes it and runs the toast's update with that version", async () => {
		const asked = serve({ notes: () => json(200, NOTES) });
		show();
		const modal = await openModal();
		await userEvent.click(
			within(modal).getByRole("button", { name: "Update to v0.5.0" }),
		);
		await waitFor(() => expect(asked).toContain("POST /api/update"));
		expect(modal.hasAttribute("open")).toBe(false);
		expect((await screen.findByTestId("update-toast")).dataset.state).toBe(
			"updating",
		);
	});

	it("by hand: why and the command in place of Update", async () => {
		serve({
			info: {
				...OFFER,
				oneClick: false,
				byHand: true,
				byHandReason: "not-writable",
			},
			notes: () => json(200, NOTES),
		});
		show();
		const modal = await openModal();
		const footer = within(modal).getByTestId("whats-new-footer");
		expect(within(footer).getByTestId("update-by-hand")).toHaveTextContent(
			"No auto-update: installed in a folder crb can't write",
		);
		expect(within(footer).getByTestId("update-command").textContent).toBe(
			OFFER.command,
		);
		expect(
			within(footer).queryByRole("button", { name: /^Update( to|$)/ }),
		).toBeNull();
	});

	it("an RC: the range from rc.N, and the changes without notes yet linking the compare view", async () => {
		serve({
			info: { ...OFFER, current: "0.4.0-rc.3", available: "0.4.0-rc.5" },
			notes: () =>
				json(200, {
					current: "0.4.0-rc.3",
					available: "0.4.0-rc.5",
					older: false,
					dropped: 1,
					sections: [
						{
							version: "0.4.0-rc.5",
							date: null,
							released: false,
							uncovered: [131, 129],
							notes: [
								{
									id: "CAR-9",
									kind: "improved",
									prs: [135],
									text: "Threads tab: j and k step.",
								},
							],
						},
					],
				}),
		});
		show();
		const modal = await openModal();
		expect(within(modal).getByTestId("whats-new-range").textContent).toBe(
			"rc.3 → v0.4.0-rc.5",
		);
		const more = await within(modal).findByTestId("notes-uncovered");
		expect(more.textContent).toBe("2 more changes, no notes yet");
		expect(more.getAttribute("href")).toBe(
			"https://github.com/Gilthans/carbonless/compare/v0.4.0-rc.3...v0.4.0-rc.5",
		);
		// Not released: no release link, no date.
		expect(
			within(modal).queryByRole("link", { name: "Release on GitHub" }),
		).toBeNull();
		expect(within(modal).getByTestId("notes-dropped").textContent).toBe(
			"1 note couldn't be read",
		);
	});

	it("a note's markup is text: no HTML, no javascript: link, `code` as code", async () => {
		const evil = {
			...NOTES,
			sections: [
				{
					...NOTES.sections[0],
					notes: [
						{
							id: "CAR-1",
							kind: "new",
							prs: [1],
							text: 'Hi <img src=x onerror="window.pwned=1"> [x](javascript:alert(1)) `<b>code</b>` done',
						},
					],
				},
			],
		};
		serve({ notes: () => json(200, evil) });
		show();
		const modal = await openModal();
		const text = await within(modal).findByTestId("release-note-text");
		expect(text.textContent).toBe(
			'Hi <img src=x onerror="window.pwned=1"> [x](javascript:alert(1)) <b>code</b> done',
		);
		expect(modal.querySelector("img, b")).toBeNull();
		expect(text.querySelector("code")?.textContent).toBe("<b>code</b>");
		for (const a of modal.querySelectorAll("a")) {
			expect(a.getAttribute("href")).toMatch(/^https:\/\/github\.com\//);
		}
		expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
	});

	it("opens with focus on its title (no tooltip pops); Escape closes it and focus goes back to What's new", async () => {
		serve({ notes: () => json(200, NOTES) });
		show();
		const modal = await openModal();
		expect(document.activeElement).toBe(
			within(modal).getByRole("heading", { name: "What's new" }),
		);
		expect(shownTips()).not.toContain("Close");
		await userEvent.keyboard("{Escape}");
		expect(modal.hasAttribute("open")).toBe(false);
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: /^Update available/ }),
		);
	});

	it("a failed Retry never sticks: closed, the notes loaded meanwhile, reopened shows them", async () => {
		let notesOk = false;
		serve({
			notes: () =>
				notesOk
					? json(200, NOTES)
					: json(502, { error: "Registry unreachable" }),
			retry: () => json(502, { error: "Registry unreachable" }),
		});
		show();
		const modal = await openModal();
		const alert = await within(modal).findByRole("alert");
		await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
		await waitFor(() =>
			expect(within(modal).getByRole("alert").textContent).toContain(
				"Registry unreachable",
			),
		);
		await userEvent.click(within(modal).getByRole("button", { name: "Close" }));
		// The next check loaded them on the server.
		notesOk = true;
		await openModal();
		await within(modal).findAllByTestId("notes-version");
		expect(within(modal).queryByRole("alert")).toBeNull();
	});

	it("a kind's name: a 40px target that focus (or a tap) opens", async () => {
		serve({ notes: () => json(200, NOTES) });
		show();
		const modal = await openModal();
		const kind = (await within(modal).findAllByRole("img", { name: "New" }))[0];
		if (!kind) throw new Error("no kind icon");
		expect(kind.tabIndex).toBe(0);
		expect(kind.className).toContain("size-10");
		kind.focus();
		await waitFor(() => expect(shownTips()).toContain("New"));
	});

	it("a release day: in days, the day itself on focus, no clock time", async () => {
		const day = new Date(Date.now() - 3 * 86_400_000);
		const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
		serve({
			notes: () =>
				json(200, {
					...NOTES,
					sections: [{ ...NOTES.sections[0], date: iso }],
				}),
		});
		show();
		const modal = await openModal();
		const date = await within(modal).findByTestId("release-date");
		expect(date.textContent).toBe("3 days ago");
		date.focus();
		await waitFor(() => expect(shownTips()).toHaveLength(1));
		expect(shownTips()[0]).toMatch(/^\d{4} [A-Z][a-z]{2} \d{1,2}$/);
	});

	it("no footer when there is nothing to put in it", async () => {
		serve({
			info: { ...OFFER, oneClick: false, command: null, byHand: false },
			notes: () => json(200, NOTES),
		});
		show();
		const modal = await openModal();
		await within(modal).findAllByTestId("notes-version");
		expect(within(modal).queryByTestId("whats-new-footer")).toBeNull();
	});

	it("a release without a date yet: no date at all (never 'Invalid date' or 'now'), its release still linked", async () => {
		serve({
			notes: () =>
				json(200, {
					...NOTES,
					sections: [{ ...NOTES.sections[0], date: null, released: true }],
				}),
		});
		show();
		const modal = await openModal();
		const section = (await within(modal).findAllByTestId("notes-version"))[0];
		if (!section) throw new Error("no section");
		expect(within(section).queryByTestId("release-date")).toBeNull();
		expect(section.querySelector("time")).toBeNull();
		expect(section.textContent).not.toMatch(/Invalid|now|ago/);
		expect(
			within(section).getByRole("link", { name: "Release on GitHub" }),
		).toHaveAttribute(
			"href",
			"https://github.com/Gilthans/carbonless/releases/tag/v0.5.0",
		);
	});
});
