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
//                                             starts release.yml's promote: <rc tag> (default:
//                                             the newest; CI must have passed on it), packed as
//                                             X.Y.Z, the tarball smoke-tested, and
//                                             staged on npm (hidden until approved); prints the
//                                             run's URL
//   pnpm release publish [<run-id>]
//                                             THE OWNER ONLY: checks a promote run's staged
//                                             tarball (default: the newest run) and approves it
//                                             (npm stage approve, with their two-factor OTP), or
//                                             for the very first release publishes it; then
//                                             starts release-finish; agents never run it
//   pnpm release next <patch|minor|major|X.Y.Z>
//                                             a branch and PR setting master's next release
//   pnpm release merge-ok <pr>                fails while master is frozen (its version is
//                                             released, the "next" PR not merged) unless <pr>
//                                             is that "next" PR, or while the PR's tickets have
//                                             no Release note in Linear (a ticket-less PR: no
//                                             "Release note:" line in its description); run
//                                             before every merge
//   pnpm release note <CAR-N> "<text>" [--kind new|improved|fixed]
//   pnpm release note <CAR-N> --none "<why>"  checks the note and posts it on the ticket as a
//                                             "Release note" comment (the kind defaults from
//                                             the ticket's labels)
//   pnpm release notes [X.Y.Z] [--pr]         writes release-notes/X.Y.Z.json (default: master's
//                                             next release) from Linear and the PRs merged up to
//                                             origin/master; prints what is missing; --pr puts
//                                             it on notes/X.Y.Z with a "notes: X.Y.Z" PR instead.
//                                             Never writes to Linear
//   pnpm release notes check                  fails listing what has no note: the release so
//                                             far, and tickets done in the last 30 days
//
// Steps the workflows run (not for people): ci:rc-version, ci:set-version,
// ci:check-publish, ci:write-version, ci:promote-plan, ci:manifest,
// ci:check-run, ci:finish-plan, ci:notes-check, ci:changelog,
// ci:release-body, ci:bump. (CI passed on the
// RC's commit: scripts/ci-passed.mjs, with no dependencies.) They print KEY=value
// lines for $GITHUB_OUTPUT and read the checkout's tags. (The rc fix-up is
// scripts/rc-fixup.mjs, with no dependencies, for the jobs that hold npm's
// OIDC credential.)
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { NOTE_KINDS, type NoteKind } from "../src/shared/releaseNotes.js";
import {
	bump,
	checkPromoteRun,
	checkRcPublish,
	DEFAULT_REPO,
	finishPlan,
	formatVersion,
	type Io,
	KINDS,
	type Kind,
	mergeOk,
	next,
	type PublishIo,
	parseManifest,
	parseVersion,
	promote,
	publishRelease,
	type Runner,
	rcToPublish,
	resolvePromote,
	status,
	tarballDigests,
	withGitHead,
	withVersion,
} from "./release-lib.js";
import { localCommand } from "./release-local.js";
import {
	auditNotes,
	formatNotesFile,
	type Linear,
	linearClient,
	linearKey,
	NO_LINEAR_KEY,
	notesCheck,
	notesFilesAt,
	notesPath,
	postNote,
	prNotesOk,
	promoteNotesCheck,
	readNotesFile,
	releaseRange,
	renderNotesBody,
	shippedNotes,
	withChangelogSection,
	withReleaseNotes,
	writeNotes,
} from "./release-notes.js";

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

const publishIo: PublishIo = {
	...io,
	ask: async (question) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			return /^y(es)?$/i.test((await rl.question(question)).trim());
		} finally {
			rl.close();
		}
	},
	interactive: (cmd, args) =>
		new Promise((resolve, reject) => {
			const child = spawn(cmd, args, { stdio: "inherit" });
			child.on("error", reject);
			child.on("close", (code) => resolve(code ?? 1));
		}),
};

