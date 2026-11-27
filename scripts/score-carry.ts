/**
 * Scores the thread tracer against a corpus of expected placements:
 *
 *   pnpm score-carry <corpus.json> [--repo <dir>] [--out <dir>] [--compare <previous.json>]
 *
 * Each entry is a thread made on one snapshot and the placement a reviewer
 * expects for it in a later one (format: docs/thread-carry-corpus.md). The
 * current tracer places each one the server's way (ThreadPlacer over
 * buildSnapshot's target snapshot, no stored placements) in the corpus's
 * repo, and each gets a verdict:
 *
 * - right: placed (or changed) on an expected or also-acceptable line, or a
 *   file comment on its file;
 * - wrong-line: placed somewhere else (or a file comment off its file);
 * - unplaced-ok: expected `gone`, and unplaced or outside;
 * - unplaced-wrong: expected on a line, but unplaced or outside.
 *
 * Prints right/total (right + unplaced-ok), each verdict's count and the
 * same per tag; `--compare` adds every entry whose verdict differs from a
 * previous run's `--out` file. `--out <dir>` writes `score-carry.json`
 * there (the input of a later `--compare`). Exit 0 when it ran, 2 when it
 * couldn't.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildSnapshot } from "../src/server/diff/snapshot.js";
import { killDetachedGits } from "../src/server/git.js";
import {
	ThreadPlacer,
	type TraceableThread,
} from "../src/server/rereview/threads.js";
import type { ThreadCodeSource } from "../src/server/threadCode.js";
import type { ThreadPlacement } from "../src/shared/rereview/placement.js";
import { TRACER_VERSION } from "../src/shared/tracer/index.js";
import type { DiffSide, Snapshot } from "../src/shared/types.js";

/** A snapshot: its head and base, any revision git resolves in the repo. */
export interface CorpusSnapshot {
	commit: string;
	/** Default: the merge base of `commit` and the corpus's `base`. */
	base?: string;
}

export interface CorpusLines {
	path: string;
	lines: number[];
}

export interface CorpusEntry {
	/** Unique per entry (one thread may have one entry per target). */
	id: string;
	madeAt: CorpusSnapshot & {
		path: string;
		/** Omitted, with the lines, for a file comment. */
		side?: DiffSide;
		startSide?: DiffSide;
		startLine?: number;
		line?: number;
	};
	target: CorpusSnapshot;
	/** The lines it belongs on (new side), "gone", or "file" (a file comment). */
	expected: CorpusLines | "gone" | "file";
	/** Other lines that count as right (also for "gone"). */
	alsoAcceptable?: CorpusLines[];
	/** Labels to break the score down by (e.g. a failure pattern). */
	tags?: string[];
}

export interface Corpus {
	version: 1;
	/** The repository, relative to the corpus file; `--repo` overrides it. */
	repo?: string;
	/** The base branch's revision, for snapshots without their own base. */
	base?: string;
	entries: CorpusEntry[];
}

export type Verdict = "right" | "wrong-line" | "unplaced-ok" | "unplaced-wrong";

export const VERDICTS: readonly Verdict[] = [
	"right",
	"wrong-line",
	"unplaced-ok",
	"unplaced-wrong",
];

export interface Scored {
	id: string;
	tags: string[];
	verdict: Verdict;
	placement: ThreadPlacement;
}

export interface ScoreRun {
	tracerVersion: number;
	entries: Scored[];
}

/**
 * Whether a placed range is right: on the new side of the entry's path,
 * every line of it expected or also acceptable, and at least one expected
 * (also acceptable, for "gone"). A range spread past them is wrong, even
 * when it touches one.
 */
