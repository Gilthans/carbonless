/**
 * Checks carbonless's thread code panes against GitHub (read-only):
 *
 *   pnpm compare-threads <pr-url-or-owner/repo#n> [--as-of <iso>] [--placed-from <iso>] [--out <dir>]
 *
 * Opens the PR the way `crb` does (Session, in-process, with its own cache
 * under <out>/xdg) and reads its threads as the UI is served them (stage
 * "full"). For every review thread it checks what the code pane marks (path,
 * side, line range, the marked rows' text) against GitHub's REST review
 * comment (side/start_side, original_line/original_start_line, diff_hunk).
 * Writes <out>/compare.md and <out>/compare.json; exits 1 on any mismatch,
 * 2 when the comparison couldn't run. <out> defaults to $TMPDIR/crb-compare/<owner>-<repo>-<n>[-asof].
 *
 * The commented range is compared on the comment's own side (docs/faq.md):
 * a comment made in a "changes since" view has another old side, so its
 * context and deleted rows may differ. Where carbonless's snapshot verdict
 * says `same`, every marked row and the rows before them must match
 * GitHub's hunk exactly.
 *
 * `--placed-from <iso>`: a re-review across rounds (C19). Every unresolved
 * thread opened by that cutoff (the reviewer's first round) is placed by
 * carbonless into the head of `--as-of` (their next round) and into the
 * head GitHub's REST `line` is on now (the same head unless the PR moved
 * on since), and the latter compared with GitHub's `line`: the
 * Placements table in compare.md. Disagreements are listed, not failed:
 * GitHub calls a comment outdated when anything in its hunk changed,
 * carbonless only when its own lines did.
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
import {
	fetchHeadAsOf,
	fetchPrMeta,
	fetchThreadSummaries,
	type PrRef,
	resolvePrRef,
	runGh,
} from "../src/server/gh.js";
import { killDetachedGits } from "../src/server/git.js";
import { Session } from "../src/server/session.js";
import { type HunkLine, parseDiffHunk } from "../src/shared/diffHunk.js";
import type { ThreadPlacement } from "../src/shared/rereview/placement.js";
import type {
	CodeRow,
	DiffSide,
	PlacementsAnswer,
	ReviewThread,
} from "../src/shared/types.js";

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

/** How carbonless's placement on GitHub's head compares with GitHub's `line`. */
export type PlacementKind =
	| "agree"
	| "line"
	| "side"
	| "path"
	| "we-unplace"
	| "we-place-outdated";

export interface PlacementRow {
	id: string;
	/** The thread's path as GitHub lists it. */
	path: string;
	/** When its opener was published. */
	opened: string;
	/** GitHub's place on its head now: "RIGHT 29", "RIGHT 25-26", "outdated", "file". */
	github: string;
	/** carbonless's on the as-of head: "placed RIGHT 29", "changed RIGHT 2", "unplaced deleted", "outside file-gone", "file". */
	ours: string;
	/** carbonless's on GitHub's head now, when that isn't the as-of head; else "". */
	oursNow: string;
	kind: PlacementKind;
}

export interface Placements {
	placedFrom: string;
	/** The PR's head at --placed-from, at --as-of (or now), and on GitHub now. */
	fromHead: string;
	toHead: string;
	githubHead: string;
	rows: PlacementRow[];
	/** Unresolved threads opened by --placed-from that GitHub lists no REST comment for. */
	unlisted: number;
	counts: { total: number; agree: number; disagree: number };
}

