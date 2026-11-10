// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeFromHunk } from "../../test/code-window";
import { suggestionHtml } from "../../test/fake-gh/scenario";
import { expectLoadingThen, heldJson } from "../../test/loading";
import type {
	CodeWindow,
	PrOverview,
	ReviewThread,
	ReviewView,
	SessionInfo,
	TimelineView,
} from "../shared/types";
import { COMPACT_RAMP, compactNumberHideClass, compactProgress } from "./App";
import { resetShowInvisibles, setShowInvisibles } from "./code/Invisibles";
import { findFloat, findState } from "./files/find/findState";
import { createAppRouter } from "./router";
import { draftsFor } from "./threads/drafts";

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
	pinnedHead: null,
};

/** An overview and its threads, as the page gets them from two routes. */
type OverviewFixture = PrOverview & { threads: ReviewThread[] };

const overview: OverviewFixture = {
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
	youAuthor: false,
	writes: "on",
	commentLeft: true,
	pendingReview: null,
	readId: "read1",
	// Just read: the page doesn't read it again.
	fetchedAt: "2026-01-05T12:00:00Z",
	servedAt: "2026-01-05T12:00:01Z",
	checks: [
		{ name: "lint", status: "failing", url: "https://ci.example/lint" },
		{ name: "deploy/preview", status: "pending", url: "javascript:alert(1)" },
		{ name: "build", status: "passing" },
	],
	threads: [
		{
			id: "T-old",
			loaded: true,
			path: "src/old.ts",
			line: null,
			currentLine: null,
			excerpt: "Coverage dropped",
			html: '<p dir="auto">Coverage <em>dropped</em> by 2%</p>',
			body: "",
			createdAt: "2026-01-02T12:00:00Z",
			author: "ci-bot",
			bot: true,
			avatarUrl: "",
			participants: [],
			commentCount: 1,
			hasReply: false,
			outdated: true,
			lastActivityAt: "2026-01-02T12:00:00Z",
			resolved: false,
			anchor: null,
			attention: [],
			yourTurn: false,
			viewerCan: { reply: true, resolve: true, unresolve: true },
			commit: "",
			subject: "line",
			code: null,
		},
		{
			id: "T-cache",
			loaded: true,
			path: "src/cache.ts",
			line: 42,
			currentLine: 42,
			excerpt: "Should this expire?",
			html: '<p dir="auto">Should this <strong>expire</strong>?</p>',
			body: "",
			createdAt: "2026-01-03T09:00:00Z",
			author: "rev1",
			bot: false,
			avatarUrl: "",
			participants: [],
			commentCount: 3,
			hasReply: true,
			outdated: false,
			lastActivityAt: "2026-01-03T11:00:00Z",
			resolved: false,
			anchor: null,
			attention: [],
			yourTurn: false,
			viewerCan: { reply: true, resolve: true, unresolve: true },
			commit: "",
			subject: "line",
			code: codeFromHunk(
				"@@ -40,2 +40,3 @@ class Cache {\n   get() {}\n-  old() {}\n+  set() {}\n+  ttl = 5;",
				{ path: "src/cache.ts", line: 42 },
			),
		},
		...[1, 2, 3, 4].map((i) =>
			humanThread(`src/done${i}.ts`, { resolved: true }),
		),
	],
};

