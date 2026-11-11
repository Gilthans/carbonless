import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	AgentAnchor,
	AgentConfig,
	AgentMessageRequest,
	AgentStatus,
	AgentThread,
	AgentView,
	OpenAgentThreadRequest,
} from "../../shared/agent.js";
import type {
	CodeAnchor,
	CodeWindow,
	DiffLine,
	ReviewThread,
	Snapshot,
} from "../../shared/types.js";
import { readConfig } from "../config.js";
import { loadFileHunks } from "../diff/snapshot.js";
import type { PrMeta } from "../gh.js";
import { runGitBuffer } from "../git.js";
import { RefStore } from "../review/refStore.js";
import { agentsDir } from "./checkout.js";
import { joinGithub, liveGithubThreads, resolveView } from "./githubJoin.js";
import { isSafePath, mimeTypeOf } from "./prompt.js";
import { AgentRunner, type RunnerFacts } from "./runner.js";
import { type AgentThreadFold, AgentThreadStore } from "./store.js";

/** The port this server listens on (serve.ts sets it): the claim names it. */
let listeningPort = 0;
export const setServerPort = (port: number): void => {
	listeningPort = port;
};
export const serverPort = (): number => listeningPort;

/** A request the agent host refuses as made (the app answers 400). */
export class AgentRequestError extends Error {}

/**
 * A request that conflicts with what is there (the app answers 409): a
 * conversation already on that GitHub thread (`thread` names it), a
 * question on a resolved GitHub thread, a resolve of a thread conversation.
 */
export class AgentConflictError extends Error {
	constructor(
		message: string,
		readonly thread?: string,
	) {
		super(message);
	}
}

/** What the host reads of the review's GitHub threads and patch sets. */
export type AgentGithub = Pick<
	ReviewAgentSource,
	"threads" | "thread" | "patchsets"
> & {
	/** The snapshot's merge base (a viewed head's, unless it is a patch set's). */
	base(): string;
};

/**
 * A review's agent as its Session owns it: the runner, and the one store
 * of the reviewer's agent threads every route goes through (its dedupe of
 * clientIds holds within one store). Thread conversations are joined with
 * GitHub's threads on every read (githubJoin.ts).
 */
export class AgentHost {
	constructor(
		private readonly runner: AgentRunner,
		private readonly store: AgentThreadStore,
		private readonly code: (
			anchor: AgentAnchor,
			at: string,
		) => Promise<CodeWindow | undefined>,
		private readonly github: AgentGithub,
	) {}

	status(): Promise<AgentStatus> {
		return this.runner.status();
	}

