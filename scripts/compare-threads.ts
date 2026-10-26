/**
 * Checks carbonless's thread code panes against GitHub (read-only):
 *
 *   pnpm compare-threads <pr-url-or-owner/repo#n> [--as-of <iso>] [--out <dir>]
 *
 * Opens the PR the way `crb` does (Session, in-process, with its own cache
 * under <out>/xdg) and reads its threads as the UI is served them (stage
 * "full"). For every review thread it checks what the code pane marks (path,
 * side, line range, the marked rows' text) against GitHub's REST review
 * comment (side/start_side, original_line/original_start_line, diff_hunk).
 * Writes <out>/compare.md and <out>/compare.json; exits 1 on any mismatch,
 * 2 when the comparison couldn't run. <out> defaults to $TMPDIR/crb-compare.
 *
 * The commented range is compared on the comment's own side (docs/faq.md):
 * a comment made in a "changes since" view has another old side, so its
 * context and deleted rows may differ. Where carbonless's snapshot verdict
 * says `same`, every marked row and the rows before them must match
 * GitHub's hunk exactly.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atOrBefore, parseAsOf } from "../src/server/asOf.js";
import { clonePath } from "../src/server/clone.js";
import { visibleAt } from "../src/server/commentTime.js";
import { fetchThreadSummaries, runGh } from "../src/server/gh.js";
import { killDetachedGits } from "../src/server/git.js";
import { Session } from "../src/server/session.js";
import { type HunkLine, parseDiffHunk } from "../src/shared/diffHunk.js";
import type { CodeRow, DiffSide, ReviewThread } from "../src/shared/types.js";

/** The fields of GitHub's REST review comment this compares against. */
interface RestComment {
	node_id: string;
	path: string;
	subject_type?: string;
	line: number | null;
	original_line: number | null;
	start_line: number | null;
	original_start_line: number | null;
	side: DiffSide | null;
	start_side: DiffSide | null;
	original_commit_id: string | null;
	diff_hunk: string;
	in_reply_to_id?: number;
}

export interface ThreadResult {
	/** GitHub's thread id. */
	id: string;
	path: string;
	/** GitHub's range ("RIGHT 10-12", "LEFT→RIGHT 3-4", "file"). */
	github: string;
	/** The code pane's range and marked row count, or why there is none. */
	ours: string;
	source: "clone" | "github" | "pending" | "none";
	/** carbonless's verdict: "same", "different (<reason>)" or "" (no code). */
	snapshot: string;
	match: boolean;
	/** Why it doesn't match. */
	causes: string[];
	notes: string[];
}

export interface Comparison {
	pr: string;
	asOf: string | null;
	threads: ThreadResult[];
	counts: {
		total: number;
		matching: number;
		mismatches: number;
		fileComments: number;
		clone: number;
		github: number;
		snapshotSame: number;
		snapshotDifferent: number;
	};
}

const bare = (text: string) => text.replace(/\r$/, "");
const numOn = (row: HunkLine, side: DiffSide) =>
	side === "LEFT" ? row.oldNo : row.newNo;
const range = (
	startSide: DiffSide,
	start: number,
	side: DiffSide,
	end: number,
) =>
	`${startSide === side ? side : `${startSide}→${side}`} ${start === end ? end : `${start}-${end}`}`;
const sameRow = (a: HunkLine, b: HunkLine) =>
	a.kind === b.kind &&
	a.oldNo === b.oldNo &&
	a.newNo === b.newNo &&
	bare(a.text) === bare(b.text);

/** Every page of `gh api --paginate --slurp`, flattened. */
async function restComments(
	owner: string,
	repo: string,
	number: number,
): Promise<RestComment[]> {
	const out = await runGh([
		"api",
		`repos/${owner}/${repo}/pulls/${number}/comments`,
		"--paginate",
		"--slurp",
	]);
	return (JSON.parse(out) as RestComment[][]).flat();
}

