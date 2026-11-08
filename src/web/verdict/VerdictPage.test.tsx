// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
	act,
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	PrOverview,
	ReviewThread,
	ReviewView,
	SessionInfo,
	VerdictAnswer,
	VerdictFacts,
	VerdictRequest,
} from "../../shared/types";
import { createAppRouter } from "../router";
import { OWN_PR_TIP, VERDICT_TIPS } from "./VerdictCard";

const HEAD = "b".repeat(40);
const OLD = "9".repeat(40);

const info: SessionInfo = {
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: HEAD,
	currentHead: HEAD,
	headMoved: false,
	patchset: null,
	asOf: null,
	pinnedHead: null,
	patchsets: [],
	lastSeen: null,
	head: null,
};

const overview: PrOverview = {
	title: "Add widget cache",
	number: 12,
	url: "https://github.com/acme/widget/pull/12",
	author: "alice",
	body: "",
	bodyHtml: "",
	isDraft: false,
	state: "OPEN",
	createdAt: "2026-01-02T10:00:00Z",
	updatedAt: "2026-01-05T12:00:00Z",
	baseBranch: "main",
	headBranch: "feature/cache",
	mergeable: "MERGEABLE",
	requestedReviewers: [{ name: "maya", team: false }],
	reviews: [],
	commenters: [],
	humanStarted: true,
	youAuthor: false,
	writes: "on",
	commentLeft: true,
	pendingReview: null,
	readId: "read1",
	fetchedAt: "2026-01-05T12:00:00Z",
	servedAt: "2026-01-05T12:00:01Z",
	checks: [],
};

function thread(id: string, more: Partial<ReviewThread> = {}): ReviewThread {
	return {
		id,
		loaded: true,
		path: `src/${id}.ts`,
		line: 3,
		currentLine: 3,
		excerpt: `About ${id}`,
		html: "",
		body: "",
		createdAt: "2026-01-01T00:00:00Z",
		lastActivityAt: "2026-01-01T00:00:00Z",
		author: "ravi",
		bot: false,
		avatarUrl: "",
		participants: [],
		commentCount: 1,
		hasReply: false,
		outdated: false,
		resolved: false,
		code: null,
		anchor: null,
		commit: "",
		subject: "line",
		attention: [],
		yourTurn: false,
		viewerCan: { reply: true, resolve: true, unresolve: true },
		...more,
	};
}

const threads = [thread("t1"), thread("t2", { author: "octo" })];

const facts: VerdictFacts = {
	since: null,
	mergeStateStatus: "BLOCKED",
	reviewDecision: "CHANGES_REQUESTED",
	checks: [
		{ name: "jira", status: "failing", required: true, url: "https://ci/jira" },
		{ name: "e2e", status: "pending", required: false },
		{ name: "unit", status: "passing", required: true },
	],
	rule: null,
	codeOwnerRequests: [{ name: "acme/platform", team: true }],
	reviews: [
		{
			author: "ravi",
			state: "CHANGES_REQUESTED",
			submittedAt: "2026-01-04T00:00:00Z",
			commitId: HEAD,
			you: false,
			bot: false,
		},
	],
	head: HEAD,
	fetchedAt: "2026-01-05T12:00:00Z",
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
		lines: counts(340, 120, 0),
		files: { ...counts(3, 1, 0), done: 1 },
	},
};

type Route =
	| { status: number; body: unknown }
	| ((init?: RequestInit) => Promise<Response>);
type Routes = Record<string, Route>;

let fetchMock: ReturnType<typeof vi.fn>;
let posted: VerdictRequest[];

const ok = (body: unknown) => ({ status: 200, body });

const landed = (state: VerdictAnswer["review"]["state"]): VerdictAnswer => ({
	review: {
		id: "R9",
		state,
		submittedAt: new Date().toISOString(),
		commitId: HEAD,
		body: "",
	},
});