export interface Comparison {
	pr: string;
	asOf: string | null;
	/** With --placed-from: thread placement across the two rounds. */
	placements?: Placements;
	/** GitHub's state when the PR is over: compared as of now, at its last head. */
	over: "MERGED" | "CLOSED" | null;
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

/** A placement as one cell: "placed RIGHT 29", "unplaced deleted", "file". */
export function placementCell(p: ThreadPlacement): string {
	switch (p.kind) {
		case "placed":
		case "changed": {
			const a = p.anchor;
			return `${p.kind} ${range(a.startSide, a.startLine, a.side, a.line)}`;
		}
		case "unplaced":
			return `unplaced ${p.fate}${p.movedTo ? ` → ${p.movedTo}` : ""}`;
		case "outside":
			return `outside ${p.fate}`;
		case "file":
			return "file";
	}
}

/** GitHub's place for a thread on its head now, from the REST opener. */
export function githubCell(rest: RestComment): string {
	if (rest.subject_type === "file") return "file";
	if (rest.line === null) return "outdated";
	const side = rest.side ?? "RIGHT";
	return range(
		rest.start_side ?? side,
		rest.start_line ?? rest.line,
		side,
		rest.line,
	);
}

/**
 * carbonless's placement on GitHub's head against GitHub's REST `line`
 * there: the same path, side and end line is "agree"; a line GitHub calls
 * outdated agrees with anything but "placed" (GitHub outdates a comment
 * when its hunk changed, carbonless says "changed" or a fate).
 */
export function placementKind(
	ours: ThreadPlacement,
	rest: RestComment,
): PlacementKind {
	if (rest.subject_type === "file") {
		if (ours.kind !== "file") return "we-unplace";
		return ours.path === rest.path ? "agree" : "path";
	}
	if (rest.line === null) {
		return ours.kind === "placed" ? "we-place-outdated" : "agree";
	}
	if (ours.kind !== "placed" && ours.kind !== "changed") return "we-unplace";
	const a = ours.anchor;
	if (a.path !== rest.path) return "path";
	if (a.side !== (rest.side ?? "RIGHT")) return "side";
	return a.line === rest.line ? "agree" : "line";
}

/** Placements into `head`, once the session's background job has them. */
async function placedInto(
	session: Session,
	head: string,
	readId: string,
): Promise<PlacementsAnswer> {
	for (;;) {
		const answer = await session.placements({ head }, readId);
		if (!("pending" in answer)) return answer;
		await new Promise((r) => setTimeout(r, 50));
	}
}

/**
 * The Placements table (--placed-from): every unresolved thread published
 * by `placedFrom` in the session's read (as of a cutoff every thread reads
 * unresolved: GitHub doesn't say when one was resolved), placed into the
 * session's head and into GitHub's head now, compared with GitHub's REST
 * `line`. Placement traces each thread from its own commit, so no patch
 * set is needed (and an as-of review is one per cutoff, so a first
 * round's patch set couldn't be found from the second's anyway).
 */
async function comparePlacements(
	session: Session,
	ref: PrRef,
	placedFrom: string,
	over: boolean,
): Promise<Placements> {
	const [meta, overview, rest, summaries] = await Promise.all([
		fetchPrMeta(ref),
		session.overview(),
		restComments(ref.owner, ref.repo, ref.number),
		fetchThreadSummaries(ref),
	]);
	const fromHead = await fetchHeadAsOf(ref, placedFrom);
	const toHead = session.snapshot().head;
	const githubHead = meta.headOid;
	const served = await session.threads(overview.readId, "full");
	const byNode = new Map(
		rest.filter((c) => c.in_reply_to_id == null).map((c) => [c.node_id, c]),
	);
	const opened = new Map<string, { at: string; node: string }>();
	for (const raw of summaries as {
		id: string;
		first?: { nodes?: { id?: string }[] };
	}[]) {
		const opener = raw.first?.nodes?.[0];
		const at = visibleAt(opener);
		if (at !== null && atOrBefore(at, placedFrom)) {
			opened.set(raw.id, { at, node: opener?.id ?? "" });
		}
	}
	const ours = await placedInto(session, toHead, overview.readId);
	// GitHub's `line` is on its head now: placed there too when the PR
	// moved on (a merged or closed PR's last head is the as-of one).
	const now =
		githubHead === toHead || over
			? ours
			: await placedInto(session, githubHead, overview.readId);
	const placement = (a: PlacementsAnswer, id: string) =>
		a.threads.find((t) => t.id === id)?.placement;
	const rows: PlacementRow[] = [];
	let unlisted = 0;
	for (const t of served.threads) {
		const when = opened.get(t.id);
		if (!when || t.resolved) continue;
		const r = byNode.get(when.node);
		const mine = placement(ours, t.id);
		const mineNow = placement(now, t.id);
		if (!r || !mine || !mineNow) {
			unlisted++;
			continue;
		}
		rows.push({
			id: t.id,
			path: r.path,
			opened: when.at,
			github: githubCell(r),
			ours: placementCell(mine),
			oursNow: now === ours ? "" : placementCell(mineNow),
			kind: placementKind(mineNow, r),
		});
	}
	const agree = rows.filter((r) => r.kind === "agree").length;
	return {
		placedFrom,
		fromHead,
		toHead,
		githubHead,
		rows,
		unlisted,
		counts: { total: rows.length, agree, disagree: rows.length - agree },
	};
}

/** Opens `pr` as crb does and compares every thread it serves with GitHub. */
export async function compareThreads(
	pr: string,
	options: {
		asOf?: string;
		/** A first round's cutoff: the Placements table (comparePlacements). */
		placedFrom?: string;
		cwd?: string;
		progress?: (m: string) => void;
	} = {},
): Promise<Comparison> {
	const cwd = options.cwd ?? process.cwd();
	let asOf = options.asOf;
	let over: Comparison["over"] = null;
	if (!asOf) {
		// crb won't open a merged or closed PR with no review started; as of
		// now it is the PR at its last head, every thread opened.
		const meta = await fetchPrMeta(await resolvePrRef(pr, cwd));
		if (meta.state !== "OPEN") {
			over = meta.state;
			asOf = parseAsOf(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
		}
	}
	const session = await Session.open(pr, cwd, options.progress, { asOf });
	try {
		const info = session.info().pr;
		const ref = { owner: info.owner, repo: info.repo, number: info.number };
		const repo = clonePath(ref.owner, ref.repo);
		const files = new Map<string, string[] | null>();
		const fileAtCommit = (commit: string, path: string) => {
			const key = `${commit}:${path}`;
			if (!files.has(key)) files.set(key, fileAt(repo, commit, path));
			return files.get(key) ?? null;
		};
		// carbonless's read and GitHub's lists, each compared with the other.
		// `fresh`: a new read of carbonless's, not the one opening served.
		const compareRead = async (fresh: boolean): Promise<ThreadResult[]> => {
			const [overview, rest, summaries] = await Promise.all([
				session.overview(fresh ? 0 : undefined),
				restComments(ref.owner, ref.repo, ref.number),
				fetchThreadSummaries(ref),
			]);
			const served = await session.threads(overview.readId, "full");
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
			const results = served.threads.map((t) => {
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
				results.push({
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
				for (const t of results) t.notes.push("read incomplete");
			}
			return results;
		};
		let threads = await compareRead(false);
		// A thread opened on a live PR between the reads isn't carbonless's
		// miss: read everything again once before reporting it.
		if (threads.some((t) => t.causes.includes("not served"))) {
			threads = await compareRead(true);
			for (const t of threads) {
				if (t.causes.includes("not served"))
					t.notes.push("also when read again");
			}
		}
		const count = (f: (t: ThreadResult) => boolean) => threads.filter(f).length;
		const placements = options.placedFrom
			? await comparePlacements(session, ref, options.placedFrom, over !== null)
			: undefined;
		return {
			pr: `${ref.owner}/${ref.repo}#${ref.number}`,
			asOf: asOf ?? null,
			...(placements ? { placements } : {}),
			over,
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
	const when = !c.asOf
		? ""
		: c.over
			? ` (${c.over.toLowerCase()}: as of ${c.asOf}, its last head)`
			: ` as of ${c.asOf}`;
	const summary = `${n.matching}/${n.total} match, ${n.mismatches} mismatches (line comments: ${n.total - n.fileComments}, file comments: ${n.fileComments}; code from the clone: ${n.clone}, GitHub's hunk: ${n.github}; snapshot same: ${n.snapshotSame}, different: ${n.snapshotDifferent}).`;
	const rows = c.threads.map(
		(t, i) =>
			`| ${i + 1} | ${cell(t.path)} | ${cell(t.github)} | ${cell(t.ours)} | ${t.source} | ${t.snapshot} | ${t.match ? "yes" : "NO"} | ${cell([...t.causes, ...t.notes].join("; "))} |`,
	);
	return `# ${c.pr}${when}

${summary}

Checks per line comment, against GitHub's REST review comment: path, commit, side, start side and range (original_*); the marked rows' text on the comment's side = GitHub's hunk's range; with snapshot "same", every marked row and the rows before them = GitHub's hunk (kind, numbers, text); clone rows' new side = the file at the commit. File comments: no code.

| # | path | GitHub | ours | source | snapshot | match | causes; notes |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
${c.placements ? renderPlacements(c.placements) : ""}`;
}

const short = (oid: string) => oid.slice(0, 7);

/** compare.md's Placements section (--placed-from). */
export function renderPlacements(p: Placements): string {
	const moved = p.githubHead !== p.toHead;
	const rows = p.rows.map(
		(r, i) =>
			`| ${i + 1} | ${cell(r.path)} | ${r.opened} | ${cell(r.github)} | ${cell(r.ours)} |${moved ? ` ${cell(r.oursNow)} |` : ""} ${r.kind} |`,
	);
	return `
## Placements

Unresolved threads opened by ${p.placedFrom} (head ${short(p.fromHead)}), placed by carbonless into ${short(p.toHead)}${moved ? ` and into GitHub's head now, ${short(p.githubHead)}` : ""}, against GitHub's REST \`line\` on ${short(p.githubHead)}: ${p.counts.agree}/${p.counts.total} agree, ${p.counts.disagree} disagree${p.unlisted ? `, ${p.unlisted} not listed by GitHub's REST` : ""}.

Kinds: agree; line, side, path (both place it, elsewhere); we-unplace (GitHub places it, carbonless lists it unplaced or outside); we-place-outdated (GitHub calls it outdated, carbonless places it on the same text).

| # | path | opened | GitHub | ours on ${short(p.toHead)} |${moved ? ` ours on ${short(p.githubHead)} |` : ""} kind |
|---|---|---|---|---|${moved ? "---|" : ""}---|
${rows.join("\n")}
`;
}

const USAGE = `Usage: pnpm compare-threads <pr-url-or-owner/repo#n> [--as-of <iso>] [--placed-from <iso>] [--out <dir>]

--placed-from: a first round's cutoff; adds the Placements table (threads
opened by then, placed into the --as-of head, against GitHub's line).

--out defaults to $TMPDIR/crb-compare/<owner>-<repo>-<n>[-asof].
On a live PR a thread opened mid-run can look "not served": such a
mismatch is reported only if a second read still shows it.`;

/** The CLI: 0 all match, 1 a mismatch, 2 couldn't compare. */
export async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			"as-of": { type: "string" },
			"placed-from": { type: "string" },
			out: { type: "string" },
		},
	});
	const [pr, ...extra] = positionals;
	if (!pr || extra.length) {
		console.error(USAGE);
		return 2;
	}
	const asOf =
		values["as-of"] === undefined ? undefined : parseAsOf(values["as-of"]);
	const placedFrom =
		values["placed-from"] === undefined
			? undefined
			: parseAsOf(values["placed-from"]);
	if (placedFrom && asOf && placedFrom >= asOf) {
		console.error("--placed-from must be before --as-of");
		return 2;
	}
	const ref = await resolvePrRef(pr, process.cwd());
	const out = resolve(
		values.out ??
			join(
				tmpdir(),
				"crb-compare",
				`${ref.owner}-${ref.repo}-${ref.number}${asOf ? "-asof" : ""}`,
			),
	);
	mkdirSync(out, { recursive: true });
	// Its own clone and review data, never the reviewer's cache; restored
	// after, for callers in the same process.
	const savedXdg = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = join(out, "xdg");
	let c: Comparison;
	try {
		c = await compareThreads(pr, {
			asOf,
			placedFrom,
			progress: (m) => console.error(`crb: ${m}`),
		});
	} finally {
		if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = savedXdg;
	}
	writeFileSync(
		join(out, "compare.json"),
		`${JSON.stringify(c, null, "\t")}\n`,
	);
	writeFileSync(join(out, "compare.md"), renderMarkdown(c));
	console.log(
		`${c.counts.matching}/${c.counts.total} match, ${c.counts.mismatches} mismatches${c.placements ? `; placements ${c.placements.counts.agree}/${c.placements.counts.total} agree` : ""}: ${join(out, "compare.md")}`,
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
