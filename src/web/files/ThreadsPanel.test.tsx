// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileView } from "../../shared/types";
import { conversation, reviewThread } from "../agent/threadAgentFixtures";
import { FileTree, type SidebarTab, type ThreadsCount } from "./FileTree";
import {
	readSidebar,
	SIDEBAR_DEFAULT,
	type SidebarState,
	sidebarKey,
	useSidebarState,
	writeSidebar,
} from "./sidebarState";
import { ShowResolvedToggle, ThreadsPanel } from "./ThreadsPanel";
import { agentRows, githubRows, type PanelRow } from "./threadRows";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const people = githubRows(
	[
		reviewThread({
			id: "old",
			path: "src/deep/dir/old.ts",
			line: 3,
			lastActivityAt: "2026-01-01T00:00:00Z",
			lastAuthor: { login: "rev1", avatarUrl: "", bot: false },
		}),
		reviewThread({
			id: "new",
			path: "new.ts",
			line: null,
			lastActivityAt: "2026-01-09T00:00:00Z",
			lastAuthor: { login: "octo-author", avatarUrl: "", bot: false },
			yourTurn: true,
		}),
		reviewThread({
			id: "done",
			path: "done.ts",
			resolved: true,
			lastActivityAt: "2026-01-10T00:00:00Z",
		}),
	],
	new Map(),
);
const ai = agentRows([conversation({ unread: true })], new Map(), new Map());

function Panel(props: {
	people: PanelRow[] | null;
	ai: PanelRow[] | null;
	onJump?: (row: PanelRow) => void;
	peopleError?: boolean;
}) {
	const [state, setState] = useState<SidebarState>(SIDEBAR_DEFAULT);
	return (
		<>
			<ShowResolvedToggle
				on={state.showResolved}
				onChange={(showResolved) => setState((s) => ({ ...s, showResolved }))}
			/>
			<ThreadsPanel
				people={props.people}
				peopleError={props.peopleError ?? false}
				ai={props.ai}
				aiError={false}
				state={state}
				onState={(c) => setState((s) => ({ ...s, ...c }))}
				onJump={props.onJump ?? (() => {})}
			/>
		</>
	);
}

const region = (name: string) => screen.getByRole("region", { name });
const rowNames = (name: string) =>
	within(region(name))
		.queryAllByTestId("threads-row")
		.map((r) => r.getAttribute("data-key"));

