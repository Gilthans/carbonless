// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fate } from "../../shared/rereview/placement";
import type { ReviewThread } from "../../shared/types";
import { NotInComparison } from "./NotInComparison";
import {
	PlacementChip,
	type PlacementInfo,
	PlacementProvider,
	UnplacedRow,
	UnplacedThreads,
} from "./ThreadFate";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

afterEach(cleanup);

const HOSTILE = '<img src=x onerror="window.pwned=1">';

const thread = (extra: Partial<ReviewThread> = {}): ReviewThread => ({
	id: "T1",
	path: `src/${HOSTILE}.ts`,
	line: 3,
	currentLine: null,
	loaded: true,
	excerpt: `Look <b>here</b> ${HOSTILE}`,
	html: "",
	body: "",
	createdAt: "2026-01-01T00:00:00Z",
	lastActivityAt: "2026-01-01T00:00:00Z",
	author: HOSTILE,
	bot: false,
	avatarUrl: "",
	participants: [],
	commentCount: 1,
	hasReply: false,
	outdated: false,
	resolved: false,
	code: {
		anchor: {
			path: `src/${HOSTILE}.ts`,
			commit: "a".repeat(40),
			side: "RIGHT",
			line: 3,
			startSide: "RIGHT",
			startLine: 3,
			at: "2026-01-01T00:00:00Z",
		},
		rows: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
			kind: "context" as const,
			oldNo: n,
			newNo: n,
			text: n === 3 ? HOSTILE : `line ${n}`,
			marked: n === 3,
		})),
		source: "clone",
		snapshot: { same: true },
	},
	anchor: null,
	commit: "a".repeat(40),
	subject: "line",
	attention: [],
	yourTurn: false,
	viewerCan: { reply: false, resolve: false, unresolve: false },
	...extra,
});

const info = (over: Partial<PlacementInfo> = {}): PlacementInfo => ({
	placements: null,
	pending: false,
	error: null,
	retry: () => {},
	readId: "r1",
	to: { patchset: 2 },
	placeOn: null,
	openedOn: () => 1,
	...over,
});

function wrap(value: PlacementInfo, children: ReactNode) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<PlacementProvider value={value}>{children}</PlacementProvider>
		</QueryClientProvider>
	);
}

describe("Not in this comparison", () => {
	it("lists a thread by its original path, file deleted, its code cut to the commented line ±2; text from GitHub and git stays text", () => {
		const t = thread();
		render(
			wrap(
				info(),
				<NotInComparison
					threads={[
						{
							thread: t,
							placement: { kind: "outside", path: t.path, fate: "file-gone" },
						},
					]}
					readId="r1"
					pending={false}
				/>,
			),
		);
		const group = screen.getByTestId("not-in-comparison");
		expect(group.textContent).toContain("Not in this comparison");
		expect(group.textContent).toContain("1 thread");
		expect(group.textContent).toContain(
			"Commented file has been deleted since the review",
		);
		expect(group.textContent).toContain(`src/${HOSTILE}.ts`);
		expect(group.textContent).toContain(HOSTILE);
		expect(screen.getByTestId("original-code-label").textContent).toBe(
			`PS1 · src/${HOSTILE}.ts · line 3`,
		);
		expect(screen.getAllByTestId("original-code-line")).toHaveLength(5);
		// Nothing of it became markup.
		expect(group.querySelector("img[src='x']")).toBeNull();
		expect(group.querySelector("b")).toBeNull();
		expect((window as { pwned?: number }).pwned).toBeUndefined();
	});

	it("spins while the placements are on their way, never an empty group", () => {
		render(
			wrap(
				info({ pending: true }),
				<NotInComparison threads={[]} readId="r1" pending />,
			),
		);
		expect(
			screen.getByRole("status", { name: "Placing threads" }),
		).toBeTruthy();
		expect(screen.queryByTestId("not-in-comparison")).toBeNull();
	});

	it("is nothing at all once the placements say there is nothing outside", () => {
		const { container } = render(
			wrap(
				info(),
				<NotInComparison threads={[]} readId="r1" pending={false} />,
			),
		);
		expect(container.textContent).toBe("");
	});
});

