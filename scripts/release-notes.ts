// Release notes (CAR-192, docs/superpowers/specs/2026-11-16-release-notes-design.md;
// docs/releasing.md, "Release notes"). Linear is the source: each ticket has
// a `Release note` comment. `pnpm release promote` collects the RC's notes
// from Linear and sends them to the promote run as an input (CAR-242), which
// checks they cover the release from git alone and ships them in the
// release's package (crbReleaseNotes, crbReleaseNotesFile in package.json,
// dist/release-notes.json); release-finish commits what was published as
// release-notes/X.Y.Z.json. `pnpm release notes` can still snapshot them
// early (a "notes: X.Y.Z" PR), for RCs' What's new. The one Linear key in
// CI is the release-note check's (CAR-211: read only, in that one step,
// running master's code).
// Linear and git go through injected clients, so tests drive everything
// with fakes.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	compareReleaseVersions,
	MAX_LOCAL_BYTES,
	MAX_SHIPPED_BYTES,
	MAX_SHIPPED_VERSIONS,
	NOTE_KINDS,
	type NoteKind,
	noneWhyProblems,
	noteTextProblems,
	parseReleaseNotesFile,
	printable,
	type ReleaseNoneEntry,
	type ReleaseNote,
	type ReleaseNotesFile,
	type ShippedReleaseNotes,
	sortNotes,
} from "../src/shared/releaseNotes.js";
import {
	formatVersion,
	type Io,
	must,
	PACKAGE,
	parseManifest,
	parseVersion,
	previousRelease,
	publishedIntegrity,
	remoteTags,
	tagOf,
	tarballDigests,
} from "./release-lib.js";

const NOTES_DIR = "release-notes";
const TEAM = "CAR";

// ---------------------------------------------------------------------------
// The `Release note` lines (a Linear comment, or a ticket-less PR's description).

/** One parsed `Release note` line. */
export type NoteLine =
	| { kind: NoteKind | null; text: string }
	| { none: string };

/** A ticket's (or PR's) decision: notes, an explicit none, nothing, or a line that breaks the rules. */
export type NoteStatus =
	| { status: "notes"; notes: { kind: NoteKind; text: string }[] }
	| { status: "none"; why: string }
	| { status: "missing" }
	| { status: "invalid"; errors: string[] };

const MARKER = /^\s*release note\b/i;
const LINE = /^\s*release note\s*(?:\(\s*([a-z]+)\s*\))?\s*:\s*(.*?)\s*$/i;

/** Parses one `Release note…` line (`line` must start with the marker). */
export function parseNoteLine(line: string): NoteLine | { error: string } {
	const m = LINE.exec(line);
	if (!m) {
		return {
			error: `"${clip(line)}" isn't "Release note (new|improved|fixed): text" or "Release note: none (why)"`,
		};
	}
	const kindWord = m[1]?.toLowerCase();
	const rest = m[2] ?? "";
	if (/^none\b/i.test(rest)) {
		const why = /^none\s*\((.*)\)$/i.exec(rest)?.[1]?.trim();
		if (kindWord) return { error: `"${clip(line)}": none takes no kind` };
		if (why === undefined) {
			return {
				error: `"${clip(line)}": none needs a reason in parentheses, e.g. "Release note: none (flaky test fix)"`,
			};
		}
		const problems = noneWhyProblems(why);
		if (problems.length > 0) {
			return { error: `"${clip(line)}": the reason ${problems.join(", ")}` };
		}
		return { none: why };
	}
	let kind: NoteKind | null = null;
	if (kindWord !== undefined) {
		if (!(NOTE_KINDS as readonly string[]).includes(kindWord)) {
			return {
				error: `"${clip(line)}": the kind is new, improved or fixed, not ${kindWord}`,
			};
		}
		kind = kindWord as NoteKind;
	}
	const problems = noteTextProblems(rest);
	if (problems.length > 0) {
		return { error: `"${clip(line)}": the note ${problems.join(", ")}` };
	}
	return { kind, text: rest };
}

