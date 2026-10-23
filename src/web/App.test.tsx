// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrOverview, ReviewView, SessionInfo } from "../shared/types";
import { createAppRouter } from "./router";

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: "b".repeat(40),
	currentHead: "b".repeat(40),
	headMoved: false,
	patchset: null,
};

const overview: PrOverview = {
	title: "Add widget cache",
	number: 12,
	url: "https://github.com/acme/widget/pull/12",
	author: "octo-author",
	body: "Caches **widgets**.\n\n<script>window.pwned = true</script>\n\n[bad](javascript:alert(1))",
	isDraft: false,
	state: "OPEN",
	createdAt: "2026-01-02T10:00:00Z",
	updatedAt: "2026-01-05T12:00:00Z",
	baseBranch: "main",
	headBranch: "feature/cache",
	mergeable: "MERGEABLE",
	requestedReviewers: [
		{ name: "rev2", team: false },
		{ name: "Core Team", team: true },
	],
	reviews: [
		{
			author: "rev1",
			state: "COMMENTED",
			opinion: "CHANGES_REQUESTED",
			submittedAt: "2026-01-04T09:00:00Z",
			you: false,
			bot: false,
		},
		{
			author: "github-actions",
			state: "COMMENTED",
			submittedAt: "2026-01-02T11:00:00Z",
			you: false,
			bot: true,
		},
	],
	commenters: [
		{ author: "octo", lastAt: "2026-01-04T10:00:00Z", bot: false, you: true },
		{
			author: "codecov",
			lastAt: "2026-01-04T08:00:00Z",
			bot: true,
			you: false,
		},
	],
	humanStarted: true,
	checks: [
		{ name: "lint", status: "failing", url: "https://ci.example/lint" },
		{ name: "deploy/preview", status: "pending", url: "javascript:alert(1)" },
		{ name: "build", status: "passing" },
	],
	threads: [
		{
			path: "src/old.ts",
			line: null,
			excerpt: "Coverage dropped",
			author: "ci-bot",
			bot: true,
			hasReply: false,
			outdated: true,
		},
		{
			path: "src/cache.ts",
			line: 42,
			excerpt: "Should this expire?",
			author: "rev1",
			bot: false,
			hasReply: true,
			outdated: false,
		},
	],
};

const counts = (total: number, reviewed: number, crossedOff: number) => ({
	total,
	reviewed,
	crossedOff,
});
const review: ReviewView = {
	revision: "r1",
	patchset: null,
	files: [],
	progress: {
		clusters: counts(6, 2, 1),
		lines: counts(40, 10, 2),
		files: { ...counts(3, 1, 0), done: 1 },
	},
};

type Routes = Record<string, { status: number; body: unknown }>;

let fetchMock: ReturnType<typeof mockApi>;

function mockApi(routes: Routes) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const path = new URL(String(input), "http://test").pathname;
		const route = routes[path];
		if (!route) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(route.body), { status: route.status });
	});
	vi.stubGlobal("fetch", fetchMock);
	// jsdom lacks scrolling; the router restores scroll on navigation.
	vi.stubGlobal("scrollTo", vi.fn());
	return fetchMock;
}

const ok = (body: unknown) => ({ status: 200, body });

function renderApp(routes: Partial<Routes> = {}, path = "/") {
	fetchMock = mockApi({
		"/api/session": ok(info),
		"/api/overview": ok(overview),
		"/api/review": ok(review),
		...routes,
	} as Routes);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const router = createAppRouter({ initialPath: path });
	const view = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { ...view, router };
}

const calls = (path: string) =>
	fetchMock.mock.calls.filter(([input]) => String(input) === path).length;

