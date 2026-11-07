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
} from "../../shared/agent.js";
import { AcpAgent, AgentStartError, agentEnv } from "./acp.js";
import { agentsDir, type Checkout, createCheckout } from "./checkout.js";
import { takeClaim } from "./claim.js";
import { decidePermission } from "./policy.js";
import {
	anchorFor,
	buildPrompt,
	type PromptEnvelope,
	type PromptMessage,
	type PromptReview,
	sanitizeEnvelope,
} from "./prompt.js";
import type { AgentThreadFold, AgentThreadStore } from "./store.js";

/** What the runner asks of the review it serves. */
export interface RunnerFacts {
	review(): PromptReview;
	prFacts(): Promise<{ title: string; body: string; files: string[] }>;
	anchored(
		anchor: AgentAnchor,
	): Promise<{ uri: string; mimeType: string; text: string } | null>;
	hunk(anchor: AgentAnchor): Promise<string | null>;
	authorOf(login: string): "reviewer" | "pr_author" | "other";
}

export interface RunnerDeps {
	reviewId: string;
	config(): Promise<{ agent: AgentConfig | null; problems: string[] }>;
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
	/** Crashes since the last turn that ended without one. */
	#crashes = 0;
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
				if (read.changed && this.#config) {
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

	/** Reads the config; on a change, a turn under way is cancelled (the pump applies it). */
	async #readConfig(): Promise<{ changed: boolean }> {
		const { agent, problems } = await this.#deps.config();
		this.#problems = problems;
		this.#configured = agent !== null;
		const key = agent ? JSON.stringify(agent) : null;
		if (key === this.#key) return { changed: false };
		const first = this.#key === undefined;
		this.#key = key;
		this.#config = agent;
		this.#crashes = 0;
		if (this.#proc && this.#proc.key !== key && this.#answering) {
			await this.#proc.agent?.cancel();
		}
		return { changed: !first };
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
		if (this.#proc?.agent) return this.#proc.agent;
		// Twice crashed without a good turn between: stays error until the config changes.
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
			const threads = await this.#deps.store.read();
			const next = threads.find((t) => !t.resolved && t.waiting);
			if (!next) {
				if (this.#current(agent)) this.#set("ready");
				return;
			}
			if (!(await this.#turn(agent, next))) return;
		}
	}

	/** One prompt for `thread`; false when draining should stop. */
	async #turn(agent: AcpAgent, thread: AgentThreadFold): Promise<boolean> {
		const { facts } = this.#deps;
		const review = facts.review();
		const rejected = this.#notices.get(thread.id);
		// The tree follows the PR's head (a Refresh moves it).
		const stuck = await this.#checkout
			?.moveTo(review.head.commit)
			.catch((error: unknown) => (error as Error).message);
		const notice =
			[
				rejected,
				stuck
					? `The PR's head is now ${review.head.commit}, but your checkout could not move there (${stuck.trim().slice(0, 300)}); it is still at the commit you were given before.`
					: undefined,
			]
				.filter(Boolean)
				.join("\n") || undefined;
		const viewer = this.#deps.viewer;
		let pr: PromptEnvelope["pr"];
		if (!this.#prompted) {
			pr = await facts.prFacts().then(
				(p) => ({ title: p.title, body: p.body, files: p.files }),
				() => undefined,
			);
		}
		const env: PromptEnvelope = sanitizeEnvelope({
			kind: "agent_thread",
			review,
			thread: { id: thread.id, anchor: anchorFor(thread.anchor, review) },
			messages: thread.messages.map(
				(m): PromptMessage =>
					m.by === "ai"
						? { author: { role: "agent" }, at: m.at, text: m.text }
						: {
								author: viewer
									? { login: viewer, role: facts.authorOf(viewer) }
									: { role: "reviewer" },
								at: m.at,
								text: m.text,
							},
			),
			...(notice ? { notice } : {}),
			...(pr ? { pr } : {}),
		});
		const [anchored, hunk] = await Promise.all([
			facts.anchored(thread.anchor).catch(() => null),
			facts.hunk(thread.anchor).catch(() => null),
		]);
		if (this.#closed || this.#proc?.agent !== agent) return false;
		// The answer names the last human message it saw: a reply sent while
		// the turn runs lands before the answer and still waits (the fold).
		const asked = thread.messages.findLast((m) => m.by === "human")?.id;
		const answering: Answering = {
			thread: thread.id,
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
		if (this.#answering === answering) this.#answering = null;
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
		try {
			await this.#deps.store.message(thread.id, {
				by: "ai",
				text: reply.text,
				agent: agent.info,
				stop: reply.stop,
				activity: answering.activity,
				...(asked ? { replyTo: asked } : {}),
			});
		} catch (error) {
			this.#set("error", {
				error: `Could not store the reply: ${(error as Error).message}`,
			});
			return false;
		}
		// Gone (a crash): onExit says so; the next question respawns.
		if (this.#proc?.agent !== agent || !agent.alive) return false;
		if (reply.stop !== "error") this.#crashes = 0;
		if (this.#current(agent)) this.#set("ready");
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

function startError(error: unknown): string {
	if (error instanceof AgentStartError) {
		const tail = error.stderr.trim().slice(-500);
		return tail ? `${error.message}: ${tail}` : error.message;
	}
	return (error as Error).message;
}
