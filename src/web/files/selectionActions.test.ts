import { ZapIcon } from "@primer/octicons-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAME_AS_BASE } from "../../shared/types";
import { askAgentAvailable } from "../agent/askAgentAction";
import { getComposers, resetComposers } from "../threads/newThreads";
import {
	COMMENT_ACTION,
	type CodeSpan,
	commentAvailable,
	describeSpan,
	EARLIER_ONLY,
	MIXED_COMMITS,
	NO_GITHUB_LINE,
	registerSelectionAction,
	type SelectionContext,
	selectionActions,
	subscribeSelectionActions,
} from "./selectionActions";

const span = (more: Partial<CodeSpan> = {}): CodeSpan => ({
	path: "src/a.ts",
	commit: "h",
	subject: "line",
	startSide: "RIGHT",
	startLine: 2,
	side: "RIGHT",
	line: 2,
	startCol: 4,
	endCol: 9,
	...more,
});

const ctx = (more: Partial<SelectionContext> = {}): SelectionContext => ({
	writes: "on",
	commentLeft: true,
	file: { binary: false, submodule: false },
	...more,
});

afterEach(resetComposers);

describe("selection actions", () => {
	it("offers Comment, and a later kind joins by registering one entry", () => {
		expect(selectionActions().map((a) => a.id)).toEqual(["comment"]);
		const started: CodeSpan[] = [];
		const told = vi.fn();
		const off = subscribeSelectionActions(told);
		const remove = registerSelectionAction({
			id: "ask",
			icon: ZapIcon,
			label: "Ask",
			available: (s) => (s.subject === "file" ? "Lines only" : true),
			start: (s) => started.push(s),
		});
		expect(told).toHaveBeenCalledTimes(1);
		const [comment, ask] = selectionActions();
		expect(comment?.id).toBe("comment");
		expect(ask?.available(span(), ctx())).toBe(true);
		expect(ask?.available(span({ subject: "file" }), ctx())).toBe("Lines only");
		ask?.start(span());
		expect(started).toEqual([span()]);
		remove();
		off();
		expect(selectionActions().map((a) => a.id)).toEqual(["comment"]);
	});

	it("Comment opens a composer on the span", () => {
		COMMENT_ACTION.start(span());
		expect(getComposers()).toMatchObject([{ span: span(), focus: true }]);
		// The same span again: the same composer, not a second one.
		COMMENT_ACTION.start(span());
		expect(getComposers()).toHaveLength(1);
	});
});

describe("commentAvailable", () => {
	it("is on for lines and files when writing is on", () => {
		expect(commentAvailable(span(), ctx())).toBe(true);
		expect(commentAvailable(span({ subject: "file" }), ctx())).toBe(true);
	});

	it("says why writing is off", () => {
		expect(commentAvailable(span(), ctx({ writes: "as-of" }))).toBe(
			"Comments are off as of a cutoff",
		);
		expect(commentAvailable(span(), ctx({ writes: "viewer" }))).toBe(
			"Comments are off when viewing as someone else",
		);
	});

	it("is off on old lines when GitHub's merge base isn't the left side", () => {
		const left = span({ startSide: "LEFT", side: "RIGHT" });
		expect(commentAvailable(left, ctx({ commentLeft: false }))).toBe(
			"Old lines can't take comments with this pinned head",
		);
		expect(commentAvailable(left, ctx())).toBe(true);
		// RIGHT lines and file comments don't depend on it.
		expect(commentAvailable(span(), ctx({ commentLeft: false }))).toBe(true);
		expect(
			commentAvailable(span({ subject: "file" }), ctx({ commentLeft: false })),
		).toBe(true);
	});

	it("is off on lines of a binary file or a submodule, on for the file", () => {
		for (const file of [
			{ binary: true, submodule: false },
			{ binary: false, submodule: true },
		]) {
			expect(commentAvailable(span(), ctx({ file }))).toBe(
				"No lines to comment on in this file",
			);
			expect(commentAvailable(span({ subject: "file" }), ctx({ file }))).toBe(
				true,
			);
		}
	});
});

