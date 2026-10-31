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

	it("never asks for drafts storage keeps; asks while it can't keep them", () => {
		localStorage.clear();
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		const drafts = draftsFor(client);
		// Not yet bound to a PR: memory is all there is.
		act(() => drafts.setText("T1", "   "));
		expect(leave()).toBe(false);
		act(() => drafts.setText("T1", "Half a thought"));
		expect(leave()).toBe(true);
		// In storage now: a reload brings it back.
		act(() => drafts.bind("crb:drafts:o/r#1"));
		expect(leave()).toBe(false);
		act(() => drafts.setEdit("T1", "c1", "Old", "Old and new"));
		act(() =>
			drafts.setNew(
				"n1",
				{ path: "a.ts", commit: "c", subject: "file" },
				"A new thread",
			),
		);
		expect(leave()).toBe(false);
		act(() => drafts.setText("T1", ""));
		expect(leave()).toBe(false);
	});

	it("asks while drafts can't reach storage (it throws)", () => {
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		const setItem = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("quota");
			});
		try {
			act(() => draftsFor(client).bind("crb:drafts:o/r#2"));
			act(() => draftsFor(client).setText("T1", "Half a thought"));
			expect(leave()).toBe(true);
		} finally {
			setItem.mockRestore();
		}
	});

	it("asks for a resolve or a delete not yet on GitHub, never for a reply its draft resends", async () => {
		localStorage.clear();
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
		const writes = threadWritesFor(client);
		act(() => writes.drafts.bind("crb:drafts:o/r#3"));
		act(() => writes.setResolved("T1", true));
		expect(leave()).toBe(true);
		await act(async () => {
			answers.shift()?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(leave()).toBe(false);
		// Sent and unconfirmed, it's kept as a draft: the next page resends it.
		act(() => writes.reply("T1", "Fixed"));
		expect(writes.state().busy).toBe(true);
		expect(leave()).toBe(false);
		await act(async () => {
			answers.shift()?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		// A delete in its undo window: nothing sent yet, a reload would lose it.
		act(() => writes.deleteComment("T1", "c1"));
		expect(leave()).toBe(true);
		act(() => writes.undoDelete("T1", "c1"));
		expect(leave()).toBe(false);
	});

	it("asks exactly while a refused write is listed, kept or not: until Retry lands or it's dropped", async () => {
		localStorage.clear();
		const statuses = [403, 403, 403, 200];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				const status = statuses.shift() ?? 200;
				return new Response(
					JSON.stringify(
						status === 200
							? {
									threadId: "T1",
									resolved: false,
									commentCount: 2,
									lastActivityAt: "2026-01-01T00:00:00Z",
									attention: [],
									yourTurn: false,
									viewerCan: { reply: true, resolve: true, unresolve: true },
									comments: { threadId: "T1", comments: [{ id: "c1" }] },
								}
							: { error: "no" },
					),
					{ status },
				);
			}),
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
		const writes = threadWritesFor(client);
		act(() => writes.drafts.bind("crb:drafts:o/r#4"));
		expect(leave()).toBe(false);
		// A refused reply: its text is a draft storage keeps, but it's unsettled.
		await act(async () => {
			writes.reply("T1", "Refused");
			await vi.waitFor(() => expect(writes.state().refused).toHaveLength(1));
		});
		expect(writes.drafts.durable()).toBe(true);
		expect(leave()).toBe(true);
		// Retried and refused again: still asks.
		await act(async () => {
			writes.retry("T1", "reply");
			await vi.waitFor(() =>
				expect(writes.state().refused[0]?.retrying).toBeUndefined(),
			);
		});
		expect(leave()).toBe(true);
		// Dropped: nothing asks.
		act(() => writes.drop("T1", "reply"));
		expect(leave()).toBe(false);
		// Refused, then a Retry GitHub takes: asks until it lands.
		await act(async () => {
			writes.reply("T1", "Again");
			await vi.waitFor(() => expect(writes.state().refused).toHaveLength(1));
		});
		expect(leave()).toBe(true);
		await act(async () => {
			writes.retry("T1", "reply");
			await vi.waitFor(() => expect(writes.state().refused).toEqual([]));
		});
		expect(leave()).toBe(false);
	});
});
