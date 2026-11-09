import type { Span } from "./load";

/*
 * What `pnpm test-profile` prints: a run's spans summed into wall and test
 * time, setup phases, top files and tests, gh and git calls, and crb's hot
 * spots; and two runs side by side (`--compare`).
 */

/** The phases of an e2e test, in print order (spans.ts tags them). */
export const PHASES = [
	"setup.fixture",
	"setup.crb_serve",
	"setup.crb_open",
	"setup.browser",
	"setup.first_load",
	"setup.other",
	"body",
	"teardown.crb_stop",
	"teardown.other",
] as const;

export interface Calls {
	n: number;
	ms: number;
	/** Per test, the median count and time (tests without any count as 0). */
	medianN: number;
	medianMs: number;
}

export interface TestRow {
	key: string;
	title: string;
	file: string;
	project: string;
	ms: number;
	status: string;
}

export interface HotSpot {
	name: string;
	n: number;
	ms: number;
	p50: number;
	max: number;
}

export interface Summary {
	wallMs: number;
	tests: number;
	testMs: number;
	/** Exclusive time per phase, summed over tests. Unit runs: "body" and "file" only. */
	phases: Record<string, number>;
	files: { file: string; ms: number; tests: number }[];
	slowest: TestRow[];
	calls: Record<string, Calls>;
	hot: HotSpot[];
}

const dur = (s: Span) => Math.max(0, s.endMs - s.startMs);

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Which call bucket a span counts in, if any. */
function callKind(s: Span): string | null {
	if (s.service === "fake-gh") return "fake gh (process)";
	if (s.name.startsWith("gh ")) return "gh";
	if (s.name.startsWith("git ")) {
		return s.attrs["crb.fixture"] ? "git (fixture)" : "git (crb)";
	}
	return null;
}

const HARNESS = new Set(["e2e", "fake-gh"]);

