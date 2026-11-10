import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { traceFiles } from "./load";

export interface Run {
	dir: string;
	name: string;
	/** The tree it ran in (run.json), when known. */
	cwd: string | null;
}

function runCwd(dir: string): string | null {
	try {
		const cwd = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).cwd;
		return typeof cwd === "string" ? cwd : null;
	} catch {
		return null;
	}
}

/**
 * The run `name` means: an exact directory name, or else the newest run
 * whose name contains it ("latest": any), preferring runs of the tree
 * `cwd` and skipping runs with no traces (a `playwright test --list`).
 */
export function findRun(
	root: string,
	name = "latest",
	cwd = process.cwd(),
	/** Tests: runs between listing the runs and looking at each. */
	afterList: () => void = () => {},
): Run {
	// A run pruned (by another run starting) between the listing and a
	// look at it is skipped.
	const isDir = (d: string) => {
		try {
			return statSync(join(root, d)).isDirectory();
		} catch {
			return false;
		}
	};
	const hasTraces = (r: Run) => {
		try {
			return traceFiles(r.dir).length > 0;
		} catch {
			return false;
		}
	};
	const listed = existsSync(root) ? readdirSync(root) : [];
	afterList();
	const runs = listed.filter(isDir).sort();
	const at = (d: string): Run => ({
		dir: join(root, d),
		name: d,
		cwd: runCwd(join(root, d)),
	});
	if (runs.includes(name)) return at(name);
	const match = runs
		.filter((d) => name === "latest" || d.includes(name))
		.map(at)
		.filter(hasTraces);
	const found = match.filter((r) => r.cwd === cwd).at(-1) ?? match.at(-1);
	if (!found) throw new Error(`no test traces match "${name}" in ${root}`);
	return found;
}

/**
 * A run named on the command line: a path (a downloaded CI artifact: a run
 * directory, or a directory of runs, whose newest run matching nothing
 * else is taken) or a name under `root` (findRun).
 */
export function resolveRun(
	root: string,
	arg: string | undefined,
	cwd = process.cwd(),
): Run {
	if (arg && (arg.includes("/") || arg.startsWith(".")) && existsSync(arg)) {
		const dir = resolve(arg);
		const isRun =
			existsSync(join(dir, "run.json")) || traceFiles(dir).length > 0;
		if (isRun) return { dir, name: basename(dir), cwd: runCwd(dir) };
		return findRun(dir, "latest", cwd);
	}
	return findRun(root, arg, cwd);
}