describe("ThreadsPanel", () => {
	it("lists each region's conversations newest first, resolved ones hidden until the toggle", async () => {
		const user = userEvent.setup();
		render(<Panel people={people} ai={ai} />);
		expect(rowNames("People")).toEqual(["gh:new", "gh:old"]);
		expect(rowNames("AI")).toEqual(["ai:A1"]);
		expect(
			within(region("People")).getByTestId("threads-count"),
		).toHaveProperty("textContent", "2");
		const toggle = screen.getByRole("button", { name: "Show resolved" });
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		await user.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(rowNames("People")).toEqual(["gh:done", "gh:new", "gh:old"]);
		expect(
			within(region("People")).getByTestId("threads-count").textContent,
		).toBe("3");
	});

	it("names each row by where it is, who spoke last and its cues", () => {
		render(<Panel people={people} ai={ai} />);
		const rows = within(region("People")).getAllByRole("button", {
			name: /last by/,
		});
		expect(rows[0]?.getAttribute("aria-label")).toBe(
			"new.ts, last by octo-author, your turn",
		);
		expect(rows[1]?.getAttribute("aria-label")).toBe(
			"src/deep/dir/old.ts:3, last by rev1",
		);
		expect(
			within(region("AI"))
				.getByRole("button", { name: /last by/ })
				.getAttribute("aria-label"),
		).toBe("src/cache.ts:4, last by the agent, new agent message");
		// The date beside each row.
		expect(region("People").querySelectorAll("time[datetime]").length).toBe(2);
	});

	it("each row says what it's about beneath; a bar while it's read, never a blank", () => {
		const rows = githubRows(
			[
				reviewThread({ id: "r", excerpt: "Should this expire?" }),
				reviewThread({
					id: "l",
					loaded: false,
					excerpt: "",
					lastActivityAt: "2026-01-01T00:00:00Z",
				}),
			],
			new Map(),
		);
		render(<Panel people={rows} ai={[]} />);
		const [read, loading] = within(region("People")).getAllByTestId(
			"threads-row",
		);
		expect(
			within(read as HTMLElement).getByTestId("threads-row-blurb").textContent,
		).toBe("Should this expire?");
		expect(
			within(loading as HTMLElement).getByTestId("threads-row-blurb-loading"),
		).toBeTruthy();
		expect(
			within(loading as HTMLElement).queryByTestId("threads-row-blurb"),
		).toBeNull();
	});

	it("a row whose text failed to load says so beneath", () => {
		const rows = githubRows(
			[reviewThread({ id: "f", loaded: false, excerpt: "" })],
			new Map(),
			{ contentFailed: true },
		);
		render(<Panel people={rows} ai={[]} />);
		const failed = within(region("People")).getByTestId(
			"threads-row-blurb-failed",
		);
		expect(failed.textContent).toBe("Couldn't load");
		expect(
			within(region("People")).queryByTestId("threads-row-blurb-loading"),
		).toBeNull();
	});

	it("a row goes to its thread", async () => {
		const user = userEvent.setup();
		const onJump = vi.fn();
		render(<Panel people={people} ai={ai} onJump={onJump} />);
		await user.click(
			within(region("People")).getByRole("button", { name: /^src\/deep/ }),
		);
		expect(onJump).toHaveBeenCalledWith(
			expect.objectContaining({
				key: "gh:old",
				focus: { id: "old" },
			}),
		);
	});

	it("folds a region from its header", async () => {
		const user = userEvent.setup();
		render(<Panel people={people} ai={ai} />);
		const header = within(region("AI")).getByRole("button", { name: "AI, 1" });
		expect(header.getAttribute("aria-expanded")).toBe("true");
		await user.click(header);
		expect(header.getAttribute("aria-expanded")).toBe("false");
		expect(
			within(region("AI")).queryByRole("button", { name: /last by/ }),
		).toBeNull();
		// Its count stays.
		expect(within(region("AI")).getByTestId("threads-count").textContent).toBe(
			"1",
		);
	});

	it("while loading, a region spins: never a 0 or an empty list", () => {
		render(<Panel people={null} ai={null} />);
		for (const name of ["People", "AI"]) {
			const r = region(name);
			expect(r.getAttribute("aria-busy")).toBe("true");
			expect(
				within(r).getByRole("button", { name: `${name}, loading` }),
			).toBeTruthy();
			expect(
				within(r).getByRole("status", { name: `Loading ${name}` }),
			).toBeTruthy();
			expect(within(r).queryByTestId("threads-count")).toBeNull();
			expect(within(r).queryAllByTestId("threads-row")).toEqual([]);
		}
	});

	it("an empty region is its header with 0, nothing more", () => {
		render(<Panel people={[]} ai={[]} />);
		expect(
			within(region("People")).getByTestId("threads-count").textContent,
		).toBe("0");
		expect(region("People").textContent).toBe("People0");
		expect(
			within(region("People")).getByRole("button", { name: "People, 0" }),
		).toBeTruthy();
	});

	it("a failed region says so in its count's place", () => {
		render(<Panel people={null} ai={ai} peopleError />);
		expect(
			within(region("People")).getByRole("img", { name: "Couldn't load" }),
		).toBeTruthy();
		expect(region("People").getAttribute("aria-busy")).toBeNull();
		expect(
			within(region("People")).getByRole("button", {
				name: "People, couldn't load",
			}),
		).toBeTruthy();
	});
});

const files: FileView[] = [
	{
		index: 0,
		path: "src/a.ts",
		status: "modified",
		binary: false,
		submodule: false,
		additions: 1,
		deletions: 1,
		done: false,
		crossedOff: false,
		clusters: [],
	} as unknown as FileView,
];

