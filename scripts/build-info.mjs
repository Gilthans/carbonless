#!/usr/bin/env node
// Writes dist/build-info.json: package.json's version and the commit built
// (git rev-parse HEAD, "-dirty" appended when the tree has changes), so an
// installed build reports its version with no .git (src/server/version.ts).
// And dist/release-notes.json, the release notes this build ships (CAR-192):
// package.json's crbReleaseNotes, which `release.ts ci:set-version` writes
// for an RC or a release. A local build has none, and no file.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const git = (...args) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const { version, crbReleaseNotes } = JSON.parse(
	readFileSync(new URL("package.json", root), "utf8"),
);
const dirty = git("status", "--porcelain") !== "";
const commit = `${git("rev-parse", "HEAD")}${dirty ? "-dirty" : ""}`;
mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(
	new URL("dist/build-info.json", root),
	`${JSON.stringify({ version, commit }, null, "\t")}\n`,
);
if (Array.isArray(crbReleaseNotes)) {
	writeFileSync(
		new URL("dist/release-notes.json", root),
		`${JSON.stringify(crbReleaseNotes, null, "\t")}\n`,
	);
}
