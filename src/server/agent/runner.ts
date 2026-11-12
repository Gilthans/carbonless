import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
	type ActivityKind,
	AGENT_TURN_MS,
	type AgentActivity,
	type AgentAnchor,
	type AgentConfig,
	type AgentIdentity,
	type AgentState,
	type AgentStatus,
	type AgentStop,
	type AgentView,
} from "../../shared/agent.js";
import { runGit } from "../git.js";
import { AcpAgent, AgentStartError, agentEnv } from "./acp.js";
import { agentsDir, type Checkout, createCheckout } from "./checkout.js";
import { takeClaim } from "./claim.js";
import { decidePermission } from "./policy.js";
import {
	anchorFor,
	buildPrompt,
	type CommentRole,
	type GithubThreadFacts,
	type PromptEnvelope,
	type PromptMessage,
	type PromptPatchset,
	type PromptReview,
	sanitizeEnvelope,
	takeSuggestion,
	threadEnvelope,
} from "./prompt.js";
import type { AgentThreadFold, AgentThreadStore } from "./store.js";

/**
 * What the runner asks of the review it serves. None of it writes to
 * GitHub: the runner can't resolve, reply to or write to a thread.
 */
export interface RunnerFacts {
	review(): PromptReview;
	prFacts(): Promise<{ title: string; body: string; files: string[] }>;
	anchored(
		anchor: AgentAnchor,
	): Promise<{ uri: string; mimeType: string; text: string } | null>;
	hunk(anchor: AgentAnchor): Promise<string | null>;
	authorOf(login: string): Promise<CommentRole>;
	/**
	 * The folds joined with GitHub's threads (githubJoin.ts): a live
	 * thread conversation resolved with its GitHub thread, an orphan a
	 * span thread, `githubUnknown` when GitHub can't be read.
	 */
	join(folds: AgentThreadFold[]): Promise<AgentThreadFold[]>;
	/**
	 * GitHub thread `thread` from the session's current read, placed on
	 * `view`; null when GitHub no longer lists it; throws when it can't be read.
	 */
	github(thread: string, view: AgentView): Promise<GithubThreadFacts | null>;
	/** The reviewer's patch sets and GitHub's newest head as last read. */
	views(): { patchsets: PromptPatchset[]; current: string };
	/** Asks GitHub for the PR's head, fetching a new one into the cache clone. */
	checkHead(): Promise<void>;
}

/** What a turn sends: the envelope, the anchored file and the code block. */
interface Prepared {
	env: PromptEnvelope;
	anchored: { uri: string; mimeType: string; text: string } | null;
	hunk: string | null;
	/** A thread conversation's turn: its answer may suggest resolving. */
	suggestions: boolean;
}

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface RunnerDeps {
	reviewId: string;
	/**
	 * The machine's agent config; `saves` counts the setup modal's Saves
	 * (each one, even of the same config, lets a crashed agent start again).
	 */
	config(): Promise<{
		agent: AgentConfig | null;
		problems: string[];
		saves?: number;
	}>;
	store: AgentThreadStore;
	cacheClone: string;
	head: string;
	port: number;
	facts: RunnerFacts;
	now?: () => number;
	turnMs?: number;
	/** The reviewer's login, named on their messages in the envelope. */
	viewer?: string;
}

/** A live title is cut here; the stored list is capped again (capActivity). */
const MAX_TITLE = 200;
/** Live activity entries kept for the status while a turn runs. */
const MAX_LIVE_ACTIVITY = 200;
const ACTIVITY_KINDS: readonly string[] = [
	"read",
	"edit",
	"delete",
	"move",
	"search",
	"execute",
	"think",
	"fetch",
	"switch_mode",
	"other",
] satisfies ActivityKind[];

const kindOf = (kind: unknown): ActivityKind =>
	typeof kind === "string" && ACTIVITY_KINDS.includes(kind)
		? (kind as ActivityKind)
		: "other";
const titleOf = (title: unknown): string =>
	typeof title === "string" ? title.slice(0, MAX_TITLE) : "";

/** One spawned process, as the runner tracks it. */
interface Proc {
	agent: AcpAgent | null;
	/** Stops its start while under way. */
	abort: AbortController;
	/** The config it was spawned with (JSON). */
	key: string;
	/** Closed on purpose (config change, close): its exit isn't a crash. */
	stopping: boolean;
}