/** The file at `commit` in `repo`, as lines; null when it has none. */
function fileAt(repo: string, commit: string, path: string): string[] | null {
	try {
		return execFileSync("git", ["-C", repo, "show", `${commit}:${path}`], {
			encoding: "utf8",
			maxBuffer: 1 << 28,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.map(bare);
	} catch {
		return null;
	}
}

/** One served thread against its REST opener (null: GitHub lists none). */
export function compareThread(
	thread: ReviewThread,
	rest: RestComment | null,
	fileAtCommit: (commit: string, path: string) => string[] | null,
): ThreadResult {
	const causes: string[] = [];
	const notes: string[] = [];
	const code = thread.code;
	const result = (github: string, ours: string): ThreadResult => ({
		id: thread.id,
		path: thread.path,
		github,
		ours,
		source: code?.source ?? "none",
		snapshot: !code?.snapshot
			? ""
			: code.snapshot.same
				? "same"
				: `different (${code.snapshot.reason})`,
		match: causes.length === 0,
		causes,
		notes,
	});
	if (!rest) {
		causes.push("no REST comment");
		return result("?", code ? "code" : "no code");
	}
	if (rest.path !== thread.path) causes.push("path");
	if (rest.subject_type === "file") {
		if (code) causes.push("code for a file comment");
		return result("file", code ? "code" : "no code");
	}
	const end = rest.original_line ?? rest.line;
	const side = rest.side ?? "RIGHT";
	const startSide = rest.start_side ?? side;
	if (end === null) {
		causes.push("GitHub gives no line");
		return result("no line", code ? "code" : "no code");
	}
	const start = rest.original_start_line ?? rest.start_line ?? end;
	const github = `${range(startSide, start, side, end)}${rest.diff_hunk ? "" : " (no hunk)"}`;
	if (!code) {
		causes.push(rest.diff_hunk ? "no code" : "no code (no hunk either)");
		return result(github, "no code");
	}
	if (code.source === "pending") {
		causes.push("still pending");
		return result(github, "pending");
	}
	const a = code.anchor;
	const marked = code.rows.filter((r) => r.marked);
	const ours = `${range(a.startSide, a.startLine, a.side, a.line)} (${marked.length} marked)`;
	if (a.path !== rest.path) causes.push("anchor path");
	if (rest.original_commit_id && a.commit !== rest.original_commit_id) {
		causes.push("commit");
	}
	if (a.side !== side) causes.push("side");
	if (a.startSide !== startSide) causes.push("start side");
	if (a.line !== end) causes.push("end line");
	if (a.startLine !== start) causes.push("start line");
	const first = marked[0];
	const last = marked.at(-1);
	if (!first || !last) causes.push("nothing marked");
	else {
		if (numOn(last, side) !== end) causes.push("last marked row");
		if (numOn(first, startSide) !== start) causes.push("first marked row");
	}

	// GitHub's hunk ends at the commented line: its range is the run from
	// the start line's row to the end line's.
	if (rest.diff_hunk) {
		const truth = parseDiffHunk(rest.diff_hunk);
		const tEnd = truth.findLastIndex((r) => numOn(r, side) === end);
		const tStart =
			tEnd < 0
				? -1
				: truth
						.slice(0, tEnd + 1)
						.findLastIndex((r) => numOn(r, startSide) === start);
		if (tStart < 0) notes.push("GitHub's hunk lacks its range");
		else {
			const want = truth.slice(tStart, tEnd + 1);
			const own = (rows: HunkLine[]) =>
				rows.filter((r) => numOn(r, side) !== null).map((r) => bare(r.text));
			if (JSON.stringify(own(want)) !== JSON.stringify(own(marked))) {
				causes.push("marked text vs GitHub");
			}
			const rowsAgree =
				want.length === marked.length &&
				want.every((r, k) => sameRow(r, marked[k] as CodeRow));
			const firstMarked = code.rows.findIndex((r) => r.marked);
			const before = code.rows.slice(0, Math.max(0, firstMarked));
			const tBefore = truth.slice(0, tStart);
			let beforeAgree = true;
			for (let k = 1; k <= Math.min(before.length, tBefore.length); k++) {
				const x = before[before.length - k] as CodeRow;
				const y = tBefore[tBefore.length - k] as HunkLine;
				if (!sameRow(x, y)) {
					if (code.snapshot?.same) causes.push(`row ${k} before vs GitHub`);
					beforeAgree = false;
					break;
				}
			}
			if (code.snapshot?.same) {
				if (!rowsAgree) causes.push("marked rows vs GitHub (snapshot same)");
			} else if (rowsAgree && beforeAgree) {
				notes.push("rows agree with GitHub's hunk all the same");
			}
		}
	} else notes.push("no GitHub hunk");

	// Independent truth: the new side's rows are the file at the commit.
	if (code.source === "clone" && a.commit) {
		const file = fileAtCommit(a.commit, a.path);
		if (!file) notes.push("commit lacks the file");
		else {
			const off = code.rows.find(
				(r) => r.newNo !== null && file[r.newNo - 1] !== bare(r.text),
			);
			if (off) causes.push(`new ${off.newNo} vs file`);
		}
	}
	return result(github, ours);
}

/** Opens `pr` as crb does and compares every thread it serves with GitHub. */
export async function compareThreads(
	pr: string,
	options: { asOf?: string; cwd?: string; progress?: (m: string) => void } = {},
): Promise<Comparison> {
	const asOf = options.asOf;
	const session = await Session.open(
		pr,
		options.cwd ?? process.cwd(),
		options.progress,
		{ asOf },
	);
	try {
		const info = session.info().pr;
		const ref = { owner: info.owner, repo: info.repo, number: info.number };
		const [overview, rest, summaries] = await Promise.all([
			session.overview(),
			restComments(ref.owner, ref.repo, ref.number),
			fetchThreadSummaries(ref),
		]);
		const served = await session.threads(overview.readId, "full");
		const repo = clonePath(ref.owner, ref.repo);
		const byNode = new Map(
			rest.filter((c) => c.in_reply_to_id == null).map((c) => [c.node_id, c]),
		);
		// What GitHub says the read should hold: threads opened (published) by the cutoff.
		const expected = new Map<string, string>();
		for (const raw of summaries as {
			id: string;
			first?: { nodes?: { id?: string }[] };
		}[]) {
			const opener = raw.first?.nodes?.[0];
			const at = visibleAt(opener);
			if (at === null || (asOf && !atOrBefore(at, asOf))) continue;
			expected.set(raw.id, opener?.id ?? "");
		}
		const files = new Map<string, string[] | null>();
		const fileAtCommit = (commit: string, path: string) => {
			const key = `${commit}:${path}`;
			if (!files.has(key)) files.set(key, fileAt(repo, commit, path));
			return files.get(key) ?? null;
		};
		const threads = served.threads.map((t) => {
			const r = compareThread(
				t,
				byNode.get(expected.get(t.id) ?? "") ?? null,
				fileAtCommit,
			);
			if (!expected.has(t.id))
				r.causes.push("not on GitHub (as of the cutoff)");
			r.match = r.causes.length === 0;
			return r;
		});
		const servedIds = new Set(served.threads.map((t) => t.id));
		for (const id of expected.keys()) {
			if (servedIds.has(id)) continue;
			threads.push({
				id,
				path: "",
				github: "listed",
				ours: "not served",
				source: "none",
				snapshot: "",
				match: false,
				causes: ["not served"],
				notes: [],
			});
		}
		if (!served.complete) {
			for (const t of threads) t.notes.push("read incomplete");
		}
		const count = (f: (t: ThreadResult) => boolean) => threads.filter(f).length;
		return {
			pr: `${ref.owner}/${ref.repo}#${ref.number}`,
			asOf: asOf ?? null,
			threads,
			counts: {
				total: threads.length,
				matching: count((t) => t.match),
				mismatches: count((t) => !t.match),
				fileComments: count((t) => t.github === "file"),
				clone: count((t) => t.source === "clone"),
				github: count((t) => t.source === "github"),
				snapshotSame: count((t) => t.snapshot === "same"),
				snapshotDifferent: count((t) => t.snapshot.startsWith("different")),
			},
		};
	} finally {
		killDetachedGits();
		await session.close();
	}
}

const cell = (text: string) => text.replaceAll("|", "\\|");

export function renderMarkdown(c: Comparison): string {
	const n = c.counts;
	const summary = `${n.matching}/${n.total} match, ${n.mismatches} mismatches (file comments: ${n.fileComments}; code from the clone: ${n.clone}, GitHub's hunk: ${n.github}; snapshot same: ${n.snapshotSame}, different: ${n.snapshotDifferent}).`;
	const rows = c.threads.map(
		(t, i) =>
			`| ${i + 1} | ${cell(t.path)} | ${cell(t.github)} | ${cell(t.ours)} | ${t.source} | ${t.snapshot} | ${t.match ? "yes" : "NO"} | ${cell([...t.causes, ...t.notes].join("; "))} |`,
	);
	return `# ${c.pr}${c.asOf ? ` as of ${c.asOf}` : ""}

${summary}

Checks per line comment, against GitHub's REST review comment: path, commit, side, start side and range (original_*); the marked rows' text on the comment's side = GitHub's hunk's range; with snapshot "same", every marked row and the rows before them = GitHub's hunk (kind, numbers, text); clone rows' new side = the file at the commit. File comments: no code.

| # | path | GitHub | ours | source | snapshot | match | causes; notes |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
}

/** The CLI: 0 all match, 1 a mismatch, 2 couldn't compare. */
export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: { "as-of": { type: "string" }, out: { type: "string" } },
	});
	const [pr, ...extra] = positionals;
	if (!pr || extra.length) {
		console.error(
			"Usage: pnpm compare-threads <pr-url-or-owner/repo#n> [--as-of <iso>] [--out <dir>]",
		);
		return 2;
	}
	const out = resolve(values.out ?? join(tmpdir(), "crb-compare"));
	mkdirSync(out, { recursive: true });
	// Its own clone and review data, never the reviewer's cache.
	process.env.XDG_CACHE_HOME = join(out, "xdg");
	const asOf =
		values["as-of"] === undefined ? undefined : parseAsOf(values["as-of"]);
	const c = await compareThreads(pr, {
		asOf,
		progress: (m) => console.error(`crb: ${m}`),
	});
	writeFileSync(
		join(out, "compare.json"),
		`${JSON.stringify(c, null, "\t")}\n`,
	);
	writeFileSync(join(out, "compare.md"), renderMarkdown(c));
	console.log(
		`${c.counts.matching}/${c.counts.total} match, ${c.counts.mismatches} mismatches: ${join(out, "compare.md")}`,
	);
	return c.counts.mismatches ? 1 : 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(
				`compare-threads: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		},
	);
}
