import { randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
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
 * removed and taken once more; a live holder's is not: `{ ok: false, holder }`.
 */
export async function takeClaim(
	dir: string,
	self: Holder,
): Promise<ClaimResult> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "claim.json");
	const token = randomUUID();
	const mine: ClaimFile = { pid: self.pid, port: self.port, token };
	for (let attempt = 0; ; attempt++) {
		try {
			await writeFile(path, JSON.stringify(mine), { flag: "wx" });
			return {
				ok: true,
				release: async () => {
					const now = await readClaim(dir);
					if (now?.token === token) await unlink(path).catch(() => {});
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stale = await readText(path);
		if (stale === null) continue;
		const held = parseClaim(stale);
		if (held && pidAlive(held.pid)) {
			return { ok: false, holder: { pid: held.pid, port: held.port } };
		}
		if (attempt >= 3) {
			return {
				ok: false,
				holder: held ? { pid: held.pid, port: held.port } : { pid: 0, port: 0 },
			};
		}
		// Take the stale file away atomically: one taker's rename wins. A
		// file that turns out not to be the stale one read (someone's fresh
		// claim, moved in the meantime) goes back, and stands.
		const aside = `${path}.${token}.stale`;
		try {
			await rename(path, aside);
		} catch {
			continue;
		}
		const moved = await readText(aside);
		if (moved !== stale) {
			await link(aside, path).catch(() => {});
			await unlink(aside).catch(() => {});
			const theirs = moved === null ? null : parseClaim(moved);
			return {
				ok: false,
				holder: theirs
					? { pid: theirs.pid, port: theirs.port }
					: { pid: 0, port: 0 },
			};
		}
		await unlink(aside).catch(() => {});
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}
