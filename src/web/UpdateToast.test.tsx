// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../shared/update";
import { ToastStack } from "./Toasts";
import { UpdateToast } from "./UpdateToast";

const OFFER: UpdateInfo = {
	current: "0.2.0",
	available: "0.3.0",
	releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.3.0",
	oneClick: true,
	command: "npm install -g carbonless-review@0.3.0",
	state: "idle",
	failed: null,
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
				const v = opts.version?.() ?? null;
				if (v === null) throw new TypeError("Failed to fetch");
				return json(200, { version: v, commit: "x" });
			}
			return json(404, {});
		}),
	);
	return { posts };
}

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
	localStorage.clear();
	reload = vi.fn();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
});
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

	it("Update: posts the version, shows it updating, reloads once crb answers the new version", async () => {
		let version: string | null = "0.2.0";
		const { posts } = serve({ info: () => OFFER, version: () => version });
		show();
		await toast();
		await userEvent.click(screen.getByRole("button", { name: "Update" }));
		const t = await toast();
		await waitFor(() => expect(t.dataset.state).toBe("updating"));
		expect(t.textContent).toContain("Updating to v0.3.0");
		expect(posts).toEqual([{ version: "0.3.0" }]);
		// Down while it installs: still updating, never empty.
		version = null;
		await new Promise((r) => setTimeout(r, 1200));
		expect((await toast()).dataset.state).toBe("updating");
		expect(reload).not.toHaveBeenCalled();
		version = "0.3.0";
		await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 5000 });
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

	it("a failure crb reports at start shows until dismissed", async () => {
		serve({
			info: () => ({
				...OFFER,
				failed: {
					version: "0.3.0",
					tail: "EACCES",
					command: OFFER.command as string,
				},
			}),
		});
		show();
		expect((await toast()).dataset.state).toBe("failed");
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByTestId("update-toast")).toBeNull();
	});
});
