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
import type { Holder, ReviewClaim } from "./claim.js";
import { oneLine } from "./prompt.js";

/**
 * A session carbonless didn't launch, joined to one review through MCP:
 * its join requests (the reviewer approves each), its token, its presence
 * (the watcher's open connection is the keep-alive) and the review's "ACP
 * off" flag. Server memory plus two files in the review's agent dir:
 * `joined.json` (token hash, identity, since) and `acp-off`. Never git.
 * Spec: the CAR-81 ticket's spec document.
 */

/**
 * Test only: `CRB_JOIN_GRACE_GATE` names a file. While it's set, a dropped
 * watcher's grace window doesn't run on the clock: it ends when that file
 * exists, so an end-to-end test sees the session leave as `lost` on its own
 * cue (a gate, not a shortened timer). Unset or blank: the real window.
 */
export function joinGraceGate(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env.CRB_JOIN_GRACE_GATE?.trim() || undefined;
}

/** How often a gated grace window looks for its file. */
const GATE_POLL_MS = 50;

export type AttachOutcome =
	| { state: "pending"; request: string }
	| { state: "denied" | "expired" }
	| { state: "approved"; token: string };

/** An Approve on a server that doesn't hold the review's agent claim (HTTP 409, code elsewhere). */
export class JoinElsewhereError extends Error {
	constructor(readonly holder: Holder) {
		super(
			`Another carbonless server (port ${holder.port}) holds this review's agent`,
		);
	}
}

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
	/**
	 * The review's agent claim, shared with the ACP runner: only its holder
	 * restores, serves or deletes `joined.json`. None: this broker acts as
	 * the holder (tests).
	 */
	claim?: ReviewClaim;
	/** Test only: see joinGraceGate. Default: CRB_JOIN_GRACE_GATE. */
	graceGate?: string;
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
const clean = (s: string): string => oneLine(s, MAX_IDENTITY);

/**
 * `who` as every view shows it: one line each, sanitised, at most 80 code
 * points; an empty name falls back to the machine, then "session".
 */
export function cleanIdentity(who: JoinIdentity): JoinIdentity {
	const harness = who.harness === undefined ? "" : clean(who.harness);
	const machine = clean(who.machine);
	return {
		name: clean(who.name) || machine || "session",
		machine,
		...(harness ? { harness } : {}),
	};
}

export class JoinBroker {
	readonly #deps: JoinBrokerDeps;
	readonly #now: () => number;
	#pending: Pending | null = null;
	/** Approved, its join still being installed: `outcome` waits for it. */
	#approving: Pending | null = null;
	/** Answered, replaced or expired requests → what `outcome` says. */
	readonly #finished = new Map<string, AttachOutcome>();
	#joined: Joined | null = null;
	#lease: Lease | null = null;
	/** The last lease delivered a question and closed: busy, not reconnecting. */
	#woken = false;
	#handed: { thread: string; asked: string | undefined } | null = null;
	/** No watcher: leaves as `lost` when it fires. */
	#absence: ReturnType<typeof setTimeout> | null = null;
	readonly #gate: string | undefined;
	#left: (JoinIdentity & { why: JoinLeave; at: number }) | null = null;
	#closed = false;

	constructor(deps: JoinBrokerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#gate = deps.graceGate ?? joinGraceGate();
	}

