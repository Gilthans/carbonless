import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
): Run {
	const runs = existsSync(root)
		? readdirSync(root)
				.filter((d) => statSync(join(root, d)).isDirectory())
				.sort()
		: [];
	const at = (d: string): Run => ({
		dir: join(root, d),
		name: d,
		cwd: runCwd(join(root, d)),
	});
	if (runs.includes(name)) return at(name);
	const match = runs
		.filter((d) => name === "latest" || d.includes(name))
		.map(at)
		.filter((r) => traceFiles(r.dir).length > 0);
	const found = match.filter((r) => r.cwd === cwd).at(-1) ?? match.at(-1);
	if (!found) throw new Error(`no test traces match "${name}" in ${root}`);
	return found;
}
