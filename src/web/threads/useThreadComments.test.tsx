// @vitest-environment jsdom
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentsView, ThreadComments } from "../../shared/types";
import { commentsQuery, overviewQuery, showCommentsOf } from "../api";
import { PageActive } from "../pageActive";
import { usePrefetchComments, useThreadComments } from "./useThreadComments";

/** What a request asked for: its read and ids. */
interface Asked {
	read: string;
	ids: string[];
}

const comments = (threadId: string): ThreadComments => ({
	threadId,
	comments: [
		{
			id: `${threadId}-c`,
			author: "rev",
			bot: false,
			avatarUrl: "",
			publishedAt: "2026-01-03T09:00:00Z",
			pending: false,
			html: `<p>${threadId}</p>`,
			body: threadId,
			text: threadId,
		},
	],
});

let asked: Asked[];
let inFlight: number;
let most: number;
/** Answers a comments request; the default serves every id after `delay`. */
let answer: (a: Asked) => Promise<Response>;
let overviewReads: number;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

beforeEach(() => {
	asked = [];
	inFlight = 0;
	most = 0;
	overviewReads = 0;
	answer = async (a) => {
		await new Promise((r) => setTimeout(r, 20));
		return json({ threads: a.ids.map(comments) } satisfies CommentsView);
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			const url = new URL(input, "http://crb");
			if (url.pathname === "/api/overview") {
				overviewReads++;
				return json({ readId: `r${overviewReads}` });
			}
			const a = {
				read: url.searchParams.get("read") ?? "",
				ids: (url.searchParams.get("ids") ?? "").split(","),
			};
			asked.push(a);
			inFlight++;
			most = Math.max(most, inFlight);
			try {
				return await answer(a);
			} finally {
				inFlight--;
			}
		}),
	);
});
/** Every test's clients, their queues dropped after it: none leaks into the next. */
let clients: QueryClient[] = [];
const newClient = (...args: ConstructorParameters<typeof QueryClient>) => {
	const client = new QueryClient(...args);
	clients.push(client);
	return client;
};
afterEach(async () => {
	cleanup();
	for (const client of clients) showCommentsOf(client, "after the test");
	clients = [];
	await waitFor(() => expect(inFlight).toBe(0));
	vi.unstubAllGlobals();
});

