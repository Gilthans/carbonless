import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../../../shared/agent";
import { agentView } from "./agentView";

const status = (s: Partial<AgentStatus>): AgentStatus => ({
	state: "off",
	configured: true,
	since: "2026-11-12T10:00:00Z",
	waiting: 0,
	...s,
});

describe("agentView", () => {
	it("loads until the status is in", () => {
		expect(agentView(undefined)).toBe("loading");
	});

	it("is connected iff a session joined or the spawn flag is set, whatever the state", () => {
		expect(agentView(status({ state: "off" }))).toBe("setup");
		expect(agentView(status({ state: "off", spawned: true }))).toBe(
			"connected",
		);
		expect(agentView(status({ state: "error", spawned: true }))).toBe(
			"connected",
		);
		expect(agentView(status({ state: "elsewhere", spawned: true }))).toBe(
			"connected",
		);
		expect(
			agentView(
				status({
					state: "ready",
					via: "mcp",
					joined: { name: "s", machine: "m", since: "2026-11-12T10:00:00Z" },
				}),
			),
		).toBe("connected");
		// A ready runner with no flag and no join is not this review's agent.
		expect(agentView(status({ state: "ready" }))).toBe("setup");
	});
});
