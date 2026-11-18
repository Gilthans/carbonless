// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RereviewAnswer, SessionInfo } from "../../shared/types";
import { rereviewQuery } from "../api";
import type { Comparison, Viewing } from "./comparison";
import { useSince } from "./useSince";

const OID = "f".repeat(40);
const HEAD: Viewing = { kind: "head", oid: OID };
const PS2: Viewing = { kind: "patchset", number: 2 };

const answer = (toRevision: string, from = 1): RereviewAnswer =>
	({
		from,
		toHead: OID,
		toRevision,
		files: [],
		toRead: { files: 1, clusters: 3 },
		threads: [],
	}) as unknown as RereviewAnswer;

const session = (revisions: string[]): SessionInfo =>
	({
		patchsets: revisions.map((revision, i) => ({ number: i + 1, revision })),
	}) as unknown as SessionInfo;

const comparison = (viewing: Viewing, since = 1): Comparison =>
	({ viewing, base: { kind: "patchset", number: since } }) as Comparison;

interface Props {
	comparison: Comparison;
	session: SessionInfo;
}

let client: QueryClient;

const render = (initialProps: Props) =>
	renderHook(
		(p: Props) => useSince(p.comparison, p.session, undefined, new Map()),
		{
			initialProps,
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		},
	);

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// Every read not seeded below is still on its way.
	vi.spyOn(globalThis, "fetch").mockImplementation(
		() => new Promise<Response>(() => {}),
	);
});

afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
});

describe("useSince: a snapshot answered under another name (CAR-208)", () => {
	it("a mark on the viewed head starts PS2 of that snapshot: the head's answer stays while PS2's is read, then PS2's shows", () => {
		const head = answer("r2");
		client.setQueryData(rereviewQuery(1, { head: OID }).queryKey, head);
		const hook = render({
			comparison: comparison(HEAD),
			session: session(["r1"]),
		});
		expect(hook.result.current.answer).toBe(head);
		// The session names PS2 (snapshot r2): another query key, unanswered.
		hook.rerender({
			comparison: comparison(PS2),
			session: session(["r1", "r2"]),
		});
		expect(hook.result.current.answer).toBe(head);
		expect(hook.result.current.pending).toBe(false);
		const ps2 = answer("r2");
		client.setQueryData(rereviewQuery(1, { patchset: 2 }).queryKey, ps2);
		hook.rerender({
			comparison: comparison(PS2),
			session: session(["r1", "r2"]),
		});
		expect(hook.result.current.answer).toBe(ps2);
	});

	it("PS2 on another snapshot (the head on a moved base) doesn't fit: pending, no answer", () => {
		client.setQueryData(rereviewQuery(1, { head: OID }).queryKey, answer("rA"));
		const hook = render({
			comparison: comparison(HEAD),
			session: session(["r1"]),
		});
		hook.rerender({
			comparison: comparison(PS2),
			session: session(["r1", "rB"]),
		});
		expect(hook.result.current.answer).toBeNull();
		expect(hook.result.current.pending).toBe(true);
	});

	it("the same snapshot compared from another patch set doesn't fit: pending, no answer", () => {
		client.setQueryData(rereviewQuery(1, { head: OID }).queryKey, answer("r2"));
		const hook = render({
			comparison: comparison(HEAD),
			session: session(["r1"]),
		});
		// Compared from PS2 instead, to PS3 of the same snapshot r2.
		hook.rerender({
			comparison: comparison({ kind: "patchset", number: 3 }, 2),
			session: session(["r1", "rX", "r2"]),
		});
		expect(hook.result.current.answer).toBeNull();
		expect(hook.result.current.pending).toBe(true);
	});

	it("a held answer is never used for a viewed head (no patch set's revision to match)", () => {
		client.setQueryData(
			rereviewQuery(1, { patchset: 2 }).queryKey,
			answer("r2"),
		);
		const hook = render({
			comparison: comparison(PS2),
			session: session(["r1", "r2"]),
		});
		expect(hook.result.current.answer).not.toBeNull();
		hook.rerender({
			comparison: comparison(HEAD),
			session: session(["r1", "r2"]),
		});
		expect(hook.result.current.answer).toBeNull();
		expect(hook.result.current.pending).toBe(true);
	});

	it("a failed read of the new name shows as failed, never the held answer", async () => {
		client.setQueryData(rereviewQuery(1, { head: OID }).queryKey, answer("r2"));
		vi.mocked(globalThis.fetch).mockImplementation(async () =>
			Response.json({ error: "boom" }, { status: 500 }),
		);
		const hook = render({
			comparison: comparison(HEAD),
			session: session(["r1"]),
		});
		hook.rerender({
			comparison: comparison(PS2),
			session: session(["r1", "r2"]),
		});
		await vi.waitFor(() => expect(hook.result.current.error).not.toBeNull());
		expect(hook.result.current.answer).toBeNull();
		expect(hook.result.current.pending).toBe(false);
	});
});
