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
import { heldJson } from "../../../test/loading";
import type {
	PrOverview,
	ReviewView,
	SessionInfo,
	VerdictFacts,
	VerdictRequest,
	VerdictSince,
} from "../../shared/types";
import { createAppRouter } from "../router";
import { nothingToReread, sinceLine } from "./VerdictCard";

/*
 * The verdict card's "since your verdict" lines (VerdictFacts.since): what
 * you gave on which patch set, what changed since with the target patch
 * set's meter, the identical-diff copy with "Approve again on …", and the
 * spinner while the engine computes. The rest of the card: VerdictPage.test.tsx.
 */

const PS1 = "a1b2c3d".padEnd(40, "1");
const PS2 = "f9e8d7c".padEnd(40, "2");
const NEW = "0c1d2e3".padEnd(40, "3");
const ID = "01testreview0000000000000a";

const patchset = (number: number, head: string) => ({
	number,
	head,
	mergeBase: "e".repeat(40),
	startedAt: Date.parse("2026-11-05T10:00:00Z"),
	since: number === 1 ? null : number - 1,
	shape: number === 1 ? null : ("S1" as const),
});

const session = (more: Partial<SessionInfo> = {}): SessionInfo => ({
	pr: {
		owner: "acme",
		repo: "widget",
		number: 12,
		title: "Add widget cache",
		url: "https://github.com/acme/widget/pull/12",
	},
	viewer: "octo",
	snapshotHead: PS2,
	currentHead: PS2,
	headMoved: false,
	patchset: 2,
	asOf: null,
	pinnedHead: null,
	patchsets: [patchset(1, PS1), patchset(2, PS2)],
	lastSeen: null,
	head: { oid: PS2, mergeBase: "e".repeat(40), baseBranch: "main", commits: 0 },
	...more,
});

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
	requestedReviewers: [],
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

const counts = (total: number, reviewed: number, crossedOff = 0) => ({
	total,
	reviewed,
	crossedOff,
});
const review = (patchsetNo: number | null): ReviewView => ({
	revision: "r2",
	patchset: patchsetNo,
	files: [],
	progress: {
		clusters: counts(6, 4),
		lines: counts(40, 30),
		files: { ...counts(3, 2), done: 2 },
	},
});

const given = (more: Partial<VerdictSince> = {}): VerdictSince => ({
	state: "APPROVED",
	head: PS1,
	at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
	url: "https://github.com/acme/widget/pull/12#pullrequestreview-1",
	patchset: 1,
	to: { head: PS2, patchset: 2 },
	changes: {
		status: "done",
		shape: "S1",
		commits: 3,
		files: 2,
		reworked: 1,
		new: 1,
		gone: 0,
		identical: false,
	},
	...more,
});

const SAME: VerdictSince["changes"] = {
	status: "done",
	shape: "S4a",
	commits: 2,
	files: 0,
	reworked: 0,
	new: 0,
	gone: 0,
	identical: true,
};

const facts = (since: VerdictSince | null): VerdictFacts => {
	const yours = since && {
		author: "octo",
		state: since.state,
		submittedAt: since.at,
		commitId: since.head,
		you: true,
		bot: false,
	};
	return {
		mergeStateStatus: "CLEAN",
		reviewDecision: null,
		checks: [],
		rule: null,
		codeOwnerRequests: [],
		reviews: yours ? [yours] : [],
		yourVerdict: yours,
		head: PS2,
		fetchedAt: "2026-01-05T12:00:00Z",
		since,
	};
};

let posted: VerdictRequest[];

const local = (input: RequestInfo | URL) =>
	new URL(String(input), "http://test").pathname.replace(
		`/api/r/${ID}/`,
		"/api/",
	);

/** The tab with `verdict` answering GET /api/verdict (each call), the rest fixed. */
function renderTab(
	verdict: () => VerdictFacts | Promise<Response>,
	info: SessionInfo = session(),
) {
	posted = [];
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200 });
			switch (local(input)) {
				case "/api/session":
					return json(info);
				case "/api/overview":
					return json(overview);
				case "/api/review":
					return json(review(info.patchset));
				case "/api/threads":
					return json({ threads: [], complete: true });
				case "/api/timeline":
					return json({ events: [], gaps: [] });
				case "/api/verdict": {
					if (init?.method === "POST") {
						const req = JSON.parse(String(init.body)) as VerdictRequest;
						posted.push(req);
						return json({
							review: {
								id: "R9",
								state: "APPROVED",
								submittedAt: new Date().toISOString(),
								commitId: req.commit,
								body: "",
							},
						});
					}
					const answer = verdict();
					return answer instanceof Promise ? answer : json(answer);
				}
				default:
					return new Response("{}", { status: 404 });
			}
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("scrollTo", vi.fn());
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const router = createAppRouter({ initialPath: `/r/${ID}/verdict` });
	render(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { fetchMock };
}