const wrapper =
	(client: QueryClient) =>
	({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);

function Thread({ readId, id }: { readId: string | undefined; id: string }) {
	const q = useThreadComments(readId, id);
	return (
		<p data-testid={id}>
			{q.isError
				? "error"
				: q.data
					? q.data.comments.map((c) => c.text).join()
					: "loading"}
		</p>
	);
}

function Prefetch({ readId, ids }: { readId: string; ids: string[] }) {
	usePrefetchComments(readId, ids);
	return null;
}

const ids = (n: number, from = 0) =>
	Array.from({ length: n }, (_, i) => `T${from + i}`);

describe("comments: batched, prefetched, opened", () => {
	it("gathers the hooks mounted in one tick into one request", async () => {
		const client = newClient();
		render(
			<div>
				{ids(7).map((id) => (
					<Thread key={id} readId="r1" id={id} />
				))}
			</div>,
			{ wrapper: wrapper(client) },
		);
		await waitFor(() =>
			expect(screen.getByTestId("T6")).toHaveTextContent("T6"),
		);
		expect(asked).toEqual([{ read: "r1", ids: ids(7) }]);
		expect(commentsQuery("r1", "T0").queryKey).toEqual([
			"comments",
			"r1",
			"T0",
		]);
		expect(commentsQuery("r1", "T0").staleTime).toBe(Number.POSITIVE_INFINITY);
	});

	it("prefetches in order, fifty a request, at most two at once", async () => {
		const client = newClient();
		render(<Prefetch readId="r1" ids={ids(160)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(client.getQueryData(["comments", "r1", "T159"])).toBeDefined(),
		);
		expect(asked.map((a) => a.ids.length)).toEqual([50, 50, 50, 10]);
		expect(asked.flatMap((a) => a.ids)).toEqual(ids(160));
		expect(most).toBe(2);
	});

	it("sends 60 prefetched ids as 50 and 10", async () => {
		const client = newClient();
		render(<Prefetch readId="r1" ids={ids(60)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(client.getQueryData(["comments", "r1", "T59"])).toBeDefined(),
		);
		expect(asked.map((a) => a.ids.length)).toEqual([50, 10]);
	});

	it("an id already prefetched and then opened asks for nothing more", async () => {
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={["T1"]} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(client.getQueryData(["comments", "r1", "T1"])).toBeDefined(),
		);
		rerender(
			<>
				<Prefetch readId="r1" ids={["T1"]} />
				<Thread readId="r1" id="T1" />
			</>,
		);
		expect(screen.getByTestId("T1")).toHaveTextContent("T1");
		await new Promise((r) => setTimeout(r, 50));
		expect(asked).toHaveLength(1);
	});

	it("an id opened while prefetched but in flight joins that request", async () => {
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={["T1"]} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(asked).toHaveLength(1));
		rerender(
			<>
				<Prefetch readId="r1" ids={["T1"]} />
				<Thread readId="r1" id="T1" />
			</>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("T1")).toHaveTextContent("T1"),
		);
		expect(asked).toHaveLength(1);
	});

	it("an opened id still queued goes in the next request, ahead of the queue", async () => {
		const slow = answer;
		answer = async (a) => {
			// The prefetched ones take a while: the opened one doesn't wait.
			if (a.ids.length > 1) await new Promise((r) => setTimeout(r, 300));
			return slow(a);
		};
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={ids(200)} />, {
			wrapper: wrapper(client),
		});
		// Two requests out, the rest queued.
		await waitFor(() => expect(asked).toHaveLength(2));
		rerender(
			<>
				<Prefetch readId="r1" ids={ids(200)} />
				<Thread readId="r1" id="T180" />
			</>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("T180")).toHaveTextContent("T180"),
		);
		// On its own, while the two prefetches are still out.
		expect(asked[2]?.ids).toEqual(["T180"]);
		expect(asked).toHaveLength(3);
		// Never asked for twice.
		expect(
			asked.flatMap((a) => a.ids).filter((id) => id === "T180"),
		).toHaveLength(1);
	});

	it("a read gone (410) reads the overview again and asks under the new read", async () => {
		answer = async (a) =>
			a.read === "r1"
				? json({ error: "read gone" }, 410)
				: json({ threads: a.ids.map(comments) });
		const client = newClient({
			defaultOptions: { queries: { retry: false } },
		});
		function Page() {
			const overview = useQuery(overviewQuery);
			return <Thread readId={overview.data?.readId} id="T1" />;
		}
		render(<Page />, { wrapper: wrapper(client) });
		await waitFor(() =>
			expect(screen.getByTestId("T1")).toHaveTextContent("T1"),
		);
		expect(asked.map((a) => a.read)).toEqual(["r1", "r2"]);
		expect(overviewReads).toBe(2);
	});

	it("a failed request is an error, never a partial thread", async () => {
		answer = async () => json({ error: "boom" }, 500);
		const client = newClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(<Thread readId="r1" id="T1" />, { wrapper: wrapper(client) });
		await waitFor(() =>
			expect(screen.getByTestId("T1")).toHaveTextContent("error"),
		);
	});

	it("an id the answer leaves out is an error, not an empty thread", async () => {
		answer = async (a) =>
			json({ threads: a.ids.filter((id) => id !== "T2").map(comments) });
		const client = newClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<>
				<Thread readId="r1" id="T1" />
				<Thread readId="r1" id="T2" />
			</>,
			{ wrapper: wrapper(client) },
		);
		await waitFor(() =>
			expect(screen.getByTestId("T2")).toHaveTextContent("error"),
		);
		expect(screen.getByTestId("T1")).toHaveTextContent("T1");
	});

	it("an id left out of the answer is a 502: the server answered", async () => {
		answer = async () => json({ threads: [] });
		const client = newClient({
			defaultOptions: { queries: { retry: false } },
		});
		await expect(
			client.fetchQuery(commentsQuery("r1", "T1")),
		).rejects.toMatchObject({ status: 502 });
	});

	it("a new prefetch order moves what is still queued", async () => {
		const slow = answer;
		answer = async (a) => {
			await new Promise((r) => setTimeout(r, 200));
			return slow(a);
		};
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={ids(200)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(asked).toHaveLength(2));
		// Another file opened: its threads first, then the rest as before.
		rerender(<Prefetch readId="r1" ids={[...ids(50, 150), ...ids(150)]} />);
		await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(4));
		expect(asked[2]?.ids).toEqual(ids(50, 150));
		expect(asked[3]?.ids).toEqual(ids(50, 100));
	});

	it("an opened thread stays ahead of a new prefetch order", async () => {
		const slow = answer;
		answer = async (a) => {
			await new Promise((r) => setTimeout(r, 300));
			return slow(a);
		};
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={ids(200)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(asked).toHaveLength(2));
		// The first opened one takes the third request: every slot is busy.
		rerender(
			<>
				<Prefetch readId="r1" ids={ids(200)} />
				<Thread readId="r1" id="T180" />
			</>,
		);
		await waitFor(() => expect(asked).toHaveLength(3));
		rerender(
			<>
				<Prefetch readId="r1" ids={[...ids(50, 150), ...ids(150)]} />
				<Thread readId="r1" id="T180" />
				<Thread readId="r1" id="T190" />
			</>,
		);
		await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(5));
		expect(asked[3]?.ids).toEqual(["T190"]);
		// Then the new order: the reordered ones not sent yet, then the rest.
		expect(asked[4]?.ids).toEqual([
			...ids(50, 150).filter((id) => id !== "T180" && id !== "T190"),
			"T100",
			"T101",
		]);
	});

	it("a read gone (410) sends nothing more for it", async () => {
		answer = async () => {
			await new Promise((r) => setTimeout(r, 30));
			return json({ error: "read gone" }, 410);
		};
		const client = newClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(<Prefetch readId="r1" ids={ids(200)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(client.getQueryState(["comments", "r1", "T199"])?.status).toBe(
				"error",
			),
		);
		// The two out when it went; the queued ones never sent.
		expect(asked).toHaveLength(2);
	});

	it("a new read drops the old one's queue and comments", async () => {
		const slow = answer;
		answer = async (a) => {
			await new Promise((r) => setTimeout(r, 100));
			return slow(a);
		};
		const client = newClient();
		const { rerender } = render(<Prefetch readId="r1" ids={ids(200)} />, {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(asked).toHaveLength(2));
		rerender(<Prefetch readId="r2" ids={ids(3)} />);
		await waitFor(() =>
			expect(client.getQueryData(["comments", "r2", "T2"])).toBeDefined(),
		);
		await new Promise((r) => setTimeout(r, 150));
		expect(asked.map((a) => a.read)).toEqual(["r1", "r1", "r2"]);
		expect(
			client.getQueryCache().findAll({ queryKey: ["comments", "r1"] }),
		).toEqual([]);
		// Kept a while without anyone showing them, not forever.
		expect(commentsQuery("r2", "T0").gcTime).toBeLessThanOrEqual(3_600_000);
	});

	it("waits for a read id", async () => {
		const client = newClient();
		render(<Thread readId={undefined} id="T1" />, { wrapper: wrapper(client) });
		await new Promise((r) => setTimeout(r, 30));
		expect(asked).toEqual([]);
		expect(screen.getByTestId("T1")).toHaveTextContent("loading");
	});
});

