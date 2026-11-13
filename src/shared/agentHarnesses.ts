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

/**
 * A word quoted for a POSIX shell (and zsh, where an unquoted `?` globs):
 * in double quotes when nothing there expands, else in single quotes.
 */
export function shellWord(word: string): string {
	if (!/[$`"\\!\n]/.test(word)) return `"${word}"`;
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * A harness a running session can invite from (Invite's step 1): the line
 * that adds this crb's /mcp (streamable HTTP) to it, once per machine.
 * Only harnesses whose CLI adds an HTTP MCP server by command; Other is
 * the bare URL, for any client's own config.
 */
export interface McpHarness {
	id: "claude-code" | "codex" | "gemini" | "other";
	label: string;
	/** The setup line for `url` (the MCP URL with its key). */
	line(url: string): string;
}

export const MCP_HARNESSES: readonly McpHarness[] = Object.freeze([
	{
		id: "claude-code",
		label: "Claude Code",
		line: (url: string) =>
			`claude mcp add --scope user --transport http crb ${shellWord(url)}`,
	},
	{
		// `codex mcp add <NAME> --url <URL>` (codex-cli 0.166 `--help`).
		id: "codex",
		label: "Codex",
		line: (url: string) => `codex mcp add crb --url ${shellWord(url)}`,
	},
	{
		// `gemini mcp add [options] <name> <commandOrUrl>`, `-t http`, `-s user`
		// (gemini-cli docs/tools/mcp-server.md).
		id: "gemini",
		label: "Gemini CLI",
		line: (url: string) =>
			`gemini mcp add --scope user --transport http crb ${shellWord(url)}`,
	},
	{ id: "other", label: "Other", line: (url: string) => url },
]);