	/** The threads in opened order, joined with GitHub; a line anchor's carries its code window. */
	async threads(): Promise<AgentThread[]> {
		const folds = await this.#joined(await this.store.read());
		return Promise.all(folds.map((t) => this.#view(t)));
	}

	/**
	 * Each span thread's id, anchor and when it was asked (what placement
	 * reads): a live thread conversation goes where its GitHub thread goes,
	 * so it is left out; an orphan comes with its span anchor.
	 */
	async asked(): Promise<{ id: string; anchor: AgentAnchor; at: string }[]> {
		return (await this.#joined(await this.store.read()))
			.filter((t) => t.anchor.subject !== "thread")
			.map(({ id, anchor, at }) => ({ id, anchor, at }));
	}

	/**
	 * Opens a thread on a span, or on a GitHub thread (`req.thread`): one
	 * listed, with an id and not deleted (else AgentRequestError), and with
	 * no conversation yet (else AgentConflictError naming it). A resend of
	 * an opening already written returns its thread.
	 */
	async open(req: OpenAgentThreadRequest): Promise<AgentThread> {
		// A resend of an opening already stored: its thread, whatever GitHub says now.
		const known = await this.store.openedWith(req.clientId);
		if (known !== undefined) {
			return this.#view(await this.#joinedOne(await this.store.find(known)));
		}
		const view = req.view ? this.#resolveView(req.view) : undefined;
		let anchor: AgentAnchor;
		if (req.span) anchor = req.span;
		else if (req.thread !== undefined) {
			anchor = await this.#threadAnchor(req.thread);
		} else throw new AgentRequestError("A span or a thread, one of them");
		const t = await this.store.open({
			anchor,
			text: req.text,
			by: "human",
			clientId: req.clientId,
			...(view ? { view } : {}),
		});
		this.runner.asked();
		return this.#view(await this.#joinedOne(t));
	}

	/**
	 * A question in a thread; refused (AgentConflictError) while its GitHub
	 * thread is resolved, and failing (the read's error, 502) while GitHub
	 * can't be read. A resend of a message already stored returns the
	 * thread before either check.
	 */
	async message(
		thread: string,
		req: AgentMessageRequest,
	): Promise<AgentThread> {
		if (await this.store.messagedWith(thread, req.clientId)) {
			return this.#view(await this.#joinedOne(await this.store.find(thread)));
		}
		const view = req.view ? this.#resolveView(req.view) : undefined;
		const current = await this.store.find(thread);
		if (current.anchor.subject === "thread") {
			// Fails closed: an unread GitHub never lets a question through.
			const rt = liveGithubThreads(await this.github.threads()).get(
				current.anchor.thread,
			);
			if (rt?.resolved) {
				throw new AgentConflictError(
					"The GitHub thread is resolved: unresolve it to ask again",
				);
			}
		}
		const t = await this.store.message(thread, {
			by: "human",
			text: req.text,
			clientId: req.clientId,
			...(view ? { view } : {}),
		});
		this.runner.asked();
		return this.#view(await this.#joinedOne(t));
	}

	/**
	 * Resolves a span thread or an orphan; a live thread conversation has
	 * no resolved state of its own (AgentConflictError: resolve the GitHub
	 * thread, a human action on its card).
	 */
	async setResolved(thread: string, resolved: boolean): Promise<AgentThread> {
		const current = await this.store.find(thread);
		if (current.anchor.subject === "thread") {
			// Unknown GitHub threads fail the write (502), never resolve it here.
			const live = liveGithubThreads(await this.github.threads());
			if (live.has(current.anchor.thread)) {
				throw new AgentConflictError(
					"A thread conversation resolves with its GitHub thread",
				);
			}
		}
		const t = await this.store.setResolved(thread, resolved);
		return this.#view(await this.#joinedOne(t));
	}

	/** The reviewer has seen the thread up to a message (no write when already seen). */
	async seen(thread: string, upTo: string): Promise<AgentThread> {
		const t = await this.store.seen(thread, upTo);
		return this.#view(await this.#joinedOne(t));
	}

	cancel(): Promise<void> {
		return this.runner.cancel();
	}

	/** Spawns the agent if one is configured and answers the backlog (never awaited). */
	start(): void {
		this.runner.poke();
	}

	close(): Promise<void> {
		return this.runner.close();
	}

	#resolveView(view: Omit<AgentView, "left" | "right">): AgentView {
		const v = resolveView(view, this.github.patchsets(), this.github.base());
		if (!v) throw new AgentRequestError("view names no patch set or commit");
		return v;
	}

	/** The anchor of a new conversation on GitHub thread `id`; see open(). */
	async #threadAnchor(id: string): Promise<AgentAnchor> {
		const rt = await this.github.thread(id);
		if (!rt || rt.id === "" || rt.unavailable === "deleted") {
			throw new AgentRequestError(`No GitHub thread ${id} to ask about`);
		}
		const anchor: AgentAnchor = {
			subject: "thread",
			thread: rt.id,
			path: rt.path,
			// One GitHub gave unreadably: on no known commit, like "".
			commit: OID.test(rt.commit) ? rt.commit : "",
			...(rt.anchor
				? {
						side: rt.anchor.side,
						line: rt.anchor.line,
						startSide: rt.anchor.startSide,
						startLine: rt.anchor.startLine,
					}
				: {}),
		};
		const existing = (await this.store.read()).find(
			(f) => f.anchor.subject === "thread" && f.anchor.thread === rt.id,
		);
		if (existing) {
			throw new AgentConflictError(
				"This thread already has a conversation",
				existing.id,
			);
		}
		return anchor;
	}

	/**
	 * The folds joined with GitHub's threads, read only when a thread
	 * conversation is among them. When GitHub can't be read, thread
	 * conversations stay live (where their thread is), flagged
	 * `githubUnknown`, with their own stored `resolved`: never a made-up one.
	 */
	async #joined(folds: AgentThreadFold[]): Promise<AgentThreadFold[]> {
		if (!folds.some((f) => f.anchor.subject === "thread")) return folds;
		const threads = await this.github.threads().catch(() => null);
		if (threads) return joinGithub(folds, threads);
		return folds.map((f) =>
			f.anchor.subject === "thread" ? { ...f, githubUnknown: true } : f,
		);
	}

	async #joinedOne(t: AgentThreadFold): Promise<AgentThreadFold> {
		return (await this.#joined([t]))[0] ?? t;
	}

	async #view(t: AgentThreadFold): Promise<AgentThread> {
		const { clientId: _, ...thread } = t;
		if (t.anchor.subject !== "line") return thread;
		const code = await this.code(t.anchor, t.at).catch(() => undefined);
		return code ? { ...thread, code } : thread;
	}
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
	/** The PR's review threads as last read from GitHub (their summaries). */
	threads(): Promise<ReviewThread[]>;
	/** One review thread, null when GitHub doesn't list it; a deleted one says so (`unavailable`). */
	thread(id: string): Promise<ReviewThread | null>;
	/** The reviewer's patch sets. */
	patchsets(): readonly { number: number; head: string; mergeBase: string }[];
	/** The PR's head on GitHub as last read (it may be past the snapshot's). */
	currentHead(): string;
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
	const runner = new AgentRunner({
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
	});
	return new AgentHost(
		runner,
		store,
		async (anchor, at) => {
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
		},
		{
			threads: () => src.threads(),
			thread: (id) => src.thread(id),
			patchsets: () => src.patchsets(),
			base: () => src.snapshot().base,
		},
	);
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