function rightRange(
	e: CorpusEntry,
	anchor: { path: string; side: DiffSide; startLine: number; line: number },
): boolean {
	const on = (sets: readonly CorpusLines[]) => {
		const lines = new Set<number>();
		for (const w of sets) {
			if (w.path === anchor.path) for (const n of w.lines) lines.add(n);
		}
		return lines;
	};
	const also = e.alsoAcceptable ?? [];
	const must = on(typeof e.expected === "object" ? [e.expected] : also);
	const may = on([
		...(typeof e.expected === "object" ? [e.expected] : []),
		...also,
	]);
	if (anchor.side !== "RIGHT") return false;
	let touched = false;
	for (let n = anchor.startLine; n <= anchor.line; n++) {
		if (!may.has(n)) return false;
		if (must.has(n)) touched = true;
	}
	return touched;
}

export function verdictOf(e: CorpusEntry, p: ThreadPlacement): Verdict {
	if (e.expected === "file") {
		return p.kind === "file" && p.path === e.madeAt.path
			? "right"
			: "wrong-line";
	}
	if (p.kind === "placed" || p.kind === "changed") {
		const a = p.anchor;
		const anchor = {
			path: a.path,
			side: a.side,
			// A range across sides counts from its end line.
			startLine: a.startSide === a.side ? a.startLine : a.line,
			line: a.line,
		};
		return rightRange(e, anchor) ? "right" : "wrong-line";
	}
	if (p.kind === "file") return "wrong-line";
	return e.expected === "gone" ? "unplaced-ok" : "unplaced-wrong";
}

const isLine = (n: unknown) => Number.isInteger(n) && (n as number) >= 1;
const isText = (v: unknown) => typeof v === "string" && v !== "";
const isSide = (v: unknown) => v === undefined || v === "LEFT" || v === "RIGHT";

function linesProblem(v: unknown): string | null {
	const w = v as Partial<CorpusLines> | null;
	if (!w || typeof w !== "object") return "not an object";
	if (!isText(w.path)) return "no path";
	if (
		!Array.isArray(w.lines) ||
		w.lines.length === 0 ||
		!w.lines.every(isLine)
	) {
		return "lines must be line numbers";
	}
	return null;
}

/** What is wrong with a parsed corpus file, one message per problem. */
export function corpusProblems(value: unknown): string[] {
	const c = value as Partial<Corpus> | null;
	if (!c || typeof c !== "object") return ["not a JSON object"];
	if (c.version !== 1)
		return [`version must be 1, not ${JSON.stringify(c.version)}`];
	if (!Array.isArray(c.entries)) return ["entries must be an array"];
	const out: string[] = [];
	if (c.repo !== undefined && !isText(c.repo)) out.push("repo must be a path");
	if (c.base !== undefined && !isText(c.base))
		out.push("base must be a revision");
	const ids = new Set<string>();
	c.entries.forEach((raw, i) => {
		const e = raw as Partial<CorpusEntry> | null;
		const at = `entries[${i}]${e && isText(e.id) ? ` (${e.id})` : ""}`;
		const bad = (what: string) => out.push(`${at}: ${what}`);
		if (!e || typeof e !== "object") {
			bad("not an object");
			return;
		}
		if (!isText(e.id)) bad("no id");
		else if (ids.has(e.id as string)) bad("duplicate id");
		else ids.add(e.id as string);
		const m = e.madeAt;
		if (!m || !isText(m.commit) || !isText(m.path)) {
			bad("madeAt needs a commit and a path");
		} else {
			if (!isSide(m.side) || !isSide(m.startSide))
				bad("madeAt's sides are LEFT or RIGHT");
			if (m.line !== undefined && !isLine(m.line))
				bad("madeAt.line must be a line number");
			if (
				m.startLine !== undefined &&
				(m.line === undefined || !isLine(m.startLine))
			) {
				bad("madeAt.startLine needs a line, both line numbers");
			}
			if (m.base !== undefined && !isText(m.base))
				bad("madeAt.base must be a revision");
		}
		if (!e.target || !isText(e.target.commit)) bad("target needs a commit");
		else if (e.target.base !== undefined && !isText(e.target.base)) {
			bad("target.base must be a revision");
		}
		if (e.expected !== "gone" && e.expected !== "file") {
			const p = linesProblem(e.expected);
			if (p) bad(`expected: "gone", "file" or lines (${p})`);
		}
		if (e.alsoAcceptable !== undefined) {
			if (!Array.isArray(e.alsoAcceptable))
				bad("alsoAcceptable must be an array");
			else {
				for (const w of e.alsoAcceptable) {
					const p = linesProblem(w);
					if (p) bad(`alsoAcceptable: ${p}`);
				}
			}
		}
		if (
			e.tags !== undefined &&
			!(Array.isArray(e.tags) && e.tags.every(isText))
		) {
			bad("tags must be strings");
		}
	});
	return out;
}

