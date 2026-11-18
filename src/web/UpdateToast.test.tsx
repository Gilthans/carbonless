// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../shared/update";
import { ToastStack } from "./Toasts";
import { BACK_LIMIT_MS, BACK_POLL_MS, UpdateToast } from "./UpdateToast";

// Whether the page has unsaved work (useUnsavedGuard's condition).
const page = vi.hoisted(() => ({ unsaved: false }));
vi.mock("./files/useSetStates", () => ({ useUnsaved: () => page.unsaved }));

// user-event stubs the Clipboard API; what reaches the clipboard is
// copyText's (copyText.test.ts). Here: what each outcome shows.
const copied = vi.hoisted(() => ({ ok: true, texts: [] as string[] }));
vi.mock("./copyText", () => ({
	copyText: async (text: string) => {
		copied.texts.push(text);
		return copied.ok;
	},
}));

const OFFER: UpdateInfo = {
	current: "0.2.0",
	available: "0.3.0",
	releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.3.0",
	oneClick: true,
	command: "npm install -g carbonless-review@0.3.0",
	state: "idle",
	failed: null,
	commit: "c".repeat(40),
	boot: "boot-1",
	channel: "latest",
	install: "npm",
	byHand: false,
	byHandReason: null,
	byHandManager: null,
	lastChecked: "2026-11-12T10:00:00.000Z",
	checkError: null,
	checksOff: null,
};

const FAILED = {
	version: "0.3.0",
	tail: "npm error code E404",
	command: OFFER.command as string,
};

/** Fake timers (and Date): the wait's ticks move only when a test says. */
const fakeTimers = () =>
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	});

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/**
 * A fake crb: /api/update answers `info()`, /api/version `version()` (null:
 * down) from process `boot()` (default OFFER's).
 */
function serve(opts: {
	info: () => UpdateInfo;
	version?: () => string | null;
	/** Which crb answers /api/version; undefined: one too old to say. */
	boot?: () => string | undefined;
	post?: () => Response;
	/** Holds a GET /api/update's answer (read at its start) until it settles. */
	hold?: () => Promise<void> | undefined;
}) {
	const posts: unknown[] = [];
	const asked = { version: 0, update: 0 };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/update" && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return (
					opts.post?.() ?? json(202, { ...opts.info(), state: "restarting" })
				);
			}
			if (url === "/api/update") {
				asked.update++;
				const body = opts.info();
				await opts.hold?.();
				return json(200, body);
			}
			if (url === "/api/version") {
				asked.version++;
				const v = opts.version?.() ?? null;
				if (v === null) throw new TypeError("Failed to fetch");
				return json(200, {
					version: v,
					commit: "x",
					boot: opts.boot ? opts.boot() : OFFER.boot,
				});
			}
			return json(404, {});
		}),
	);
	return { posts, asked };
}

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
	page.unsaved = false;
	localStorage.clear();
	reload = vi.fn();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

