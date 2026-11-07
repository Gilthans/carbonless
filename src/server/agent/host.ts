import type {
	AgentAnchor,
	AgentMessageRequest,
	AgentStatus,
	AgentThread,
	OpenAgentThreadRequest,
} from "../../shared/agent.js";
import type { CodeWindow } from "../../shared/types.js";
import type { AgentRunner } from "./runner.js";
import type { AgentThreadFold, AgentThreadStore } from "./store.js";

/** The port this server listens on (serve.ts sets it): the claim names it. */
let listeningPort = 0;
export const setServerPort = (port: number): void => {
	listeningPort = port;
};
export const serverPort = (): number => listeningPort;

/**
 * A review's agent as its Session owns it: the runner, and the one store
 * of the reviewer's agent threads every route goes through (its dedupe of
 * clientIds holds within one store).
 */
export class AgentHost {
	constructor(
		private readonly runner: AgentRunner,
		private readonly store: AgentThreadStore,
		private readonly code: (
			anchor: AgentAnchor,
			at: string,
		) => Promise<CodeWindow | undefined>,
	) {}

	status(): Promise<AgentStatus> {
		return this.runner.status();
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
		this.runner.poke();
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
		this.runner.poke();
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

	close(): Promise<void> {
		return this.runner.close();
	}

	async #view(t: AgentThreadFold): Promise<AgentThread> {
		const { clientId: _, ...thread } = t;
		if (t.anchor.subject !== "line") return thread;
		const code = await this.code(t.anchor, t.at).catch(() => undefined);
		return code ? { ...thread, code } : thread;
	}
}