interface Answering {
	thread: string;
	/** The last human message the turn answers. */
	asked: string | undefined;
	text: string;
	activity: AgentActivity[];
	/** toolCallId → its entry in `activity`. */
	calls: Map<string, AgentActivity>;
}

/**
 * The reviewer's agent for one review: its status, and the queue of
 * waiting threads, answered one prompt at a time, oldest opened first. See
 * the spec's "Lifecycle and status" and "The runner".
 */
export class AgentRunner {
	readonly #deps: RunnerDeps;
	readonly #now: () => number;
	#state: AgentState = "off";
	#since: number;
	#error: string | undefined;
	#elsewhere: number | undefined;
	#configured = false;
	#problems: string[] = [];
	/** The config last read (JSON; null: none); undefined before the first read. */
	#key: string | null | undefined;
	#config: AgentConfig | null = null;
	#proc: Proc | null = null;
	#identity: AgentIdentity | undefined;
	#release: (() => Promise<void>) | null = null;
	#checkout: Checkout | null = null;
	#answering: Answering | null = null;
	/**
	 * Crashes since the last turn that ended without one: at two, no
	 * respawn until a human asks again or the config is saved.
	 */
	#crashes = 0;
	/** The config saves last seen (RunnerDeps.config). */
	#saves: number | undefined;
	/** Whether the process has had a prompt (the first carries `pr`). */
	#prompted = false;
	/** A rejected permission's reason, for the thread's next envelope. */
	readonly #notices = new Map<string, string>();
	/** Agents that went away by crashing (their last turn is stored). */
	readonly #crashedAgents = new WeakSet<AcpAgent>();
	#pump: Promise<void> | null = null;
	#again = false;
	#closed: Promise<void> | null = null;

	constructor(deps: RunnerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#since = this.#now();
	}