export function summarize(spans: Span[], top = 8): Summary {
	// Keyed by trace too: ids need only be unique within a trace.
	const key = (s: Span) => `${s.traceId}:${s.spanId}`;
	const byId = new Map(spans.map((s) => [key(s), s]));
	const children = new Map<string, Span[]>();
	for (const s of spans) {
		if (!s.parent) continue;
		const p = `${s.traceId}:${s.parent}`;
		const list = children.get(p);
		if (list) list.push(s);
		else children.set(p, [s]);
	}
	const tests = spans.filter((s) => s.attrs["crb.kind"] === "test");
	const fileSpans = spans.filter((s) => s.attrs["crb.kind"] === "file");

	// The test each span runs under (memoized walk up the parents).
	const testOf = new Map<string, Span | null>();
	const owner = (s: Span): Span | null => {
		const known = testOf.get(key(s));
		if (known !== undefined) return known;
		const path: Span[] = [];
		let cur: Span | undefined = s;
		let found: Span | null = null;
		while (cur) {
			const k = testOf.get(key(cur));
			if (k !== undefined) {
				found = k;
				break;
			}
			path.push(cur);
			if (cur.attrs["crb.kind"] === "test") {
				found = cur;
				break;
			}
			cur = cur.parent ? byId.get(`${cur.traceId}:${cur.parent}`) : undefined;
		}
		for (const p of path) testOf.set(key(p), found);
		return found;
	};

	// Phases: each tagged span's time minus its nearest tagged descendants'.
	const phases: Record<string, number> = {};
	const add = (k: string, ms: number) => {
		phases[k] = (phases[k] ?? 0) + ms;
	};
	for (const t of tests) {
		let tagged = 0;
		const walk = (s: Span): number => {
			let inner = 0;
			for (const c of children.get(key(s)) ?? []) {
				if (c.service !== "e2e") continue;
				const phase = c.attrs["crb.phase"];
				if (typeof phase === "string") {
					const d = dur(c);
					const own = d - walk(c);
					add(phase, Math.max(0, own));
					inner += d;
				} else {
					inner += walk(c);
				}
			}
			return inner;
		};
		tagged = walk(t);
		add("body", Math.max(0, dur(t) - tagged));
	}
	if (fileSpans.length > 0) {
		const inTests = new Map<string, number>();
		for (const t of tests) {
			if (t.parent)
				inTests.set(
					`${t.traceId}:${t.parent}`,
					(inTests.get(`${t.traceId}:${t.parent}`) ?? 0) + dur(t),
				);
		}
		for (const f of fileSpans) {
			add("file", Math.max(0, dur(f) - (inTests.get(key(f)) ?? 0)));
		}
	}

	const files = new Map<string, { ms: number; tests: number }>();
	for (const f of fileSpans) {
		const name = String(f.attrs["test.file"]);
		files.set(name, { ms: dur(f), tests: 0 });
	}
	for (const t of tests) {
		const name = String(t.attrs["test.file"] ?? "?");
		const row = files.get(name) ?? { ms: 0, tests: 0 };
		if (fileSpans.length === 0) row.ms += dur(t);
		row.tests++;
		files.set(name, row);
	}

	const rows: TestRow[] = tests.map((t) => {
		const file = String(t.attrs["test.file"] ?? "?");
		const project = String(t.attrs["test.project"] ?? "");
		const title = String(t.attrs["test.title"] ?? t.name);
		return {
			key: `${project}|${file}|${title}`,
			title,
			file,
			project,
			ms: dur(t),
			status: String(t.attrs["test.status"] ?? "?"),
		};
	});

	const perTest = new Map<string, Map<string, { n: number; ms: number }>>();
	const totals = new Map<string, { n: number; ms: number }>();
	const hot = new Map<string, number[]>();
	for (const s of spans) {
		const kind = callKind(s);
		if (kind) {
			const tot = totals.get(kind) ?? { n: 0, ms: 0 };
			tot.n++;
			tot.ms += dur(s);
			totals.set(kind, tot);
			const t = owner(s);
			if (t) {
				const m = perTest.get(kind) ?? new Map();
				const row = m.get(key(t)) ?? { n: 0, ms: 0 };
				row.n++;
				row.ms += dur(s);
				m.set(key(t), row);
				perTest.set(kind, m);
			}
		}
		// crb's own spans: crb serve's (e2e), or crb code inside a unit test.
		const crbSide =
			!HARNESS.has(s.service) &&
			!s.attrs["crb.kind"] &&
			!s.attrs["crb.fixture"] &&
			s.service !== "playwright-worker" &&
			s.parent !== null &&
			!s.name.startsWith("crb serve") &&
			s.name !== "crb <pr>";
		if (crbSide) {
			const list = hot.get(s.name);
			if (list) list.push(dur(s));
			else hot.set(s.name, [dur(s)]);
		}
	}
	const calls: Record<string, Calls> = {};
	for (const [kind, tot] of totals) {
		const m = perTest.get(kind) ?? new Map();
		const ns = tests.map((t) => m.get(key(t))?.n ?? 0);
		const ms = tests.map((t) => m.get(key(t))?.ms ?? 0);
		calls[kind] = { ...tot, medianN: median(ns), medianMs: median(ms) };
	}

	const starts = spans.map((s) => s.startMs);
	const ends = spans.map((s) => s.endMs);
	return {
		wallMs: spans.length
			? ends.reduce((a, b) => Math.max(a, b)) -
				starts.reduce((a, b) => Math.min(a, b))
			: 0,
		tests: tests.length,
		testMs: tests.reduce((a, t) => a + dur(t), 0),
		phases,
		files: [...files]
			.map(([file, r]) => ({ file, ...r }))
			.sort((a, b) => b.ms - a.ms)
			.slice(0, top),
		slowest: rows.sort((a, b) => b.ms - a.ms),
		calls,
		hot: [...hot]
			.map(([name, d]) => ({
				name,
				n: d.length,
				ms: d.reduce((a, b) => a + b, 0),
				p50: median(d),
				max: Math.max(...d),
			}))
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 12),
	};
}

