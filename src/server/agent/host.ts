import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentAnchor,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentStatus,
	type AgentThread,
	JOIN,
	type OpenAgentThreadRequest,
} from "../../shared/agent.js";
import type {
	CodeAnchor,
	CodeWindow,
	DiffLine,
	Snapshot,
} from "../../shared/types.js";
import { readConfig } from "../config.js";
import { loadFileHunks } from "../diff/snapshot.js";
import type { PrMeta } from "../gh.js";
import { runGitBuffer } from "../git.js";
import { RefStore } from "../review/refStore.js";
import { agentsDir } from "./checkout.js";
import { ReviewClaim } from "./claim.js";
import { JoinBroker } from "./join.js";
import { isSafePath, mimeTypeOf } from "./prompt.js";
import { AgentRunner, type RunnerFacts } from "./runner.js";
import { type AgentThreadFold, AgentThreadStore } from "./store.js";

/** The port this server listens on (serve.ts sets it): the claim names it. */
let listeningPort = 0;
export const setServerPort = (port: number): void => {
	listeningPort = port;
};
export const serverPort = (): number => listeningPort;

/** What the host asks of its ACP runner (an AgentRunner; a stub in tests). */
export type HostRunner = Pick<
	AgentRunner,
	"status" | "asked" | "poke" | "stop" | "cancel" | "close" | "inFlight"
>;

/**
 * A review's agent as its Session owns it: the ACP runner, the join broker
 * (a session joined through MCP answers instead while it is joined), and
 * the one store of the reviewer's agent threads every route goes through
 * (its dedupe of clientIds holds within one store).
 */
export class AgentHost {
	readonly #restored: Promise<void>;

	constructor(
		private readonly runner: HostRunner,
		private readonly store: AgentThreadStore,
		private readonly code: (
			anchor: AgentAnchor,
			at: string,
		) => Promise<CodeWindow | undefined>,
		readonly join: JoinBroker,
	) {
		this.#restored = join.restore().catch(() => {});
	}

	/** The runner's status, with a joined session (or a request to join) laid over it. */
	async status(): Promise<AgentStatus> {
		await this.#restored;
		const base = await this.runner.status();
		const { presence, ...view } = this.join.view();
		const out: AgentStatus = {
			...base,
			...view,
			...(this.join.acpOff() ? { acpOff: true } : {}),
		};
		const joined = view.joined;
		if (!joined) return out;
		const handed = this.join.handedOut();
		// The ACP buddy's last turn (it finishes after an Approve) stays
		// visible until it ends, unless the session holds a thread.
		const { answering: acpTurn, error: __, elsewhere: ___, ...rest } = out;
		return {
			...rest,
			state:
				presence === "listening"
					? "ready"
					: presence === "busy"
						? "busy"
						: "reconnecting",
			agent: {
				name: joined.name,
				version: joined.harness ?? "",
				via: "mcp",
				machine: joined.machine,
			},
			since: joined.since,
			...(handed
				? {
						answering: {
							thread: handed.thread,
							text: "",
							activity: [],
							...(handed.asked ? { asked: handed.asked } : {}),
						},
					}
				: acpTurn
					? { answering: acpTurn }
					: {}),
		};
	}

	/** The thread the ACP buddy still answers (after an Approve, for up to JOIN.acpStopMs): `next` skips it. */
	busyThread(): string | null {
		return this.runner.inFlight();
	}

	/** In use by a joined session (or a request to join): the registry doesn't evict it. */
	active(): boolean {
		return this.join.active();
	}

	/** The threads in opened order; a line anchor's carries its code window. */
	async threads(): Promise<AgentThread[]> {
		const folds = await this.store.read();
		return Promise.all(folds.map((t) => this.#view(t)));
	}

	async open(req: OpenAgentThreadRequest): Promise<AgentThread> {
		const t = await this.store.open({
			anchor: req.span,
			text: req.text,
			by: "human",
			clientId: req.clientId,
		});
		await this.#asked();
		return this.#view(t);
	}

	async message(
		thread: string,
		req: AgentMessageRequest,
	): Promise<AgentThread> {
		const t = await this.store.message(thread, {
			by: "human",
			text: req.text,
			clientId: req.clientId,
		});
		await this.#asked();
		return this.#view(t);
	}

	async setResolved(thread: string, resolved: boolean): Promise<AgentThread> {
		return this.#view(await this.store.setResolved(thread, resolved));
	}

	cancel(): Promise<void> {
		return this.runner.cancel();
	}

	/** Spawns the agent if one is configured and answers the backlog (never awaited). */
	start(): void {
		this.runner.poke();
	}

	/** The reviewer's Start: the ACP buddy on again (a joined session leaves first). */
	async startAcp(): Promise<void> {
		await this.#restored;
		this.join.leave("disconnected");
		await this.join.setAcpOff(false);
		this.runner.asked();
	}

	/** The reviewer's Disconnect of a joined session; the ACP buddy stays as it is (off). */
	async disconnect(): Promise<void> {
		await this.#restored;
		this.join.leave("disconnected");
	}

	async close(): Promise<void> {
		await this.#restored;
		this.join.close();
		await this.runner.close();
	}

	/** A human asked: a joined session's watcher wakes, else the ACP runner. */
	async #asked(): Promise<void> {
		await this.#restored;
		if (this.join.view().joined) this.join.wake();
		else this.runner.asked();
	}

	async #view(t: AgentThreadFold): Promise<AgentThread> {
		const { clientId: _, ...thread } = t;
		if (t.anchor.subject !== "line") return thread;
		const code = await this.code(t.anchor, t.at).catch(() => undefined);
		return code ? { ...thread, code } : thread;
	}
}