describe("when the placements fail", () => {
	it("lists every thread not shown where it was made, says why, and retries; never an empty group", async () => {
		const t = thread();
		const retry = vi.fn();
		render(
			wrap(
				info({ error: new Error("git failed") }),
				<NotInComparison
					threads={[]}
					readId="r1"
					pending={false}
					failed={{ threads: [t], error: new Error("git failed"), retry }}
				/>,
			),
		);
		const group = screen.getByTestId("placements-failed");
		expect(group.textContent).toContain("Thread places couldn't be computed");
		expect(group.textContent).toContain("git failed");
		expect(group.textContent).toContain("1 thread");
		const row = screen.getByTestId("unplaced-thread");
		expect(row.getAttribute("data-fate")).toBe("unknown");
		expect(row.textContent).toContain(
			"Couldn't work out where this thread is now",
		);
		expect(row.textContent).toContain(`src/${HOSTILE}.ts`);
		screen.getByRole("button", { name: "Retry" }).click();
		expect(retry).toHaveBeenCalledOnce();
		expect(screen.queryByTestId("not-in-comparison")).toBeNull();
	});

	it("a card's chip says its place is unknown, not loading and not placed", () => {
		render(
			wrap(
				info({ error: new Error("git failed") }),
				<PlacementChip thread={thread()} />,
			),
		);
		expect(screen.getByTestId("placement-error").textContent).toContain(
			"place unknown",
		);
		expect(screen.queryByRole("status")).toBeNull();
	});
});