	/** The status; reads the config (a change is picked up here) and retries a claim held elsewhere. */
	async status(): Promise<AgentStatus> {
		if (!this.#closed) {
			const read = await this.#readConfig();
			if (!this.#closed) {
				if (read.saved && !read.changed && this.#config) {
					// A Save (the same config): a stopped agent starts again.
					if (this.#state === "error" || this.#state === "off") this.poke();
				} else if (read.changed && this.#config) {
					if (this.#state !== "elsewhere") this.#set("starting");
					this.poke();
				} else if (read.changed) {
					this.#set("off");
					this.poke();
				} else if (
					this.#config &&
					(this.#state === "elsewhere" ||
						(this.#state === "off" && !this.#pump))
				) {
					this.poke();
				}
			}
		}
		let waiting = 0;
		try {
			waiting = (await this.#deps.store.read()).filter(
				(t) => t.waiting && !t.resolved,
			).length;
		} catch {
			// The count is a hint; the ref may be unreadable a moment.
		}
		// Questions asked elsewhere (another server showing `elsewhere`)
		// reach the ref, not this runner: the holder answers them on its poll.
		if (waiting > 0 && this.#state === "ready" && !this.#pump) this.poke();
		const error =
			this.#state === "error"
				? this.#error
				: this.#problems.length
					? this.#problems.join("; ")
					: undefined;
		const answering = this.#answering;
		return {
			state: this.#state,
			configured: this.#configured,
			...(this.#identity ? { agent: this.#identity } : {}),
			since: new Date(this.#since).toISOString(),
			...(answering
				? {
						answering: {
							thread: answering.thread,
							text: answering.text,
							activity: answering.activity.map((a) => ({ ...a })),
							...(answering.asked ? { asked: answering.asked } : {}),
						},
					}
				: {}),
			...(error ? { error } : {}),
			...(this.#state === "elsewhere" && this.#elsewhere !== undefined
				? { elsewhere: this.#elsewhere }
				: {}),
			waiting,
		};
	}

	/** After a human open or message: spawns if needed, then drains. Never throws. */
	poke(): void {
		if (this.#closed) return;
		this.#again = true;
		if (this.#pump) return;
		this.#pump = this.#run()
			.catch((error: unknown) => {
				this.#set("error", { error: (error as Error).message });
			})
			.finally(() => {
				this.#pump = null;
				if (this.#again && !this.#closed) this.poke();
			});
	}

	/**
	 * A human asked (a new thread or a message): like poke, and an agent
	 * that crashed twice may start again. One question, one try: never a loop.
	 */
	asked(): void {
		this.#crashes = 0;
		this.poke();
	}

	/** Resolves once nothing is running (tests). */
	async settled(): Promise<void> {
		while (this.#pump) await this.#pump;
	}

	/** Stops the current turn only. */
	async cancel(): Promise<void> {
		const agent = this.#proc?.agent;
		if (agent && this.#answering) await agent.cancel();
	}

	/** Cancels, closes the agent, removes the checkout and releases the claim. */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			this.#again = false;
			await this.#stopProc();
			await this.#pump;
			await this.#checkout?.remove().catch(() => {});
			this.#checkout = null;
			await this.#release?.().catch(() => {});
			this.#release = null;
			this.#answering = null;
			this.#set("off");
		})();
		return this.#closed;
	}

	#set(
		state: AgentState,
		extra: { error?: string; elsewhere?: number } = {},
	): void {
		if (state !== this.#state) this.#since = this.#now();
		this.#state = state;
		this.#error = extra.error;
		this.#elsewhere = extra.elsewhere;
	}

	/**
	 * Reads the config; on a change, a turn under way is cancelled (the pump
	 * applies it). A new Save, changed or not, opens the crash gate.
	 */
	async #readConfig(): Promise<{ changed: boolean; saved: boolean }> {
		const { agent, problems, saves } = await this.#deps.config();
		this.#problems = problems;
		this.#configured = agent !== null;
		const saved = this.#saves !== undefined && saves !== this.#saves;
		this.#saves = saves;
		if (saved) this.#crashes = 0;
		const key = agent ? JSON.stringify(agent) : null;
		if (key === this.#key) return { changed: false, saved };
		const first = this.#key === undefined;
		this.#key = key;
		this.#config = agent;
		this.#crashes = 0;
		if (this.#proc && this.#proc.key !== key && this.#answering) {
			await this.#proc.agent?.cancel();
		}
		return { changed: !first, saved };
	}

	async #run(): Promise<void> {
		while (this.#again && !this.#closed) {
			this.#again = false;
			const agent = await this.#ensure();
			if (agent) await this.#drain(agent);
		}
	}

	/** The running agent, spawned if it should run; null when it can't or shouldn't. */
	async #ensure(): Promise<AcpAgent | null> {
		await this.#readConfig();
		if (this.#closed) return null;
		const config = this.#config;
		if (this.#proc && this.#proc.key !== this.#key) await this.#stopProc();
		if (!config) {
			// Off: another server may take the review's agent (and sweep its
			// dir), so the tree goes with the claim.
			await this.#checkout?.remove().catch(() => {});
			this.#checkout = null;
			await this.#release?.().catch(() => {});
			this.#release = null;
			this.#set("off");
			return null;
		}
		if (this.#proc?.agent) {
			if (this.#proc.agent.alive) return this.#proc.agent;
			// Its connection closed but the process lingers: killed, replaced.
			await this.#lost(this.#proc);
		}
		// Twice crashed without a good turn between: stays error until a
		// human asks again or the config is saved.
		if (this.#crashes >= 2) return null;
		if (!this.#release) {
			const claim = await takeClaim(this.#dir(), {
				pid: process.pid,
				port: this.#deps.port,
			});
			if (!claim.ok) {
				this.#set("elsewhere", { elsewhere: claim.holder.port });
				return null;
			}
			if (this.#closed) {
				await claim.release();
				return null;
			}
			this.#release = claim.release;
		}
		// The config moved while the claim was taken: the next round has it.
		if (this.#config !== config) return null;
		this.#set("starting");
		// A tree removed under us (a sweep, by hand) is made again.
		if (this.#checkout && !existsSync(join(this.#checkout.tree, ".git"))) {
			this.#checkout = null;
		}
		try {
			this.#checkout ??= await createCheckout(
				this.#deps.cacheClone,
				this.#deps.reviewId,
				this.#deps.facts.review().head.commit || this.#deps.head,
			);
		} catch (error) {
			this.#set("error", {
				error: `Could not make the agent's checkout: ${(error as Error).message}`,
			});
			return null;
		}
		// Closed while the checkout was made: close() found no process to
		// stop and waits for this pump, so a start now would hold it until
		// the start times out (close removes the checkout after).
		if (this.#closed) return null;
		const key = this.#key as string;
		const proc: Proc = {
			agent: null,
			abort: new AbortController(),
			key,
			stopping: false,
		};
		this.#proc = proc;
		let agent: AcpAgent;
		try {
			agent = await AcpAgent.spawn({
				command: config.command,
				args: config.args,
				env: agentEnv(config.env),
				cwd: this.#checkout.dir,
				stderrFile: join(this.#checkout.dir, "agent.stderr.log"),
				onUpdate: (u) => this.#onUpdate(u),
				onPermission: (req) => this.#onPermission(req),
				onExit: (code, signal) => this.#onExit(proc, code, signal),
				signal: proc.abort.signal,
			});
		} catch (error) {
			if (this.#proc === proc) this.#proc = null;
			if (!proc.stopping) this.#set("error", { error: startError(error) });
			return null;
		}
		proc.agent = agent;
		if (
			proc.stopping ||
			this.#closed ||
			this.#proc !== proc ||
			proc.key !== this.#key
		) {
			await agent.close();
			return null;
		}
		this.#identity = agent.info;
		this.#prompted = false;
		this.#set("ready");
		return agent;
	}

	async #stopProc(): Promise<void> {
		const proc = this.#proc;
		if (!proc) return;
		this.#proc = null;
		proc.stopping = true;
		proc.abort.abort();
		await proc.agent?.close();
	}

	/**
	 * A process whose connection closed while it still runs: a crash (it
	 * counts, its last turn is stored), then killed.
	 */
	async #lost(proc: Proc): Promise<void> {
		if (proc.stopping) return;
		if (this.#proc === proc) this.#proc = null;
		proc.stopping = true;
		if (proc.agent) this.#crashedAgents.add(proc.agent);
		this.#crashes++;
		const tail = proc.agent?.stderrTail().trim() ?? "";
		this.#set("error", {
			error: `The agent's connection closed${tail ? `: ${tail.slice(-500)}` : ""}`,
		});
		await proc.agent?.close();
	}

	#onExit(proc: Proc, code: number | null, signal: string | null): void {
		if (proc.stopping || this.#closed) return;
		if (this.#proc === proc) this.#proc = null;
		if (proc.agent) this.#crashedAgents.add(proc.agent);
		this.#crashes++;
		const tail = proc.agent?.stderrTail().trim() ?? "";
		const how = signal ? `on ${signal}` : `with code ${code}`;
		this.#set("error", {
			error: `exited ${how}${tail ? `: ${tail.slice(-500)}` : ""}`,
		});
	}

	/** Whether `agent` is the one that should run now (a status may have just turned it off). */
	#current(agent: AcpAgent): boolean {
		return (
			!this.#closed &&
			this.#proc?.agent === agent &&
			this.#proc.key === this.#key
		);
	}

	#dir(): string {
		return join(agentsDir(), this.#deps.reviewId);
	}

	/** Answers waiting threads, oldest opened first, while this agent runs. */
	async #drain(agent: AcpAgent): Promise<void> {
		for (;;) {
			if (this.#closed || this.#proc?.agent !== agent) return;
			if (this.#proc.key !== this.#key || !agent.alive) return;
			const threads = await this.#deps.facts.join(
				await this.#deps.store.read(),
			);
			// A question already waiting on a GitHub thread resolved since is
			// still answered (it was asked); a resolved span thread's isn't.
			const next = threads.find(
				(t) => t.waiting && (t.anchor.subject === "thread" || !t.resolved),
			);
			if (!next) {
				// A failed last turn keeps its reason up until the next one.
				if (this.#current(agent) && this.#state !== "error") {
					this.#set("ready");
				}
				return;
			}
			if (!(await this.#turn(agent, next))) return;
		}
	}

	/** One prompt for `thread`; false when draining should stop. */
	async #turn(agent: AcpAgent, thread: AgentThreadFold): Promise<boolean> {
		const { facts } = this.#deps;
		const rejected = this.#notices.get(thread.id);
		let pr: PromptEnvelope["pr"];
		if (!this.#prompted) {
			pr = await facts.prFacts().then(
				(p) => ({ title: p.title, body: p.body, files: p.files }),
				() => undefined,
			);
		}
		const messages = await this.#messages(thread);
		const { env, anchored, hunk, suggestions } =
			thread.anchor.subject === "thread"
				? await this.#threadTurn(thread, messages, rejected, pr)
				: await this.#spanTurn(thread, messages, rejected, pr);
		if (this.#closed || this.#proc?.agent !== agent) return false;
		// The answer names the last human message it saw: a reply sent while
		// the turn runs lands before the answer and still waits (the fold).
		const asked = thread.messages.findLast((m) => m.by === "human")?.id;
		const answering: Answering = {
			thread: thread.id,
			asked,
			text: "",
			activity: [],
			calls: new Map(),
		};
		this.#answering = answering;
		if (this.#current(agent)) this.#set("busy");
		const deadline = setTimeout(
			() => void agent.cancel(),
			this.#deps.turnMs ?? AGENT_TURN_MS,
		);
		const reply = await agent.prompt(buildPrompt(env, anchored, hunk));
		clearTimeout(deadline);
		this.#prompted = true;
		try {
			return await this.#store(
				agent,
				thread,
				reply,
				answering,
				rejected,
				suggestions,
			);
		} finally {
			// Only once the reply is stored (or never will be): the status
			// keeps the streamed text until the thread holds it.
			if (this.#answering === answering) this.#answering = null;
		}
	}

	/** The thread's messages as the envelope gives them. */
	async #messages(thread: AgentThreadFold): Promise<PromptMessage[]> {
		const viewer = this.#deps.viewer;
		const role = viewer ? await this.#deps.facts.authorOf(viewer) : undefined;
		return thread.messages.map(
			(m): PromptMessage =>
				m.by === "ai"
					? { author: { role: "agent" }, at: m.at, text: m.text }
					: {
							author:
								viewer && role ? { login: viewer, role } : { role: "reviewer" },
							at: m.at,
							text: m.text,
						},
		);
	}

	/**
	 * A span thread's turn (an orphan's too): the tree follows the PR's
	 * head (a Refresh moves it); the anchored file and the hunk around it.
	 */
	async #spanTurn(
		thread: AgentThreadFold,
		messages: PromptMessage[],
		rejected: string | undefined,
		pr: PromptEnvelope["pr"],
	): Promise<Prepared> {
		const { facts } = this.#deps;
		const review = facts.review();
		const stuck = await this.#moveTo(review.head.commit);
		const notice = joinNotices([
			rejected,
			thread.orphaned
				? `The GitHub thread this conversation was about is gone (deleted, or no longer listed): it is a regular conversation on the thread's last known lines (${thread.anchor.path} at ${thread.anchor.commit || "an unknown commit"}).`
				: undefined,
			stuck
				? `The PR's head is now ${review.head.commit}, but your checkout could not move there (${stuck}); it is still at the commit you were given before.`
				: undefined,
		]);
		const env = sanitizeEnvelope({
			kind: "agent_thread",
			review,
			thread: { id: thread.id, anchor: anchorFor(thread.anchor, review) },
			messages,
			...(notice ? { notice } : {}),
			...(pr ? { pr } : {}),
		});
		const [anchored, hunk] = await Promise.all([
			facts.anchored(thread.anchor).catch(() => null),
			facts.hunk(thread.anchor).catch(() => null),
		]);
		return { env, anchored, hunk, suggestions: false };
	}

	/**
	 * A thread conversation's turn: checkHead first (so `current`'s objects
	 * are in the clone), the view of the last human message (else the
	 * latest patch set), the checkout moved to `view.right`, GitHub's
	 * thread read now (none when it can't be: never a made-up resolved),
	 * and any commit the clone lacks named in the notice.
	 */
	async #threadTurn(
		thread: AgentThreadFold,
		messages: PromptMessage[],
		rejected: string | undefined,
		pr: PromptEnvelope["pr"],
	): Promise<Prepared> {
		const { facts } = this.#deps;
		const anchor = thread.anchor as Extract<AgentAnchor, { subject: "thread" }>;
		const checked = await facts.checkHead().then(
			() => undefined,
			(error: unknown) => oneLine((error as Error).message),
		);
		const review = facts.review();
		const { patchsets, current } = facts.views();
		const view = viewOf(thread, patchsets, review);
		let github: GithubThreadFacts | null = null;
		let unread: string | undefined;
		let gone = false;
		if (thread.githubUnknown) unread = "";
		else {
			try {
				github = await facts.github(anchor.thread, view);
				gone = github === null;
			} catch (error) {
				unread = oneLine((error as Error).message);
			}
		}
		const stuck = await this.#moveTo(view.right);
		const opened = github ? github.openedOn : anchor.commit;
		const missing = await this.#missing([
			[opened, "the commit the thread was opened on (openedOn)"],
			[view.left, "view.left"],
			[view.right, "view.right"],
			[current, "current"],
		]);
		const notice = joinNotices([
			rejected,
			unread !== undefined
				? `GitHub couldn't be read${unread ? ` (${unread})` : ""}: the thread's comments and whether it is resolved are not in this prompt.`
				: undefined,
			gone
				? `The GitHub thread (${anchor.path}) is gone: it is no longer listed on GitHub.`
				: undefined,
			checked
				? `carbonless couldn't check GitHub for the PR's newest head (${checked}): \`current\` is the head as last read.`
				: undefined,
			stuck
				? `Your checkout could not move to view.right, ${view.right} (${stuck}); run \`git rev-parse HEAD\` to see where it is.`
				: undefined,
			...missing.map(
				([oid, what]) =>
					`Commit ${oid} (${what}) is missing from the clone: it was never fetched (likely force-pushed away before carbonless saw it), so it can't be checked out or diffed.`,
			),
		]);
		const env = sanitizeEnvelope(
			threadEnvelope({
				review,
				thread: { id: thread.id, anchor },
				github,
				view,
				current,
				patchsets,
				messages,
				...(notice ? { notice } : {}),
				...(pr ? { pr } : {}),
			}),
		);
		const anchored = await facts.anchored(anchor).catch(() => null);
		return {
			env,
			anchored,
			hunk: github?.code ?? null,
			suggestions: true,
		};
	}

	/** Moves the checkout to `commit`: undefined when it is there, else why not (one line). */
	async #moveTo(commit: string): Promise<string | undefined> {
		const stuck = await this.#checkout
			?.moveTo(commit)
			.catch((error: unknown) => (error as Error).message);
		return stuck ? oneLine(stuck) : undefined;
	}

	/** The commits (OIDs; others are skipped, never passed to git) the clone doesn't have. */
	async #missing(commits: [string, string][]): Promise<[string, string][]> {
		const repo = this.#checkout?.tree ?? this.#deps.cacheClone;
		const out: [string, string][] = [];
		const seen = new Set<string>();
		for (const [oid, what] of commits) {
			if (!OID.test(oid) || seen.has(oid)) continue;
			seen.add(oid);
			const type = (
				await runGit(repo, ["cat-file", "-t", `${oid}^{commit}`], {
					allowFailure: true,
				})
			).trim();
			if (type !== "commit") out.push([oid, what]);
		}
		return out;
	}

	/** The checkout's commit now, when it can be read. */
	async #checkoutHead(): Promise<string | undefined> {
		const tree = this.#checkout?.tree;
		if (!tree) return undefined;
		const head = (
			await runGit(tree, ["rev-parse", "HEAD"], { allowFailure: true })
		).trim();
		return OID.test(head) ? head : undefined;
	}

	/** Stores a turn's reply; false when draining should stop. */
	async #store(
		agent: AcpAgent,
		thread: AgentThreadFold,
		reply: { text: string; stop: AgentStop; error?: string },
		answering: Answering,
		rejected: string | undefined,
		suggestions: boolean,
	): Promise<boolean> {
		if (rejected !== undefined && this.#notices.get(thread.id) === rejected) {
			this.#notices.delete(thread.id);
		}
		// A process stopped on purpose (the session closing, a new config):
		// nothing half-written lands; the thread still waits for the next one.
		const stoppedOnPurpose =
			this.#closed ||
			// The config changed under the turn: the new agent answers it.
			(this.#proc?.agent === agent && this.#proc.key !== this.#key) ||
			(this.#proc?.agent !== agent && !this.#crashedLast(agent));
		if (stoppedOnPurpose) return false;
		// A suggestion is data on the message: only a human's press resolves.
		// The marker is stripped on any stop; only a finished answer suggests.
		const taken = suggestions
			? takeSuggestion(reply.text)
			: { text: reply.text, suggests: false };
		const text = taken.text;
		const suggests = taken.suggests && reply.stop === "end_turn";
		const head = await this.#checkoutHead();
		try {
			await this.#deps.store.message(thread.id, {
				by: "ai",
				text,
				agent: agent.info,
				...(head ? { head } : {}),
				...(suggests ? { suggests: "resolve" as const } : {}),
				stop: reply.stop,
				activity: answering.activity,
				...(answering.asked ? { replyTo: answering.asked } : {}),
				...(reply.error ? { error: reply.error } : {}),
			});
		} catch (error) {
			this.#set("error", {
				error: `Could not store the reply: ${(error as Error).message}`,
			});
			return false;
		}
		// Its connection closed while the process lingers: a crash.
		if (this.#proc?.agent === agent && !agent.alive) {
			await this.#lost(this.#proc);
			return false;
		}
		// Gone (a crash): onExit says so; the next question respawns.
		if (this.#proc?.agent !== agent || !agent.alive) return false;
		if (reply.stop !== "error") this.#crashes = 0;
		if (this.#current(agent)) {
			// The agent's reason for a failed turn, until the next turn.
			if (reply.error) this.#set("error", { error: reply.error });
			else this.#set("ready");
		}
		return true;
	}