describe("comments across reads and pages", () => {
	it("asks for nothing while the read id is empty", async () => {
		const client = newClient();
		render(<Thread readId="" id="T1" />, { wrapper: wrapper(client) });
		await new Promise((r) => setTimeout(r, 30));
		expect(asked).toEqual([]);
		expect(screen.getByTestId("T1")).toHaveTextContent("loading");
	});

	it("keeps the previous read's comments shown until the new read's land", async () => {
		const client = newClient();
		const { rerender } = render(<Thread readId="r1" id="T1" />, {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(screen.getByTestId("T1")).toHaveTextContent("T1"),
		);
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		answer = async (a) => {
			await gate;
			return json({
				threads: a.ids.map((id) => ({
					...comments(id),
					comments: comments(id).comments.map((c) => ({
						...c,
						text: `${id} new`,
					})),
				})),
			} satisfies CommentsView);
		};
		rerender(<Thread readId="r2" id="T1" />);
		await waitFor(() => expect(asked.at(-1)?.read).toBe("r2"));
		expect(screen.getByTestId("T1")).toHaveTextContent("T1");
		expect(screen.getByTestId("T1")).not.toHaveTextContent("loading");
		release();
		await waitFor(() =>
			expect(screen.getByTestId("T1")).toHaveTextContent("T1 new"),
		);
	});

	it("a hidden kept page prefetches nothing; shown again, its order applies", async () => {
		const client = newClient();
		const page = (active: boolean) => (
			<PageActive value={active}>
				<Prefetch readId="r1" ids={["T1", "T2"]} />
			</PageActive>
		);
		const { rerender } = render(page(false), { wrapper: wrapper(client) });
		await new Promise((r) => setTimeout(r, 30));
		expect(asked).toEqual([]);
		rerender(page(true));
		await waitFor(() =>
			expect(asked).toEqual([{ read: "r1", ids: ["T1", "T2"] }]),
		);
	});
});