/** A POST /api/verdict that answers each request as `answer` says (held: never). */
function verdictRoute(
	answer: (req: VerdictRequest) => Response | null = (req) =>
		new Response(
			JSON.stringify(
				landed(
					req.event === "APPROVE"
						? "APPROVED"
						: req.event === "COMMENT"
							? "COMMENTED"
							: "CHANGES_REQUESTED",
				),
			),
			{ status: 200 },
		),
) {
	// What GitHub has: a verdict that lands is read back.
	let served = facts;
	return async (init?: RequestInit) => {
		if (init?.method !== "POST") {
			return new Response(JSON.stringify(served), { status: 200 });
		}
		const req = JSON.parse(String(init.body)) as VerdictRequest;
		posted.push(req);
		const res = answer(req);
		if (!res) return new Promise<Response>(() => {});
		if (res.ok) {
			const { review } = (await res.clone().json()) as VerdictAnswer;
			served = {
				...served,
				reviews: [
					{
						author: "octo",
						state: review.state,
						submittedAt: review.submittedAt,
						commitId: review.commitId,
						you: true,
						bot: false,
					},
					...served.reviews.filter((r) => !r.you),
				],
			};
		}
		return res;
	};
}

/** The tests' review: the page binds to it (api.ts bindReview). */
const ID = "01testreview0000000000000a";
/** A review route's path as the routes below name it: `/api/<x>`. */
const local = (input: RequestInfo | URL) =>
	new URL(String(input), "http://test").pathname.replace(
		`/api/r/${ID}/`,
		"/api/",
	);

function renderApp(routes: Partial<Routes> = {}, page = "/verdict") {
	const path = `/r/${ID}${page === "/" ? "" : page}`;
	posted = [];
	const all: Routes = {
		"/api/session": ok(info),
		"/api/overview": ok(overview),
		"/api/review": ok(review),
		"/api/timeline": ok({ events: [], gaps: [] }),
		"/api/threads": ok({ threads, complete: true }),
		"/api/verdict": verdictRoute(),
		...routes,
	} as Routes;
	fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const p = local(input);
		const route = all[p];
		if (!route) return new Response("{}", { status: 404 });
		if (typeof route === "function") return route(init);
		return new Response(JSON.stringify(route.body), { status: route.status });
	});
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("scrollTo", vi.fn());
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const router = createAppRouter({ initialPath: path });
	const view = render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { ...view, router, client };
}

const verdictReads = () =>
	fetchMock.mock.calls.filter(
		([input, init]) =>
			local(input) === "/api/verdict" &&
			(init as RequestInit | undefined)?.method !== "POST",
	).length;

