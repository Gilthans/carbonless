import { randomBytes } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** A span as the summary reads it back. */
export interface Span {
	traceId: string;
	spanId: string;
	parent: string | null;
	name: string;
	service: string;
	startMs: number;
	endMs: number;
	attrs: Record<string, string | number | boolean>;
	error: boolean;
}

interface OtlpValue {
	stringValue?: string;
	intValue?: number | string;
	doubleValue?: number;
	boolValue?: boolean;
}
interface OtlpAttr {
	key: string;
	value: OtlpValue;
}
interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes?: OtlpAttr[];
	status?: { code?: number };
}
export interface OtlpRequest {
	resourceSpans: {
		resource?: { attributes?: OtlpAttr[] };
		scopeSpans: { spans: OtlpSpan[] }[];
	}[];
}

const value = (v: OtlpValue) =>
	v.stringValue ??
	v.boolValue ??
	v.doubleValue ??
	(v.intValue === undefined ? "" : Number(v.intValue));

const attrsOf = (list: OtlpAttr[] | undefined) =>
	Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));

/** Nanosecond string to epoch milliseconds (fractions kept). */
export const nanosToMs = (n: string) =>
	Number(n.slice(0, -6) || "0") + Number(n.slice(-6)) / 1e6;

/**
 * A trace file's lines (gzip or not); a torn last line is skipped, and a
 * file a packer took meanwhile (compactRun) reads as empty.
 */
export function fileLines(path: string): string[] {
	let raw: Buffer;
	try {
		raw = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (path.endsWith(".gz")) raw = gunzipSync(raw);
	return raw.toString("utf8").split("\n").filter(Boolean);
}

/** The trace files of a run directory. */
export function traceFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"))
		.map((f) => join(dir, f));
}

/**
 * Every request (line) of a run, parsed; unreadable lines skipped. With
 * `traceId`, only the lines that mention it.
 */
export function readRequests(dir: string, traceId?: string): OtlpRequest[] {
	const out: OtlpRequest[] = [];
	for (const file of traceFiles(dir)) {
		for (const line of fileLines(file)) {
			if (traceId && !line.includes(traceId)) continue;
			try {
				out.push(JSON.parse(line) as OtlpRequest);
			} catch {
				// A process killed mid-write: the rest still counts.
			}
		}
	}
	return out;
}

/** The spans of OTLP requests. */
export function spansOf(requests: OtlpRequest[]): Span[] {
	const spans: Span[] = [];
	for (const req of requests) {
		for (const rs of req.resourceSpans ?? []) {
			const res = attrsOf(rs.resource?.attributes);
			const service = String(res["service.name"] ?? "?");
			for (const ss of rs.scopeSpans ?? []) {
				for (const s of ss.spans ?? []) {
					spans.push({
						traceId: s.traceId,
						spanId: s.spanId,
						parent: s.parentSpanId || null,
						name: s.name,
						service,
						startMs: nanosToMs(s.startTimeUnixNano),
						endMs: nanosToMs(s.endTimeUnixNano),
						attrs: attrsOf(s.attributes),
						error: s.status?.code === 2,
					});
				}
			}
		}
	}
	return spans;
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Packs the plain files of processes that have exited (`<name>-<pid>-<id>.jsonl`)
 * into one gzipped file: a run leaves thousands of one-span fake-gh files.
 * Files of live processes are left alone. Each file is claimed by renaming
 * it to `<file>.packing-<packer pid>-<id>` first, so two packers (a run's end
 * and `pnpm test-profile`) never pack the same one; on failure the claimed
 * files go back. A claim whose packer died is taken over the same way (the
 * rename decides between two takers). The run directory keeps its mtime,
 * so viewing a run doesn't extend its retention. Returns how many files it
 * packed.
 */
export function compactRun(
	dir: string,
	isAlive: (pid: number) => boolean = alive,
	/** Tests: runs after the claimed files are read, before the pack is written. */
	beforeWrite: () => void = () => {},
): number {
	const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
	const claimed: [original: string, claim: string][] = [];
	const tmp = join(dir, `packed-${id}.jsonl.gz.tmp`);
	let mtime: Date | null = null;
	const claim = (current: string, original: string) => {
		const to = `${original}.packing-${id}`;
		try {
			renameSync(join(dir, current), join(dir, to));
			claimed.push([join(dir, original), join(dir, to)]);
		} catch {
			// Another packer claimed it first.
		}
	};
	try {
		mtime = statSync(dir).mtime;
		for (const f of readdirSync(dir)) {
			const plain = /-(\d+)-[0-9a-f]+\.jsonl$/.exec(f);
			if (plain) {
				if (!isAlive(Number(plain[1]))) claim(f, f);
				continue;
			}
			// A dead packer's claim, or its half-written pack.
			const orphan = /^(.+\.jsonl)\.packing-(\d+)-[0-9a-f]+$/.exec(f);
			if (orphan && !isAlive(Number(orphan[2]))) {
				claim(f, orphan[1] as string);
				continue;
			}
			const tmpOf = /^packed-(\d+)-[0-9a-f]+\.jsonl\.gz\.tmp$/.exec(f);
			if (tmpOf && !isAlive(Number(tmpOf[1]))) {
				rmSync(join(dir, f), { force: true });
			}
		}
		if (claimed.length === 0) return 0;
		// Per file: a killed process's torn last line stays its own line.
		const text = claimed
			.flatMap(([, to]) => readFileSync(to, "utf8").split("\n"))
			.filter(Boolean)
			.map((l) => `${l}\n`)
			.join("");
		beforeWrite();
		writeFileSync(tmp, gzipSync(text));
		renameSync(tmp, join(dir, `packed-${id}.jsonl.gz`));
		for (const [, to] of claimed) rmSync(to, { force: true });
		return claimed.length;
	} catch {
		rmSync(tmp, { force: true });
		for (const [from, to] of claimed) {
			try {
				renameSync(to, from);
			} catch {
				// Gone already.
			}
		}
		return 0;
	} finally {
		if (mtime) {
			try {
				utimesSync(dir, mtime, mtime);
			} catch {
				// Pruned meanwhile.
			}
		}
	}
}

/** Whether the run's runner (the pid that ends its directory name) still runs. */
export function runnerAlive(
	dir: string,
	isAlive: (pid: number) => boolean = alive,
): boolean {
	const m = /-(\d+)$/.exec(dir.replace(/\/+$/, ""));
	return m ? isAlive(Number(m[1])) : false;
}

/**
 * A run's spans for viewing. Packs it first only once its runner has
 * exited: a live run is packed by its own end (Playwright onEnd, Vitest
 * teardown), never under it by a reader.
 */
export function viewRun(
	dir: string,
	isAlive: (pid: number) => boolean = alive,
): Span[] {
	if (!runnerAlive(dir, isAlive)) compactRun(dir, isAlive);
	return spansOf(readRequests(dir));
}
