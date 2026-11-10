import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";
import {
	type AgentStatus,
	JOIN,
	type JoinIdentity,
	type JoinLeave,
} from "../../shared/agent.js";
import { sanitizeThirdParty } from "./prompt.js";

/**
 * A session carbonless didn't launch, joined to one review through MCP:
 * its join requests (the reviewer approves each), its token, its presence
 * (the watcher's open connection is the keep-alive) and the review's "ACP
 * off" flag. Server memory plus two files in the review's agent dir:
 * `joined.json` (token hash, identity, since) and `acp-off`. Never git.
 * See docs/superpowers/specs/2026-11-10-join-review-mcp-design.md.
 */

export type AttachOutcome =
	| { state: "pending"; request: string }
	| { state: "denied" | "expired" }
	| { state: "approved"; token: string };

/** An Approve or Deny of a request that isn't the pending one (HTTP 409). */
export class StaleJoinRequestError extends Error {
	constructor(readonly request: string) {
		super("This join request was already answered, replaced or expired");
	}
}

/**
 * One open watcher connection. `deliver` resolves when a question waits
 * for the session (write the line, close); `ended` when the broker ends
 * the lease: `replaced` by a newer watcher (409), `left` (the session
 * left: 410), `closed` (the review's session closed: drop the socket, the
 * watcher's retry finds the next one). `close()` when the socket ends.
 */
export interface WatchLease {
	deliver: Promise<void>;
	ended: Promise<"replaced" | "left" | "closed">;
	close(): void;
}

export interface JoinBrokerDeps {
	/** `<agentsDir()>/<review-id>` */
	dir: string;
	now?: () => number;
	/** After a join is approved (the previous one already left as `replaced`). */
	onApproved: () => Promise<void>;
	onLeft: (why: JoinLeave) => void;
	/** Whether a question waits: a watcher that connects then is answered at once. */
	waiting?: () => Promise<boolean>;
}

type Presence = "listening" | "busy" | "reconnecting";

interface Pending {
	id: string;
	who: JoinIdentity;
	at: number;
	expiry: ReturnType<typeof setTimeout>;
	waiters: Set<() => void>;
}

interface Joined {
	who: JoinIdentity;
	since: number;
	hash: Buffer;
	/** The session has its token (approved and collected, or restored). */
	collected: boolean;
}

interface Lease {
	deliver: () => void;
	end: (how: "replaced" | "left" | "closed") => void;
	delivered: boolean;
}

/** Identity strings as shown: sanitised, at most this many characters. */
const MAX_IDENTITY = 80;
/** Answered requests remembered for a late `attach({request})`. */
const MAX_FINISHED = 20;
const JOINED_FILE = "joined.json";
const ACP_OFF_FILE = "acp-off";
const nextUlid = monotonicFactory();

const hashOf = (token: string): Buffer =>
	createHash("sha256").update(token).digest();
const clean = (s: string): string =>
	sanitizeThirdParty(s).trim().slice(0, MAX_IDENTITY);

/** `who` sanitised and capped, as every view shows it. */
export function cleanIdentity(who: JoinIdentity): JoinIdentity {
	const harness = who.harness === undefined ? "" : clean(who.harness);
	return {
		name: clean(who.name),
		machine: clean(who.machine),
		...(harness ? { harness } : {}),
	};
}

export class JoinBroker {
	readonly #deps: JoinBrokerDeps;
	readonly #now: () => number;
	#pending: Pending | null = null;
	/** Answered, replaced or expired requests → what `outcome` says. */
	readonly #finished = new Map<string, AttachOutcome>();
	#joined: Joined | null = null;
	#lease: Lease | null = null;
	/** The last lease delivered a question and closed: busy, not reconnecting. */
	#woken = false;
	#handed: { thread: string; asked: string | undefined } | null = null;
	/** No watcher: leaves as `lost` when it fires. */
	#absence: ReturnType<typeof setTimeout> | null = null;
	#left: (JoinIdentity & { why: JoinLeave; at: number }) | null = null;
	#acpOff: boolean;
	#closed = false;

	constructor(deps: JoinBrokerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#acpOff = existsSync(join(deps.dir, ACP_OFF_FILE));
	}

