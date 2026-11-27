// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DiffLine,
	type FileHunks,
	type FileView,
	type PrOverview,
	SAME_AS_BASE,
	type SessionInfo,
} from "../../shared/types";
import { ASK_AGENT_ACTION, resetAgentComposers } from "../agent/askAgentAction";
import { ShortcutsProvider } from "../shortcuts";
import { contextRanges } from "./contextRanges";
import { DiffBody } from "./DiffBody";
import { setPicks } from "./linePicks";
import { SelectionBar } from "./SelectionBar";
import { registerSelectionAction } from "./selectionActions";

vi.mock("./highlight", () => ({
	languageFor: () => null,
	highlightLine: async () => [],
}));

/*
 * CAR-293: the since view shows a line GitHub's diff (base → head) hasn't:
 * a later patch set put it back as the base had it (`offGithub`). Comment
 * is off there, with why; Ask agent stays on (a question needs no GitHub
 * line); the changed line beside it takes a comment.
 */

const PS1 = "a".repeat(40);
const HEAD = "b".repeat(40);
const PATH = "src/a.ts";

const line = (
	kind: DiffLine["kind"],
	oldNo: number | undefined,
	newNo: number | undefined,
	text: string,
	extra: Partial<DiffLine> = {},
): DiffLine => ({
	kind,
	...(oldNo === undefined ? {} : { oldNo }),
	...(newNo === undefined ? {} : { newNo }),
	text,
	...extra,
});

/* The since view (PS1 → head): line 3 put back (off GitHub's diff), line 4 changed. */
const SINCE: FileHunks = {
	newLineCount: 4,
	hunks: [
		{
			oldStart: 1,
			oldCount: 4,
			newStart: 1,
			newCount: 4,
			lines: [
				line("context", 1, 1, "one", { offGithub: true }),
				line("context", 2, 2, "two"),
				line("del", 3, undefined, "three changed", {
					clusterKey: "k1",
					baseNo: null,
				}),
				line("add", undefined, 3, "three", {
					clusterKey: "k1",
					offGithub: true,
				}),
				line("del", 4, undefined, "four", { clusterKey: "k1", baseNo: 4 }),
				line("add", undefined, 4, "four changed", { clusterKey: "k1" }),
			],
		},
	],
	pieces: [],
};

const file: FileView = {
	index: 0,
	path: PATH,
	status: "modified",
	binary: false,
	submodule: false,
	additions: 2,
	deletions: 1,
	done: false,
	reviewed: false,
	crossedOff: false,
	clusters: [
		{
			key: "k1",
			kind: "lines",
			oldStart: 3,
			oldCount: 1,
			newStart: 3,
			newCount: 2,
			removed: ["three"],
			added: ["new three", "new four"],
			lines: 3,
			state: "unreviewed",
		},
	],
};

function setup() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://test");
			if (url.pathname === "/api/files/0/hunks") {
				return new Response(JSON.stringify(SINCE));
			}
			return new Response("{}", { status: 404 });
		}),
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(["overview"], {
		readId: "r",
		writes: "on",
		commentLeft: true,
		pendingReview: null,
	} as unknown as PrOverview);
	client.setQueryData(["session"], {
		snapshotHead: HEAD,
		viewer: "me",
		pr: { owner: "o", repo: "r", number: 1 },
		patchsets: [{ number: 1, head: PS1 }],
	} as unknown as SessionInfo);
	render(
		<QueryClientProvider client={client}>
			<ShortcutsProvider>
				<section data-path={PATH}>
					<DiffBody
						file={file}
						revision="r1"
						onToggle={() => {}}
						onCrossOff={() => {}}
						from={1}
						kinds={new Map()}
						threads={{ readId: "r", snapshotHead: HEAD, threads: [] }}
					/>
				</section>
				<SelectionBar files={[file]} commit={HEAD} earlier={PS1} />
			</ShortcutsProvider>
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

const pickButton = (newNo: number) =>
	document.querySelector(
		`tr[data-new-no="${newNo}"] button[data-pick="RIGHT:${newNo}"]`,
	) as HTMLElement;

let removeAction: () => void = () => {};
beforeEach(() => {
	window.scrollTo = vi.fn();
	removeAction = registerSelectionAction(ASK_AGENT_ACTION);
	setPicks(null);
});
afterEach(() => {
	removeAction();
	cleanup();
	resetAgentComposers();
	setPicks(null);
	contextRanges.reset();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("since view: a line GitHub's diff hasn't (CAR-293)", () => {
	it("marks the row, so the page knows it", async () => {
		setup();
		await screen.findAllByTestId("diff-line");
		const row = (n: number) =>
			document.querySelector(`tr[data-new-no="${n}"]`) as HTMLElement;
		expect(row(3)).toHaveAttribute("data-off-github");
		expect(row(1)).toHaveAttribute("data-off-github");
		expect(row(4)).not.toHaveAttribute("data-off-github");
		expect(row(2)).not.toHaveAttribute("data-off-github");
	});

	it("picked: Comment off with why, Ask agent on", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(pickButton(3));
		const bar = within(await screen.findByTestId("selection-bar"));
		const comment = bar.getByRole("button", { name: "Comment" });
		expect(comment).toHaveAttribute("aria-disabled", "true");
		expect(comment).toHaveAccessibleDescription(SAME_AS_BASE);
		expect(bar.getByRole("button", { name: "Ask agent" })).not.toHaveAttribute(
			"aria-disabled",
		);
	});

	it("a range from the changed line to it: off too; the changed line alone: on", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(pickButton(4));
		const bar = within(await screen.findByTestId("selection-bar"));
		expect(bar.getByRole("button", { name: "Comment" })).not.toHaveAttribute(
			"aria-disabled",
		);
		await user.keyboard("{Shift>}");
		await user.click(pickButton(3));
		await user.keyboard("{/Shift}");
		const range = within(await screen.findByTestId("selection-bar"));
		expect(
			range.getByRole("button", { name: "Comment" }),
		).toHaveAccessibleDescription(SAME_AS_BASE);
	});

	it("asked about it: the question's Comment instead is off with why", async () => {
		const user = setup();
		await screen.findAllByTestId("diff-line");
		await user.click(pickButton(3));
		const bar = within(await screen.findByTestId("selection-bar"));
		await user.click(bar.getByRole("button", { name: "Ask agent" }));
		const box = within(await screen.findByTestId("agent-composer"));
		const instead = box.getByRole("button", { name: "Comment instead" });
		expect(instead).toHaveAttribute("aria-disabled", "true");
		expect(instead).toHaveAccessibleDescription(SAME_AS_BASE);
	});
});