/**
 * The host with its join broker on `dir` (`<agentsDir()>/<review-id>`):
 * the runner is made with the broker's ACP-off flag, and approving a join
 * turns ACP off and stops the runner (its running turn gets
 * JOIN.acpStopMs, then is cancelled).
 */
export function buildAgentHost(o: {
	dir: string;
	store: AgentThreadStore;
	code: (anchor: AgentAnchor, at: string) => Promise<CodeWindow | undefined>;
	runner: (acpOff: () => boolean, claim?: ReviewClaim) => HostRunner;
	/** The review's agent claim, shared by the runner and the joined session. */
	claim?: ReviewClaim;
	now?: () => number;
}): AgentHost {
	let runner: HostRunner | undefined;
	const join: JoinBroker = new JoinBroker({
		dir: o.dir,
		...(o.now ? { now: o.now } : {}),
		...(o.claim ? { claim: o.claim } : {}),
		// The broker already set ACP off (before joined.json).
		onApproved: async () => {
			void runner?.stop(JOIN.acpStopMs).catch(() => {});
		},
		onLeft: () => {},
		// The thread the ACP buddy still answers isn't the session's.
		waiting: async () => {
			const busy = runner?.inFlight() ?? null;
			return (await o.store.read()).some(
				(t) => t.waiting && !t.resolved && t.id !== busy,
			);
		},
	});
	// A joined session keeps the ACP buddy off even without the file.
	runner = o.runner(() => join.acpOff() || join.isJoined(), o.claim);
	return new AgentHost(runner, o.store, o.code, join);
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The anchored file is sent up to this size (bytes); past it, or binary, not at all. */
const MAX_ANCHORED = 256 * 1024;
/** Lines of the hunk kept on each side of the anchor. */
const HUNK_CONTEXT = 20;

/** What a Session hands its agent: its clone, its review and its live views. */
export interface ReviewAgentSource {
	repo: string;
	reviewId: string;
	viewer: string;
	meta(): PrMeta;
	snapshot(): Snapshot;
	prFacts(): Promise<{ title: string; body: string }>;
	code(anchor: CodeAnchor): Promise<CodeWindow | null>;
}

/** The setup modal's Saves since the server started (PUT /api/config/agent). */
let agentConfigSaves = 0;
/** A Save, even of the same config: every review's crashed agent may start again. */
export const noteAgentConfigSaved = (): void => {
	agentConfigSaves++;
};
/** How many Saves this server has seen (each review's runner compares). */
export const agentConfigSaveCount = (): number => agentConfigSaves;

/** The agent config from config.json, with the problems that concern it. */
export async function agentConfig(): Promise<{
	agent: AgentConfig | null;
	problems: string[];
}> {
	const { config, problems } = await readConfig();
	return {
		agent: config.agent,
		problems: problems.filter((p) => /^(agent|config\.json)\b/.test(p)),
	};
}

/** The review's agent host: one thread store, one runner, the session's facts. */
export function reviewAgentHost(src: ReviewAgentSource): AgentHost {
	const store = new AgentThreadStore(
		new RefStore(src.repo),
		src.reviewId,
		src.viewer,
	);
	const tree = join(agentsDir(), src.reviewId, "tree");
	const facts: RunnerFacts = {
		review: () => {
			const m = src.meta();
			const s = src.snapshot();
			return {
				repo: `${m.owner}/${m.repo}`,
				pr: m.number,
				url: m.url,
				base: { ref: m.baseBranch, commit: m.baseOid ?? s.base },
				head: { ref: m.headBranch, commit: s.head },
				mergeBase: s.base,
				tree,
			};
		},
		prFacts: async () => ({
			...(await src.prFacts()),
			files: src.snapshot().files.map((f) => f.path),
		}),
		anchored: (anchor) => anchoredFile(src, tree, anchor),
		hunk: (anchor) => anchorHunk(src, anchor),
		authorOf: (login) => (login === src.viewer ? "reviewer" : "other"),
	};
	const code = async (anchor: AgentAnchor, at: string) => {
		if (anchor.subject !== "line") return undefined;
		const window = await src.code({
			path: anchor.path,
			commit: anchor.commit,
			side: anchor.side,
			line: anchor.line,
			startSide: anchor.startSide,
			startLine: anchor.startLine,
			at,
			startCol: anchor.startCol ?? null,
			endCol: anchor.endCol ?? null,
		});
		return window ?? undefined;
	};
	const dir = join(agentsDir(), src.reviewId);
	return buildAgentHost({
		dir,
		store,
		code,
		claim: new ReviewClaim(dir, () => ({
			pid: process.pid,
			port: serverPort(),
		})),
		runner: (acpOff, claim) =>
			new AgentRunner({
				reviewId: src.reviewId,
				config: async () => ({
					...(await agentConfig()),
					saves: agentConfigSaveCount(),
				}),
				store,
				cacheClone: src.repo,
				head: src.snapshot().head,
				port: serverPort(),
				viewer: src.viewer,
				facts,
				acpOff,
				...(claim ? { claim } : {}),
			}),
	});
}

/**
 * The anchored file's text at the anchor's commit (the merge base for a
 * LEFT anchor), read from the clone with a checked OID and a path that
 * stays inside the tree; null when it can't be read, is binary or large.
 */
export async function anchoredFile(
	src: Pick<ReviewAgentSource, "repo" | "snapshot">,
	tree: string,
	anchor: AgentAnchor,
): Promise<{ uri: string; mimeType: string; text: string } | null> {
	if (!isSafePath(anchor.path)) return null;
	const left = anchor.subject === "line" && anchor.side === "LEFT";
	const commit = left ? src.snapshot().base : anchor.commit;
	if (!OID.test(commit)) return null;
	const blob = await runGitBuffer(
		src.repo,
		["cat-file", "blob", `${commit}:${anchor.path}`],
		{ allowFailure: true },
	);
	if (blob.length === 0 || blob.length > MAX_ANCHORED || blob.includes(0)) {
		return null;
	}
	return {
		uri: pathToFileURL(join(tree, anchor.path)).href,
		mimeType: mimeTypeOf(anchor.path),
		text: blob.toString("utf8"),
	};
}

/**
 * The snapshot's diff hunk around a line anchor, as unified diff text,
 * HUNK_CONTEXT lines each side of the anchored range; null for a file
 * anchor, an unsafe path or a file the snapshot doesn't change.
 */
export async function anchorHunk(
	src: Pick<ReviewAgentSource, "repo" | "snapshot">,
	anchor: AgentAnchor,
): Promise<string | null> {
	if (anchor.subject !== "line" || !isSafePath(anchor.path)) return null;
	const snapshot = src.snapshot();
	const file = snapshot.files.find(
		(f) => f.path === anchor.path || f.oldPath === anchor.path,
	);
	if (!file) return null;
	const { hunks } = await loadFileHunks(src.repo, snapshot, file.index, {
		headings: false,
	});
	const numberOf = (l: DiffLine, side: "LEFT" | "RIGHT") =>
		side === "LEFT" ? l.oldNo : l.newNo;
	const touches = (l: DiffLine) => {
		const no = numberOf(l, anchor.side);
		const from = anchor.startSide === anchor.side ? anchor.startLine : 1;
		return no !== undefined && no >= from && no <= anchor.line;
	};
	const hunk = hunks.find((h) => h.lines.some(touches));
	if (!hunk) return null;
	const first = hunk.lines.findIndex(touches);
	const last = hunk.lines.findLastIndex(touches);
	const lines = hunk.lines.slice(
		Math.max(0, first - HUNK_CONTEXT),
		last + HUNK_CONTEXT + 1,
	);
	const start = (side: "LEFT" | "RIGHT") =>
		lines.find((l) => numberOf(l, side) !== undefined)?.[
			side === "LEFT" ? "oldNo" : "newNo"
		] ?? 0;
	const count = (kind: DiffLine["kind"]) =>
		lines.filter((l) => l.kind === "context" || l.kind === kind).length;
	const header = `@@ -${start("LEFT")},${count("del")} +${start("RIGHT")},${count("add")} @@`;
	const sign = { context: " ", add: "+", del: "-" } as const;
	return [header, ...lines.map((l) => `${sign[l.kind]}${l.text}`)].join("\n");
}
