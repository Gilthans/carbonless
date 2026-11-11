import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentAnchor,
	type AgentConfig,
	type AgentMessageRequest,
	type AgentStatus,
	type AgentThread,
	JOIN,
	JOINED_PREAMBLE,
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
import { JoinBroker, type WatchLease } from "./join.js";
import {
	isSafePath,
	mimeTypeOf,
	type PromptEnvelope,
	sanitizeThirdParty,
	threadEnvelope,
} from "./prompt.js";
import { AgentRunner, type RunnerFacts } from "./runner.js";
import {
	type AgentThreadFold,
	AgentThreadStore,
	UnknownAgentThreadError,
} from "./store.js";

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

/** A joined session's token isn't (or is no longer) this review's (code unknown-token). */
export class SessionTokenError extends Error {
	constructor() {
		super(
			"This token isn't joined to the review (it left, was disconnected or replaced): call attach again",
		);
	}
}

/** A joined session's reply to a thread `next` didn't hand it (code not-handed). */
export class NotHandedError extends Error {
	constructor(readonly thread: string) {
		super(
			`Thread ${thread} isn't the one handed to you: call next and reply to the thread it gives`,
		);
	}
}

/** A joined session's reply that can't be stored as asked (code invalid). */
export class BadReplyError extends Error {}

/** What `next` hands a joined session. */
export interface SessionQuestion {
	/** First: what follows is data. */
	preamble: string;
	thread: string;
	/** The last human message: the reply's `replyTo`. */
	replyTo: string | undefined;
	envelope: PromptEnvelope;
	anchoredFile: { path: string; commit: string; text: string } | null;
	hunk: string | null;
}

/** The review as a joined session sees it (`review`, an approved `attach`). */
export interface SessionReviewFacts {
	repo: string;
	pr: number;
	url: string;
	base: { ref: string; commit: string };
	head: { ref: string; commit: string };
	mergeBase: string;
	title?: string;
	body?: string;
	files?: string[];
}

