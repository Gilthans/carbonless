// pnpm release: versions and npm channels (docs/releasing.md).
//
//   pnpm release local [--out <dir>] [--no-install]
//                                             builds and packs this checkout as it is into <dir>
//                                             (default ~/.local/share/carbonless/releases) as
//                                             carbonless-review-<version>-<sha7>[-dirty].tgz and
//                                             installs it as the global crb; the last stdout line
//                                             is the tarball's path
//   pnpm release status                       master's next version, rc and latest on npm and in tags
//   pnpm release promote [<rc tag>] [--next patch|minor|major]
//                                             runs the promote workflow: <rc tag> (default: the
//                                             newest) published as X.Y.Z on latest, then a
//                                             "next" PR (default minor); prints the run's URL
//   pnpm release next <patch|minor|major|X.Y.Z>
//                                             a branch and PR setting master's next release
//
// Steps the workflows run (not for people): ci:rc-version, ci:set-version,
// ci:write-version, ci:promote-plan, ci:changelog, ci:bump, ci:rc-fixup. They
// print KEY=value lines for $GITHUB_OUTPUT and read the checkout's tags.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bump,
	DEFAULT_REPO,
	formatVersion,
	type Io,
	KINDS,
	type Kind,
	next,
	npmState,
	parseVersion,
	promote,
	type Runner,
	rcBehindLatest,
	rcToPublish,
	releasePrs,
	renderChangelog,
	resolvePromote,
	status,
	withVersion,
} from "./release-lib.js";
import { localCommand } from "./release-local.js";

const runner: Runner = (cmd, args, opts) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});

const io: Io = {
	run: runner,
	log: (line) => console.log(line),
	repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
	now: () => new Date(),
	// ci:* steps read the checkout's tags; they get no token to ask origin.
	tags: process.argv[2]?.startsWith("ci:") ? "local" : "origin",
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function usage(): never {
	console.error(
		"usage: pnpm release local [--out <dir>] [--no-install] | status | promote [<rc tag>] [--next patch|minor|major] | next <patch|minor|major|X.Y.Z>",
	);
	process.exit(2);
}

function kindArg(value: string | undefined): Kind {
	if (!value || !(KINDS as readonly string[]).includes(value)) usage();
	return value as Kind;
}

/** package.json's version in `dir`. */
const packageVersion = (dir: string) =>
	(
		JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
			version: string;
		}
	).version;

/**
 * Sets package.json's version in the runner's checkout without making the
 * tree dirty: git is told to skip the file (skip-worktree), so `git status`
 * stays empty and scripts/build-info.mjs records the commit, not `-dirty`.
 * Works on any commit, also one whose build-info.mjs predates this.
 */
function setVersion(version: string, dir: string) {
	if (!parseVersion(version)) throw new Error(`not a version: ${version}`);
	const file = join(dir, "package.json");
	writeFileSync(file, withVersion(readFileSync(file, "utf8"), version));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("update-index", "--skip-worktree", "package.json");
	const dirty = git("status", "--porcelain");
	if (dirty !== "") throw new Error(`the tree is not clean:\n${dirty}`);
	console.log(`version=${version}`);
}

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	switch (command) {
		case "local":
			return localCommand(rest, usage);
		case "status":
			return status(io);
		case "promote": {
			let tag: string | undefined;
			let kind: Kind = "minor";
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i] ?? "";
				if (a === "--next") kind = kindArg(rest[++i]);
				else if (a.startsWith("--next=")) kind = kindArg(a.slice(7));
				else if (!tag && !a.startsWith("-")) tag = a;
				else usage();
			}
			await promote(io, tag, kind);
			return;
		}
		case "next": {
			if (rest.length !== 1 || !rest[0]) usage();
			const dir = mkdtempSync(join(tmpdir(), "crb-next-"));
			await next(io, rest[0], join(dir, "worktree"));
			return;
		}
		case "ci:rc-version": {
			const { version, firstPublish, blocked } = await rcToPublish(
				io,
				packageVersion(process.cwd()),
			);
			console.log(`version=${version}`);
			console.log(`first_publish=${firstPublish}`);
			console.log(`publish=${blocked === null}`);
			console.log(`blocked=${blocked ?? ""}`);
			return;
		}
		case "ci:set-version": {
			const [version, dir = process.cwd()] = rest;
			if (!version) usage();
			setVersion(version, dir);
			return;
		}
		case "ci:write-version": {
			// A committed change (the "next" PR), unlike ci:set-version.
			const version = rest[0] ?? "";
			if (!parseVersion(version)) usage();
			const file = join(process.cwd(), "package.json");
			writeFileSync(file, withVersion(readFileSync(file, "utf8"), version));
			return;
		}
		case "ci:promote-plan": {
			const plan = await resolvePromote(io, rest[0] ?? "");
			console.log(`tag=${plan.tag}`);
			console.log(`release=${plan.release}`);
			return;
		}
		case "ci:rc-fixup": {
			// ci:rc-fixup [<version this run published>]: the version `rc` must
			// move to so it isn't behind latest nor that version, or empty.
			const published = rest[0] ?? "";
			if (published && !parseVersion(published)) usage();
			console.log(
				`move_rc_to=${rcBehindLatest(await npmState(io), published || undefined) ?? ""}`,
			);
			return;
		}
		case "ci:changelog": {
			// ci:changelog <X.Y.Z> <ref the release was built from>
			const [version, to] = rest;
			if (!version || !to) usage();
			const prs = await releasePrs(io, version, to, process.cwd());
			const file = join(process.cwd(), "docs/changelog.md");
			const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
			const date = io.now().toISOString().slice(0, 10);
			writeFileSync(file, renderChangelog(existing, version, date, prs));
			console.log(`prs=${prs.length}`);
			return;
		}
		case "ci:bump": {
			const v = parseVersion(rest[0] ?? "");
			if (!v || v.rc !== undefined) usage();
			console.log(`next=${formatVersion(bump(v, kindArg(rest[1])))}`);
			return;
		}
		default:
			usage();
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`error: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
