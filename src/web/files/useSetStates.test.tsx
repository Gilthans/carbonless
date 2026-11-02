// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewSaverFor } from "../home/viewSaver";
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

	it("asks while Home's view list isn't saved yet (nothing resends it after the page)", async () => {
		let answer: (() => void) | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						answer = () =>
							resolve(
								Response.json({
									viewer: { login: "dan", avatarUrl: "" },
									view: { name: "My PRs", repos: ["acme/api"] },
									configProblems: [],
									viewerError: null,
									refreshMinutes: 2,
									startedRepos: [],
								}),
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
			viewSaverFor(client).save(["acme/api"]);
		});
		expect(leave()).toBe(true);
		await act(async () => {
			answer?.();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(viewSaverFor(client).snapshot().intended).toBeNull();
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
});
