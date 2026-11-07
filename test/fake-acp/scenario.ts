import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
		chunks?: number;
	}>;
	/** Permission requests made before answering, each also a tool_call update. */
	requests?: Array<{ kind: ActivityKind; title: string; rawInput?: unknown }>;
	/** Exit 70 right after the first chunk. */
	crashOnPrompt?: boolean;
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
