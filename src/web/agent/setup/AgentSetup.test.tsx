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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inRouter } from "../../../../test/in-router";
import { expectLoadingThen, heldJson } from "../../../../test/loading";
import type {
	AgentCheck,
	AgentConfig,
	AgentStatus,
	AgentThread,
} from "../../../shared/agent";
import { mcpLine } from "../api";
import {
	closeAgentSetup,
	openAgentSetup,
	openInviteSetup,
	openSpawnSetup,
	TAB_KEY,
} from "../setupStore";
import { AgentSetupHost, RELOAD_HINT } from "./AgentSetup";

// The writes, recorded in order; the reads go through fetch below.
const writes = vi.hoisted(() => ({
	log: [] as Array<[string, unknown]>,
	check: null as unknown,
	detach: null as null | (() => Promise<void>),
}));
vi.mock("../api", async (importOriginal) => {
	const real = await importOriginal<typeof import("../api")>();
	const record =
		(name: string, answer: (...a: unknown[]) => unknown = () => undefined) =>
		async (...args: unknown[]) => {
			writes.log.push([name, args]);
			return answer(...args);
		};
	return {
		...real,
		answerJoin: vi.fn(record("answerJoin", () => ({ ok: true }))),
		postAgentStart: vi.fn(record("postAgentStart")),
		postAgentCancel: vi.fn(record("postAgentCancel")),
		postAgentDetach: vi.fn(async (...args: unknown[]) => {
			writes.log.push(["postAgentDetach", args]);
			await writes.detach?.();
		}),
		putAgentConfig: vi.fn(
			record("putAgentConfig", (agent) => ({ agent: agent ?? null })),
		),
		checkAgentConfig: vi.fn(record("checkAgentConfig", () => writes.check)),
	};
});

const copied = vi.hoisted(() => ({ ok: true, texts: [] as string[] }));
vi.mock("../../copyText", () => ({
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

const SINCE = "2026-11-12T10:00:00Z";
const status = (s: Partial<AgentStatus> = {}): AgentStatus => ({
	state: "off",
	configured: true,
	since: SINCE,
	waiting: 0,
	...s,
});

const JOINED = {
	name: "widgets-pr-77",
	machine: "laptop",
	harness: "Claude Code",
	since: SINCE,
};

const thread = (id: string, path: string, line: number): AgentThread => ({
	id,
	anchor: {
		subject: "line",
		path,
		commit: "f".repeat(40),
		side: "RIGHT",
		line,
		startSide: "RIGHT",
		startLine: line,
	},
	openedBy: "human",
	at: SINCE,
	messages: [
		{
			id: `${id}m`,
			by: "human",
			at: SINCE,
			text: "Why is the backlog never awaited?\nmore",
		},
	],
	resolved: false,
	waiting: true,
	unread: false,
});

let current: AgentStatus;
let heldStatus: Promise<Response> | null;
let stored: { agent: AgentConfig | null; problems: string[] };
let threads: AgentThread[];
beforeEach(() => {
	writes.log = [];
	writes.check = {
		ok: true,
		agent: { name: "Claude Agent", version: "0.100.0" },
	} satisfies AgentCheck;
	writes.detach = null;
	current = status();
	heldStatus = null;
	stored = { agent: null, problems: [] };
	threads = [];
	try {
		localStorage.clear();
	} catch {}
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url === "/api/agent") return heldStatus ?? json(200, current);
			if (url === "/api/config/agent") return json(200, stored);
			if (url === "/api/mcp/setup") return json(200, { key: "k3y" });
			if (url === "/api/agent/threads") return json(200, { threads });
			return json(404, { error: "no" });
		}),
	);
});
afterEach(() => {
	closeAgentSetup();
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function show(open: () => void = openAgentSetup) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			{inRouter(() => (
				<>
					<button type="button" onClick={open}>
						opener
					</button>
					<AgentSetupHost />
				</>
			))}
		</QueryClientProvider>,
	);
	return { client, user: userEvent.setup() };
}

