// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { ReviewThread } from "../../shared/types";
import { ThreadBubble } from "../files/ThreadBubble";
import { AgentBubble } from "./AgentBubble";

afterEach(cleanup);

const agentThread = (resolved: boolean): AgentThread => ({
	id: "A1",
	anchor: { subject: "file", path: "a.ts", commit: "h" },
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [],
	resolved,
	waiting: false,
	unread: false,
});

describe("a resolved agent bubble", () => {
	it("stays the agent's (tint, edge, sparkle) with the check; a resolved comment bubble has neither", () => {
		render(
			<AgentBubble
				threads={[agentThread(true)]}
				open={false}
				onToggle={() => {}}
				where="on line 3"
			/>,
		);
		const agent = screen.getByTestId("agent-bubble");
		expect(agent).toHaveAccessibleName("1 agent thread on line 3, resolved");
		const pill = agent.querySelector("[data-resolved]") as HTMLElement;
		expect(pill.className).toContain("bg-agent");
		expect(pill.className).toContain("border-agent-edge");
		expect(pill.querySelector(".octicon-sparkle-fill")).not.toBeNull();
		expect(pill.querySelector(".octicon-check")).not.toBeNull();
		cleanup();
		render(
			<ThreadBubble
				threads={[
					{ resolved: true, commentCount: 1, yourTurn: false } as ReviewThread,
				]}
				open={false}
				onToggle={() => {}}
			/>,
		);
		const comment = screen.getByTestId("thread-bubble");
		expect(comment.querySelector(".octicon-sparkle-fill")).toBeNull();
		expect(comment.innerHTML).not.toContain("bg-agent");
	});

	it("is never part of a text selection, like a comment bubble", () => {
		render(
			<AgentBubble
				threads={[agentThread(false)]}
				open={false}
				onToggle={() => {}}
				where="on line 3"
			/>,
		);
		const agent = screen.getByTestId("agent-bubble");
		const button = agent.matches("button")
			? agent
			: (agent.querySelector("button") as HTMLElement);
		expect(button).toHaveClass("select-none");
	});
});

describe("an agent bubble's count", () => {
	it("counts unresolved threads only; all resolved, it counts them with the check", () => {
		const t = (id: string, resolved: boolean) => ({
			...agentThread(resolved),
			id,
		});
		render(
			<AgentBubble
				threads={[t("A", false), t("R", true), t("B", false)]}
				open={false}
				onToggle={() => {}}
				where="on line 3"
			/>,
		);
		const agent = screen.getByTestId("agent-bubble");
		expect(agent).toHaveAccessibleName("2 agent threads on line 3");
		expect(agent).toHaveTextContent(/^2$/);
	});
});

describe("an agent bubble's unread dot", () => {
	it("shows while a thread under it is unread, with the count in its name", () => {
		const unread = { ...agentThread(false), id: "U", unread: true };
		const { rerender } = render(
			<AgentBubble
				threads={[agentThread(false), unread]}
				open={false}
				onToggle={() => {}}
				where="on line 3"
			/>,
		);
		const bubble = screen.getByTestId("agent-bubble");
		expect(bubble).toHaveAccessibleName("2 agent threads on line 3, 1 new");
		expect(screen.getByTestId("agent-unread-dot").className).toContain(
			"bg-accent",
		);
		rerender(
			<AgentBubble
				threads={[agentThread(false)]}
				open={false}
				onToggle={() => {}}
				where="on line 3"
			/>,
		);
		expect(screen.queryByTestId("agent-unread-dot")).toBeNull();
		expect(screen.getByTestId("agent-bubble")).toHaveAccessibleName(
			"1 agent thread on line 3",
		);
	});
});