	/**
	 * A `joined.json` left by the last server: joined again, reconnecting,
	 * the grace window running. Only on the server that takes the claim.
	 */
	async restore(): Promise<void> {
		if (this.#joined || this.#closed) return;
		const path = join(this.#deps.dir, JOINED_FILE);
		if (!existsSync(path)) return;
		if (!(await this.#hold())) return;
		const fail = () => {
			rmSync(path, { force: true });
			void this.#drop();
		};
		if (this.#joined || this.#closed) {
			if (!this.#joined) void this.#drop();
			return;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			fail();
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
			fail();
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
		const pending =
			this.#pending?.id === request
				? this.#pending
				: this.#approving?.id === request
					? this.#approving
					: null;
		if (pending && waitMs > 0) {
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
		this.#approving = pending;
		let installed: Joined | null = null;
		let token: string;
		try {
			const claim = await this.#take();
			if (!claim.ok) throw new JoinElsewhereError(claim.holder);
			if (this.#closed) throw new StaleJoinRequestError(request);
			this.#end("replaced", { keepClaim: true });
			// ACP off first: a crash between the two files never leaves a
			// restored join beside a running ACP buddy.
			await this.setAcpOff(true);
			token = randomBytes(32).toString("base64url");
			const joined: Joined = {
				who: pending.who,
				since: this.#now(),
				hash: hashOf(token),
				collected: false,
			};
			installed = joined;
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
		} catch (error) {
			// Nothing half-installed: the request ends, no join, the claim
			// goes back (ACP may stay off: Start brings it back).
			this.#finish(pending, { state: "expired" });
			if (installed && this.#joined === installed) {
				this.#joined = null;
				this.#disarm();
				rmSync(join(this.#deps.dir, JOINED_FILE), { force: true });
			}
			if (!this.#joined) void this.#drop();
			throw error;
		}
		this.#arm();
		try {
			await this.#deps.onApproved();
		} catch (error) {
			// The join took effect: the reviewer's Approve isn't an error.
			console.warn(`crb: after a join: ${(error as Error).message}`);
		}
		this.#finish(pending, { state: "approved", token });
	}

	/**
	 * Whether this server may take a join for the review (holds or can take
	 * the claim); `attach` answers `elsewhere` with the holder otherwise.
	 */
	async claimCheck(): Promise<{ ok: true } | { ok: false; holder: Holder }> {
		const taken = await this.#take();
		if (!taken.ok) return taken;
		if (!this.#joined && !this.#approving) await this.#drop();
		return { ok: true };
	}

	/** Joined, asked to join or watched: the review is in use (no idle eviction). */
	active(): boolean {
		return (
			this.#joined !== null ||
			this.#pending !== null ||
			this.#approving !== null ||
			this.#lease !== null
		);
	}

	isJoined(): boolean {
		return this.#joined !== null;
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
		this.#end(why, { keepClaim: false });
	}

	#end(why: JoinLeave, opts: { keepClaim: boolean }): void {
		const j = this.#joined;
		if (!j) return;
		this.#joined = null;
		this.#handed = null;
		this.#woken = false;
		this.#disarm();
		this.#lease?.end("left");
		rmSync(join(this.#deps.dir, JOINED_FILE), { force: true });
		this.#left = { ...j.who, why, at: this.#now() };
		if (!opts.keepClaim) void this.#drop();
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

	/** Read from the file each time: another server may have set or cleared it. */
	acpOff(): boolean {
		return existsSync(join(this.#deps.dir, ACP_OFF_FILE));
	}

	async setAcpOff(off: boolean): Promise<void> {
		const path = join(this.#deps.dir, ACP_OFF_FILE);
		if (off) {
			mkdirSync(this.#deps.dir, { recursive: true });
			writeFileSync(path, "");
		} else {
			rmSync(path, { force: true });
		}
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
		// joined.json stays; the next holder restores it.
		void this.#drop();
	}

	async #take(): Promise<{ ok: true } | { ok: false; holder: Holder }> {
		const claim = this.#deps.claim;
		if (!claim) return { ok: true };
		const r = await claim.hold("join");
		return r.ok ? { ok: true } : { ok: false, holder: r.holder };
	}

	async #hold(): Promise<boolean> {
		return (await this.#take()).ok;
	}

	async #drop(): Promise<void> {
		await this.#deps.claim?.drop("join").catch(() => {});
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
		const lost = () => {
			this.#absence = null;
			if (this.#joined === j) this.leave("lost");
		};
		const grace = j.collected && !this.#handed && !this.#woken;
		const gate = grace ? this.#gate : undefined;
		if (gate) {
			// Test only: the window ends on the test's cue, not the clock.
			const poll = setInterval(() => {
				if (!existsSync(gate)) return;
				clearInterval(poll);
				lost();
			}, GATE_POLL_MS);
			this.#absence = poll;
			return;
		}
		const ms = !j.collected
			? JOIN.expiryMs
			: grace
				? JOIN.graceMs
				: JOIN.busyMs;
		this.#absence = setTimeout(lost, ms);
	}

	#disarm(): void {
		// clearTimeout ends a gate's setInterval too (Node shares the ids).
		if (this.#absence) clearTimeout(this.#absence);
		this.#absence = null;
	}

	#finish(pending: Pending, outcome: AttachOutcome): void {
		clearTimeout(pending.expiry);
		if (this.#pending === pending) this.#pending = null;
		if (this.#approving === pending) this.#approving = null;
		this.#finished.set(pending.id, outcome);
		while (this.#finished.size > MAX_FINISHED) {
			const oldest = this.#finished.keys().next().value as string;
			this.#finished.delete(oldest);
		}
		for (const w of [...pending.waiters]) w();
	}

	/** The outcome now; an approved one's token goes out once. */
	#collect(request: string): AttachOutcome {
		if (this.#pending?.id === request || this.#approving?.id === request) {
			return { state: "pending", request };
		}
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
