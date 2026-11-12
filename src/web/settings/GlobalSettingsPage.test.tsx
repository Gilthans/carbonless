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
import type { UpdateInfo } from "../../shared/update";
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
	channel: "rc",
	install: "pnpm",
	byHand: false,
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

	it("the running version, its commit, channel, install and last check", async () => {
		serve({ get: () => INFO });
		show();
		const s = await section();
		expect(await within(s).findByText("0.3.0-rc.4")).toBeInTheDocument();
		expect(within(s).getByRole("link", { name: /282f365/ })).toHaveAttribute(
			"href",
			`https://github.com/Gilthans/carbonless/commit/${SHA}`,
		);
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

	it("a newer version: linked to its release, with Update doing what the toast's does", async () => {
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
		expect(
			within(r).getByRole("link", { name: /v0\.3\.0-rc\.7/ }),
		).toHaveAttribute("href", OFFER.releaseUrl);
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
			}),
		});
		show();
		const r = await screen.findByTestId("update-result");
		expect(await within(r).findByTestId("update-command")).toHaveTextContent(
			"pnpm add -g carbonless-review@0.3.0-rc.7",
		);
		expect(within(r).queryByRole("button", { name: "Update" })).toBeNull();
		expect(screen.getByTestId("version-install")).toHaveTextContent(
			"update by hand",
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
			expect(screen.getByText("0.3.0-rc.4")).toBeInTheDocument();
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

	it("a -dirty build: shown as dirty, never linked to the clean commit", async () => {
		serve({ get: () => ({ ...INFO, commit: `${SHA}-dirty` }) });
		show();
		const row = await screen.findByTestId("version-current");
		expect(row).toHaveTextContent("282f365-dirty");
		expect(within(row).queryByRole("link")).toBeNull();
	});

	it("a commit that isn't a SHA: shown, not linked", async () => {
		serve({
			get: () => ({ ...INFO, commit: "unknown", checksOff: "local-build" }),
		});
		show();
		const row = await screen.findByTestId("version-current");
		expect(row).toHaveTextContent("unknown");
		expect(within(row).queryByRole("link")).toBeNull();
	});
});
