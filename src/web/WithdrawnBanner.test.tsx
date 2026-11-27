// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../shared/update";
import { ToastStack } from "./Toasts";
import { UpdateToast } from "./UpdateToast";
import { WithdrawnBanner } from "./WithdrawnBanner";

vi.mock("./files/useSetStates", () => ({ useUnsaved: () => false }));

const WITHDRAWN: UpdateInfo = {
	current: "0.4.0",
	available: "0.4.1",
	releaseUrl: "https://github.com/Gilthans/carbonless/releases/tag/v0.4.1",
	oneClick: true,
	command: "npm install -g carbonless-review@0.4.1",
	state: "idle",
	failed: null,
	commit: "c".repeat(40),
	boot: "boot-1",
	channel: "latest",
	install: "npm",
	byHand: false,
	byHandReason: null,
	byHandManager: null,
	lastChecked: "2026-11-27T10:00:00.000Z",
	checkError: null,
	checksOff: null,
	withdrawn: { reason: "comments posted to the wrong PR" },
};

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A fake crb answering /api/update with `info` (after `hold`, when given). */
function serve(info: UpdateInfo, hold?: Promise<void>) {
	const posts: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/update" && init?.method === "POST") {
				posts.push(JSON.parse(String(init.body)));
				return json(202, { ...info, state: "installing" });
			}
			if (url === "/api/update") {
				await hold;
				return json(200, info);
			}
			return json(404, { error: "not here" });
		}),
	);
	return { posts };
}

function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ToastStack>
				<UpdateToast>
					<WithdrawnBanner />
					<main data-testid="page" />
				</UpdateToast>
			</ToastStack>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const banner = () => screen.findByTestId("withdrawn-banner");

describe("WithdrawnBanner", () => {
	it("nothing while /api/update is pending (no banner, no Fix coming), then the banner", async () => {
		let release: () => void = () => {};
		const hold = new Promise<void>((r) => {
			release = r;
		});
		serve({ ...WITHDRAWN, available: null, command: null }, hold);
		show();
		await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
		expect(screen.queryByTestId("withdrawn-banner")).toBeNull();
		expect(screen.queryByText("Fix coming")).toBeNull();
		release();
		expect(within(await banner()).getByText("Fix coming")).toBeTruthy();
	});

	it("not withdrawn: nothing, and the toast offers the update as always", async () => {
		serve({ ...WITHDRAWN, withdrawn: null });
		show();
		expect(await screen.findByTestId("update-toast")).toBeTruthy();
		expect(screen.queryByTestId("withdrawn-banner")).toBeNull();
	});

	it("with a fix: the icon, Withdrawn, the version and reason, and Update, which opens What's new and installs; the toast doesn't offer it too", async () => {
		const { posts } = serve(WITHDRAWN);
		show();
		const b = await banner();
		// A labelled region, not a live one (no announcement per page).
		expect(b.tagName).toBe("SECTION");
		expect(b.getAttribute("aria-label")).toBe("Withdrawn version");
		expect(b.getAttribute("role")).toBe(null);
		expect(b.getAttribute("aria-live")).toBe(null);
		expect(
			within(b).getByRole("img", { name: "Withdrawn version" }),
		).toBeTruthy();
		expect(within(b).getByText("Withdrawn")).toBeTruthy();
		expect(within(b).getByTestId("withdrawn-reason").textContent).toBe(
			"0.4.0: comments posted to the wrong PR",
		);
		expect(screen.queryByTestId("update-toast")).toBeNull();
		// Never dismissed.
		expect(
			within(b).queryByRole("button", { name: /dismiss|close/i }),
		).toBeNull();
		await userEvent.click(
			within(b).getByRole("button", { name: "Update to 0.4.1" }),
		);
		await userEvent.click(
			await within(screen.getByTestId("whats-new")).findByRole("button", {
				name: "Update to v0.4.1",
			}),
		);
		await waitFor(() => expect(posts).toEqual([{ version: "0.4.1" }]));
	});

	it("without a fix: Fix coming, no Update", async () => {
		serve({ ...WITHDRAWN, available: null, command: null, oneClick: false });
		show();
		const b = await banner();
		expect(within(b).getByTestId("withdrawn-fix-coming").textContent).toBe(
			"Fix coming",
		);
		expect(within(b).queryByRole("button", { name: /Update/ })).toBeNull();
	});

	it("by hand: the command instead of Update", async () => {
		serve({
			...WITHDRAWN,
			oneClick: false,
			byHand: true,
			byHandReason: "not-writable",
		});
		show();
		const b = await banner();
		expect(within(b).getByTestId("update-command").textContent).toBe(
			"npm install -g carbonless-review@0.4.1",
		);
		expect(within(b).queryByRole("button", { name: /^Update/ })).toBeNull();
	});

	it("no reason given: the version alone, no dangling colon", async () => {
		serve({ ...WITHDRAWN, withdrawn: { reason: "" } });
		show();
		const b = await banner();
		expect(within(b).getByTestId("withdrawn-reason").textContent).toBe("0.4.0");
		expect(within(b).getByText("Withdrawn")).toBeTruthy();
	});

	it("crb's check not answered yet: asks again in 3 s, until it has; then the usual poll", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		try {
			let info: UpdateInfo = {
				...WITHDRAWN,
				lastChecked: null,
				withdrawn: null,
				available: null,
				command: null,
			};
			let asked = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => {
					if (url === "/api/update") {
						asked++;
						return json(200, info);
					}
					return json(404, {});
				}),
			);
			show();
			await vi.waitFor(() => expect(asked).toBe(1));
			// Not answered: asked again soon.
			await act(() => vi.advanceTimersByTimeAsync(3_000));
			expect(asked).toBe(2);
			info = { ...WITHDRAWN, available: null, command: null };
			await act(() => vi.advanceTimersByTimeAsync(3_000));
			expect(asked).toBe(3);
			// The answer's render (the query's notify is a timer too).
			await act(() => vi.advanceTimersByTimeAsync(10));
			expect(screen.getByTestId("withdrawn-banner")).toBeTruthy();
			// Answered: back to the usual poll (minutes), no more 3 s asks.
			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(asked).toBe(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("checks off: never the quick asks", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		try {
			let asked = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					asked++;
					return json(200, {
						...WITHDRAWN,
						lastChecked: null,
						withdrawn: null,
						available: null,
						checksOff: "local-build",
					});
				}),
			);
			show();
			await vi.waitFor(() => expect(asked).toBe(1));
			await act(() => vi.advanceTimersByTimeAsync(60_000));
			expect(asked).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("the reason is plain text: markup shows as typed, nothing rendered from it", async () => {
		const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
		serve({ ...WITHDRAWN, withdrawn: { reason: evil } });
		show();
		const b = await banner();
		expect(b.querySelector("img")).toBeNull();
		expect(b.querySelector("b")).toBeNull();
		expect(within(b).getByTestId("withdrawn-reason").textContent).toBe(
			`0.4.0: ${evil}`,
		);
	});
});
