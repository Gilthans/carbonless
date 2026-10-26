// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewThread, ThreadsView } from "../../shared/types";
import { threadWritesFor } from "../threads/threadWrites";
import { SyncNotices, threadLabel } from "./SyncNotices";

const thread = (more: Partial<ReviewThread>) =>
	({
		id: "T1",
		path: "src/cache.ts",
		line: 42,
		subject: "line",
		code: null,
		...more,
	}) as ReviewThread;

let statuses: number[];

function setup(threads: ReviewThread[]) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string) => {
			calls.push(path);
			const status = statuses.shift() ?? 200;
			return new Response(
				JSON.stringify(
					status === 409
						? {
								error: "one pending review",
								code: "pending-review",
								url: "https://github.com/o/r/pull/1/files",
							}
						: { error: `refused ${status}` },
				),
				{ status },
			);
		}),
	);
	const client = new QueryClient();
	client.setQueryData(["overview"], { readId: "r1" });
	client.setQueryData(["comments", "r1", "T1"], {
		threadId: "T1",
		comments: [{ id: "c1" }],
	});
	client.setQueryData<ThreadsView>(["threads", "r1", "full"], {
		threads,
		complete: true,
	});
	render(
		<QueryClientProvider client={client}>
			<SyncNotices />
		</QueryClientProvider>,
	);
	return { writes: threadWritesFor(client), calls };
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("threadLabel", () => {
	it("names file and line, the file for a file comment, else the PR", () => {
		expect(threadLabel(thread({}))).toBe("src/cache.ts:42");
		expect(threadLabel(thread({ subject: "file", line: null }))).toBe(
			"src/cache.ts",
		);
		expect(threadLabel(undefined)).toBe("PR comment");
	});
});

describe("SyncNotices for thread writes", () => {
	it("a refused write is red with the action, the thread, the message and Retry", async () => {
		statuses = [403, 403];
		const { writes, calls } = setup([thread({})]);
		await act(async () => {
			writes.setResolved("T1", true);
		});
		const notice = await screen.findByTestId("write-failed");
		expect(notice).toHaveTextContent("Resolve · src/cache.ts:42");
		expect(notice).toHaveTextContent("refused 403");
		await userEvent.click(
			within(notice).getByRole("button", { name: "Retry resolve" }),
		);
		expect(calls).toHaveLength(2);
	});

	it("a pending review blocks a reply: said so, with the link", async () => {
		statuses = [409];
		const { writes } = setup([thread({})]);
		await act(async () => {
			writes.reply("T1", "Fixed");
		});
		const notice = await screen.findByTestId("write-failed");
		expect(notice).toHaveTextContent("Reply · src/cache.ts:42");
		expect(notice).toHaveTextContent(
			"A pending review on GitHub blocks replies",
		);
		expect(
			within(notice).getByRole("link", { name: "Open on GitHub" }),
		).toHaveAttribute("href", "https://github.com/o/r/pull/1/files");
	});

	it("yellow after 5 s of transient failures, then red after five in a row", async () => {
		vi.useFakeTimers();
		statuses = Array(10).fill(502);
		const { writes } = setup([thread({})]);
		await act(async () => {
			writes.reply("T1", "Fixed");
			await vi.advanceTimersByTimeAsync(5000);
		});
		const delayed = screen.getByTestId("write-delayed");
		expect(delayed).toHaveTextContent("Reply…");
		expect(delayed).toHaveTextContent("src/cache.ts:42");
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(screen.getByTestId("write-stalled")).toHaveTextContent(
			"Reply · src/cache.ts:42",
		);
	});
});
