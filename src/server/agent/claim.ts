import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Who holds a review's agent on this machine: a server's pid and port. */
export interface Holder {
	pid: number;
	port: number;
}

export type ClaimResult =
	| { ok: true; release(): Promise<void> }
	| { ok: false; holder: Holder };

/** Whether a process with this pid is alive (EPERM: alive, someone else's). */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface ClaimFile extends Holder {
	/** Which take wrote it: release() removes only its own. */
	token: string;
}

/** A claim file's text as a claim, or null when it isn't one. */
function parseClaim(text: string): ClaimFile | null {
	try {
		const c = JSON.parse(text);
		if (!c || !Number.isInteger(c.pid) || !Number.isInteger(c.port))
			return null;
		return {
			pid: c.pid,
			port: c.port,
			token: typeof c.token === "string" ? c.token : "",
		};
	} catch {
		return null;
	}
}

/** The claim in `dir`, or null when the file isn't a claim. */
export async function readClaim(dir: string): Promise<ClaimFile | null> {
	const text = await readText(join(dir, "claim.json"));
	return text === null ? null : parseClaim(text);
}

/**
 * One agent per review per machine: `<dir>/claim.json`, created O_EXCL with
 * `self` in it. A claim whose pid is dead, or a file that isn't a claim, is
 * replaced, by one taker at a time (claim.lock); a live holder's is not:
 * `{ ok: false, holder }`.
 */
export async function takeClaim(
	dir: string,
	self: Holder,
): Promise<ClaimResult> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "claim.json");
	const lock = join(dir, "claim.lock");
	const token = randomUUID();
	const mine: ClaimFile = { pid: self.pid, port: self.port, token };
	const write = async (): Promise<boolean> => {
		try {
			await writeFile(path, JSON.stringify(mine), { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return false;
		}
	};
	const taken: ClaimResult = {
		ok: true,
		release: async () => {
			const now = await readClaim(dir);
			if (now?.token === token) await unlink(path).catch(() => {});
		},
	};
	const heldBy = (c: ClaimFile | null): ClaimResult => ({
		ok: false,
		holder: c ? { pid: c.pid, port: c.port } : { pid: 0, port: 0 },
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await write()) return taken;
		const stale = await readText(path);
		if (stale === null) continue;
		const held = parseClaim(stale);
		if (held && pidAlive(held.pid)) return heldBy(held);
		// A dead holder's claim is replaced under claim.lock, by one taker at
		// a time: only it removes claim.json, and only the stale text it read.
		try {
			await writeFile(lock, JSON.stringify({ pid: self.pid }), { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const other = parseClaimPid(await readText(lock));
			if (other !== null && pidAlive(other)) {
				// Another taker is replacing it: theirs, once written.
				return heldBy(await readClaim(dir));
			}
			// A lock left by a taker that died mid-way.
			await unlink(lock).catch(() => {});
			continue;
		}
		try {
			if ((await readText(path)) === stale) await unlink(path).catch(() => {});
			if (await write()) return taken;
		} finally {
			await unlink(lock).catch(() => {});
		}
	}
	return heldBy(await readClaim(dir));
}

function parseClaimPid(text: string | null): number | null {
	if (text === null) return null;
	try {
		const { pid } = JSON.parse(text);
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** Who in one server holds a review's claim: its ACP runner, its joined session. */
export type ClaimUser = "acp" | "join";

/**
 * A review's claim as one server shares it between its ACP runner and its
 * joined session (the spec: "the existing claim also covers a joined
 * session"): taken on the first hold, released when the last user drops.
 */
export class ReviewClaim {
	readonly #users = new Set<ClaimUser>();
	#release: (() => Promise<void>) | null = null;
	/** One take at a time (two users holding at once take once). */
	#taking: Promise<ClaimResult> | null = null;
	/** A release under way: a hold waits for it (else it sees its own claim as another's). */
	#releasing: Promise<void> | null = null;

	constructor(
		private readonly dir: string,
		private readonly self: () => Holder,
	) {}

	/** Whether this server holds the claim (for any user). */
	held(): boolean {
		return this.#release !== null;
	}

	/** Holds the claim for `user`; `{ ok: false, holder }` when another server has it. */
	async hold(user: ClaimUser): Promise<ClaimResult> {
		while (this.#releasing && !this.#release) await this.#releasing;
		if (!this.#release) {
			this.#taking ??= takeClaim(this.dir, this.self()).finally(() => {
				this.#taking = null;
			});
			const taken = await this.#taking;
			if (!taken.ok) return taken;
			this.#release ??= taken.release;
		}
		this.#users.add(user);
		return { ok: true, release: () => this.drop(user) };
	}

	/** `user` lets go; the claim is released once nobody holds it. */
	async drop(user: ClaimUser): Promise<void> {
		this.#users.delete(user);
		if (this.#users.size > 0 || !this.#release) return;
		const release = this.#release;
		this.#release = null;
		const releasing: Promise<void> = release()
			.catch(() => {})
			.finally(() => {
				if (this.#releasing === releasing) this.#releasing = null;
			});
		this.#releasing = releasing;
		await releasing;
	}
}