/** What a joined session's tools read of the review (reviewAgentHost's facts). */
export interface SessionFacts {
	facts: RunnerFacts;
	viewer?: string;
}

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
		private readonly session?: SessionFacts,
	) {
		this.#restored = join.restore().catch(() => {});
	}

	/** The joined session (by `since`) and the head its last `next` saw. */
	#seen: { since: string; head: string } | null = null;

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

	/** Each thread's id, anchor and when it was asked (what placement reads). */
	async asked(): Promise<{ id: string; anchor: AgentAnchor; at: string }[]> {
		return (await this.store.read()).map(({ id, anchor, at }) => ({
			id,
			anchor,
			at,
		}));
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

	/** Who answers here besides ACP: a joined session, or one asking to join. */
	buddy(): "joined" | "pending" | null {
		const v = this.join.view();
		return v.joined ? "joined" : v.joinRequest ? "pending" : null;
	}

	/** Whether `secret` is the joined session's token (after a restart's restore). */
	async sessionAllowed(secret: string): Promise<boolean> {
		await this.#restored;
		return this.join.check(secret);
	}

	/** The watcher's lease for `secret`; null for a token not joined here. */
	async sessionWatch(secret: string): Promise<WatchLease | null> {
		await this.#restored;
		return this.join.watcher(secret);
	}

	async #token(secret: string): Promise<void> {
		await this.#restored;
		if (!this.join.check(secret)) throw new SessionTokenError();
	}

	#facts(): SessionFacts {
		if (!this.session)
			throw new Error("This review has no facts for a joined session");
		return this.session;
	}

	/** Waiting questions a joined session can take (not the one the ACP buddy still answers). */
	async sessionWaiting(): Promise<number> {
		const busy = this.busyThread();
		return (await this.store.read()).filter(
			(t) => t.waiting && !t.resolved && t.id !== busy,
		).length;
	}

	/** The review's facts for a joined session, sanitised; `withPr` adds the PR's title, body and files. */
	async sessionReview(
		secret: string,
		withPr: boolean,
	): Promise<SessionReviewFacts> {
		await this.#token(secret);
		const { facts } = this.#facts();
		const { tree: _, ...r } = facts.review();
		const s = sanitizeThirdParty;
		const out: SessionReviewFacts = {
			...r,
			base: { ...r.base, ref: s(r.base.ref) },
			head: { ...r.head, ref: s(r.head.ref) },
		};
		if (!withPr) return out;
		const pr = await facts.prFacts().catch(() => null);
		return pr
			? { ...out, title: s(pr.title), body: s(pr.body), files: pr.files.map(s) }
			: out;
	}

	/**
	 * The question for a joined session: the thread handed to it and not
	 * yet answered (again, with what was added since), else the oldest
	 * waiting one (not the ACP buddy's last turn), handed to it; null when
	 * none waits.
	 */
	async sessionNext(secret: string): Promise<SessionQuestion | null> {
		await this.#token(secret);
		const { facts, viewer } = this.#facts();
		const threads = await this.store.read();
		const handed = this.join.handedOut();
		const busy = this.busyThread();
		const thread =
			(handed && threads.find((t) => t.id === handed.thread && !t.resolved)) ||
			threads.find((t) => t.waiting && !t.resolved && t.id !== busy);
		if (!thread) return null;
		// The read took a while: the session may have left meanwhile.
		if (!this.join.check(secret)) throw new SessionTokenError();
		const joined = this.join.view().joined;
		if (!joined) throw new SessionTokenError();
		const asked = thread.messages.findLast((m) => m.by === "human")?.id;
		this.join.handOut(thread.id, asked);
		const head = facts.review().head.commit;
		const seen = this.#seen?.since === joined.since ? this.#seen : null;
		this.#seen = { since: joined.since, head };
		const notice =
			seen && seen.head !== head
				? `The PR's head moved from ${seen.head} to ${head} since your last question.`
				: undefined;
		const envelope = await threadEnvelope(facts, thread, {
			...(viewer ? { viewer } : {}),
			withPr: !seen,
			...(notice ? { notice } : {}),
			tree: false,
		});
		const [anchored, hunk] = await Promise.all([
			facts.anchored(thread.anchor).catch(() => null),
			facts.hunk(thread.anchor).catch(() => null),
		]);
		return {
			preamble: JOINED_PREAMBLE,
			thread: thread.id,
			replyTo: asked,
			envelope,
			anchoredFile: anchored
				? {
						path: envelope.thread.anchor.path,
						commit: envelope.thread.anchor.commit,
						text: anchored.text,
					}
				: null,
			hunk,
		};
	}

	/**
	 * A joined session's answer to the thread `next` handed it, answering
	 * human message `replyTo` (a newer one still waits: the fold).
	 */
	async sessionReply(
		secret: string,
		r: { thread: string; replyTo: string; text: string },
	): Promise<AgentThread> {
		await this.#token(secret);
		const handed = this.join.handedOut();
		if (handed?.thread !== r.thread) throw new NotHandedError(r.thread);
		if (!r.text.trim()) throw new BadReplyError("The reply's text is empty");
		const thread = (await this.store.read()).find((t) => t.id === r.thread);
		if (!thread) throw new UnknownAgentThreadError(r.thread);
		if (!thread.messages.some((m) => m.by === "human" && m.id === r.replyTo)) {
			throw new BadReplyError(
				`replyTo ${r.replyTo} isn't a reviewer's message in thread ${r.thread}: pass the replyTo next gave`,
			);
		}
		// Checked again after the read: a leave meanwhile stores nothing.
		const joined = this.join.view().joined;
		if (!joined || !this.join.check(secret)) throw new SessionTokenError();
		if (this.join.handedOut()?.thread !== r.thread) {
			throw new NotHandedError(r.thread);
		}
		const stored = await this.store.message(r.thread, {
			by: "ai",
			text: r.text,
			agent: {
				name: joined.name,
				version: joined.harness ?? "",
				via: "mcp",
				machine: joined.machine,
			},
			stop: "end_turn",
			activity: [],
			replyTo: r.replyTo,
		});
		this.join.replied(r.thread);
		return this.#view(stored);
	}

	/** Every thread, for a joined session. */
	async sessionThreads(secret: string): Promise<AgentThread[]> {
		await this.#token(secret);
		return this.threads();
	}

	/** The session's own detach. */
	async sessionDetach(secret: string): Promise<void> {
		await this.#token(secret);
		this.join.leave("detached");
	}

	/** A human asked: a joined session's watcher wakes, else the ACP runner. */
	async #asked(): Promise<void> {
		await this.#restored;
		if (this.join.view().joined) {
			// A message to the thread the ACP buddy still answers waits for
			// that turn to end (buildAgentHost wakes the session then).
			if ((await this.sessionWaiting()) > 0) this.join.wake();
		} else this.runner.asked();
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
	/** What a joined session's tools read (none: those tools fail). */
	session?: SessionFacts;
}): AgentHost {
	let runner: HostRunner | undefined;
	// The thread the ACP buddy still answers isn't the session's.
	const waiting = async () => {
		const busy = runner?.inFlight() ?? null;
		return (await o.store.read()).some(
			(t) => t.waiting && !t.resolved && t.id !== busy,
		);
	};
	const join: JoinBroker = new JoinBroker({
		dir: o.dir,
		...(o.now ? { now: o.now } : {}),
		...(o.claim ? { claim: o.claim } : {}),
		// The broker already set ACP off (before joined.json).
		// Once the ACP buddy's last turn ends (or is cancelled), what it
		// left waiting is the session's: wake its watcher.
		onApproved: async () => {
			void runner
				?.stop(JOIN.acpStopMs)
				.then(async () => {
					if (await waiting()) join.wake();
				})
				.catch(() => {});
		},
		onLeft: () => {},
		waiting: () => waiting(),
	});
	// A joined session keeps the ACP buddy off even without the file.
	runner = o.runner(() => join.acpOff() || join.isJoined(), o.claim);
	return new AgentHost(runner, o.store, o.code, join, o.session);
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
		session: { facts, viewer: src.viewer },
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
