// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	code: {
		anchor: {
			path,
			commit: H1,
			side: "RIGHT",
			line: 3,
			startSide: "RIGHT",
			startLine: 3,
			at: "2026-11-07T10:00:00Z",
		},
		source: "clone",
		rows: [{ kind: "add", oldNo: null, newNo: 3, text: "three", marked: true }],
	},
	resolved: false,
	waiting: false,
	unread: false,
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
		expect(within(rev).getByTestId("unplaced-fate")).toHaveTextContent(
			"The commented change has been reverted since the review",
		);
		// The code it was asked on, as a review thread's row has it.
		expect(within(rev).getByTestId("original-code-title")).toHaveTextContent(
			"Original Reviewed Change",
		);
		expect(rev).toHaveTextContent("rev.ts");
		expect(within(rev).getByTestId("agent-thread")).toHaveClass(
			"border-agent-edge",
		);
		expect(ren).toHaveAttribute("data-fate", "unknown");
		expect(ren).toHaveTextContent("old.ts");
		expect(
			within(ren).getByRole("img", {
				name: "Asked on an earlier version (1111111)",
			}),
		).toBeTruthy();
	});
});

describe("AgentNotInComparison while the agent placements load or fail", () => {
	const mount = (props: Partial<Parameters<typeof AgentNotInComparison>[0]>) =>
		render(
			<QueryClientProvider client={new QueryClient()}>
				<AgentNotInComparison
					threads={[]}
					snapshotHead={H2}
					placements={null}
					{...props}
				/>
			</QueryClientProvider>,
		);

	it("a spinner while threads wait for their place, never an empty or outdated list", () => {
		mount({ pending: true, waiting: 2 });
		const loading = screen.getByTestId("agent-placements-loading");
		expect(loading).toHaveAttribute("aria-busy", "true");
		expect(
			within(loading).getByRole("status", { name: "Placing agent threads" }),
		).toBeTruthy();
		expect(screen.queryByTestId("agent-outside")).toBeNull();
	});

	it("nothing while none waits", () => {
		mount({ pending: true, waiting: 0 });
		expect(screen.queryByTestId("agent-placements-loading")).toBeNull();
	});

	it("a failure says so, with a retry, and lists the threads that wait as unknown-fate rows (as review threads)", async () => {
		const retry = vi.fn();
		mount({
			failed: {
				error: new Error("boom"),
				retry,
				threads: [agentPlaceable(asked("W", "calc.ts"))],
			},
		});
		const failed = screen.getByTestId("agent-placements-failed");
		expect(failed).toHaveTextContent(
			"Agent thread places couldn't be computed",
		);
		expect(failed).toHaveTextContent("boom");
		const row = within(failed).getByTestId("agent-unplaced");
		expect(row).toHaveAttribute("data-fate", "unknown");
		expect(within(row).getByTestId("unplaced-fate")).toHaveTextContent(
			"Couldn't work out where this thread is now",
		);
		expect(within(row).getByTestId("agent-thread")).toBeTruthy();
		await userEvent.click(
			within(failed).getByRole("button", { name: "Retry" }),
		);
		expect(retry).toHaveBeenCalled();
	});
});
