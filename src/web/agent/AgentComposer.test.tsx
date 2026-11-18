// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../../shared/types";
import { sessionQuery } from "../api";
import type { CodeSpan } from "../files/selectionActions";
import { AgentComposer } from "./AgentComposer";
import { resetAgentWrites } from "./agentWrites";
import { openAgentComposer, resetAgentComposers } from "./askAgentAction";

const lineSpan: CodeSpan = {
	path: "src/a.ts",
	commit: "h2",
	subject: "line",
	startSide: "RIGHT",
	startLine: 3,
	side: "RIGHT",
	line: 5,
};
const fileSpan: CodeSpan = { path: "src/a.ts", commit: "h2", subject: "file" };

let posts: string[];

beforeEach(() => {
	posts = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			if ((init?.method ?? "GET") !== "GET") posts.push(String(input));
			return new Promise<Response>(() => {});
		}),
	);
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	resetAgentComposers();
	resetAgentWrites();
	vi.unstubAllGlobals();
});

function show(span: CodeSpan) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(sessionQuery.queryKey, {
		viewer: "octo",
		snapshotHead: "h2",
		patchsets: [{ number: 1, head: "h2" }],
	} as unknown as SessionInfo);
	let id = "";
	act(() => {
		id = openAgentComposer(span);
	});
	render(
		<QueryClientProvider client={client}>
			<AgentComposer clientId={id} span={span} quote="const a = 1;" />
		</QueryClientProvider>,
	);
	return userEvent.setup();
}

const box = () =>
	screen.getByRole("textbox", {
		name: "Ask your agent",
	}) as HTMLTextAreaElement;
const chip = (name: string) =>
	within(screen.getByTestId("agent-composer")).getByRole("button", { name });

describe("the Ask agent composer's one-tap questions (CAR-203)", () => {
	it.each([
		["a line range", lineSpan],
		["a file", fileSpan],
	])("show on %s", (_, span) => {
		show(span);
		expect(
			within(screen.getByTestId("agent-quick-questions"))
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual([
			"Explain this code please",
			"Why this change?",
			"What calls this?",
			"Is this tested?",
		]);
	});

	it("a tap fills an empty box, appends to a typed one, keeps focus at the end, and sends nothing", async () => {
		const user = show(lineSpan);
		await user.click(chip("What calls this?"));
		expect(box()).toHaveValue("What calls this?");
		expect(box()).toHaveFocus();
		expect(box().selectionStart).toBe("What calls this?".length);
		expect(screen.getByTestId("agent-composer-ask")).toBeEnabled();
		await user.click(chip("Is this tested?"));
		expect(box()).toHaveValue("What calls this?\nIs this tested?");
		expect(box()).toHaveFocus();
		expect(box().selectionEnd).toBe(box().value.length);
		expect(posts).toEqual([]);
		// Sending stays the reviewer's: Ask sends what the box holds.
		await user.click(screen.getByTestId("agent-composer-ask"));
		expect(posts).toHaveLength(1);
	});

	it("a tap after typing goes on a new line", async () => {
		const user = show(lineSpan);
		await user.type(box(), "Hmm.");
		await user.click(chip("Why this change?"));
		expect(box()).toHaveValue("Hmm.\nWhy this change?");
		expect(posts).toEqual([]);
	});
});
