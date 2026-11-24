// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_ID, REQUEST_ID_HEADER } from "../shared/activity";
import {
	activePolls,
	LOADING_STEP_AFTER_MS,
	LOADING_STEP_EVERY_MS,
	outRequests,
	tagFetch,
	useLoadingStep,
} from "./loadingStep";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("tagFetch (CAR-296)", () => {
	it("tags a same-origin API request with an id, kept while it is out; nothing else", async () => {
		let answer = (_: Response) => {};
		const inner = vi.fn(
			(_input: RequestInfo | URL, _init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					answer = resolve;
				}),
		);
		const tagged = tagFetch(inner as typeof fetch);
		const pending = tagged("/api/home/repos/acme/api?seen=1", {
			headers: { "content-type": "application/json" },
		});
		const headers = new Headers(inner.mock.calls[0]?.[1]?.headers);
		const id = headers.get(REQUEST_ID_HEADER) ?? "";
		expect(id).toMatch(REQUEST_ID);
		// The caller's headers kept.
		expect(headers.get("content-type")).toBe("application/json");
		expect(outRequests().get(id)).toEqual({
			path: "/api/home/repos/acme/api?seen=1",
			method: "GET",
		});
		answer(new Response("{}"));
		await pending;
		expect(outRequests().has(id)).toBe(false);
		// Not tagged: the ask itself, the page's spans, other origins, pages.
		for (const url of [
			"/api/activity?req=abcdefgh",
			"/api/trace",
			"https://elsewhere.example/api/x",
			"/r/abc",
		]) {
			inner.mockClear();
			const call = tagged(url);
			expect(inner.mock.calls[0]?.[1]).toBeUndefined();
			answer(new Response("{}"));
			await call;
		}
	});

	it("drops a failed request too", async () => {
		const tagged = tagFetch((async () => {
			throw new TypeError("network");
		}) as typeof fetch);
		await expect(tagged("/api/session")).rejects.toThrow("network");
		expect(outRequests().size).toBe(0);
	});
});

function Probe(props: { active: boolean; testId?: string; path?: string }) {
	const prefix = props.path ?? "/api/slow";
	const { step, live } = useLoadingStep(
		"probe",
		(r) => r.path.startsWith(prefix),
		props.active,
	);
	return (
		<p data-testid={props.testId ?? "line"} data-live={String(live)}>
			{step?.text}
		</p>
	);
}

describe("useLoadingStep (CAR-296)", () => {
	let asks: string[];
	let held: Promise<Response>;
	let releaseSlow = () => {};
	beforeEach(() => {
		vi.useFakeTimers();
		asks = [];
		held = new Promise<Response>((resolve) => {
			releaseSlow = () => resolve(new Response("{}"));
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (input.startsWith("/api/activity")) {
					asks.push(input);
					const ids = new URL(input, "http://x").searchParams
						.get("req")
						?.split(",");
					return new Response(
						JSON.stringify({
							steps: Object.fromEntries(
								(ids ?? []).map((id) => [
									id,
									{
										name: "gh pr view",
										label: "GitHub: pr view",
										ms: 4_200,
										since: "2026-11-24T00:00:00.000Z",
									},
								]),
							),
						}),
					);
				}
				return held;
			}),
		);
	});

	it("asks nothing before the threshold, then shows the step, every second; gone when the load ends", async () => {
		const slow = tagFetch(fetch)("/api/slow");
		const { rerender } = render(<Probe active />);
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_AFTER_MS - 10));
		expect(asks).toEqual([]);
		expect(screen.getByTestId("line")).toHaveTextContent("");
		await act(() => vi.advanceTimersByTimeAsync(20));
		expect(asks).toHaveLength(1);
		expect(screen.getByTestId("line")).toHaveTextContent(
			"GitHub: pr view · 4s",
		);
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_EVERY_MS));
		expect(asks).toHaveLength(2);
		releaseSlow();
		await slow;
		rerender(<Probe active={false} />);
		expect(screen.getByTestId("line")).toHaveTextContent("");
		await act(() => vi.advanceTimersByTimeAsync(5 * LOADING_STEP_EVERY_MS));
		expect(asks).toHaveLength(2);
		expect(activePolls()).toBe(0);
	});

	it("clears the line once its requests are gone for two asks, the load still pending (a step that ended never stays)", async () => {
		const slow = tagFetch(fetch)("/api/slow");
		render(<Probe active />);
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_AFTER_MS + 10));
		expect(screen.getByTestId("line")).toHaveTextContent("GitHub: pr view");
		releaseSlow();
		await act(async () => {
			await slow;
		});
		// One ask with nothing out: kept (a gap between two asks).
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_EVERY_MS));
		expect(screen.getByTestId("line")).toHaveTextContent("GitHub: pr view");
		// Two: gone, though the hook is still active.
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_EVERY_MS));
		expect(screen.getByTestId("line")).toHaveTextContent("");
	});

	it("hooks of one key share one ask, each showing its own requests' step; the first is the one read out", async () => {
		const other = tagFetch(fetch)("/api/other");
		render(
			<>
				<Probe active testId="mine" path="/api/other" />
				<Probe active testId="none" path="/api/nothing" />
			</>,
		);
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_AFTER_MS + 10));
		expect(asks).toHaveLength(1);
		expect(screen.getByTestId("mine")).toHaveTextContent("GitHub: pr view");
		expect(screen.getByTestId("none")).toHaveTextContent("");
		expect(screen.getByTestId("mine")).toHaveAttribute("data-live", "true");
		expect(screen.getByTestId("none")).toHaveAttribute("data-live", "false");
		cleanup();
		releaseSlow();
		await other;
	});

	it("hooks of one key share one ask", async () => {
		const slow = tagFetch(fetch)("/api/slow");
		render(
			<>
				<Probe active testId="a" />
				<Probe active testId="b" />
				<Probe active testId="c" />
			</>,
		);
		await act(() => vi.advanceTimersByTimeAsync(LOADING_STEP_AFTER_MS + 10));
		expect(asks).toHaveLength(1);
		for (const id of ["a", "b", "c"]) {
			expect(screen.getByTestId(id)).toHaveTextContent("GitHub: pr view");
		}
		cleanup();
		expect(activePolls()).toBe(0);
		releaseSlow();
		await slow;
	});
});
