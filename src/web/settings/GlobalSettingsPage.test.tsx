// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectLoadingThen, heldJson } from "../../../test/loading";
import type { ReleaseNote } from "../../shared/releaseNotes";
import type { UpdateInfo } from "../../shared/update";
import type { OwnNotes } from "../../shared/whatsNew";
import { ToastStack } from "../Toasts";
import { UpdateToast } from "../UpdateToast";
import { GlobalSettingsPage } from "./GlobalSettingsPage";

const page = vi.hoisted(() => ({ unsaved: false }));
vi.mock("../files/useSetStates", () => ({ useUnsaved: () => page.unsaved }));

const SHA = "282f365a".padEnd(40, "0");
const INFO: UpdateInfo = {
	current: "0.3.0-rc.4",
	available: null,
	releaseUrl: null,
	oneClick: false,
	command: null,
	state: "idle",
	failed: null,
	commit: SHA,
	boot: "boot-1",
	channel: "rc",
	install: "pnpm",
	byHand: false,
	byHandReason: null,
	byHandManager: null,
	lastChecked: new Date(Date.now() - 3 * 60_000).toISOString(),
	checkError: null,
	checksOff: null,
};
const OFFER: Partial<UpdateInfo> = {
	available: "0.3.0-rc.7",
	releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.3.0-rc.7",
	oneClick: true,
	command: "pnpm add -g carbonless-review@0.3.0-rc.7",
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A fake crb: GET /api/update answers `get()`, the check `check()`. */
function serve(opts: {
	get: () => UpdateInfo | Promise<Response>;
	check?: () => Response | Promise<Response>;
	/** POST /api/update's answer (default: restarting). */
	post?: () => Response;
	/** GET /api/release-notes (default: a build without notes). */
	own?: () => OwnNotes | Promise<Response>;
	/** GET /api/update/notes (default: 404). */
	notes?: () => Response;
}) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${url}`);
			if (url === "/api/update/check" && method === "POST") {
				return opts.check?.() ?? json(409, { error: "no" });
			}
			if (url === "/api/update" && method === "POST") {
				return (
					opts.post?.() ??
					json(202, { ...(opts.get() as UpdateInfo), state: "restarting" })
				);
			}
			if (url === "/api/update") {
				const answer = opts.get();
				return answer instanceof Promise ? answer : json(200, answer);
			}
			if (url === "/api/release-notes") {
				const answer = opts.own?.() ?? {
					current: INFO.current,
					file: false,
					running: null,
					earlier: [],
					dropped: 0,
				};
				return answer instanceof Promise ? answer : json(200, answer);
			}
			if (url === "/api/update/notes") return opts.notes?.() ?? json(404, {});
			if (url === "/api/version") throw new TypeError("Failed to fetch");
			return json(404, {});
		}),
	);
	return calls;
}

function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const root = createRootRoute({
		component: () => (
			<ToastStack>
				<UpdateToast>
					<Outlet />
				</UpdateToast>
			</ToastStack>
		),
	});
	const router = createRouter({
		routeTree: root.addChildren([
			createRoute({
				getParentRoute: () => root,
				path: "/settings",
				component: GlobalSettingsPage,
			}),
		]),
		history: createMemoryHistory({ initialEntries: ["/settings"] }),
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return client;
}

const section = async () => {
	await screen.findByTestId("version-current");
	return screen.getByTestId("settings-version");
};
const checkButton = () =>
	screen.getByRole("button", { name: "Check for updates" });
const result = () => screen.queryByTestId("update-result");

beforeEach(() => {
	page.unsaved = false;
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("GlobalSettingsPage", () => {
	it("loading: a spinner, never a version or 'never checked'", async () => {
		const held = heldJson();
		serve({ get: () => held.response });
		show();
		await expectLoadingThen({
			loading: () =>
				screen.queryByRole("status", { name: "Loading the version" }),
			empty: [
				() => screen.queryByText("never checked"),
				() => screen.queryByTestId("version-current"),
			],
			release: () => held.release(INFO),
			result: () => screen.queryByTestId("version-current"),
		});
	});

	it("the running version linking its release (an RC to its tag), no commit; channel, install and last check", async () => {
		serve({ get: () => INFO });
		show();
		const s = await section();
		const link = await within(s).findByRole("link", {
			name: "Release v0.3.0-rc.4 on GitHub",
		});
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/Gilthans/carbonless/releases/tag/v0.3.0-rc.4",
		);
		expect(link.className).toContain("min-h-10");
		expect(s.textContent).not.toContain("282f365");
		expect(within(s).queryByRole("link", { name: /282f365/ })).toBeNull();
		expect(screen.getByTestId("version-install")).toHaveTextContent(
			"channel rc· pnpm global",
		);
		expect(screen.getByTestId("version-checked")).toHaveTextContent(
			"checked 3 minutes ago",
		);
		expect(result()).toHaveTextContent("Up to date");
	});

	it("Check for updates: a spinner while it checks, then up to date", async () => {
		const held = heldJson();
		const calls = serve({
			get: () => ({ ...INFO, lastChecked: null }),
			check: () => held.response,
		});
		show();
		await section();
		await waitFor(() =>
			expect(screen.getByTestId("version-checked")).toHaveTextContent(
				"never checked",
			),
		);
		expect(result()).toBeNull();
		await userEvent.click(checkButton());
		await waitFor(() => expect(result()).toHaveTextContent("Checking"));
		expect(checkButton()).toBeDisabled();
		expect(screen.queryByText("Up to date")).toBeNull();
		held.release({ ...INFO, lastChecked: new Date().toISOString() });
		await waitFor(() => expect(result()).toHaveTextContent("Up to date"));
		expect(checkButton()).toBeEnabled();
		expect(calls).toContain("POST /api/update/check");
	});

	it("a newer version: What's new opens the modal, and Update does what the toast's does", async () => {
		let now: UpdateInfo = INFO;
		const calls = serve({
			get: () => now,
			check: () => {
				now = { ...INFO, ...OFFER };
				return json(200, now);
			},
		});
		show();
		await section();
		await userEvent.click(checkButton());
		const r = await screen.findByTestId("update-result");
		await waitFor(() => expect(r).toHaveAttribute("data-state", "available"));
		expect(r).toHaveTextContent("v0.3.0-rc.7available");
		await userEvent.click(
			within(r).getByRole("button", { name: "What's new" }),
		);
		const modal = screen.getByTestId("whats-new");
		expect(modal.hasAttribute("open")).toBe(true);
		expect(
			within(modal).getByRole("button", { name: "Update to v0.3.0-rc.7" }),
		).toBeInTheDocument();
		await userEvent.click(within(modal).getByRole("button", { name: "Close" }));
		// The toast offers it too.
		expect(await screen.findByTestId("update-toast")).toHaveAttribute(
			"data-state",
			"available",
		);
		await userEvent.click(within(r).getByRole("button", { name: "Update" }));
		await waitFor(() =>
			expect(screen.getByTestId("update-toast")).toHaveAttribute(
				"data-state",
				"updating",
			),
		);
		expect(
			within(screen.getByTestId("update-result")).getByRole("status", {
				name: "Updating to v0.3.0-rc.7",
			}),
		).toBeInTheDocument();
		expect(calls.filter((c) => c === "POST /api/update")).toHaveLength(1);
	});

	it("unsaved work: the page's Update asks first, as the toast's does", async () => {
		page.unsaved = true;
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		const calls = serve({ get: () => ({ ...INFO, ...OFFER }) });
		show();
		const r = await screen.findByTestId("update-result");
		await waitFor(() => expect(r).toHaveAttribute("data-state", "available"));
		await userEvent.click(within(r).getByRole("button", { name: "Update" }));
		expect(confirm).toHaveBeenCalledOnce();
		expect(calls).not.toContain("POST /api/update");
	});

	it("crb can't update itself: the command to copy, no Update", async () => {
		serve({
			get: () => ({
				...INFO,
				...OFFER,
				oneClick: false,
				install: null,
				byHand: true,
				byHandReason: "no-install",
			}),
		});
		show();
		const r = await screen.findByTestId("update-result");
		expect(await within(r).findByTestId("update-command")).toHaveTextContent(
			"pnpm add -g carbonless-review@0.3.0-rc.7",
		);
		expect(within(r).queryByRole("button", { name: "Update" })).toBeNull();
		const install = screen.getByTestId("version-install");
		expect(install).toHaveTextContent(
			"No auto-update: not an npm/pnpm global install",
		);
		expect(
			within(install).getByRole("link", { name: "How to set up updates" }),
		).toHaveAttribute(
			"href",
			"https://github.com/Gilthans/carbonless/blob/master/docs/faq.md#not-an-npm-or-pnpm-global-install",
		);
	});

	it("by hand with nothing on offer: the install row still says why, as the toast would", async () => {
		serve({
			get: () => ({
				...INFO,
				byHand: true,
				byHandReason: "service",
				byHandManager: "systemd (crb.service)",
			}),
		});
		show();
		const install = await screen.findByTestId("version-install");
		await waitFor(() =>
			expect(install).toHaveTextContent(
				/pnpm global\s*No auto-update: systemd won't restart crb/,
			),
		);
		expect(
			within(install).getByRole("link", { name: "How to set up updates" }),
		).toHaveAttribute(
			"href",
			"https://github.com/Gilthans/carbonless/blob/master/docs/faq.md#systemd-wont-restart-crb",
		);
	});

	it("a failed check says why, and Retry checks again", async () => {
		let n = 0;
		serve({
			get: () => INFO,
			check: () =>
				++n === 1
					? json(200, { ...INFO, checkError: "Registry answered 503" })
					: json(200, INFO),
		});
		show();
		await section();
		await userEvent.click(checkButton());
		await waitFor(() =>
			expect(result()).toHaveTextContent("Check failed: Registry answered 503"),
		);
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(result()).toHaveTextContent("Up to date"));
		expect(n).toBe(2);
	});

	it("a check crb refuses (HTTP error) is a failure too", async () => {
		serve({
			get: () => INFO,
			check: () => json(500, { error: "Internal server error" }),
		});
		show();
		await section();
		await userEvent.click(checkButton());
		await waitFor(() => expect(result()).toHaveTextContent("Check failed"));
		expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
	});

	it.each([
		["local-build", "local build"],
		["env", "CRB_NO_UPDATE_CHECK"],
		["config", "updates.check off"],
	] as const)(
		"updates off (%s): says why, no Check button",
		async (off, why) => {
			serve({
				get: () => ({
					...INFO,
					install: null,
					lastChecked: null,
					checksOff: off,
				}),
			});
			show();
			expect(await screen.findByTestId("updates-off")).toHaveTextContent(
				`updates off: ${why}`,
			);
			expect(screen.getByTestId("version-current")).toHaveTextContent(
				"0.3.0-rc.4",
			);
			expect(
				screen.queryByRole("button", { name: "Check for updates" }),
			).toBeNull();
			expect(result()).toBeNull();
		},
	);

	it("a failed check never hides the update on offer: both show", async () => {
		serve({
			get: () => ({ ...INFO, ...OFFER, checkError: "Registry unreachable" }),
		});
		show();
		const r = await screen.findByTestId("update-result");
		await waitFor(() => expect(r).toHaveAttribute("data-state", "available"));
		expect(within(r).getByRole("button", { name: "Update" })).toBeEnabled();
		expect(within(r).getByTestId("check-failed")).toHaveTextContent(
			"Check failed: Registry unreachable",
		);
		expect(within(r).queryByText("Up to date")).toBeNull();
	});

	it("a failed check request is gone once fresher info arrives", async () => {
		let now: UpdateInfo = INFO;
		serve({
			get: () => now,
			check: () => json(500, { error: "Internal server error" }),
		});
		const client = show();
		await section();
		await userEvent.click(checkButton());
		await waitFor(() => expect(result()).toHaveTextContent("Check failed"));
		// The toast's poll (or another tab's check) brings a newer answer.
		now = { ...INFO, ...OFFER, lastChecked: new Date().toISOString() };
		await client.refetchQueries({ queryKey: ["update"] });
		await waitFor(() =>
			expect(result()).toHaveAttribute("data-state", "available"),
		);
		expect(screen.queryByTestId("check-failed")).toBeNull();
	});

	it("Check is off while crb installs or restarts", async () => {
		serve({ get: () => ({ ...INFO, ...OFFER, state: "installing" }) });
		show();
		await section();
		expect(checkButton()).toBeDisabled();
	});

	it("Check is off once this page's Update started, before crb says so", async () => {
		serve({
			get: () => ({ ...INFO, ...OFFER, checkError: "Registry unreachable" }),
			// crb answers still idle (the page's phase is what says updating).
			post: () => json(202, { ...INFO, ...OFFER }),
		});
		show();
		const r = await screen.findByTestId("update-result");
		await waitFor(() => expect(r).toHaveAttribute("data-state", "available"));
		expect(checkButton()).toBeEnabled();
		await userEvent.click(within(r).getByRole("button", { name: "Update" }));
		await waitFor(() => expect(checkButton()).toBeDisabled());
		// No failure under a toast that says Updating.
		expect(screen.queryByTestId("check-failed")).toBeNull();
	});

	it("a local build: its version as plain text, no release link, no commit", async () => {
		serve({
			get: () => ({
				...INFO,
				commit: `${SHA}-dirty`,
				checksOff: "local-build",
			}),
		});
		show();
		const row = await screen.findByTestId("version-current");
		expect(row).toHaveTextContent("0.3.0-rc.4");
		expect(row.textContent).not.toContain("282f365");
		expect(within(row).queryByRole("link")).toBeNull();
	});

	it("a version that isn't one is never linked", async () => {
		serve({ get: () => ({ ...INFO, current: "0.3.0/../../x" }) });
		show();
		const row = await screen.findByTestId("version-current");
		expect(row).toHaveTextContent("0.3.0/../../x");
		expect(within(row).queryByRole("link")).toBeNull();
	});

	describe("the running version's notes", () => {
		const note = (
			id: string,
			text: string,
			kind: ReleaseNote["kind"] = "new",
		) => ({
			id,
			kind,
			prs: [Number(id.replace(/\D/g, ""))],
			text,
		});
		const OWN: OwnNotes = {
			current: INFO.current,
			file: true,
			dropped: 0,
			running: {
				version: INFO.current,
				date: null,
				released: false,
				uncovered: [],
				notes: [
					note("CAR-1", "Threads tab. Every conversation, newest first."),
					note("CAR-2", "One agent conversation."),
					note("CAR-3", "Whitespace fix.", "fixed"),
					note("CAR-4", "A fourth note."),
				],
			},
			earlier: [
				{
					version: "0.2.0",
					date: "2026-11-01T10:00:00.000Z",
					released: true,
					uncovered: [],
					notes: [note("CAR-0", "An earlier one.")],
				},
			],
		};
		const texts = () =>
			screen.queryAllByTestId("release-note-text").map((t) => t.textContent);

		it("loading: skeletons, never 'No user-facing changes'; then the first three, first sentence each", async () => {
			const held = heldJson();
			serve({ get: () => INFO, own: () => held.response });
			show();
			await section();
			await expectLoadingThen({
				loading: () =>
					screen.queryByRole("status", { name: "Loading the release notes" }),
				empty: [() => screen.queryByText("No user-facing changes")],
				release: () => held.release(OWN),
				result: () => screen.queryAllByTestId("release-note")[0] ?? null,
			});
			expect(texts()).toEqual([
				"Threads tab.",
				"One agent conversation.",
				"Whitespace fix.",
			]);
		});

		it("Show more: the running version in full, then 5 older versions folded, each with its own Show more; Show less folds back", async () => {
			serve({ get: () => INFO, own: () => OWN });
			show();
			await section();
			const more = await screen.findByTestId("running-notes-toggle");
			expect(more).toHaveAttribute("aria-expanded", "false");
			await userEvent.click(more);
			expect(texts()).toEqual([
				"Threads tab. Every conversation, newest first.",
				"One agent conversation.",
				"Whitespace fix.",
				"A fourth note.",
				"An earlier one.",
			]);
			expect(
				screen.getAllByTestId("notes-version").map((s) => s.dataset.version),
			).toEqual(["0.2.0"]);
			// One earlier version: no Show more versions.
			expect(screen.queryByTestId("more-versions")).toBeNull();
			await userEvent.click(screen.getByTestId("running-notes-toggle"));
			expect(texts()).toHaveLength(3);
		});

		it("Show more versions: 5 at a time, all the way back; an older version's own Show more opens its notes in full", async () => {
			// Twelve earlier releases, newest first, as the package's file
			// carries them (uncapped); each with four notes, the first long.
			const earlier = Array.from({ length: 12 }, (_, i) => {
				const v = `0.1.${11 - i}`;
				return {
					version: v,
					date: "2026-10-01",
					released: true,
					uncovered: [],
					notes: [
						note("CAR-1", `Note one of ${v}. More of it.`),
						note("CAR-2", `Note two of ${v}.`),
						note("CAR-3", `Note three of ${v}.`),
						note("CAR-4", `Note four of ${v}.`),
					],
				};
			});
			serve({ get: () => INFO, own: () => ({ ...OWN, earlier }) });
			show();
			await section();
			await userEvent.click(await screen.findByTestId("running-notes-toggle"));
			const versions = () =>
				screen.getAllByTestId("notes-version").map((s) => s.dataset.version);
			expect(versions()).toEqual([
				"0.1.11",
				"0.1.10",
				"0.1.9",
				"0.1.8",
				"0.1.7",
			]);
			// Each older version's number links its release (no separate ↗).
			const first0 = screen.getAllByTestId("notes-version")[0] as HTMLElement;
			expect(
				within(first0).getByRole("link", { name: "Release v0.1.11 on GitHub" }),
			).toHaveAttribute(
				"href",
				"https://github.com/Gilthans/carbonless/releases/tag/v0.1.11",
			);
			expect(
				within(first0).getAllByRole("link", { name: /Release/ }),
			).toHaveLength(1);
			// Each older version folded: its first 3 notes, first sentence each.
			const first = screen.getAllByTestId("notes-version")[0] as HTMLElement;
			expect(
				within(first)
					.getAllByTestId("release-note-text")
					.map((t) => t.textContent),
			).toEqual([
				"Note one of 0.1.11.",
				"Note two of 0.1.11.",
				"Note three of 0.1.11.",
			]);
			await userEvent.click(
				within(first).getByRole("button", { name: /Show more/ }),
			);
			expect(
				within(first)
					.getAllByTestId("release-note-text")
					.map((t) => t.textContent),
			).toEqual([
				"Note one of 0.1.11. More of it.",
				"Note two of 0.1.11.",
				"Note three of 0.1.11.",
				"Note four of 0.1.11.",
			]);
			await userEvent.click(screen.getByTestId("more-versions"));
			expect(versions()).toHaveLength(10);
			await userEvent.click(screen.getByTestId("more-versions"));
			expect(versions()).toHaveLength(12);
			expect(versions().at(-1)).toBe("0.1.0");
			expect(screen.queryByTestId("more-versions")).toBeNull();
			// Folded and opened again: back to the first 5.
			await userEvent.click(screen.getByTestId("running-notes-toggle"));
			await userEvent.click(screen.getByTestId("running-notes-toggle"));
			expect(versions()).toHaveLength(5);
		});

		it("an RC with changes but no notes yet: the count shows folded, never 'No user-facing changes'", async () => {
			serve({
				get: () => INFO,
				own: () => ({
					...OWN,
					running: {
						...(OWN.running as NonNullable<OwnNotes["running"]>),
						notes: [],
						uncovered: [131, 129, 140],
					},
					earlier: [],
				}),
			});
			show();
			await section();
			expect(await screen.findByTestId("notes-uncovered")).toHaveTextContent(
				"3 more changes, no notes yet",
			);
			expect(screen.queryByText("No user-facing changes")).toBeNull();
		});

		it("What's new opens after a failed Update, on a click, and only then", async () => {
			serve({
				get: () => ({ ...INFO, ...OFFER }),
				post: () => json(409, { error: "An update is already under way" }),
			});
			show();
			await section();
			const r = await screen.findByTestId("update-result");
			await userEvent.click(within(r).getByRole("button", { name: "Update" }));
			await waitFor(() =>
				expect(screen.getByTestId("update-toast")).toHaveAttribute(
					"data-state",
					"failed",
				),
			);
			const modal = screen.getByTestId("whats-new");
			expect(modal.hasAttribute("open")).toBe(false);
			await userEvent.click(
				within(r).getByRole("button", { name: "What's new" }),
			);
			expect(modal.hasAttribute("open")).toBe(true);
		});

		it("a local build (no notes file) shows none; a version without notes says so", async () => {
			serve({ get: () => INFO });
			show();
			await section();
			await waitFor(() =>
				expect(screen.queryByTestId("running-notes")).toBeNull(),
			);
			expect(screen.queryByText("No user-facing changes")).toBeNull();
			cleanup();
			vi.unstubAllGlobals();
			serve({
				get: () => INFO,
				own: () => ({
					...OWN,
					running: {
						...(OWN.running as NonNullable<OwnNotes["running"]>),
						notes: [],
					},
					earlier: [],
				}),
			});
			show();
			await section();
			expect(
				await screen.findByText("No user-facing changes"),
			).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
		});
	});
});
