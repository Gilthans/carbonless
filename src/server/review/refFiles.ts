import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/*
 * A ref's tip read off git's own files (CAR-320): a loose ref file, else
 * its line in packed-refs, as git's default ("files") ref backend keeps
 * them (gitrepository-layout). RefStore reads its refs' tips many times a
 * page, and a `git rev-parse` each costs ~90 ms to start on Windows; a
 * file read costs nothing like it.
 *
 * Read in git's own order (the loose file, then packed-refs), which every
 * ref update keeps consistent: git writes both by lock and rename, packs
 * a ref before pruning its loose file, and drops a deleted ref from
 * packed-refs before unlinking it. Whatever it can't be sure of (a
 * reftable repository, a symbolic ref, a git directory it can't find, an
 * unreadable file, contents it doesn't recognize) answers undefined: the
 * caller asks git.
 */

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A crb ref name this reads (RefStore checks it too): never a path out of refs/crb. */
const CRB_REF =
	/^refs\/crb\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Each repo's git directory with a files backend, or null (ask git). */
const gitDirs = new Map<string, Promise<string | null>>();

const isDir = (path: string) =>
	stat(path).then(
		(s) => s.isDirectory(),
		() => false,
	);

async function findGitDir(repo: string): Promise<string | null> {
	// A bare repository (crb's clones), else a work tree's own `.git` directory.
	for (const dir of [repo, join(repo, ".git")]) {
		const [refs, objects] = await Promise.all([
			isDir(join(dir, "refs")),
			isDir(join(dir, "objects")),
		]);
		if (!refs || !objects) continue;
		// The reftable backend keeps refs elsewhere.
		if (await isDir(join(dir, "reftable"))) return null;
		return dir;
	}
	return null;
}

function gitDirOf(repo: string): Promise<string | null> {
	let known = gitDirs.get(repo);
	if (!known) {
		known = findGitDir(repo);
		gitDirs.set(repo, known);
	}
	return known;
}

const missing = (error: unknown) => {
	const code = (error as NodeJS.ErrnoException)?.code;
	return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR";
};

/**
 * The tip of full ref name `ref` (already checked: `refs/crb/...`, plain
 * characters) from git's files: its OID, null when the ref doesn't exist,
 * undefined when only git can tell.
 */
export async function tipFromFiles(
	repo: string,
	ref: string,
): Promise<string | null | undefined> {
	if (!CRB_REF.test(ref) || ref.includes("..")) return undefined;
	try {
		const dir = await gitDirOf(repo);
		if (!dir) return undefined;
		const root = resolve(dir, "refs", "crb");
		const file = resolve(dir, ref);
		if (!file.startsWith(root + sep)) return undefined;
		try {
			const loose = (await readFile(file, "utf8")).trim();
			return OID.test(loose) ? loose : undefined;
		} catch (error) {
			if (!missing(error)) return undefined;
		}
		let packed: string;
		try {
			packed = await readFile(join(dir, "packed-refs"), "utf8");
		} catch (error) {
			return missing(error) ? null : undefined;
		}
		for (const line of packed.split("\n")) {
			if (line.startsWith("#") || line.startsWith("^")) continue;
			const space = line.indexOf(" ");
			if (space < 0) continue;
			if (line.slice(space + 1).trimEnd() !== ref) continue;
			const oid = line.slice(0, space);
			return OID.test(oid) ? oid : undefined;
		}
		return null;
	} catch {
		return undefined;
	}
}