function usage(): never {
	console.error(
		'usage: pnpm release local [--out <dir>] [--no-install] | status | promote [<rc tag>] [--next patch|minor|major] | publish [<run-id>] | next <patch|minor|major|X.Y.Z> | merge-ok <pr> | note <CAR-N> "<text>" [--kind new|improved|fixed] | note <CAR-N> --none "<why>" | notes [X.Y.Z] [--pr] | notes check',
	);
	process.exit(2);
}

function kindArg(value: string | undefined): Kind {
	if (!value || !(KINDS as readonly string[]).includes(value)) usage();
	return value as Kind;
}

/** Linear with the key on this machine, or null without one (never in CI). */
function linearOrNull(): Linear | null {
	const key = linearKey();
	return key ? linearClient(key) : null;
}

function mustLinear(): Linear {
	const linear = linearOrNull();
	if (!linear) throw new Error(NO_LINEAR_KEY);
	return linear;
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
async function setVersion(version: string, dir: string) {
	if (!parseVersion(version)) throw new Error(`not a version: ${version}`);
	const file = join(dir, "package.json");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	// gitHead: npm then records the commit, so an RC or a release can be
	// told from a master build of the same version (`crb --version` shows the
	// commit, and a machine following npm can compare it).
	const head = git("rev-parse", "HEAD").trim();
	// The release notes it ships (CAR-192): npm keeps the field in the
	// version's manifest, and the build copies it to dist/release-notes.json.
	const notes = await shippedNotes(io, version, dir);
	writeFileSync(
		file,
		withReleaseNotes(
			withGitHead(withVersion(readFileSync(file, "utf8"), version), head),
			notes,
		),
	);
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
			await promote(io, tag, kind, (rc, release) =>
				promoteNotesCheck(io, release, rc, linearOrNull()),
			);
			return;
		}
		case "publish": {
			if (rest.length > 1) usage();
			// The owner at a terminal, answering y/N and npm's OTP: never piped.
			if (!process.stdin.isTTY || !process.stdout.isTTY) {
				throw new Error(
					"pnpm release publish needs the owner at a terminal (it asks y/N, and npm asks for the OTP)",
				);
			}
			await publishRelease(publishIo, rest[0]);
			return;
		}
		case "ci:manifest": {
			// ci:manifest <tgz> <release> <rc tag> <sha> <next>: promote's manifest.json.
			const [tgz, version, tag, sha, nextKind] = rest;
			if (!tgz || !version || !tag || !sha || !nextKind) usage();
			const manifest = parseManifest(
				JSON.stringify({
					version,
					tag,
					sha,
					...tarballDigests(readFileSync(tgz)),
					next: nextKind,
					tarball: tgz.split("/").at(-1),
				}),
			);
			console.log(JSON.stringify(manifest, null, "\t"));
			return;
		}
		case "ci:check-run": {
			// ci:check-run <run id>: fails unless a successful dispatched promote of master.
			const [run] = rest;
			if (!run) usage();
			await checkPromoteRun(io, run);
			console.log(`ok: run ${run}`);
			return;
		}
		case "ci:finish-plan": {
			// ci:finish-plan <X.Y.Z> <manifest.json>: what release-finish still does.
			const [version, file] = rest;
			if (!version || !file) usage();
			const manifest = parseManifest(readFileSync(file, "utf8"));
			const plan = await finishPlan(
				io,
				version,
				manifest,
				packageVersion(process.cwd()),
			);
			console.log(`sha=${manifest.sha}`);
			console.log(`rc_tag=${manifest.tag}`);
			console.log(`next=${manifest.next}`);
			console.log(`push_tag=${plan.pushTag}`);
			console.log(`next_pr=${plan.nextPr}`);
			return;
		}
		case "next": {
			if (rest.length !== 1 || !rest[0]) usage();
			const dir = mkdtempSync(join(tmpdir(), "crb-next-"));
			await next(io, rest[0], join(dir, "worktree"));
			return;
		}
		case "merge-ok": {
			if (rest.length !== 1 || !rest[0]) usage();
			await mergeOk(io, rest[0], (pull) => prNotesOk(pull, linearOrNull));
			return;
		}
		case "note": {
			const [id, ...args] = rest;
			if (!id) usage();
			let kind: NoteKind | undefined;
			let none: string | undefined;
			let text: string | undefined;
			for (let i = 0; i < args.length; i++) {
				const a = args[i] ?? "";
				if (a === "--kind") {
					const k = args[++i] ?? "";
					if (!(NOTE_KINDS as readonly string[]).includes(k)) usage();
					kind = k as NoteKind;
				} else if (a === "--none") {
					none = args[++i];
					if (none === undefined) usage();
				} else if (text === undefined) text = a;
				else usage();
			}
			if ((text === undefined) === (none === undefined)) usage();
			if (none !== undefined && kind) usage();
			await postNote(
				io,
				mustLinear(),
				id,
				none !== undefined ? { none } : { text: text ?? "", kind },
			);
			return;
		}
		case "notes": {
			if (rest[0] === "check") {
				if (rest.length !== 1) usage();
				await auditNotes(io, mustLinear());
				return;
			}
			let version: string | undefined;
			let pr = false;
			for (const a of rest) {
				if (a === "--pr") pr = true;
				else if (!version && parseVersion(a)) version = a;
				else usage();
			}
			const dir = mkdtempSync(join(tmpdir(), "crb-notes-"));
			await writeNotes(io, mustLinear(), {
				version,
				pr,
				root: process.cwd(),
				worktree: join(dir, "worktree"),
				write: (path, text) => {
					mkdirSync(dirname(path), { recursive: true });
					writeFileSync(path, text);
				},
			});
			return;
		}
		case "ci:notes-check": {
			// ci:notes-check <X.Y.Z> <sha>: release-notes/X.Y.Z.json at sha covers the release.
			const [version, sha] = rest;
			if (!version || !sha || !/^[0-9a-f]{40}$/.test(sha)) usage();
			console.log(await notesCheck(io, version, sha));
			return;
		}
		case "ci:release-body": {
			// ci:release-body <X.Y.Z> <sha>: the GitHub release's text.
			const [version, sha] = rest;
			if (!version || !sha) usage();
			const files = await notesFilesAt(io, sha);
			const range = await releaseRange(io, version, sha);
			console.log(renderNotesBody(files.get(version) ?? null, range));
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
			await setVersion(version, dir);
			return;
		}
		case "ci:check-publish": {
			// ci:check-publish <tag> <version>: fails unless it is rc and X.Y.Z-rc.N.
			const [tag, version] = rest;
			if (!tag || !version) usage();
			checkRcPublish(version, tag);
			console.log(`ok: ${version} to ${tag}`);
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
		case "ci:changelog": {
			// ci:changelog <X.Y.Z> <the RC's commit>: the version's section in
			// docs/changelog.md from its notes file at that commit (git only),
			// and the file in this checkout dated.
			const [version, to] = rest;
			if (!version || !to) usage();
			const files = await notesFilesAt(io, to);
			const range = await releaseRange(io, version, to);
			const date = io.now().toISOString().slice(0, 10);
			const file = join(process.cwd(), "docs/changelog.md");
			const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
			const section = `## ${version} (${date})\n\n${renderNotesBody(files.get(version) ?? null, range)}`;
			writeFileSync(file, withChangelogSection(existing, version, section));
			const notesFile = join(process.cwd(), notesPath(version));
			if (existsSync(notesFile)) {
				const notes = readNotesFile(
					readFileSync(notesFile, "utf8"),
					notesPath(version),
				);
				writeFileSync(notesFile, formatNotesFile({ ...notes, date }));
			}
			console.log(`prs=${range.prs.length}`);
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
