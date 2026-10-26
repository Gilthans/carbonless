// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { draftsFor } from "../threads/drafts";
import { threadWritesFor } from "../threads/threadWrites";
import { stateSyncFor, useUnsavedGuard } from "./useSetStates";

function Guard() {
	useUnsavedGuard();
	return null;
}

const leave = () => {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event.defaultPrevented;
};

describe("useUnsavedGuard", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("asks before leaving only while a change is unsaved", async () => {
		let answer: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						answer = () =>
							resolve(
								new Response(
									JSON.stringify({
										revision: "r1",
										patchset: 1,
										files: [],
										progress: {},
									}),
								),
							);
					}),
			),
		);
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		expect(leave()).toBe(false);
		await act(async () => {
			void stateSyncFor(client).apply("r1", "a.ts", [
				{ key: "k1", state: "reviewed" },
			]);
		});
		expect(leave()).toBe(true);
		await act(async () => {
			answer?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(stateSyncFor(client).getState().pending.size).toBe(0);
		expect(leave()).toBe(false);
	});

	it("asks before leaving with a reply draft, until it's cleared", () => {
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		act(() => draftsFor(client).setText("T1", "   "));
		expect(leave()).toBe(false);
		act(() => draftsFor(client).setText("T1", "Half a thought"));
		expect(leave()).toBe(true);
		act(() => draftsFor(client).setText("T1", ""));
		expect(leave()).toBe(false);
	});

	it("asks before leaving while a reply or resolve isn't on GitHub yet", async () => {
		const answers: (() => void)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(path: string) =>
					new Promise<Response>((resolve) => {
						answers.push(() =>
							resolve(
								new Response(
									JSON.stringify({
										threadId: "T1",
										resolved: path.endsWith("/resolved"),
										commentCount: 2,
										lastActivityAt: "2026-01-01T00:00:00Z",
										attention: [],
										yourTurn: false,
										viewerCan: { reply: true, resolve: true, unresolve: true },
										comments: { threadId: "T1", comments: [{ id: "c1" }] },
									}),
								),
							),
						);
					}),
			),
		);
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		client.setQueryData(["overview"], { readId: "r1" });
		client.setQueryData(["comments", "r1", "T1"], {
			threadId: "T1",
			comments: [{ id: "c1" }],
		});
		act(() => threadWritesFor(client).setResolved("T1", true));
		expect(leave()).toBe(true);
		await act(async () => {
			answers.shift()?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(leave()).toBe(false);
		act(() => threadWritesFor(client).reply("T1", "Fixed"));
		expect(leave()).toBe(true);
		await act(async () => {
			answers.shift()?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(leave()).toBe(false);
	});
});
