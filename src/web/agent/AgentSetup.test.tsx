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
import { expectLoadingThen, heldJson } from "../../../test/loading";
import type { AgentCheck, AgentConfig, AgentStatus } from "../../shared/agent";
import { AgentSetup, RELOAD_HINT } from "./AgentSetup";
import { agentStatusQuery } from "./api";
import type { SetupTab } from "./setupStore";

// user-event stubs the Clipboard API; what reaches the clipboard is
// copyText's (copyText.test.ts). Here: what each outcome shows.
const copied = vi.hoisted(() => ({ ok: true, texts: [] as string[] }));
vi.mock("../copyText", () => ({
	copyText: async (text: string) => {
		copied.texts.push(text);
		return copied.ok;
	},
}));

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

let fetchMock: ReturnType<typeof vi.fn>;
let check: AgentCheck;
/** config.json's agent, as GET /api/config/agent reads it. */
let stored: { agent: AgentConfig | null; problems: string[] };
/** Holds the config read until called. */
let holdRead: Promise<void> | null;
beforeEach(() => {
	check = { ok: true, agent: { name: "Claude Agent", version: "0.100.0" } };
	stored = { agent: null, problems: [] };
	holdRead = null;
	fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "/api/config/agent/check") return json(200, check);
		if (url === "/api/config/agent" && !init?.method) {
			await holdRead;
			return json(200, stored);
		}
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
	if (configured) {
		stored = {
			agent: { command: "gemini", args: ["--acp"], env: {}, leash: "open" },
			problems: [],
		};
	}
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	);
	return { invalidate, user: userEvent.setup() };
}

/** The writes and checks sent (the config reads left out). */
const calls = () =>
	fetchMock.mock.calls
		.filter(([, init]) => (init as RequestInit | undefined)?.method)
		.map(([url, init]) => ({
			url,
			method: (init as RequestInit | undefined)?.method,
			body: JSON.parse(
				String((init as RequestInit | undefined)?.body ?? "null"),
			),
		}));

async function openIt(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "opener" }));
	const dialog = screen.getByRole("dialog", { name: "Your agent" });
	await within(dialog).findByRole("radiogroup", { name: "Harness" });
	return dialog;
}

