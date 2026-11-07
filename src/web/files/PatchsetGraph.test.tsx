// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { expectLoadingThen, heldJson } from "../../../test/loading";
import type { RereviewAnswer, SessionInfo } from "../../shared/types";
import { ShortcutsProvider } from "../shortcuts";
import type { Comparison, ComparisonBase, Viewing } from "./comparison";
import { headIsNewer, PatchsetGraph, railDots } from "./PatchsetGraph";

const oid = (c: string) => c.repeat(40);

const patchset = (number: number) => ({
	number,
	head: oid(String(number)),
	mergeBase: oid("0"),
	startedAt: Date.now() - number * 86_400_000,
	since: number === 1 ? null : number - 1,
	shape: number === 1 ? null : ("S1" as const),
});

function session(
	patchsets: number[],
	head: string | null,
	over: Partial<SessionInfo> = {},
): SessionInfo {
	return {
		pr: { owner: "acme", repo: "widget", number: 7, title: "T", url: "" },
		viewer: "octo",
		snapshotHead: patchsets.length ? oid(String(patchsets.at(-1))) : oid("a"),
		currentHead: head ?? oid("a"),
		headMoved: false,
		patchset: patchsets.at(-1) ?? null,
		asOf: null,
		pinnedHead: null,
		patchsets: patchsets.map(patchset),
		lastSeen: null,
		head: head
			? { oid: head, mergeBase: oid("0"), baseBranch: "main", commits: 3 }
			: null,
		...over,
	};
}

const answer = (over: Partial<RereviewAnswer> = {}): RereviewAnswer => ({
	from: 2,
	toHead: oid("f"),
	toRevision: "r3",
	shape: {
		code: "S1",
		commits: 3,
		identical: false,
		conflicts: [],
		virtualRebase: "ok",
		virtualHead: null,
	},
	interdiff: "available",
	files: [],
	toRead: { files: 1, clusters: 2 },
	threads: [],
	...over,
});

function renderGraph(
	s: SessionInfo,
	comparison: { viewing: Viewing; base: ComparisonBase },
	rereview: (
		url: URL,
	) => { status: number; body: unknown } | Promise<Response> = () => ({
		status: 200,
		body: answer(),
	}),
) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://test");
		if (url.pathname === "/api/rereview") {
			const result = rereview(url);
			if (result instanceof Promise) return result;
			return new Response(JSON.stringify(result.body), {
				status: result.status,
			});
		}
		return new Response("{}", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const setViewing = vi.fn();
	const setBase = vi.fn();
	const onViewHead = vi.fn();
	const c: Comparison = {
		...comparison,
		target: { kind: "current" },
		patchsets: s.patchsets.map((p) => p.number),
		setViewing,
		setBase,
	};
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<PatchsetGraph session={s} comparison={c} onViewHead={onViewHead} />
			</ShortcutsProvider>
		</QueryClientProvider>,
	);
	return { fetchMock, setViewing, setBase, onViewHead };
}

const tail = () => screen.getByTestId("ps-tail");
const node = (id: string) => screen.getByTestId(`ps-node-${id}`);
const markerIn = (id: string, name: "viewing" | "comparison base") =>
	within(node(id)).queryByRole("button", { name });

const ps = (number: number): Viewing => ({ kind: "patchset", number });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("railDots", () => {
	it("the branch, every patch set, and the head when newer", () => {
		const s = session([1, 2], oid("f"));
		const { dots, head } = railDots(s, ps(2));
		expect(dots.map((d) => d.id)).toEqual(["branch", "ps1", "ps2"]);
		expect(dots[0]?.label).toBe("main");
		expect(head?.label).toBe("head");
		expect(headIsNewer(s)).toBe(true);
	});
	it("no head dot when the head is the newest patch set, or unknown", () => {
		expect(railDots(session([1, 2], oid("2")), ps(2)).head).toBeNull();
		expect(headIsNewer(session([1, 2], oid("2")))).toBe(false);
		expect(railDots(session([1, 2], null), ps(2)).head).toBeNull();
	});
	it("before any patch set, the snapshot reviewed is a dot of its own", () => {
		const s = session([], oid("f"));
		const { dots, head } = railDots(s, { kind: "head", oid: oid("a") });
		expect(dots.map((d) => d.id)).toEqual(["branch", "snapshot"]);
		expect(dots[1]?.label).toBe("aaaaaaa");
		expect(head?.id).toBe("head");
	});
});