function humanThread(
	path: string,
	extra: Partial<ReviewThread> = {},
): ReviewThread {
	return {
		id: path,
		loaded: true,
		path,
		line: 1,
		currentLine: 1,
		excerpt: path,
		html: `<p>${path}</p>`,
		body: "",
		createdAt: "2026-01-01T09:00:00Z",
		lastActivityAt: "2026-01-01T09:00:00Z",
		author: "rev2",
		bot: false,
		avatarUrl: "",
		participants: [],
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		anchor: null,
		attention: [],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: true },
		commit: "",
		subject: "line",
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
/** A route's body that never comes. */
const NEVER = Symbol("never");

let fetchMock: ReturnType<typeof mockApi>;

function mockApi(routes: Routes) {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, _init?: RequestInit) => {
			const path = apiPath(input);
			const route = routes[path];
			if (!route) return new Response("{}", { status: 404 });
			if (route.body === NEVER) return new Promise<Response>(() => {});
			// Held (test/loading.ts): answered when the test lets it go.
			if (route.body instanceof Promise) return route.body as Promise<Response>;
			return new Response(JSON.stringify(route.body), { status: route.status });
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	// jsdom lacks scrolling; the router restores scroll on navigation.
	vi.stubGlobal("scrollTo", vi.fn());
	return fetchMock;
}

const ok = (body: unknown) => ({ status: 200, body });

/**
 * The page's routes: an overview fixture's threads are served apart, as
 * the server does (every stage at once, complete), unless a test gives
 * `/api/threads` itself.
 */
/** The review the tests show (its page is /r/<ID>). */
const ID = "01testreview0000000000000a";

/** A request's path, its review's routes as `/api/<x>`. */
const apiPath = (input: RequestInfo | URL) => {
	const path = new URL(String(input), "http://test").pathname;
	const review = `/api/r/${ID}/`;
	if (path.startsWith("/api/r/") && !path.startsWith(review)) {
		throw new Error(`A request for another review: ${path}`);
	}
	return path.replace(review, "/api/");
};

/** A request's URL, its review's routes as `/api/<x>`. */
const local = (input: RequestInfo | URL) =>
	String(input).replace(`/api/r/${ID}/`, "/api/");

/** Where a review page of the tests' review is. */
const at = (page: "/" | "/files") => ({
	to: page === "/" ? ("/r/$id" as const) : ("/r/$id/files" as const),
	params: { id: ID },
});

function renderApp(routes: Partial<Routes> = {}, path = "/") {
	path = `/r/${ID}${path === "/" ? "" : path.startsWith("/?") ? path.slice(1) : path}`;
	const all = {
		"/api/session": ok(info),
		"/api/overview": ok(overview),
		"/api/review": ok(review),
		"/api/timeline": ok({ events: [], gaps: [] }),
		...routes,
	} as Routes;
	const shown = all["/api/overview"];
	const body = shown?.body as Partial<OverviewFixture> | undefined;
	if (body && typeof body === "object" && "threads" in body) {
		const { threads, ...rest } = body;
		all["/api/overview"] = { status: shown?.status ?? 200, body: rest };
		all["/api/threads"] ??= ok({ threads, complete: true });
	}
	fetchMock = mockApi(all);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const router = createAppRouter({ initialPath: path });
	const view = render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { ...view, router, client: queryClient };
}

const calls = (path: string) =>
	fetchMock.mock.calls.filter(([input]) => local(input) === path).length;

/**
 * Files changed's code, loaded: the router waits for it (a lazy route) before
 * it shows the page. Run alone, a test is the first to import it, which can
 * take longer than a findBy waits on a loaded machine; awaiting it first
 * makes the test wait for the code itself, not race it.
 */
const filesPageLoaded = () => import("./files/FilesPage");

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
		await router.navigate(at("/files"));
		await screen.findByRole("region", { name: "Files changed" });
		await router.navigate(at("/"));
		await screen.findByRole("region", { name: "What it does" });
		expect(calls("/api/overview")).toBe(1);
		expect(calls("/api/session")).toBe(1);
	});

	it("keeps a visited page mounted, hidden and inert, while the other shows", async () => {
		const { router } = renderApp();
		const what = await screen.findByRole("region", { name: "What it does" });
		await router.navigate(at("/files"));
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
		await router.navigate(at("/"));
		// The same elements come back: nothing remounted.
		expect(await screen.findByRole("region", { name: "What it does" })).toBe(
			what,
		);
		expect(files.closest("[data-page]")).toHaveAttribute("hidden");
		expect(screen.queryByRole("region", { name: "Files changed" })).toBeNull();
		await router.navigate(at("/files"));
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

	it("the logo links Home", async () => {
		const user = userEvent.setup();
		const { router } = renderApp();
		// The full header's logo (the compact row's mark links Home too).
		const home = await screen.findByTestId("home-link");
		expect(home).toHaveAccessibleName("Home");
		expect(home).toHaveAttribute("href", "/");
		await user.click(home);
		await waitFor(() => expect(router.state.location.pathname).toBe("/"));
		expect(screen.queryByRole("region", { name: "What it does" })).toBeNull();
	});

	it("an unknown review is the not-found page, with the way Home", async () => {
		renderApp({
			"/api/session": {
				status: 404,
				body: { error: "No review x", code: "unknown-review" },
			},
		});
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"No such review.",
		);
		expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("a review its PR now refuses says why, with the way Home", async () => {
		renderApp({
			"/api/session": {
				status: 409,
				body: {
					error: "PR acme/widget#12 is already merged; nothing to review",
					code: "refused",
				},
			},
		});
		expect(await screen.findByTestId("not-found")).toHaveTextContent(
			"PR acme/widget#12 is already merged; nothing to review",
		);
		expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("still asks before leaving with a draft storage can't keep once Home shows", async () => {
		const user = userEvent.setup();
		const { client, router } = renderApp();
		await screen.findByRole("region", { name: "What it does" });
		// A draft in storage needs no asking (useUnsavedGuard): storage fails.
		const setItem = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("quota");
			});
		try {
			act(() => draftsFor(client).setText("T-cache", "Half a thought"));
			await user.click(screen.getByTestId("home-link"));
			await waitFor(() => expect(router.state.location.pathname).toBe("/"));
			const ask = new Event("beforeunload", { cancelable: true });
			window.dispatchEvent(ask);
			expect(ask.defaultPrevented).toBe(true);
		} finally {
			setItem.mockRestore();
			// Gone again before the next test.
			act(() => draftsFor(client).setText("T-cache", ""));
		}
	});

	it("shows no kept page on an unknown path", async () => {
		const { router } = renderApp();
		await screen.findByRole("region", { name: "What it does" });
		await router.navigate({ to: `/r/${ID}/nope` as "/" });
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
		const banner = await screen.findByText(/New commits were pushed/);
		expect(banner.closest('[role="status"]')).not.toBeNull();
	});

	it("shows no banner, and no error, when the head check fails", async () => {
		renderApp({
			"/api/head": { status: 502, body: { error: "gh is down" } },
		});
		await screen.findByRole("heading", { level: 1 });
		await waitFor(() => expect(calls("/api/head")).toBe(1));
		expect(screen.queryByText(/New commits were pushed/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("has a Find in PR button that opens the bar on Files changed and goes there from the overview", async () => {
		findState.reset();
		await filesPageLoaded();
		const user = userEvent.setup();
		const { router } = renderApp();
		await screen.findByRole("region", { name: "What it does" });
		const button = screen.getByRole("button", { name: "Find in PR" });
		// Here it goes to Files changed: nothing expands.
		expect(button).not.toHaveAttribute("aria-expanded");
		await user.click(button);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/r/${ID}/files`),
		);
		expect(findState.get().open).toBe(true);
		expect(await screen.findByTestId("find-bar")).toBeInTheDocument();
		await waitFor(() =>
			expect(button).toHaveAttribute("aria-expanded", "true"),
		);
		// On Files changed, a second click closes it.
		await user.click(button);
		expect(findState.get().open).toBe(false);
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("find-bar")).toBeNull();
		findState.reset();
	});

	it("leaving Files changed closes Find in PR and clears its term; coming back starts closed", async () => {
		findState.reset();
		await filesPageLoaded();
		const user = userEvent.setup();
		const { router } = renderApp({}, "/files");
		const button = await screen.findByRole("button", { name: "Find in PR" });
		await user.click(button);
		const box = await screen.findByTestId("find-box");
		await user.type(box, "save");
		expect(findState.get().term).toBe("save");
		await router.navigate({ to: `/r/${ID}` as "/" });
		await screen.findByRole("region", { name: "What it does" });
		await waitFor(() => expect(findState.get().open).toBe(false));
		expect(findState.get().term).toBe("");
		await router.navigate({ to: `/r/${ID}/files` as "/" });
		await waitFor(() =>
			expect(button).toHaveAttribute("aria-expanded", "false"),
		);
		expect(screen.queryByTestId("find-bar")).toBeNull();
		await user.click(button);
		expect(await screen.findByTestId("find-box")).toHaveValue("");
		findState.reset();
	});

	it("leaving the review (Home) closes Find in PR and clears its term", async () => {
		findState.reset();
		await filesPageLoaded();
		const user = userEvent.setup();
		const { unmount } = renderApp({}, "/files");
		await user.click(await screen.findByRole("button", { name: "Find in PR" }));
		await user.type(await screen.findByTestId("find-box"), "save");
		unmount();
		expect(findState.get()).toMatchObject({ open: false, term: "" });
	});

	it("on a phone the open find bar takes the app header out of the layout; closing it brings the header back, focus on its Find button", async () => {
		findState.reset();
		await filesPageLoaded();
		vi.stubGlobal(
			"matchMedia",
			(query: string) =>
				({
					matches: false,
					media: query,
					addEventListener: () => {},
					removeEventListener: () => {},
				}) as unknown as MediaQueryList,
		);
		try {
			const user = userEvent.setup();
			renderApp({}, "/files");
			const button = await screen.findByRole("button", { name: "Find in PR" });
			const header = document.querySelector("[data-app-header]") as HTMLElement;
			expect(header).toBeVisible();
			await user.click(button);
			await screen.findByTestId("find-bar");
			expect(header).not.toBeVisible();
			expect(header).toHaveAttribute("hidden");
			await user.click(screen.getByRole("button", { name: "Close (Esc)" }));
			expect(screen.queryByTestId("find-bar")).toBeNull();
			expect(header).toBeVisible();
			expect(header).not.toHaveAttribute("hidden");
			expect(button).toHaveFocus();
		} finally {
			findState.reset();
		}
	});

	it("the find bar stays out of the slot while Files changed is kept but hidden (find open on another page)", async () => {
		findState.reset();
		await filesPageLoaded();
		const { router } = renderApp({}, "/files");
		await screen.findByRole("progressbar", { name: "Review progress" });
		await router.navigate({ to: `/r/${ID}` as "/" });
		await screen.findByRole("region", { name: "What it does" });
		// Opened here (the header's button opens, then goes to Files changed).
		act(() => findState.open());
		const slot = document.querySelector("[data-find-slot]") as HTMLElement;
		expect(slot.childElementCount).toBe(0);
		expect(findFloat.get()).toBe(false);
		await router.navigate({ to: `/r/${ID}/files` as "/" });
		await waitFor(() => expect(slot.childElementCount).toBe(1));
		expect(findFloat.get()).toBe(true);
		findState.reset();
	});

	it("on a wide screen the open find bar goes in the slot above the app header, which stays", async () => {
		findState.reset();
		await filesPageLoaded();
		const user = userEvent.setup();
		renderApp({}, "/files");
		const button = await screen.findByRole("button", { name: "Find in PR" });
		await user.click(button);
		const bar = await screen.findByTestId("find-bar");
		const header = document.querySelector("[data-app-header]") as HTMLElement;
		expect(header).toBeVisible();
		expect(header).not.toHaveAttribute("hidden");
		const slot = bar.closest("[data-find-slot]") as HTMLElement;
		expect(slot).not.toBeNull();
		expect(
			slot.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		findState.reset();
	});

	it("has a Settings gear in the app bar whose switch shows hidden characters", async () => {
		const user = userEvent.setup();
		renderApp();
		const row = await screen.findByTestId("app-header-row");
		const gear = within(row).getByRole("button", { name: "Settings" });
		expect(gear).toHaveAttribute("aria-expanded", "false");
		await user.click(gear);
		expect(gear).toHaveAttribute("aria-expanded", "true");
		const dialog = screen.getByRole("dialog", { name: "Settings" });
		const toggle = within(dialog).getByRole("switch", {
			name: "Show hidden characters",
		});
		expect(toggle).toHaveAttribute("aria-checked", "true");
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const code = within(humans).getByRole("figure", {
			name: "Code at src/cache.ts",
		});
		await waitFor(() =>
			expect(code.querySelectorAll("[data-inv]").length).toBeGreaterThan(0),
		);
		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await waitFor(() =>
			expect(code.querySelectorAll("[data-inv]")).toHaveLength(0),
		);
		// Escape closes it, focus back on the gear.
		await user.keyboard("{Escape}");
		expect(gear).toHaveAttribute("aria-expanded", "false");
		expect(gear).toHaveFocus();
		act(() => setShowInvisibles(true));
	});

	it("closes the Settings popover when focus leaves it, and on Escape from anywhere", async () => {
		const user = userEvent.setup();
		renderApp();
		const gear = await within(
			await screen.findByTestId("app-header-row"),
		).findByRole("button", { name: "Settings" });
		await user.click(gear);
		expect(gear).toHaveAttribute("aria-expanded", "true");
		// Focus moves on through the three switches and the shortcuts
		// entry, then out of the popover.
		await user.tab();
		expect(gear).toHaveAttribute("aria-expanded", "true");
		await user.tab();
		expect(gear).toHaveAttribute("aria-expanded", "true");
		await user.tab();
		expect(gear).toHaveAttribute("aria-expanded", "true");
		await user.tab();
		expect(gear).toHaveAttribute("aria-expanded", "false");
		await user.click(gear);
		expect(gear).toHaveAttribute("aria-expanded", "true");
		act(() => (document.activeElement as HTMLElement | null)?.blur());
		await user.keyboard("{Escape}");
		expect(gear).toHaveAttribute("aria-expanded", "false");
		expect(gear).toHaveFocus();
	});

	it("while the PR loads, the header is a frame with a spinner, never blank", async () => {
		const session = heldJson();
		renderApp({ "/api/session": { status: 200, body: session.response } });
		await expectLoadingThen({
			loading: () => screen.queryByRole("status", { name: "Loading the PR" }),
			empty: [() => screen.queryByText("Loading…")],
			release: () => session.release(info),
			result: () =>
				screen.queryByRole("heading", { level: 1, name: "Add widget cache" }),
		});
		expect(screen.queryByTestId("header-loading")).toBeNull();
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
		resetShowInvisibles();
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

	describe("a long description folds", () => {
		afterEach(() => vi.restoreAllMocks());
		/** jsdom has no layout: the description is `tall` px, clipped at 280. */
		const heights = (tall: number) => {
			const desc = (el: HTMLElement) => el.dataset.testid === "description";
			vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					return desc(this) ? tall : 0;
				},
			);
			vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
				function (this: HTMLElement) {
					return desc(this) ? Math.min(tall, 280) : 0;
				},
			);
		};

		it("over the height: clipped, faded, Show more and Show less, its text always there", async () => {
			heights(900);
			const user = userEvent.setup();
			renderApp();
			const what = await screen.findByRole("region", { name: "What it does" });
			const body = within(what).getByTestId("description");
			expect(body).toHaveClass("max-h-[17.5rem]", "overflow-hidden");
			const more = await within(what).findByRole("button", {
				name: "Show more",
			});
			expect(more).toHaveAttribute("aria-expanded", "false");
			expect(more).toHaveAttribute("aria-controls", body.id);
			// Clipped, still in the DOM (screen readers, find in page).
			expect(within(body).getByText("widgets")).toBeInTheDocument();
			await user.click(more);
			expect(body).not.toHaveClass("max-h-[17.5rem]");
			const less = within(what).getByRole("button", { name: "Show less" });
			expect(less).toHaveAttribute("aria-expanded", "true");
			await user.click(less);
			expect(body).toHaveClass("max-h-[17.5rem]");
		});

		it("a keyboard user landing on a clipped link opens it", async () => {
			heights(900);
			renderApp();
			const what = await screen.findByRole("region", { name: "What it does" });
			await within(what).findByRole("button", { name: "Show more" });
			const body = within(what).getByTestId("description");
			act(() => {
				body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
			});
			expect(
				within(what).getByRole("button", { name: "Show less" }),
			).toHaveAttribute("aria-expanded", "true");
		});

		it("under the height: whole, no toggle", async () => {
			heights(200);
			renderApp();
			const what = await screen.findByRole("region", { name: "What it does" });
			expect(within(what).getByText("widgets")).toBeInTheDocument();
			expect(
				within(what).queryByRole("button", { name: /Show (more|less)/ }),
			).toBeNull();
		});
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
		// The viewer commented and has progress: they're on it too.
		expect(who).toHaveTextContent("You and rev1 are reviewing");
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

	describe("who started reviewing, the viewer included", () => {
		const untouched: ReviewView = {
			...review,
			progress: {
				clusters: counts(6, 0, 0),
				lines: counts(40, 0, 0),
				files: { ...counts(3, 0, 0), done: 0 },
			},
		};
		const alone = {
			...overview,
			reviews: [],
			commenters: [],
			requestedReviewers: [],
			humanStarted: false,
		};
		const yourReview = {
			author: "octo",
			state: "COMMENTED" as const,
			submittedAt: "2026-01-04T09:30:00Z",
			you: true,
			bot: false,
		};
		const yourComment = {
			author: "octo",
			lastAt: "2026-01-04T10:00:00Z",
			bot: false,
			you: true,
		};
		// The Review files button shows progress once the review data is in.
		const reviewLoaded = () => screen.findByText(/clusters ·/);
		const line = async () => {
			const who = await screen.findByRole("region", { name: "Who's on it" });
			const p = who.querySelector("p");
			if (!p) throw new Error("no line");
			return p;
		};

		it("says when no one else has started", async () => {
			renderApp({
				"/api/overview": ok(alone),
				"/api/review": ok(untouched),
			});
			const p = await line();
			await reviewLoaded();
			expect(p).toHaveTextContent(/^No one else has started reviewing$/);
		});

		it("doesn't count the author's own reviews and comments", async () => {
			renderApp({
				"/api/overview": ok({
					...alone,
					author: "octo",
					youAuthor: true,
					reviews: [yourReview],
					commenters: [yourComment],
				}),
				"/api/review": ok(untouched),
			});
			const p = await line();
			await reviewLoaded();
			expect(p).toHaveTextContent(/^No one else has started reviewing$/);
		});

		it("counts the author's progress here", async () => {
			renderApp({
				"/api/overview": ok({
					...alone,
					author: "octo",
					youAuthor: true,
					commenters: [yourComment],
				}),
				"/api/review": ok(review),
			});
			const p = await line();
			await waitFor(() =>
				expect(p).toHaveTextContent(/^You're reviewing this change$/),
			);
		});

		it("names the others when the viewer isn't reviewing", async () => {
			renderApp({
				"/api/overview": ok({
					...overview,
					commenters: overview.commenters.filter((c) => !c.you),
				}),
				"/api/review": ok(untouched),
			});
			const p = await line();
			await reviewLoaded();
			expect(p).toHaveTextContent(/^rev1 already started$/);
			expect(p.querySelector("svg")).toHaveClass("text-warn");
		});

		it.each([
			["a GitHub review", { reviews: [yourReview] }, untouched],
			["a comment", { commenters: [yourComment] }, untouched],
			["reviewed clusters", {}, review],
			[
				"crossed-off clusters only",
				{},
				{
					...untouched,
					progress: {
						...untouched.progress,
						clusters: counts(6, 0, 1),
					},
				},
			],
		])("says you're reviewing after %s", async (_, gh, data) => {
			renderApp({
				"/api/overview": ok({ ...alone, ...gh }),
				"/api/review": ok(data),
			});
			const p = await line();
			await waitFor(() =>
				expect(p).toHaveTextContent(/^You're reviewing this change$/),
			);
			expect(p.querySelector("svg")).toHaveClass("text-ok");
		});

		it("falls back to GitHub while the review data loads", async () => {
			renderApp({
				"/api/overview": ok({ ...alone, commenters: [yourComment] }),
				"/api/review": { status: 200, body: NEVER },
			});
			expect(await line()).toHaveTextContent(/^You're reviewing this change$/);
			cleanup();
			renderApp({
				"/api/overview": ok(alone),
				"/api/review": { status: 200, body: NEVER },
			});
			expect(await line()).toHaveTextContent(
				/^No one else has started reviewing$/,
			);
		});

		it("says you and the others are reviewing, in the warn tone", async () => {
			renderApp({ "/api/review": ok(untouched) });
			const p = await line();
			expect(p).toHaveTextContent(/^You and rev1 are reviewing$/);
			expect(p.querySelector("svg")).toHaveClass("text-warn");
		});

		it("says someone else when the others' names are unknown", async () => {
			renderApp({
				"/api/overview": ok({ ...alone, humanStarted: true }),
				"/api/review": ok(review),
			});
			const p = await line();
			await waitFor(() =>
				expect(p).toHaveTextContent(/^You and someone else are reviewing$/),
			);
		});
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
		// Header: status, opener, opened and last active (the sort key).
		const head = within(human).getByTestId("thread-head");
		expect(head).toHaveTextContent(
			/^Unresolved thread by rev1\s*opened\s.+updated\s/,
		);
		expect(
			Array.from(head.querySelectorAll("time")).map((t) =>
				t.getAttribute("dateTime"),
			),
		).toEqual(["2026-01-03T09:00:00Z", "2026-01-03T11:00:00Z"]);
		// file:line below the header links to that line in Files changed.
		const place = within(human).getByRole("link", { name: "src/cache.ts:42" });
		expect(place).toHaveAttribute(
			"href",
			expect.stringMatching(
				new RegExp(
					`^/r/${ID}/files\\?path=src%2Fcache\\.ts&line=42&side=RIGHT`,
				),
			),
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

	it("unresolved and resolved are one two-way choice, either way", async () => {
		const user = userEvent.setup();
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const choice = within(humans).getByRole("radiogroup", {
			name: "Threads shown",
		});
		const open = within(choice).getByRole("radio", { name: "1 unresolved" });
		const done = within(choice).getByRole("radio", { name: "4 resolved" });
		const listId = within(humans).getByRole("list", {
			name: "Unresolved threads",
		}).parentElement?.id;
		expect(listId).toBeTruthy();
		for (const r of [open, done]) {
			expect(r).toHaveAttribute("aria-controls", listId);
		}
		expect(open).toBeChecked();
		expect(done).not.toBeChecked();
		await user.click(done);
		expect(done).toBeChecked();
		expect(open).not.toBeChecked();
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
		// Resolved threads need no reply.
		expect(list).not.toHaveTextContent("no reply");
		// Clicking the chosen side again keeps it.
		await user.click(done);
		expect(done).toBeChecked();
		// The other side brings its list back.
		await user.click(open);
		expect(open).toBeChecked();
		expect(within(humans).getAllByTestId("thread")).toHaveLength(1);
		// Nothing resolved: still chosen, and says so.
		const bots = screen.getByRole("region", { name: "Bot reviews" });
		const none = within(bots).getByRole("radio", { name: "0 resolved" });
		expect(none).not.toHaveAttribute("aria-disabled");
		await user.click(none);
		expect(none).toBeChecked();
		expect(within(bots).queryAllByTestId("thread")).toHaveLength(0);
		expect(bots).toHaveTextContent("No resolved threads");
		await user.click(within(bots).getByRole("radio", { name: "1 unresolved" }));
		expect(within(bots).getAllByTestId("thread")).toHaveLength(1);
	});

	it("keyboard: arrows move between the two sides", async () => {
		const user = userEvent.setup();
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const open = within(humans).getByRole("radio", { name: "1 unresolved" });
		open.focus();
		await user.keyboard("{ArrowRight}");
		expect(
			within(humans).getByRole("radio", { name: "4 resolved" }),
		).toBeChecked();
		expect(
			within(humans).getByRole("list", { name: "Resolved threads" }),
		).toBeInTheDocument();
		await user.keyboard("{ArrowLeft}");
		expect(open).toBeChecked();
	});

	it("with only resolved threads, shows 0 unresolved, chosen, and either side works", async () => {
		const user = userEvent.setup();
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [humanThread("src/r.ts", { resolved: true })],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		expect(humans).toHaveTextContent("No unresolved threads");
		const open = within(humans).getByRole("radio", { name: "0 unresolved" });
		expect(open).toBeChecked();
		const done = within(humans).getByRole("radio", { name: "1 resolved" });
		await user.click(done);
		expect(within(humans).getAllByTestId("thread")).toHaveLength(1);
		await user.click(open);
		expect(open).toBeChecked();
		expect(humans).toHaveTextContent("No unresolved threads");
	});

	it("lists five threads at a time; Load more adds five; switching starts over", async () => {
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
		const more = within(humans).getByRole("button", { name: /^Load / });
		expect(more).toHaveTextContent("Load 5 more comments out of 7");
		// Its own button under the list (not a list item), led by a chevron.
		expect(more.closest("ul")).toBeNull();
		expect(more.querySelector("svg[aria-hidden]")).not.toBeNull();
		await user.click(more);
		expect(shown()).toHaveLength(10);
		expect(more).toHaveTextContent("Load 2 more comments out of 2");
		await user.click(more);
		expect(shown()).toHaveLength(12);
		expect(within(humans).queryByRole("button", { name: /^Load / })).toBeNull();
		await user.click(within(humans).getByRole("radio", { name: "7 resolved" }));
		expect(shown()).toEqual([0, 1, 2, 3, 4].map((i) => `src/r${i}.ts:1`));
		await user.click(
			within(humans).getByRole("button", {
				name: "Load 2 more comments out of 2",
			}),
		);
		expect(shown()).toHaveLength(7);
		await user.click(
			within(humans).getByRole("radio", { name: "12 unresolved" }),
		);
		expect(shown()).toHaveLength(5);
		await user.click(within(humans).getByRole("radio", { name: "7 resolved" }));
		expect(shown()).toHaveLength(5);
	});

	it("draws suggested changes as mini diffs, and GitHub's HTML when they don't line up", async () => {
		const code = codeFromHunk(
			"@@ -40,2 +40,3 @@ class Cache {\n   get() {}\n-  old() {}\n+  set() {}\n+  ttl = 5;",
			{ path: "src/cache.ts", startLine: 41, line: 42 },
		);
		const html = [
			'<p dir="auto">Use:</p>',
			suggestionHtml(
				["  set() {}", "  ttl = 5;"],
				["  set(v) {}", "  ttl = 10;"],
			),
			'<p dir="auto">or drop them:</p>',
			suggestionHtml(["  set() {}", "  ttl = 5;"], []),
		].join("\n");
		const body =
			"Use:\r\n```suggestion\r\n  set(v) {}\r\n  ttl = 10;\r\n```\r\nor drop them:\r\n```suggestion\r\n```";
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					humanThread("src/cache.ts", { line: 42, code, html, body }),
					humanThread("src/other.ts", {
						code,
						// GitHub's block replaces other lines than the thread's.
						html: suggestionHtml(["something else"], ["x"]),
						body: "```suggestion\nx\n```",
						createdAt: "2026-01-01T08:00:00Z",
						lastActivityAt: "2026-01-01T08:00:00Z",
					}),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const [first, second] = within(humans).getAllByTestId("thread");
		if (!first || !second) throw new Error("two threads");
		const blocks = within(first).getAllByRole("figure", {
			name: "Suggested change",
		});
		expect(blocks).toHaveLength(2);
		const rows = (block: HTMLElement) =>
			within(block)
				.getAllByTestId("suggestion-line")
				.map((r) => r.textContent?.replace(/\s+/g, " ").trim());
		expect(rows(blocks[0] as HTMLElement)).toEqual([
			"41− set() {}",
			"42− ttl = 5;",
			"41+ set(v) {}",
			"42+ ttl = 10;",
		]);
		// An empty suggestion deletes the lines.
		expect(rows(blocks[1] as HTMLElement)).toEqual([
			"41− set() {}",
			"42− ttl = 5;",
		]);
		expect(first).toHaveTextContent("or drop them:");
		expect(within(first).queryByRole("button", { name: /apply/i })).toBeNull();
		// Not the thread's lines: GitHub's HTML as is, nothing dropped.
		expect(
			within(second).queryByRole("figure", { name: "Suggested change" }),
		).toBeNull();
		expect(within(second).getByTestId("thread-body")).toHaveTextContent(
			/Suggested change\s*something else\s*x/,
		);
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

	it("shows the rows around the commented range, before and after it, and where they came from", async () => {
		const code = codeFromHunk(
			"@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g",
			{ path: "src/ctx.ts", line: 4 },
		);
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [humanThread("src/ctx.ts", { line: 4, code })],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const pane = within(humans).getByRole("figure", {
			name: "Code at src/ctx.ts",
		});
		expect(pane).toHaveAttribute("data-source", "clone");
		const rows = within(pane).getAllByTestId("thread-code-line");
		expect(rows.map((r) => r.textContent?.replace(/\s+/g, " "))).toEqual([
			"22 b",
			"33 c",
			"4−d",
			"4+D",
			"55 e",
			"66 f",
			"77 g",
		]);
		expect(rows.map((r) => r.hasAttribute("data-marked"))).toEqual([
			false,
			false,
			false,
			true,
			false,
			false,
			false,
		]);
		expect(within(humans).getByTestId("thread-place")).toHaveTextContent(
			"src/ctx.ts:4",
		);
	});

	it("flags code that can't be shown to be what the commenter saw with a red chip", async () => {
		const hunk = "@@ -1,2 +1,2 @@\n a\n-b\n+B";
		const anchor = {
			line: 2,
			commit: "0123456789abcdef0123456789abcdef01234567",
			at: "2026-01-01T09:00:00Z",
		};
		const thread = (
			path: string,
			snapshot: CodeWindow["snapshot"],
			source: CodeWindow["source"] = "clone",
		) =>
			humanThread(path, {
				line: 2,
				code: {
					...codeFromHunk(hunk, { ...anchor, path }, source),
					snapshot,
				},
			});
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					thread("src/same.ts", { same: true }),
					thread("src/differs.ts", { same: false, reason: "diff-differs" }),
					thread("src/unchecked.ts", { same: false, reason: "no-host-diff" }),
					// No verdict at all: flagged, never trusted.
					thread("src/unknown.ts", undefined),
					thread("src/github.ts", { same: true }, "github"),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = (path: string) =>
			within(humans)
				.getAllByTestId("thread")
				.find((t) => t.textContent?.includes(path)) as HTMLElement;
		const chip = (path: string) =>
			within(card(path)).queryByTestId("thread-snapshot");
		expect(
			await within(humans).findAllByTestId("thread-snapshot"),
		).toHaveLength(3);
		expect(chip("src/same.ts")).toBeNull();
		expect(chip("src/github.ts")).toBeNull();
		for (const path of [
			"src/differs.ts",
			"src/unchecked.ts",
			"src/unknown.ts",
		]) {
			const c = chip(path);
			expect(c).toHaveTextContent("different snapshot");
			// In the card's header, red, focusable for touch and keyboard.
			expect(within(card(path)).getByTestId("thread-head")).toContainElement(c);
			expect(c?.querySelector(".text-bad")).not.toBeNull();
			expect(c).toHaveAttribute("tabindex", "0");
		}
		expect(chip("src/differs.ts")).toHaveAccessibleDescription(
			/^Made on 0123456, .+ ago, in another diff; the code shown may differ from what the commenter saw\.$/,
		);
		expect(chip("src/unchecked.ts")).toHaveAccessibleDescription(
			/^Made on 0123456, .+ ago; GitHub kept no diff to check it against, so the code shown may differ from what the commenter saw\.$/,
		);
		// No verdict: nothing claimed about why.
		expect(chip("src/unknown.ts")).toHaveAccessibleDescription(
			/^Made on 0123456, .+ ago; the code shown may differ from what the commenter saw\.$/,
		);
		// Focus (a tap) shows it.
		const differs = chip("src/differs.ts") as HTMLElement;
		act(() => differs.focus());
		expect(screen.getByRole("tooltip")).toHaveTextContent("in another diff");
	});

	it("shows no snapshot chip while the code is on its way, or with no code", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					humanThread("src/pending.ts", {
						line: 2,
						code: {
							...codeFromHunk("@@ -1,1 +1,1 @@\n-a\n+b", { line: 1 }),
							rows: [],
							source: "pending",
							snapshot: undefined,
						},
					}),
					humanThread("src/none.ts"),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		await within(humans).findAllByTestId("thread");
		expect(within(humans).queryByTestId("thread-snapshot")).toBeNull();
	});

	it("the hidden-characters setting shows invisible characters in the code panes", async () => {
		renderApp();
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const code = within(humans).getByRole("figure", {
			name: "Code at src/cache.ts",
		});
		act(() => setShowInvisibles(true));
		await waitFor(() =>
			expect(code.querySelectorAll("[data-inv]").length).toBeGreaterThan(0),
		);
		act(() => setShowInvisibles(false));
		await waitFor(() =>
			expect(code.querySelectorAll("[data-inv]")).toHaveLength(0),
		);
	});

	it("numbers the header by the marked line, and says where a carried-forward comment is now", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					humanThread("src/moved.ts", {
						line: 9,
						currentLine: 3,
						// The range (9) isn't in GitHub's hunk: its last line is marked.
						code: codeFromHunk(
							"@@ -1,1 +1,2 @@\n a\n+b",
							{ line: 9 },
							"github",
						),
					}),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const place = within(humans).getByTestId("thread-place");
		expect(place).toHaveTextContent("src/moved.ts:2");
		place.focus();
		expect(
			await screen.findByRole("tooltip", { name: "Now at line 3" }),
		).toBeVisible();
	});

	it("numbers a fallen-back header on the comment's own side", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					humanThread("src/side.ts", {
						line: 9,
						currentLine: null,
						// The range (9) isn't in GitHub's hunk, whose last line is a deletion.
						code: codeFromHunk(
							"@@ -1,2 +1,2 @@\n+a\n b\n-c",
							{ line: 9 },
							"github",
						),
					}),
				],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		expect(
			within(humans).getByTestId("thread").querySelector("code"),
		).toHaveTextContent("src/side.ts:2");
	});

	it("lays out tabs in a code pane at the file's .editorconfig width", async () => {
		const tabbed = (path: string) =>
			humanThread(path, {
				code: codeFromHunk("@@ -1,0 +1,1 @@\n+\tx", { path, line: 1 }),
			});
		const file = (path: string, tabWidth?: number) =>
			({
				index: 0,
				path,
				status: "modified",
				binary: false,
				submodule: false,
				additions: 1,
				deletions: 0,
				...(tabWidth ? { tabWidth } : {}),
				clusters: [],
				done: false,
				reviewed: false,
				crossedOff: false,
			}) as ReviewView["files"][number];
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [tabbed("src/two.ts"), tabbed("src/default.ts")],
			}),
			"/api/review": ok({
				...review,
				files: [file("src/two.ts", 2), file("src/default.ts")],
			}),
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const tab = (path: string) =>
			within(humans)
				.getByRole("figure", { name: `Code at ${path}` })
				.querySelector<HTMLElement>('[data-inv="tab"]');
		await waitFor(() => expect(tab("src/two.ts")?.style.width).toBe("2ch"));
		expect(tab("src/default.ts")?.style.width).toBe("4ch");
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

	it("offers no toggle for a short thread with nothing to do on it", async () => {
		renderApp({ "/api/overview": ok({ ...overview, writes: "viewer" }) });
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
			renderApp({
				"/api/overview": ok({
					...overview,
					fetchedAt: "2026-01-05T18:00:00Z",
					servedAt: "2026-01-05T18:00:00Z",
				}),
			});
			const what = await screen.findByRole("region", {
				name: "What it does",
			});
			const img = () => within(what).getByAltText(":shipit:");
			// A read at most a minute old, so its signed URLs are fresh.
			const reads = () => calls("/api/overview?maxAge=60000");
			expect(calls("/api/overview")).toBe(1);
			// Breaking right after the read: not an expired URL, no refetch.
			img().dispatchEvent(new Event("error"));
			expect(reads()).toBe(0);
			vi.setSystemTime(new Date("2026-01-05T18:06:00Z"));
			img().dispatchEvent(new Event("error"));
			await waitFor(() => expect(reads()).toBe(1));
			// Throttled: more broken images within the minute don't refetch.
			vi.setSystemTime(new Date("2026-01-05T18:06:30Z"));
			img().dispatchEvent(new Event("error"));
			await new Promise((r) => setTimeout(r, 50));
			expect(reads()).toBe(1);
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

	/**
	 * An overview read ten minutes ago (by the server's clock, whatever this
	 * browser's says) and a re-read that waits for `gate`.
	 */
	const oldRead = () => {
		const served = "2026-01-05T12:10:00Z";
		renderApp({
			"/api/overview": ok({
				...overview,
				title: "Then",
				fetchedAt: "2026-01-05T12:00:00Z",
				servedAt: served,
			}),
		});
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const signals: AbortSignal[] = [];
		const routes = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (local(input) === "/api/overview?maxAge=15000") {
				if (init?.signal) signals.push(init.signal);
				await gate;
				init?.signal?.throwIfAborted();
				return new Response(
					JSON.stringify({
						...overview,
						title: "Now",
						readId: "read2",
						fetchedAt: served,
						servedAt: served,
					}),
				);
			}
			if (!routes) throw new Error("no mock");
			return routes(input, init);
		});
		return { release, signals };
	};

	it("shows an old kept overview at once and brings it up to date, Refresh spinning meanwhile", async () => {
		const { release } = oldRead();
		const what = await screen.findByRole("region", { name: "What it does" });
		expect(within(what).getByRole("heading", { level: 3 })).toHaveTextContent(
			"Then",
		);
		// Refresh shows the re-read (its icon spins) but stays a button to press.
		const refresh = await screen.findByRole("button", { name: "Refresh" });
		await waitFor(() => expect(refresh).toHaveAttribute("data-updating"));
		expect(refresh.querySelector("svg")).toHaveClass("animate-spin");
		expect(refresh).toBeEnabled();
		release();
		await waitFor(() =>
			expect(within(what).getByRole("heading", { level: 3 })).toHaveTextContent(
				"Now",
			),
		);
		expect(refresh).not.toHaveAttribute("data-updating");
		expect(calls("/api/overview?maxAge=15000")).toBe(1);
		// The new read's threads, all at once.
		expect(
			fetchMock.mock.calls.some(([i]) =>
				String(i).includes("read=read2&stage=full"),
			),
		).toBe(true);
	});

	it("swaps to a re-read without waiting for its timeline, the old one shown until it comes", async () => {
		const { release } = oldRead();
		const routes = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			const url = local(input);
			if (url.startsWith("/api/timeline")) {
				if (url.includes("read=read2")) return new Promise<Response>(() => {});
				return new Response(
					JSON.stringify({
						gaps: [],
						events: [
							{
								kind: "ready",
								actor: { login: "octo-author", avatarUrl: "", bot: false },
								at: "2026-01-02T09:00:00Z",
							},
						],
					}),
				);
			}
			if (!routes) throw new Error("no mock");
			return routes(input, init);
		});
		const section = await screen.findByRole("region", { name: "Timeline" });
		expect(await within(section).findByTestId("timeline-event")).toBeVisible();
		release();
		const what = screen.getByRole("region", { name: "What it does" });
		await waitFor(() =>
			expect(within(what).getByRole("heading", { level: 3 })).toHaveTextContent(
				"Now",
			),
		);
		// The new read's timeline is on its way: the old one stays, marked busy.
		const list = within(section).getByRole("list", { name: "Timeline events" });
		await waitFor(() => expect(list).toHaveAttribute("aria-busy", "true"));
		expect(within(list).getByTestId("timeline-event")).toBeVisible();
	});

	it("lets Refresh supersede a re-read that hangs: it cancels it and reads anew", async () => {
		const user = userEvent.setup();
		const { signals } = oldRead();
		const refresh = await screen.findByRole("button", { name: "Refresh" });
		await waitFor(() => expect(refresh).toHaveAttribute("data-updating"));
		await user.click(refresh);
		await waitFor(() => expect(signals[0]?.aborted).toBe(true));
		await waitFor(() => expect(calls("/api/refresh")).toBe(1));
	});

	it("doesn't read an overview again when it's young, or as of a cutoff", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				asOf: "2026-01-04T00:00:00Z",
				fetchedAt: "2026-01-04T00:00:00Z",
			}),
		});
		await screen.findByRole("region", { name: "What it does" });
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock.mock.calls.map(([i]) => String(i))).not.toContainEqual(
			expect.stringContaining("maxAge"),
		);
		cleanup();
		renderApp();
		await screen.findByRole("region", { name: "What it does" });
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock.mock.calls.map(([i]) => String(i))).not.toContainEqual(
			expect.stringContaining("maxAge"),
		);
	});

	it("shows the frame of each section while GitHub is read", async () => {
		renderApp({ "/api/overview": ok(NEVER) });
		expect(await screen.findByTestId("overview-loading")).toHaveTextContent(
			/What it does.*Who's on it.*Is it ready/,
		);
		expect(screen.queryByRole("region", { name: "What it does" })).toBeNull();
	});

	it("never waits for the threads: the rest shows, each thread list shows its frame", async () => {
		renderApp({ "/api/threads": ok(NEVER) });
		const what = await screen.findByRole("region", { name: "What it does" });
		expect(what).toHaveTextContent("Add widget cache");
		expect(screen.getByRole("region", { name: "Who's on it" })).toBeVisible();
		const ready = screen.getByRole("region", { name: "Is it ready" });
		expect(
			within(ready).getByRole("button", { name: /1 failing/ }),
		).toBeVisible();
		expect(within(ready).getAllByTestId("threads-loading")).toHaveLength(2);
		expect(within(ready).queryByTestId("thread")).toBeNull();
	});

	it("fills threads in as they come: headers from the summary, then the text, then the code", async () => {
		const full = overview.threads;
		// The summary: every thread, its text and code still on their way.
		const summary = full.map((t) => ({
			...t,
			loaded: false,
			excerpt: "",
			html: "",
			body: "",
			code: t.code && { ...t.code, rows: [], source: "pending" },
		}));
		renderApp({ "/api/threads": ok(NEVER) });
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const routes = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			const url = local(input);
			if (url.startsWith("/api/threads")) {
				if (url.includes("stage=summary")) {
					return new Response(
						JSON.stringify({ threads: summary, complete: false }),
					);
				}
				await gate;
				return new Response(JSON.stringify({ threads: full, complete: true }));
			}
			if (!routes) throw new Error("no mock");
			return routes(input, init);
		});
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		const card = await within(humans).findByTestId("thread");
		// The header and place are there, exact; the text and code are frames.
		expect(card).toHaveTextContent("rev1");
		expect(within(card).getByTestId("thread-place")).toHaveTextContent(
			"src/cache.ts:42",
		);
		expect(within(card).getByTestId("thread-body-loading")).toHaveTextContent(
			"Loading…",
		);
		expect(within(card).getByTestId("thread-code-loading")).toBeVisible();
		expect(within(humans).getByText("1 unresolved")).toBeVisible();
		release();
		expect(
			await within(humans).findByRole("figure", {
				name: "Code at src/cache.ts",
			}),
		).toBeVisible();
		expect(within(card).getByTestId("thread-body")).toHaveTextContent(
			"Should this expire?",
		);
		expect(within(card).queryByTestId("thread-body-loading")).toBeNull();
	});

	it("measures a code pane that arrives after its card: clipped, it takes focus to scroll", async () => {
		// The card renders first with the code's frame, then the pane mounts
		// in its place: its overflow must be measured then, not only at the
		// card's mount (an e2e race, overview.spec.ts "an opened long range").
		const pane = (el: HTMLElement) => el.tagName === "FIGURE";
		const scroll = vi
			.spyOn(HTMLElement.prototype, "scrollHeight", "get")
			.mockImplementation(function (this: HTMLElement) {
				return pane(this) ? 1200 : 0;
			});
		const client = vi
			.spyOn(HTMLElement.prototype, "clientHeight", "get")
			.mockImplementation(function (this: HTMLElement) {
				return pane(this) ? 158 : 0;
			});
		try {
			const full = overview.threads;
			const summary = full.map((t) => ({
				...t,
				code: t.code && { ...t.code, rows: [], source: "pending" },
			}));
			renderApp({ "/api/threads": ok(NEVER) });
			let release = () => {};
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const routes = fetchMock.getMockImplementation();
			fetchMock.mockImplementation(async (input, init) => {
				const url = local(input);
				if (url.startsWith("/api/threads")) {
					if (url.includes("stage=summary")) {
						return new Response(
							JSON.stringify({ threads: summary, complete: false }),
						);
					}
					await gate;
					return new Response(
						JSON.stringify({ threads: full, complete: true }),
					);
				}
				if (!routes) throw new Error("no mock");
				return routes(input, init);
			});
			const humans = await screen.findByRole("region", {
				name: "Human reviews",
			});
			const card = await within(humans).findByTestId("thread");
			expect(within(card).getByTestId("thread-code-loading")).toBeVisible();
			release();
			const code = await within(humans).findByRole("figure", {
				name: "Code at src/cache.ts",
			});
			await waitFor(() => expect(code).toHaveAttribute("tabindex", "0"));
		} finally {
			scroll.mockRestore();
			client.mockRestore();
		}
	});

	it("says when the threads couldn't be read, leaving no list busy forever", async () => {
		renderApp({ "/api/threads": { status: 502, body: { error: "gh broke" } } });
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		expect(await within(ready).findByText("gh broke")).toBeVisible();
		expect(within(ready).queryByTestId("threads-loading")).toBeNull();
		expect(ready.querySelector("[aria-busy]")).toBeNull();
	});

	it("says which threads' text will never come, on the card and over the list", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				threads: [
					humanThread("src/gone.ts", {
						unavailable: "deleted",
						excerpt: "",
						html: "",
						createdAt: "2026-01-01T09:00:00Z",
					}),
					humanThread("src/no-id.ts", {
						id: "",
						unavailable: "unreadable",
						excerpt: "",
						html: "",
						createdAt: "2026-01-01T08:00:00Z",
					}),
				],
			}),
		});
		const ready = await screen.findByRole("region", { name: "Is it ready" });
		const [gone, noId] = await within(ready).findAllByTestId(
			"thread-body-unavailable",
		);
		expect(gone).toHaveTextContent("Deleted on GitHub");
		expect(noId).toHaveTextContent("Couldn't be read from GitHub");
		expect(
			within(ready).getByText("1 thread couldn't be read from GitHub"),
		).toBeVisible();
		expect(within(ready).queryByTestId("thread-body-loading")).toBeNull();
	});

	it("keeps the previous read's threads in place, busy, until a Refresh's land", async () => {
		const user = userEvent.setup();
		renderApp({ "/api/refresh": ok(info) });
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		expect(await within(humans).findAllByTestId("thread")).not.toHaveLength(0);
		const routes = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			const url = local(input);
			if (url === "/api/overview") {
				const { threads: _, ...rest } = overview;
				return new Response(JSON.stringify({ ...rest, readId: "read2" }));
			}
			// The new read's threads take their time.
			if (url.includes("read=read2")) return new Promise<Response>(() => {});
			if (!routes) throw new Error("no mock");
			return routes(input, init);
		});
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(([i]) => String(i).includes("read=read2")),
			).toBe(true),
		);
		// Still the old cards, marked busy; no frames in their place.
		expect(within(humans).getAllByTestId("thread")).not.toHaveLength(0);
		expect(
			within(humans).getByRole("list", { name: "Unresolved threads" }),
		).toHaveAttribute("aria-busy", "true");
		expect(within(humans).queryByTestId("threads-loading")).toBeNull();
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
		const resolved = within(humans).getByRole("radio", { name: "0 resolved" });
		resolved.focus();
		expect(
			await screen.findByRole("tooltip", { name: /Resolution history/ }),
		).toBeVisible();
		expect(resolved).toHaveAccessibleDescription(
			/Resolution history isn't known/,
		);
		// Still a side to choose: it says none is resolved.
		await userEvent.setup().click(resolved);
		expect(resolved).toBeChecked();
		expect(humans).toHaveTextContent("No resolved threads");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("has no as-of marker normally", async () => {
		renderApp();
		await screen.findByRole("heading", { level: 1 });
		expect(screen.queryByTestId("as-of")).toBeNull();
	});

	it("while review progress loads, the Review files button spins, never 0 clusters", async () => {
		const progress = heldJson();
		renderApp({ "/api/review": { status: 200, body: progress.response } });
		const link = await screen.findByRole("link", { name: /Review files/ });
		await expectLoadingThen({
			loading: () =>
				screen.queryByRole("status", { name: "Loading review progress" }),
			empty: [
				() => within(link).queryByText(/clusters/),
				() => screen.queryByText("Loading progress…"),
			],
			release: () => progress.release(review),
			result: () => within(link).queryByText("2 / 5 clusters · 40%"),
		});
	});

	it("shows review progress on the Review files button", async () => {
		renderApp();
		const link = await screen.findByRole("link", { name: /Review files/ });
		expect(await within(link).findByText(/2 \/ 5/)).toBeInTheDocument();
		expect(link).toHaveAttribute("href", `/r/${ID}/files`);
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

	it("puts the agent chip right by the logo, before the title: one chip in the header", async () => {
		renderApp({
			"/api/agent": ok({
				state: "ready",
				configured: true,
				agent: { name: "Claude Agent", version: "0.100.0" },
				since: "2026-11-07T10:00:00Z",
				waiting: 0,
			}),
		});
		await screen.findByRole("heading", { level: 1 });
		const chip = await screen.findByRole("button", {
			name: "Your agent: Claude Agent 0.100.0",
		});
		expect(screen.getAllByTestId("agent-chip")).toEqual([chip]);
		const slot = screen.getByTestId("agent-chip-slot");
		expect(slot).toContainElement(chip);
		// Logo, chip, title: side by side in the title row.
		const logo = screen.getByTestId("home-link");
		const title = screen.getByTestId("header-title");
		expect(slot.parentElement).toBe(title.parentElement);
		expect(logo.parentElement).toBe(slot.parentElement);
		expect(
			logo.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(slot.nextElementSibling).toBe(title);
		// Not in the meta line under the title any more.
		expect(screen.getByText("acme/widget").parentElement).not.toContainElement(
			chip,
		);
		// The sticky row's place for it holds nothing to focus or name
		// until it docks there.
		const row = screen.getByTestId("agent-chip-row-slot");
		expect(row.querySelector("button, [aria-label]")).toBeNull();
	});

	it("leaves no chip and no kept space without an agent (the layout itself: e2e/sticky.spec.ts)", async () => {
		renderApp({ "/api/overview": ok({ ...overview, writes: "viewer" }) });
		await screen.findByRole("heading", { level: 1 });
		await screen.findByRole("region", { name: "Bot reviews" });
		expect(screen.queryByTestId("agent-chip")).toBeNull();
		for (const id of ["agent-chip-slot", "agent-chip-row-slot"]) {
			const slot = screen.getByTestId(id);
			expect(slot.querySelector("button, [data-chip-space]")).toBeNull();
		}
	});

	it("mounts no chip, and reads no agent, without a PR (session failed)", async () => {
		renderApp({
			"/api/session": { status: 502, body: { error: "gh is not logged in" } },
			"/api/agent": ok({
				state: "ready",
				configured: true,
				agent: { name: "Claude Agent", version: "0.100.0" },
				since: "2026-11-07T10:00:00Z",
				waiting: 0,
			}),
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"gh is not logged in",
		);
		// The overview (writes on) is in: a mounted chip would read now.
		await screen.findByRole("region", { name: "What it does" });
		await act(async () => {});
		expect(calls("/api/agent")).toBe(0);
		expect(screen.queryByTestId("agent-chip")).toBeNull();
	});

	it("closes the chip's tooltip when the chip moves into the sticky row", async () => {
		const rect = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: HTMLElement) {
				const by = this.dataset.testid === "agent-chip-slot";
				const top = by && window.scrollY > 0 ? -10 : 20;
				return {
					top,
					bottom: top + 24,
					left: 0,
					right: by ? 46 : 0,
					width: by ? 46 : 0,
					height: by ? 24 : 0,
					x: 0,
					y: top,
					toJSON: () => ({}),
				} as DOMRect;
			});
		try {
			renderApp({
				"/api/agent": ok({
					state: "ready",
					configured: true,
					agent: { name: "Claude Agent", version: "0.100.0" },
					since: "2026-11-07T10:00:00Z",
					waiting: 0,
				}),
			});
			const chip = await screen.findByRole("button", {
				name: "Your agent: Claude Agent 0.100.0",
			});
			// Its tooltip (always there, hidden while closed), opened by a hover.
			const tip = () =>
				[...document.querySelectorAll("[role=tooltip]")].find(
					(t) => t.textContent === "Claude Agent 0.100.0",
				);
			expect(tip()).toHaveAttribute("hidden");
			fireEvent.mouseEnter(chip);
			await waitFor(() => expect(tip()).not.toHaveAttribute("hidden"));
			act(() => {
				Object.defineProperty(window, "scrollY", {
					value: 100,
					configurable: true,
				});
				window.dispatchEvent(new Event("scroll"));
			});
			await waitFor(() =>
				expect(screen.getByTestId("agent-chip-row-slot")).toContainElement(
					chip,
				),
			);
			await waitFor(() => expect(tip()).toHaveAttribute("hidden"));
		} finally {
			rect.mockRestore();
			Object.defineProperty(window, "scrollY", {
				value: 0,
				configurable: true,
			});
		}
	});

	it("moves the one chip into the sticky row as its place by the logo leaves the screen: never remounted, so never read again", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const rect = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: HTMLElement) {
				const by = this.dataset.testid === "agent-chip-slot";
				const top = by && window.scrollY > 0 ? -10 : 20;
				return {
					top,
					bottom: top + 24,
					left: 0,
					right: by ? 46 : 0,
					width: by ? 46 : 0,
					height: by ? 24 : 0,
					x: 0,
					y: top,
					toJSON: () => ({}),
				} as DOMRect;
			});
		try {
			renderApp({
				"/api/agent": ok({
					state: "ready",
					configured: true,
					agent: { name: "Claude Agent", version: "0.100.0" },
					since: "2026-11-07T10:00:00Z",
					waiting: 0,
				}),
			});
			const chip = await screen.findByRole("button", {
				name: "Your agent: Claude Agent 0.100.0",
			});
			expect(screen.getByTestId("agent-chip-slot")).toContainElement(chip);
			const reads = calls("/api/agent");
			expect(reads).toBe(1);
			// Long after its read (stale: a remount would read it again).
			vi.setSystemTime(Date.now() + 60_000);
			for (const y of [100, 0, 100]) {
				act(() => {
					Object.defineProperty(window, "scrollY", {
						value: y,
						configurable: true,
					});
					window.dispatchEvent(new Event("scroll"));
				});
				const place = y > 0 ? "agent-chip-row-slot" : "agent-chip-slot";
				await waitFor(() =>
					expect(screen.getByTestId(place)).toContainElement(chip),
				);
				// The same node, the only one.
				expect(screen.getAllByTestId("agent-chip")).toEqual([chip]);
			}
			expect(calls("/api/agent")).toBe(reads);
		} finally {
			rect.mockRestore();
			Object.defineProperty(window, "scrollY", {
				value: 0,
				configurable: true,
			});
			vi.useRealTimers();
		}
	});

	it("offers the title again as a back-to-top button, inert until stuck", async () => {
		renderApp();
		await screen.findByRole("heading", { level: 1 });
		// jsdom has no layout: never stuck, so it is out of reach.
		const compact = screen.getByTestId("compact-title");
		expect(compact).toHaveAttribute("inert");
		expect(compact).toHaveAccessibleName("Back to top: Add widget cache");
		// So are the mark's Home link and the number's GitHub link beside it.
		const home = screen.getByTestId("compact-home-link");
		expect(home).toHaveAttribute("inert");
		expect(home).toHaveAccessibleName("Home");
		expect(home).toHaveAttribute("href", "/");
		const number = screen.getByTestId("compact-pr-link");
		expect(number).toHaveAttribute("inert");
		expect(number).toHaveAccessibleName("#12 on GitHub");
		expect(number).toHaveAttribute("target", "_blank");
		expect(number).toHaveAttribute("rel", "noreferrer");
		expect(number).toHaveAttribute(
			"href",
			"https://github.com/acme/widget/pull/12",
		);
	});

	it("a PR url that isn't http(s) gets no number link: the number is plain text", async () => {
		renderApp({
			"/api/session": ok({
				...info,
				pr: { ...info.pr, url: "javascript:alert(1)" },
			}),
		});
		await screen.findByRole("heading", { level: 1 });
		expect(screen.queryByTestId("compact-pr-link")).toBeNull();
		const pill = screen.getByTestId("compact-title-pill");
		expect(pill).toHaveTextContent("Add widget cache");
		expect(pill).toHaveTextContent("#12");
		expect(pill.querySelector("a")).toBeNull();
		expect(screen.getByTestId("header-title").querySelector("a")).toBeNull();
	});

	it("hides the compact number where its digits would crush the title", () => {
		// Padding and gap 1.5rem, ~0.45rem a character, a 2.5rem title floor.
		expect(compactNumberHideClass(7)).toBe("@max-[5rem]:hidden");
		expect(compactNumberHideClass(12)).toBe("@max-[5.5rem]:hidden");
		expect(compactNumberHideClass(123)).toBe("@max-[6rem]:hidden");
		expect(compactNumberHideClass(1234)).toBe("@max-[6.5rem]:hidden");
		expect(compactNumberHideClass(12345)).toBe("@max-[7rem]:hidden");
		expect(compactNumberHideClass(123456)).toBe("@max-[7.5rem]:hidden");
		expect(compactNumberHideClass(98765432)).toBe("@max-[7.5rem]:hidden");
	});
});

describe("Timeline", () => {
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	const actor = (login: string, bot = false) => ({
		login,
		avatarUrl: "",
		bot,
	});
	const commit = (n: number, at: string) => ({
		kind: "commit" as const,
		at,
		oid: String(n).repeat(40),
		headline: `Change ${n}`,
		url: "",
	});
	const reviewComment = (threadId: string, path: string, text: string) => ({
		kind: "comment" as const,
		at: "2026-01-03T09:00:00Z",
		path,
		line: 3,
		text,
		url: "https://github.com/acme/widget/pull/12#discussion_r1",
		threadId,
	});
	const timeline: TimelineView = {
		gaps: [],
		events: [
			{
				kind: "commits",
				actor: actor("octo-author"),
				from: "2026-01-01T09:00:00Z",
				to: "2026-01-02T09:00:00Z",
				items: [
					commit(1, "2026-01-01T09:00:00Z"),
					commit(2, "2026-01-02T09:00:00Z"),
				],
			},
			{
				kind: "force-push",
				actor: actor("octo-author"),
				at: "2026-01-02T10:00:00Z",
				before: "a".repeat(40),
				after: "c".repeat(40),
			},
			{
				kind: "review",
				actor: actor("rev1"),
				from: "2026-01-03T09:00:00Z",
				to: "2026-01-03T11:00:00Z",
				items: [
					{
						kind: "review",
						at: "2026-01-03T09:00:00Z",
						state: "CHANGES_REQUESTED",
						text: "",
						url: "",
					},
					reviewComment("T-cache", "src/cache.ts", "Should this expire?"),
					reviewComment("T-cache", "src/cache.ts", "Ping"),
					reviewComment("src/done1.ts", "src/done1.ts", "Rename this"),
				],
			},
			{
				kind: "commits",
				actor: actor("octo-author"),
				from: "2026-01-04T09:00:00Z",
				to: "2026-01-04T09:00:00Z",
				items: [commit(3, "2026-01-04T09:00:00Z")],
			},
		],
	};

	async function events(routes: Partial<Routes> = {}) {
		renderApp({ "/api/timeline": ok(timeline), ...routes });
		const section = await screen.findByRole("region", { name: "Timeline" });
		const list = await within(section).findByRole("list", {
			name: "Timeline events",
		});
		return { section, rows: within(list).getAllByTestId("timeline-event") };
	}

	it("is the page's last section: one line per event, oldest first, runs closed", async () => {
		const { section, rows } = await events();
		const sections =
			section.parentElement?.querySelectorAll(":scope > section");
		expect(sections?.[sections.length - 1]).toBe(section);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toHaveTextContent("octo-author");
		expect(rows[0]).toHaveTextContent("2 commits");
		// From X to Y: both ends as relative times with the exact one on hover.
		expect(rows[0]).toHaveTextContent(/from .+ to .+/);
		expect(rows[0]?.querySelectorAll("time")).toHaveLength(2);
		// A single item: one date.
		expect(rows[3]?.querySelectorAll("time")).toHaveLength(1);
		expect(rows[3]).not.toHaveTextContent(/from .+ to/);
		expect(rows[1]).toHaveTextContent(/force-pushed.*aaaaaaa.*ccccccc/);
		expect(within(section).queryAllByTestId("timeline-item")).toHaveLength(0);
	});

	it("opens a commit run into its commits", async () => {
		const user = userEvent.setup();
		const { rows } = await events();
		const row = rows[0] as HTMLElement;
		const show = within(row).getByRole("button", { name: "Show 2 commits" });
		expect(show).toHaveAttribute("aria-expanded", "false");
		await user.click(show);
		expect(show).toHaveAttribute("aria-expanded", "true");
		const items = within(row).getAllByTestId("timeline-item");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("1111111");
		expect(items[0]).toHaveTextContent("Change 1");
		expect(within(items[0] as HTMLElement).getByRole("link")).toHaveAttribute(
			"href",
			`https://github.com/acme/widget/pull/12/commits/${"1".repeat(40)}`,
		);
		await user.click(show);
		expect(within(row).queryAllByTestId("timeline-item")).toHaveLength(0);
	});

	it("sums up a review run: comments, verdict and how many of its threads are resolved", async () => {
		const user = userEvent.setup();
		const { rows } = await events();
		const row = rows[2] as HTMLElement;
		expect(row).toHaveTextContent("rev1");
		expect(row).toHaveTextContent("3 comments");
		expect(
			within(row).getByRole("img", { name: "Changes requested" }),
		).toBeInTheDocument();
		// Two threads: T-cache (unresolved) and src/done1.ts (resolved).
		const chip = await within(row).findByTestId("timeline-resolved");
		expect(chip).toHaveTextContent("1 of 2 resolved");
		expect(chip).toHaveAccessibleDescription(
			"1 of the 2 threads these comments are in is resolved now",
		);
		await user.click(
			within(row).getByRole("button", { name: "Show 3 comments" }),
		);
		const items = within(row).getAllByTestId("timeline-item");
		// The verdict, then each comment with its thread's state and place.
		expect(items).toHaveLength(4);
		expect(
			within(items[1] as HTMLElement).getByRole("img", { name: "Unresolved" }),
		).toBeInTheDocument();
		expect(
			within(items[3] as HTMLElement).getByRole("img", { name: "Resolved" }),
		).toBeInTheDocument();
		const place = within(items[1] as HTMLElement).getByTestId("timeline-place");
		expect(place).toHaveTextContent("src/cache.ts:42");
		expect(place).toHaveAttribute(
			"href",
			expect.stringContaining(`/r/${ID}/files?`),
		);
		expect(items[1]).toHaveTextContent("Should this expire?");
	});

	it("while the threads load, a review run and its comments spin, never read as threadless", async () => {
		const user = userEvent.setup();
		const threads = heldJson();
		const { threads: list, ...rest } = overview;
		const { rows } = await events({
			"/api/overview": ok(rest),
			"/api/threads": { status: 200, body: threads.response },
		});
		const row = rows[2] as HTMLElement;
		await user.click(
			within(row).getByRole("button", { name: "Show 3 comments" }),
		);
		const items = () => within(row).getAllByTestId("timeline-item");
		await expectLoadingThen({
			loading: () =>
				within(row).queryByRole("status", { name: "Loading threads" }),
			empty: [
				// A comment read as being in no thread.
				() => within(row).queryByRole("img", { name: "Comment" }),
			],
			release: () => threads.release({ threads: list, complete: true }),
			result: () => within(row).queryByTestId("timeline-resolved"),
		});
		expect(
			within(items()[1] as HTMLElement).getByRole("img", {
				name: "Unresolved",
			}),
		).toBeInTheDocument();
		expect(
			within(items()[3] as HTMLElement).getByRole("link", {
				name: "Go to the thread",
			}),
		).toBeInTheDocument();
		expect(
			within(row).queryAllByRole("status", { name: "Loading thread" }),
		).toHaveLength(0);
	});

	it("as of a cutoff, counts a run's threads without claiming any resolved or not", async () => {
		const user = userEvent.setup();
		const asOf = "2026-01-05T00:00:00Z";
		const { rows } = await events({
			"/api/session": ok({ ...info, asOf }),
			"/api/overview": ok({ ...overview, asOf }),
		});
		const row = rows[2] as HTMLElement;
		const chip = await within(row).findByTestId("timeline-resolved");
		expect(chip).toHaveTextContent("2 threads");
		expect(chip).not.toHaveTextContent("resolved");
		expect(chip).toHaveAccessibleDescription(
			"Resolution isn't known as of the cutoff",
		);
		await user.click(
			within(row).getByRole("button", { name: "Show 3 comments" }),
		);
		const items = within(row).getAllByTestId("timeline-item");
		expect(
			within(items[1] as HTMLElement).getByRole("img", {
				name: "Thread; resolution isn't known as of the cutoff",
			}),
		).toBeInTheDocument();
		expect(within(row).queryByRole("img", { name: "Unresolved" })).toBeNull();
		expect(within(row).queryByRole("img", { name: "Resolved" })).toBeNull();
	});

	it("brings a comment's thread card into view, opening the resolved list if need be", async () => {
		const user = userEvent.setup();
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled;
		const { rows } = await events();
		const row = rows[2] as HTMLElement;
		await user.click(
			within(row).getByRole("button", { name: "Show 3 comments" }),
		);
		const items = within(row).getAllByTestId("timeline-item");
		await user.click(
			within(items[3] as HTMLElement).getByRole("link", {
				name: "Go to the thread",
			}),
		);
		const card = await waitFor(() => {
			const el = document.getElementById("thread-src/done1.ts");
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		await waitFor(() => expect(card).toHaveFocus());
		expect(scrolled).toHaveBeenCalled();
		const humans = screen.getByRole("region", { name: "Human reviews" });
		expect(
			within(humans).getByRole("list", { name: "Resolved threads" }),
		).toContainElement(card);
		expect(
			within(humans).getByRole("radio", { name: "4 resolved" }),
		).toBeChecked();
	});

	it("brings a thread into view while Drafts is on: its list shows, Drafts goes", async () => {
		const user = userEvent.setup();
		Element.prototype.scrollIntoView = vi.fn();
		const { client } = renderApp({ "/api/timeline": ok(timeline) });
		const humans = await screen.findByRole("region", { name: "Human reviews" });
		await within(humans).findAllByTestId("thread");
		act(() => draftsFor(client).setText("T-cache", "Half a thought"));
		const chip = await within(humans).findByTestId("drafts-filter");
		await user.click(chip);
		expect(chip).toHaveAttribute("aria-pressed", "true");
		const section = screen.getByRole("region", { name: "Timeline" });
		const row = within(section).getAllByTestId(
			"timeline-event",
		)[2] as HTMLElement;
		await user.click(
			within(row).getByRole("button", { name: "Show 3 comments" }),
		);
		const items = within(row).getAllByTestId("timeline-item");
		await user.click(
			within(items[3] as HTMLElement).getByRole("link", {
				name: "Go to the thread",
			}),
		);
		await waitFor(() =>
			expect(
				within(humans).getByRole("radio", { name: "4 resolved" }),
			).toBeChecked(),
		);
		expect(chip).toHaveAttribute("aria-pressed", "false");
		expect(
			within(humans).getByRole("list", { name: "Resolved threads" }),
		).toContainElement(document.getElementById("thread-src/done1.ts"));
	});

	it("shows the latest events, the earlier ones on request, and what GitHub didn't list", async () => {
		const user = userEvent.setup();
		const many: TimelineView = {
			gaps: ["GitHub listed 250 of 260 commits"],
			events: Array.from({ length: 35 }, (_, i) => ({
				kind: "closed" as const,
				actor: actor(`user${i}`),
				at: new Date(Date.UTC(2026, 0, 1, 9, i)).toISOString(),
			})),
		};
		const { section, rows } = await events({ "/api/timeline": ok(many) });
		expect(rows).toHaveLength(30);
		expect(rows[0]).toHaveTextContent("user5");
		expect(within(section).getByTestId("timeline-gap")).toHaveTextContent(
			"GitHub listed 250 of 260 commits",
		);
		await user.click(
			within(section).getByRole("button", { name: "Show 5 earlier events" }),
		);
		expect(within(section).getAllByTestId("timeline-event")).toHaveLength(35);
		expect(
			within(section).queryByRole("button", { name: /earlier events/ }),
		).toBeNull();
	});

	it("loads apart from the rest of the page", async () => {
		renderApp({ "/api/timeline": ok(NEVER) });
		const section = await screen.findByRole("region", { name: "Timeline" });
		expect(within(section).getByTestId("timeline-loading")).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(
			await screen.findByRole("region", { name: "Human reviews" }),
		).toBeVisible();
	});

	it("says when the timeline couldn't be read", async () => {
		renderApp({
			"/api/timeline": { status: 502, body: { error: "timeline broke" } },
		});
		const section = await screen.findByRole("region", { name: "Timeline" });
		expect(await within(section).findByText("timeline broke")).toBeVisible();
		expect(within(section).queryByTestId("timeline-loading")).toBeNull();
	});
});