async function opened(open?: () => void) {
	const { user, client } = show(open);
	await user.click(await screen.findByRole("button", { name: "opener" }));
	const dialog = await screen.findByTestId("agent-setup");
	return { user, client, dialog };
}

const names = (calls: Array<[string, unknown]>) => calls.map(([n]) => n);

describe("AgentSetup: the view follows the status", () => {
	it("Setup Review Agent with no agent, Review Agent with one", async () => {
		const { dialog, client } = await opened();
		expect(
			await within(dialog).findByRole("heading", {
				name: "Setup Review Agent",
			}),
		).toBeTruthy();
		current = status({ state: "starting", spawned: true });
		await client.invalidateQueries({ queryKey: ["agent"] });
		expect(
			await within(dialog).findByRole("heading", { name: "Review Agent" }),
		).toBeTruthy();
		expect(within(dialog).queryByRole("tab")).toBeNull();
	});

	it("a spinner while the status is read, never 'No agent requesting to join'", async () => {
		const held = heldJson();
		heldStatus = held.response;
		const { dialog } = await opened();
		await expectLoadingThen({
			loading: () =>
				within(dialog).queryByRole("status", { name: "Loading your agent" }),
			empty: [() => within(dialog).queryByText("No agent requesting to join")],
			release: () => {
				heldStatus = null;
				held.release(current);
			},
			result: () => within(dialog).queryByText("No agent requesting to join"),
		});
	});

	it("the tab is remembered across openings in crb.agentSetup.tab", async () => {
		const first = await opened();
		expect(
			within(first.dialog).getByRole("tab", { name: "Invite" }),
		).toHaveAttribute("aria-selected", "true");
		await first.user.click(
			within(first.dialog).getByRole("tab", { name: "Spawn" }),
		);
		expect(localStorage.getItem(TAB_KEY)).toBe("spawn");
		closeAgentSetup();
		cleanup();
		const again = await opened();
		expect(
			within(again.dialog).getByRole("tab", { name: "Spawn" }),
		).toHaveAttribute("aria-selected", "true");
		closeAgentSetup();
		cleanup();
		// What storage says wins.
		localStorage.setItem(TAB_KEY, "invite");
		const third = await opened();
		expect(
			within(third.dialog).getByRole("tab", { name: "Invite" }),
		).toHaveAttribute("aria-selected", "true");
	});

	it("an opener that names a tab opens it and stores it", async () => {
		const { dialog } = await opened(openSpawnSetup);
		expect(within(dialog).getByRole("tab", { name: "Spawn" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(localStorage.getItem(TAB_KEY)).toBe("spawn");
		closeAgentSetup();
		cleanup();
		await opened(openInviteSetup);
		expect(localStorage.getItem(TAB_KEY)).toBe("invite");
	});

	it("with localStorage throwing, it opens on Invite and the tabs still switch", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		// The in-memory tab from earlier tests is Invite's again.
		openInviteSetup();
		closeAgentSetup();
		const { user, dialog } = await opened();
		const invite = within(dialog).getByRole("tab", { name: "Invite" });
		expect(invite).toHaveAttribute("aria-selected", "true");
		await user.click(within(dialog).getByRole("tab", { name: "Spawn" }));
		expect(within(dialog).getByRole("tab", { name: "Spawn" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await user.click(invite);
		expect(invite).toHaveAttribute("aria-selected", "true");
	});

	it("Escape closes it and focus goes back", async () => {
		const { user } = await opened();
		// The header's X takes focus; the footer has a Close too.
		expect(screen.getAllByRole("button", { name: "Close" })[0]).toHaveFocus();
		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("agent-setup")).not.toHaveAttribute("open");
		expect(screen.getByRole("button", { name: "opener" })).toHaveFocus();
	});
});

describe("AgentSetup: Invite", () => {
	it("each harness button switches the setup line; Claude Code has the reload hint", async () => {
		const { user, dialog } = await opened(openInviteSetup);
		const line = await within(dialog).findByTestId("join-setup-line");
		const origin = window.location.origin;
		expect(line).toHaveValue(mcpLine("claude-code", origin, "k3y"));
		expect(within(dialog).getByRole("img", { name: RELOAD_HINT })).toBeTruthy();
		const codex = within(dialog).getByRole("button", { name: "Codex" });
		await user.click(codex);
		expect(codex).toHaveAttribute("aria-pressed", "true");
		expect(line).toHaveValue(mcpLine("codex", origin, "k3y"));
		expect(within(dialog).queryByRole("img", { name: RELOAD_HINT })).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Other" }));
		expect(line).toHaveValue(`${origin}/mcp?key=k3y`);
	});

	it("a join request shows its card; Approve and Decline answer it", async () => {
		current = status({
			joinRequest: {
				id: "req1",
				name: "widgets-pr-77",
				machine: "laptop",
				harness: "Claude Code",
				at: SINCE,
			},
		});
		const { user, dialog, client } = await opened(openInviteSetup);
		const card = await within(dialog).findByTestId("join-request-card");
		expect(card).toHaveTextContent("widgets-pr-77");
		expect(card).toHaveTextContent("Claude Code");
		expect(card).toHaveTextContent("laptop");
		expect(within(card).getByRole("time")).toBeTruthy();
		expect(
			within(dialog).queryByText("No agent requesting to join"),
		).toBeNull();
		await user.click(within(card).getByRole("button", { name: "Decline" }));
		await waitFor(() =>
			expect(writes.log).toContainEqual(["answerJoin", ["req1", false]]),
		);
		// Answered: gone at once, as from the bar, though the status still has it.
		expect(
			await within(dialog).findByText("No agent requesting to join"),
		).toBeTruthy();
		// The next request: Approve, with its name kept while it is sent.
		const api = await import("../api");
		let release = () => {};
		vi.mocked(api.answerJoin).mockImplementationOnce(
			(...args) =>
				new Promise((done) => {
					writes.log.push(["answerJoin", args]);
					release = () => done({ ok: true });
				}),
		);
		current = status({
			joinRequest: { id: "req2", name: "next", machine: "m", at: SINCE },
		});
		await client.invalidateQueries({ queryKey: ["agent"] });
		const next = await within(dialog).findByTestId("join-request-card");
		const approve = within(next).getByRole("button", { name: "Approve" });
		await user.click(approve);
		await waitFor(() =>
			expect(writes.log).toContainEqual(["answerJoin", ["req2", true]]),
		);
		expect(approve).toHaveAccessibleName("Approve");
		expect(approve).toHaveAttribute("aria-busy", "true");
		expect(
			within(next).getByRole("button", { name: "Decline" }),
		).not.toHaveAttribute("aria-busy");
		release();
		await waitFor(() =>
			expect(within(dialog).queryByTestId("join-request-card")).toBeNull(),
		);
	});

	it("a request that would replace a running agent says whom", async () => {
		current = status({
			state: "ready",
			agent: { name: "Claude Agent", version: "1" },
			joinRequest: { id: "r3", name: "s", machine: "m", at: SINCE },
		});
		const { dialog } = await opened(openInviteSetup);
		const card = await within(dialog).findByTestId("join-request-card");
		expect(card).toHaveTextContent("Replaces Claude Agent");
	});

	it("the harness picked is remembered in crb.agentSetup.mcpHarness", async () => {
		const first = await opened(openInviteSetup);
		await within(first.dialog).findByTestId("join-setup-line");
		await first.user.click(
			within(first.dialog).getByRole("button", { name: "Gemini CLI" }),
		);
		expect(localStorage.getItem("crb.agentSetup.mcpHarness")).toBe("gemini");
		closeAgentSetup();
		cleanup();
		const again = await opened(openInviteSetup);
		expect(
			within(again.dialog).getByRole("button", { name: "Gemini CLI" }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			await within(again.dialog).findByTestId("join-setup-line"),
		).toHaveValue(mcpLine("gemini", window.location.origin, "k3y"));
	});

	it("only the selected tab controls a panel, and that panel is there", async () => {
		const { dialog } = await opened(openInviteSetup);
		const invite = within(dialog).getByRole("tab", { name: "Invite" });
		const spawn = within(dialog).getByRole("tab", { name: "Spawn" });
		expect(spawn).not.toHaveAttribute("aria-controls");
		const panel = document.getElementById(
			invite.getAttribute("aria-controls") ?? "",
		);
		expect(panel).toHaveAttribute("role", "tabpanel");
	});

	it("a request while a session is joined leaves the modal on the connected view", async () => {
		current = status({
			via: "mcp",
			joined: JOINED,
			joinRequest: { id: "r2", name: "other", machine: "m", at: SINCE },
		});
		// Joined: the connected view. Its request shows in the bar, not here.
		const { dialog } = await opened(openInviteSetup);
		expect(
			await within(dialog).findByRole("heading", { name: "Review Agent" }),
		).toBeTruthy();
	});
});

describe("AgentSetup: Spawn", () => {
	it("a failed check shows why with its stderr, and saves and starts nothing", async () => {
		writes.check = { ok: false, error: "not logged in", stderr: "Run login" };
		const { user, dialog } = await opened(openSpawnSetup);
		await within(dialog).findByRole("radiogroup", { name: "Harness" });
		await user.click(within(dialog).getByRole("button", { name: "Spawn" }));
		const err = await within(dialog).findByTestId("agent-check-error");
		expect(err).toHaveTextContent("not logged in");
		expect(within(dialog).getByText("Run login").tagName).toBe("PRE");
		expect(names(writes.log)).toEqual(["checkAgentConfig"]);
	});

	it("an ok check saves (keeping the stored env for that command), then starts", async () => {
		stored = {
			agent: {
				command: "claude-agent-acp",
				args: [],
				env: { CLAUDE_CODE_EXECUTABLE: "/opt/claude" },
				leash: "open",
			},
			problems: [],
		};
		const { user, dialog } = await opened(openSpawnSetup);
		expect(
			await within(dialog).findByRole("radio", { name: "Claude Code" }),
		).toBeChecked();
		await user.click(within(dialog).getByRole("button", { name: "Spawn" }));
		await waitFor(() =>
			expect(names(writes.log)).toEqual([
				"checkAgentConfig",
				"putAgentConfig",
				"postAgentStart",
			]),
		);
		expect(writes.log[1]?.[1]).toEqual([stored.agent]);
	});

	it("a second press while spawning does nothing", async () => {
		let release = () => {};
		writes.check = { ok: true, agent: { name: "a", version: "1" } };
		const { user, dialog } = await opened(openSpawnSetup);
		await within(dialog).findByRole("radiogroup", { name: "Harness" });
		const api = await import("../api");
		vi.mocked(api.checkAgentConfig).mockImplementationOnce(
			() =>
				new Promise((done) => {
					writes.log.push(["checkAgentConfig", []]);
					release = () =>
						done({ ok: true, agent: { name: "a", version: "1" } });
				}),
		);
		const spawn = within(dialog).getByRole("button", { name: "Spawn" });
		await user.click(spawn);
		expect(spawn).toHaveTextContent("Spawning…");
		await user.click(spawn);
		release();
		await waitFor(() =>
			expect(names(writes.log)).toEqual([
				"checkAgentConfig",
				"putAgentConfig",
				"postAgentStart",
			]),
		);
	});

	it("the leash is Open, with an info button that says what it allows", async () => {
		const { dialog } = await opened(openSpawnSetup);
		expect(
			await within(dialog).findByRole("radio", { name: "Open" }),
		).toBeChecked();
		expect(
			within(dialog).getByRole("button", {
				name: /anything the local session allows/,
			}),
		).toBeTruthy();
	});

	it("has no Save, Remove or Check, and no Env", async () => {
		const { dialog } = await opened(openSpawnSetup);
		await within(dialog).findByRole("radiogroup", { name: "Harness" });
		for (const name of ["Save", "Remove", "Check", "Cancel"]) {
			expect(within(dialog).queryByRole("button", { name })).toBeNull();
		}
		expect(within(dialog).queryByText("Env")).toBeNull();
		expect(dialog.textContent).not.toContain("CLAUDE_CODE_EXECUTABLE");
		expect(
			within(dialog).getAllByRole("button", { name: "Close" }),
		).toHaveLength(2);
	});

	it("a preset's command is read-only; Other's is typed", async () => {
		const { user, dialog } = await opened(openSpawnSetup);
		await user.click(
			await within(dialog).findByRole("radio", { name: "Gemini CLI" }),
		);
		const command = within(dialog).getByRole("textbox", { name: "Command" });
		expect(command).toHaveValue("gemini");
		expect(command).toHaveAttribute("readonly");
		await user.click(within(dialog).getByRole("radio", { name: "Other" }));
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).not.toHaveAttribute("readonly");
	});

	it("a stored command no harness has is Other, with the config's problems", async () => {
		stored = {
			agent: { command: "my-acp", args: ["--x"], env: {}, leash: "open" },
			problems: ['agent.leash: "strict" isn\'t a level; open'],
		};
		const { dialog } = await opened(openSpawnSetup);
		expect(
			await within(dialog).findByRole("radio", { name: "Other" }),
		).toBeChecked();
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue("my-acp");
		expect(
			within(dialog).getByTestId("agent-config-problems"),
		).toHaveTextContent("strict");
	});

	it("a preset's command at an absolute path is that preset, and Spawn keeps the path and env", async () => {
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
		const { user, dialog } = await opened(openSpawnSetup);
		expect(
			await within(dialog).findByRole("radio", { name: "Claude Code" }),
		).toBeChecked();
		// Away and back: still the stored path.
		await user.click(within(dialog).getByRole("radio", { name: "Gemini CLI" }));
		await user.click(
			within(dialog).getByRole("radio", { name: "Claude Code" }),
		);
		expect(
			within(dialog).getByRole("textbox", { name: "Command" }),
		).toHaveValue(abs);
		await user.click(within(dialog).getByRole("button", { name: "Spawn" }));
		await waitFor(() => expect(names(writes.log)).toContain("postAgentStart"));
		expect(writes.log[1]?.[1]).toEqual([stored.agent]);
	});

	it("arguments with a space stay whole through the field", async () => {
		const { user, dialog } = await opened(openSpawnSetup);
		await user.click(
			await within(dialog).findByRole("radio", { name: "Other" }),
		);
		await user.type(
			within(dialog).getByRole("textbox", { name: "Command" }),
			"my-acp",
		);
		await user.type(
			within(dialog).getByRole("textbox", { name: "Arguments" }),
			'--name "two words"',
		);
		await user.click(within(dialog).getByRole("button", { name: "Spawn" }));
		await waitFor(() =>
			expect(names(writes.log)).toContain("checkAgentConfig"),
		);
		expect(writes.log[0]?.[1]).toEqual([
			{
				command: "my-acp",
				args: ["--name", "two words"],
				env: {},
				leash: "open",
			},
		]);
	});

	it("a refused copy says so and selects the line to copy by hand", async () => {
		copied.ok = false;
		copied.texts = [];
		const { user, dialog } = await opened(openSpawnSetup);
		const line = await within(dialog).findByTestId("agent-install-line");
		await user.click(
			within(dialog).getByRole("button", { name: "Copy install" }),
		);
		expect(copied.texts).toEqual([
			"npm i -g @agentclientprotocol/claude-agent-acp",
		]);
		await waitFor(() => expect(line).toHaveFocus());
		copied.ok = true;
	});
});

describe("AgentSetup: Review Agent (connected)", () => {
	it("an ACP agent: its identity, Ready, Idle, and Stop current disabled", async () => {
		current = status({
			state: "ready",
			spawned: true,
			via: "acp",
			agent: { name: "Claude Agent", version: "0.100.0" },
			seen: SINCE,
			spawnedAt: "2026-11-12T09:00:00Z",
			// A state change since: Connected must not follow it.
			since: "2026-11-12T11:00:00Z",
		});
		stored = {
			agent: { command: "claude-agent-acp", args: [], env: {}, leash: "open" },
			problems: [],
		};
		const { dialog } = await opened();
		const card = await within(dialog).findByTestId("agent-status-card");
		expect(card).toHaveTextContent("Claude Agent 0.100.0");
		expect(card).toHaveTextContent("Spawned · ACP");
		expect(within(card).getByTestId("agent-state")).toHaveTextContent("Ready");
		expect(await within(card).findByText("claude-agent-acp")).toBeTruthy();
		expect(within(dialog).getByText("Idle")).toBeTruthy();
		expect(
			within(dialog).getByRole("button", { name: "Stop current" }),
		).toBeDisabled();
	});

	it("Connected is when Spawn set the flag; left out without it, never the last state change", async () => {
		current = status({ state: "ready", spawned: true, spawnedAt: SINCE });
		let { dialog } = await opened();
		let card = await within(dialog).findByTestId("agent-status-card");
		const connected = within(card).getByText("Connected").nextElementSibling;
		expect(connected?.querySelector("time")).toHaveAttribute("datetime", SINCE);
		closeAgentSetup();
		cleanup();
		current = status({ state: "ready", spawned: true });
		({ dialog } = await opened());
		card = await within(dialog).findByTestId("agent-status-card");
		expect(within(card).queryByText("Connected")).toBeNull();
		expect(within(card).getByText("Last seen")).toBeTruthy();
	});

	it("a joined session's Connected is when it joined", async () => {
		current = status({ state: "ready", via: "mcp", joined: JOINED });
		const { dialog } = await opened();
		const card = await within(dialog).findByTestId("agent-status-card");
		const connected = within(card).getByText("Connected").nextElementSibling;
		expect(connected?.querySelector("time")).toHaveAttribute(
			"datetime",
			JOINED.since,
		);
	});

	it("a joined session: Stop current is disabled, its tooltip says to stop it in the session", async () => {
		current = status({
			state: "busy",
			via: "mcp",
			joined: JOINED,
			agent: { name: "widgets-pr-77", version: "", via: "mcp" },
			answering: { thread: "T1", text: "", activity: [] },
			waiting: 1,
		});
		threads = [thread("T1", "src/host.ts", 234)];
		const { dialog } = await opened();
		const card = await within(dialog).findByTestId("agent-status-card");
		expect(card).toHaveTextContent("widgets-pr-77");
		expect(card).toHaveTextContent("Invited · MCP");
		expect(card).toHaveTextContent("laptop · Claude Code");
		const stop = within(dialog).getByRole("button", { name: "Stop current" });
		expect(stop).toHaveAttribute("aria-disabled", "true");
		expect(stop).toHaveAccessibleDescription(/Stop it in the session/);
		await userEvent.setup().click(stop);
		expect(names(writes.log)).not.toContain("postAgentCancel");
	});

	it("an ACP agent at work: Stop current cancels its reply", async () => {
		current = status({
			state: "busy",
			spawned: true,
			via: "acp",
			agent: { name: "Claude Agent", version: "1" },
			answering: {
				thread: "T1",
				text: "",
				activity: [{ kind: "read", title: "Read src/host.ts" }],
			},
			waiting: 1,
		});
		threads = [thread("T1", "src/host.ts", 234)];
		const { user, dialog } = await opened();
		expect(await within(dialog).findByTestId("agent-activity")).toBeTruthy();
		const stop = within(dialog).getByRole("button", { name: "Stop current" });
		expect(stop).toBeEnabled();
		await user.click(stop);
		await waitFor(() => expect(names(writes.log)).toContain("postAgentCancel"));
	});

	it("Detach detaches, says Detaching… until the status agrees, then shows setup", async () => {
		current = status({
			state: "ready",
			spawned: true,
			agent: { name: "Claude Agent", version: "1" },
		});
		const { user, dialog, client } = await opened();
		await user.click(
			await within(dialog).findByRole("button", { name: "Detach" }),
		);
		await waitFor(() => expect(names(writes.log)).toEqual(["postAgentDetach"]));
		// The status still says spawned (another server's agent stops on its poll).
		expect(
			await within(dialog).findByRole("button", { name: /Detaching/ }),
		).toBeDisabled();
		current = status({ state: "off" });
		await client.invalidateQueries({ queryKey: ["agent"] });
		expect(
			await within(dialog).findByRole("heading", {
				name: "Setup Review Agent",
			}),
		).toBeTruthy();
	});

	it("a failed Detach goes back to Detach and says why", async () => {
		current = status({ state: "ready", spawned: true });
		writes.detach = () => Promise.reject(new Error("could not detach"));
		const { user, dialog } = await opened();
		await user.click(
			await within(dialog).findByRole("button", { name: "Detach" }),
		);
		expect(await within(dialog).findByText("could not detach")).toBeTruthy();
		const detach = within(dialog).getByRole("button", { name: "Detach" });
		expect(detach).toBeEnabled();
		// And it can be pressed again.
		writes.detach = null;
		await user.click(detach);
		await waitFor(() =>
			expect(names(writes.log)).toEqual(["postAgentDetach", "postAgentDetach"]),
		);
	});

	it("an agent that crashed out shows the error and Restart, which starts it again", async () => {
		current = status({
			state: "error",
			spawned: true,
			error: "The agent exited twice",
		});
		const { user, dialog } = await opened();
		expect(
			await within(dialog).findByText("The agent exited twice"),
		).toBeTruthy();
		expect(within(dialog).getByTestId("agent-state")).toHaveTextContent(
			"Error",
		);
		await user.click(within(dialog).getByRole("button", { name: "Restart" }));
		await waitFor(() => expect(names(writes.log)).toEqual(["postAgentStart"]));
	});

	it("a flag with no config: Error, No agent configured", async () => {
		current = status({ state: "error", spawned: true, configured: false });
		const { dialog } = await opened();
		expect(await within(dialog).findByText("No agent configured")).toBeTruthy();
	});

	it("another carbonless runs it: says so with its port", async () => {
		current = status({ state: "elsewhere", spawned: true, elsewhere: 4750 });
		const { dialog } = await opened();
		expect(await within(dialog).findByTestId("agent-state")).toHaveTextContent(
			"Running in another carbonless :4750",
		);
	});

	it("the waiting count leaves out the thread being answered", async () => {
		current = status({
			state: "busy",
			spawned: true,
			agent: { name: "A", version: "1" },
			answering: { thread: "T1", text: "", activity: [] },
			waiting: 3,
		});
		threads = [thread("T1", "src/host.ts", 234)];
		const { dialog } = await opened();
		expect(
			await within(dialog).findByTestId("agent-waiting-count"),
		).toHaveTextContent("2 waiting");
	});

	it("the thread link names path:line and the question, and closes the modal", async () => {
		current = status({
			state: "busy",
			spawned: true,
			agent: { name: "A", version: "1" },
			answering: { thread: "T1", text: "", activity: [] },
			waiting: 1,
		});
		threads = [thread("T1", "src/host.ts", 234)];
		const { user, dialog } = await opened();
		const link = await within(dialog).findByRole("link", {
			name: /host\.ts:234/,
		});
		expect(
			within(dialog).getByTestId("agent-answering-question"),
		).toHaveTextContent(/^“Why is the backlog never awaited\?”$/);
		await user.click(link);
		await waitFor(() =>
			expect(screen.getByTestId("agent-setup")).not.toHaveAttribute("open"),
		);
	});
});
