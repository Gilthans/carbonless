import { readdirSync, statSync } from "node:fs";
import { isServiceFile } from "../../src/server/trace";
import {
	fileLines,
	nanosToMs,
	type OtlpRequest,
	type Span,
	spansOf,
	traceFiles,
} from "./load";
import { fmt } from "./summary";

/*
 * A crb serve's trace directory ($CRB_TRACE_DIR, docs/test-profiling.md
 * "crb outside tests"), as `pnpm test-profile <dir>` reads it: the
 * slowest routes, gh and git calls by kind and by command, over a window
 * (`--since`). Unlike a test run it is never packed: crb serve's own
 * retention prunes its files by name.
 */

/** Whether `dir` is a server's trace directory rather than a test run. */
export function isServerDir(dir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	return (
		!names.includes("run.json") && names.some((f) => isServiceFile("crb", f))
	);
}

const UNITS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

/**
 * `--since`: a span of time back from `now` (`30m`, `6h`, `1d`, `2w`) or
 * a date/time (`2026-11-20`, ISO), as epoch milliseconds.
 */
export function parseSince(arg: string, now = Date.now()): number {
	const m = /^(\d+(?:\.\d+)?)([mhdw])$/.exec(arg.trim());
	if (m) return now - Number(m[1]) * (UNITS[m[2] as string] as number);
	const at = Date.parse(arg);
	if (Number.isNaN(at)) {
		throw new Error(`--since takes 30m, 6h, 1d, 2w or a date: ${arg}`);
	}
	return at;
}

/**
 * The directory's requests with only the spans that end at or after
 * `sinceMs`; files last written before it aren't read at all.
 */
export function readServerRequests(
	dir: string,
	sinceMs = Number.NEGATIVE_INFINITY,
): OtlpRequest[] {
	const out: OtlpRequest[] = [];
	for (const file of traceFiles(dir)) {
		try {
			if (statSync(file).mtimeMs < sinceMs) continue;
		} catch {
			continue; // Pruned meanwhile.
		}
		for (const line of fileLines(file)) {
			let req: OtlpRequest;
			try {
				req = JSON.parse(line) as OtlpRequest;
			} catch {
				continue; // A torn last line.
			}
			for (const rs of req.resourceSpans ?? []) {
				for (const ss of rs.scopeSpans ?? []) {
					ss.spans = (ss.spans ?? []).filter(
						(s) => nanosToMs(s.endTimeUnixNano) >= sinceMs,
					);
				}
			}
			out.push(req);
		}
	}
	return out;
}

export function readServerSpans(dir: string, sinceMs?: number): Span[] {
	return spansOf(readServerRequests(dir, sinceMs));
}

export interface Stat {
	name: string;
	n: number;
	ms: number;
	p50: number;
	p95: number;
	max: number;
	/** Failed: a 5xx or aborted request, an error status on a call. */
	errors: number;
}

export interface ServerSummary {
	spans: number;
	fromMs: number | null;
	toMs: number | null;
	/** Requests by route, slowest p95 first. */
	routes: Stat[];
	/** gh and git, all commands together. */
	kinds: Stat[];
	/** gh and git by command (`git fetch`, `gh api graphql`), most time first. */
	commands: Stat[];
}

const dur = (s: Span) => Math.max(0, s.endMs - s.startMs);

/** The nearest-rank percentile `p` (0–100) of sorted `values`. */
function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const i = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.min(i, sorted.length - 1)] as number;
}

function stats(groups: Map<string, { d: number[]; errors: number }>): Stat[] {
	return [...groups].map(([name, g]) => {
		const sorted = [...g.d].sort((a, b) => a - b);
		return {
			name,
			n: sorted.length,
			ms: sorted.reduce((a, b) => a + b, 0),
			p50: pct(sorted, 50),
			p95: pct(sorted, 95),
			max: sorted.at(-1) ?? 0,
			errors: g.errors,
		};
	});
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

/** Whether a request span failed: 5xx, aborted, or an error status. */
function failed(s: Span): boolean {
	const status = s.attrs.status;
	return (
		s.error ||
		status === "aborted" ||
		(typeof status === "number" && status >= 500)
	);
}

export function summarizeServer(spans: Span[]): ServerSummary {
	const routes = new Map<string, { d: number[]; errors: number }>();
	const kinds = new Map<string, { d: number[]; errors: number }>();
	const commands = new Map<string, { d: number[]; errors: number }>();
	const add = (
		m: Map<string, { d: number[]; errors: number }>,
		k: string,
		s: Span,
	) => {
		const g = m.get(k) ?? { d: [], errors: 0 };
		g.d.push(dur(s));
		if (failed(s)) g.errors++;
		m.set(k, g);
	};
	for (const s of spans) {
		if (ROUTE.test(s.name)) add(routes, s.name, s);
		const kind = s.name.startsWith("gh ")
			? "gh"
			: s.name.startsWith("git ")
				? "git"
				: null;
		if (kind) {
			add(kinds, kind, s);
			add(commands, s.name, s);
		}
	}
	return {
		spans: spans.length,
		fromMs: spans.length ? Math.min(...spans.map((s) => s.startMs)) : null,
		toMs: spans.length ? Math.max(...spans.map((s) => s.endMs)) : null,
		routes: stats(routes).sort((a, b) => b.p95 - a.p95 || b.ms - a.ms),
		kinds: stats(kinds).sort((a, b) => (a.name < b.name ? -1 : 1)),
		commands: stats(commands).sort((a, b) => b.ms - a.ms),
	};
}

const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const trim = (s: string, n: number) =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s;

const HEAD = `${lpad("n", 6)} ${lpad("total", 8)} ${lpad("p50", 7)} ${lpad("p95", 7)} ${lpad("max", 7)} ${lpad("err", 4)}`;
const row = (w: number, s: Stat) =>
	`  ${pad(trim(s.name, w), w)} ${lpad(String(s.n), 6)} ${lpad(fmt(s.ms), 8)} ${lpad(fmt(s.p50), 7)} ${lpad(fmt(s.p95), 7)} ${lpad(fmt(s.max), 7)} ${lpad(s.errors ? String(s.errors) : "", 4)}`;

const when = (ms: number | null) =>
	ms === null ? "–" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** The text `pnpm test-profile <server trace dir>` prints. */
export function formatServer(
	label: string,
	s: ServerSummary,
	top = 15,
): string {
	const out = [
		`▶ ${label}`,
		`  ${s.spans} spans · ${when(s.fromMs)} → ${when(s.toMs)} UTC`,
	];
	if (s.routes.length) {
		out.push("", "🐢 slowest routes (by p95)", `  ${pad("", 44)} ${HEAD}`);
		for (const r of s.routes.slice(0, top)) out.push(row(44, r));
	}
	if (s.kinds.length) {
		out.push("", "⚙ calls", `  ${pad("", 44)} ${HEAD}`);
		for (const k of s.kinds) out.push(row(44, k));
		out.push(
			"",
			"⚙ calls by command (most time first)",
			`  ${pad("", 44)} ${HEAD}`,
		);
		for (const c of s.commands.slice(0, top)) out.push(row(44, c));
	}
	if (!s.routes.length && !s.kinds.length) out.push("", "no requests or calls");
	return out.join("\n");
}