const card = () => screen.findByTestId("verdict-card-tab");
const button = async (name: string) =>
	within(await card()).getByRole("button", { name });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("Final Verdict tab", () => {
	it("isn't read on first open of another tab, only once it shows", async () => {
		const { router } = renderApp({}, "/");
		await screen.findByRole("region", { name: "What it does" });
		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		expect(verdictReads()).toBe(0);
		const tab = screen.getByRole("link", { name: "Final Verdict" });
		expect(tab).toHaveAttribute("href", `/r/${ID}/verdict`);
		await router.navigate({ to: "/r/$id/verdict", params: { id: ID } });
		expect(await screen.findByTestId("github-status")).toHaveTextContent(
			"GitHub: blocked",
		);
		expect(verdictReads()).toBe(1);
	});

	it("shows GitHub's status, then one list: required rows tagged, the rest untagged", async () => {
		renderApp();
		const status = await screen.findByTestId("github-status");
		expect(status).toHaveTextContent("GitHub: blocked");
		const list = await screen.findByRole("list", { name: "Blockers" });
		await waitFor(() =>
			expect(within(list).getByText("About t1")).toBeInTheDocument(),
		);
		const rows = within(list).getAllByTestId("blocker");
		const row = (text: string) =>
			rows.find((r) => r.textContent?.includes(text)) as HTMLElement;
		expect(row("jira failing")).toHaveAttribute("data-required", "true");
		expect(
			within(row("jira failing")).getByTestId("required-tag"),
		).toHaveAccessibleDescription("GitHub won't merge without it");
		expect(within(row("jira failing")).getByRole("link")).toHaveAttribute(
			"href",
			"https://ci/jira",
		);
		expect(row("Changes requested by ravi")).toHaveAttribute(
			"data-required",
			"true",
		);
		// The rule unread and no review required: a code owner asked, untagged.
		expect(row("@acme/platform")).not.toHaveAttribute("data-required");
		expect(row("e2e running")).not.toHaveAttribute("data-required");
		expect(row("e2e running")).toHaveAttribute("data-tone", "warn");
		// Own thread first, linking to its card on the Overview.
		const own = row("About t2");
		expect(rows.indexOf(own)).toBeLessThan(rows.indexOf(row("About t1")));
		expect(within(own).getByRole("link")).toHaveAttribute(
			"href",
			`/r/${ID}?thread=t2`,
		);
		expect(row("Waiting on maya")).toBeTruthy();
		expect(row("1 check passing")).toHaveAttribute("data-kind", "summary");
	});

	it("approves at once, with no body when the box is off, and shows it", async () => {
		renderApp();
		const user = userEvent.setup();
		const approve = await button("Approve");
		expect(approve).toHaveAccessibleDescription(VERDICT_TIPS.APPROVE);
		await user.click(approve);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toEqual({
			clientId: expect.any(String),
			event: "APPROVE",
			commit: HEAD,
			attemptedAt: expect.any(String),
			retry: false,
		});
		expect(await screen.findByTestId("your-verdict")).toHaveTextContent(
			/You approved/,
		);
	});

	it("sends nothing for Comment or Request changes without a message: the box opens and takes focus", async () => {
		renderApp();
		const user = userEvent.setup();
		await user.click(await button("Comment"));
		const box = await screen.findByRole("textbox", { name: "Message" });
		expect(box).toHaveFocus();
		expect(
			screen.getByRole("checkbox", { name: "Include a message" }),
		).toBeChecked();
		await user.click(await button("Request changes"));
		expect(box).toHaveFocus();
		expect(posted).toHaveLength(0);
		await user.type(box, "Please split this");
		await user.click(await button("Request changes"));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			event: "REQUEST_CHANGES",
			body: "Please split this",
		});
		// Sent: the box is closed and empty.
		expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
		expect(await screen.findByTestId("your-verdict")).toHaveTextContent(
			/You requested changes/,
		);
	});

	it("sends an approval's message only when the box is ticked", async () => {
		renderApp();
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("checkbox", { name: "Include a message" }),
		);
		await user.type(
			screen.getByRole("textbox", { name: "Message" }),
			"Ship it",
		);
		await user.click(await button("Approve"));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ event: "APPROVE", body: "Ship it" });
	});

	it("keeps the message across a reload", async () => {
		renderApp();
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("checkbox", { name: "Include a message" }),
		);
		await user.type(screen.getByRole("textbox", { name: "Message" }), "Hmm");
		cleanup();
		renderApp();
		expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue(
			"Hmm",
		);
	});

	it("posts one review for a double press, and holds the others while it's out", async () => {
		renderApp({ "/api/verdict": verdictRoute(() => null) });
		const user = userEvent.setup();
		const approve = await button("Approve");
		await user.dblClick(approve);
		await user.click(await button("Request changes"));
		// The POST is held: one request, the rest waits (ThreadWrites tests
		// cover a second press while one is out).
		await waitFor(() => expect(posted).toHaveLength(1));
		for (const name of ["Approve", "Comment", "Request changes"]) {
			expect(await button(name)).toHaveAttribute("aria-disabled", "true");
		}
		// Shown at once, as sending.
		expect(screen.getByTestId("your-verdict")).toHaveTextContent(
			/You approved just now/,
		);
	});

	it("on the viewer's own PR, allows only Comment", async () => {
		renderApp({ "/api/overview": ok({ ...overview, youAuthor: true }) });
		const user = userEvent.setup();
		const approve = await button("Approve");
		expect(approve).toHaveAttribute("aria-disabled", "true");
		expect(approve).toHaveAccessibleDescription(OWN_PR_TIP);
		expect(await button("Request changes")).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		const comment = await button("Comment");
		expect(comment).not.toHaveAttribute("aria-disabled");
		await user.click(approve);
		expect(posted).toHaveLength(0);
	});

	it("disables all three where writes are off", async () => {
		renderApp({
			"/api/overview": ok({
				...overview,
				writes: "as-of",
				asOf: "2026-01-03T00:00:00Z",
			}),
		});
		const user = userEvent.setup();
		for (const name of ["Approve", "Comment", "Request changes"]) {
			const b = await button(name);
			expect(b).toHaveAttribute("aria-disabled", "true");
			await user.click(b);
		}
		expect(posted).toHaveLength(0);
	});

	it("says the reviewer's verdict was on an earlier push, and when the card's commit is older", async () => {
		renderApp({
			"/api/session": ok({ ...info, snapshotHead: OLD }),
			"/api/verdict": ok({
				...facts,
				reviews: [
					{
						author: "octo",
						state: "APPROVED",
						submittedAt: "2026-01-04T00:00:00Z",
						commitId: OLD,
						you: true,
						bot: false,
					},
				],
			}),
		});
		expect(await screen.findByTestId("your-verdict")).toHaveTextContent(
			/You approved.*on an earlier push/,
		);
		expect(screen.getByTestId("verdict-older")).toHaveTextContent(
			"On 9999999, an older commit",
		);
	});

	it("lists every reviewer's verdict: yours first, the others newest first, bots apart; earlier pushes said", async () => {
		const at = (
			author: string,
			state: VerdictFacts["reviews"][number]["state"],
			submittedAt: string,
			more: Partial<VerdictFacts["reviews"][number]> = {},
		) => ({
			author,
			state,
			submittedAt,
			commitId: HEAD,
			you: false,
			bot: false,
			...more,
		});
		renderApp({
			"/api/verdict": ok({
				...facts,
				reviews: [
					at("renovate", "COMMENTED", "2026-01-06T00:00:00Z", { bot: true }),
					at("maya", "APPROVED", "2026-01-05T00:00:00Z", {
						url: "https://github.com/acme/widget/pull/12#pullrequestreview-5",
					}),
					at("ravi", "CHANGES_REQUESTED", "2026-01-04T00:00:00Z"),
					at("octo", "COMMENTED", "2026-01-02T00:00:00Z", { you: true }),
					at("dima", "APPROVED", "2026-01-01T00:00:00Z", { commitId: OLD }),
					at("lee", "DISMISSED", "2026-01-01T00:00:00Z"),
				],
			}),
		});
		const section = await screen.findByTestId("verdict-reviews");
		const people = within(section).getByRole("list", { name: "Reviews" });
		const rows = within(people).getAllByTestId("review-row");
		const names = ["octo", "maya", "ravi", "dima", "lee"];
		expect(
			rows.map((r) => names.find((n) => r.textContent?.startsWith(n))),
		).toEqual(["octo", "maya", "ravi", "dima", "lee"]);
		expect(rows[0]).toHaveAttribute("data-you", "true");
		expect(rows[0]).toHaveTextContent("you");
		expect(rows.map((r) => r.dataset.state)).toEqual([
			"COMMENTED",
			"APPROVED",
			"CHANGES_REQUESTED",
			"APPROVED",
			"DISMISSED",
		]);
		expect(within(rows[1] as HTMLElement).getByRole("link")).toHaveAttribute(
			"href",
			"https://github.com/acme/widget/pull/12#pullrequestreview-5",
		);
		expect(within(rows[2] as HTMLElement).queryByRole("link")).toBeNull();
		expect(
			rows.filter((r) => within(r).queryByTestId("review-earlier")),
		).toEqual([rows[3]]);
		const bots = within(section).getByRole("list", { name: "Bot reviews" });
		expect(within(bots).getAllByTestId("review-row")).toHaveLength(1);
		expect(within(bots).getByRole("img", { name: "bot" })).toBeInTheDocument();
		// The header counts, icon-first.
		expect(
			within(section).getByRole("img", { name: "2 approved" }),
		).toBeInTheDocument();
		expect(
			within(section).getByRole("img", { name: "1 requested changes" }),
		).toBeInTheDocument();
		// Between the blockers and the card.
		const blockersList = screen.getByRole("list", { name: "Blockers" });
		expect(
			blockersList.compareDocumentPosition(section) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			section.compareDocumentPosition(await card()) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// Approvals aren't repeated in the summary row.
		expect(blockersList).not.toHaveTextContent("approved");
	});

	it("has no Reviews section when no one reviewed", async () => {
		renderApp({ "/api/verdict": ok({ ...facts, reviews: [] }) });
		await screen.findByTestId("github-status");
		expect(screen.queryByTestId("verdict-reviews")).toBeNull();
	});

	it("Comment's tip says it replaces a standing approval or request for changes", async () => {
		const mine = (state: VerdictFacts["reviews"][number]["state"]) =>
			ok({
				...facts,
				reviews: [
					{
						author: "octo",
						state,
						submittedAt: "2026-01-04T00:00:00Z",
						commitId: HEAD,
						you: true,
						bot: false,
					},
				],
			});
		renderApp({ "/api/verdict": mine("CHANGES_REQUESTED") });
		await waitFor(async () =>
			expect(await button("Comment")).toHaveAccessibleDescription(
				`${VERDICT_TIPS.COMMENT}Replaces your request for changes`,
			),
		);
		cleanup();
		renderApp({ "/api/verdict": mine("APPROVED") });
		await waitFor(async () =>
			expect(await button("Comment")).toHaveAccessibleDescription(
				`${VERDICT_TIPS.COMMENT}Replaces your approval`,
			),
		);
		cleanup();
		renderApp({ "/api/verdict": mine("COMMENTED") });
		await screen.findByTestId("verdict-reviews");
		expect(await button("Comment")).toHaveAccessibleDescription(
			VERDICT_TIPS.COMMENT,
		);
	});

	it("a comment whose withdrawal failed: a yellow notice that the opinion stands, nothing under not posted", async () => {
		renderApp({
			"/api/verdict": verdictRoute(
				(req) =>
					new Response(
						JSON.stringify({
							...landed(req.event === "APPROVE" ? "APPROVED" : "COMMENTED"),
							...(req.event === "COMMENT"
								? {
										stillStands: {
											state: "CHANGES_REQUESTED",
											message: "Resource not accessible by integration",
										},
									}
								: {}),
						} satisfies VerdictAnswer),
						{ status: 200 },
					),
			),
		});
		const user = userEvent.setup();
		await user.click(await button("Comment"));
		await user.type(screen.getByRole("textbox", { name: "Message" }), "Ok");
		await user.click(await button("Comment"));
		const notice = await screen.findByTestId("verdict-still-stands");
		expect(notice).toHaveTextContent(
			"Commented; your request for changes still stands: Resource not accessible by integration",
		);
		expect(screen.queryByTestId("refused-write")).toBeNull();
		expect(posted).toHaveLength(1);
		// The next press clears it.
		await user.click(await button("Approve"));
		await waitFor(() =>
			expect(screen.queryByTestId("verdict-still-stands")).toBeNull(),
		);
	});

	it("shows progress as information only", async () => {
		renderApp();
		expect(await screen.findByTestId("verdict-info")).toHaveTextContent(
			"You reviewed 120 of 340 lines · 1 of your threads is open",
		);
	});

	it("lists a refused verdict in the not-posted chip, with its message", async () => {
		renderApp({
			"/api/verdict": verdictRoute(
				() =>
					new Response(
						JSON.stringify({
							error: "User can only have one pending review per pull request",
							code: "pending-review",
							url: "https://github.com/acme/widget/pull/12/files",
						}),
						{ status: 409 },
					),
			),
		});
		const user = userEvent.setup();
		await user.click(await button("Comment"));
		await user.type(screen.getByRole("textbox", { name: "Message" }), "Nit");
		await user.click(await button("Comment"));
		const item = await screen.findByTestId("refused-write");
		expect(item).toHaveTextContent("Verdict · Comment");
		expect(item).toHaveTextContent("A pending review on GitHub blocks it");
		// Kept with the refusal (its preview, what Retry sends), not in the box.
		expect(item).toHaveTextContent("Nit");
		expect(screen.getByTestId("pending-review-warning")).toBeInTheDocument();
	});

	it("goes checkbox, message, buttons by keyboard; Request changes jumps to the message", async () => {
		renderApp();
		const user = userEvent.setup();
		const box = await screen.findByRole("checkbox", {
			name: "Include a message",
		});
		box.focus();
		await user.keyboard(" ");
		const message = screen.getByRole("textbox", { name: "Message" });
		await user.tab();
		expect(message).toHaveFocus();
		await user.tab();
		expect(await button("Approve")).toHaveFocus();
		await user.tab();
		expect(await button("Comment")).toHaveFocus();
		await user.tab();
		const changes = await button("Request changes");
		expect(changes).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(message).toHaveFocus();
		await user.keyboard("Needs tests");
		await user.tab();
		await user.tab();
		await user.tab();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			event: "REQUEST_CHANGES",
			body: "Needs tests",
		});
	});

	it("reads GitHub again on Refresh", async () => {
		renderApp({ "/api/refresh": ok(info) });
		const user = userEvent.setup();
		await screen.findByTestId("github-status");
		expect(verdictReads()).toBe(1);
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(verdictReads()).toBe(2));
	});

	it("puts the card after the last file, with the blockers' count once it nears the window", async () => {
		const seen: IntersectionObserverCallback[] = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(cb: IntersectionObserverCallback) {
					seen.push(cb);
				}
				observe() {}
				disconnect() {}
			},
		);
		renderApp({}, "/files");
		const end = await screen.findByTestId("verdict-card-files");
		const link = within(end).getByRole("link", { name: "Blockers" });
		expect(link).toHaveAttribute("href", `/r/${ID}/verdict`);
		expect(verdictReads()).toBe(0);
		act(() => {
			for (const cb of seen) {
				cb(
					[{ isIntersecting: true } as IntersectionObserverEntry],
					{} as IntersectionObserver,
				);
			}
		});
		// jira, changes requested, e2e, the code owner, two threads, maya.
		expect(
			await within(end).findByRole("link", { name: "Blockers: 7" }),
		).toBeInTheDocument();
		expect(verdictReads()).toBe(1);
		expect(within(end).getByRole("button", { name: "Approve" })).toBeTruthy();
	});

	it("keeps the Files end card quiet when GitHub's facts can't be read", async () => {
		const seen: IntersectionObserverCallback[] = [];
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(cb: IntersectionObserverCallback) {
					seen.push(cb);
				}
				observe() {}
				disconnect() {}
			},
		);
		renderApp(
			{ "/api/verdict": { status: 502, body: { error: "gh failed" } } },
			"/files",
		);
		const end = await screen.findByTestId("verdict-card-files");
		act(() => {
			for (const cb of seen) {
				cb(
					[{ isIntersecting: true } as IntersectionObserverEntry],
					{} as IntersectionObserver,
				);
			}
		});
		await waitFor(() => expect(verdictReads()).toBe(1));
		expect(within(end).getByRole("link", { name: "Blockers" })).toBeTruthy();
		expect(within(end).queryByText(/gh failed/)).toBeNull();
		expect(within(end).getByRole("button", { name: "Approve" })).toBeTruthy();
	});

	it("says merged with no list under it, and disables the buttons", async () => {
		renderApp({
			"/api/overview": ok({ ...overview, state: "MERGED" }),
			"/api/verdict": ok({
				...facts,
				mergeStateStatus: null,
				reviewDecision: null,
			}),
		});
		expect(await screen.findByTestId("github-status")).toHaveTextContent(
			"Merged",
		);
		expect(screen.queryByRole("list", { name: "Blockers" })).toBeNull();
		expect(await button("Approve")).toHaveAttribute("aria-disabled", "true");
	});
});