/** A placement in a few words, for the comparison's lines. */
export function describePlacement(p: ThreadPlacement): string {
	switch (p.kind) {
		case "placed":
		case "changed": {
			const a = p.anchor;
			const lines =
				a.startSide === a.side && a.startLine !== a.line
					? `${a.startLine}-${a.line}`
					: `${a.line}`;
			return `${p.kind} ${a.path}:${a.side === "LEFT" ? "L" : ""}${lines}`;
		}
		case "unplaced":
			return `unplaced ${p.fate}${p.nearest ? ` near ${p.nearest.line}` : ""}`;
		case "outside":
			return `outside ${p.fate}`;
		case "file":
			return `file ${p.path}`;
		case "pending":
			return `pending ${p.path}`;
	}
}

function revParse(repo: string, rev: string): string {
	return execFileSync(
		"git",
		["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
		{
			cwd: repo,
			encoding: "utf8",
		},
	).trim();
}

function mergeBase(repo: string, a: string, b: string): string {
	return execFileSync("git", ["merge-base", "--end-of-options", a, b], {
		cwd: repo,
		encoding: "utf8",
	}).trim();
}

/** Places every entry with the current tracer and judges it. */
export async function scoreCorpus(
	corpus: Corpus,
	repo: string,
): Promise<ScoreRun> {
	const base = corpus.base;
	const resolveSnapshot = (s: CorpusSnapshot) => {
		const head = revParse(repo, s.commit);
		if (s.base !== undefined) return { head, base: revParse(repo, s.base) };
		if (base === undefined) {
			throw new Error(
				`no base for ${s.commit}: give the snapshot's or the corpus's`,
			);
		}
		return { head, base: mergeBase(repo, head, revParse(repo, base)) };
	};
	const ids = new Set<string>();
	// A thread's own snapshot by its head, for the placer's endpoints.
	const own = new Map<string, { base: string; head: string }>();
	const resolved = corpus.entries.map((e) => {
		if (ids.has(e.id)) throw new Error(`duplicate entry id ${e.id}`);
		ids.add(e.id);
		const made = resolveSnapshot(e.madeAt);
		const known = own.get(made.head);
		if (known && known.base !== made.base) {
			throw new Error(`${e.madeAt.commit} has two bases in the corpus`);
		}
		own.set(made.head, made);
		return { e, made, target: resolveSnapshot(e.target) };
	});
	const code = {
		endpoints: async (anchor: { commit: string }) =>
			own.get(anchor.commit) ?? null,
	} as unknown as ThreadCodeSource;
	const placer = new ThreadPlacer(repo, code);
	const snapshots = new Map<string, Promise<Snapshot>>();
	const snapshotOf = (t: { base: string; head: string }) => {
		const key = `${t.base} ${t.head}`;
		let s = snapshots.get(key);
		if (!s) {
			s = buildSnapshot(repo, t.base, t.head);
			snapshots.set(key, s);
		}
		return s;
	};
	const entries: Scored[] = [];
	for (const { e, made, target } of resolved) {
		const snapshot = await snapshotOf(target);
		const m = e.madeAt;
		const at = new Date(0).toISOString();
		const lines =
			m.line === undefined
				? null
				: {
						side: m.side ?? "RIGHT",
						line: m.line,
						startSide: m.startSide ?? m.side ?? "RIGHT",
						startLine: m.startLine ?? m.line,
					};
		const thread: TraceableThread = {
			id: e.id,
			path: m.path,
			commit: made.head,
			createdAt: at,
			anchor: lines && { path: m.path, commit: made.head, at, ...lines },
		};
		const base = { snapshot: snapshot.base, ref: snapshot.base };
		const inputs = await placer.inputs(snapshot, [thread], base, at);
		// No moves: the corpus scores the tracer alone.
		const [placed] = await placer.placeMoved(
			snapshot,
			inputs,
			() => undefined,
			base,
		);
		if (!placed) throw new Error(`entry ${e.id} got no placement`);
		entries.push({
			id: e.id,
			tags: e.tags ?? [],
			verdict: verdictOf(e, placed.placement),
			placement: placed.placement,
		});
	}
	return { tracerVersion: TRACER_VERSION, entries };
}

const count = (entries: readonly Scored[]) => {
	const by = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<
		Verdict,
		number
	>;
	for (const e of entries) by[e.verdict]++;
	return by;
};

const line = (label: string, entries: readonly Scored[]) => {
	const by = count(entries);
	const ok = by.right + by["unplaced-ok"];
	return `${label}${ok}/${entries.length} right  (${VERDICTS.map((v) => `${v} ${by[v]}`).join(", ")})`;
};

/** The printed report: overall, per tag, and what changed since `previous`. */
export function report(run: ScoreRun, previous?: ScoreRun): string {
	const out = [line(`tracer ${run.tracerVersion}: `, run.entries)];
	const tags = [...new Set(run.entries.flatMap((e) => e.tags))].sort();
	for (const tag of tags) {
		out.push(
			line(
				`  ${tag}: `,
				run.entries.filter((e) => e.tags.includes(tag)),
			),
		);
	}
	if (previous) {
		const before = new Map(previous.entries.map((e) => [e.id, e]));
		const changed = run.entries.filter((e) => {
			const b = before.get(e.id);
			return !b || b.verdict !== e.verdict;
		});
		out.push(
			`compared with tracer ${previous.tracerVersion}: ${changed.length} verdict(s) changed`,
		);
		for (const e of changed) {
			const b = before.get(e.id);
			out.push(
				`  ${e.id}: ${b ? `${b.verdict} (${describePlacement(b.placement)})` : "new"} -> ${e.verdict} (${describePlacement(e.placement)})`,
			);
		}
	}
	return out.join("\n");
}

const USAGE =
	"Usage: pnpm score-carry <corpus.json> [--repo <dir>] [--out <dir>] [--compare <previous score-carry.json>]";

/** The CLI: 0 when it ran, 2 when it couldn't. */
export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			repo: { type: "string" },
			out: { type: "string" },
			compare: { type: "string" },
		},
	});
	const [file, ...extra] = positionals;
	if (!file || extra.length) {
		console.error(USAGE);
		return 2;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		console.error(
			`${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
	const problems = corpusProblems(parsed);
	if (problems.length) {
		for (const p of problems) console.error(`${file}: ${p}`);
		return 2;
	}
	const corpus = parsed as Corpus;
	const repoDir = values.repo ?? corpus.repo;
	if (!repoDir) {
		console.error("no repository: give --repo or the corpus's repo");
		return 2;
	}
	const repo = resolve(
		values.repo ? process.cwd() : dirname(resolve(file)),
		repoDir,
	);
	const previous = values.compare
		? (JSON.parse(readFileSync(values.compare, "utf8")) as ScoreRun)
		: undefined;
	let run: ScoreRun;
	try {
		run = await scoreCorpus(corpus, repo);
	} finally {
		killDetachedGits();
	}
	if (values.out) {
		mkdirSync(values.out, { recursive: true });
		writeFileSync(
			join(values.out, "score-carry.json"),
			`${JSON.stringify(run, null, "\t")}\n`,
		);
	}
	console.log(report(run, previous));
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(
				`score-carry: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		},
	);
}
