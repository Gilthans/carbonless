import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { stateDir } from "./paths.js";
import type { BuildInfo } from "./version.js";

/** The running server, as `crb serve` records it in `server.json`. */
export interface ServerState {
	/** Where it listens: `http://<host>:<port>`, no key. */
	url: string;
	host: string;
	port: number;
	pid: number;
	startedAt: string;
	version: BuildInfo;
}

const PRIVATE = 0o600;
const stateFile = () => join(stateDir(), "server.json");
const keyFile = () => join(stateDir(), "key");

export function writeServerState(s: ServerState): Promise<void> {
	return writeFileAtomic(
		stateFile(),
		`${JSON.stringify(s, null, "\t")}\n`,
		PRIVATE,
	);
}

/** Whether a process with this pid exists (EPERM: someone else's, but alive). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readState(): Promise<ServerState | null> {
	let text: string;
	try {
		text = await readFile(stateFile(), "utf8");
	} catch {
		return null;
	}
	try {
		const s = JSON.parse(text) as Partial<ServerState>;
		const valid =
			typeof s.url === "string" &&
			typeof s.host === "string" &&
			Number.isInteger(s.port) &&
			Number.isInteger(s.pid) &&
			(s.pid as number) > 0 &&
			typeof s.startedAt === "string" &&
			typeof s.version?.version === "string" &&
			typeof s.version?.commit === "string";
		return valid ? (s as ServerState) : null;
	} catch {
		return null;
	}
}

/**
 * The server `server.json` names, or null when there's no file, it's
 * unreadable, or its pid is gone. A live pid may still not be crb (a
 * reused pid): the client asks the server itself before trusting it.
 */
export async function readLiveServerState(): Promise<ServerState | null> {
	const s = await readState();
	return s && pidAlive(s.pid) ? s : null;
}

/** Removes `server.json` if it names this process (a clean shutdown). */
export async function removeServerState(): Promise<void> {
	const s = await readState();
	if (s?.pid === process.pid) await rm(stateFile(), { force: true });
}

const newKey = () => randomBytes(24).toString("base64url");

/**
 * The access key for binds beyond loopback, kept in `key` (0600) across
 * restarts so a phone's bookmark keeps working; made on first use.
 */
export async function accessKey(): Promise<string> {
	try {
		const key = (await readFile(keyFile(), "utf8")).trim();
		if (key) return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Written aside, then linked into place: of two first uses, one wins and
	// both read its key.
	await mkdir(stateDir(), { recursive: true });
	const tmp = `${keyFile()}.${process.pid}.${randomBytes(4).toString("hex")}`;
	await writeFile(tmp, `${newKey()}\n`, { mode: PRIVATE, flag: "wx" });
	try {
		await link(tmp, keyFile());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await rm(tmp, { force: true });
	}
	return (await readFile(keyFile(), "utf8")).trim();
}

/** Replaces the key (crb serve --new-key): old links stop working. */
export async function rotateAccessKey(): Promise<string> {
	const key = newKey();
	await writeFileAtomic(keyFile(), `${key}\n`, PRIVATE);
	return key;
}
