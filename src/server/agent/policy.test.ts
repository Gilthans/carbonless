import type {
	PermissionOption,
	RequestPermissionRequest,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { decidePermission } from "./policy.js";

const OPTIONS: PermissionOption[] = [
	{ optionId: "a1", name: "Allow", kind: "allow_once" },
	{ optionId: "a2", name: "Always", kind: "allow_always" },
	{ optionId: "r1", name: "Reject", kind: "reject_once" },
	{ optionId: "r2", name: "Never", kind: "reject_always" },
];

const req = (
	kind: ToolKind | null,
	over: Partial<RequestPermissionRequest["toolCall"]> = {},
	options = OPTIONS,
): RequestPermissionRequest => ({
	sessionId: "s",
	toolCall: { toolCallId: "t", title: "a tool", kind, ...over },
	options,
});
const chose = (id: string) => ({
	outcome: { outcome: "selected", optionId: id },
});

describe("decidePermission at open", () => {
	const kinds: Array<ToolKind | null> = [
		"read",
		"edit",
		"delete",
		"move",
		"search",
		"execute",
		"think",
		"fetch",
		"switch_mode",
		"other",
		null,
	];
	it.each(kinds)("allows %s with allow_once", (kind) => {
		expect(decidePermission(req(kind), "open")).toEqual({
			response: chose("a1"),
			decision: "allowed",
		});
	});

	it("allows git push and gh through execute", () => {
		for (const command of ["git push origin HEAD", "gh pr merge 7"]) {
			const d = decidePermission(
				req("execute", { rawInput: { command } }),
				"open",
			);
			expect(d.decision).toBe("allowed");
		}
	});

	it("rejects a switch into plan mode, by rawInput or by title", () => {
		const reason = "carbonless keeps the session out of plan mode";
		expect(
			decidePermission(
				req("switch_mode", { rawInput: { mode: "plan" } }),
				"open",
			),
		).toEqual({ response: chose("r1"), decision: "rejected", reason });
		expect(
			decidePermission(
				req("switch_mode", { title: "Enter plan mode" }),
				"open",
			),
		).toEqual({ response: chose("r1"), decision: "rejected", reason });
	});

	it("allows a switch to acceptEdits", () => {
		expect(
			decidePermission(
				req("switch_mode", {
					title: "Switch mode",
					rawInput: { mode: "acceptEdits" },
				}),
				"open",
			).decision,
		).toBe("allowed");
	});

	it("falls back to allow_always, then to reject_always", () => {
		const noOnce = OPTIONS.filter((o) => !o.kind.endsWith("_once"));
		expect(decidePermission(req("edit", {}, noOnce), "open").response).toEqual(
			chose("a2"),
		);
		expect(
			decidePermission(
				req("switch_mode", { rawInput: { mode: "plan" } }, noOnce),
				"open",
			).response,
		).toEqual(chose("r2"));
	});

	it("takes the first option when none is an allow", () => {
		const odd = [{ optionId: "x", name: "?", kind: "reject_once" as const }];
		expect(decidePermission(req("read", {}, odd), "open")).toMatchObject({
			response: chose("x"),
		});
	});

	it("cancels with no options", () => {
		expect(decidePermission(req("read", {}, []), "open").response).toEqual({
			outcome: { outcome: "cancelled" },
		});
		expect(
			decidePermission(
				req(
					"switch_mode",
					{ rawInput: { mode: "plan" } },
					OPTIONS.filter((o) => o.kind.startsWith("allow")),
				),
				"open",
			).response,
		).toEqual({ outcome: { outcome: "cancelled" } });
	});
});