describe("PlacementChip", () => {
	it("spins in its slot while pending, says changed since, a fate, or nothing", () => {
		const t = thread();
		const { rerender } = render(
			wrap(info({ pending: true }), <PlacementChip thread={t} />),
		);
		expect(
			screen.getByRole("status", { name: "Placing threads" }),
		).toBeTruthy();
		const anchor = {
			path: "a.ts",
			startSide: "RIGHT" as const,
			startLine: 3,
			side: "RIGHT" as const,
			line: 3,
		};
		rerender(
			wrap(
				info({
					placements: new Map([
						[
							t.id,
							{
								kind: "changed",
								anchor,
								old: { side: "RIGHT", startLine: 3, line: 3, text: ["x"] },
								now: ["y"],
							},
						],
					]),
				}),
				<PlacementChip thread={t} />,
			),
		);
		expect(screen.getByTestId("placement-changed").textContent).toContain(
			"changed since",
		);
		rerender(
			wrap(
				info({
					placements: new Map([
						[
							t.id,
							{ kind: "unplaced", fate: "moved", path: "b.ts", nearest: null },
						],
					]),
				}),
				<PlacementChip thread={t} />,
			),
		);
		expect(screen.getByTestId("placement-fate").textContent).toContain(
			"moved?",
		);
		rerender(
			wrap(
				info({
					placements: new Map([
						[t.id, { kind: "placed", anchor, changed: false }],
					]),
				}),
				<PlacementChip thread={t} />,
			),
		);
		expect(screen.queryByTestId("placement-fate")).toBeNull();
		expect(screen.queryByTestId("placement-changed")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});
});

describe("UnplacedRow", () => {
	afterEach(() => vi.unstubAllGlobals());

	it.each<[Fate | null, string]>([
		["deleted", "Commented line has been deleted since the review"],
		["rewritten", "Commented line has been rewritten since the review"],
		["reverted", "The commented change has been reverted since the review"],
		[
			"base-changed",
			"The base changed under the commented line since the review",
		],
		["file-gone", "Commented file has been deleted since the review"],
		[null, "Couldn't work out where this thread is now"],
	])("its top row says the fate %s in a sentence", (fate, sentence) => {
		render(
			wrap(info(), <UnplacedRow thread={thread()} readId="r1" fate={fate} />),
		);
		const top = screen.getByTestId("unplaced-fate");
		expect(top.textContent).toBe(sentence);
		// One line on a phone: truncated, never wrapped.
		expect(top.className).toContain("truncate");
	});

	it("moved? names where the line may have gone, as text", () => {
		render(
			wrap(
				info(),
				<UnplacedRow
					thread={thread()}
					readId="r1"
					fate="moved"
					movedTo={`lib/${HOSTILE}.ts`}
				/>,
			),
		);
		const top = screen.getByTestId("unplaced-fate");
		expect(top.textContent).toBe(
			`Commented line may have moved to lib/${HOSTILE}.ts`,
		);
		expect(top.querySelector("img")).toBeNull();
	});

	it("the original code sits in a titled box: Original Reviewed Change, then where it was", () => {
		render(
			wrap(
				info(),
				<UnplacedRow thread={thread()} readId="r1" fate="deleted" />,
			),
		);
		const box = screen.getByTestId("original-code");
		expect(within(box).getByTestId("original-code-title").textContent).toBe(
			"Original Reviewed Change",
		);
		expect(within(box).getByTestId("original-code-label").textContent).toBe(
			`PS1 · src/${HOSTILE}.ts · line 3`,
		);
		expect(box.className).toContain("border");
	});

	it("the first comment shows at once, sanitized; Show more reveals the replies", async () => {
		const user = userEvent.setup();
		const comment = (id: string, author: string, html: string) => ({
			id,
			author,
			bot: false,
			avatarUrl: "",
			publishedAt: "2026-01-01T00:00:00Z",
			pending: false,
			html,
			body: "",
			text: "",
			editedAt: null,
			viewerCan: { update: false, delete: false },
			deleted: false,
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			const body =
				url.pathname === "/api/comments"
					? {
							threads: [
								{
									threadId: "T1",
									comments: [
										comment("c1", "octo", "<p>Look here</p>"),
										comment("c2", "rev1", "<p>A reply</p>"),
									],
								},
							],
						}
					: null;
			return new Response(JSON.stringify(body ?? {}), {
				status: body ? 200 : 404,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		render(
			wrap(
				info(),
				<UnplacedRow
					thread={thread({
						author: "octo",
						html: `<p>Look <b>here</b></p>${HOSTILE}`,
						commentCount: 2,
						hasReply: true,
					})}
					readId="r1"
					fate="deleted"
				/>,
			),
		);
		const first = screen.getByTestId("unplaced-opener");
		expect(first.textContent).toContain("octo");
		expect(first.querySelector("time")).not.toBeNull();
		expect(within(first).getByText("here").tagName).toBe("B");
		// GitHub's HTML is sanitized: the handler is gone.
		expect(first.querySelector("img[onerror]")).toBeNull();
		expect((window as { pwned?: number }).pwned).toBeUndefined();
		// The replies wait behind Show more.
		expect(screen.queryByText("A reply")).toBeNull();
		const more = screen.getByRole("button", { name: /^Show more/ });
		expect(more).toHaveAttribute("aria-expanded", "false");
		expect(more.textContent).toContain("1 reply");
		await user.click(more);
		await waitFor(() => expect(screen.getByText("A reply")).toBeTruthy());
		// The opener isn't repeated among them.
		expect(screen.getAllByText("Look")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});
});

describe("a resolved unplaced thread", () => {
	it("is one quiet line, after the unresolved ones; a click expands the full row, and Collapse folds it", async () => {
		const user = userEvent.setup();
		const open = thread({ id: "T1", author: "octo" });
		const done = thread({
			id: "T2",
			author: "rev1",
			resolved: true,
			html: "<p>Old remark</p>",
		});
		render(
			wrap(
				info(),
				<NotInComparison
					threads={[
						{
							thread: done,
							placement: { kind: "outside", path: "a.ts", fate: "file-gone" },
						},
						{
							thread: open,
							placement: { kind: "outside", path: "b.ts", fate: "file-gone" },
						},
					]}
					readId="r1"
					pending={false}
				/>,
			),
		);
		const group = screen.getByTestId("not-in-comparison");
		// Counted nowhere: the badge says the unresolved one only.
		expect(group.textContent).toContain("1 thread");
		const rows = screen.getAllByTestId("unplaced-thread");
		expect(rows.map((r) => r.dataset.thread)).toEqual(["T1", "T2"]);
		const quiet = rows[1] as HTMLElement;
		expect(quiet).toHaveAttribute("data-resolved", "true");
		const line = within(quiet).getByTestId("unplaced-collapsed");
		expect(line.textContent).toBe("File deleted · a.ts · rev1");
		// Its name says what it shows, the path too.
		expect(line).toHaveAccessibleName(
			"Resolved thread by rev1: File deleted · a.ts. Expand",
		);
		expect(line).toHaveAttribute("aria-expanded", "false");
		expect(line.className).toContain("text-muted");
		// No code, no comment while collapsed.
		expect(within(quiet).queryByTestId("original-code")).toBeNull();
		expect(within(quiet).queryByTestId("unplaced-opener")).toBeNull();
		await user.click(line);
		const full = screen.getAllByTestId("unplaced-thread")[1] as HTMLElement;
		expect(within(full).getByTestId("original-code")).toBeTruthy();
		expect(within(full).getByText("Old remark")).toBeTruthy();
		await user.click(within(full).getByRole("button", { name: "Collapse" }));
		expect(
			within(
				screen.getAllByTestId("unplaced-thread")[1] as HTMLElement,
			).getByTestId("unplaced-collapsed"),
		).toBeTruthy();
	});

	it("unresolving restores the full row at once; resolving collapses it", () => {
		const t = thread({ id: "T3" });
		const { rerender } = render(
			wrap(info(), <UnplacedRow thread={t} readId="r1" fate="deleted" />),
		);
		expect(screen.getByTestId("original-code")).toBeTruthy();
		rerender(
			wrap(
				info(),
				<UnplacedRow
					thread={{ ...t, resolved: true }}
					readId="r1"
					fate="deleted"
				/>,
			),
		);
		expect(screen.getByTestId("unplaced-collapsed").textContent).toContain(
			"Line deleted",
		);
		expect(screen.queryByTestId("original-code")).toBeNull();
		rerender(
			wrap(info(), <UnplacedRow thread={t} readId="r1" fate="deleted" />),
		);
		expect(screen.queryByTestId("unplaced-collapsed")).toBeNull();
		expect(screen.getByTestId("unplaced-fate").textContent).toBe(
			"Commented line has been deleted since the review",
		);
	});
});

describe("a resolved thread's placement chip", () => {
	it("is muted, never red or yellow: placed so it never vanishes, not to ask for attention", () => {
		const anchor = {
			path: "a.ts",
			startSide: "RIGHT" as const,
			startLine: 3,
			side: "RIGHT" as const,
			line: 3,
		};
		const t = thread({ resolved: true });
		const { rerender } = render(
			wrap(
				info({
					placements: new Map([
						[
							t.id,
							{
								kind: "changed",
								anchor,
								old: { side: "RIGHT", startLine: 3, line: 3, text: ["x"] },
								now: ["y"],
							},
						],
					]),
				}),
				<PlacementChip thread={t} />,
			),
		);
		const tone = (id: string) =>
			(screen.getByTestId(id).querySelector("span") as HTMLElement).className;
		expect(tone("placement-changed")).toContain("text-ink-soft");
		expect(tone("placement-changed")).not.toMatch(/text-(warn|bad)/);
		rerender(
			wrap(
				info({
					placements: new Map([
						[
							t.id,
							{
								kind: "unplaced",
								fate: "deleted",
								path: "a.ts",
								nearest: null,
							},
						],
					]),
				}),
				<PlacementChip thread={t} />,
			),
		);
		expect(tone("placement-fate")).toContain("text-ink-soft");
		expect(tone("placement-fate")).not.toMatch(/text-(warn|bad)/);
	});
});

describe("the per-file unplaced list", () => {
	it("its badge counts unresolved threads only, and is gone when all are resolved", () => {
		const fate = (t: ReviewThread) => ({
			thread: t,
			placement: {
				kind: "unplaced" as const,
				fate: "deleted" as const,
				path: "a.ts",
				nearest: null,
			},
		});
		const open = thread({ id: "U1" });
		const done = thread({ id: "U2", resolved: true });
		const { rerender } = render(
			wrap(
				info(),
				<UnplacedThreads
					fates={[fate(done), fate(open)]}
					readId="r1"
					path="a.ts"
					fileIndex={0}
				/>,
			),
		);
		const list = screen.getByTestId("unplaced-threads");
		expect(list.textContent).toContain("1 unplaced");
		rerender(
			wrap(
				info(),
				<UnplacedThreads
					fates={[fate(done)]}
					readId="r1"
					path="a.ts"
					fileIndex={0}
				/>,
			),
		);
		expect(screen.getByTestId("unplaced-threads").textContent).not.toMatch(
			/unplaced/,
		);
		expect(screen.getByTestId("unplaced-collapsed")).toBeTruthy();
	});
});
