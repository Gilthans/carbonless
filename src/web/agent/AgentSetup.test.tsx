// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCheck, AgentStatus } from "../../shared/agent";
import { AgentSetup } from "./AgentSetup";
import { agentStatusQuery } from "./api";

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

let fetchMock: ReturnType<typeof vi.fn>;
let check: AgentCheck;
beforeEach(() => {
	check = { ok: true, agent: { name: "Claude Agent", version: "0.100.0" } };
	fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/config/agent/check") return json(200, check);
		if (url === "/api/config/agent") {
			return json(200, { agent: JSON.parse(String(init?.body)) });
		}
		return json(404, { error: "no" });
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const status = (configured: boolean): AgentStatus => ({
	state: configured ? "ready" : "off",
	configured,
	since: "2026-11-07T10:00:00Z",
	waiting: 0,
});

function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				opener
			</button>
			<AgentSetup open={open} onClose={() => setOpen(false)} />
			<p data-testid="state">{open ? "open" : "closed"}</p>
		</>
	);
}

function show(configured = false) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	client.setQueryData(agentStatusQuery.queryKey, status(configured));
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	);
	return { invalidate, user: userEvent.setup() };
}

const calls = () =>
	fetchMock.mock.calls.map(([url, init]) => ({
		url,
		method: (init as RequestInit | undefined)?.method,
		body: JSON.parse(String((init as RequestInit | undefined)?.body ?? "null")),
	}));

async function openIt(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "opener" }));
	return screen.getByRole("dialog", { name: "Your agent" });
}

describe("AgentSetup", () => {
	it("picking Claude Code fills the command and shows its install line", async () => {
		const { user } = show();
		const dialog = await openIt(user);
		await user.click(within(dialog).getByRole("radio", { name: "Gemini CLI" }));
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue("gemini");
		expect(
			within(dialog).getByRole("textbox", { name: "Arguments" }),
		).toHaveValue("--acp");
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue("claude-agent-acp");
		expect(
			within(dialog).getByRole("textbox", { name: "Install" }),
		).toHaveValue("npm i -g @agentclientprotocol/claude-agent-acp");
		expect(dialog.textContent).toContain(
			"CLAUDE_CODE_EXECUTABLE=$(which claude)",
		);
		// A preset's command is its own; Other's is typed.
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveAttribute("readonly");
		await user.click(within(dialog).getByRole("radio", { name: "Other" }));
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).not.toHaveAttribute("readonly");
	});

	it("a successful Check enables Save, and Save writes the config", async () => {
		const { user, invalidate } = show();
		const dialog = await openIt(user);
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		const save = within(dialog).getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		expect(
			await within(dialog).findByTestId("agent-check-ok"),
		).toHaveTextContent("Claude Agent 0.100.0");
		expect(save).toBeEnabled();
		await user.click(save);
		await waitFor(() =>
			expect(screen.getByTestId("state")).toHaveTextContent("closed"),
		);
		expect(calls()).toEqual([
			{
				url: "/api/config/agent/check",
				method: "POST",
				body: { command: "claude-agent-acp", args: [], env: {}, leash: "open" },
			},
			{
				url: "/api/config/agent",
				method: "PUT",
				body: { command: "claude-agent-acp", args: [], env: {}, leash: "open" },
			},
		]);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: agentStatusQuery.queryKey,
		});
	});

	it("a failed Check shows why with the stderr and keeps Save off", async () => {
		check = {
			ok: false,
			error: "not logged in",
			stderr: "Run `claude /login`",
		};
		const { user } = show();
		const dialog = await openIt(user);
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		const err = await within(dialog).findByTestId("agent-check-error");
		expect(err).toHaveTextContent("not logged in");
		expect(within(dialog).getByText("Run `claude /login`").tagName).toBe("PRE");
		expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("a command changed after its Check needs another", async () => {
		const { user } = show();
		const dialog = await openIt(user);
		await user.click(within(dialog).getByRole("radio", { name: "Other" }));
		const command = within(dialog).getByRole("textbox", { name: "Command" });
		await user.type(command, "my-agent");
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await within(dialog).findByTestId("agent-check-ok");
		const save = within(dialog).getByRole("button", { name: "Save" });
		expect(save).toBeEnabled();
		await user.type(command, "2");
		expect(save).toBeDisabled();
		expect(within(dialog).queryByTestId("agent-check-ok")).toBeNull();
	});

	it("Remove writes no agent; only when one is set up", async () => {
		const first = show(false);
		await openIt(first.user);
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
		cleanup();
		const { user } = show(true);
		const dialog = await openIt(user);
		await user.click(within(dialog).getByRole("button", { name: "Remove" }));
		await waitFor(() =>
			expect(screen.getByTestId("state")).toHaveTextContent("closed"),
		);
		expect(calls().at(-1)).toEqual({
			url: "/api/config/agent",
			method: "PUT",
			body: null,
		});
	});

	it("Escape closes it and focus goes back", async () => {
		const { user } = show();
		await openIt(user);
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
		await user.keyboard("{Escape}");
		expect(screen.getByTestId("state")).toHaveTextContent("closed");
		expect(screen.getByRole("button", { name: "opener" })).toHaveFocus();
	});

	it("shows the leash as open", async () => {
		const { user } = show();
		const dialog = await openIt(user);
		expect(within(dialog).getByTestId("agent-leash")).toHaveTextContent("open");
		expect(dialog.textContent).toContain("stricter levels later");
	});
});
