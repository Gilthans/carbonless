// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, JoinLeave } from "../../shared/agent";
import type { PrOverview } from "../../shared/types";
import { overviewQuery } from "../api";
import { agentStatusQuery } from "./api";
import {
	JoinToast,
	leftWord,
	resetJoinToasts,
	TOAST_MS,
	takeLeft,
} from "./JoinToast";

const status = (left?: { why: JoinLeave; at: string }): AgentStatus => ({
	state: "off",
	configured: true,
	since: "2026-11-10T10:00:00Z",
	waiting: 1,
	...(left
		? { left: { name: "carbonless · main", machine: "devbox", ...left } }
		: {}),
});

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
	visibility = v;
	document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
	resetJoinToasts();
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function show(first: AgentStatus) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(agentStatusQuery.queryKey, first);
	client.setQueryData(overviewQuery.queryKey, { writes: "on" } as PrOverview);
	const view = render(
		<QueryClientProvider client={client}>
			<JoinToast />
		</QueryClientProvider>,
	);
	const set = (s: AgentStatus) =>
		act(async () => client.setQueryData(agentStatusQuery.queryKey, s));
	return { client, set, view };
}

describe("which leave is toasted", () => {
	it("not the one already there on the first read; each new one once", () => {
		const old = { why: "lost" as const, at: "2026-11-10T09:00:00Z" };
		expect(takeLeft("r1", status(old))).toBeNull();
		expect(takeLeft("r1", status(old))).toBeNull();
		const next = { why: "detached" as const, at: "2026-11-10T10:00:00Z" };
		expect(takeLeft("r1", status(next))).toMatchObject(next);
		expect(takeLeft("r1", status(next))).toBeNull();
		// Another review keeps its own first read.
		expect(takeLeft("r2", status(next))).toBeNull();
	});

	it("a first read with none: the first leave after is toasted", () => {
		expect(takeLeft("r1", status())).toBeNull();
		const left = { why: "replaced" as const, at: "2026-11-10T10:00:00Z" };
		expect(takeLeft("r1", status(left))).toMatchObject(left);
	});

	it("words: left (its detach, your Disconnect), disconnected (lost), replaced", () => {
		expect(leftWord("detached")).toBe("left");
		expect(leftWord("disconnected")).toBe("left");
		expect(leftWord("lost")).toBe("disconnected");
		expect(leftWord("replaced")).toBe("replaced");
	});
});

describe("the toast", () => {
	it("shows a leave after the tab's first read, once, then goes after its time", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { set } = show(status());
		expect(screen.queryByTestId("join-toast")).toBeNull();
		const region = screen.getByTestId("join-toast-region");
		expect(region).toHaveAttribute("aria-live", "polite");
		expect(region).toBeEmptyDOMElement();
		const left = { why: "disconnected" as const, at: "2026-11-10T10:05:00Z" };
		await set(status(left));
		const toast = await screen.findByTestId("join-toast");
		expect(toast).toHaveTextContent("carbonless · main left");
		expect(toast.querySelector("time")).toHaveAttribute("datetime", left.at);
		// Inside the polite live region that was there before it.
		expect(region).toContainElement(toast);
		expect(screen.getByTestId("join-toast-region")).toBe(region);
		await act(async () => vi.advanceTimersByTimeAsync(TOAST_MS));
		await waitFor(() => expect(screen.queryByTestId("join-toast")).toBeNull());
		// The same leave on the next poll: no second toast.
		await set({ ...status(left), waiting: 2 });
		expect(screen.queryByTestId("join-toast")).toBeNull();
	});

	it("not for a leave that happened before the tab looked", async () => {
		show(status({ why: "lost", at: "2026-11-10T09:00:00Z" }));
		await act(async () => {});
		expect(screen.queryByTestId("join-toast")).toBeNull();
	});

	it("a leave read while the tab is hidden waits for the tab to come back", async () => {
		const { set } = show(status());
		act(() => setVisibility("hidden"));
		await set(status({ why: "lost", at: "2026-11-10T10:05:00Z" }));
		expect(screen.queryByTestId("join-toast")).toBeNull();
		act(() => setVisibility("visible"));
		expect(await screen.findByTestId("join-toast")).toHaveTextContent(
			"carbonless · main disconnected",
		);
	});

	it("Dismiss closes it", async () => {
		const { set } = show(status());
		await set(status({ why: "replaced", at: "2026-11-10T10:05:00Z" }));
		const toast = await screen.findByTestId("join-toast");
		expect(toast).toHaveTextContent("carbonless · main replaced");
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByTestId("join-toast")).toBeNull();
	});

	it("a name with markup shows as text", async () => {
		const { set } = show(status());
		await set({
			...status(),
			left: {
				name: "<img src=x onerror=alert(1)>",
				machine: "m",
				why: "detached",
				at: "2026-11-10T10:05:00Z",
			},
		});
		const toast = await screen.findByTestId("join-toast");
		expect(toast.querySelector("img")).toBeNull();
		expect(toast).toHaveTextContent("<img src=x onerror=alert(1)> left");
	});
});
