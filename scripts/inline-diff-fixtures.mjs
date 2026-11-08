#!/usr/bin/env node
// Rebuilds test/fixtures/inline-diff from a clone of
// Gilthans/carbonless-gallery (our playground, not a real PR's data): every
// file that differs between `base/inline-diff` and `case/inline-diff`, as
// `base/<path>` and `case/<path>` byte for byte (CRLF kept), and GitHub's
// observed marks of PR #14 (`github-marks.json`, measured signed in; the
// recon's capture). `known-differences.json` is the test's and stays.
//
//   node scripts/inline-diff-fixtures.mjs <gallery clone> <github-marks.json>
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [gallery, marks] = process.argv.slice(2);
if (!gallery || !marks) {
	console.error(
		"usage: node scripts/inline-diff-fixtures.mjs <gallery clone> <github-marks.json>",
	);
	process.exit(2);
}
const out = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../test/fixtures/inline-diff",
);
const git = (...args) =>
	execFileSync("git", ["-C", gallery, ...args], {
		maxBuffer: 64 * 1024 * 1024,
	});
/** The local branch, else the remote one. */
const ref = (name) => {
	for (const candidate of [name, `origin/${name}`]) {
		try {
			git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
			return candidate;
		} catch {}
	}
	throw new Error(`no ${name} in ${gallery}`);
};
const base = ref("base/inline-diff");
const head = ref("case/inline-diff");
const paths = git("diff", "--name-only", "-z", "--no-renames", base, head)
	.toString("utf8")
	.split("\0")
	.filter((p) => p.startsWith("inline/"));
for (const side of ["base", "case"])
	rmSync(join(out, side), { recursive: true, force: true });
for (const path of paths) {
	for (const [side, at] of [
		["base", base],
		["case", head],
	]) {
		const file = join(out, side, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, git("show", `${at}:${path}`));
	}
}
copyFileSync(marks, join(out, "github-marks.json"));
console.log(`${paths.length} case files from ${base}..${head} into ${out}`);
