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
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrOverview, ReviewView, SessionInfo } from "../shared/types";
import { COMPACT_RAMP, compactProgress } from "./App";
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
	asOf: null,
};

const overview: PrOverview = {
	title: "Add widget cache",
	number: 12,
	url: "https://github.com/acme/widget/pull/12",
	author: "octo-author",
	body: "## Summary\n\n<!-- reviewers: see below -->\nCaches **widgets**. :tada:",
	// What GitHub renders, plus what a hostile or broken response could carry.
	bodyHtml:
		'<h2 dir="auto">Summary</h2><p dir="auto">Caches <strong>widgets</strong>. <g-emoji class="g-emoji" alias="tada">🎉</g-emoji> <img class="emoji" alt=":shipit:" src="https://github.githubassets.com/images/icons/emoji/shipit.png"></p>' +
		'<!-- leaked --><script>window.pwned = true</script><img src="x" onerror="window.pwned = true"><a href="javascript:alert(1)">bad</a>',
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
			html: '<p dir="auto">Coverage <em>dropped</em> by 2%</p>',
			createdAt: "2026-01-02T12:00:00Z",
			author: "ci-bot",
			bot: true,
			commentCount: 1,
			hasReply: false,
			outdated: true,
			lastActivityAt: "2026-01-02T12:00:00Z",
			resolved: false,
			code: null,
		},
		{
			path: "src/cache.ts",
			line: 42,
			excerpt: "Should this expire?",
			html: '<p dir="auto">Should this <strong>expire</strong>?</p>',
			createdAt: "2026-01-03T09:00:00Z",
			author: "rev1",
			bot: false,
			commentCount: 3,
			hasReply: true,
			outdated: false,
			lastActivityAt: "2026-01-03T11:00:00Z",
			resolved: false,
			code: {
				diffHunk:
					"@@ -40,2 +40,3 @@ class Cache {\n   get() {}\n-  old() {}\n+  set() {}\n+  ttl = 5;",
				side: "RIGHT",
				startSide: "RIGHT",
				startLine: 42,
				endLine: 42,
			},
		},
		...[1, 2, 3, 4].map((i) =>
			humanThread(`src/done${i}.ts`, { resolved: true }),
		),
	],
};