describe("PatchsetGraph", () => {
	it("up to date: the last slot says so, at its one width, with no head dot", () => {
		renderGraph(session([1, 2], oid("2")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		expect(tail()).toHaveAttribute("data-state", "up-to-date");
		expect(tail().className).toContain("w-[84px]");
		expect(tail().className).toContain("sm:w-[150px]");
		expect(screen.getByRole("img", { name: "up to date" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^head/ })).toBeNull();
		// The markers sit where the comparison says.
		expect(markerIn("ps2", "viewing")).not.toBeNull();
		expect(markerIn("ps1", "comparison base")).not.toBeNull();
		expect(markerIn("ps1", "viewing")).toBeNull();
	});

	it("a newer head: the same slot holds the dashed connector with its count and the head dot", async () => {
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		expect(tail()).toHaveAttribute("data-state", "head");
		expect(tail().className).toContain("w-[84px]");
		expect(
			screen.getByRole("button", { name: "head fffffff" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("img", { name: "up to date" })).toBeNull();
		const conn = screen.getByTestId("ps-conn-head");
		// The count comes from git at once, not from the engine.
		expect(within(conn).getByTestId("ps-conn-label")).toHaveTextContent(
			"3 commits",
		);
		expect(conn).toHaveAccessibleName("PS2 to head: 3 commits");
	});

	it("the connector's card spins in its to-read slot until the engine answers, then says the line", async () => {
		const held = heldJson();
		renderGraph(
			session([1, 2], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
			// The head's answer is held; the one between the patch sets is in.
			(url) =>
				url.searchParams.has("head")
					? held.response
					: { status: 200, body: answer({ toHead: oid("2") }) },
		);
		const conn = screen.getByTestId("ps-conn-head");
		act(() => conn.focus());
		await expectLoadingThen({
			// Inside the card (a tooltip, aria-hidden): by its test id.
			loading: () => screen.queryByTestId("rereview-pending"),
			empty: [
				() => screen.queryByText(/nothing new/),
				() => screen.queryByText(/0 files/),
			],
			release: () => held.release(answer()),
			result: () =>
				screen.queryByText("3 new commits · 1 file, 2 clusters to read"),
		});
		expect(conn).toHaveAttribute("data-tone", "warn");
	});

	it("the connector goes green when nothing is new, red for conflicts", async () => {
		renderGraph(
			session([1, 2], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
			() => ({
				status: 200,
				body: answer({
					shape: {
						code: "S4a",
						commits: 3,
						identical: true,
						conflicts: [],
						virtualRebase: "ok",
						virtualHead: null,
					},
					toRead: { files: 0, clusters: 0 },
				}),
			}),
		);
		await waitFor(() =>
			expect(screen.getByTestId("ps-conn-head")).toHaveAttribute(
				"data-tone",
				"ok",
			),
		);
		cleanup();
		renderGraph(
			session([1, 2], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
			() => ({
				status: 200,
				body: answer({
					shape: {
						code: "S4b",
						commits: 3,
						identical: false,
						conflicts: ["a.ts"],
						virtualRebase: "conflict",
						virtualHead: null,
					},
				}),
			}),
		);
		await waitFor(() =>
			expect(screen.getByTestId("ps-conn-head")).toHaveAttribute(
				"data-tone",
				"bad",
			),
		);
	});

	it("viewing the head: the viewing marker sits on the head dot, the base on the newest patch set", () => {
		renderGraph(session([1, 2], oid("f")), {
			viewing: { kind: "head", oid: oid("f") },
			base: ps(2) as ComparisonBase,
		});
		expect(markerIn("head", "viewing")).not.toBeNull();
		expect(markerIn("ps2", "comparison base")).not.toBeNull();
		expect(markerIn("ps2", "viewing")).toBeNull();
	});

	it("an old patch set: the viewing marker on it, the base on the branch", () => {
		renderGraph(session([1, 2], oid("2")), {
			viewing: ps(1),
			base: { kind: "branch" },
		});
		expect(markerIn("ps1", "viewing")).not.toBeNull();
		expect(markerIn("branch", "comparison base")).not.toBeNull();
		expect(markerIn("ps2", "viewing")).toBeNull();
	});

	it("clicking a dot views it; the branch dot makes it the comparison base", async () => {
		const user = userEvent.setup();
		const { setViewing, setBase, onViewHead } = renderGraph(
			session([1, 2], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
		);
		await user.click(screen.getByRole("button", { name: "head fffffff" }));
		expect(setViewing).toHaveBeenLastCalledWith({
			kind: "head",
			oid: oid("f"),
		});
		expect(onViewHead).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "PS1" }));
		expect(setViewing).toHaveBeenLastCalledWith({
			kind: "patchset",
			number: 1,
		});
		await user.click(
			screen.getByRole("button", { name: "main (base branch)" }),
		);
		expect(setBase).toHaveBeenLastCalledWith({ kind: "branch" });
	});

	it("Ctrl+] and Ctrl+[ move the viewing marker; with Shift the base; bare brackets move nothing", () => {
		const { setViewing, setBase } = renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const press = (key: string, init: KeyboardEventInit) =>
			fireEvent.keyDown(document.body, { key, ...init });
		press("]", { code: "BracketRight" });
		press("[", { code: "BracketLeft" });
		expect(setViewing).not.toHaveBeenCalled();
		expect(setBase).not.toHaveBeenCalled();
		// Past the newest patch set: the head.
		press("]", { ctrlKey: true, code: "BracketRight" });
		expect(setViewing).toHaveBeenLastCalledWith({
			kind: "head",
			oid: oid("f"),
		});
		press("[", { ctrlKey: true, code: "BracketLeft" });
		expect(setViewing).toHaveBeenLastCalledWith({
			kind: "patchset",
			number: 1,
		});
		press("{", { ctrlKey: true, shiftKey: true, code: "BracketLeft" });
		expect(setBase).toHaveBeenLastCalledWith({ kind: "branch" });
		// Right of the base is the viewed dot itself: the base can't go there.
		press("}", { ctrlKey: true, shiftKey: true, code: "BracketRight" });
		expect(setBase).toHaveBeenCalledTimes(1);
	});

	it("dragging the viewing marker onto the head dot views it; onto the branch does nothing", () => {
		const { setViewing, setBase } = renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const centre = (el: HTMLElement, x: number) => {
			vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
				left: x - 20,
				width: 40,
				top: 0,
				height: 40,
				right: x + 20,
				bottom: 40,
				x: x - 20,
				y: 0,
				toJSON: () => ({}),
			});
		};
		centre(screen.getByTestId("ps-dot-branch"), 10);
		centre(screen.getByTestId("ps-dot-ps1"), 110);
		centre(screen.getByTestId("ps-dot-ps2"), 210);
		centre(screen.getByTestId("ps-dot-head"), 310);
		const marker = screen.getByRole("button", { name: "viewing" });
		marker.setPointerCapture = () => {};
		fireEvent.pointerDown(marker, { pointerId: 1, clientX: 210 });
		fireEvent.pointerMove(marker, { pointerId: 1, clientX: 300 });
		expect(screen.getByTestId("ps-dot-head")).toHaveAttribute(
			"data-drop",
			"true",
		);
		fireEvent.pointerUp(marker, { pointerId: 1, clientX: 300 });
		expect(setViewing).toHaveBeenLastCalledWith({
			kind: "head",
			oid: oid("f"),
		});
		fireEvent.pointerDown(marker, { pointerId: 2, clientX: 210 });
		fireEvent.pointerUp(marker, { pointerId: 2, clientX: 12 });
		expect(setViewing).toHaveBeenCalledTimes(1);
		// The base marker: left of the viewed dot only.
		const base = screen.getByRole("button", { name: "comparison base" });
		base.setPointerCapture = () => {};
		fireEvent.pointerDown(base, { pointerId: 3, clientX: 110 });
		fireEvent.pointerUp(base, { pointerId: 3, clientX: 300 });
		expect(setBase).not.toHaveBeenCalled();
		fireEvent.pointerDown(base, { pointerId: 4, clientX: 110 });
		fireEvent.pointerUp(base, { pointerId: 4, clientX: 12 });
		expect(setBase).toHaveBeenLastCalledWith({ kind: "branch" });
	});

	it("a pinned head, a merged PR or an as-of view: neither the head dot nor up to date", () => {
		renderGraph(session([1], null, { pinnedHead: oid("1") }), {
			viewing: ps(1),
			base: { kind: "branch" },
		});
		expect(tail()).toHaveAttribute("data-state", "none");
		expect(tail()).toHaveTextContent("pinned");
		expect(screen.queryByRole("button", { name: /^head/ })).toBeNull();
		expect(screen.queryByRole("img", { name: "up to date" })).toBeNull();
	});
});
