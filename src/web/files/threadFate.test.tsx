// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewThread } from "../../shared/types";
import { NotInComparison } from "./NotInComparison";
import {
	PlacementChip,
	type PlacementInfo,
	PlacementProvider,
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
		expect(group.textContent).toContain("file deleted");
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
