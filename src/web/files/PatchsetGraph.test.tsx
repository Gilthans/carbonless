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
import { patchsetCommitsQuery, REREVIEW_POLL_MS } from "../api";
import { ShortcutsProvider } from "../shortcuts";
import type { Comparison, ComparisonBase, Viewing } from "./comparison";
import { headIsNewer, PatchsetGraph, railDots } from "./PatchsetGraph";

const oid = (c: string) => c.repeat(40);

const patchset = (number: number) => ({
	number,
	head: oid(String(number)),
	mergeBase: oid("0"),
	baseBranch: "main",
	startedAt: Date.now() - number * 86_400_000,
	since: number === 1 ? null : number - 1,
	shape: number === 1 ? null : ("S1" as const),
	commits: number * 2,
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
	comparison: { viewing: Viewing; base: ComparisonBase; baseChosen?: boolean },
	rereview: (
		url: URL,
	) => { status: number; body: unknown } | Promise<Response> = () => ({
		status: 200,
		body: answer(),
	}),
	threads: () => Promise<unknown> = async () => ({
		threads: [],
		complete: true,
	}),
	sessionAnswer?: () => Promise<SessionInfo>,
) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://test");
		if (url.pathname === "/api/overview") {
			return new Response(JSON.stringify({ readId: "r1" }), { status: 200 });
		}
		if (url.pathname === "/api/session" && sessionAnswer) {
			return new Response(JSON.stringify(await sessionAnswer()), {
				status: 200,
			});
		}
		if (url.pathname === "/api/threads") {
			return new Response(JSON.stringify(await threads()), { status: 200 });
		}
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
	const set = vi.fn();
	const onViewHead = vi.fn();
	const c: Comparison = {
		baseChosen: true,
		...comparison,
		target: { kind: "current" },
		patchsets: s.patchsets.map((p) => p.number),
		setViewing,
		setBase,
		set,
	};
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const tree = (next: SessionInfo) => (
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<PatchsetGraph session={next} comparison={c} onViewHead={onViewHead} />
			</ShortcutsProvider>
		</QueryClientProvider>
	);
	const { rerender } = render(tree(s));
	return {
		fetchMock,
		setViewing,
		setBase,
		set,
		onViewHead,
		rerender: (next: SessionInfo) => rerender(tree(next)),
	};
}

