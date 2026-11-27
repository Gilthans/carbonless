// pnpm release: versions and npm channels (docs/releasing.md).
//
//   pnpm release local [--out <dir>] [--no-install]
//                                             builds and packs this checkout as it is into <dir>
//                                             (default ~/.local/share/carbonless/releases) as
//                                             carbonless-review-<version>-<sha7>[-dirty].tgz and
//                                             installs it as the global crb; the last stdout line
//                                             is the tarball's path
//   pnpm release status                       master's next version, rc and latest on npm and in tags,
//                                             the withdrawn versions, and the hotfixes whose fix
//                                             master still lacks
//   pnpm release promote [<rc tag>] [--next patch|minor|major]
//                                             collects the release's notes for exactly <rc tag>'s
//                                             range from Linear (refusing while any is missing),
//                                             then starts release.yml's promote with them: <rc
//                                             tag> (default: the newest; CI must have passed on
//                                             it), packed as X.Y.Z with those notes, the tarball
//                                             smoke-tested, and staged on npm (hidden until
//                                             approved); prints the run's URL
//   pnpm release hotfix [vX.Y.Z]              ON THE OWNER'S WORD: creates hotfix/<next patch> on
//                                             origin at the newest release tag's commit (the only
//                                             one accepted; after a withdraw, the withdrawn
//                                             release; a version npm has with no tag is skipped);
//                                             the fix goes in as a PR into it
//   pnpm release promote --hotfix X.Y.Z       ON THE OWNER'S WORD: promotes hotfix/X.Y.Z's head
//                                             as promote does an RC (CI passed on the head, its
//                                             PRs' notes from Linear); no RC on rc first
//   pnpm release publish [<run-id>]
//                                             THE OWNER ONLY: checks a promote run's staged
//                                             tarball (default: the newest run) and approves it
//                                             (npm stage approve, with their two-factor OTP), or
//                                             for the very first release publishes it; then
//                                             starts release-finish; agents never run it
//   pnpm release withdraw <version>... "<why>" [--deprecate-only]
//                                             THE OWNER ONLY (npm asks for the OTP): deprecates
//                                             each version with "withdrawn: <why>" (crb never
//                                             offers it, and one running it shows a Withdrawn
//                                             banner) and moves latest and rc off them to the
//                                             newest good version; --deprecate-only moves no tag
//                                             (when none good is left); safe to rerun
//   pnpm release next <patch|minor|major|X.Y.Z>
//                                             a branch and PR setting master's next release
//   pnpm release merge-ok <pr>                fails while master is frozen (its version is
//                                             released, the "next" PR not merged) unless <pr>
//                                             is that "next" PR, or while the PR's tickets have
//                                             no Release note in Linear nor in its description
//                                             (a ticket-less PR: no "Release note:" line in its
//                                             description); reruns the PR's red release-note
//                                             check once its notes pass; run before every merge
//   pnpm release note <CAR-N> "<text>" [--kind new|improved|fixed]
//   pnpm release note <CAR-N> --none "<why>"  checks the note and posts it on the ticket as a
//                                             "Release note" comment (the kind defaults from
//                                             the ticket's labels), then reruns the release-note
//                                             check of each open PR whose title names CAR-N
//   pnpm release notes [X.Y.Z] [--pr]         writes release-notes/X.Y.Z.json (default: master's
//                                             next release) from Linear and the PRs merged up to
//                                             origin/master; prints what is missing; --pr puts
//                                             it on notes/X.Y.Z with a "notes: X.Y.Z" PR instead
//                                             (optional: promote collects the notes itself; this
//                                             previews them, and RCs ship them). Never writes to
//                                             Linear
//   pnpm release notes check                  fails listing what has no note: the release so
//                                             far, and tickets done in the last 30 days
//
// Steps the workflows run (not for people): ci:rc-version, ci:set-version,
// ci:check-publish, ci:write-version, ci:promote-plan, ci:manifest,
// ci:check-run, ci:finish-plan, ci:notes-input, ci:published-notes,
// ci:changelog, ci:release-body, ci:bump, ci:pr-note, ci:port. (CI passed on the
// RC's commit: scripts/ci-passed.mjs, with no dependencies.) They print KEY=value
// lines for $GITHUB_OUTPUT and read the checkout's tags. (The rc fix-up is
// scripts/rc-fixup.mjs, with no dependencies, for the jobs that hold npm's
// OIDC credential.)
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { NOTE_KINDS, type NoteKind } from "../src/shared/releaseNotes.js";
import {
	hotfixStart,
	hotfixStatus,
	missingOnMaster,
	portPr,
	promoteHotfix,
	resolveHotfix,
} from "./release-hotfix.js";
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
	must,
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
	capLocal,
	capShipped,
	finishNotes,
	formatNotesFile,
	hotfixNotes,
	type Linear,
	LOCAL_NOTES_GIT_PATH,
	linearClient,
	linearKey,
	mergeOkNotes,
	noLinearKey,
	notesFilesAt,
	notesFromInput,
	notesPath,
	type PullForNotes,
	postNote,
	prNotesOk,
	promoteNotes,
	readNotesFile,
	releaseRange,
	renderNotesBody,
	shippedNotes,
	withChangelogSection,
	withReleaseNotes,
	workflowText,
	writeNotes,
} from "./release-notes.js";
import { withdraw, withdrawnStatus } from "./release-withdraw.js";