	/** Whether `agent` went away by crashing (not stopped on purpose). */
	#crashedLast(agent: AcpAgent): boolean {
		return this.#crashedAgents.has(agent);
	}

	#onUpdate(u: SessionUpdate): void {
		const a = this.#answering;
		if (!a) return;
		if (u.sessionUpdate === "agent_message_chunk") {
			if (u.content.type === "text") a.text += u.content.text;
		} else if (u.sessionUpdate === "tool_call") {
			const entry: AgentActivity = {
				kind: kindOf(u.kind),
				title: titleOf(u.title),
			};
			if (a.activity.length < MAX_LIVE_ACTIVITY) a.activity.push(entry);
			a.calls.set(u.toolCallId, entry);
		} else if (u.sessionUpdate === "tool_call_update") {
			const entry = a.calls.get(u.toolCallId);
			if (entry && typeof u.title === "string" && u.title) {
				entry.title = titleOf(u.title);
			}
		}
	}

	#onPermission(req: RequestPermissionRequest): RequestPermissionResponse {
		const d = decidePermission(req, this.#config?.leash ?? "open");
		const a = this.#answering;
		if (a) {
			const known = a.calls.get(req.toolCall.toolCallId);
			if (known) known.decision = d.decision;
			else if (a.activity.length < MAX_LIVE_ACTIVITY) {
				const entry: AgentActivity = {
					kind: kindOf(req.toolCall.kind),
					title: titleOf(req.toolCall.title),
					decision: d.decision,
				};
				a.activity.push(entry);
				a.calls.set(req.toolCall.toolCallId, entry);
			}
			if (d.decision === "rejected" && d.reason) {
				this.#notices.set(a.thread, d.reason);
			}
		}
		return d.response;
	}
}

