/**
 * The agent harnesses the setup modal offers, each speaking ACP over stdio.
 * One table, so the FAQ and the modal agree. carbonless installs none.
 */
export interface AgentHarness {
	id: "claude-code" | "gemini" | "goose" | "opencode" | "copilot" | "other";
	label: string;
	command: string;
	args: string[];
	/** the install line shown, copyable */
	install?: string;
	/** env added when `claude` is on PATH (claude-code only) */
	envHint?: string;
}

export const AGENT_HARNESSES: readonly AgentHarness[] = Object.freeze([
	{
		id: "claude-code",
		label: "Claude Code",
		command: "claude-agent-acp",
		args: [],
		install: "npm i -g @agentclientprotocol/claude-agent-acp",
		envHint: "CLAUDE_CODE_EXECUTABLE=$(which claude)",
	},
	{ id: "gemini", label: "Gemini CLI", command: "gemini", args: ["--acp"] },
	{ id: "goose", label: "Goose", command: "goose", args: ["acp"] },
	{ id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"] },
	{ id: "copilot", label: "Copilot CLI", command: "copilot", args: ["--acp"] },
	{ id: "other", label: "Other", command: "", args: [] },
]);