describe("App", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("shows the PR title and number", async () => {
		renderApp();
		expect(
			await screen.findByRole("heading", {
				level: 1,
				name: "Add widget cache",
			}),
		).toBeInTheDocument();
		const number = screen.getByRole("link", { name: "#12" });
		expect(number).toHaveAttribute("target", "_blank");
		expect(number).toHaveAttribute("rel", "noreferrer");
	});

	it("does not ask GitHub again when the overview remounts", async () => {
		const { router } = renderApp();
		await screen.findByRole("region", { name: "What it does" });
		await router.navigate({ to: "/files" });
		await screen.findByRole("region", { name: "Files changed" });
		await router.navigate({ to: "/" });
		await screen.findByRole("region", { name: "What it does" });
		expect(calls("/api/overview")).toBe(1);
		expect(calls("/api/session")).toBe(1);
	});

	it("shows the moved-head banner once the head check reports new commits", async () => {
		renderApp({
			"/api/head": ok({
				...info,
				currentHead: "c".repeat(40),
				headMoved: true,
			}),
		});
		expect(await screen.findByRole("status")).toHaveTextContent(
			"New commits were pushed",
		);
	});

	it("shows no banner, and no error, when the head check fails", async () => {
		renderApp({
			"/api/head": { status: 502, body: { error: "gh is down" } },
		});
		await screen.findByRole("heading", { level: 1 });
		await waitFor(() => expect(calls("/api/head")).toBe(1));
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the server's error message", async () => {
		renderApp({
			"/api/session": { status: 502, body: { error: "gh is not logged in" } },
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"gh is not logged in",
		);
	});
});

describe("OverviewPage", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders the description as markdown without raw HTML", async () => {
		const { container } = renderApp();
		const what = await screen.findByRole("region", { name: "What it does" });
		expect(within(what).getByText("widgets").tagName).toBe("STRONG");
		expect(container.querySelector("script")).toBeNull();
		expect(
			within(what).getByText("bad").getAttribute("href") ?? "",
		).not.toMatch(/javascript/i);
	});

	it("says who already started reviewing, with their blocking opinion", async () => {
		renderApp();
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(who).toHaveTextContent("rev1 already started");
		expect(within(who).getByText("rev1").closest("li")).toHaveTextContent(
			"Changes requested",
		);
		expect(who).toHaveTextContent("rev2");
		expect(who).toHaveTextContent("Core Team");
	});

	it("says when no one else has started", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				reviews: [],
				commenters: [],
				requestedReviewers: [],
				humanStarted: false,
			}),
		});
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(who).toHaveTextContent("No one else has started reviewing");
	});

	it("lists checks failing, then pending, then passing, with safe links only", async () => {
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const names = within(ready)
			.getAllByTestId("check")
			.map((li) => li.textContent);
		expect(
			names.map((n) => n?.match(/lint|deploy\/preview|build/)?.[0]),
		).toEqual(["lint", "deploy/preview", "build"]);
		expect(within(ready).getByRole("link", { name: /lint/ })).toHaveAttribute(
			"href",
			"https://ci.example/lint",
		);
		expect(within(ready).queryByRole("link", { name: /deploy/ })).toBeNull();
	});

	it("splits unresolved threads into bots and humans and lists those without reply", async () => {
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const bots = within(ready).getByRole("list", { name: "Bots/AI threads" });
		const humans = within(ready).getByRole("list", { name: "Human threads" });
		expect(bots).toHaveTextContent("Coverage dropped");
		expect(humans).toHaveTextContent("Should this expire?");
		const noReply = within(ready).getByRole("list", { name: "No reply" });
		expect(noReply).toHaveTextContent("src/old.ts");
		expect(noReply).not.toHaveTextContent("src/cache.ts");
	});

	it("shows the overview's error message", async () => {
		renderApp({
			"/api/overview": {
				status: 502,
				body: { error: "PR acme/widget#12 not found" },
			},
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"PR acme/widget#12 not found",
		);
	});

	it("shows review progress on the Review files button", async () => {
		renderApp();
		const link = await screen.findByRole("link", { name: /Review files/ });
		expect(await within(link).findByText(/2 \/ 5/)).toBeInTheDocument();
		expect(link).toHaveAttribute("href", "/files");
	});
});
