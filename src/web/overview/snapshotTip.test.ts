import { describe, expect, it } from "vitest";
import type { CodeWindow } from "../../shared/types";
import { snapshotTip } from "./OverviewPage";

const NOW = Date.parse("2026-01-04T09:00:00Z");
const code = (
	snapshot: CodeWindow["snapshot"],
	anchor: { commit?: string; at?: string } = {},
): CodeWindow => ({
	anchor: {
		path: "a.ts",
		commit: anchor.commit ?? "b19a0aa0123456789abcdef0123456789abcdef0",
		side: "RIGHT",
		line: 1,
		startSide: "RIGHT",
		startLine: 1,
		at: anchor.at ?? "2026-01-01T09:00:00Z",
	},
	rows: [],
	source: "clone",
	snapshot,
});

describe("snapshotTip", () => {
	it("says which commit and when, then why, about the commenter", () => {
		expect(
			snapshotTip(code({ same: false, reason: "diff-differs" }), NOW),
		).toBe(
			"Made on b19a0aa, 3 days ago, in another diff; the code shown may differ from what the commenter saw.",
		);
		expect(
			snapshotTip(code({ same: false, reason: "no-host-diff" }), NOW),
		).toBe(
			"Made on b19a0aa, 3 days ago; GitHub kept no diff to check it against, so the code shown may differ from what the commenter saw.",
		);
	});

	it("claims no reason when the verdict is missing", () => {
		expect(snapshotTip(code(undefined), NOW)).toBe(
			"Made on b19a0aa, 3 days ago; the code shown may differ from what the commenter saw.",
		);
	});

	it("leaves out a commit or a time it doesn't know", () => {
		const differs = { same: false, reason: "diff-differs" } as const;
		expect(snapshotTip(code(differs, { commit: "" }), NOW)).toBe(
			"Made 3 days ago, in another diff; the code shown may differ from what the commenter saw.",
		);
		expect(snapshotTip(code(differs, { at: "" }), NOW)).toBe(
			"Made on b19a0aa, in another diff; the code shown may differ from what the commenter saw.",
		);
		expect(snapshotTip(code(differs, { commit: "", at: "" }), NOW)).toBe(
			"The code shown may differ from what the commenter saw.",
		);
	});
});