function humanThread(
	path: string,
	extra: Partial<PrOverview["threads"][number]> = {},
): PrOverview["threads"][number] {
	return {
		path,
		line: 1,
		excerpt: path,
		html: `<p>${path}</p>`,
		createdAt: "2026-01-01T09:00:00Z",
		lastActivityAt: "2026-01-01T09:00:00Z",
		author: "rev2",
		bot: false,
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		...extra,
	};
}

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

	it("keeps a visited page mounted, hidden and inert, while the other shows", async () => {
		const { router } = renderApp();
		const what = await screen.findByRole("region", { name: "What it does" });
		await router.navigate({ to: "/files" });
		const files = await screen.findByRole("region", { name: "Files changed" });
		await screen.findByRole("progressbar", { name: "Review progress" });
		const reads = calls("/api/review");
		// The overview is still there, as it was, but out of reach.
		const kept = what.closest("[data-page]");
		expect(kept).toHaveAttribute("data-page", "/");
		expect(kept).toHaveAttribute("hidden");
		expect(kept).toHaveAttribute("inert");
		expect(kept).toHaveAttribute("aria-hidden", "true");
		expect(what).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "What it does" })).toBeNull();
		await router.navigate({ to: "/" });
		// The same elements come back: nothing remounted.
		expect(await screen.findByRole("region", { name: "What it does" })).toBe(
			what,
		);
		expect(files.closest("[data-page]")).toHaveAttribute("hidden");
		expect(screen.queryByRole("region", { name: "Files changed" })).toBeNull();
		await router.navigate({ to: "/files" });
		expect(await screen.findByRole("region", { name: "Files changed" })).toBe(
			files,
		);
		expect(files.closest("[data-page]")).not.toHaveAttribute("aria-hidden");
		expect(what.closest("[data-page]")).toHaveAttribute("aria-hidden", "true");
		// The files page reads the review again as it shows (writes made
		// elsewhere appear); the overview, staying, does not refetch.
		await waitFor(() => expect(calls("/api/review")).toBe(reads + 1));
		expect(screen.getByRole("region", { name: "Files changed" })).toBe(files);
		expect(calls("/api/overview")).toBe(1);
	});

	it("shows no kept page on an unknown path", async () => {
		const { router } = renderApp();
		await screen.findByRole("region", { name: "What it does" });
		await router.navigate({ to: "/nope" as "/" });
		expect(await screen.findByText(/No such page/)).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "What it does" })).toBeNull();
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

	it("renders the description as GitHub renders it, sanitized", async () => {
		const { container } = renderApp();
		const what = await screen.findByRole("region", { name: "What it does" });
		expect(
			within(what).getByRole("heading", { name: "Summary" }),
		).toBeInTheDocument();
		expect(within(what).getByText("widgets").tagName).toBe("STRONG");
		expect(what).toHaveTextContent("🎉");
		expect(within(what).getByAltText(":shipit:")).toHaveAttribute(
			"src",
			"https://github.githubassets.com/images/icons/emoji/shipit.png",
		);
		expect(what.textContent).not.toContain("<!--");
		expect(what.textContent).not.toContain("reviewers: see below");
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("[onerror]")).toBeNull();
		expect(within(what).getByText("bad")).not.toHaveAttribute("href");
		expect(container.querySelector(".markdown-body")).toContainElement(
			within(what).getByText("widgets"),
		);
	});

	it("falls back to the plain description when GitHub sent no HTML", async () => {
		renderApp({
			"/api/overview": ok({ ...overview, bodyHtml: "", body: "<b>raw</b>" }),
		});
		const what = await screen.findByRole("region", { name: "What it does" });
		expect(what).toHaveTextContent("<b>raw</b>");
		expect(what.querySelector("b")).toBeNull();
	});

	it("links the PR on GitHub with the GitHub mark", async () => {
		renderApp();
		const what = await screen.findByRole("region", { name: "What it does" });
		const link = within(what).getByRole("link", { name: "View on GitHub" });
		expect(link).toHaveAttribute("href", overview.url);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link.querySelector("svg")).not.toBeNull();
		expect(link).not.toHaveTextContent(/\S/);
		const user = userEvent.setup();
		await user.hover(link);
		// Its text repeats the link's name, so it is hidden from the a11y tree.
		await waitFor(() =>
			expect(
				screen.getByText("View on GitHub", { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
	});

	it("shows PR dates as relative <time>s", async () => {
		vi.useFakeTimers({
			now: new Date("2026-01-05T18:00:00Z"),
			toFake: ["Date"],
		});
		try {
			renderApp();
			const what = await screen.findByRole("region", {
				name: "What it does",
			});
			const times = [...what.querySelectorAll("time")];
			expect(times.map((t) => t.getAttribute("dateTime"))).toEqual([
				"2026-01-02T10:00:00Z",
				"2026-01-05T12:00:00Z",
			]);
			expect(times.map((t) => t.textContent)).toEqual([
				"3 days ago",
				"6 hours ago",
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("says who already started reviewing, with their blocking opinion", async () => {
		renderApp();
		const who = await screen.findByRole("region", { name: "Who's on it" });
		expect(who).toHaveTextContent("rev1 already started");
		const rev1 = within(who).getByText("rev1").closest("li");
		if (!rev1) throw new Error("no rev1 row");
		const changes = within(rev1).getByRole("img", {
			name: "Changes requested",
		});
		// Keyboard and touch reach the tooltip too: the icon takes focus.
		changes.focus();
		expect(
			await screen.findByText("Changes requested", {
				selector: "[role=tooltip]",
			}),
		).toBeVisible();
		// The later comment is secondary: smaller, after a short "then".
		const then = within(rev1).getByRole("img", { name: "then commented" });
		expect(then.querySelector("svg")).toHaveAttribute("width", "12");
		expect(then.parentElement).toHaveTextContent(/^then/);
		expect(changes.querySelector("svg")).toHaveAttribute("width", "16");
		expect(who).toHaveTextContent("rev2");
		expect(who).toHaveTextContent("Core Team");
		expect(within(who).getByRole("img", { name: "team" })).toBeInTheDocument();
		const bot = within(who).getByText("github-actions").closest("li");
		expect(bot && within(bot).getByRole("img", { name: "bot" })).toBeTruthy();
	});

	it("shows when each review was submitted and each commenter last commented", async () => {
		renderApp();
		const who = await screen.findByRole("region", { name: "Who's on it" });
		const timeIn = (name: string) =>
			within(who).getByText(name).closest("li")?.querySelector("time");
		expect(timeIn("rev1")).toHaveAttribute("dateTime", "2026-01-04T09:00:00Z");
		expect(timeIn("github-actions")).toHaveAttribute(
			"dateTime",
			"2026-01-02T11:00:00Z",
		);
		expect(timeIn("codecov")).toHaveAttribute(
			"dateTime",
			"2026-01-04T08:00:00Z",
		);
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

	it("sums up readiness in one row of chips: conflicts and CI", async () => {
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const row = within(ready).getByRole("list", { name: "Readiness" });
		expect(
			within(row)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["No conflicts", "1 failing", "1 pending", "1 passing"]);
		// The list of checks stays closed until a CI chip is pressed.
		expect(within(ready).queryByRole("list", { name: "Checks" })).toBeNull();
		expect(within(ready).queryAllByTestId("check")).toHaveLength(0);
	});

	it("opens the checks, failing first, from any CI chip, with safe links only", async () => {
		const user = userEvent.setup();
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const failing = within(ready).getByRole("button", { name: /1 failing/ });
		expect(failing).toHaveAttribute("aria-expanded", "false");
		await user.click(failing);
		expect(failing).toHaveAttribute("aria-expanded", "true");
		const list = within(ready).getByRole("list", { name: "Checks" });
		expect(failing).toHaveAttribute("aria-controls", list.id);
		// Named by the visible heading; the chip's tip isn't its description.
		expect(
			document.getElementById(list.getAttribute("aria-labelledby") ?? ""),
		).toHaveTextContent("Checks");
		expect(failing).not.toHaveAttribute("aria-describedby");
		const names = within(list)
			.getAllByTestId("check")
			.map((li) => li.textContent);
		expect(
			names.map((n) => n?.match(/lint|deploy\/preview|build/)?.[0]),
		).toEqual(["lint", "deploy/preview", "build"]);
		expect(within(list).getByRole("link", { name: /lint/ })).toHaveAttribute(
			"href",
			"https://ci.example/lint",
		);
		expect(within(list).queryByRole("link", { name: /deploy/ })).toBeNull();
		await user.click(within(ready).getByRole("button", { name: /1 passing/ }));
		expect(within(ready).queryByRole("list", { name: "Checks" })).toBeNull();
	});

	it("shows all-passing CI as one chip, and draft and conflicts in red or grey", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				isDraft: true,
				mergeable: "CONFLICTING",
				checks: [
					{ name: "a", status: "passing" },
					{ name: "b", status: "passing" },
				],
			}),
		});
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const row = within(ready).getByRole("list", { name: "Readiness" });
		expect(
			within(row)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["Draft", "Conflicts", "2/2 passing"]);
		expect(within(row).getByText("Conflicts").closest("span")).toHaveClass(
			"text-bad",
		);
		cleanup();
		renderApp({
			"/api/overview": ok({ ...overview, mergeable: "UNKNOWN", checks: [] }),
		});
		const again = await screen.findByRole("region", { name: "Is it ready" });
		expect(
			within(within(again).getByRole("list", { name: "Readiness" }))
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["Conflicts unknown", "No checks"]);
	});

	it("explains a chip in a tooltip on focus", async () => {
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		within(ready)
			.getByText("No conflicts")
			.closest<HTMLElement>("[tabindex]")
			?.focus();
		expect(
			await screen.findByText("Merges cleanly into main", {
				selector: "[role=tooltip]",
			}),
		).toBeVisible();
	});

	it("puts unresolved threads under human and bot reviews, with resolved counts", async () => {
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const bots = screen.getByRole("region", { name: "Bot reviews" });
		expect(
			within(humans).getByRole("list", { name: "Thread counts" }),
		).toHaveTextContent("1 unresolved4 resolved");
		expect(
			within(bots).getByRole("list", { name: "Thread counts" }),
		).toHaveTextContent("1 unresolved0 resolved");
		const human = within(humans).getByTestId("thread");
		expect(human).toHaveTextContent("src/cache.ts:42");
		expect(human.querySelector("code")).toHaveTextContent("src/cache.ts:42");
		expect(human).toHaveTextContent("rev1");
		// Last active, which the threads are sorted by.
		expect(human.querySelector("time")).toHaveAttribute(
			"dateTime",
			"2026-01-03T11:00:00Z",
		);
		const count = within(human).getByRole("img", { name: "3 comments" });
		expect(count).toHaveTextContent("3");
		expect(human).not.toHaveTextContent("no reply");
		const bot = within(bots).getByTestId("thread");
		expect(bot).toHaveTextContent("no reply");
		// Its icon isn't the comment count's.
		const noReply = within(bot).getByText("no reply");
		expect(noReply.querySelector("svg")).toHaveClass("octicon-reply");
		expect(
			within(bot).getByRole("img", { name: "1 comment" }).querySelector("svg"),
		).toHaveClass("octicon-comment");
		expect(bot).toHaveTextContent("outdated");
		expect(within(bot).getByRole("img", { name: "1 comment" })).toBeVisible();
		// The per-thread chip replaces the separate list.
		expect(screen.queryByRole("list", { name: "No reply" })).toBeNull();
		expect(screen.queryByText("Unresolved threads")).toBeNull();
	});

	it("says so when a group has no threads at all", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [1, 2].map((i) =>
					humanThread(`src/r${i}.ts`, { resolved: true }),
				),
			}),
		});
		const bots = await screen.findByRole("region", { name: "Bot reviews" });
		expect(bots).toHaveTextContent("No threads");
		const humans = screen.getByRole("region", { name: "Human reviews" });
		expect(humans).toHaveTextContent("2 resolved");
		expect(
			within(humans).queryByRole("list", { name: "Unresolved threads" }),
		).toBeNull();
	});

	it("the resolved count is a toggle that swaps the list to resolved threads and back", async () => {
		const user = userEvent.setup();
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const toggle = within(humans).getByRole("button", { name: "4 resolved" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toBeInTheDocument();
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(
			within(humans).queryByRole("list", { name: "Unresolved threads" }),
		).toBeNull();
		const list = within(humans).getByRole("list", { name: "Resolved threads" });
		expect(
			within(list)
				.getAllByTestId("thread")
				.map((t) => t.querySelector("code")?.textContent),
		).toEqual([
			"src/done1.ts:1",
			"src/done2.ts:1",
			"src/done3.ts:1",
			"src/done4.ts:1",
		]);
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(within(humans).getAllByTestId("thread")).toHaveLength(1);
	});

	it("lists five threads at a time; Load more adds five; the toggle starts over", async () => {
		const user = userEvent.setup();
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					...Array.from({ length: 12 }, (_, i) => humanThread(`src/u${i}.ts`)),
					...Array.from({ length: 7 }, (_, i) =>
						humanThread(`src/r${i}.ts`, { resolved: true }),
					),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const shown = () =>
			within(humans)
				.getAllByTestId("thread")
				.map((t) => t.querySelector("code")?.textContent);
		expect(shown()).toEqual([0, 1, 2, 3, 4].map((i) => `src/u${i}.ts:1`));
		const more = within(humans).getByRole("button", { name: "Load more" });
		await user.click(more);
		expect(shown()).toHaveLength(10);
		await user.click(more);
		expect(shown()).toHaveLength(12);
		expect(
			within(humans).queryByRole("button", { name: "Load more" }),
		).toBeNull();
		await user.click(
			within(humans).getByRole("button", { name: "7 resolved" }),
		);
		expect(shown()).toEqual([0, 1, 2, 3, 4].map((i) => `src/r${i}.ts:1`));
		await user.click(within(humans).getByRole("button", { name: "Load more" }));
		expect(shown()).toHaveLength(7);
		await user.click(
			within(humans).getByRole("button", { name: "7 resolved" }),
		);
		expect(shown()).toHaveLength(5);
	});

	it("shows the code a comment was written on beside it, the commented line marked; a file comment has none", async () => {
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const code = within(humans).getByRole("figure", {
			name: "Code at src/cache.ts",
		});
		const rows = within(code).getAllByTestId("thread-code-line");
		expect(rows.map((r) => r.textContent?.replace(/\s+/g, " "))).toEqual([
			"4040 get() {}",
			"41− old() {}",
			"41+ set() {}",
			"42+ ttl = 5;",
		]);
		expect(rows.map((r) => r.hasAttribute("data-marked"))).toEqual([
			false,
			false,
			false,
			true,
		]);
		const bots = screen.getByRole("region", { name: "Bot reviews" });
		expect(within(bots).queryByTestId("thread-code")).toBeNull();
		expect(within(bots).getByTestId("thread")).toHaveTextContent("src/old.ts");
	});

	it("previews a thread as GitHub renders it, clipped, with a toggle when it is long", async () => {
		const user = userEvent.setup();
		// jsdom has no layout: make every clipped body look taller than its box.
		const scroll = vi
			.spyOn(HTMLElement.prototype, "scrollHeight", "get")
			.mockReturnValue(400);
		const client = vi
			.spyOn(HTMLElement.prototype, "clientHeight", "get")
			.mockReturnValue(128);
		try {
			renderApp();
			const bots = await screen.findByRole("region", { name: "Bot reviews" });
			const body = within(bots).getByTestId("thread-body");
			expect(body.querySelector(".markdown-body em")).toHaveTextContent(
				"dropped",
			);
			expect(body).toHaveClass("max-h-32", "overflow-hidden");
			const toggle = within(bots).getByRole("button", { name: "Show more" });
			expect(toggle).toHaveAttribute("aria-expanded", "false");
			expect(toggle).toHaveAttribute("aria-controls", body.id);
			await user.click(toggle);
			expect(body).not.toHaveClass("max-h-32");
			const less = within(bots).getByRole("button", { name: "Show less" });
			expect(less).toHaveAttribute("aria-expanded", "true");
			await user.click(less);
			expect(body).toHaveClass("max-h-32");
		} finally {
			scroll.mockRestore();
			client.mockRestore();
		}
	});

	it("offers no toggle for a short thread", async () => {
		renderApp();
		const bots = await screen.findByRole("region", { name: "Bot reviews" });
		expect(within(bots).getByTestId("thread-body")).toHaveTextContent(
			"Coverage dropped by 2%",
		);
		expect(
			within(bots).queryByRole("button", { name: "Show more" }),
		).toBeNull();
	});

	it("refetches the overview when a GitHub image breaks in a page left open (signed URLs expire)", async () => {
		vi.useFakeTimers({
			now: new Date("2026-01-05T18:00:00Z"),
			toFake: ["Date"],
		});
		try {
			renderApp();
			const what = await screen.findByRole("region", {
				name: "What it does",
			});
			const img = () => within(what).getByAltText(":shipit:");
			expect(calls("/api/overview")).toBe(1);
			// Breaking right after the fetch: not an expired URL, no refetch.
			img().dispatchEvent(new Event("error"));
			expect(calls("/api/overview")).toBe(1);
			vi.setSystemTime(new Date("2026-01-05T18:06:00Z"));
			img().dispatchEvent(new Event("error"));
			await waitFor(() => expect(calls("/api/overview")).toBe(2));
			// Throttled: more broken images within the minute don't refetch.
			vi.setSystemTime(new Date("2026-01-05T18:06:30Z"));
			img().dispatchEvent(new Event("error"));
			await new Promise((r) => setTimeout(r, 50));
			expect(calls("/api/overview")).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks check status with a named icon instead of a word", async () => {
		const user = userEvent.setup();
		renderApp();
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		await user.click(within(ready).getByRole("button", { name: /1 failing/ }));
		const lint = within(ready).getAllByTestId("check")[0];
		if (!lint) throw new Error("no check");
		expect(within(lint).getByRole("img", { name: "failing" })).toBeVisible();
		expect(within(lint).getByRole("link")).toHaveTextContent(/^lint$/);
		// The tooltip lives in a portal, hidden until opened.
		expect(within(lint).queryByText("failing")).toBeNull();
		expect(
			screen.getAllByText("failing", { selector: "[role=tooltip]" })[0],
		).not.toBeVisible();
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

	it("marks the Overview tab current on a URL with a query (the first load's ?key=)", async () => {
		renderApp({}, "/?key=abc");
		await screen.findByRole("region", { name: "What it does" });
		expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(
			screen.getByRole("link", { name: "Files changed" }),
		).not.toHaveAttribute("aria-current");
	});

	it("as of a cutoff: marks the header with the date and says resolution is unknown", async () => {
		renderApp({
			"/api/session": ok({ ...info, asOf: "2026-09-15T11:35:52Z" }),
			"/api/overview": ok({
				...overview,
				threads: overview.threads.map((t) => ({ ...t, resolved: false })),
				mergeable: "UNKNOWN",
				asOf: "2026-09-15T11:35:52Z",
			}),
		});
		const marker = await screen.findByTestId("as-of");
		expect(marker).toHaveTextContent(/^as of 2026 Sep 15, \d\d:35:52 /);
		marker.focus();
		expect(
			await screen.findByText(/Thread resolution and merge conflicts/, {
				selector: "[role=tooltip]",
			}),
		).toBeVisible();
		const humans = screen.getByRole("region", { name: "Human reviews" });
		expect(
			within(humans).getByRole("list", { name: "Thread counts" }),
		).toHaveTextContent("5 unresolved0 resolved");
		const resolved = within(humans).getByRole("button", { name: "0 resolved" });
		resolved.focus();
		expect(
			await screen.findByRole("tooltip", { name: /Resolution history/ }),
		).toBeVisible();
		expect(resolved).toHaveAccessibleDescription(
			/Resolution history isn't known/,
		);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("has no as-of marker normally", async () => {
		renderApp();
		await screen.findByRole("heading", { level: 1 });
		expect(screen.queryByTestId("as-of")).toBeNull();
	});

	it("shows review progress on the Review files button", async () => {
		renderApp();
		const link = await screen.findByRole("link", { name: /Review files/ });
		expect(await within(link).findByText(/2 \/ 5/)).toBeInTheDocument();
		expect(link).toHaveAttribute("href", "/files");
	});
});

describe("compactProgress", () => {
	it("fades the compact title in over the last stretch before sticking", () => {
		expect(compactProgress(COMPACT_RAMP + 10, false)).toBe(0);
		expect(compactProgress(COMPACT_RAMP, false)).toBe(0);
		expect(compactProgress(COMPACT_RAMP / 2, false)).toBe(0.5);
		expect(compactProgress(0, false)).toBe(1);
		expect(compactProgress(-5, false)).toBe(1);
	});

	it("skips the ramp under reduced motion", () => {
		expect(compactProgress(COMPACT_RAMP / 2, true)).toBe(0);
		expect(compactProgress(0, true)).toBe(1);
	});
});

describe("App header", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("offers the title again as a back-to-top button, inert until stuck", async () => {
		renderApp();
		await screen.findByRole("heading", { level: 1 });
		// jsdom has no layout: never stuck, so it is out of reach.
		const compact = screen.getByTestId("compact-title");
		expect(compact).toHaveAttribute("inert");
		expect(compact).toHaveAccessibleName("Back to top: Add widget cache #12");
	});
});