/** The notices that are set, one per line; undefined when none is. */
function joinNotices(parts: (string | undefined)[]): string | undefined {
	return parts.filter(Boolean).join("\n") || undefined;
}

/** An error message on one line, cut to 300 characters. */
function oneLine(message: string): string {
	return message.trim().replace(/\s+/g, " ").slice(0, 300);
}

/**
 * The comparison a thread turn answers in: the view sent with the last
 * human message, else (an agent-started conversation, or a message sent
 * without one) the latest patch set against the base branch, or the
 * snapshot's head when there is none.
 */
export function viewOf(
	thread: AgentThreadFold,
	patchsets: readonly PromptPatchset[],
	review: PromptReview,
): AgentView {
	const sent = thread.messages.findLast((m) => m.by === "human")?.view;
	if (sent && OID.test(sent.right) && OID.test(sent.left)) return sent;
	const latest = patchsets.reduce<PromptPatchset | undefined>(
		(a, p) => (a && a.number > p.number ? a : p),
		undefined,
	);
	if (latest) {
		return {
			target: { patchset: latest.number },
			from: { branch: true },
			left: latest.mergeBase,
			right: latest.head,
		};
	}
	return {
		target: { head: review.head.commit },
		from: { branch: true },
		left: review.mergeBase,
		right: review.head.commit,
	};
}

function startError(error: unknown): string {
	if (error instanceof AgentStartError) {
		const tail = error.stderr.trim().slice(-500);
		return tail ? `${error.message}: ${tail}` : error.message;
	}
	return (error as Error).message;
}
