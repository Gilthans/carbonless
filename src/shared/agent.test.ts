import { describe, expect, it } from "vitest";
import { type AgentAnchor, isAgentQuestion } from "./agent.js";

const span: AgentAnchor = { subject: "file", path: "a.ts", commit: "" };
const onThread: AgentAnchor = {
	subject: "thread",
	thread: "PRRT_1",
	path: "a.ts",
	commit: "",
};
const review: AgentAnchor = { subject: "review" };

describe("isAgentQuestion", () => {
	it("a resolved review thread still asks (it is never resolved)", () => {
		expect(
			isAgentQuestion({ waiting: true, resolved: true, anchor: review }),
		).toBe(true);
	});
	it("a resolved GitHub thread conversation still asks (it was asked)", () => {
		expect(
			isAgentQuestion({ waiting: true, resolved: true, anchor: onThread }),
		).toBe(true);
	});
	it("a resolved span thread doesn't; an open one does", () => {
		expect(
			isAgentQuestion({ waiting: true, resolved: true, anchor: span }),
		).toBe(false);
		expect(
			isAgentQuestion({ waiting: true, resolved: false, anchor: span }),
		).toBe(true);
	});
	it("nothing asks when nothing waits", () => {
		for (const anchor of [span, onThread, review]) {
			expect(isAgentQuestion({ waiting: false, resolved: false, anchor })).toBe(
				false,
			);
		}
	});
});