const runner: Runner = (cmd, args, opts) =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts?.cwd,
			env: opts?.env ? { ...process.env, ...opts.env } : undefined,
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
		'usage: pnpm release local [--out <dir>] [--no-install] | status | hotfix [vX.Y.Z] | promote [<rc tag>] [--next patch|minor|major] | promote --hotfix X.Y.Z | publish [<run-id>] | withdraw <version>... "<why>" [--deprecate-only] | next <patch|minor|major|X.Y.Z> | merge-ok <pr> | note <CAR-N> "<text>" [--kind new|improved|fixed] | note <CAR-N> --none "<why>" | notes [X.Y.Z] [--pr] | notes check',
	);
	process.exit(2);
}

function kindArg(value: string | undefined): Kind {
	if (!value || !(KINDS as readonly string[]).includes(value)) usage();
	return value as Kind;
}

/** Linear with the key on this machine, or null without one (never in CI), and where it looked. */
function findLinear(): { linear: Linear | null; tried: string[] } {
	const { key, tried } = linearKey();
	return { linear: key ? linearClient(key) : null, tried };
}

/** ci:published-notes' output, read back strictly: a notes file of `version`. */
function readPublishedNotes(path: string, version: string) {
	const notes = readNotesFile(readFileSync(path, "utf8"), path);
	if (notes.version !== version) {
		throw new Error(`${path} is for ${notes.version}, not ${version}`);
	}
	return notes;
}

function mustLinear(): Linear {
	const { linear, tried } = findLinear();
	if (!linear) throw new Error(noLinearKey(tried));
	return linear;
}

/** A PR's changed files, from GitHub. */
async function prFiles(number: number): Promise<string[]> {
	const out = await must(io, "gh", [
		"api",
		"--paginate",
		`repos/${io.repo}/pulls/${number}/files?per_page=100`,
		"--jq",
		".[].filename",
	]);
	return out.split("\n").filter((f) => f !== "");
}

/**
 * docs/changelog.md's section of `version` and its release-notes/X.Y.Z.json
 * (the published notes, dated) in the checkout at `root`; the PRs from
 * git, up to `to`. Returns how many PRs.
 */
async function writeChangelog(
	version: string,
	to: string,
	published: string,
	root: string,
): Promise<number> {
	const notes = readPublishedNotes(published, version);
	const range = await releaseRange(io, version, to);
	const date = io.now().toISOString().slice(0, 10);
	const file = join(root, "docs/changelog.md");
	// Read once (no exists-then-read race): none yet is an empty changelog.
	let existing: string | null = null;
	try {
		existing = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(file), { recursive: true });
	const section = `## ${version} (${date})\n\n${renderNotesBody(notes, range)}`;
	writeFileSync(file, withChangelogSection(existing, version, section));
	const notesFile = join(root, notesPath(version));
	mkdirSync(dirname(notesFile), { recursive: true });
	writeFileSync(notesFile, formatNotesFile({ ...notes, date }));
	return range.prs.length;
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
 * Works on any commit, also one whose build-info.mjs predates this. A
 * release's own notes come from `notesFile` (promote's, CAR-242: the
 * checked input, written by ci:notes-input) when given, else from its
 * release-notes/X.Y.Z.json at HEAD.
 */