const card = () => screen.findByTestId("verdict-card-tab");

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("sinceLine and nothingToReread", () => {
	it("says what the engine counted, words in the singular for one", () => {
		const done = given().changes as Extract<
			VerdictSince["changes"],
			{ status: "done" }
		>;
		expect(sinceLine(done)).toBe(
			"3 commits · 2 files · 1 reworked, 1 new cluster",
		);
		expect(
			sinceLine({ ...done, commits: 1, files: 1, reworked: 0, new: 2 }),
		).toBe("1 commit · 1 file · 2 new clusters");
		expect(sinceLine({ ...done, files: 0, reworked: 0, new: 0, gone: 2 })).toBe(
			"3 commits · 2 gone",
		);
	});

	it("is nothing to re-read only for an identical diff with nothing counted (principle 2)", () => {
		expect(nothingToReread(SAME)).toBe(true);
		expect(nothingToReread({ ...SAME, new: 1 } as typeof SAME)).toBe(false);
		expect(nothingToReread({ ...SAME, reworked: 1 } as typeof SAME)).toBe(
			false,
		);
		expect(nothingToReread({ ...SAME, gone: 1 } as typeof SAME)).toBe(false);
		expect(nothingToReread({ ...SAME, identical: false } as typeof SAME)).toBe(
			false,
		);
		expect(nothingToReread({ status: "pending" })).toBe(false);
		expect(nothingToReread({ status: "failed", message: "x" })).toBe(false);
	});
});