/** 420ms, 4.2s, 3m12s, 1h03m. */
export function fmt(ms: number): string {
	const a = Math.abs(ms);
	const sign = ms < 0 ? "-" : "";
	if (a < 1000) return `${sign}${Math.round(a)}ms`;
	if (a < 60_000) return `${sign}${(a / 1000).toFixed(1)}s`;
	const s = Math.round(a / 1000);
	if (s < 3600)
		return `${sign}${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${sign}${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const pct = (part: number, whole: number) =>
	whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-";

const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);

function trim(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The text `pnpm test-profile <run>` prints. */
export function formatSummary(run: string, s: Summary, top = 8): string {
	const out: string[] = [];
	out.push(
		`▶ ${run}`,
		`  wall ${fmt(s.wallMs)} · ${s.tests} tests · test time ${fmt(s.testMs)}`,
	);
	const phaseKeys = [
		...PHASES.filter((p) => p in s.phases),
		...Object.keys(s.phases).filter(
			(p) => !(PHASES as readonly string[]).includes(p),
		),
	];
	if (phaseKeys.length) {
		const whole = Object.values(s.phases).reduce((a, b) => a + b, 0);
		out.push(
			"",
			"⏱ phases",
			`  ${pad("", 18)} ${lpad("total", 9)} ${lpad("share", 7)} ${lpad("/test", 7)}`,
		);
		for (const p of phaseKeys) {
			const ms = s.phases[p] ?? 0;
			out.push(
				`  ${pad(p, 18)} ${lpad(fmt(ms), 9)} ${lpad(pct(ms, whole), 7)} ${lpad(fmt(s.tests ? ms / s.tests : 0), 7)}`,
			);
		}
	}
	out.push("", "📄 top files");
	for (const f of s.files.slice(0, top)) {
		out.push(`  ${lpad(fmt(f.ms), 7)} ${lpad(String(f.tests), 4)}t  ${f.file}`);
	}
	out.push("", "🐢 top tests");
	for (const t of s.slowest.slice(0, top)) {
		const fail =
			t.status === "passed" || t.status === "pass" ? "" : ` ✗${t.status}`;
		out.push(
			`  ${lpad(fmt(t.ms), 7)}  ${trim(`${t.project ? `[${t.project}] ` : ""}${t.file.replace(/^.*\//, "")} › ${t.title}`, 100)}${fail}`,
		);
	}
	const kinds = Object.keys(s.calls).sort();
	if (kinds.length) {
		out.push(
			"",
			"⚙ calls",
			`  ${pad("", 18)} ${lpad("n", 6)} ${lpad("total", 8)} ${lpad("mean", 7)} ${lpad("n/test", 7)} ${lpad("ms/test", 8)}`,
		);
		for (const k of kinds) {
			const c = s.calls[k] as Calls;
			out.push(
				`  ${pad(k, 18)} ${lpad(String(c.n), 6)} ${lpad(fmt(c.ms), 8)} ${lpad(fmt(c.n ? c.ms / c.n : 0), 7)} ${lpad(String(c.medianN), 7)} ${lpad(fmt(c.medianMs), 8)}`,
			);
		}
		out.push("  (n/test, ms/test: medians over tests)");
	}
	if (s.hot.length) {
		out.push(
			"",
			"🔥 crb hot spots",
			`  ${pad("", 36)} ${lpad("n", 6)} ${lpad("total", 8)} ${lpad("p50", 7)} ${lpad("max", 7)}`,
		);
		for (const h of s.hot) {
			out.push(
				`  ${pad(trim(h.name, 36), 36)} ${lpad(String(h.n), 6)} ${lpad(fmt(h.ms), 8)} ${lpad(fmt(h.p50), 7)} ${lpad(fmt(h.max), 7)}`,
			);
		}
	}
	return out.join("\n");
}

function delta(a: number, b: number, time = true): string {
	const d = b - a;
	const show = time ? fmt : (n: number) => String(Math.round(n));
	const rel =
		a > 0 ? ` (${d >= 0 ? "+" : ""}${((100 * d) / a).toFixed(0)}%)` : "";
	return `${show(a)} → ${show(b)}  ${d >= 0 ? "+" : ""}${show(d)}${rel}`;
}

/** The text of `--compare`: run `a` (before) against `b`. */
export function formatCompare(
	aName: string,
	a: Summary,
	bName: string,
	b: Summary,
	top = 5,
): string {
	const out = [`▶ ${aName} → ${bName}`];
	out.push(`  wall       ${delta(a.wallMs, b.wallMs)}`);
	out.push(`  tests      ${delta(a.tests, b.tests, false)}`);
	out.push(`  test time  ${delta(a.testMs, b.testMs)}`);
	const phases = [
		...new Set([...Object.keys(a.phases), ...Object.keys(b.phases)]),
	];
	if (phases.length) {
		out.push("", "⏱ phases");
		for (const p of PHASES.filter((x) => phases.includes(x)).concat(
			phases.filter(
				(x) => !(PHASES as readonly string[]).includes(x),
			) as never[],
		)) {
			out.push(`  ${pad(p, 18)} ${delta(a.phases[p] ?? 0, b.phases[p] ?? 0)}`);
		}
	}
	const kinds = [
		...new Set([...Object.keys(a.calls), ...Object.keys(b.calls)]),
	].sort();
	if (kinds.length) {
		out.push("", "⚙ calls (n; total)");
		for (const k of kinds) {
			const x = a.calls[k];
			const y = b.calls[k];
			out.push(
				`  ${pad(k, 18)} ${delta(x?.n ?? 0, y?.n ?? 0, false)}; ${delta(x?.ms ?? 0, y?.ms ?? 0)}`,
			);
		}
	}
	const before = new Map(a.slowest.map((t) => [t.key, t]));
	const moved = b.slowest
		.filter((t) => before.has(t.key))
		.map((t) => ({ t, d: t.ms - (before.get(t.key) as TestRow).ms }))
		.sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
		.slice(0, top);
	if (moved.length) {
		out.push("", "↕ tests that moved most");
		for (const { t, d } of moved) {
			out.push(
				`  ${lpad(`${d >= 0 ? "+" : ""}${fmt(d)}`, 8)}  ${trim(`${t.file.replace(/^.*\//, "")} › ${t.title}`, 90)}`,
			);
		}
	}
	return out.join("\n");
}
