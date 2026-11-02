// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusalsFor, refusalsKey } from "../threads/refusals";
import {
	threadWritesFor,
	useThreadWritesSetup,
	VERDICT_LANE,
} from "../threads/threadWrites";
import { verdictKey } from "./verdictDraft";

/** The review the page shows (useReviewId), set per test. */
let reviewId = "";
vi.mock("../reviewId", () => ({ useReviewId: () => reviewId }));

const PR = { owner: "o", repo: "r", number: 1 };
const HEAD = "a".repeat(40);

/** Review A's verdict on its way, and a verdict of A's GitHub refused. */
function seedReviewA() {
	localStorage.setItem(
		verdictKey(PR, "A"),
		JSON.stringify({
			text: "",
			sending: {
				clientId: "vA",
				event: "APPROVE",
				commit: HEAD,
				attemptedAt: "2026-01-05T00:00:00Z",
				sentOnce: true,
			},
		}),
	);
	localStorage.setItem(
		refusalsKey(PR, "A"),
		JSON.stringify([
			{
				threadId: VERDICT_LANE,
				key: "verdict",
				action: "Verdict",
				event: "REQUEST_CHANGES",
				message: "No",
				at: "2026-01-05T00:00:00Z",
			},
		]),
	);
	// A thread write's refusal: the PR's, every review lists it.
	localStorage.setItem(
		refusalsKey(PR),
		JSON.stringify([
			{
				threadId: "T1",
				key: "resolve",
				action: "Resolve",
				resolved: true,
				message: "No",
				at: "2026-01-05T00:00:00Z",
			},
		]),
	);
}

let fetchMock: ReturnType<typeof vi.fn>;
const verdictPosts = () =>
	fetchMock.mock.calls.filter(
		([input, init]) =>
			String(input).endsWith("/api/verdict") &&
			(init as RequestInit | undefined)?.method === "POST",
	);

function Setup() {
	useThreadWritesSetup();
	return null;
}

/** A page of review `id`: its session and overview known, writing on. */
function open(id: string) {
	reviewId = id;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(["session"], { pr: { ...PR, title: "t", url: "" } });
	client.setQueryData(["overview"], { writes: "on", headOid: HEAD });
	const wrap = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<Setup />, { wrapper: wrap });
	return client;
}

describe("the verdict is the review's own", () => {
	beforeEach(() => {
		localStorage.clear();
		// A verdict's POST never answers: only whether it went out matters.
		fetchMock = vi.fn(() => new Promise<Response>(() => {}));
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it("another review of the PR neither resends A's pending verdict nor lists A's refused one", async () => {
		// Review A's page: a verdict pressed and on its way, and one GitHub
		// refused; a thread write's refusal, the PR's.
		const a = open("A");
		const writes = threadWritesFor(a);
		await waitFor(() => expect(refusalsFor(a).durable()).toBe(true));
		expect(writes.submitVerdict("APPROVE", undefined, HEAD)).toBe(true);
		await waitFor(() => expect(verdictPosts()).toHaveLength(1));
		refusalsFor(a).put({
			threadId: VERDICT_LANE,
			key: "verdict",
			action: "Verdict",
			event: "REQUEST_CHANGES",
			message: "No",
			at: "2026-01-05T00:00:00Z",
		});
		refusalsFor(a).put({
			threadId: "T1",
			key: "resolve",
			action: "Resolve",
			resolved: true,
			message: "No",
			at: "2026-01-05T00:00:00Z",
		});
		cleanup();
		// Review B of the same PR (another tab, say pinned to a head) loads.
		const b = open("B");
		await waitFor(() =>
			expect(
				refusalsFor(b)
					.get()
					.map((r) => r.threadId),
			).toEqual(["T1"]),
		);
		expect(threadWritesFor(b).state().verdict).toBeNull();
		expect(verdictPosts()).toHaveLength(1);
		// A's entries stay A's: its own reload resends and lists them.
		cleanup();
		open("A");
		await waitFor(() => expect(verdictPosts()).toHaveLength(2));
	});

	it("the review that pressed it resends it on load and lists its refusal", async () => {
		seedReviewA();
		const a = open("A");
		await waitFor(() => expect(verdictPosts()).toHaveLength(1));
		const body = JSON.parse(
			String((verdictPosts()[0]?.[1] as RequestInit | undefined)?.body),
		) as { clientId: string; retry: boolean };
		expect(body).toMatchObject({ clientId: "vA", retry: true });
		expect(
			refusalsFor(a)
				.get()
				.map((r) => r.threadId)
				.sort(),
		).toEqual(["T1", VERDICT_LANE].sort());
	});

	it("drops the PR-wide entry builds before per-review keys wrote", async () => {
		const prWide = `crb:verdict:${PR.owner}/${PR.repo}#${PR.number}`;
		localStorage.setItem(
			prWide,
			JSON.stringify({
				text: "",
				sending: {
					clientId: "old",
					event: "APPROVE",
					commit: HEAD,
					attemptedAt: "2026-01-05T00:00:00Z",
					sentOnce: true,
				},
			}),
		);
		open("B");
		await waitFor(() => expect(localStorage.getItem(prWide)).toBeNull());
		expect(verdictPosts()).toHaveLength(0);
	});
});
