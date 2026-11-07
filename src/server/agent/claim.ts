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

/** The claim in `dir`, or null when the file isn't a claim. */
export async function readClaim(dir: string): Promise<ClaimFile | null> {
	try {
		const c = JSON.parse(await readFile(join(dir, "claim.json"), "utf8"));
		if (
			c &&
			Number.isInteger(c.pid) &&
			Number.isInteger(c.port) &&
			typeof c.token === "string"
		)
			return c as ClaimFile;
		if (c && Number.isInteger(c.pid) && Number.isInteger(c.port))
			return { pid: c.pid, port: c.port, token: "" };
		return null;
	} catch {
		return null;
	}
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
		const held = await readClaim(dir);
		if (held && pidAlive(held.pid)) {
			return { ok: false, holder: { pid: held.pid, port: held.port } };
		}
		if (attempt >= 1) {
			// Someone else freed and took it between our tries: theirs stands.
			return {
				ok: false,
				holder: held ? { pid: held.pid, port: held.port } : { pid: 0, port: 0 },
			};
		}
		await unlink(path).catch(() => {});
	}
}