function Tree(props: { count: ThreadsCount }) {
	const [tab, setTab] = useState<SidebarTab>("files");
	return (
		<FileTree
			files={files}
			unit="lines"
			current={null}
			onSelect={() => {}}
			tabs={{
				tab,
				onTab: setTab,
				count: props.count,
				panel: <p>the panel</p>,
				controls: <button type="button">resolved toggle</button>,
			}}
		/>
	);
}

describe("FileTree's tabs", () => {
	it("switches between Files and Threads, each with its own controls", async () => {
		const user = userEvent.setup();
		render(<Tree count={{ state: "open", n: 3 }} />);
		const tabs = screen.getByRole("tablist", { name: "Sidebar" });
		const filesTab = within(tabs).getByRole("tab", { name: "Files" });
		const threadsTab = within(tabs).getByRole("tab", {
			name: "Threads, 3 open",
		});
		expect(filesTab.getAttribute("aria-selected")).toBe("true");
		expect(screen.getByRole("navigation", { name: "Files" })).toBeTruthy();
		expect(screen.queryByText("resolved toggle")).toBeNull();
		await user.click(threadsTab);
		expect(threadsTab.getAttribute("aria-selected")).toBe("true");
		const panel = screen.getByRole("tabpanel");
		expect(panel.getAttribute("aria-labelledby")).toBe(threadsTab.id);
		expect(within(panel).getByText("the panel")).toBeTruthy();
		expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
		expect(screen.getByText("resolved toggle")).toBeTruthy();
		// Arrow keys move between the tabs.
		await user.keyboard("{ArrowLeft}");
		expect(filesTab.getAttribute("aria-selected")).toBe("true");
		expect(document.activeElement).toBe(filesTab);
	});

	it("the Threads tab spins while its count is unknown, never 0", () => {
		render(<Tree count={{ state: "loading" }} />);
		const tab = screen.getByRole("tab", { name: "Threads, loading" });
		expect(within(tab).queryByTestId("threads-open")).toBeNull();
	});

	it("the Threads tab names a region that failed, never a count without it", () => {
		render(<Tree count={{ state: "failed", what: "People" }} />);
		const tab = screen.getByRole("tab", {
			name: "Threads, couldn't load People",
		});
		expect(within(tab).getByTestId("threads-tab-failed")).toBeTruthy();
		expect(within(tab).queryByTestId("threads-open")).toBeNull();
	});
});

describe("the sidebar's state", () => {
	const key = sidebarKey({ owner: "o", repo: "r", number: 7 });

	it("is kept per PR, each field checked", () => {
		expect(readSidebar(key)).toEqual(SIDEBAR_DEFAULT);
		writeSidebar(key, { ...SIDEBAR_DEFAULT, tab: "threads", aiFolded: true });
		expect(readSidebar(key)).toMatchObject({ tab: "threads", aiFolded: true });
		expect(
			readSidebar(sidebarKey({ owner: "o", repo: "r", number: 8 })),
		).toEqual(SIDEBAR_DEFAULT);
		localStorage.setItem(key, '{"tab":"bogus","showResolved":"yes"}');
		expect(readSidebar(key)).toEqual(SIDEBAR_DEFAULT);
		localStorage.setItem(key, "not json");
		expect(readSidebar(key)).toEqual(SIDEBAR_DEFAULT);
	});

	it("the hook stores each change", async () => {
		const user = userEvent.setup();
		function Probe() {
			const [s, set] = useSidebarState(key);
			return (
				<button type="button" onClick={() => set({ tab: "threads" })}>
					{s.tab}
				</button>
			);
		}
		render(<Probe />);
		await user.click(screen.getByRole("button", { name: "files" }));
		expect(screen.getByRole("button", { name: "threads" })).toBeTruthy();
		expect(readSidebar(key).tab).toBe("threads");
	});
});
