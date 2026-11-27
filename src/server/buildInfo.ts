import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Reading the build (no side effects at import): version.ts reads it at
 * load for crb itself; the tracer only when tracing is on, so a unit test
 * file with tracing off spawns no git for it.
 */

/** What a build of carbonless is: package.json's version and the commit built. */
export interface BuildInfo {
	version: string;
	/** Full SHA; "-dirty" appended when the tree had changes at build time. */
	commit: string;
}

/**
 * This build: dist/build-info.json (scripts/build-info.mjs, so an installed
 * tarball needs no .git); run from source (tsx, Vitest), package.json's
 * version and the checkout's HEAD.
 */
export function readBuild(): BuildInfo {
	// Paths, not URLs: under jsdom (web unit tests, which load the tracer
	// through test/setup.ts) the global URL is jsdom's, which fs refuses.
	const here = dirname(fileURLToPath(import.meta.url));
	try {
		const info = JSON.parse(
			readFileSync(join(here, "../build-info.json"), "utf8"),
		) as BuildInfo;
		if (typeof info.version === "string" && typeof info.commit === "string") {
			return { version: info.version, commit: info.commit };
		}
	} catch {
		// Not a build: from source.
	}
	const root = join(here, "../..");
	const { version } = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	) as { version: string };
	let commit = "unknown";
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// No git: "unknown", the same on both sides of a source run.
	}
	return { version, commit };
}