/** Text from a PR or Linear, shortened and safe to print (no control or bidi characters). */
const clip = (s: string) => {
	const t = printable(s.trim());
	return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

/** The kind a ticket's labels imply (Feature, Improvement, Bug), null when none or several. */
export function kindFromLabels(labels: readonly string[]): NoteKind | null {
	const byLabel: Record<string, NoteKind> = {
		feature: "new",
		improvement: "improved",
		bug: "fixed",
	};
	const kinds = new Set(
		labels.flatMap((l) => {
			const k = byLabel[l.trim().toLowerCase()];
			return k ? [k] : [];
		}),
	);
	return kinds.size === 1 ? ([...kinds][0] ?? null) : null;
}

/**
 * The status of a set of parsed lines, kinds defaulting to `defaultKind`;
 * `noKind` says why a line without one has none to take.
 */
function statusOf(
	lines: (NoteLine | { error: string })[],
	defaultKind: NoteKind | null,
	noKind: string,
): NoteStatus {
	if (lines.length === 0) return { status: "missing" };
	const errors: string[] = [];
	const notes: { kind: NoteKind; text: string }[] = [];
	const nones: string[] = [];
	for (const l of lines) {
		if ("error" in l) errors.push(l.error);
		else if ("none" in l) nones.push(l.none);
		else if (l.kind ?? defaultKind) {
			notes.push({ kind: (l.kind ?? defaultKind) as NoteKind, text: l.text });
		} else {
			errors.push(
				`"${clip(l.text)}": no kind, and ${noKind} (write "Release note (new|improved|fixed): …")`,
			);
		}
	}
	if (nones.length > 0 && notes.length > 0) {
		errors.push("has both notes and none: say one or the other");
	}
	if (nones.length > 1) errors.push("says none more than once");
	if (errors.length > 0) return { status: "invalid", errors };
	if (nones.length === 1) return { status: "none", why: nones[0] ?? "" };
	return { status: "notes", notes };
}

/**
 * The `Release note` lines of a text, parsed. Other text may follow after a
 * blank line (agents add a merge report), but a line right under a note,
 * with no blank line between, is an error: it reads as the note wrapped
 * onto a second line, which would otherwise be cut short without a word.
 */
function markedLines(text: string): (NoteLine | { error: string })[] {
	const out: (NoteLine | { error: string })[] = [];
	let afterNote = false;
	for (const line of text.split(/\r?\n/)) {
		if (MARKER.test(line)) {
			out.push(parseNoteLine(line));
			afterNote = true;
		} else if (line.trim() === "") {
			afterNote = false;
		} else if (afterNote) {
			out.push({
				error: `"${clip(line)}" continues a Release note line: a note is one line (leave a blank line before other text)`,
			});
			afterNote = false;
		}
	}
	return out;
}

/**
 * A Linear comment's note lines when it is a release-note comment (its
 * first non-blank line starts with `Release note`), else null.
 */
export function commentNoteLines(
	body: string,
): (NoteLine | { error: string })[] | null {
	const first = body.split(/\r?\n/).find((l) => l.trim() !== "");
	if (!first || !MARKER.test(first)) return null;
	return markedLines(body);
}

export type LinearComment = { body: string; updatedAt: string };

/** A ticket's note: its newest release-note comment (by updatedAt) wins. */
export function ticketNote(
	comments: readonly LinearComment[],
	labels: readonly string[],
): NoteStatus {
	const marked = comments
		.map((c) => ({ c, lines: commentNoteLines(c.body) }))
		.filter((x) => x.lines !== null)
		.sort((a, b) => b.c.updatedAt.localeCompare(a.c.updatedAt));
	const newest = marked[0];
	if (!newest?.lines) return { status: "missing" };
	return statusOf(newest.lines, kindFromLabels(labels), "its labels don't say");
}

/**
 * A PR description's note: its `Release note` lines, anywhere in it. A
 * ticket-less PR's note (`ticket` undefined), or a ticket PR's when the
 * ticket has none in Linear (CAR-211): its labels give the default kind,
 * or "unread" when there's no Linear key to read them.
 */
export function prBodyNote(
	body: string | null | undefined,
	ticket?: { labels: readonly string[] } | "unread",
): NoteStatus {
	const lines = markedLines(body ?? "");
	if (ticket === undefined) {
		return statusOf(
			lines,
			null,
			"a PR without a ticket has no labels to take it from",
		);
	}
	if (ticket === "unread") {
		return statusOf(
			lines,
			null,
			"the ticket's labels aren't read here: state the kind",
		);
	}
	return statusOf(
		lines,
		kindFromLabels(ticket.labels),
		"its ticket's labels don't say",
	);
}

/**
 * One decision from the descriptions of a ticket's PRs (a ticket with no
 * note in Linear): every note any of them gives, else a none, else
 * missing; a broken line anywhere makes it invalid.
 */
export function descriptionsNote(statuses: readonly NoteStatus[]): NoteStatus {
	const errors = statuses.flatMap((s) =>
		s.status === "invalid" ? s.errors : [],
	);
	if (errors.length > 0) return { status: "invalid", errors };
	const notes: { kind: NoteKind; text: string }[] = [];
	for (const s of statuses) {
		if (s.status !== "notes") continue;
		for (const n of s.notes) {
			if (!notes.some((m) => m.text === n.text)) notes.push(n);
		}
	}
	if (notes.length > 0) return { status: "notes", notes };
	const none = statuses.find((s) => s.status === "none");
	return none ?? { status: "missing" };
}

// ---------------------------------------------------------------------------
// Which PRs and tickets are in a release: git's first-parent subjects.

export type RangePr = {
	number: number;
	title: string;
	tickets: string[];
	/** `next: X.Y.Z` (release-finish) or `notes: X.Y.Z`: no note needed. */
	exempt: boolean;
};

/** Every `CAR-NNN` in a PR title, upper-cased, once each, in order. */
export function titleTickets(title: string): string[] {
	const out: string[] = [];
	for (const m of title.matchAll(/\bCAR-([1-9]\d*)\b/gi)) {
		const id = `${TEAM}-${m[1]}`;
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

/** A release PR's title: `next: X.Y.Z` (release-finish) or `notes: X.Y.Z`. */
const isExemptTitle = (title: string) =>
	/^(next|notes): \d+\.\d+\.\d+$/.test(title.trim());

/**
 * Whether a release PR's changes make it one: only package.json,
 * docs/changelog.md and release-notes/. A PR with such a title that
 * changes anything else needs a note like any other (the title alone is
 * anyone's to write).
 */
const releasePrFiles = (files: readonly string[]) =>
	files.every(
		(f) =>
			f === "package.json" ||
			f === "docs/changelog.md" ||
			/^release-notes\/[^/]+$/.test(f),
	);

/** A first-parent subject's PR: the title and `(#N)` at its end; null when it isn't a PR. */
export function subjectPr(subject: string): RangePr | null {
	const m = /^(.*)\s\(#([1-9]\d*)\)\s*$/.exec(subject);
	if (!m) return null;
	const title = (m[1] ?? "").trim();
	return {
		number: Number(m[2]),
		title,
		tickets: titleTickets(title),
		// releaseRange also checks what the commit changes.
		exempt: isExemptTitle(title),
	};
}

export type ReleaseRange = {
	/** The previous release's tag the range starts after (null: none). */
	from: string | null;
	/** Oldest first. */
	prs: RangePr[];
	/** First-parent subjects with no `(#N)` (a direct push): listed, never a PR. */
	other: string[];
};

/**
 * The PRs of release `version`: master's first-parent commits after the
 * previous release's tag, up to `to`. Needs only git (CI runs it with no
 * token); the tags come from Io.tags, the commits from the checkout.
 */
export async function releaseRange(
	io: Io,
	version: string,
	to: string,
	cwd?: string,
): Promise<ReleaseRange> {
	const v = parseVersion(version);
	if (!v || v.rc !== undefined) throw new Error(`not a release: ${version}`);
	const from = previousRelease(await remoteTags(io, cwd), v);
	const log = await must(
		io,
		"git",
		[
			"log",
			"--first-parent",
			"--reverse",
			"--format=%H %s",
			from ? `refs/tags/${from}..${to}` : to,
			"--",
		],
		{ cwd },
	);
	const prs: RangePr[] = [];
	const other: string[] = [];
	for (const line of log.split("\n")) {
		if (line.trim() === "") continue;
		const sha = line.slice(0, line.indexOf(" "));
		const subject = line.slice(sha.length + 1);
		const pr = subjectPr(subject);
		if (!pr) {
			other.push(subject);
			continue;
		}
		if (pr.exempt) {
			// What the merge (or squash) brought onto master.
			const files = await must(
				io,
				"git",
				["diff", "--name-only", `${sha}^1`, sha, "--"],
				{ cwd },
			);
			pr.exempt = releasePrFiles(files.split("\n").filter((f) => f !== ""));
		}
		prs.push(pr);
	}
	return { from, prs, other };
}

// ---------------------------------------------------------------------------
// release-notes/X.Y.Z.json.

export const notesPath = (version: string) => `${NOTES_DIR}/${version}.json`;

/** The file's text: tabs, PR lists on one line (as biome formats it). */
export function formatNotesFile(file: ReleaseNotesFile): string {
	const text = JSON.stringify(file, null, "\t").replace(
		/\[\s*(\d+(?:,\s*\d+)*)\s*\]/g,
		(_, nums: string) => `[${nums.split(/,\s*/).join(", ")}]`,
	);
	return `${text}\n`;
}

/** Parses a notes file's text strictly, naming it in errors. */
export function readNotesFile(text: string, name: string): ReleaseNotesFile {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${name} isn't JSON: ${(error as Error).message}`);
	}
	const parsed = parseReleaseNotesFile(value);
	if (!parsed.ok) {
		throw new Error(`${name} is malformed: ${parsed.errors.join("; ")}`);
	}
	return parsed.file;
}

/** Every release-notes/*.json at `ref` (git only), by version. */
export async function notesFilesAt(
	io: Io,
	ref: string,
	cwd?: string,
): Promise<Map<string, ReleaseNotesFile>> {
	const r = await io.run(
		"git",
		["ls-tree", "--name-only", `${ref}:${NOTES_DIR}`],
		{ cwd },
	);
	const files = new Map<string, ReleaseNotesFile>();
	// No such directory at that commit (before the first notes): none.
	if (r.code !== 0) return files;
	for (const name of r.stdout.split("\n")) {
		const m = /^(\d+\.\d+\.\d+)\.json$/.exec(name.trim());
		if (!m?.[1]) continue;
		const path = notesPath(m[1]);
		const file = readNotesFile(
			await must(io, "git", ["show", `${ref}:${path}`], { cwd }),
			path,
		);
		if (file.version !== m[1]) {
			throw new Error(`${path} is for version ${file.version}`);
		}
		files.set(m[1], file);
	}
	return files;
}

/** Ticket and PR ids an older version's file already covers (notes or none). */
function olderIds(
	files: Map<string, ReleaseNotesFile>,
	version: string,
): Set<string> {
	const ids = new Set<string>();
	for (const [v, f] of files) {
		if (compareReleaseVersions(v, version) >= 0) continue;
		for (const e of [...f.notes, ...f.none]) ids.add(e.id);
	}
	return ids;
}

/** The ids a release's PRs need covered: each ticket, or `#N` for a ticket-less PR. */
function neededIds(range: ReleaseRange): Map<string, number[]> {
	const ids = new Map<string, number[]>();
	for (const pr of range.prs) {
		if (pr.exempt) continue;
		for (const id of pr.tickets.length > 0 ? pr.tickets : [`#${pr.number}`]) {
			ids.set(id, [...(ids.get(id) ?? []), pr.number]);
		}
	}
	return ids;
}

/**
 * What a release's file (null: none yet) leaves uncovered: each id with its
 * PRs, and the PRs with any uncovered id. A ticket an older version's file
 * covers is covered (its note shipped there).
 */
export function coverage(
	range: ReleaseRange,
	file: ReleaseNotesFile | null,
	files: Map<string, ReleaseNotesFile>,
	version: string,
): { missing: { id: string; prs: number[] }[]; uncoveredPrs: number[] } {
	const covered = olderIds(files, version);
	for (const e of [...(file?.notes ?? []), ...(file?.none ?? [])]) {
		covered.add(e.id);
	}
	const missing: { id: string; prs: number[] }[] = [];
	const prs = new Set<number>();
	for (const [id, numbers] of neededIds(range)) {
		if (covered.has(id)) continue;
		missing.push({ id, prs: numbers });
		for (const n of numbers) prs.add(n);
	}
	return { missing, uncoveredPrs: [...prs].sort((a, b) => a - b) };
}

const prList = (prs: number[]) => prs.map((n) => `#${n}`).join(", ");

/** The real fix when promote has no Linear key to collect the notes with. */
const KEY_FIX =
	"set up the Linear key ($LINEAR_API_KEY or ~/.config/linear/api-key) and promote again (it collects the notes itself)";

/**
 * A committed notes file alone (`pnpm release promote` without a Linear
 * key; git only): fails unless release-notes/X.Y.Z.json at `sha` is well formed, is for
 * X.Y.Z, and covers every ticket and ticket-less PR of the release.
 */
export async function notesCheck(
	io: Io,
	version: string,
	sha: string,
	cwd?: string,
): Promise<string> {
	const path = notesPath(version);
	const files = await notesFilesAt(io, sha, cwd);
	const file = files.get(version);
	if (!file) {
		throw new Error(
			`no ${path} at ${sha}: ${KEY_FIX}; else run pnpm release notes ${version} --pr and merge its "notes: ${version}" PR, then promote that RC`,
		);
	}
	const range = await releaseRange(io, version, sha, cwd);
	const { missing } = coverage(range, file, files, version);
	if (missing.length > 0) {
		throw new Error(
			`${path} doesn't cover ${missing.map((m) => `${m.id} (${prList(m.prs)})`).join(", ")}: give each a Release note (pnpm release note), then ${KEY_FIX}; else run pnpm release notes ${version} --pr again`,
		);
	}
	const prs = range.prs.filter((p) => !p.exempt).length;
	return `ok: ${path} covers the ${prs} PR(s) since ${range.from ?? "the first commit"} (${file.notes.length} notes, ${file.none.length} none)`;
}

// ---------------------------------------------------------------------------
// The promote run's notes (CAR-242): `pnpm release promote` collects them
// for exactly the RC's range and sends them as a workflow_dispatch input;
// promote-check verifies them from git alone and ships them.

/**
 * At most this many characters of encoded notes in the `notes` input:
 * GitHub caps a dispatch's inputs at 65,535 characters in all, and the
 * other inputs (mode, rc, next) take a few dozen.
 */
export const MAX_NOTES_INPUT_CHARS = 60_000;

/** The `notes` input: the notes file as compact JSON, gzipped, base64. */
export function encodeNotesInput(file: ReleaseNotesFile): string {
	const text = gzipSync(Buffer.from(JSON.stringify(file)), {
		level: 9,
	}).toString("base64");
	if (text.length > MAX_NOTES_INPUT_CHARS) {
		throw new Error(
			`${file.version}'s notes are ${text.length} characters encoded, over the ${MAX_NOTES_INPUT_CHARS} a workflow input can carry (GitHub caps a dispatch's inputs at 65,535): shorten notes in Linear (pnpm release note), then promote again`,
		);
	}
	return text;
}

/** The `notes` input read back strictly: a notes file of `version`, or an error saying what's wrong. */
export function decodeNotesInput(
	text: string,
	version: string,
): ReleaseNotesFile {
	const t = text.trim();
	if (t.length > MAX_NOTES_INPUT_CHARS) {
		throw new Error(
			`the notes input is ${t.length} characters, over ${MAX_NOTES_INPUT_CHARS}`,
		);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) {
		throw new Error("the notes input isn't base64");
	}
	let json: string;
	try {
		json = gunzipSync(Buffer.from(t, "base64"), {
			maxOutputLength: MAX_LOCAL_BYTES,
		}).toString("utf8");
	} catch (error) {
		throw new Error(
			`the notes input isn't gzip (or unpacks to over ${MAX_LOCAL_BYTES} bytes): ${(error as Error).message}`,
		);
	}
	const file = readNotesFile(json, "the notes input");
	if (file.version !== version) {
		throw new Error(`the notes input is for ${file.version}, not ${version}`);
	}
	return file;
}

/** none entries in a file's order: by first PR, then id. */
const sortNone = (none: ReleaseNoneEntry[]) =>
	[...none].sort(
		(a, b) => (a.prs[0] ?? 0) - (b.prs[0] ?? 0) || a.id.localeCompare(b.id),
	);

const entryIds = (f: ReleaseNotesFile) =>
	new Set([...f.notes, ...f.none].map((e) => e.id));

/** One id's entries in a file, comparable as text. */
const entriesOf = (f: ReleaseNotesFile, id: string) =>
	JSON.stringify([
		f.notes.filter((n) => n.id === id),
		f.none.filter((n) => n.id === id),
	]);

/**
 * The promote input over a notes file already at the RC's commit: the
 * input's entries win for every id it has (notes or none); the file's
 * other ids are kept. `replaced`: ids both have, differently; `kept`: ids
 * only the file has.
 */
export function mergeNotes(
	input: ReleaseNotesFile | null,
	file: ReleaseNotesFile | null,
): { file: ReleaseNotesFile; replaced: string[]; kept: string[] } {
	if (!input) {
		if (!file) throw new Error("no notes to merge");
		return { file, replaced: [], kept: [] };
	}
	if (!file) return { file: input, replaced: [], kept: [] };
	const ids = entryIds(input);
	const fileIds = [...entryIds(file)];
	return {
		file: {
			version: input.version,
			date: input.date ?? file.date,
			notes: sortNotes([
				...input.notes,
				...file.notes.filter((n) => !ids.has(n.id)),
			]),
			none: sortNone([
				...input.none,
				...file.none.filter((n) => !ids.has(n.id)),
			]),
		},
		replaced: fileIds.filter(
			(id) => ids.has(id) && entriesOf(file, id) !== entriesOf(input, id),
		),
		kept: fileIds.filter((id) => !ids.has(id)),
	};
}

/**
 * `ci:notes-input` (promote-check, no token, no Linear): the release's
 * notes from the promote's `notes` input (empty: none given) over
 * release-notes/X.Y.Z.json at `sha`, if any. Fails unless the input is
 * well formed, for X.Y.Z, has only entries of the range's PRs, and
 * together with the file covers every ticket and ticket-less PR of the
 * release up to `sha`. Returns the notes and a markdown summary.
 */
export async function notesFromInput(
	io: Io,
	version: string,
	sha: string,
	encoded: string,
	cwd?: string,
): Promise<{ file: ReleaseNotesFile; summary: string }> {
	const path = notesPath(version);
	const files = await notesFilesAt(io, sha, cwd);
	const atCommit = files.get(version) ?? null;
	const input =
		encoded.trim() === "" ? null : decodeNotesInput(encoded, version);
	if (!input && !atCommit) {
		throw new Error(
			`no release notes for ${version}: start the promote with pnpm release promote (it sends them from Linear), or merge ${path} (pnpm release notes ${version} --pr) and promote that RC`,
		);
	}
	const range = await releaseRange(io, version, sha, cwd);
	const merged = mergeNotes(input, atCommit);
	// Exactly this range, whatever the notes came from (the input, or
	// entries kept from the file): an entry of another PR would ship a
	// note of a change the release doesn't have (notes collected for
	// another RC, or a file edited by hand).
	const needed = neededIds(range);
	const inRange = new Set(
		range.prs.filter((p) => !p.exempt).map((p) => p.number),
	);
	const foreign = [
		...new Set(
			[...merged.file.notes, ...merged.file.none]
				.filter((e) => !needed.has(e.id) || e.prs.some((n) => !inRange.has(n)))
				.map((e) => e.id),
		),
	];
	if (foreign.length > 0) {
		const fromInput = input ? entryIds(input) : new Set<string>();
		const from = (id: string) => (fromInput.has(id) ? "the notes input" : path);
		throw new Error(
			`the release notes have entries outside ${version}'s PRs up to ${sha}: ${foreign.map((id) => `${id} (${from(id)})`).join(", ")}: collected for another RC, or edited by hand? Promote again with pnpm release promote, or fix ${path}`,
		);
	}
	const { missing } = coverage(range, merged.file, files, version);
	if (missing.length > 0) {
		throw new Error(
			`the release notes don't cover ${missing.map((m) => `${m.id} (${prList(m.prs)})`).join(", ")}: give each a Release note (pnpm release note), then pnpm release promote again`,
		);
	}
	const prs = range.prs.filter((p) => !p.exempt).length;
	const source = input
		? atCommit
			? `the promote's input, over ${path} at the RC`
			: "the promote's input"
		: `${path} at the RC (no input)`;
	const lines = [
		`### Release notes of ${version}`,
		"",
		`The ${prs} PR(s) since ${range.from ?? "the first commit"}: ${merged.file.notes.length} notes, ${merged.file.none.length} none, from ${source}.`,
	];
	if (merged.replaced.length > 0) {
		lines.push(
			"",
			`The input replaced ${path}'s entries for ${merged.replaced.join(", ")}.`,
		);
	}
	if (merged.kept.length > 0) {
		lines.push(
			"",
			`Kept from ${path} (not in the input): ${merged.kept.join(", ")}.`,
		);
	}
	lines.push("", renderNotesBody(merged.file, range));
	return { file: merged.file, summary: lines.join("\n") };
}

/**
 * release-finish: the notes `version` was published with, from the
 * promote run's tarball in `dir` (its manifest.json and .tgz) once npm is
 * shown to have that very tarball (its integrity): the package.json field
 * crbReleaseNotesFile. Null when the package has none (promoted before
 * CAR-242): the caller falls back to the file at the RC's commit.
 */
async function publishedNotes(
	io: Io,
	version: string,
	dir: string,
): Promise<ReleaseNotesFile | null> {
	const manifest = parseManifest(
		readFileSync(join(dir, "manifest.json"), "utf8"),
	);
	if (manifest.version !== version) {
		throw new Error(
			`the promote run released ${manifest.version}, not ${version}`,
		);
	}
	const tarball = join(dir, manifest.tarball);
	const { integrity } = tarballDigests(readFileSync(tarball));
	if (integrity !== manifest.integrity) {
		throw new Error(
			`${manifest.tarball} is ${integrity}, the manifest says ${manifest.integrity}`,
		);
	}
	const published = await publishedIntegrity(io, version);
	if (published !== integrity) {
		throw new Error(
			`npm has ${PACKAGE}@${version} as ${published ?? "nothing"}, not the promote run's tarball (${integrity})`,
		);
	}
	const pkg = JSON.parse(
		await must(io, "tar", ["-xzOf", tarball, "package/package.json"]),
	) as { crbReleaseNotesFile?: unknown };
	if (pkg.crbReleaseNotesFile === undefined) return null;
	const parsed = parseReleaseNotesFile(pkg.crbReleaseNotesFile);
	if (!parsed.ok) {
		throw new Error(
			`the published crbReleaseNotesFile is malformed: ${parsed.errors.join("; ")}`,
		);
	}
	if (parsed.file.version !== version) {
		throw new Error(
			`the published crbReleaseNotesFile is for ${parsed.file.version}, not ${version}`,
		);
	}
	return parsed.file;
}

/**
 * `ci:published-notes`: the published notes (`publishedNotes`); for a
 * package promoted without them (before CAR-242), the notes file at the
 * RC's commit, with a warning; an error when there is neither.
 */
export async function finishNotes(
	io: Io,
	version: string,
	dir: string,
): Promise<{ file: ReleaseNotesFile; warning: string | null }> {
	const published = await publishedNotes(io, version, dir);
	if (published) return { file: published, warning: null };
	const { sha } = parseManifest(
		readFileSync(join(dir, "manifest.json"), "utf8"),
	);
	const file = (await notesFilesAt(io, sha)).get(version);
	if (!file) {
		throw new Error(
			`${version}'s package has no crbReleaseNotesFile, and ${notesPath(version)} isn't at ${sha} either`,
		);
	}
	return {
		file,
		warning: `${version}'s package has no crbReleaseNotesFile (promoted before CAR-242): using ${notesPath(version)} at ${sha}`,
	};
}

// ---------------------------------------------------------------------------
// What ships: crbReleaseNotes in package.json (capped, for npm's
// manifest), dist/release-notes.json (every version, local).

/** Newest first, the oldest dropped while over `maxBytes`; refused when the newest alone is. */
function capBytes(
	entries: ShippedReleaseNotes[],
	maxBytes: number,
): ShippedReleaseNotes[] {
	const out = [...entries];
	const size = () => Buffer.byteLength(JSON.stringify(out));
	while (out.length > 1 && size() > maxBytes) out.pop();
	if (size() > maxBytes) {
		throw new Error(
			`${out[0]?.version}'s notes alone are ${size()} bytes, over ${maxBytes}`,
		);
	}
	return out;
}

/** crbReleaseNotes: newest first, at most MAX_SHIPPED_VERSIONS and MAX_SHIPPED_BYTES (oldest dropped first). */
export function capShipped(
	entries: ShippedReleaseNotes[],
): ShippedReleaseNotes[] {
	return capBytes(entries.slice(0, MAX_SHIPPED_VERSIONS), MAX_SHIPPED_BYTES);
}

/** dist/release-notes.json: every version, newest first, within MAX_LOCAL_BYTES. */
export function capLocal(
	entries: ShippedReleaseNotes[],
): ShippedReleaseNotes[] {
	return capBytes(entries, MAX_LOCAL_BYTES);
}

/**
 * Where ci:set-version leaves the full list for the build
 * (scripts/build-info.mjs): in the checkout's own git dir, so the tree
 * stays clean and nothing of it reaches the package's manifest.
 */
export const LOCAL_NOTES_GIT_PATH = "crb-release-notes.json";

/**
 * The notes a build of `version` (X.Y.Z-rc.N or X.Y.Z) at `dir`'s HEAD
 * ships: its release's notes (undated; an RC also lists the range's PRs
 * no note covers yet) and every earlier released version's (dated by
 * their file, else their tag), newest first, uncapped: `capShipped` for
 * the manifest, `capLocal` for dist. A release's own notes are `given`
 * when passed (promote's, CAR-242), else its file at HEAD.
 */
export async function shippedNotes(
	io: Io,
	version: string,
	dir: string,
	given?: ReleaseNotesFile,
): Promise<ShippedReleaseNotes[]> {
	const v = parseVersion(version);
	if (!v) throw new Error(`not a version: ${version}`);
	const rc = v.rc !== undefined;
	const release = formatVersion({ ...v, rc: undefined });
	if (given && (rc || given.version !== release)) {
		throw new Error(
			`notes for ${given.version} given to a build of ${version}: only that release takes them`,
		);
	}
	const files = await notesFilesAt(io, "HEAD", dir);
	const tags = new Set(await remoteTags(io, dir));
	const own = given ?? files.get(release) ?? null;
	if (!rc && !own) {
		throw new Error(
			`no ${notesPath(release)}: a release ships its notes (pnpm release promote sends them)`,
		);
	}
	const entries: ShippedReleaseNotes[] = [];
	const top: ShippedReleaseNotes = {
		version: release,
		// Undated in its own build: its date is the day it is published,
		// which release-finish writes into its notes file (and the
		// changelog) after the owner approves; later builds ship that.
		date: null,
		notes: own?.notes ?? [],
	};
	if (rc) {
		const range = await releaseRange(io, release, "HEAD", dir);
		top.uncovered = coverage(range, own, files, release).uncoveredPrs;
	}
	entries.push(top);
	const older = [...files.values()]
		.filter(
			(f) =>
				compareReleaseVersions(f.version, release) < 0 &&
				tags.has(tagOf(parseVersion(f.version) ?? v)),
		)
		.sort((a, b) => compareReleaseVersions(b.version, a.version));
	for (const f of older) {
		let date = f.date;
		if (date === null) {
			const r = await io.run(
				"git",
				["log", "-1", "--format=%cs", `refs/tags/v${f.version}`],
				{ cwd: dir },
			);
			date = /^\d{4}-\d{2}-\d{2}$/.test(r.stdout.trim())
				? r.stdout.trim()
				: null;
		}
		entries.push({ version: f.version, date, notes: f.notes });
	}
	return entries;
}

/**
 * package.json's text with `crbReleaseNotes` set (re-serialized with
 * tabs), and for a release `crbReleaseNotesFile`: its own notes file
 * whole (notes and none), which release-finish commits from the published
 * package (CAR-242).
 */
export function withReleaseNotes(
	packageJson: string,
	notes: ShippedReleaseNotes[],
	file?: ReleaseNotesFile,
): string {
	const pkg = JSON.parse(packageJson) as Record<string, unknown>;
	pkg.crbReleaseNotes = notes;
	if (file) pkg.crbReleaseNotesFile = file;
	return `${JSON.stringify(pkg, null, "\t")}\n`;
}

// ---------------------------------------------------------------------------
// docs/changelog.md and the GitHub release, from the notes file.

const KIND_HEADINGS: Record<NoteKind, string> = {
	new: "New",
	improved: "Improved",
	fixed: "Fixed",
};

/**
 * Markdown-safe text for the changelog and the GitHub release: no HTML
 * (`<` and `>` as entities, so a title can't close the details block or
 * add a tag) and no @mention (it would notify someone).
 */
export function mdText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/@(?=[\w-])/g, "@\u200b");
}

/**
 * A note's text for GitHub markdown: the prose as `mdText` makes it, the
 * `code` spans as they are (markdown shows them verbatim, entities and
 * all). The notes are checked against these already (noteTextProblems);
 * this holds even for a file edited by hand. Not `escapeTags`: it keeps
 * the tags GitHub keeps (`<details>`, `<a>`, ...), to preserve what a
 * reviewer typed; here nothing of the kind is wanted.
 */
function mdNoteText(text: string): string {
	const parts = text.split("`");
	if (parts.length % 2 === 0) return mdText(text);
	return parts.map((p, i) => (i % 2 === 1 ? p : mdText(p))).join("`");
}

/** A version's changelog body (no heading): its notes by kind, then every PR. */
export function renderNotesBody(
	file: ReleaseNotesFile | null,
	range: ReleaseRange,
): string {
	const parts: string[] = [];
	const notes = sortNotes(file?.notes ?? []);
	if (notes.length === 0) parts.push("No user-facing changes.");
	for (const kind of NOTE_KINDS) {
		const of = notes.filter((n) => n.kind === kind);
		if (of.length === 0) continue;
		parts.push(
			[
				`### ${KIND_HEADINGS[kind]}`,
				"",
				...of.map(
					(n) =>
						`- ${mdNoteText(n.text)} (${[n.id, ...n.prs.map((p) => `#${p}`)].filter((x, i, a) => a.indexOf(x) === i).join(", ")})`,
				),
			].join("\n"),
		);
	}
	const prs = range.prs.filter((p) => !p.exempt);
	if (prs.length > 0) {
		parts.push(
			[
				`<details><summary>Every PR (${prs.length})</summary>`,
				"",
				...prs.map((p) => `- ${mdText(p.title)} (#${p.number})`),
				"</details>",
			].join("\n"),
		);
	}
	return parts.join("\n\n");
}

/** docs/changelog.md with `section` (starting `## version (`) on top, replacing that version's older one. */
export function withChangelogSection(
	existing: string | null,
	version: string,
	section: string,
): string {
	const sections = (existing ?? "")
		.replace(/^# Changelog\s*/, "")
		.split(/^(?=## )/m)
		.map((s) => s.trim())
		.filter((s) => s !== "" && !s.startsWith(`## ${version} (`));
	return `# Changelog\n\n${[section.trim(), ...sections].join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Linear (where its key is: the owner's machine, and the release-note check's
// one step, read only).

export type Linear = {
	query: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
};

/**
 * The Linear key: $LINEAR_API_KEY, else `linear/api-key` in
 * $XDG_CONFIG_HOME, else in ~/.config (a worktree's .envrc points
 * XDG_CONFIG_HOME at its own dir); `tried` names each place, for the error.
 */
export function linearKey(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): { key: string | null; tried: string[] } {
	const tried = ["$LINEAR_API_KEY"];
	const fromEnv = env.LINEAR_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, tried };
	const dirs = [env.XDG_CONFIG_HOME, join(home, ".config")].filter(
		(d): d is string => !!d,
	);
	for (const dir of [...new Set(dirs)]) {
		const file = join(dir, "linear/api-key");
		tried.push(file);
		if (!existsSync(file)) continue;
		const key = readFileSync(file, "utf8").trim();
		if (key) return { key, tried };
	}
	return { key: null, tried };
}

/** Why there's no Linear client: every place the key was looked for. */
export const noLinearKey = (tried: readonly string[]) =>
	`no Linear key (tried ${tried.join(", ")}): set $LINEAR_API_KEY or put it in ~/.config/linear/api-key (release notes live in Linear)`;

/** A Linear GraphQL client over fetch. */
export function linearClient(
	key: string,
	fetchImpl: typeof fetch = fetch,
	url = "https://api.linear.app/graphql",
): Linear {
	return {
		query: async <T>(query: string, variables?: Record<string, unknown>) => {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: key },
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(30_000),
			});
			const json = (await res.json().catch(() => null)) as {
				data?: T;
				errors?: { message: string }[];
			} | null;
			if (!res.ok || !json || json.errors?.length || !json.data) {
				throw new Error(
					`Linear answered ${res.status}: ${json?.errors?.map((e) => e.message).join("; ") ?? "no data"}`,
				);
			}
			return json.data;
		},
	};
}

type LinearIssue = {
	id: string;
	identifier: string;
	title: string;
	labels: string[];
	comments: LinearComment[];
	/** Attachment URLs (GitHub PRs among them). */
	attachments: string[];
	state: { name: string; type: string };
};

const ISSUE_FIELDS = `id identifier title
	state { name type }
	labels { nodes { name } }
	comments(first: 250) { nodes { body updatedAt } }
	attachments(first: 50) { nodes { url } }`;

type RawIssue = {
	id: string;
	identifier: string;
	title: string;
	state: { name: string; type: string };
	labels: { nodes: { name: string }[] };
	comments: { nodes: LinearComment[] };
	attachments: { nodes: { url: string }[] };
};

const toIssue = (r: RawIssue): LinearIssue => ({
	id: r.id,
	identifier: r.identifier,
	title: r.title,
	state: r.state,
	labels: r.labels.nodes.map((l) => l.name),
	comments: r.comments.nodes,
	attachments: r.attachments.nodes.map((a) => a.url),
});

/** A ticket by its identifier (`CAR-183`); null when Linear has none. */
async function linearIssue(
	linear: Linear,
	identifier: string,
): Promise<LinearIssue | null> {
	try {
		const data = await linear.query<{ issue: RawIssue | null }>(
			`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
			{ id: identifier },
		);
		return data.issue ? toIssue(data.issue) : null;
	} catch (error) {
		if (/not found|entity not found/i.test((error as Error).message))
			return null;
		throw error;
	}
}

/** The team's tickets completed since `since` (ISO), every page. */
async function doneSince(
	linear: Linear,
	since: string,
): Promise<LinearIssue[]> {
	const out: LinearIssue[] = [];
	let after: string | null = null;
	for (let page = 0; page < 20; page++) {
		const data: {
			issues: {
				nodes: RawIssue[];
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
			};
		} = await linear.query(
			`query Done($team: String!, $since: DateTimeOrDuration!, $after: String) {
				issues(first: 50, after: $after, filter: { team: { key: { eq: $team } }, completedAt: { gte: $since } }) {
					nodes { ${ISSUE_FIELDS} }
					pageInfo { hasNextPage endCursor }
				}
			}`,
			{ team: TEAM, since, after },
		);
		out.push(...data.issues.nodes.map(toIssue));
		if (!data.issues.pageInfo.hasNextPage) break;
		after = data.issues.pageInfo.endCursor;
	}
	return out;
}

/** Posts a comment on a ticket (the only Linear write: `pnpm release note`). */
async function postComment(
	linear: Linear,
	issueId: string,
	body: string,
): Promise<string | null> {
	const data = await linear.query<{
		commentCreate: { success: boolean; comment: { url: string } | null };
	}>(
		`mutation Note($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } } }`,
		{ issueId, body },
	);
	if (!data.commentCreate.success)
		throw new Error("Linear didn't take the comment");
	return data.commentCreate.comment?.url ?? null;
}

const noteCommand = (id: string) =>
	`pnpm release note ${id} "<text>" [--kind new|improved|fixed] or pnpm release note ${id} --none "<why>"`;

// ---------------------------------------------------------------------------
// pnpm release note CAR-NNN "<text>" [--kind k] | --none "<why>"

/** `pnpm release note`: validates the note and posts it as a comment on the ticket. */
export async function postNote(
	io: Io,
	linear: Linear,
	id: string,
	note: { text: string; kind?: NoteKind } | { none: string },
): Promise<string> {
	const ticket = /^CAR-[1-9]\d*$/i.test(id) ? id.toUpperCase() : null;
	if (!ticket) {
		throw new Error(
			`not a ticket (CAR-NNN): ${id}. A PR without a ticket says "Release note: …" in its description instead`,
		);
	}
	let line: string;
	if ("none" in note) {
		const problems = noneWhyProblems(note.none);
		if (problems.length > 0)
			throw new Error(`the reason ${problems.join(", ")}`);
		line = `Release note: none (${note.none})`;
	} else {
		const problems = noteTextProblems(note.text);
		if (problems.length > 0) throw new Error(`the note ${problems.join(", ")}`);
		line = "";
	}
	const issue = await linearIssue(linear, ticket);
	if (!issue) throw new Error(`Linear has no ${ticket}`);
	if (!("none" in note)) {
		const kind = note.kind ?? kindFromLabels(issue.labels);
		if (!kind) {
			throw new Error(
				`${ticket}'s labels (${issue.labels.join(", ") || "none"}) don't say new, improved or fixed: give --kind`,
			);
		}
		line = `Release note (${kind}): ${note.text}`;
	}
	const url = await postComment(linear, issue.id, line);
	io.log(`${ticket}: ${line}`);
	if (url) io.log(url);
	await rerunNoteChecks(io, ticket);
	return line;
}

// ---------------------------------------------------------------------------
// pnpm release notes [X.Y.Z] [--pr] | notes check

/** A ticket-less PR's description, from GitHub. */
async function prBody(io: Io, pr: number): Promise<string> {
	return must(io, "gh", [
		"api",
		`repos/${io.repo}/pulls/${pr}`,
		"--jq",
		'.body // ""',
	]);
}

export type Collected = {
	file: ReleaseNotesFile;
	/** What has no decision yet, or a broken one, with how to fix it. */
	missing: string[];
	/** Covered by an older version's file (no newer note). */
	shippedBefore: string[];
	warnings: string[];
};

/**
 * The notes of release `version` from Linear (tickets) and GitHub
 * (ticket-less PRs' descriptions), as release-notes/X.Y.Z.json. Reads
 * only: never writes to Linear.
 */
export async function collectNotes(
	io: Io,
	linear: Linear,
	version: string,
	range: ReleaseRange,
	files: Map<string, ReleaseNotesFile>,
): Promise<Collected> {
	const notes: ReleaseNote[] = [];
	const none: ReleaseNoneEntry[] = [];
	const missing: string[] = [];
	const shippedBefore: string[] = [];
	const warnings: string[] = [];
	const older = [...files.values()].filter(
		(f) => compareReleaseVersions(f.version, version) < 0,
	);
	const inRange = new Map(range.prs.map((p) => [p.number, p]));
	for (const [id, prs] of neededIds(range)) {
		let status: NoteStatus;
		if (id.startsWith("#")) {
			status = prBodyNote(await prBody(io, prs[0] ?? 0));
		} else {
			const issue = await linearIssue(linear, id);
			if (!issue) {
				missing.push(`${id} (${prList(prs)}): Linear has no such ticket`);
				continue;
			}
			status = ticketNote(issue.comments, issue.labels);
			// No note in Linear: its PRs' descriptions may carry one (CAR-211,
			// as the release-note check accepts). Linear's wins when both do.
			if (status.status === "missing") {
				const statuses: NoteStatus[] = [];
				for (const n of prs) {
					statuses.push(
						prBodyNote(await prBody(io, n), { labels: issue.labels }),
					);
				}
				status = descriptionsNote(statuses);
			}
			// Linear's PR attachments, cross-checked against the titles.
			for (const url of issue.attachments) {
				const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(
					url,
				);
				if (!m || m[1]?.toLowerCase() !== io.repo.toLowerCase()) continue;
				const pr = inRange.get(Number(m[2]));
				if (pr && !pr.tickets.includes(id) && !pr.exempt) {
					warnings.push(
						`${id} has #${pr.number} attached in Linear, but its title doesn't name ${id}`,
					);
				}
			}
		}
		const how = id.startsWith("#")
			? `add a "Release note (kind): …" or "Release note: none (why)" line to #${id.slice(1)}'s description`
			: `${noteCommand(id)} (or a "Release note" line in ${prList(prs)}'s description)`;
		if (status.status === "missing") {
			missing.push(`${id} (${prList(prs)}): no Release note: ${how}`);
			continue;
		}
		if (status.status === "invalid") {
			missing.push(
				`${id} (${prList(prs)}): ${status.errors.join("; ")}: ${how}`,
			);
			continue;
		}
		// A ticket an older release shipped shows again only with a newer note.
		const before = older.find((f) =>
			[...f.notes, ...f.none].some((e) => e.id === id),
		);
		if (before) {
			const shipped = new Set(
				before.notes.filter((n) => n.id === id).map((n) => n.text),
			);
			const fresh =
				status.status === "notes"
					? status.notes.filter((n) => !shipped.has(n.text))
					: [];
			if (fresh.length === 0) {
				shippedBefore.push(`${id}: in ${before.version}`);
				continue;
			}
			for (const n of fresh)
				notes.push({ id, kind: n.kind, prs, text: n.text });
			continue;
		}
		if (status.status === "none") none.push({ id, prs, why: status.why });
		else
			for (const n of status.notes)
				notes.push({ id, kind: n.kind, prs, text: n.text });
	}
	for (const s of range.other) {
		warnings.push(`not a PR (no "(#N)"): ${clip(s)}`);
	}
	return {
		file: {
			version,
			date: files.get(version)?.date ?? null,
			notes: sortNotes(notes),
			none: sortNone(none),
		},
		missing,
		shippedBefore,
		warnings,
	};
}

/** master's package.json version at `ref`. */
async function versionAt(io: Io, ref: string): Promise<string> {
	return (
		JSON.parse(await must(io, "git", ["show", `${ref}:package.json`])) as {
			version: string;
		}
	).version;
}

/**
 * `pnpm release notes [X.Y.Z] [--pr]`: writes release-notes/X.Y.Z.json
 * (in `root`, or with `pr` on a `notes/X.Y.Z` branch from origin/master,
 * pushed, with a "notes: X.Y.Z" PR) from Linear and the PRs merged up to
 * origin/master; prints what is still missing. Never writes to Linear.
 */
export async function writeNotes(
	io: Io,
	linear: Linear,
	opts: {
		version?: string;
		pr: boolean;
		root: string;
		worktree: string;
		write: (path: string, text: string) => void;
	},
): Promise<Collected> {
	await must(io, "git", ["fetch", "origin", "master", "--tags"]);
	const version = opts.version ?? (await versionAt(io, "origin/master"));
	const v = parseVersion(version);
	if (!v || v.rc !== undefined)
		throw new Error(`not a release X.Y.Z: ${version}`);
	const range = await releaseRange(io, version, "origin/master");
	const files = await notesFilesAt(io, "origin/master");
	const collected = await collectNotes(io, linear, version, range, files);
	const text = formatNotesFile(collected.file);
	const path = notesPath(version);
	for (const e of collected.file.notes) io.log(`${e.id} ${e.kind}: ${e.text}`);
	for (const e of collected.file.none) io.log(`${e.id} none: ${e.why}`);
	for (const s of collected.shippedBefore) io.log(`${s} (no newer note)`);
	for (const w of collected.warnings) io.log(`warning: ${w}`);
	for (const m of collected.missing) io.log(`missing: ${m}`);
	if (!opts.pr) {
		opts.write(join(opts.root, path), text);
		io.log(`wrote ${path}`);
	} else {
		await notesPr(io, version, path, text, opts);
	}
	if (collected.missing.length > 0) {
		io.log(
			`incomplete: ${collected.missing.length} without a note; promote refuses ${version} until each has one`,
		);
	}
	return collected;
}

/** The "notes: X.Y.Z" PR: a `notes/X.Y.Z` branch from origin/master with the file. */
async function notesPr(
	io: Io,
	version: string,
	path: string,
	text: string,
	opts: { worktree: string; write: (path: string, text: string) => void },
): Promise<void> {
	const branch = `notes/${version}`;
	const remote = (
		await must(io, "git", ["ls-remote", "--heads", "origin", branch])
	).split(/\s/)[0];
	await must(io, "git", [
		"worktree",
		"add",
		"--detach",
		opts.worktree,
		"origin/master",
	]);
	try {
		opts.write(join(opts.worktree, path), text);
		const diff = await io.run("git", ["status", "--porcelain", "--", path], {
			cwd: opts.worktree,
		});
		if (diff.stdout.trim() === "") {
			io.log(`${path} on origin/master is already this: no PR`);
			return;
		}
		await must(io, "git", ["add", "--", path], { cwd: opts.worktree });
		await must(
			io,
			"git",
			[
				"commit",
				"-m",
				`notes: ${version}`,
				"-m",
				`${version}'s release notes from Linear (pnpm release notes ${version} --pr). Merging this approves their wording.`,
				"--",
				path,
			],
			{ cwd: opts.worktree },
		);
		// Our own branch, written again from Linear: replaced, with a lease
		// on what origin had (or on it not existing).
		await must(
			io,
			"git",
			[
				"push",
				`--force-with-lease=refs/heads/${branch}:${remote || ""}`,
				"origin",
				`HEAD:refs/heads/${branch}`,
			],
			{ cwd: opts.worktree },
		);
	} finally {
		await io.run("git", ["worktree", "remove", "--force", opts.worktree]);
	}
	const open = (
		await must(io, "gh", [
			"pr",
			"list",
			"--repo",
			io.repo,
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"url",
			"--jq",
			'.[0].url // ""',
		])
	).trim();
	if (open) {
		io.log(`updated ${open}`);
		return;
	}
	const url = (
		await must(io, "gh", [
			"pr",
			"create",
			"--repo",
			io.repo,
			"--base",
			"master",
			"--head",
			branch,
			"--title",
			`notes: ${version}`,
			"--body",
			`${version}'s release notes, from each ticket's Release note in Linear. Merging this approves their wording; a change goes back to Linear (pnpm release note) and this is written again (pnpm release notes ${version} --pr).`,
		])
	).trim();
	io.log(url);
}

/** This repository's PR numbers among a ticket's Linear attachments. */
function attachedPrs(io: Io, issue: LinearIssue): number[] {
	const out: number[] = [];
	for (const url of issue.attachments) {
		const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
		if (m && m[1]?.toLowerCase() === io.repo.toLowerCase()) {
			const n = Number(m[2]);
			if (!out.includes(n)) out.push(n);
		}
	}
	return out;
}

/** A ticket's note from its attached PRs' descriptions (missing when it has none). */
async function attachedPrsNote(
	io: Io,
	issue: LinearIssue,
): Promise<NoteStatus> {
	const statuses: NoteStatus[] = [];
	for (const n of attachedPrs(io, issue)) {
		statuses.push(prBodyNote(await prBody(io, n), { labels: issue.labels }));
	}
	return descriptionsNote(statuses);
}

/**
 * `pnpm release notes check`: what has no note yet: the release so far
 * (up to origin/master), which fails it, and the tickets done in the last
 * 30 days outside that range, which only warn (most predate the rule).
 * For merges no script saw (the owner's, in GitHub's UI).
 */
export async function auditNotes(io: Io, linear: Linear): Promise<string[]> {
	await must(io, "git", ["fetch", "origin", "master", "--tags"]);
	const version = await versionAt(io, "origin/master");
	const range = await releaseRange(io, version, "origin/master");
	const files = await notesFilesAt(io, "origin/master");
	const { missing } = await collectNotes(io, linear, version, range, files);
	const problems = missing.map((m) => `${version}: ${m}`);
	const warnings: string[] = [];
	const since = new Date(io.now().getTime() - 30 * 86_400_000).toISOString();
	const seen = new Set(neededIds(range).keys());
	for (const issue of await doneSince(linear, since)) {
		if (seen.has(issue.identifier)) continue;
		let s = ticketNote(issue.comments, issue.labels);
		if (s.status === "missing") {
			// Its PRs' descriptions (Linear's PR attachments), as collectNotes
			// and the release-note check take them (CAR-211).
			s = await attachedPrsNote(io, issue);
		}
		if (s.status === "missing") {
			warnings.push(
				`warning: done: ${issue.identifier} ${clip(issue.title)}: no Release note: ${noteCommand(issue.identifier)}`,
			);
		} else if (s.status === "invalid") {
			warnings.push(
				`warning: done: ${issue.identifier}: ${s.errors.join("; ")}`,
			);
		}
	}
	for (const w of warnings) io.log(w);
	for (const p of problems) io.log(p);
	if (problems.length > 0) {
		throw new Error(`${problems.length} without a release note`);
	}
	io.log(`ok: every ticket and PR of ${version} so far has a release note`);
	return problems;
}

// ---------------------------------------------------------------------------
// merge-ok's note check (CAR-192, D2: the gate is at merge).

/** A PR as GitHub's REST API answers it (the fields used here). */
export type PullForNotes = {
	number: number;
	title: string;
	body?: string | null;
	head?: { ref?: string };
	/** GitHub's: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, … */
	author_association?: string;
};

/** Whose PRs may have Linear read for them (the rest: description notes only). */
const LINEAR_AUTHORS = ["OWNER", "MEMBER", "COLLABORATOR"];

/** At most this many tickets read from Linear for one PR. */
const MAX_PR_TICKETS = 5;

/**
 * Refuses (throws) a PR whose tickets have no Release note in Linear nor
 * in its description (the ticket's wins when both have one), a ticket-less
 * PR without a `Release note:` line in its description, a `car-NNN-*`
 * branch whose title names no ticket, a description whose `Fixes`/`Part
 * of` tickets differ from the title's, and, with no Linear key, a ticket
 * PR whose description has no note. A failed Linear read throws, never
 * passes. Returns what it found, for the log. merge-ok and GitHub's
 * release-note check (CAR-211) both judge with it.
 */
export async function prNotesOk(
	pull: PullForNotes,
	linear: () => { linear: Linear | null; tried: string[] },
	files: () => Promise<string[]>,
): Promise<string> {
	const title = pull.title ?? "";
	const branch = pull.head?.ref ?? "";
	// A release PR: its title, its own branch (next/X.Y.Z, notes/X.Y.Z), and
	// only release files changed.
	const kind = /^(next|notes): (\d+\.\d+\.\d+)$/.exec(title.trim());
	if (
		kind &&
		isExemptTitle(title) &&
		branch === `${kind[1]}/${kind[2]}` &&
		releasePrFiles(await files())
	) {
		return `#${pull.number} is "${title}": no note needed`;
	}
	const tickets = titleTickets(title);
	if (tickets.length === 0 && /^car-\d+/i.test(branch)) {
		throw new Error(
			`#${pull.number}'s branch ${clip(branch)} is a ticket's, but its title names none: add (CAR-NNN) to the title`,
		);
	}
	const body = pull.body ?? "";
	const linked = [
		...new Set(
			[
				...body.matchAll(
					/\b(?:fixes|part of|closes|resolves)\s+(CAR-[1-9]\d*)\b/gi,
				),
			].map((m) => (m[1] ?? "").toUpperCase()),
		),
	];
	if (linked.length > 0) {
		const notInTitle = linked.filter((t) => !tickets.includes(t));
		const notInBody = tickets.filter((t) => !linked.includes(t));
		if (notInTitle.length > 0 || notInBody.length > 0) {
			throw new Error(
				`#${pull.number}'s title names ${tickets.join(", ") || "no ticket"} but its description links ${linked.join(", ")}: make them agree (the title is what release notes read)`,
			);
		}
	}
	if (tickets.length === 0) {
		const s = prBodyNote(body);
		if (s.status === "missing") {
			throw new Error(
				`#${pull.number} has no ticket and no "Release note (new|improved|fixed): …" or "Release note: none (why)" line in its description`,
			);
		}
		if (s.status === "invalid") {
			throw new Error(`#${pull.number}'s Release note: ${s.errors.join("; ")}`);
		}
		return `#${pull.number}: ${s.status === "none" ? `no note (${s.why})` : `${s.notes.length} note(s)`} in its description`;
	}
	// A ticket PR: each ticket's note in Linear, else the description's
	// (CAR-211: "either through the PR description or through the ticket").
	const own = (ticket: { labels: readonly string[] } | "unread") =>
		prBodyNote(body, ticket);
	if (tickets.length > MAX_PR_TICKETS) {
		throw new Error(
			`#${pull.number}'s title names ${tickets.length} tickets: at most ${MAX_PR_TICKETS} (split the PR, or name fewer)`,
		);
	}
	// Linear is read only for the repository's own people's PRs: anyone
	// else's (a fork's) can't make the key look up tickets for the public
	// log, or spend Linear's rate limit with edits. The association is the
	// one GitHub reports for the PR (gh api), never the event's.
	const trusted = LINEAR_AUTHORS.includes(pull.author_association ?? "");
	const { linear: client, tried } = trusted
		? linear()
		: { linear: null, tried: [] };
	if (!client) {
		const why = trusted
			? `no Linear key here: ${tickets.join(", ")}'s notes unread`
			: `its author isn't the repository's (${clip(pull.author_association ?? "unknown")}): Linear isn't read for it`;
		const s = own("unread");
		if (s.status === "notes" || s.status === "none") {
			return `#${pull.number}: ${decided(s)} in its description (${why})`;
		}
		const fix = `add a "Release note (new|improved|fixed): …" or "Release note: none (why)" line to the PR's description`;
		throw new Error(
			s.status === "invalid"
				? `#${pull.number}'s Release note: ${s.errors.join("; ")}`
				: trusted
					? `${noLinearKey(tried)}; so ${tickets.join(", ")}'s Release note can't be read here: ${fix}`
					: `#${pull.number}: ${why}, so ${tickets.join(", ")}'s Release note there doesn't count: ${fix}`,
		);
	}
	const problems: string[] = [];
	const found: string[] = [];
	for (const id of tickets) {
		let issue: LinearIssue | null;
		try {
			issue = await linearIssue(client, id);
		} catch (error) {
			// Never a pass on a failed read.
			throw new Error(
				`couldn't read ${id} from Linear (${clip((error as Error).message)}): try again`,
			);
		}
		if (!issue) {
			problems.push(`${id}: Linear has no such ticket`);
			continue;
		}
		const t = ticketNote(issue.comments, issue.labels);
		if (t.status === "invalid") {
			problems.push(`${id}'s Release note: ${t.errors.join("; ")}`);
			continue;
		}
		if (t.status !== "missing") {
			found.push(`${id}: ${decided(t)}`);
			continue;
		}
		const d = own({ labels: issue.labels });
		if (d.status === "invalid") {
			problems.push(
				`${id} has no Release note, and the description's is broken: ${d.errors.join("; ")}`,
			);
		} else if (d.status === "missing") {
			problems.push(
				`${id} has no Release note: ${noteCommand(id)}, or a "Release note" line in the PR's description`,
			);
		} else found.push(`${id}: ${decided(d)} in the PR's description`);
	}
	if (problems.length > 0) {
		throw new Error(
			`#${pull.number} can't merge without its release notes: ${problems.join("; ")}`,
		);
	}
	return found.join(", ");
}

/** A decision, for the log. */
const decided = (s: NoteStatus) =>
	s.status === "none"
		? `no note (${s.why})`
		: s.status === "notes"
			? `${s.notes.length} note(s)`
			: s.status;

// ---------------------------------------------------------------------------
// The release-note check on GitHub (CAR-211): `.github/workflows/release-note.yml`
// runs prNotesOk (release.ts ci:pr-note). A note posted in Linear after it
// ran turns it green only on a rerun: `pnpm release note` and merge-ok do it.

/** The check (job) and workflow names of release-note.yml. */
export const NOTE_CHECK = "release-note";
export const NOTE_WORKFLOW_NAME = "Release note";

/** Text for a workflow command (`::error::…`): one line, as GitHub escapes it. */
export const workflowText = (s: string) =>
	s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const notListed = (pr: number) =>
	`warning: #${pr}'s checks have no "${NOTE_CHECK}" of workflow "${NOTE_WORKFLOW_NAME}" (not reported yet, or renamed in release-note.yml?): rerun it by hand if it's red`;

type NoteRun = {
	databaseId: number;
	/** gh's bucket: pass, fail, pending, skipping or cancel. */
	bucket: string;
	url: string;
};

/**
 * A PR's release-note check, from the PR's own checks (a
 * pull_request_target run's branch is master, so a run list by branch
 * can't find it); null when it has none yet.
 */
async function noteCheckRun(
	io: Io,
	pr: number,
): Promise<NoteRun | "no checks" | "not listed"> {
	const r = await io.run("gh", [
		"pr",
		"checks",
		String(pr),
		"--repo",
		io.repo,
		"--json",
		"name,workflow,bucket,link",
	]);
	// gh exits 1 when a check failed and 8 while one is pending: the JSON
	// is the answer either way.
	if (r.stdout.trim() === "" && /no checks reported/i.test(r.stderr)) {
		return "no checks";
	}
	let checks: {
		name: string;
		workflow: string;
		bucket: string;
		link: string;
	}[];
	try {
		if (![0, 1, 8].includes(r.code)) throw new Error();
		checks = JSON.parse(r.stdout);
	} catch {
		throw new Error(
			`gh pr checks ${pr} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
		);
	}
	const check = checks.find(
		(c) => c.name === NOTE_CHECK && c.workflow === NOTE_WORKFLOW_NAME,
	);
	const id = /\/actions\/runs\/(\d+)/.exec(check?.link ?? "")?.[1];
	// Other checks, but not this one: a renamed job or workflow (NOTE_CHECK,
	// NOTE_WORKFLOW_NAME), or a run not reported yet.
	if (!check || !id) return "not listed";
	return { databaseId: Number(id), bucket: check.bucket, url: check.link };
}

/**
 * After `pnpm release note CAR-N`: reruns the newest release-note run of
 * every open PR to master whose title names CAR-N, so the check reads the
 * new note. Never throws: a failure only warns (the note is posted).
 */
export async function rerunNoteChecks(io: Io, ticket: string): Promise<void> {
	let pulls: { number: number; title: string }[];
	try {
		pulls = JSON.parse(
			await must(io, "gh", [
				"pr",
				"list",
				"--repo",
				io.repo,
				"--base",
				"master",
				"--state",
				"open",
				"--limit",
				"200",
				"--json",
				"number,title",
			]),
		);
	} catch (error) {
		io.log(
			`warning: couldn't list open PRs to rerun their release-note check: ${clip((error as Error).message)}`,
		);
		return;
	}
	for (const p of pulls.filter((p) => titleTickets(p.title).includes(ticket))) {
		try {
			const run = await noteCheckRun(io, p.number);
			if (run === "no checks") {
				io.log(
					`#${p.number}: no release-note run yet: it reads the note when it runs`,
				);
			} else if (run === "not listed") {
				io.log(notListed(p.number));
			} else if (run.bucket === "pending") {
				io.log(
					`#${p.number}: its release-note check is running (it may have read Linear before the note): if it ends red, gh run rerun ${run.databaseId}`,
				);
			} else {
				await must(io, "gh", [
					"run",
					"rerun",
					String(run.databaseId),
					"--repo",
					io.repo,
				]);
				io.log(
					`#${p.number}: reran its release-note check (run ${run.databaseId}, ${run.url})`,
				);
			}
		} catch (error) {
			io.log(
				`warning: couldn't rerun #${p.number}'s release-note check: ${clip((error as Error).message)}: rerun it by hand (Re-run jobs)`,
			);
		}
	}
}

/**
 * merge-ok's note step: prNotesOk, then (only once it passed) the rerun of
 * a red release-note check. Throws what prNotesOk throws, rerunning nothing.
 */
export async function mergeOkNotes(
	io: Io,
	pull: PullForNotes,
	linear: () => { linear: Linear | null; tried: string[] },
	files: () => Promise<string[]>,
): Promise<string> {
	const found = await prNotesOk(pull, linear, files);
	await rerunRedNoteCheck(io, pull);
	return found;
}

/**
 * merge-ok, once its own note check passed: reruns the PR's release-note
 * check when its newest run is red (it ran before the note), and says to
 * wait for it. Never throws.
 */
export async function rerunRedNoteCheck(
	io: Io,
	pull: PullForNotes,
): Promise<void> {
	try {
		const run = await noteCheckRun(io, pull.number);
		if (run === "not listed") {
			io.log(notListed(pull.number));
			return;
		}
		if (run === "no checks") return;
		if (run.bucket !== "fail" && run.bucket !== "cancel") return;
		await must(io, "gh", [
			"run",
			"rerun",
			String(run.databaseId),
			"--repo",
			io.repo,
		]);
		io.log(
			`#${pull.number}'s release-note check was red (it ran before the note): reran it (run ${run.databaseId}, ${run.url}); wait for it to turn green before merging`,
		);
	} catch (error) {
		io.log(
			`warning: couldn't check #${pull.number}'s release-note check: ${clip((error as Error).message)}`,
		);
	}
}

/**
 * Before promote dispatches (CAR-242): the release's notes for exactly the
 * RC's range (the previous release's tag up to the RC's commit), from
 * Linear and the PR descriptions, refused (throws, listing what lacks a
 * note and how to fix it) unless they cover it. Returns them encoded for
 * the run's `notes` input. Without a Linear key it can't collect them: it
 * checks release-notes/X.Y.Z.json at the RC covers the release instead
 * and returns "" (the run then takes that file).
 */
export async function promoteNotes(
	io: Io,
	release: string,
	tag: string,
	found: { linear: Linear | null; tried: readonly string[] },
): Promise<string> {
	await must(io, "git", ["fetch", "origin", "master", "--tags"]);
	const sha = (
		await must(io, "git", ["rev-parse", `refs/tags/${tag}^{commit}`])
	).trim();
	const path = notesPath(release);
	const { linear } = found;
	if (!linear) {
		io.log(
			`warning: ${noLinearKey(found.tried)}: promote can't collect ${release}'s notes, so the run takes ${path} at ${tag}`,
		);
		io.log(await notesCheck(io, release, sha));
		return "";
	}
	const range = await releaseRange(io, release, sha);
	const files = await notesFilesAt(io, sha);
	const collected = await collectNotes(io, linear, release, range, files);
	for (const w of collected.warnings) io.log(`warning: ${w}`);
	if (collected.missing.length > 0) {
		throw new Error(
			`${tag} can't be promoted: ${collected.missing.length} without a release note:\n${collected.missing.map((m) => `  ${m}`).join("\n")}`,
		);
	}
	// What the run will check: the notes over any file at the RC's commit.
	const merged = mergeNotes(collected.file, files.get(release) ?? null);
	const { missing } = coverage(range, merged.file, files, release);
	if (missing.length > 0) {
		throw new Error(
			`${tag} can't be promoted: the notes don't cover ${missing.map((m) => `${m.id} (${prList(m.prs)})`).join(", ")}`,
		);
	}
	for (const e of collected.file.notes) io.log(`${e.id} ${e.kind}: ${e.text}`);
	for (const e of collected.file.none) io.log(`${e.id} none: ${e.why}`);
	for (const s of collected.shippedBefore) io.log(`${s} (no newer note)`);
	if (merged.replaced.length > 0) {
		io.log(
			`Linear's notes replace ${path}'s at ${tag} for ${merged.replaced.join(", ")}`,
		);
	}
	if (merged.kept.length > 0) {
		io.log(`kept from ${path} at ${tag}: ${merged.kept.join(", ")}`);
	}
	const encoded = encodeNotesInput(collected.file);
	io.log(
		`${release}'s notes up to ${tag}: ${collected.file.notes.length} notes, ${collected.file.none.length} none (sent to the run)`,
	);
	return encoded;
}
