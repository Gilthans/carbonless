import type { FileStatus, FileSummary } from "../../shared/types.js";
import { GitError, runGit } from "../git.js";

export const DIFF_ARGS = [
	"-c",
	"core.quotePath=false",
	// Zero context unless a call asks for more: git's change counts can
	// depend on the context size (blank lines may align differently), so
	// --numstat must count with the same zero context as the -U0 patch the
	// clusters come from.
	"-c",
	"diff.context=0",
	"-c",
	"diff.renames=true",
	"diff",
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--diff-algorithm=myers",
	"-M",
	"--ignore-submodules=none",
	"--inter-hunk-context=0",
	"--indent-heuristic",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

export type ChangedFile = Omit<FileSummary, "index" | "clusters"> & {
	oldOid: string;
	newOid: string;
};

const ZERO_MODE = "000000";
const SUBMODULE_MODE = "160000";

const STATUS: Record<string, FileStatus> = {
	A: "added",
	D: "deleted",
	M: "modified",
	R: "renamed",
	T: "type-changed",
};

interface RawEntry {
	oldMode: string;
	newMode: string;
	oldOid: string;
	newOid: string;
	status: FileStatus;
	path: string;
	oldPath?: string;
}

function parseRaw(output: string): RawEntry[] {
	const tokens = output.split("\0");
	const entries: RawEntry[] = [];
	let i = 0;
	while (i < tokens.length && tokens[i]?.startsWith(":")) {
		const [oldMode, newMode, oldOid, newOid, code] = (tokens[i++] as string)
			.slice(1)
			.split(" ");
		const status = STATUS[code?.[0] ?? ""];
		if (!oldMode || !newMode || !oldOid || !newOid || !status) {
			throw new GitError(`Unexpected git diff --raw record: ${tokens[i - 1]}`);
		}
		const first = tokens[i++] as string;
		const entry: RawEntry = {
			oldMode,
			newMode,
			oldOid,
			newOid,
			status,
			path: first,
		};
		if (status === "renamed") {
			entry.oldPath = first;
			entry.path = tokens[i++] as string;
		}
		entries.push(entry);
	}
	return entries;
}

interface NumstatEntry {
	additions: number;
	deletions: number;
	binary: boolean;
}

function parseNumstat(output: string): NumstatEntry[] {
	const tokens = output.split("\0");
	const entries: NumstatEntry[] = [];
	let i = 0;
	while (i < tokens.length && tokens[i] !== "") {
		const token = tokens[i++] as string;
		const match = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(token);
		if (!match)
			throw new GitError(`Unexpected git diff --numstat record: ${token}`);
		const [, add, del, rest] = match;
		if (rest === "") i += 2; // rename: old and new path follow
		const binary = add === "-" && del === "-";
		entries.push({
			additions: binary ? 0 : Number(add),
			deletions: binary ? 0 : Number(del),
			binary,
		});
	}
	return entries;
}

/**
 * The files changed between `base` and `head` (commits or trees), in raw
 * diff order; `paths` limits the diff to those paths (a pathspec after
 * `--`: renames are detected among them only).
 */
export async function listChangedFiles(
	repo: string,
	base: string,
	head: string,
	paths: string[] = [],
): Promise<ChangedFile[]> {
	const [raw, numstat] = await Promise.all([
		runGit(repo, [
			...DIFF_ARGS,
			"--raw",
			"-z",
			"--no-abbrev",
			base,
			head,
			"--",
			...paths,
		]),
		runGit(repo, [...DIFF_ARGS, "--numstat", "-z", base, head, "--", ...paths]),
	]);
	const rawEntries = parseRaw(raw);
	const stats = parseNumstat(numstat);
	if (rawEntries.length !== stats.length) {
		throw new GitError("git diff --raw and --numstat disagree on file count");
	}
	return rawEntries.map((entry, i) => {
		const stat = stats[i] as NumstatEntry;
		const file: ChangedFile = {
			path: entry.path,
			status: entry.status,
			binary: stat.binary,
			submodule:
				entry.oldMode === SUBMODULE_MODE || entry.newMode === SUBMODULE_MODE,
			additions: stat.additions,
			deletions: stat.deletions,
			oldOid: entry.oldOid,
			newOid: entry.newOid,
		};
		if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
		if (entry.oldMode !== ZERO_MODE) file.oldMode = entry.oldMode;
		if (entry.newMode !== ZERO_MODE) file.newMode = entry.newMode;
		return file;
	});
}
