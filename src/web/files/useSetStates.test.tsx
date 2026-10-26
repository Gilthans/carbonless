// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
