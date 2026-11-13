#!/usr/bin/env node
// Rebuilds test/fixtures/pairing from a clone of Gilthans/carbonless-gallery
// (our playground, not a real PR's data): every file that differs between
// `base/similarity-pairing` and `case/similarity-pairing` (step 2's cases,
// `pairing/01…07`), as `base/<path>` and `case/<path>` byte for byte.
//
//   node scripts/pairing-fixtures.mjs <gallery clone>
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [gallery] = process.argv.slice(2);
if (!gallery) {
	console.error("usage: node scripts/pairing-fixtures.mjs <gallery clone>");
	process.exit(2);
}
const out = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../test/fixtures/pairing",
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
const base = ref("base/similarity-pairing");
const head = ref("case/similarity-pairing");
const paths = git("diff", "--name-only", "-z", "--no-renames", base, head)
	.toString("utf8")
	.split("\0")
	.filter((p) => p.startsWith("pairing/"));
rmSync(out, { recursive: true, force: true });
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
console.log(`${paths.length} case files from ${base}..${head} into ${out}`);