async function setVersion(version: string, dir: string, notesFile?: string) {
	const v = parseVersion(version);
	if (!v) throw new Error(`not a version: ${version}`);
	const file = join(dir, "package.json");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	// gitHead: npm then records the commit, so an RC or a release can be
	// told from a master build of the same version (`crb --version` shows the
	// commit, and a machine following npm can compare it).
	const head = git("rev-parse", "HEAD").trim();
	// The release notes it ships (CAR-192): npm keeps the field, capped, in
	// the version's manifest; the build (scripts/build-info.mjs) writes
	// every version into dist/release-notes.json from the git dir's file.
	const given = notesFile
		? readNotesFile(readFileSync(notesFile, "utf8"), notesFile)
		: undefined;
	const notes = await shippedNotes(io, version, dir, given);
	// A release also carries its notes file whole (notes and none), which
	// release-finish commits from the published package.
	const own =
		v.rc !== undefined
			? undefined
			: (given ??
				(await notesFilesAt(io, "HEAD", dir)).get(
					formatVersion({ ...v, rc: undefined }),
				));
	writeFileSync(
		file,
		withReleaseNotes(
			withGitHead(withVersion(readFileSync(file, "utf8"), version), head),
			capShipped(notes),
			own,
		),
	);
	const local = git(
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		LOCAL_NOTES_GIT_PATH,
	).trim();
	// For this version and commit only: build-info.mjs ignores it otherwise.
	writeFileSync(
		local,
		`${JSON.stringify({ version, commit: head, notes: capLocal(notes) })}\n`,
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
			await status(io);
			await withdrawnStatus(io);
			await hotfixStatus(io);
			return;
		case "hotfix": {
			if (rest.length > 1 || rest[0]?.startsWith("-")) usage();
			await hotfixStart(io, rest[0]);
			return;
		}
		case "withdraw": {
			// withdraw <version>... "<why>" [--deprecate-only]: the last
			// positional is the reason.
			const deprecateOnly = rest.includes("--deprecate-only");
			const positional = rest.filter((a) => a !== "--deprecate-only");
			if (positional.some((a) => a.startsWith("-"))) usage();
			const why = positional.pop();
			if (why === undefined || positional.length === 0) usage();
			// The owner at a terminal, answering y/N and npm's OTP: never piped.
			if (!process.stdin.isTTY || !process.stdout.isTTY) {
				throw new Error(
					"pnpm release withdraw needs the owner at a terminal (it asks y/N, and npm asks for the OTP)",
				);
			}
			await withdraw(publishIo, { versions: positional, why, deprecateOnly });
			return;
		}
		case "promote": {
			let tag: string | undefined;
			let kind: Kind = "minor";
			let hotfix: string | undefined;
			for (let i = 0; i < rest.length; i++) {
				const a = rest[i] ?? "";
				if (a === "--next") kind = kindArg(rest[++i]);
				else if (a.startsWith("--next=")) kind = kindArg(a.slice(7));
				else if (a === "--hotfix") hotfix = rest[++i] ?? usage();
				else if (!tag && !a.startsWith("-")) tag = a;
				else usage();
			}
			if (hotfix !== undefined) {
				// A hotfix has no RC tag and opens no "next" PR.
				if (tag || rest.some((a) => a.startsWith("--next"))) usage();
				await promoteHotfix(io, hotfix, (branch, sha, release) =>
					hotfixNotes(io, release, branch, sha, findLinear()),
				);
				return;
			}
			await promote(io, tag, kind, (rc, release) =>
				promoteNotes(io, release, rc, findLinear()),
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
			// ci:manifest <tgz> <release> <rc tag> <sha> <next> [hotfix/X.Y.Z]:
			// promote's manifest.json (a hotfix's tag: the release it starts from).
			const [tgz, version, tag, sha, nextKind, hotfix] = rest;
			if (!tgz || !version || !tag || !sha || !nextKind) usage();
			const manifest = parseManifest(
				JSON.stringify({
					version,
					tag,
					sha,
					...(hotfix ? { hotfix } : {}),
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
			console.log(`hotfix=${plan.hotfix ?? ""}`);
			return;
		}
		case "ci:port": {
			// ci:port <X.Y.Z> <worktree> <notes.json> <out dir>: the hotfix
			// port PR (CAR-212): a worktree of master on hotfix-port/X.Y.Z
			// with each of vX.Y.Z's PRs master lacks that applies cleanly
			// (git cherry-pick -x), and a commit of the changelog section and
			// release-notes/X.Y.Z.json; the PR's title and body in <out dir>
			// (title, body.md). Prints the summary (markdown). git only.
			const [version, worktree, published, out] = rest;
			const v = parseVersion(version ?? "");
			if (
				!version ||
				!v ||
				v.rc !== undefined ||
				!worktree ||
				!published ||
				!out
			)
				usage();
			const items = await missingOnMaster(io, `v${version}`, {
				worktree,
				keep: `hotfix-port/${version}`,
			});
			const to = (
				await must(io, "git", ["rev-parse", `refs/tags/v${version}^{commit}`])
			).trim();
			await writeChangelog(version, to, published, worktree);
			const paths = ["docs/changelog.md", notesPath(version)];
			await must(io, "git", ["add", "--", ...paths], { cwd: worktree });
			await must(
				io,
				"git",
				[
					"commit",
					"-m",
					`Hotfix ${version}: its changelog and release notes`,
					"--",
					...paths,
				],
				{ cwd: worktree },
			);
			const pr = portPr(version, items);
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "title"), pr.title);
			writeFileSync(join(out, "body.md"), `${pr.body}\n`);
			console.log(`### Port of ${version} to master\n\n${pr.body}`);
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
			// The PR's notes, then a red release-note check from before the
			// note is rerun.
			await mergeOk(io, rest[0], (pull) =>
				mergeOkNotes(io, pull, findLinear, () => prFiles(pull.number)),
			);
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
		case "ci:pr-note": {
			// ci:pr-note <pull.json> <files.json>: the release-note check
			// (CAR-211). The PR and its files as GitHub's REST API gave them
			// (files: `gh api --paginate --slurp`); Linear from $LINEAR_API_KEY
			// when the run has it. Fails with an annotation, never printing
			// the key.
			const [pullFile, filesFile] = rest;
			if (!pullFile || !filesFile || rest.length !== 2) usage();
			const pull = JSON.parse(readFileSync(pullFile, "utf8")) as PullForNotes;
			const pages = JSON.parse(readFileSync(filesFile, "utf8")) as unknown;
			if (!Array.isArray(pages)) throw new Error("the PR's files: not a list");
			const files = pages
				.flatMap((p) => (Array.isArray(p) ? p : [p]))
				.map((f) => String((f as { filename?: unknown })?.filename ?? ""));
			try {
				console.log(await prNotesOk(pull, findLinear, async () => files));
			} catch (error) {
				console.log(
					`::error title=Release note::${workflowText((error as Error).message)}`,
				);
				process.exit(1);
			}
			return;
		}
		case "ci:notes-input": {
			// ci:notes-input <X.Y.Z> <sha> <out.json>: the promote's notes
			// ($NOTES_INPUT, the run's `notes` input; empty: none) over
			// release-notes/X.Y.Z.json at sha, checked to cover the release,
			// written to out.json; prints the summary (markdown).
			const [version, sha, out] = rest;
			if (!version || !sha || !out || !/^[0-9a-f]{40}$/.test(sha)) usage();
			const { file, summary } = await notesFromInput(
				io,
				version,
				sha,
				process.env.NOTES_INPUT ?? "",
			);
			writeFileSync(out, formatNotesFile(file));
			console.log(summary);
			return;
		}
		case "ci:published-notes": {
			// ci:published-notes <X.Y.Z> <promote artifact dir> <out.json>:
			// the notes X.Y.Z was published with (its package's
			// crbReleaseNotesFile, once npm shows that very tarball); for a
			// package promoted without them, the file at the RC's commit.
			const [version, dir, out] = rest;
			if (!version || !dir || !out) usage();
			const { file, warning } = await finishNotes(io, version, dir);
			if (warning) console.log(`::warning::${workflowText(warning)}`);
			writeFileSync(out, formatNotesFile(file));
			console.log(
				`${version}: ${file.notes.length} notes, ${file.none.length} none`,
			);
			return;
		}
		case "ci:release-body": {
			// ci:release-body <X.Y.Z> <sha> <notes.json>: the GitHub release's
			// text, from the published notes (ci:published-notes).
			const [version, sha, notesFile] = rest;
			if (!version || !sha || !notesFile) usage();
			const notes = readPublishedNotes(notesFile, version);
			const range = await releaseRange(io, version, sha);
			console.log(renderNotesBody(notes, range));
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
			// ci:set-version <version> [dir] [notes.json]
			const [version, dir = process.cwd(), notesFile] = rest;
			if (!version) usage();
			await setVersion(version, dir, notesFile);
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
			// ci:promote-plan <rc tag | ""> [hotfix/X.Y.Z | ""]: what promote
			// builds (ref) and what promote-ci checked (source: the RC tag,
			// or the hotfix branch).
			const [rc = "", hotfix = ""] = rest;
			if (hotfix !== "") {
				if (rc.trim() !== "") usage();
				const m = /^hotfix\/(\d+\.\d+\.\d+)$/.exec(hotfix);
				if (!m?.[1]) throw new Error(`not a hotfix branch: ${hotfix}`);
				const plan = await resolveHotfix(io, m[1]);
				console.log(`tag=${plan.tag}`);
				console.log(`release=${plan.release}`);
				console.log(`ref=refs/remotes/origin/${plan.branch}`);
				console.log(`source=${plan.branch}`);
				return;
			}
			const plan = await resolvePromote(io, rc);
			console.log(`tag=${plan.tag}`);
			console.log(`release=${plan.release}`);
			console.log(`ref=refs/tags/${plan.tag}`);
			console.log(`source=${plan.tag}`);
			return;
		}
		case "ci:changelog": {
			// ci:changelog <X.Y.Z> <the RC's commit> <notes.json>: the
			// version's section in docs/changelog.md from the published notes
			// (ci:published-notes; the PRs from git), and those notes, dated,
			// as release-notes/X.Y.Z.json in this checkout (replacing any file
			// there: what was published wins).
			const [version, to, published] = rest;
			if (!version || !to || !published) usage();
			const prs = await writeChangelog(version, to, published, process.cwd());
			console.log(`prs=${prs}`);
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
