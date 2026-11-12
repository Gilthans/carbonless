// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewView, SessionInfo } from "../../shared/types";
import { reviewQuery, sessionQuery } from "../api";
import { parseFilesSearch } from "../files/landing";
import { parseSearch, stringifySearch } from "../search";
import { AgentMarkdown } from "./AgentMarkdown";
import { codeLinkSearch, codeLinkTarget } from "./codeLinks";

afterEach(cleanup);

const H3 = "3".repeat(40);
const H9 = "9".repeat(40);
const files = new Set(["src/a.ts", "docs/b.md"]);
const patchsets = [
	{ number: 2, head: "2".repeat(40) },
	{ number: 3, head: H3 },
];

describe("codeLinkTarget", () => {
	const ref = { path: "src/a.ts", start: 12, end: 18 };

	it("opens the answer's head: ps when it is a patch set's, head otherwise", () => {
		expect(codeLinkTarget(ref, H3, files, patchsets)).toBe(
			"?path=src%2Fa.ts&line=12&side=RIGHT&ps=3",
		);
		expect(codeLinkTarget(ref, H9, files, patchsets)).toBe(
			`?path=src%2Fa.ts&line=12&side=RIGHT&head=${H9}`,
		);
	});

	it("opens the current view without a head, and for one that is no commit id", () => {
		expect(codeLinkTarget(ref, undefined, files, patchsets)).toBe(
			"?path=src%2Fa.ts&line=12&side=RIGHT",
		);
		expect(
			codeLinkSearch(ref, "javascript:alert(1)", files, patchsets),
		).toEqual({ path: "src/a.ts", line: 12, side: "RIGHT" });
	});

	it("is null for a path not in the PR", () => {
		expect(
			codeLinkTarget(
				{ path: "src/x.ts", start: 1, end: 1 },
				H3,
				files,
				patchsets,
			),
		).toBeNull();
	});
});

function show(text: string, head?: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(reviewQuery().queryKey, {
		files: [{ path: "src/a.ts" }, { path: "docs/b.md" }],
	} as unknown as ReviewView);
	client.setQueryData(sessionQuery.queryKey, {
		patchsets,
	} as unknown as SessionInfo);
	const root = createRootRoute({
		component: () => (
			<>
				<AgentMarkdown text={text} head={head} />
				<Outlet />
			</>
		),
	});
	const filesRoute = createRoute({
		getParentRoute: () => root,
		path: "/r/$id/files",
		validateSearch: parseFilesSearch,
		component: () => <p data-testid="files-page" />,
	});
	const index = createRoute({
		getParentRoute: () => root,
		path: "/r/$id/overview",
		component: () => null,
	});
	const router = createRouter({
		routeTree: root.addChildren([filesRoute, index]),
		history: createMemoryHistory({ initialEntries: ["/r/RV1/overview"] }),
		parseSearch,
		stringifySearch,
	});
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return Object.assign(router, { client });
}

describe("code links in an agent's answer", () => {
	it("path:line and path:start-end in inline code and bare text become router links", async () => {
		const router = show(
			"See `src/a.ts:12` and src/a.ts:20-25, also docs/b.md:3.",
			H3,
		);
		const links = await screen.findAllByTestId("agent-code-link");
		expect(links.map((l) => l.textContent)).toEqual([
			"src/a.ts:12",
			"src/a.ts:20-25",
			"docs/b.md:3",
		]);
		// Inline code stays code inside its link.
		expect(links[0]?.querySelector("code")).not.toBeNull();
		await userEvent.click(links[1] as HTMLElement);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/r/RV1/files"),
		);
		expect(router.state.location.search).toMatchObject({
			path: "src/a.ts",
			line: "20",
			ps: "3",
		});
	});

	it("a path not in the PR stays text", async () => {
		show(
			"Look at `src/nope.ts:4` and lib/other.ts:9 and src/a.ts without a line.",
			H3,
		);
		await screen.findByText(/Look at/);
		expect(screen.queryAllByTestId("agent-code-link")).toHaveLength(0);
	});

	it("no href is built from the agent's text: a javascript: link is dropped and every link is the router's", async () => {
		show(
			'[src/a.ts:12](javascript:alert(1)) and <a href="javascript:alert(2)">src/a.ts:5</a>',
			H3,
		);
		await screen.findByText(/and/);
		for (const a of document.querySelectorAll("a")) {
			expect(a.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
		}
		// The agent's text never becomes an href: every link of ours is the router's.
		for (const a of screen.queryAllByTestId("agent-code-link")) {
			expect(a.getAttribute("href")).toMatch(/^\/r\/RV1\/files\?/);
		}
	});

	it("a link still navigates through the router after the PR's files or patch sets are refetched", async () => {
		const router = show("See `src/a.ts:12`.", H3);
		await screen.findByTestId("agent-code-link");
		// New identities (a refetch after a push): the prose is linked again.
		act(() => {
			router.client.setQueryData(reviewQuery().queryKey, {
				files: [
					{ path: "src/a.ts" },
					{ path: "docs/b.md" },
					{ path: "src/new.ts" },
				],
			} as unknown as ReviewView);
			router.client.setQueryData(sessionQuery.queryKey, {
				patchsets: [...patchsets, { number: 4, head: H9 }],
			} as unknown as SessionInfo);
		});
		const link = await screen.findByTestId("agent-code-link");
		// fireEvent returns false when the click's default was prevented.
		expect(fireEvent.click(link)).toBe(false);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/r/RV1/files"),
		);
		expect(router.state.location.search).toMatchObject({
			path: "src/a.ts",
			line: "12",
			ps: "3",
		});
	});

	it("no links without a router or without the PR's files", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, enabled: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<AgentMarkdown text="`src/a.ts:12`" />
			</QueryClientProvider>,
		);
		expect(screen.getByText("src/a.ts:12")).toBeTruthy();
		expect(screen.queryAllByTestId("agent-code-link")).toHaveLength(0);
	});
});