let client: QueryClient;
function show() {
	client = new QueryClient({
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

const toast = () => screen.findByTestId("update-toast");

/** The toast's What's new, then the modal's Update (the toast has none of its own). */
/**
 * clickUpdate under fake timers: the toast's button, then the modal's
 * Update, each in its own act (never inside another: the modal must render
 * between the two).
 */
function clickUpdateNow(version = "0.3.0") {
	fireEvent.click(screen.getByTestId("update-open"));
	// The dialog opens in an effect; read the button by its text, at once.
	const update = screen
		.getByTestId("whats-new")
		.querySelector<HTMLButtonElement>("[data-testid=whats-new-footer] button");
	if (update?.textContent !== `Update to v${version}`) {
		throw new Error(`no Update to v${version} in What's new`);
	}
	fireEvent.click(update);
}

async function clickUpdate(version = "0.3.0") {
	await userEvent.click(
		screen.getByRole("button", { name: /^Update available/ }),
	);
	await userEvent.click(
		await screen.findByRole("button", { name: `Update to v${version}` }),
	);
}

describe("UpdateToast", () => {
	it("nothing on offer: nothing shown", async () => {
		const fetch = serve({
			info: () => ({
				...OFFER,
				available: null,
				releaseUrl: null,
				command: null,
				oneClick: false,
			}),
		});
		show();
		await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
		expect(screen.queryByTestId("update-toast")).toBeNull();
		expect(fetch.posts).toEqual([]);
	});

	it("an offer: the version, What's new (no Update of its own) and a dismiss, in the toast stack", async () => {
		serve({ info: () => OFFER });
		show();
		const t = await toast();
		expect(t.dataset.state).toBe("available");
		expect(t.textContent).toContain("Update available");
		expect(t.textContent).toContain("v0.3.0");
		expect(within(t).queryByRole("link")).toBeNull();
		// The offer itself is the one button (What's new); no Update of its own.
		const open = within(t).getByRole("button", {
			name: "Update available v0.3.0",
		});
		expect(open.dataset.testid).toBe("update-open");
		expect(
			within(t)
				.getAllByRole("button")
				.map((b) => b.getAttribute("aria-label") ?? b.textContent),
		).toEqual(["Update available v0.3.0", "Dismiss"]);
		await userEvent.click(open);
		expect(screen.getByTestId("whats-new").hasAttribute("open")).toBe(true);
		expect(screen.getByTestId("toast-stack").contains(t)).toBe(true);
		expect(screen.queryByTestId("update-command")).toBeNull();
	});

	it("dismissed per version: stays dismissed, a newer one shows again", async () => {
		let info = OFFER;
		serve({ info: () => info });
		const first = show();
		await toast();
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByTestId("update-toast")).toBeNull();
		first.unmount();
		show();
		await waitFor(() =>
			expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2),
		);
		expect(screen.queryByTestId("update-toast")).toBeNull();
		cleanup();
		info = { ...OFFER, available: "0.4.0" };
		show();
		expect((await toast()).textContent).toContain("Update available");
	});

	it("crb can't update itself: the command to copy in What's new, none in the toast, no Update", async () => {
		serve({ info: () => ({ ...OFFER, oneClick: false }) });
		show();
		const t = await toast();
		expect(within(t).queryByTestId("update-command")).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: /^Update available/ }),
		);
		await screen.findByTestId("update-command");
		expect(screen.queryByRole("button", { name: /^Update( to|$)/ })).toBeNull();
		expect(screen.getByTestId("update-command").textContent).toBe(
			OFFER.command,
		);
		expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
	});

	it("crb can't update itself: why, in one line, with the FAQ section on setting it up; the command stays", async () => {
		const FAQ =
			"https://github.com/Gilthans/carbonless/blob/master/docs/faq.md";
		const cases: [Partial<UpdateInfo>, string, string][] = [
			[
				{ byHandReason: "no-install" },
				"No auto-update: not an npm/pnpm global install",
				"not-an-npm-or-pnpm-global-install",
			],
			[
				{ byHandReason: "not-writable" },
				"No auto-update: installed in a folder crb can't write",
				"installed-in-a-folder-crb-cant-write",
			],
			[
				{ byHandReason: "service", byHandManager: "systemd (crb.service)" },
				"No auto-update: systemd won't restart crb",
				"systemd-wont-restart-crb",
			],
			[
				{ byHandReason: "service", byHandManager: "PID 1" },
				"No auto-update: crb is PID 1, nothing restarts it",
				"crb-is-a-containers-pid-1",
			],
		];
		for (const [over, text, anchor] of cases) {
			serve({
				info: () => ({ ...OFFER, oneClick: false, byHand: true, ...over }),
			});
			show();
			const t = await toast();
			expect(within(t).queryByTestId("update-by-hand")).toBeNull();
			await userEvent.click(
				within(t).getByRole("button", { name: /^Update available/ }),
			);
			const m = await screen.findByTestId("whats-new-footer");
			expect(within(m).getByTestId("update-by-hand")).toHaveTextContent(text);
			expect(
				within(m).getByRole("link", { name: "How to set up updates" }),
			).toHaveAttribute("href", `${FAQ}#${anchor}`);
			expect(within(m).getByTestId("update-command")).toHaveTextContent(
				OFFER.command ?? "",
			);
			expect(
				within(m).queryByRole("button", { name: /^Update( to|$)/ }),
			).toBeNull();
			cleanup();
			vi.unstubAllGlobals();
		}
		// One click: no reason, no link.
		serve({ info: () => OFFER });
		show();
		await toast();
		await userEvent.click(
			screen.getByRole("button", { name: /^Update available/ }),
		);
		await screen.findByRole("button", { name: "Update to v0.3.0" });
		expect(screen.queryByTestId("update-by-hand")).toBeNull();
	});

	it("Copy command says Copied, or Copy failed with the command selected (CAR-121)", async () => {
		serve({ info: () => ({ ...OFFER, oneClick: false }) });
		show();
		await toast();
		await userEvent.click(
			screen.getByRole("button", { name: /^Update available/ }),
		);
		await screen.findByTestId("update-command");
		copied.ok = true;
		copied.texts = [];
		await userEvent.click(screen.getByRole("button", { name: "Copy command" }));
		expect(copied.texts).toEqual([OFFER.command]);
		await screen.findByRole("button", { name: "Copied" });
		copied.ok = false;
		await userEvent.click(screen.getByRole("button", { name: "Copied" }));
		await screen.findByRole("button", { name: "Copy failed" });
		expect(window.getSelection()?.toString()).toBe(OFFER.command);
		window.getSelection()?.removeAllRanges();
	});

	it("Update: posts the version, shows it updating, reloads once crb answers the new version", async () => {
		let version: string | null = null;
		const { posts, asked } = serve({
			info: () => OFFER,
			version: () => version,
		});
		show();
		await toast();
		await clickUpdate();
		const t = await toast();
		await waitFor(() => expect(t.dataset.state).toBe("updating"));
		expect(t.textContent).toContain("Updating to v0.3.0");
		expect(posts).toEqual([{ version: "0.3.0" }]);
		// Down while it installs (crb asked, no answer): still updating,
		// never empty.
		await waitFor(() => expect(asked.version).toBeGreaterThan(0), {
			timeout: 5000,
		});
		expect((await toast()).dataset.state).toBe("updating");
		expect(reload).not.toHaveBeenCalled();
		version = "0.3.0";
		await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000 });
	});

	it("crb back with unsaved work on the page: no reload by itself; Reload, which the browser's leave ask guards", async () => {
		page.unsaved = true;
		// Another tab's update: this page's reviewer was asked nothing.
		serve({
			info: () => ({ ...OFFER, state: "restarting" }),
			version: () => "0.3.0",
		});
		show();
		await waitFor(
			async () => expect((await toast()).dataset.state).toBe("back"),
			{ timeout: 5000 },
		);
		expect(reload).not.toHaveBeenCalled();
		expect((await toast()).textContent).toContain("Updated to v0.3.0");
		await userEvent.click(screen.getByRole("button", { name: "Reload" }));
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("this tab's Update with unsaved work: asks first; back, the reload is the reviewer's again", async () => {
		page.unsaved = true;
		let version: string | null = null;
		const { posts } = serve({ info: () => OFFER, version: () => version });
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		show();
		await toast();
		await clickUpdate();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(posts).toEqual([]);
		expect((await toast()).dataset.state).toBe("available");
		confirm.mockReturnValue(true);
		await clickUpdate();
		expect(posts).toEqual([{ version: "0.3.0" }]);
		version = "0.3.0";
		// Edits made while crb was down are as unsaved as any: no reload
		// past the browser's ask.
		await waitFor(
			async () => expect((await toast()).dataset.state).toBe("back"),
			{ timeout: 5000 },
		);
		expect(reload).not.toHaveBeenCalled();
	});

	it("crb never comes back: after BACK_LIMIT_MS, a failure with the command", async () => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		const { asked } = serve({
			info: () => ({ ...OFFER, state: "restarting" }),
			version: () => null,
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
		await act(() => vi.advanceTimersByTimeAsync(BACK_LIMIT_MS - BACK_POLL_MS));
		// Still asking, still updating, just short of the limit.
		expect(asked.version).toBeGreaterThan(100);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
		await act(() => vi.advanceTimersByTimeAsync(3 * BACK_POLL_MS));
		const t = screen.getByTestId("update-toast");
		expect(t.dataset.state).toBe("failed");
		expect(screen.getByTestId("update-output").textContent).toBe(
			"crb did not come back with 0.3.0 within 5 minutes",
		);
		expect(screen.getByTestId("update-command").textContent).toBe(
			OFFER.command,
		);
		expect(reload).not.toHaveBeenCalled();
	});

	it("a failure: Retry updates again; its dismiss leaves the offer", async () => {
		const failed = {
			version: "0.3.0",
			tail: "EACCES",
			command: OFFER.command as string,
		};
		const { posts } = serve({ info: () => ({ ...OFFER, failed }) });
		show();
		expect((await toast()).dataset.state).toBe("failed");
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect((await toast()).dataset.state).toBe("available");
		cleanup();
		show();
		expect((await toast()).dataset.state).toBe("failed");
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(posts).toEqual([{ version: "0.3.0" }]);
		await waitFor(async () =>
			expect((await toast()).dataset.state).toBe("updating"),
		);
	});

	it("another tab's update: shows it updating too", async () => {
		serve({
			info: () => ({ ...OFFER, state: "restarting" }),
			version: () => null,
		});
		show();
		await waitFor(async () =>
			expect((await toast()).dataset.state).toBe("updating"),
		);
	});

	it("crb now runs the version on offer (an update this page missed): reloads", async () => {
		let info = OFFER;
		serve({ info: () => info });
		show();
		await toast();
		info = {
			...OFFER,
			current: "0.3.0",
			available: null,
			releaseUrl: null,
			command: null,
		};
		await client.refetchQueries({ queryKey: ["update"] });
		await waitFor(() => expect(reload).toHaveBeenCalled());
	});

	it("crb back on the old version with the install's failure: the output and the command", async () => {
		fakeTimers();
		let info: UpdateInfo = OFFER;
		let boot = "boot-1";
		const { posts } = serve({
			info: () => info,
			version: () => "0.2.0",
			boot: () => boot,
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		clickUpdateNow();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(posts).toEqual([{ version: "0.3.0" }]);
		// The old crb again, its install failed (never seen down).
		boot = "boot-2";
		info = { ...OFFER, boot, failed: FAILED };
		await act(() => vi.advanceTimersByTimeAsync(BACK_POLL_MS));
		expect(screen.getByRole("alert").textContent).toContain(
			"Update to v0.3.0 failed",
		);
		expect(screen.getByTestId("update-output").textContent).toBe(
			"npm error code E404",
		);
		expect(screen.getByTestId("update-command").textContent).toBe(
			OFFER.command,
		);
		expect(reload).not.toHaveBeenCalled();
	});

	it("crb announced its restart: only /api/version while that crb answers, never /api/update it may stop under (CAR-177)", async () => {
		fakeTimers();
		// Another tab's Update: crb boot-1 restarts, in its grace.
		let info: UpdateInfo = { ...OFFER, state: "restarting" };
		let version: string | null = "0.2.0";
		let boot = "boot-1";
		const { asked } = serve({
			info: () => info,
			version: () => version,
			boot: () => boot,
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
		const before = asked.update;
		await act(() => vi.advanceTimersByTimeAsync(10 * BACK_POLL_MS));
		expect(asked.version).toBeGreaterThanOrEqual(9);
		expect(asked.update).toBe(before);
		// Down: still only /api/version.
		version = null;
		await act(() => vi.advanceTimersByTimeAsync(2 * BACK_POLL_MS));
		expect(asked.update).toBe(before);
		// Another crb, on the old version: /api/update says why.
		version = "0.2.0";
		boot = "boot-2";
		info = { ...OFFER, boot, failed: FAILED };
		await act(() => vi.advanceTimersByTimeAsync(BACK_POLL_MS));
		expect(asked.update).toBe(before + 1);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("failed");
		expect(screen.getByTestId("update-output").textContent).toBe(
			"npm error code E404",
		);
	});

	it("a poll still out when Update is clicked never lands over the POST's answer (CAR-177)", async () => {
		fakeTimers();
		let release: () => void = () => {};
		let held: Promise<void> | undefined;
		let info: UpdateInfo = OFFER;
		const { asked } = serve({
			info: () => info,
			version: () => "0.2.0",
			hold: () => held,
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		held = new Promise((r) => {
			release = r;
		});
		void client.refetchQueries({ queryKey: ["update"] });
		await act(() => vi.advanceTimersByTimeAsync(0));
		held = undefined;
		// The poll read "idle"; Update's answer says restarting.
		info = { ...OFFER, state: "restarting" };
		clickUpdateNow();
		await act(() => vi.advanceTimersByTimeAsync(0));
		await act(async () => release());
		await act(() => vi.advanceTimersByTimeAsync(0));
		const before = asked.update;
		await act(() => vi.advanceTimersByTimeAsync(3 * BACK_POLL_MS));
		expect(asked.update).toBe(before);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
	});

	it("crb older than boot ids: /api/update every tick, as before", async () => {
		fakeTimers();
		const { boot: _, ...old } = { ...OFFER, state: "restarting" as const };
		const { asked } = serve({
			info: () => old as UpdateInfo,
			version: () => "0.2.0",
			boot: () => undefined,
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		const before = asked.update;
		await act(() => vi.advanceTimersByTimeAsync(3 * BACK_POLL_MS));
		expect(asked.update).toBe(before + 3);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
	});

	it("this page's Update got no answer: /api/update says what crb does; restarting, then only /api/version (CAR-177)", async () => {
		fakeTimers();
		let info: UpdateInfo = OFFER;
		const { posts, asked } = serve({
			info: () => info,
			version: () => "0.2.0",
			post: () => {
				info = { ...OFFER, state: "restarting" };
				throw new TypeError("Failed to fetch");
			},
		});
		show();
		await act(() => vi.advanceTimersByTimeAsync(0));
		clickUpdateNow();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(posts).toEqual([{ version: "0.3.0" }]);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
		const before = asked.update;
		await act(() => vi.advanceTimersByTimeAsync(BACK_POLL_MS));
		expect(asked.update).toBe(before + 1);
		await act(() => vi.advanceTimersByTimeAsync(5 * BACK_POLL_MS));
		expect(asked.update).toBe(before + 1);
		expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
	});

	for (const answered of [true, false]) {
		it(`a service's install while crb serves (Update ${answered ? "answered" : "unanswered"}): asks /api/update until it fails, the failure shown (CAR-177)`, async () => {
			fakeTimers();
			let info: UpdateInfo = OFFER;
			const { asked } = serve({
				info: () => info,
				version: () => "0.2.0",
				post: () => {
					info = { ...OFFER, state: "installing" };
					if (!answered) throw new TypeError("Failed to fetch");
					return json(202, info);
				},
			});
			show();
			await act(() => vi.advanceTimersByTimeAsync(0));
			clickUpdateNow();
			await act(() => vi.advanceTimersByTimeAsync(0));
			const before = asked.update;
			await act(() => vi.advanceTimersByTimeAsync(2 * BACK_POLL_MS));
			expect(asked.update).toBe(before + 2);
			expect(screen.getByTestId("update-toast").dataset.state).toBe("updating");
			info = { ...OFFER, failed: FAILED };
			await act(() => vi.advanceTimersByTimeAsync(BACK_POLL_MS));
			expect(screen.getByTestId("update-toast").dataset.state).toBe("failed");
			expect(screen.getByTestId("update-output").textContent).toBe(
				"npm error code E404",
			);
		});
	}

	it("a refused Update: the failure, with the server's reason", async () => {
		serve({
			info: () => OFFER,
			post: () => json(409, { error: "An update is already under way" }),
		});
		show();
		await toast();
		await clickUpdate();
		await waitFor(async () =>
			expect((await toast()).dataset.state).toBe("failed"),
		);
		expect(screen.getByTestId("update-output").textContent).toBe(
			"An update is already under way",
		);
	});
});