describe("commentAvailable: GitHub's diff", () => {
	it("is off on lines outside every hunk, on across hunks", () => {
		expect(commentAvailable(span(), ctx({ inDiff: false }))).toBe(
			"GitHub only takes comments on lines in the diff",
		);
		expect(commentAvailable(span({ startLine: 2, line: 40 }), ctx())).toBe(
			true,
		);
		expect(
			commentAvailable(span({ subject: "file" }), ctx({ inDiff: false })),
		).toBe(true);
	});
});

describe("commentAvailable: a line only an earlier patch set had (CAR-217)", () => {
	it("a renamed file's or a split run's earlier lines are off with their reasons (CAR-233)", () => {
		const left = span({ startSide: "LEFT", side: "LEFT" });
		expect(commentAvailable(left, ctx({ noLine: "renamed" }))).toBe(
			"Renamed since the earlier patch set",
		);
		expect(commentAvailable(left, ctx({ noLine: "split" }))).toBe(
			"Not one range on the earlier patch set",
		);
	});

	it("is off with the reason, on lines; a file comment stays on", () => {
		const left = span({ startSide: "LEFT", side: "LEFT" });
		expect(commentAvailable(left, ctx({ noLine: "earlier" }))).toBe(
			EARLIER_ONLY,
		);
		expect(EARLIER_ONLY).toBe("Not in the earlier patch set's diff on GitHub");
		// The earlier patch set's lines mixed with the head's (CAR-233).
		expect(commentAvailable(left, ctx({ noLine: "mixed" }))).toBe(
			MIXED_COMMITS,
		);
		expect(askAgentAvailable(left, ctx({ noLine: "mixed" }))).toBe(
			MIXED_COMMITS,
		);
		// A span on the earlier patch set's commit (RIGHT lines there): on.
		const onEarlier = span({
			commit: "e".repeat(40),
			earlier: true,
			startSide: "RIGHT",
			side: "RIGHT",
		});
		expect(commentAvailable(onEarlier, ctx({ commentLeft: false }))).toBe(true);
		expect(askAgentAvailable(onEarlier, ctx())).toBe(true);
		expect(
			commentAvailable(span({ subject: "file" }), ctx({ noLine: "earlier" })),
		).toBe(true);
		expect(commentAvailable(left, ctx())).toBe(true);
		// A line whose base line the view doesn't know: off, with its own reason.
		expect(commentAvailable(left, ctx({ noLine: "unknown" }))).toBe(
			NO_GITHUB_LINE,
		);
		expect(NO_GITHUB_LINE).toBe("Can't place this line on GitHub's diff");
		expect(askAgentAvailable(left, ctx({ noLine: "unknown" }))).toBe(
			NO_GITHUB_LINE,
		);
	});

	it("a since-view line GitHub's diff hasn't: Comment off with why; Ask agent on (CAR-293)", () => {
		const right = span();
		expect(
			commentAvailable(right, ctx({ inDiff: false, sameAsBase: true })),
		).toBe(SAME_AS_BASE);
		expect(SAME_AS_BASE).toBe(
			"Same as the base: GitHub can't take a comment here",
		);
		expect(commentAvailable(right, ctx({ inDiff: false }))).toBe(
			"GitHub only takes comments on lines in the diff",
		);
		expect(
			askAgentAvailable(right, ctx({ inDiff: false, sameAsBase: true })),
		).toBe(true);
	});

	it("Ask agent is off there too (the agent reads a LEFT line in the base)", () => {
		const left = span({ startSide: "LEFT", side: "LEFT" });
		expect(askAgentAvailable(left, ctx({ noLine: "earlier" }))).toBe(
			EARLIER_ONLY,
		);
		expect(askAgentAvailable(left, ctx())).toBe(true);
	});
});

describe("describeSpan", () => {
	it("says where GitHub puts it", () => {
		expect(describeSpan(span())).toBe("line 2, new");
		expect(describeSpan(span({ startSide: "LEFT", side: "LEFT" }))).toBe(
			"line 2, old",
		);
		expect(describeSpan(span({ startLine: 2, line: 5 }))).toBe(
			"lines 2–5, new",
		);
		expect(
			describeSpan(span({ startSide: "LEFT", startLine: 4, line: 6 })),
		).toBe("old 4 – new 6");
		expect(describeSpan({ path: "a", commit: "h", subject: "file" })).toBe(
			"whole file",
		);
	});
});