describe("the verdict card since your verdict", () => {
	it("you approved PS1, PS2 differs: the verdict's commit and patch set, what changed with PS2's meter; Approve goes on PS2's head", async () => {
		renderTab(() => facts(given()));
		const c = await card();
		const yours = await within(c).findByTestId("your-verdict");
		expect(yours).toHaveTextContent(
			/^You approved a1b2c3d \(PS1\), 2 days ago$/,
		);
		expect(
			within(yours).getByRole("link", { name: "a1b2c3d" }),
		).toHaveAttribute(
			"href",
			"https://github.com/acme/widget/pull/12#pullrequestreview-1",
		);
		const since = within(c).getByTestId("verdict-since");
		expect(since).toHaveAttribute("data-state", "changed");
		expect(since).toHaveTextContent(
			"Since then: 3 commits · 2 files · 1 reworked, 1 new cluster",
		);
		expect(
			await within(c).findByTestId("verdict-since-meter"),
		).toHaveTextContent("4 / 6 on PS2");
		expect(within(c).queryByText(/nothing to re-read/)).toBeNull();
		expect(within(c).queryByTestId("verdict-older")).toBeNull();
		const approve = within(c).getByRole("button", { name: "Approve f9e8d7c" });
		await userEvent.click(approve);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ event: "APPROVE", commit: PS2 });
	});

	it("an identical rebase: Rebased, same diff · nothing to re-read, and Approve again on the new head", async () => {
		const info = session({
			snapshotHead: PS1,
			currentHead: NEW,
			headMoved: true,
			patchset: 1,
			patchsets: [patchset(1, PS1)],
			head: {
				oid: NEW,
				mergeBase: "e".repeat(40),
				baseBranch: "main",
				commits: 2,
			},
		});
		renderTab(
			() => facts(given({ to: { head: NEW, patchset: null }, changes: SAME })),
			info,
		);
		const c = await card();
		const since = await within(c).findByTestId("verdict-since");
		expect(since).toHaveAttribute("data-state", "same");
		expect(since).toHaveTextContent("Rebased, same diff · nothing to re-read");
		// No patch set to meter yet (the verdict starts it).
		expect(within(c).queryByTestId("verdict-since-meter")).toBeNull();
		const again = within(c).getByRole("button", {
			name: "Approve again on 0c1d2e3",
		});
		expect(again).toHaveTextContent("Approve again on 0c1d2e3");
		await userEvent.click(again);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ event: "APPROVE", commit: NEW });
	});

	it("an identical diff with a cluster the engine calls new is never nothing to re-read", async () => {
		renderTab(() =>
			facts(
				given({
					to: { head: NEW, patchset: null },
					changes: { ...SAME, files: 1, new: 1 },
				}),
			),
		);
		const c = await card();
		const since = await within(c).findByTestId("verdict-since");
		expect(since).toHaveAttribute("data-state", "changed");
		expect(since).toHaveTextContent(
			"Since then: 2 commits · 1 file · 1 new cluster",
		);
		expect(within(c).queryByText(/nothing to re-read/)).toBeNull();
		expect(
			within(c).queryByRole("button", { name: /Approve again/ }),
		).toBeNull();
	});

	it("requested changes on a same diff: the copy, but no Approve again", async () => {
		renderTab(() =>
			facts(given({ state: "CHANGES_REQUESTED", changes: SAME })),
		);
		const c = await card();
		expect(await within(c).findByTestId("your-verdict")).toHaveTextContent(
			/^You requested changes a1b2c3d \(PS1\)/,
		);
		expect(within(c).getByTestId("verdict-since")).toHaveTextContent(
			"nothing to re-read",
		);
		expect(
			within(c).queryByRole("button", { name: /Approve again/ }),
		).toBeNull();
		expect(
			within(c).getByRole("button", { name: "Approve f9e8d7c" }),
		).toBeInTheDocument();
	});

	it("spins in its slot while the engine computes, never says nothing or 0; then the counts", async () => {
		const held = heldJson();
		let calls = 0;
		renderTab(() => {
			calls += 1;
			return calls === 1
				? facts(given({ changes: { status: "pending" } }))
				: held.response;
		});
		const c = await card();
		const since = await within(c).findByTestId("verdict-since");
		expect(since).toHaveAttribute("aria-busy", "true");
		expect(
			within(since).getByRole("status", {
				name: "Comparing with your verdict",
			}),
		).toBeInTheDocument();
		expect(within(c).queryByText(/nothing to re-read/)).toBeNull();
		expect(within(c).queryByText(/\b0 /)).toBeNull();
		expect(within(c).queryByTestId("verdict-since-meter")).toBeNull();
		// Asked again while pending (REREVIEW_POLL_MS); the answer lands.
		await waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 8000 });
		held.release(facts(given()));
		await waitFor(() =>
			expect(within(c).getByTestId("verdict-since")).toHaveAttribute(
				"data-state",
				"changed",
			),
		);
		expect(
			within(c).queryByRole("status", { name: "Comparing with your verdict" }),
		).toBeNull();
	});

	it("the head moved back onto PS1's (S6): the buttons post on it, with the older-commit note", async () => {
		const info = session({
			currentHead: PS1,
			headMoved: true,
			head: {
				oid: PS1,
				mergeBase: "e".repeat(40),
				baseBranch: "main",
				commits: 0,
			},
		});
		renderTab(
			() =>
				facts(
					given({
						head: PS2,
						patchset: 2,
						to: { head: PS1, patchset: 1 },
					}),
				),
			info,
		);
		const c = await card();
		expect(await within(c).findByTestId("verdict-older")).toHaveTextContent(
			"On a1b2c3d, an older commit",
		);
		// PS1 is no longer the session's: no meter of another patch set.
		expect(within(c).queryByTestId("verdict-since-meter")).toBeNull();
		await userEvent.click(
			within(c).getByRole("button", { name: "Approve a1b2c3d" }),
		);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ commit: PS1 });
	});

	it("a failed comparison says so, distinct from empty", async () => {
		renderTab(() =>
			facts(
				given({ changes: { status: "failed", message: "merge-tree died" } }),
			),
		);
		const since = await within(await card()).findByTestId("verdict-since");
		expect(since).toHaveAttribute("data-state", "failed");
		expect(since).toHaveTextContent(
			"Since then: couldn't be compared · merge-tree died",
		);
	});

	it("renders the verdict's link only for http(s), and every value as text", async () => {
		renderTab(() =>
			facts(
				given({
					url: "javascript:alert(1)",
					changes: {
						status: "failed",
						message: "<img src=x onerror=alert(1)>",
					},
				}),
			),
		);
		const c = await card();
		const yours = await within(c).findByTestId("your-verdict");
		expect(within(yours).queryByRole("link")).toBeNull();
		expect(within(yours).getByTestId("verdict-since-commit")).toHaveTextContent(
			"a1b2c3d",
		);
		expect(c.querySelector("img")).toBeNull();
		expect(within(c).getByTestId("verdict-since")).toHaveTextContent(
			"<img src=x onerror=alert(1)>",
		);
	});

	it("no verdict to compare: the card as before, Approve on the snapshot's head", async () => {
		renderTab(() => facts(null));
		const c = await card();
		await waitFor(() =>
			expect(
				within(c).getByRole("button", { name: "Approve" }),
			).toBeInTheDocument(),
		);
		expect(within(c).queryByTestId("verdict-since")).toBeNull();
		await userEvent.click(within(c).getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ commit: PS2 });
	});
});