	/** A `joined.json` left by the last server: joined again, reconnecting, the grace window running. */
	async restore(): Promise<void> {
		if (this.#joined || this.#closed) return;
		const path = join(this.#deps.dir, JOINED_FILE);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			if (existsSync(path)) rmSync(path, { force: true });
			return;
		}
		const r = raw as {
			tokenHash?: unknown;
			who?: Partial<JoinIdentity>;
			since?: unknown;
		};
		const ok =
			typeof r.tokenHash === "string" &&
			/^[0-9a-f]{64}$/.test(r.tokenHash) &&
			typeof r.who?.name === "string" &&
			typeof r.who.machine === "string" &&
			(r.who.harness === undefined || typeof r.who.harness === "string") &&
			typeof r.since === "string" &&
			!Number.isNaN(Date.parse(r.since));
		if (!ok || !r.who) {
			rmSync(path, { force: true });
			return;
		}
		this.#joined = {
			who: cleanIdentity(r.who as JoinIdentity),
			since: Date.parse(r.since as string),
			hash: Buffer.from(r.tokenHash as string, "hex"),
			collected: true,
		};
		this.#arm();
	}

	/** A session asks to join; replaces any pending request. */
	request(who: JoinIdentity): { request: string } {
		if (this.#pending) this.#finish(this.#pending, { state: "expired" });
		const id = nextUlid().toLowerCase();
		const pending: Pending = {
			id,
			who: cleanIdentity(who),
			at: this.#now(),
			waiters: new Set(),
			expiry: setTimeout(() => {
				if (this.#pending === pending) {
					this.#finish(pending, { state: "expired" });
				}
			}, JOIN.expiryMs),
		};
		this.#pending = pending;
		return { request: id };
	}

	/**
	 * What became of `request`, waiting up to `waitMs` for an answer. The
	 * token is handed out once: a later call says `expired`.
	 */
	outcome(request: string, waitMs: number): Promise<AttachOutcome> {
		const pending = this.#pending;
		if (pending?.id === request && waitMs > 0) {
			return new Promise((resolve) => {
				const done = () => {
					clearTimeout(timer);
					pending.waiters.delete(done);
					resolve(this.#collect(request));
				};
				const timer = setTimeout(done, waitMs);
				pending.waiters.add(done);
			});
		}
		return Promise.resolve(this.#collect(request));
	}

	/** The reviewer's Approve or Deny; only the pending request's first answer counts. */
	async answer(request: string, approve: boolean): Promise<void> {
		const pending = this.#pending;
		if (!pending || pending.id !== request || this.#closed) {
			throw new StaleJoinRequestError(request);
		}
		// Taken before any await: a second answer, from any tab, is stale.
		this.#pending = null;
		clearTimeout(pending.expiry);
		if (!approve) {
			this.#finish(pending, { state: "denied" });
			return;
		}
		this.leave("replaced");
		const token = randomBytes(32).toString("base64url");
		const joined: Joined = {
			who: pending.who,
			since: this.#now(),
			hash: hashOf(token),
			collected: false,
		};
		this.#joined = joined;
		this.#woken = false;
		mkdirSync(this.#deps.dir, { recursive: true });
		writeFileSync(
			join(this.#deps.dir, JOINED_FILE),
			JSON.stringify({
				tokenHash: joined.hash.toString("hex"),
				who: joined.who,
				since: new Date(joined.since).toISOString(),
			}),
		);
		this.#arm();
		try {
			await this.#deps.onApproved();
		} finally {
			this.#finish(pending, { state: "approved", token });
		}
	}

	/** Whether `token` is the joined session's (constant time). */
	check(token: string): boolean {
		const j = this.#joined;
		if (!j || typeof token !== "string" || !token) return false;
		return timingSafeEqual(hashOf(token), j.hash);
	}

	/** `thread` was handed to the session by `next` (presence busy). */
	handOut(thread: string, asked: string | undefined): void {
		if (!this.#joined) return;
		this.#handed = { thread, asked };
		this.#arm();
	}

	handedOut(): { thread: string; asked: string | undefined } | null {
		return this.#handed ? { ...this.#handed } : null;
	}

	/** The session replied to `thread`: its hand-out ends. */
	replied(thread: string): void {
		if (this.#handed?.thread !== thread) return;
		this.#handed = null;
		this.#woken = false;
		this.#arm();
	}

	/** Opens the watcher lease for `token`; null for a bad token. A newer lease replaces an open one. */
	watcher(token: string): WatchLease | null {
		if (this.#closed || !this.check(token)) return null;
		const joined = this.#joined as Joined;
		joined.collected = true;
		this.#lease?.end("replaced");
		let deliver!: () => void;
		let end!: (how: "replaced" | "left" | "closed") => void;
		const delivered = new Promise<void>((r) => {
			deliver = r;
		});
		const ended = new Promise<"replaced" | "left" | "closed">((r) => {
			end = r;
		});
		const lease: Lease = {
			delivered: false,
			deliver: () => {
				if (lease.delivered || this.#lease !== lease) return;
				lease.delivered = true;
				deliver();
			},
			end: (how) => {
				if (this.#lease === lease) this.#lease = null;
				end(how);
			},
		};
		this.#lease = lease;
		this.#woken = false;
		this.#arm();
		void this.#deps
			.waiting?.()
			.then((w) => {
				if (w) lease.deliver();
			})
			.catch(() => {});
		return {
			deliver: delivered,
			ended,
			close: () => {
				if (this.#lease !== lease) return;
				this.#lease = null;
				if (lease.delivered) this.#woken = true;
				this.#arm();
			},
		};
	}

	/** A human asked: the open watcher, if any, wakes the session. */
	wake(): void {
		this.#lease?.deliver();
	}

	/** Ends the attachment: token revoked, watcher ended, hand-out cleared, joined.json gone, `left` recorded. */
	leave(why: JoinLeave): void {
		const j = this.#joined;
		if (!j) return;
		this.#joined = null;
		this.#handed = null;
		this.#woken = false;
		this.#disarm();
		this.#lease?.end("left");
		rmSync(join(this.#deps.dir, JOINED_FILE), { force: true });
		this.#left = { ...j.who, why, at: this.#now() };
		this.#deps.onLeft(why);
	}

	view(): Pick<AgentStatus, "via" | "joined" | "joinRequest" | "left"> & {
		presence?: Presence;
	} {
		const j = this.#joined;
		const p = this.#pending;
		const l = this.#left;
		const iso = (ms: number) => new Date(ms).toISOString();
		return {
			...(j
				? {
						via: "mcp" as const,
						joined: { ...j.who, since: iso(j.since) },
						presence: this.#presence(),
					}
				: {}),
			...(p ? { joinRequest: { ...p.who, id: p.id, at: iso(p.at) } } : {}),
			...(l ? { left: { ...l, at: iso(l.at) } } : {}),
		};
	}

	acpOff(): boolean {
		return this.#acpOff;
	}

	async setAcpOff(off: boolean): Promise<void> {
		const path = join(this.#deps.dir, ACP_OFF_FILE);
		if (off) {
			mkdirSync(this.#deps.dir, { recursive: true });
			writeFileSync(path, "");
		} else {
			rmSync(path, { force: true });
		}
		this.#acpOff = off;
	}

	/**
	 * The review's session closes (eviction, shutdown): timers stop and
	 * an open watcher is dropped, but joined.json stays for the next one.
	 */
	close(): void {
		this.#closed = true;
		this.#disarm();
		this.#lease?.end("closed");
		const p = this.#pending;
		if (p) this.#finish(p, { state: "expired" });
	}

	#presence(): Presence {
		if (this.#handed) return "busy";
		if (this.#lease) return "listening";
		return this.#woken ? "busy" : "reconnecting";
	}

	/** (Re)starts or stops the absence timer for the current presence. */
	#arm(): void {
		this.#disarm();
		const j = this.#joined;
		if (!j || this.#closed || this.#lease) return;
		const ms = !j.collected
			? JOIN.expiryMs
			: this.#handed || this.#woken
				? JOIN.busyMs
				: JOIN.graceMs;
		this.#absence = setTimeout(() => {
			this.#absence = null;
			if (this.#joined === j) this.leave("lost");
		}, ms);
	}

	#disarm(): void {
		if (this.#absence) clearTimeout(this.#absence);
		this.#absence = null;
	}

	#finish(pending: Pending, outcome: AttachOutcome): void {
		clearTimeout(pending.expiry);
		if (this.#pending === pending) this.#pending = null;
		this.#finished.set(pending.id, outcome);
		while (this.#finished.size > MAX_FINISHED) {
			const oldest = this.#finished.keys().next().value as string;
			this.#finished.delete(oldest);
		}
		for (const w of [...pending.waiters]) w();
	}

	/** The outcome now; an approved one's token goes out once. */
	#collect(request: string): AttachOutcome {
		if (this.#pending?.id === request) return { state: "pending", request };
		const o = this.#finished.get(request);
		if (!o) return { state: "expired" };
		if (o.state === "approved") {
			this.#finished.set(request, { state: "expired" });
			const j = this.#joined;
			if (j && timingSafeEqual(hashOf(o.token), j.hash)) {
				j.collected = true;
				this.#arm();
			} else {
				return { state: "expired" };
			}
		}
		return o;
	}
}
