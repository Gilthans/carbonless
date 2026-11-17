// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { askAgent, resetAgentWrites } from "../agent/agentWrites";
import {
	closeAgentComposer,
	openAgentComposer,
	resetAgentComposers,
	setAgentComposerText,
} from "../agent/askAgentAction";
import { viewSaverFor } from "../home/viewSaver";
import { draftsFor } from "../threads/drafts";
import { threadWritesFor } from "../threads/threadWrites";
import { DELAYED_MS } from "./stateSync";
import {
	stateSyncFor,
	useReviewView,
	useSyncStale,
	useSyncState,
	useUnsaved,
	useUnsavedGuard,
} from "./useSetStates";

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

	it("asks while an Ask agent composer holds a question not yet asked: not once it is sent, cancelled or cleared", async () => {
		localStorage.clear();
		resetAgentComposers();
		resetAgentWrites();
		const answers: ((status: number) => void)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						answers.push((status) =>
							resolve(
								new Response(
									JSON.stringify(
										status === 200
											? {
													id: "A1",
													anchor: span,
													messages: [],
													resolved: false,
												}
											: { error: "No agent here" },
									),
									{ status },
								),
							),
						);
					}),
			),
		);
		const span = {
			path: "a.ts",
			commit: "c".repeat(40),
			subject: "line" as const,
			side: "RIGHT" as const,
			line: 3,
		};
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<Guard />
			</QueryClientProvider>,
		);
		try {
			// Open and empty, or only spaces: nothing to lose.
			let id = "";
			act(() => {
				id = openAgentComposer(span);
			});
			expect(leave()).toBe(false);
			act(() => setAgentComposerText(id, "  \n"));
			expect(leave()).toBe(false);
			act(() => setAgentComposerText(id, "Why a lock?"));
			expect(leave()).toBe(true);
			// Cleared: clean again.
			act(() => setAgentComposerText(id, ""));
			expect(leave()).toBe(false);
			act(() => setAgentComposerText(id, "Why a lock?"));
			expect(leave()).toBe(true);
			// Cancelled (the composer closed): clean.
			act(() => closeAgentComposer(id));
			expect(leave()).toBe(false);
			// Asked: on its way, it isn't the page's to keep.
			act(() => {
				id = openAgentComposer(span, undefined, "Why a lock?");
			});
			expect(leave()).toBe(true);
			act(() => askAgent(client, span, "Why a lock?", id));
			expect(leave()).toBe(false);
			// Refused: the text is only in the box again.
			await act(async () => {
				answers.shift()?.(400);
				await new Promise((r) => setTimeout(r, 0));
			});
			expect(leave()).toBe(true);
			// Asked again, and answered: the composer closes.
			act(() => askAgent(client, span, "Why a lock?", id));
			expect(leave()).toBe(false);
			await act(async () => {
				answers.shift()?.(200);
				await new Promise((r) => setTimeout(r, 0));
			});
			expect(leave()).toBe(false);
		} finally {
			resetAgentComposers();
			resetAgentWrites();
		}
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

describe("the sync's notices", () => {
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	// CAR-147: the Files page read the whole sync state, so a save turning
	// delayed rendered every line of an open file again (and each line's
	// highlight query notified on its own).
	it("a save turning delayed renders only what shows the notice, not the page's readers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		// Nothing answers: the review read and the write stay out.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => {})),
		);
		const renders = { view: 0, unsaved: 0, stale: 0, notice: 0 };
		function View() {
			useReviewView();
			renders.view++;
			return null;
		}
		function Unsaved() {
			useUnsaved();
			renders.unsaved++;
			return null;
		}
		function Stale() {
			useSyncStale();
			renders.stale++;
			return null;
		}
		function Notice() {
			useSyncState();
			renders.notice++;
			return null;
		}
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<View />
				<Unsaved />
				<Stale />
				<Notice />
			</QueryClientProvider>,
		);
		const sync = stateSyncFor(client);
		await act(async () => {
			void sync.apply("r1", "a.ts", [{ key: "k1", state: "reviewed" }]);
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(sync.getState().delayed).toBe(false);
		const before = { ...renders };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(DELAYED_MS);
		});
		expect(sync.getState().delayed).toBe(true);
		// The control: a whole-state reader did render again.
		expect(renders.notice).toBeGreaterThan(before.notice);
		expect(renders.view).toBe(before.view);
		expect(renders.unsaved).toBe(before.unsaved);
		expect(renders.stale).toBe(before.stale);
	});

	it("the page's readers render again with what changed: a new pending change, its stored write, a refusal for staleness", async () => {
		const answers: ((r: Response) => void)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((resolve) => {
						// Only the writes answer; the review read stays out.
						if (init?.method === "POST") answers.push(resolve);
					}),
			),
		);
		const seen = {
			pending: -1,
			unsaved: false,
			stale: null as { dropped: number } | null,
		};
		function View() {
			seen.pending = useReviewView().pending.size;
			return null;
		}
		function Unsaved() {
			seen.unsaved = useUnsaved();
			return null;
		}
		function Stale() {
			seen.stale = useSyncStale();
			return null;
		}
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<View />
				<Unsaved />
				<Stale />
			</QueryClientProvider>,
		);
		const sync = stateSyncFor(client);
		expect(seen).toEqual({ pending: 0, unsaved: false, stale: null });
		const answer = async (response: Response) => {
			await act(async () => {
				await vi.waitFor(() => expect(answers.length).toBe(1));
				answers.shift()?.(response);
				await new Promise((r) => setTimeout(r, 0));
			});
		};

		await act(async () => {
			void sync.apply("r1", "a.ts", [{ key: "k1", state: "reviewed" }]);
		});
		expect(seen).toEqual({ pending: 1, unsaved: true, stale: null });
		await answer(
			new Response(
				JSON.stringify({
					revision: "r1",
					patchset: 1,
					files: [],
					progress: {},
				}),
			),
		);
		expect(seen).toEqual({ pending: 0, unsaved: false, stale: null });

		await act(async () => {
			void sync
				.apply("r1", "a.ts", [{ key: "k2", state: "reviewed" }])
				.catch(() => {});
		});
		expect(seen).toEqual({ pending: 1, unsaved: true, stale: null });
		await answer(
			new Response(JSON.stringify({ error: "moved" }), { status: 409 }),
		);
		expect(seen).toEqual({ pending: 0, unsaved: false, stale: { dropped: 1 } });
	});
});