const tail = () => screen.getByTestId("ps-tail");
const node = (id: string) => screen.getByTestId(`ps-node-${id}`);
const markerIn = (id: string, name: "comparison target" | "comparison base") =>
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
		expect(markerIn("ps2", "comparison target")).not.toBeNull();
		expect(markerIn("ps1", "comparison base")).not.toBeNull();
		expect(markerIn("ps1", "comparison target")).toBeNull();
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
		// The branch's connector counts the first patch set's commits.
		expect(
			within(screen.getByTestId("ps-conn-ps1")).getByTestId("ps-conn-label"),
		).toHaveTextContent("2 commits");
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

	it("viewing the head: the comparison target sits on the head dot, the base on the newest patch set", () => {
		renderGraph(session([1, 2], oid("f")), {
			viewing: { kind: "head", oid: oid("f") },
			base: ps(2) as ComparisonBase,
		});
		expect(markerIn("head", "comparison target")).not.toBeNull();
		expect(markerIn("ps2", "comparison base")).not.toBeNull();
		expect(markerIn("ps2", "comparison target")).toBeNull();
	});

	it("an old patch set: the comparison target on it, the base on the branch", () => {
		renderGraph(session([1, 2], oid("2")), {
			viewing: ps(1),
			base: { kind: "branch" },
		});
		expect(markerIn("ps1", "comparison target")).not.toBeNull();
		expect(markerIn("branch", "comparison base")).not.toBeNull();
		expect(markerIn("ps2", "comparison target")).toBeNull();
	});

	it("a click moves nothing: it makes the dot's card sticky, whose buttons set the roles", async () => {
		const user = userEvent.setup();
		const { set, setViewing, setBase, onViewHead } = renderGraph(
			session([1, 2], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
		);
		const dot = (name: string) => screen.getByRole("button", { name });
		const card = (name: string) =>
			screen.queryByRole("dialog", { name: `${name} details` });
		const action = (name: "Comparison Base" | "Comparison Target") =>
			within(screen.getByRole("dialog")).getByRole("button", { name });
		const disabled = (name: "Comparison Base" | "Comparison Target") =>
			expect(action(name)).toHaveAttribute("aria-disabled", "true");
		const enabled = (name: "Comparison Base" | "Comparison Target") =>
			expect(action(name)).not.toHaveAttribute("aria-disabled");

		// PS1 (the comparison base): the card, no move; Target views it, the
		// base just left of it.
		expect(dot("PS1")).toHaveAttribute("aria-expanded", "false");
		await user.click(dot("PS1"));
		expect(set).not.toHaveBeenCalled();
		expect(card("PS1")).toBeInTheDocument();
		expect(dot("PS1")).toHaveAttribute("aria-expanded", "true");
		disabled("Comparison Base");
		enabled("Comparison Target");
		// Focus moved into it, on the first button it can press.
		expect(action("Comparison Target")).toHaveFocus();
		await user.click(action("Comparison Target"));
		expect(set).toHaveBeenLastCalledWith(ps(1), { kind: "branch" });
		expect(card("PS1")).toBeNull();
		expect(dot("PS1")).toHaveFocus();

		// The viewed dot: Target is taken; Base pushes the target right.
		await user.click(dot("PS2"));
		disabled("Comparison Target");
		enabled("Comparison Base");
		await user.click(dot("PS2"));
		expect(card("PS2")).toBeNull();

		// The branch: a base only.
		await user.click(dot("main (base branch)"));
		disabled("Comparison Target");
		await user.click(action("Comparison Base"));
		expect(set).toHaveBeenLastCalledWith(ps(2), { kind: "branch" });

		// The head: the only way to view it by click is a button.
		await user.click(dot("head fffffff"));
		expect(set).toHaveBeenCalledTimes(2);
		expect(onViewHead).not.toHaveBeenCalled();
		disabled("Comparison Base");
		await user.click(action("Comparison Target"));
		expect(set).toHaveBeenLastCalledWith(
			{ kind: "head", oid: oid("f") },
			{ kind: "patchset", number: 2 },
		);
		expect(onViewHead).toHaveBeenCalledTimes(1);
		expect(setViewing).not.toHaveBeenCalled();
		expect(setBase).not.toHaveBeenCalled();
	});

	it("Comparison Base on or right of the target moves both, side by side; each disabled button says why", async () => {
		const user = userEvent.setup();
		const { set, setViewing, setBase, onViewHead } = renderGraph(
			session([1, 2, 3], oid("f")),
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
		);
		const action = (name: "Comparison Base" | "Comparison Target") =>
			within(screen.getByRole("dialog")).getByRole("button", { name });
		const open = (name: string) =>
			user.click(screen.getByRole("button", { name }));
		const disabledWith = (
			name: "Comparison Base" | "Comparison Target",
			why: string,
		) => {
			expect(action(name)).toHaveAttribute("aria-disabled", "true");
			expect(action(name)).toHaveAccessibleDescription(why);
		};

		// On the target: the base goes there, the target just right of it.
		await open("PS2");
		await user.click(action("Comparison Base"));
		expect(set).toHaveBeenLastCalledWith(ps(3), {
			kind: "patchset",
			number: 2,
		});
		// Right of it, next to the head: the head is viewed (an explicit press).
		await open("PS3");
		await user.click(action("Comparison Base"));
		expect(set).toHaveBeenLastCalledWith(
			{ kind: "head", oid: oid("f") },
			{ kind: "patchset", number: 3 },
		);
		expect(onViewHead).toHaveBeenCalledTimes(1);

		// The ends, and a dot that has the role already: disabled, with why.
		await open("head fffffff");
		disabledWith(
			"Comparison Base",
			"Nothing right of it for the comparison target",
		);
		await user.click(action("Comparison Base"));
		await user.keyboard("{Escape}");
		await open("main (base branch)");
		disabledWith(
			"Comparison Target",
			"Nothing left of it for the comparison base",
		);
		await user.click(action("Comparison Target"));
		await user.keyboard("{Escape}");
		await open("PS1");
		disabledWith("Comparison Base", "Already the comparison base");
		await user.click(action("Comparison Base"));
		await user.keyboard("{Escape}");
		expect(set).toHaveBeenCalledTimes(2);
		expect(setViewing).not.toHaveBeenCalled();
		expect(setBase).not.toHaveBeenCalled();
	});

	it("up to date, the newest patch set's Comparison Base is disabled: nothing right of it", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("2")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		await user.click(screen.getByRole("button", { name: "PS2" }));
		const base = within(screen.getByRole("dialog")).getByRole("button", {
			name: "Comparison Base",
		});
		expect(base).toHaveAttribute("aria-disabled", "true");
		expect(base).toHaveAccessibleDescription(
			"Nothing right of it for the comparison target",
		);
	});

	/** The tooltips on screen (hidden ones and aria-hidden ones too). */
	const shownTips = () =>
		[...document.querySelectorAll('[role="tooltip"]:not([hidden])')].map(
			(t) => t.textContent,
		);

	it("a card opens with no tooltip showing: an enabled button needs none", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		// By a click, and by Enter (keyboard focus keeps a tooltip open).
		await user.click(screen.getByRole("button", { name: "PS1" }));
		expect(
			within(screen.getByRole("dialog")).getByRole("button", {
				name: "Comparison Target",
			}),
		).toHaveFocus();
		expect(shownTips()).toEqual([]);
		await user.keyboard("{Escape}");
		await user.keyboard("{Enter}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(shownTips()).toEqual([]);
	});

	it("only a disabled button has a tooltip: its reason", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		await user.click(screen.getByRole("button", { name: "PS1" }));
		const card = screen.getByRole("dialog");
		const target = within(card).getByRole("button", {
			name: "Comparison Target",
		});
		const base = within(card).getByRole("button", { name: "Comparison Base" });
		await user.hover(target);
		await act(() => new Promise((r) => setTimeout(r, 300)));
		expect(shownTips()).toEqual([]);
		expect(target).not.toHaveAccessibleDescription();
		await user.hover(base);
		await waitFor(() =>
			expect(shownTips()).toEqual(["Already the comparison base"]),
		);
		expect(base).toHaveAccessibleDescription("Already the comparison base");
	});

	it("the snapshot dot's card names the newest patch set's base branch", async () => {
		const user = userEvent.setup();
		const s = session([1, 2], oid("f"));
		renderGraph(
			{
				...s,
				patchsets: s.patchsets.map((p) =>
					p.number === 2 ? { ...p, baseBranch: "release" } : p,
				),
				head: {
					oid: oid("f"),
					mergeBase: oid("9"),
					baseBranch: "develop",
					commits: 3,
				},
			},
			{
				viewing: { kind: "head", oid: oid("e") },
				base: ps(2) as ComparisonBase,
			},
		);
		await user.click(screen.getByRole("button", { name: "snapshot eeeeeee" }));
		const card = screen.getByRole("dialog", { name: "eeeeeee details" });
		expect(card).toHaveTextContent("Against release at 0000000");
	});

	it("a hostile base branch name is text on the card, never markup", async () => {
		const user = userEvent.setup();
		const hostile = '<img src=x onerror="window.pwned=1">';
		const s = session([1, 2], oid("f"));
		renderGraph(
			{
				...s,
				patchsets: s.patchsets.map((p) =>
					p.number === 1 ? { ...p, baseBranch: hostile } : p,
				),
			},
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
		);
		await user.click(screen.getByRole("button", { name: "PS1" }));
		const card = screen.getByRole("dialog", { name: "PS1 details" });
		expect(card).toHaveTextContent(`Against ${hostile} at 0000000`);
		expect(card.querySelector("img")).toBeNull();
	});

	it("the sticky card closes on Escape (focus back on the dot), a click outside or the dot again; Enter opens it", async () => {
		const user = userEvent.setup();
		const { setViewing } = renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const ps1 = screen.getByRole("button", { name: "PS1" });
		await user.click(ps1);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(ps1).toHaveFocus();
		expect(ps1).toHaveAttribute("aria-expanded", "false");
		// Enter on the focused dot: the card again, nothing moved.
		await user.keyboard("{Enter}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.click(document.body);
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.click(ps1);
		await user.click(ps1);
		expect(screen.queryByRole("dialog")).toBeNull();
		await user.keyboard(" ");
		expect(setViewing).not.toHaveBeenCalled();
	});

	it("Tab past the sticky card's last stop, or Shift+Tab before its first, closes it with focus on the dot", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const head = screen.getByRole("button", { name: "head fffffff" });
		await user.click(head);
		// The head: Comparison Base is disabled (still a stop, for its
		// reason), focus starts on Target, the one it can press.
		const button = (name: string) =>
			within(screen.getByRole("dialog")).getByRole("button", { name });
		expect(button("Comparison Target")).toHaveFocus();
		await user.tab();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(head).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.tab({ shift: true });
		expect(button("Comparison Base")).toHaveFocus();
		expect(button("Comparison Base")).toHaveAccessibleDescription(
			"Nothing right of it for the comparison target",
		);
		await user.tab({ shift: true });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(head).toHaveFocus();
	});

	it("the sticky card is placed again when its content changes size", async () => {
		const observers: (() => void)[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private cb: () => void) {
					observers.push(() => this.cb());
				}
				observe() {}
				disconnect() {}
			},
		);
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const dot = screen.getByRole("button", { name: "PS1" });
		const rect = (left: number, width: number, height: number) => ({
			left,
			top: 100,
			width,
			height,
			right: left + width,
			bottom: 100 + height,
			x: left,
			y: 100,
			toJSON: () => ({}),
		});
		vi.spyOn(dot, "getBoundingClientRect").mockReturnValue(rect(500, 40, 40));
		await user.click(dot);
		const card = screen.getByRole("dialog");
		expect(card.style.left).toBe("520px");
		// Its content grew: centred under the dot again.
		vi.spyOn(card, "getBoundingClientRect").mockReturnValue(rect(0, 200, 120));
		act(() => {
			for (const o of observers) o();
		});
		expect(card.style.left).toBe("420px");
	});

	it("the label and the dot are one element: one button, one card", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const ps1 = screen.getByRole("button", { name: "PS1" });
		const label = within(node("ps1")).getByTestId("ps-dot-label");
		expect(label).toHaveTextContent("PS1");
		expect(label.closest("button")).toBe(ps1);
		const hoverCard = () =>
			screen
				.queryAllByRole("tooltip", { hidden: true })
				.find((t) => !t.hidden && t.textContent?.includes("Patch Set 1")) ??
			null;
		// Hovering the label is hovering the dot: its card.
		await user.hover(label);
		await waitFor(() => expect(hoverCard()).not.toBeNull());
		await user.click(label);
		expect(
			screen.getByRole("dialog", { name: "PS1 details" }),
		).toBeInTheDocument();
		// The hover card gives way to the sticky one.
		expect(hoverCard()).toBeNull();
	});

	it("a patch set's card says what it is: title, start, commit, base, then its threads after a spinner", async () => {
		const user = userEvent.setup();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const s = session([1, 2], oid("f"));
		const at = (ms: number) => new Date(ms).toISOString();
		const t = (createdAt: number, resolved: boolean) => ({
			createdAt: at(createdAt),
			resolved,
		});
		const ps1Start = s.patchsets[0]?.startedAt as number;
		const ps2Start = s.patchsets[1]?.startedAt as number;
		renderGraph(
			s,
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
			undefined,
			async () => {
				await gate;
				return {
					threads: [
						t(ps1Start + 1000, true),
						t(ps1Start + 2000, false),
						t(ps2Start + 1000, false),
					],
					complete: true,
				};
			},
		);
		await user.click(screen.getByRole("button", { name: "PS1" }));
		const card = screen.getByRole("dialog", { name: "PS1 details" });
		expect(card).toHaveTextContent("Patch Set 1");
		expect(card).toHaveTextContent(/Reviewed starting \S/);
		expect(within(card).getByText(/ago$/).tagName).toBe("TIME");
		expect(card).toHaveTextContent("Commit 1111111");
		expect(card).toHaveTextContent("Against main at 0000000");
		await expectLoadingThen({
			loading: () => within(card).queryByTestId("threads-pending"),
			empty: [() => within(card).queryByText(/No threads|0 threads/)],
			release,
			result: () => within(card).queryByText("2 threads created (1 resolved)"),
		});
	});

	it("the head's card: Head, not reviewed yet, its commit, its base, the commits since the newest patch set", async () => {
		const user = userEvent.setup();
		renderGraph(session([1, 2], oid("f")), {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		await user.click(screen.getByRole("button", { name: "head fffffff" }));
		const card = screen.getByRole("dialog", { name: "head details" });
		expect(card).toHaveTextContent("Head");
		expect(card).toHaveTextContent("Not reviewed yet");
		expect(card).toHaveTextContent("Commit fffffff");
		expect(card).toHaveTextContent("Against main at 0000000");
		expect(card).toHaveTextContent("3 commits since PS2");
	});

	it("after a retarget each patch set's card names its own base branch and merge base; the head's the PR's current base", async () => {
		const user = userEvent.setup();
		const s = session([1, 2], oid("f"));
		const retargeted: SessionInfo = {
			...s,
			patchsets: s.patchsets.map((p) =>
				p.number === 1 ? { ...p, baseBranch: "release" } : p,
			),
			head: {
				oid: oid("f"),
				mergeBase: oid("9"),
				baseBranch: "develop",
				commits: 3,
			},
		};
		// Whatever the comparison: the card is the dot's own.
		renderGraph(retargeted, { viewing: ps(2), base: { kind: "branch" } });
		const cardOf = async (dot: string, name: string) => {
			await user.click(screen.getByRole("button", { name: dot }));
			const card = screen.getByRole("dialog", { name: `${name} details` });
			const text = card.textContent;
			await user.keyboard("{Escape}");
			return text;
		};
		expect(await cardOf("PS1", "PS1")).toContain("Against release at 0000000");
		expect(await cardOf("PS2", "PS2")).toContain("Against main at 0000000");
		expect(await cardOf("head fffffff", "head")).toContain(
			"Against develop at 9999999",
		);
	});

	it("the counts the server is still making are asked for again until they are in, then shown", async () => {
		const s = session([1, 2], oid("f"));
		const counting: SessionInfo = {
			...s,
			patchsets: s.patchsets.map((p) => ({ ...p, commits: null })),
		};
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		renderGraph(
			counting,
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
			undefined,
			undefined,
			async () => {
				await gate;
				return s;
			},
		);
		const conn = () => screen.getByTestId("ps-conn-ps1");
		await expectLoadingThen({
			loading: () => within(conn()).queryByTestId("ps-conn-counting"),
			empty: [() => within(conn()).queryByText(/^0/)],
			release,
			result: () => within(conn()).queryByText("2 commits"),
		});
	});

	it("the count poll runs only while a count is being made: a failed or vanished one stops it", () => {
		const q = patchsetCommitsQuery(["1 aaa"]);
		const every = q.refetchInterval as (q: unknown) => number | false;
		const at = (data: unknown) => every({ state: { data } });
		expect(at(undefined)).toBe(REREVIEW_POLL_MS);
		expect(at({ "1 aaa": null })).toBe(REREVIEW_POLL_MS);
		expect(at({ "1 aaa": 3 })).toBe(false);
		expect(at({ "1 aaa": { error: "Not an object id: x" } })).toBe(false);
		expect(at({})).toBe(false);
	});

	it("a count that failed for good shows an error in its slot, never a spinner or 0; its card says why", async () => {
		const s = session([1, 2], oid("f"));
		renderGraph(
			{
				...s,
				patchsets: s.patchsets.map((p) =>
					p.number === 1
						? { ...p, commits: { error: "Not an object id: x" } }
						: p,
				),
			},
			{ viewing: ps(2), base: ps(1) as ComparisonBase },
		);
		const conn = screen.getByTestId("ps-conn-ps1");
		expect(within(conn).getByTestId("ps-conn-count-error")).toBeTruthy();
		expect(within(conn).queryByTestId("ps-conn-counting")).toBeNull();
		expect(within(conn).queryByText(/^0/)).toBeNull();
		expect(conn).toHaveAccessibleName(
			"main to PS1: couldn't count the commits",
		);
		act(() => conn.focus());
		await waitFor(() =>
			expect(
				screen.getByText(/Couldn't count the commits: Not an object id: x/),
			).toBeTruthy(),
		);
	});

	it("the branch → PS1 connector spins until the session counts PS1's commits, then shows them", () => {
		const s = session([1, 2], oid("f"));
		const counting: SessionInfo = {
			...s,
			patchsets: s.patchsets.map((p) => ({ ...p, commits: null })),
		};
		const { rerender } = renderGraph(counting, {
			viewing: ps(2),
			base: ps(1) as ComparisonBase,
		});
		const conn = () => screen.getByTestId("ps-conn-ps1");
		expect(within(conn()).getByTestId("ps-conn-counting")).toBeInTheDocument();
		expect(within(conn()).queryByText(/commit/)).toBeNull();
		rerender(s);
		expect(within(conn()).queryByTestId("ps-conn-counting")).toBeNull();
		expect(within(conn()).getByTestId("ps-conn-label")).toHaveTextContent(
			"2 commits",
		);
		expect(conn()).toHaveAccessibleName("main to PS1: 2 commits");
	});

	it("Ctrl+] and Ctrl+[ move the comparison target; with Shift the base; bare brackets move nothing", () => {
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

	it("dragging the comparison target onto the head dot views it; onto the branch does nothing", () => {
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
		const marker = screen.getByRole("button", { name: "comparison target" });
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
