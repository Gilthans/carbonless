// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentThread } from "../../shared/agent";
import type { ThreadPlacement } from "../../shared/rereview/placement";
import { AgentNotInComparison } from "./AgentNotInComparison";
import { agentPlaceable } from "./placeable";

afterEach(cleanup);

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const asked = (id: string, path: string): AgentThread => ({
	id,
	anchor: {
		subject: "line",
		path,
		commit: H1,
		side: "RIGHT",
		line: 3,
		startSide: "RIGHT",
		startLine: 3,
	},
	openedBy: "human",
	at: "2026-11-07T10:00:00Z",
	messages: [{ id: "m", by: "human", at: "2026-11-07T10:00:00Z", text: "Q?" }],
	resolved: false,
	waiting: false,
});

describe("AgentNotInComparison", () => {
	it("lists each as its agent card under its path: an outside one with its fate, one not traced yet marked as asked on an earlier version", () => {
		const placements = new Map<string, ThreadPlacement>([
			["REV", { kind: "outside", path: "rev.ts", fate: "reverted" }],
		]);
		render(
			<QueryClientProvider client={new QueryClient()}>
				<AgentNotInComparison
					threads={[asked("REV", "rev.ts"), asked("REN", "old.ts")].map(
						agentPlaceable,
					)}
					snapshotHead={H2}
					placements={placements}
				/>
			</QueryClientProvider>,
		);
		const group = screen.getByRole("region", {
			name: "Agent threads not in this comparison",
		});
		const [rev, ren] = within(group).getAllByTestId("agent-outside") as [
			HTMLElement,
			HTMLElement,
		];
		expect(rev).toHaveAttribute("data-fate", "reverted");
		expect(within(rev).getByTestId("agent-outside-fate")).toHaveTextContent(
			"The commented change has been reverted since the review",
		);
		expect(rev).toHaveTextContent("rev.ts");
		expect(within(rev).getByTestId("agent-thread")).toHaveClass(
			"border-agent-edge",
		);
		expect(within(ren).queryByTestId("agent-outside-fate")).toBeNull();
		expect(ren).toHaveTextContent("old.ts");
		expect(
			within(ren).getByRole("img", {
				name: "Asked on an earlier version (1111111)",
			}),
		).toBeTruthy();
	});
});
