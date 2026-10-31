// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewThread, ThreadsView } from "../../shared/types";
import { threadWritesFor } from "../threads/threadWrites";
import { threadLabel } from "./RefusedWrites";
import { SyncNotices } from "./SyncNotices";

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
	it("a refused write is listed under the red chip: what, where, why, Retry; listed until GitHub takes it", async () => {
		statuses = [403, 403, 200];
		const { writes, calls } = setup([thread({})]);
		await act(async () => {
			writes.setResolved("T1", true);
		});
		const chip = await screen.findByTestId("refused-bar");
		expect(chip).toHaveAccessibleName("1 not posted");
		// Newly refused: the list opens by itself.
		expect(chip).toHaveAttribute("aria-expanded", "true");
		const item = screen.getByTestId("refused-write");
		expect(item).toHaveTextContent("Resolve · src/cache.ts:42");
		expect(item).toHaveTextContent("refused 403");
		await userEvent.click(
			within(item).getByRole("button", { name: "Retry resolve" }),
		);
		expect(calls).toHaveLength(2);
		// Refused again: still listed, with GitHub's message.
		expect(await screen.findByTestId("refused-write")).toHaveTextContent(
			"refused 403",
		);
		await userEvent.click(
			within(screen.getByTestId("refused-write")).getByRole("button", {
				name: "Retry resolve",
			}),
		);
		expect(calls).toHaveLength(3);
		await vi.waitFor(() =>
			expect(screen.queryByTestId("refused-bar")).toBeNull(),
		);
		expect(writes.state().lost).toBe(false);
	});

	it("Drop asks in place first: Cancel keeps it, Drop lets it go and its text", async () => {
		statuses = [403];
		const { writes, calls } = setup([thread({})]);
		await act(async () => {
			writes.reply("T1", "Never mind");
		});
		const item = await screen.findByTestId("refused-write");
		expect(within(item).getByTestId("refused-preview")).toHaveTextContent(
			"Never mind",
		);
		const drop = () => within(item).getByRole("button", { name: "Drop reply" });
		await userEvent.click(drop());
		const ask = within(item).getByRole("alertdialog", {
			name: "Drop this? Its text is lost",
		});
		expect(within(ask).getByRole("button", { name: "Cancel" })).toHaveFocus();
		await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByTestId("refused-drop-confirm")).toBeNull();
		expect(writes.state().refused).toHaveLength(1);
		expect(writes.drafts.text("T1")).toBe("Never mind");
		await vi.waitFor(() => expect(drop()).toHaveFocus());
		await userEvent.click(drop());
		await userEvent.keyboard("{Escape}");
		expect(writes.state().refused).toHaveLength(1);
		await userEvent.click(drop());
		await userEvent.click(screen.getByTestId("refused-drop-yes"));
		expect(screen.queryByTestId("refused-bar")).toBeNull();
		expect(writes.state().refused).toEqual([]);
		expect(writes.drafts.text("T1")).toBe("");
		expect(calls).toHaveLength(1);
	});

	it("a dropped resolve or delete asks without the text warning", async () => {
		statuses = [403];
		const { writes } = setup([thread({})]);
		await act(async () => {
			writes.setResolved("T1", true);
		});
		const item = await screen.findByTestId("refused-write");
		await userEvent.click(
			within(item).getByRole("button", { name: "Drop resolve" }),
		);
		expect(
			within(item).getByRole("alertdialog", { name: "Drop this?" }),
		).toBeInTheDocument();
	});

	it("the chip collapses and opens the list; Retry all with more than one", async () => {
		statuses = [403, 403, 200, 200];
		const { writes, calls } = setup([
			thread({}),
			thread({ id: "T2", line: 7 }),
		]);
		await act(async () => {
			writes.setResolved("T1", true);
			writes.setResolved("T2", true);
		});
		await vi.waitFor(() =>
			expect(screen.getAllByTestId("refused-write")).toHaveLength(2),
		);
		const chip = screen.getByTestId("refused-bar");
		expect(chip).toHaveAccessibleName("2 not posted");
		await userEvent.click(chip);
		expect(screen.queryByTestId("refused-list")).toBeNull();
		expect(chip).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(chip);
		await userEvent.click(screen.getByTestId("refused-retry-all"));
		expect(calls).toHaveLength(4);
		await vi.waitFor(() =>
			expect(screen.queryByTestId("refused-bar")).toBeNull(),
		);
	});

	it("a reply resent from an earlier page says so, with Discard", async () => {
		statuses = [];
		const { writes, calls } = setup([thread({})]);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		await act(async () => {
			writes.drafts.addSending("T1", "From yesterday", {
				attemptedAt: "2026-01-02T00:00:00.000Z",
				clientId: "old",
				knownCommentIds: ["c1"],
			});
			writes.resume();
		});
		const notice = await screen.findByTestId("write-resumed");
		expect(notice).toHaveTextContent("Reply · src/cache.ts:42");
		await userEvent.click(
			within(notice).getByRole("button", { name: "Discard reply" }),
		);
		expect(screen.queryByTestId("write-resumed")).toBeNull();
		expect(writes.drafts.get()).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("a resumed reply that keeps failing keeps its Discard, yellow and then red", async () => {
		vi.useFakeTimers();
		statuses = Array(20).fill(502);
		const { writes } = setup([thread({})]);
		await act(async () => {
			writes.drafts.addSending("T1", "From yesterday", {
				attemptedAt: "2026-01-02T00:00:00.000Z",
				clientId: "old",
				knownCommentIds: ["c1"],
			});
			writes.resume();
			await vi.advanceTimersByTimeAsync(5000);
		});
		const delayed = screen.getByTestId("write-delayed");
		expect(
			within(delayed).getByRole("button", { name: "Discard reply" }),
		).toBeInTheDocument();
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		const stalled = screen.getByTestId("write-stalled");
		await act(async () => {
			within(stalled).getByRole("button", { name: "Discard reply" }).click();
		});
		expect(writes.drafts.get()).toEqual([]);
	});

	it("a pending review blocks a reply: said so, with the link", async () => {
		statuses = [409];
		const { writes } = setup([thread({})]);
		await act(async () => {
			writes.reply("T1", "Fixed");
		});
		const notice = await screen.findByTestId("refused-write");
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
