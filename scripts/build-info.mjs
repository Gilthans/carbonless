#!/usr/bin/env node
// Writes dist/build-info.json: package.json's version and the commit built
// (git rev-parse HEAD, "-dirty" appended when the tree has changes), so an
// installed build reports its version with no .git (src/server/version.ts).
// And dist/release-notes.json, the release notes this build ships (CAR-192),
// every released version's: `release.ts ci:set-version` leaves them in the
// git dir (crb-release-notes.json, for this version and commit), next to
// package.json's crbReleaseNotes (the same, capped for npm's manifest),
// which stands in when that file is missing. A local build has neither,
// and no file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
	let notes = crbReleaseNotes;
	const local = git(
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"crb-release-notes.json",
	);
	if (existsSync(local)) {
		const all = JSON.parse(readFileSync(local, "utf8"));
		if (
			all.version === version &&
			all.commit === commit &&
			Array.isArray(all.notes)
		) {
			notes = all.notes;
		}
	}
	writeFileSync(
		new URL("dist/release-notes.json", root),
		`${JSON.stringify(notes, null, "\t")}\n`,
	);
}
