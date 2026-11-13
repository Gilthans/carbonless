// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
	channel: "latest",
	install: "npm",
	byHand: false,
	lastChecked: "2026-11-12T10:00:00.000Z",
	checkError: null,
	checksOff: null,
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A fake crb: /api/update answers `info()`, /api/version `version()`. */
function serve(opts: {
	info: () => UpdateInfo;
	version?: () => string | null;
	post?: () => Response;
}) {
	const posts: unknown[] = [];
	const asked = { version: 0 };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/update" && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return (
					opts.post?.() ?? json(202, { ...opts.info(), state: "restarting" })
				);
			}
			if (url === "/api/update") return json(200, opts.info());
			if (url === "/api/version") {
				asked.version++;
				const v = opts.version?.() ?? null;
				if (v === null) throw new TypeError("Failed to fetch");
				return json(200, { version: v, commit: "x" });
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

	it("an offer: the version linking to its release, Update and a dismiss, in the toast stack", async () => {
		serve({ info: () => OFFER });
		show();
		const t = await toast();
		expect(t.dataset.state).toBe("available");
		expect(t.textContent).toContain("Update available");
		expect(
			screen.getByRole("link", { name: "v0.3.0" }).getAttribute("href"),
		).toBe(OFFER.releaseUrl);
		expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
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

	it("crb can't update itself: the command to copy, no Update", async () => {
		serve({ info: () => ({ ...OFFER, oneClick: false }) });
		show();
		await toast();
		expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
		expect(screen.getByTestId("update-command").textContent).toBe(
			OFFER.command,
		);
		expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy();
	});

	it("Copy command says Copied, or Copy failed with the command selected (CAR-121)", async () => {
		serve({ info: () => ({ ...OFFER, oneClick: false }) });
		show();
		await toast();
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
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
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
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(posts).toEqual([]);
		expect((await toast()).dataset.state).toBe("available");
		confirm.mockReturnValue(true);
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
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
		let info: UpdateInfo = OFFER;
		serve({ info: () => info, version: () => "0.2.0" });
		show();
		await toast();
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
		info = {
			...OFFER,
			failed: {
				version: "0.3.0",
				tail: "npm error code E404",
				command: OFFER.command as string,
			},
		};
		await waitFor(
			async () => expect((await toast()).dataset.state).toBe("failed"),
			{ timeout: 5000 },
		);
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

	it("a refused Update: the failure, with the server's reason", async () => {
		serve({
			info: () => OFFER,
			post: () => json(409, { error: "An update is already under way" }),
		});
		show();
		await toast();
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
		await waitFor(async () =>
			expect((await toast()).dataset.state).toBe("failed"),
		);
		expect(screen.getByTestId("update-output").textContent).toBe(
			"An update is already under way",
		);
	});
});
