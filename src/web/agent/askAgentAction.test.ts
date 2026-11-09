import { afterEach, describe, expect, it } from "vitest";
import type { CodeSpan, SelectionContext } from "../files/selectionActions";
import { selectionActions } from "../files/selectionActions";
import {
	ASK_AGENT_ACTION,
	anchorOf,
	getAgentComposers,
	resetAgentComposers,
	spanOfAnchor,
} from "./askAgentAction";
import "./index";

const span = (more: Partial<CodeSpan> = {}): CodeSpan => ({
	path: "src/a.ts",
	commit: "h",
	subject: "line",
	startSide: "LEFT",
	startLine: 2,
	side: "RIGHT",
	line: 4,
	...more,
});

const ctx = (more: Partial<SelectionContext> = {}): SelectionContext => ({
	writes: "on",
	commentLeft: false,
	file: { binary: false, submodule: false },
	inDiff: false,
	...more,
});

afterEach(resetAgentComposers);

describe("Ask agent", () => {
	it("is registered after Comment", () => {
		expect(selectionActions().map((a) => a.id)).toEqual([
			"comment",
			"ask-agent",
		]);
		expect(ASK_AGENT_ACTION.shortcut).toBe("a");
		expect(ASK_AGENT_ACTION.label).toBe("Ask agent");
	});

	it.each<[string, Partial<SelectionContext>, CodeSpan, true | string]>([
		["a line", {}, span(), true],
		// No GitHub rule applies: expanded context, old lines with a pinned
		// head, binary files and submodules all take a question.
		["expanded context", { inDiff: false }, span(), true],
		["old lines", { commentLeft: false }, span({ startSide: "LEFT" }), true],
		[
			"a binary file",
			{ file: { binary: true, submodule: false } },
			span(),
			true,
		],
		[
			"a submodule's file",
			{ file: { binary: false, submodule: true } },
			span({ subject: "file" }),
			true,
		],
		[
			"as of a cutoff",
			{ writes: "as-of" },
			span(),
			"Your agent is off as of a cutoff",
		],
		[
			"as someone else",
			{ writes: "viewer" },
			span(),
			"Your agent is off when viewing as someone else",
		],
	])("on %s", (_name, more, s, want) => {
		expect(ASK_AGENT_ACTION.available(s, ctx(more))).toBe(want);
	});

	it("opens one composer per span", () => {
		ASK_AGENT_ACTION.start(span());
		ASK_AGENT_ACTION.start(span());
		expect(getAgentComposers()).toMatchObject([{ span: span(), focus: true }]);
		ASK_AGENT_ACTION.start(span({ line: 9 }));
		expect(getAgentComposers()).toHaveLength(2);
	});

	it("turns a span into a stored anchor and back", () => {
		const s = span({ startCol: 1, endCol: 4 });
		const a = anchorOf(s);
		expect(a).toEqual({
			subject: "line",
			path: "src/a.ts",
			commit: "h",
			side: "RIGHT",
			line: 4,
			startSide: "LEFT",
			startLine: 2,
			startCol: 1,
			endCol: 4,
		});
		expect(a && spanOfAnchor(a)).toEqual(s);
		expect(anchorOf({ path: "b", commit: "h", subject: "file" })).toEqual({
			subject: "file",
			path: "b",
			commit: "h",
		});
		expect(anchorOf(span({ line: undefined }))).toBeNull();
	});
});
