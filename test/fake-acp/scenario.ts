import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { ActivityKind, AgentStop } from "../../src/shared/agent.js";
import { writeFileAtomic } from "../fake-gh/atomic.mjs";

/** The fake agent's bin dir: put it first on PATH; the executable is `claude-agent-acp`. */
export const FAKE_ACP_BIN = resolve(import.meta.dirname, "bin");

/** What a held step waits for: `release()` takes it out of `hold`. */
export type AcpHoldOp = "prompt" | "initialize";

/**
 * What the fake agent (agent.mjs) does, read from $CRB_FAKE_ACP when it
 * starts (holds are re-read while they wait).
 */
export interface AcpScenario {
	agent: { name: string; version: string };
	/** Print to stderr and exit 1 instead of answering initialize. */
	initializeError?: string;
	/**
	 * Answers to prompts: the first whose `match` is a substring of the
	 * latest message's text, else the last; by default one "ok". `chunks`
	 * splits the text into that many agent_message_chunk updates.
	 */
	answers?: Array<{
		match?: string;
		text: string;
		stop?: AgentStop;
		/** With stop "error": the message the prompt fails with (a JSON-RPC internal error). */
		error?: string;
		chunks?: number;
		/** A command (argv) run in the agent's cwd before it answers. */
		run?: string[];
	}>;
	/** Permission requests made before answering, each also a tool_call update. */
	requests?: Array<{ kind: ActivityKind; title: string; rawInput?: unknown }>;
	/** Exit 70 right after the first chunk. */
	crashOnPrompt?: boolean;
	/** Close stdout right after the first chunk and live on until killed. */
	lingerOnPrompt?: boolean;
	/**
	 * Gates on the test's cue, never the clock: `prompt` holds a turn after
	 * its first chunk (a cancel ends the wait, stop `cancelled`);
	 * `initialize` holds the handshake (the status stays `starting`).
	 */
	hold?: AcpHoldOp[];
}

/** Writes `<dir>/fake-acp-scenario.json` atomically; its path goes in CRB_FAKE_ACP. */
export function writeAcpScenario(dir: string, s: AcpScenario): string {
	const path = join(dir, "fake-acp-scenario.json");
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
	return path;
}

/** Lets held `op` calls (and later ones) through. */
export function releaseAcp(path: string, op: AcpHoldOp): void {
	const s = JSON.parse(readFileSync(path, "utf8")) as AcpScenario;
	s.hold = (s.hold ?? []).filter((h) => h !== op);
	writeFileAtomic(path, JSON.stringify(s, null, "\t"));
}

/** One line of CRB_FAKE_ACP_LOG: a request the fake got, or a permission answer it was given. */
export interface AcpLogEntry {
	/** The fake process that logged it. */
	pid: number;
	/** `spawn` (its cwd, argv and env names), an ACP method, or `session/cancel`. */
	method: string;
	params: unknown;
	response?: unknown;
}

/** The log at `path` (CRB_FAKE_ACP_LOG), oldest first; [] before anything was logged. */
export function acpLog(path: string): AcpLogEntry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as AcpLogEntry);
}

/**
 * Puts the fake agent on PATH (first) with scenario `s` and writes a
 * config.json naming `claude-agent-acp` under $XDG_CONFIG_HOME, for unit
 * tests that open real sessions. Returns the scenario and log paths and a
 * restore() that puts the env back.
 */
export function useFakeAcp(
	dir: string,
	s: AcpScenario,
): { scenario: string; log: string; restore: () => void } {
	const scenario = writeAcpScenario(dir, s);
	const log = join(dir, "fake-acp.log");
	const saved = {
		PATH: process.env.PATH,
		CRB_FAKE_ACP: process.env.CRB_FAKE_ACP,
		CRB_FAKE_ACP_LOG: process.env.CRB_FAKE_ACP_LOG,
	};
	process.env.PATH = `${FAKE_ACP_BIN}${delimiter}${process.env.PATH}`;
	process.env.CRB_FAKE_ACP = scenario;
	process.env.CRB_FAKE_ACP_LOG = log;
	const configDir = join(process.env.XDG_CONFIG_HOME as string, "carbonless");
	mkdirSync(configDir, { recursive: true });
	const configFile = join(configDir, "config.json");
	writeFileAtomic(
		configFile,
		JSON.stringify({
			agent: { command: "claude-agent-acp", args: [], env: {}, leash: "open" },
		}),
	);
	return {
		scenario,
		log,
		restore: () => {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(configFile, { force: true });
		},
	};
}
