import {
	appendFileSync,
	fstatSync,
	mkdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../paths.js";

/*
 * crb serve's own log for the telemetry mailbox (docs/telemetry-mailbox.md).
 * serve.log holds crb serve's output only when crb started it (`crb <pr>`,
 * the updater); started by hand, by systemd or a Windows service, its
 * output goes elsewhere (a terminal, the journal) and the mailbox would
 * send no log. So while the mailbox is on, crb serve also appends what it
 * writes to stderr to serve-own.log in the state dir, rolled to .1 past
 * 1 MB like serve.log. Not when its stderr already is serve.log: those
 * lines (and a crash's, which only serve.log catches) are there once.
 */

export const ownLogFile = (): string => join(stateDir(), "serve-own.log");
const serveLogFile = () => join(stateDir(), "serve.log");

/** serve-own.log moves to serve-own.log.1 past this, as serve.log does. */
const LIMIT = 1024 * 1024;

/** Whether file descriptor `fd` is the file at `path` (same device and inode). */
export function fdIsFile(fd: number, path: string): boolean {
	try {
		const a = fstatSync(fd);
		const b = statSync(path);
		return a.isFile() && a.dev === b.dev && a.ino === b.ino;
	} catch {
		return false;
	}
}

/**
 * Tees this process's stderr into serve-own.log while `enabled()` (the
 * mailbox is on). Returns the undo. A write that fails is dropped: the log
 * never stops serving.
 */
export function startOwnLog(opts: {
	enabled: () => boolean;
	file?: string;
	limit?: number;
	/** stderr is serve.log already (default: checked now). */
	stderrIsServeLog?: boolean;
}): () => void {
	const file = opts.file ?? ownLogFile();
	const limit = opts.limit ?? LIMIT;
	if (opts.stderrIsServeLog ?? fdIsFile(2, serveLogFile())) return () => {};
	let size: number | null = null;
	const append = (chunk: unknown) => {
		if (!opts.enabled()) return;
		const text =
			typeof chunk === "string"
				? chunk
				: chunk instanceof Uint8Array
					? Buffer.from(chunk).toString("utf8")
					: "";
		if (!text) return;
		try {
			if (size === null) {
				mkdirSync(dirname(file), { recursive: true });
				size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
			}
			if (size > 0 && size + Buffer.byteLength(text) > limit) {
				renameSync(file, `${file}.1`);
				size = 0;
			}
			appendFileSync(file, text);
			size += Buffer.byteLength(text);
		} catch {
			size = null;
		}
	};
	const stderr = process.stderr;
	const original = stderr.write;
	let active = true;
	const wrapper = function (
		this: typeof stderr,
		chunk: unknown,
		...rest: unknown[]
	) {
		if (active) append(chunk);
		return (original as (...a: unknown[]) => boolean).call(
			this,
			chunk,
			...rest,
		);
	} as typeof stderr.write;
	stderr.write = wrapper;
	return () => {
		active = false;
		// Unwrapped only if nothing wrapped it since; else it passes through.
		if (stderr.write === wrapper) stderr.write = original;
	};
}
