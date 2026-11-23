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
import { expectLoadingThen, heldJson } from "../../../test/loading";
import { fileFlags, reviewProgress } from "../../shared/progress";
import type {
	ClusterState,
	ClusterView,
	FileView,
	PrOverview,
	ReviewView,
	SessionInfo,
	VerdictFacts,
	VerdictRequest,
	VerdictSince,
} from "../../shared/types";
import { createAppRouter } from "../router";
import { ignoreWhitespace } from "../viewSettings";
import { nothingToReread, sinceCounts, sinceLine } from "./VerdictCard";

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
	revision: `r${number}`,
	baseBranch: "main",
	startedAt: Date.parse("2026-11-05T10:00:00Z"),
	since: number === 1 ? null : number - 1,
	shape: number === 1 ? null : ("S1" as const),
	commits: number,
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
	/** A POST's answer before the default (a landed review); null: the default. */
	refuse: (req: VerdictRequest) => Response | null = () => null,
	/**
	 * The head check's answer (else none), the overview's (else at once),
	 * GET /api/review's for the session's patch set (else `review`).
	 */
	more: {
		head?: Promise<Response>;
		overview?: Promise<Response>;
		reviewOf?: (patchset: number | null) => ReviewView;
	} = {},
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
					return more.overview ?? json(overview);
				case "/api/head":
					return more.head ?? new Response("{}", { status: 404 });
				case "/api/review":
					return json((more.reviewOf ?? review)(info.patchset));
				case "/api/threads":
					return json({ threads: [], complete: true });
				case "/api/timeline":
					return json({ events: [], gaps: [] });
				case "/api/verdict": {
					if (init?.method === "POST") {
						const req = JSON.parse(String(init.body)) as VerdictRequest;
						posted.push(req);
						const refused = refuse(req);
						if (refused) return refused;
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
	return { fetchMock, client };
}

const card = () => screen.findByTestId("verdict-card-tab");

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
	ignoreWhitespace.reset();
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

	it("counts the whole line with or without whitespace-only clusters by the switch (CAR-266)", () => {
		const done = {
			...(given().changes as Extract<
				VerdictSince["changes"],
				{ status: "done" }
			>),
			withoutWhitespaceOnly: { files: 1, reworked: 0, new: 1 },
		};
		expect(sinceLine(sinceCounts(done, false))).toBe(
			"3 commits · 2 files · 1 reworked, 1 new cluster",
		);
		expect(sinceLine(sinceCounts(done, true))).toBe(
			"3 commits · 1 file · 1 new cluster",
		);
		// Nothing whitespace-only: the same counts either way.
		const { withoutWhitespaceOnly: _, ...plain } = done;
		expect(sinceCounts(plain, true)).toEqual(plain);
		// An identical diff of only whitespace-only clusters: nothing to re-read
		// with the switch on, its clusters counted with it off.
		const same = {
			...SAME,
			new: 1,
			withoutWhitespaceOnly: { files: 0, reworked: 0, new: 0 },
		} as Extract<VerdictSince["changes"], { status: "done" }>;
		expect(nothingToReread(sinceCounts(same, true))).toBe(true);
		expect(nothingToReread(sinceCounts(same, false))).toBe(false);
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

	it("Ignore whitespace on, an identical diff of only whitespace-only clusters: nothing to re-read and Approve again, both (CAR-266)", async () => {
		ignoreWhitespace.set(true);
		renderTab(() =>
			facts(
				given({
					to: { head: NEW, patchset: null },
					changes: {
						...SAME,
						files: 1,
						new: 1,
						withoutWhitespaceOnly: { files: 0, reworked: 0, new: 0 },
					} as typeof SAME,
				}),
			),
		);
		const c = await card();
		const since = await within(c).findByTestId("verdict-since");
		expect(since).toHaveTextContent("Rebased, same diff · nothing to re-read");
		expect(
			within(c).getByRole("button", { name: /^Approve again on / }),
		).toBeInTheDocument();
		// Off: the cluster counts, on the line and the button alike.
		act(() => ignoreWhitespace.set(false));
		await waitFor(() =>
			expect(since).toHaveTextContent(
				"Since then: 2 commits · 1 file · 1 new cluster",
			),
		);
		expect(
			within(c).queryByRole("button", { name: /Approve again/ }),
		).toBeNull();
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

	it("a head check that lands before the card shows still brings the since line, pending meanwhile (CAR-180)", async () => {
		// The page opens on PS2 approved, nothing since (no since line); the
		// head check finds NEW past it while the overview is still on its
		// way, so the card mounts already on NEW. The answer it has was
		// asked before NEW: it asks again, the since line pending and the
		// verdicts held meanwhile (never "nothing since", nor Approve on the
		// old head), then the since line comes.
		// The server answers against the head it knows: NEW once the head
		// check has run.
		let serverHead = PS2;
		const onPs2 = given({ head: PS2, patchset: 2 });
		const overviewHeld = heldJson();
		const headHeld = heldJson();
		const asked: string[] = [];
		const again = heldJson();
		// Gates, not findBy's clock: the first read is in, the head landed.
		let firstAsked = () => {};
		const firstAsk = new Promise<void>((r) => {
			firstAsked = r;
		});
		const { client } = renderTab(
			() => {
				const head = serverHead;
				asked.push(head);
				firstAsked();
				return head === NEW ? again.response : { ...facts(onPs2), since: null };
			},
			session(),
			() => null,
			{ head: headHeld.response, overview: overviewHeld.response },
		);
		await firstAsk;
		const landed = new Promise<void>((r) => {
			const stop = client.getQueryCache().subscribe(() => {
				if (client.getQueryData<SessionInfo>(["session"])?.head?.oid === NEW) {
					stop();
					r();
				}
			});
		});
		serverHead = NEW;
		headHeld.release(
			session({
				head: {
					oid: NEW,
					mergeBase: "e".repeat(40),
					baseBranch: "main",
					commits: 1,
				},
			}),
		);
		await landed;
		overviewHeld.release(overview);
		const c = await card();
		await expectLoadingThen({
			loading: () =>
				within(c).queryByRole("status", {
					name: "Comparing with your verdict",
				}),
			empty: [
				() => within(c).queryByTestId("verdict-older"),
				() =>
					within(c)
						.queryAllByTestId("verdict-since")
						.find((el) => el.dataset.state !== "pending") ?? null,
				() =>
					within(c)
						.queryAllByTestId(/^verdict-(approve|comment|request_changes)$/)
						.find((el) => el.getAttribute("aria-disabled") !== "true") ?? null,
			],
			release: () =>
				again.release(facts({ ...onPs2, to: { head: NEW, patchset: null } })),
			result: () =>
				within(c)
					.queryAllByTestId("verdict-since")
					.find((el) => el.dataset.state === "changed") ?? null,
		});
		expect(within(c).getByTestId("verdict-approve")).not.toHaveAttribute(
			"aria-disabled",
		);
		expect(asked).toEqual([PS2, NEW]);
	});
	it("the head moved back onto PS1's (S6): the buttons post on it, the card says the head moved back to PS1", async () => {
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
		// The PR's head now, which is an earlier patch set's commit: said so,
		// never "an older commit".
		const back = await within(c).findByTestId("verdict-moved-back");
		expect(back).toHaveTextContent(/^Head moved back to PS1$/);
		expect(within(c).queryByTestId("verdict-older")).toBeNull();
		// PS1 is no longer the session's: no meter of another patch set.
		expect(within(c).queryByTestId("verdict-since-meter")).toBeNull();
		await userEvent.click(
			within(c).getByRole("button", { name: "Approve a1b2c3d" }),
		);
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({ commit: PS1 });
	});

	it("Retry of a refused verdict posts on the commit the button names, not the snapshot's head", async () => {
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
		let refusals = 1;
		renderTab(
			() => facts(given({ to: { head: NEW, patchset: null } })),
			info,
			() =>
				refusals-- > 0
					? new Response(
							JSON.stringify({ error: "GitHub said no", code: "invalid" }),
							{ status: 422 },
						)
					: null,
		);
		const c = await card();
		await userEvent.click(
			await within(c).findByRole("button", { name: "Approve 0c1d2e3" }),
		);
		const item = await screen.findByTestId("refused-write");
		await userEvent.click(
			within(item).getByRole("button", { name: /^Retry / }),
		);
		await waitFor(() => expect(posted).toHaveLength(2));
		expect(posted.map((r) => r.commit)).toEqual([NEW, NEW]);
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

describe('the verdict card follows "Ignore whitespace" (CAR-184)', () => {
	const c = (
		key: string,
		state: ClusterState,
		lines: number,
		whitespaceOnly = false,
	): ClusterView => ({
		key,
		kind: "lines",
		oldStart: 1,
		oldCount: 1,
		newStart: 1,
		newCount: 1,
		removed: [],
		added: [],
		lines,
		state,
		...(whitespaceOnly ? { whitespaceOnly: true as const } : {}),
	});
	// A reviewed change (4 lines) and an unreviewed whitespace-only cluster (2).
	const clusters = [c("a", "reviewed", 4), c("w", "unreviewed", 2, true)];
	const files: FileView[] = [
		{
			index: 0,
			path: "src/a.ts",
			status: "modified",
			binary: false,
			submodule: false,
			additions: 3,
			deletions: 3,
			clusters,
			...fileFlags(clusters),
		},
	];
	const wsReview = (patchsetNo: number | null): ReviewView => ({
		revision: "r2",
		patchset: patchsetNo,
		files,
		progress: reviewProgress(files),
	});
	const leftOut = (el: HTMLElement) =>
		within(el).queryByRole("img", {
			name: "1 whitespace-only cluster not counted",
		});

	it("off: every cluster counts, no `~`", async () => {
		renderTab(
			() => facts(given()),
			session(),
			() => null,
			{ reviewOf: wsReview },
		);
		const card_ = await card();
		const info = await within(card_).findByTestId("verdict-info");
		expect(info).toHaveTextContent("You reviewed 4 of 6 lines");
		expect(
			await within(card_).findByTestId("verdict-since-meter"),
		).toHaveTextContent("1 / 2 on PS2");
		expect(leftOut(card_)).toBeNull();
	});

	it("on, every cluster whitespace-only: no lines to count, but the `~` still says one was left out", async () => {
		ignoreWhitespace.set(true);
		const only = [c("w", "unreviewed", 2, true)];
		const onlyFiles: FileView[] = [
			{ ...(files[0] as FileView), clusters: only, ...fileFlags(only) },
		];
		renderTab(
			() => facts(given()),
			session(),
			() => null,
			{
				reviewOf: (patchsetNo) => ({
					revision: "r2",
					patchset: patchsetNo,
					files: onlyFiles,
					progress: reviewProgress(onlyFiles),
				}),
			},
		);
		const card_ = await card();
		const info = await within(card_).findByTestId("verdict-info");
		expect(info).not.toHaveTextContent("You reviewed");
		expect(leftOut(info)).not.toBeNull();
	});

	it("on: the whitespace-only cluster is left out, all reads reviewed, with the `~`", async () => {
		ignoreWhitespace.set(true);
		renderTab(
			() => facts(given()),
			session(),
			() => null,
			{ reviewOf: wsReview },
		);
		const card_ = await card();
		const info = await within(card_).findByTestId("verdict-info");
		expect(info).toHaveTextContent("You reviewed 4 of 4 lines");
		expect(leftOut(info)).not.toBeNull();
		const since = await within(card_).findByTestId("verdict-since");
		expect(
			await within(since).findByTestId("verdict-since-meter"),
		).toHaveTextContent("1 / 1 on PS2");
		expect(leftOut(since)).not.toBeNull();
		// Off again: counted again, unreviewed.
		act(() => ignoreWhitespace.set(false));
		await waitFor(() =>
			expect(info).toHaveTextContent("You reviewed 4 of 6 lines"),
		);
		expect(within(card_).getByTestId("verdict-since-meter")).toHaveTextContent(
			"1 / 2 on PS2",
		);
		expect(leftOut(card_)).toBeNull();
	});
});

describe("the verdict's message: Write / Preview (CAR-202)", () => {
	it("opens in Write; previewed, Comment posts the text as typed", async () => {
		renderTab(() => facts(null));
		const c = await card();
		await userEvent.click(within(c).getByTestId("verdict-include"));
		const box = within(c).getByRole("textbox", { name: "Message" });
		expect(within(c).queryByRole("button", { name: "Preview" })).toBeNull();
		await userEvent.type(box, "Looks **good**");
		expect(within(c).getByRole("button", { name: "Write" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await userEvent.click(within(c).getByRole("button", { name: "Preview" }));
		const preview = within(c).getByTestId("comment-preview");
		expect(within(preview).getByText("good").tagName).toBe("STRONG");
		expect(within(c).queryByRole("textbox", { name: "Message" })).toBeNull();
		// The checkbox controls what shows: the preview while previewing.
		const controls = within(c)
			.getByTestId("verdict-include")
			.getAttribute("aria-controls");
		expect(controls && document.getElementById(controls)).toContainElement(
			preview,
		);
		await userEvent.click(within(c).getByRole("button", { name: "Comment" }));
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]).toMatchObject({
			event: "COMMENT",
			body: "Looks **good**",
		});
	});
});