describe("AgentSetup", () => {
	it("Copy says Copied, or Copy failed with the line selected to copy by hand", async () => {
		copied.ok = true;
		copied.texts = [];
		const { user } = show();
		const dialog = await openIt(user);
		await user.click(within(dialog).getByRole("button", { name: "Copy" }));
		expect(copied.texts).toEqual([
			"npm i -g @agentclientprotocol/claude-agent-acp",
		]);
		expect(
			await within(dialog).findByRole("button", { name: "Copied" }),
		).toBeVisible();
		// Another harness starts over.
		await user.click(within(dialog).getByRole("radio", { name: "Gemini CLI" }));
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		copied.ok = false;
		await user.click(within(dialog).getByRole("button", { name: "Copy" }));
		expect(
			await within(dialog).findByRole("button", { name: "Copy failed" }),
		).toBeVisible();
		const line = within(dialog).getByRole("textbox", { name: "Install" });
		expect(line).toHaveFocus();
		expect(
			line instanceof HTMLInputElement &&
				line.value.slice(line.selectionStart ?? 0, line.selectionEnd ?? 0),
		).toBe("npm i -g @agentclientprotocol/claude-agent-acp");
	});

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

	it("shows what is set up once it is read, a spinner until then", async () => {
		let release = () => {};
		holdRead = new Promise((r) => {
			release = r;
		});
		const { user } = show(true);
		await user.click(screen.getByRole("button", { name: "opener" }));
		const dialog = screen.getByRole("dialog", { name: "Your agent" });
		expect(
			within(dialog).getByRole("status", { name: "Loading your agent" }),
		).toBeTruthy();
		expect(within(dialog).queryByRole("radiogroup")).toBeNull();
		release();
		expect(
			await within(dialog).findByRole("radio", { name: "Gemini CLI" }),
		).toBeChecked();
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue("gemini");
	});

	it("a command no harness has shows as Other, with the config's problems", async () => {
		stored = {
			agent: { command: "my-acp", args: ["--x"], env: {}, leash: "open" },
			problems: ['agent.leash: "strict" isn\'t a level; open'],
		};
		const { user } = show();
		const dialog = await openIt(user);
		expect(within(dialog).getByRole("radio", { name: "Other" })).toBeChecked();
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue("my-acp");
		expect(
			within(dialog).getByTestId("agent-config-problems"),
		).toHaveTextContent("strict");
		expect(within(dialog).getByRole("button", { name: "Remove" })).toBeTruthy();
	});

	it("arguments with a space stay whole through the field, unedited or typed in quotes", async () => {
		stored = {
			agent: {
				command: "my-acp",
				args: ["--config", "/a path/x.json"],
				env: {},
				leash: "open",
			},
			problems: [],
		};
		const { user } = show();
		const dialog = await openIt(user);
		const field = within(dialog).getByRole("textbox", { name: "Arguments" });
		expect(field).toHaveValue('--config "/a path/x.json"');
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await within(dialog).findByTestId("agent-check-ok");
		expect(calls()[0]?.body).toMatchObject({
			args: ["--config", "/a path/x.json"],
		});
		await user.clear(field);
		await user.type(field, '--name "two words"');
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await waitFor(() => expect(calls()).toHaveLength(2));
		expect(calls()[1]?.body).toMatchObject({ args: ["--name", "two words"] });
	});

	it("Check and Save keep the env config.json has for that command", async () => {
		stored = {
			agent: {
				command: "claude-agent-acp",
				args: [],
				env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude/bin/claude" },
				leash: "open",
			},
			problems: [],
		};
		const { user } = show();
		const dialog = await openIt(user);
		expect(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		).toBeChecked();
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await within(dialog).findByTestId("agent-check-ok");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByTestId("state")).toHaveTextContent("closed"),
		);
		const kept = {
			command: "claude-agent-acp",
			args: [],
			env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude/bin/claude" },
			leash: "open",
		};
		expect(calls()).toEqual([
			{ url: "/api/config/agent/check", method: "POST", body: kept },
			{ url: "/api/config/agent", method: "PUT", body: kept },
		]);
	});

	it("another command doesn't take that env", async () => {
		stored = {
			agent: {
				command: "claude-agent-acp",
				args: [],
				env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude/bin/claude" },
				leash: "open",
			},
			problems: [],
		};
		const { user } = show();
		const dialog = await openIt(user);
		await user.click(within(dialog).getByRole("radio", { name: "Gemini CLI" }));
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await within(dialog).findByTestId("agent-check-ok");
		expect(calls()[0]?.body).toEqual({
			command: "gemini",
			args: ["--acp"],
			env: {},
			leash: "open",
		});
	});

	it("Remove spins while it is written", async () => {
		let release = () => {};
		const { user } = show(true);
		const dialog = await openIt(user);
		fetchMock.mockImplementationOnce(
			() =>
				new Promise<Response>((done) => {
					release = () => done(json(200, { agent: null }));
				}),
		);
		await user.click(within(dialog).getByRole("button", { name: /Remove/ }));
		expect(
			within(dialog).getByRole("status", { name: "Removing" }),
		).toBeTruthy();
		release();
		await waitFor(() =>
			expect(screen.getByTestId("state")).toHaveTextContent("closed"),
		);
	});

	it("opens clean: a Check that failed before is gone", async () => {
		const { user } = show();
		let dialog = await openIt(user);
		fetchMock.mockImplementationOnce(async () =>
			json(500, { error: "the server broke" }),
		);
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		expect(await within(dialog).findByText("the server broke")).toBeTruthy();
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		dialog = await openIt(user);
		expect(within(dialog).queryByText("the server broke")).toBeNull();
	});

	it("a preset's command at an absolute path is that preset, and the path is kept", async () => {
		const abs = "/srv/crb/node_modules/.bin/claude-agent-acp";
		stored = {
			agent: {
				command: abs,
				args: [],
				env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" },
				leash: "open",
			},
			problems: [],
		};
		const { user } = show();
		const dialog = await openIt(user);
		expect(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		).toBeChecked();
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue(abs);
		// Away and back: still the stored path.
		await user.click(within(dialog).getByRole("radio", { name: "Gemini CLI" }));
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue(abs);
		await user.click(within(dialog).getByRole("button", { name: "Check" }));
		await within(dialog).findByTestId("agent-check-ok");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(screen.getByTestId("state")).toHaveTextContent("closed"),
		);
		const kept = {
			command: abs,
			args: [],
			env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" },
			leash: "open",
		};
		expect(calls().slice(-2)).toEqual([
			{ url: "/api/config/agent/check", method: "POST", body: kept },
			{ url: "/api/config/agent", method: "PUT", body: kept },
		]);
	});

	it("a path whose basename is a preset's but with other arguments is Other", async () => {
		stored = {
			agent: {
				command: "/usr/local/bin/gemini",
				args: ["--verbose"],
				env: {},
				leash: "open",
			},
			problems: [],
		};
		const { user } = show();
		const dialog = await openIt(user);
		expect(within(dialog).getByRole("radio", { name: "Other" })).toBeChecked();
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

describe("AgentSetup's Join from a session tab", () => {
	function JoinHarness() {
		const [tab, setTab] = useState<SetupTab>("launch");
		return <AgentSetup open onClose={() => {}} tab={tab} onTab={setTab} />;
	}

	it("shows the setup line with the key (a spinner while it is read) and the join line", async () => {
		const held = heldJson();
		fetchMock.mockImplementation(async (url: string) =>
			url === "/api/mcp/setup" ? held.response : json(200, stored),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<JoinHarness />
			</QueryClientProvider>,
		);
		const user = userEvent.setup();
		const dialog = screen.getByTestId("agent-setup");
		const tab = within(dialog).getByRole("tab", {
			name: "Join from a session",
		});
		expect(tab).toHaveAttribute("aria-selected", "false");
		await user.click(tab);
		expect(tab).toHaveAttribute("aria-selected", "true");
		expect(
			within(dialog).queryByRole("radiogroup", { name: "Harness" }),
		).toBeNull();
		await expectLoadingThen({
			loading: () =>
				within(dialog).queryByRole("status", {
					name: "Loading the setup line",
				}),
			release: () => held.release({ key: "k3y" }),
			result: () => within(dialog).queryByTestId("join-setup-line"),
		});
		expect(within(dialog).getByTestId("join-setup-line")).toHaveValue(
			`claude mcp add --scope user --transport http crb "${window.location.origin}/mcp?key=k3y"`,
		);
		// A session already running picks the server up with /reload-plugins:
		// an icon, named by the hint, with it as its tooltip.
		const hint = within(dialog).getByRole("img", { name: RELOAD_HINT });
		expect(RELOAD_HINT).toContain("/reload-plugins");
		await user.hover(hint);
		await waitFor(() =>
			expect(
				screen.getByText(RELOAD_HINT, { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
		await user.unhover(hint);
		// Unbound in a component test: no review, so no join line.
		expect(within(dialog).queryByTestId("join-line")).toBeNull();
		// A refused copy says so and selects the line, to copy by hand.
		copied.ok = false;
		copied.texts = [];
		const copy = within(dialog).getByRole("button", {
			name: "Copy setup line",
		});
		await user.click(copy);
		const line = within(dialog).getByTestId("join-setup-line");
		expect(copied.texts).toEqual([(line as HTMLInputElement).value]);
		await waitFor(() => expect(line).toHaveFocus());
		// A press closes the tooltip until the pointer comes back.
		await user.unhover(copy);
		await user.hover(copy);
		await waitFor(() =>
			expect(
				screen.getByText("Copy failed", { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
		await user.unhover(copy);
		copied.ok = true;
		await user.click(
			within(dialog).getByRole("tab", { name: "Launch an agent" }),
		);
		await within(dialog).findByRole("radiogroup", { name: "Harness" });
	});

	it("tabs: wired to their panels, arrow keys move between them, each with a tooltip", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url === "/api/mcp/setup" ? json(200, { key: null }) : json(200, stored),
		);
		render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<JoinHarness />
			</QueryClientProvider>,
		);
		const user = userEvent.setup();
		const dialog = screen.getByTestId("agent-setup");
		const launch = within(dialog).getByRole("tab", { name: "Launch an agent" });
		const join = within(dialog).getByRole("tab", {
			name: "Join from a session",
		});
		const panelOf = (tab: HTMLElement) =>
			document.getElementById(tab.getAttribute("aria-controls") ?? "");
		expect(panelOf(launch)).toHaveAttribute("role", "tabpanel");
		expect(panelOf(launch)).toHaveAccessibleName("Launch an agent");
		expect(launch).toHaveAttribute("tabindex", "0");
		expect(join).toHaveAttribute("tabindex", "-1");
		// The icon-only tab (a phone's) has its name as a tooltip.
		await user.hover(launch);
		// aria-hidden: it repeats the tab's name.
		await waitFor(() =>
			expect(
				screen.getByText("Launch an agent", { selector: "[role=tooltip]" }),
			).toBeVisible(),
		);
		await user.unhover(launch);
		launch.focus();
		await user.keyboard("{ArrowRight}");
		expect(join).toHaveAttribute("aria-selected", "true");
		expect(join).toHaveFocus();
		expect(panelOf(join)).toHaveAttribute("role", "tabpanel");
		expect(panelOf(join)).toHaveAccessibleName("Join from a session");
		await user.keyboard("{ArrowRight}");
		expect(launch).toHaveAttribute("aria-selected", "true");
		expect(launch).toHaveFocus();
		await user.keyboard("{End}");
		expect(join).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(launch).toHaveFocus();
	});
});
