#!/usr/bin/env node
// The daily Dependabot sweep (CAR-273; docs/agents/dependabot-sweep.md).
// This launcher holds the owner's GitHub login and does every GitHub read
// and write itself, by fixed rules (decide() below). An agent is started
// only to fix code locally, for a CI failure the update caused: in its own
// worktree, inside a bubblewrap sandbox that hides the machine's
// credentials, with no gh, no push and no network tools. The launcher then
// checks what the agent committed and pushes it, or comments why not.
// Text from PRs, changelogs, CI logs and the agent is data to it: it only
// ever posts fixed text, or agent text scrubbed and capped, via a file.
//
//   node scripts/dependabot-sweep.mjs [--dry-run] [--ref <git ref>]
//
//   --dry-run   read only: prints what it would do for each open Dependabot
//               PR (and the agent command), writes nothing anywhere.
//   --ref <r>   read the agent instructions from <r> (the timer passes
//               origin/master) instead of the working tree.
// Environment:
//   CRB_SWEEP_PRS      "201 202": these PRs instead of gh's list (--dry-run
//                      only).
//   CRB_SWEEP_AGENT    "on" lets a local fix agent try CI failures the update
//                      caused (default off: they get an owner comment).
//   CRB_SWEEP_TIMEOUT  the agent's time budget, as timeout(1) takes it
//                      (default 90m).
//   XDG_STATE_HOME     state and logs in $XDG_STATE_HOME/carbonless/
//                      dependabot-sweep/ (default ~/.local/state/...).
// No dependencies but Node's, so the timer can run it from `git show`.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOT = "dependabot[bot]";
export const TRAILER = "Dependabot-Sweep";
/** Changes the sweep never merges nor lets the agent make. */
export const PROTECTED = [/^\.github\//, /^scripts\/release/];
/** What the agent may not change (on top of PROTECTED). */
export const AGENT_FORBIDDEN = [
	...PROTECTED,
	/^package\.json$/,
	/^pnpm-lock\.yaml$/,
	/^pnpm-workspace\.yaml$/,
	/^\.npmrc$/,
	/^\.pnpmfile/,
	/^\.gitattributes$/,
	/^\.gitmodules$/,
	/(^|\/)\.claude\//,
	/^\.nvmrc$/,
];
const BRANCH_RE = /^dependabot\/[A-Za-z0-9._/@+-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
export const COMMENT_MAX = 1500;

// --- Pure rules (unit-tested in dependabot-sweep.test.ts) -----------------

/** The paths among `files` that match one of `patterns`. */
export function matching(files, patterns = PROTECTED) {
	return files.filter((f) => patterns.some((p) => p.test(f)));
}

/** [major, minor] of a version or range like "^3.4.16", else null. */
export function versionOf(range) {
	const m = /(\d+)(?:\.(\d+))?/.exec(String(range ?? ""));
	return m ? [Number(m[1]), Number(m[2] ?? 0)] : null;
}

/** A breaking bump: the major grows, or the minor of a 0.x. */
export function isBreaking(from, to) {
	const a = versionOf(from);
	const b = versionOf(to);
	if (!a || !b) return true; // unreadable: let the owner look
	if (b[0] !== a[0]) return true; // up or down: a different major
	return a[0] === 0 && b[1] !== a[1];
}

const DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

/**
 * Dependency changes that need the owner (any section, dev tools too): a
 * breaking bump (a new major, or a new minor of a 0.x), or a new entry.
 */
export function breakingBumps(basePkg, headPkg) {
	const out = [];
	for (const section of DEP_SECTIONS) {
		const base = basePkg?.[section] ?? {};
		const head = headPkg?.[section] ?? {};
		for (const [name, to] of Object.entries(head)) {
			const from = base[name];
			if (from === undefined) out.push({ name, from: null, to, kind: "added" });
			else if (from !== to && isBreaking(from, to))
				out.push({ name, from, to, kind: "major" });
		}
	}
	return out;
}

/**
 * The packages a Dependabot PR says it updates: its title's, and the
 * `dependency-name:` entries of its commits' metadata.
 */
export function dependabotNames(title, messages = []) {
	const names = new Set();
	const t = bumpFromTitle(title);
	if (t) names.add(t.name);
	for (const m of messages)
		for (const x of String(m ?? "").matchAll(
			/^[\s-]*dependency-name:\s*["']?([^\s"']+)/gm,
		))
			names.add(x[1]);
	return [...names];
}

/** Did Dependabot's own metadata call this a major update? */
export const metadataMajor = (messages = []) =>
	messages.some((m) => /update-type:\s*version-update:semver-major/.test(m));

const LOCK_HOST = "registry.npmjs.org";
const stable = (v) =>
	Array.isArray(v)
		? v.map(stable)
		: v && typeof v === "object"
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, stable(v[k])]),
				)
			: v;

/**
 * Why a Dependabot PR isn't a plain manifest update, or []: it may change
 * only package.json and pnpm-lock.yaml; package.json only in the versions
 * of the packages it names; and every source the lockfile gains must be
 * the npm registry (no git, file, link or other hosts).
 */
export function manifestProblems({
	files,
	basePkg,
	headPkg,
	names,
	addedLockLines,
}) {
	const problems = [];
	const other = (files ?? []).filter(
		(f) => f !== "package.json" && f !== "pnpm-lock.yaml",
	);
	if (other.length > 0)
		problems.push(
			`it changes more than package.json and pnpm-lock.yaml (${other.join(", ")})`,
		);
	if ((names ?? []).length === 0)
		problems.push("it names no dependency it updates");
	if ((files ?? []).includes("package.json")) {
		const blank = (pkg) => {
			const copy = JSON.parse(JSON.stringify(pkg ?? {}));
			for (const section of DEP_SECTIONS)
				for (const n of names ?? [])
					if (copy[section] && n in copy[section]) copy[section][n] = "*";
			return JSON.stringify(stable(copy));
		};
		if (!basePkg || !headPkg || blank(basePkg) !== blank(headPkg))
			problems.push(
				`its package.json changes more than the version of ${(names ?? []).join(", ") || "its dependency"}`,
			);
	}
	const bad = new Set();
	for (const line of addedLockLines ?? []) {
		for (const u of line.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s'",}]+/gi)) {
			let host = "";
			try {
				host = new URL(u[0]).host;
			} catch {}
			if (host !== LOCK_HOST || !u[0].startsWith("https://")) bad.add(u[0]);
		}
		if (
			/(git\+|github:|gitlab:|bitbucket:|file:|link:)/.test(line) ||
			/(^|[\s{,])(repo|commit|directory|path):/.test(line)
		)
			bad.add(line.trim().slice(0, 80));
	}
	if (bad.size > 0)
		problems.push(
			`its lockfile adds sources other than ${LOCK_HOST} (${[...bad].slice(0, 3).join("; ")})`,
		);
	return problems;
}

/** "Bump X from A to B" (Dependabot's title), else null. */
export function bumpFromTitle(title) {
	const m = /^Bump (\S+) from (\S+) to (\S+?)(?: in .*)?$/.exec(
		String(title ?? "").trim(),
	);
	return m ? { name: m[1], from: m[2], to: m[3] } : null;
}

/**
 * Does the description carry a Release note: the sweep's own line, or a
 * `Release note` line of the description itself (not in a quote or in a
 * <details> block, where Dependabot puts upstream changelogs).
 */
export function hasReleaseNote(body, note) {
	const b = String(body ?? "");
	if (note && b.split("\n").some((l) => l.trim() === note)) return true;
	const own = b
		.replace(/<details[\s\S]*?<\/details>/gi, "")
		.split("\n")
		.filter((l) => !/^\s*>/.test(l))
		.join("\n");
	return /^Release note( \((new|improved|fixed)\))?:/m.test(own);
}

const cmpVersion = (a, b) => {
	const pa = String(a)
		.split(/[.+-]/)
		.map((x) => Number.parseInt(x, 10) || 0);
	const pb = String(b)
		.split(/[.+-]/)
		.map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d;
	}
	return 0;
};

/**
 * The release note line. A bump that closes open Dependabot alerts
 * (same package, first patched version reached) gets a `fixed` note built
 * only from the advisories' ids; anything else is `none`.
 */
export function releaseNote(bump, alerts) {
	const ids = bump
		? [
				...new Set(
					(alerts ?? [])
						.filter(
							(a) =>
								a.package === bump.name &&
								a.patched &&
								cmpVersion(bump.to, a.patched) >= 0 &&
								/^GHSA(-[0-9a-z]{4}){3}$/.test(a.ghsa),
						)
						.map((a) => a.ghsa),
				),
			].sort()
		: [];
	if (ids.length === 0) return "Release note: none (dependency update)";
	const name = bump.name.replace(/[^A-Za-z0-9@/._-]/g, "");
	const to = bump.to.replace(/[^0-9A-Za-z.+-]/g, "");
	return `Release note (fixed): Updated ${name} to ${to}, which closes security ${ids.length === 1 ? "advisory" : "advisories"} ${ids.join(", ")}`;
}

/**
 * How a failed CI job failed, from its first failed step: "test" (a test
 * step: worth one rerun, it may be a flake), "infra" (no step failed:
 * the runner) or "build" (install, lint, typecheck, build, pack: the
 * update's fault until shown otherwise).
 */
export function classifyJob(job) {
	const step = (job?.steps ?? []).find((s) => s.conclusion === "failure");
	if (!step) return "infra";
	const n = step.name ?? "";
	if (/install|lint|typecheck|build|pack|biome|tsc/i.test(n)) return "build";
	if (/\b(test|tests|vitest|playwright|e2e|shard)\b/i.test(n)) return "test";
	return "build";
}

const ok = (b) => b === "pass" || b === "skipping";

/**
 * What to do with one PR, from facts the launcher gathered. Pure.
 * Returns { type, reason, key? , ... } where type is one of:
 *   skip      not the sweep's to touch
 *   owner     comment once (key) for the owner and leave it
 *   rebase    comment `@dependabot rebase`
 *   wait      nothing now; a later run looks again
 *   add-note  add `note` to the description
 *   refresh-note  run merge-ok, which reruns a stale release-note check
 *   rerun     `gh run rerun <id> --failed` for `runIds`
 *   agent     hand `failure` to the agent
 *   merge     merge-ok, then merge at `sha`
 */
export function decide(f) {
	const { pr } = f;
	const sha = pr.headRefOid;
	if (pr.author !== BOT && pr.author !== "app/dependabot")
		return { type: "skip", reason: `author ${pr.author} is not Dependabot` };
	if (pr.state && pr.state !== "OPEN")
		return { type: "skip", reason: "not open" };
	if (pr.isDraft) return { type: "skip", reason: "draft" };
	if (!SHA_RE.test(sha ?? ""))
		return { type: "wait", reason: "no head commit" };
	if (pr.baseRefName && pr.baseRefName !== "master")
		return { type: "skip", reason: `targets ${pr.baseRefName}, not master` };
	if (!BRANCH_RE.test(pr.headRefName ?? ""))
		return {
			type: "owner",
			key: `branch:${sha}`,
			reason: `its branch \`${pr.headRefName}\` isn't a dependabot/ branch`,
		};
	const sweep = new Set(f.sweepShas ?? []);
	const foreign = (f.commits ?? []).filter(
		(c) =>
			!sweep.has(c.sha) &&
			!(c.author === BOT && c.committer === "web-flow" && c.verified),
	);
	if (foreign.length > 0 || (f.commits ?? []).length === 0)
		return {
			type: "owner",
			key: `commits:${sha}`,
			reason: `it has commits by neither Dependabot nor the sweep (${foreign.map((c) => c.sha.slice(0, 7)).join(", ") || "none listed"}), so it isn't merged automatically`,
		};
	const sweepShas = (f.commits ?? []).filter((c) => sweep.has(c.sha));
	if (sweepShas.length > 0)
		return {
			type: "owner",
			key: `sweep-fix:${sha}`,
			reason: `the sweep pushed a fix at ${sweepShas[sweepShas.length - 1].sha.slice(0, 7)}; review and merge it`,
		};
	const prot = matching(pr.files ?? []);
	if (prot.length > 0)
		return {
			type: "owner",
			key: `protected:${sha}`,
			reason: `it changes ${prot.map((p) => `\`${p}\``).join(", ")} (workflows or release scripts), which only the owner merges`,
		};
	if ((f.manifestProblems ?? []).length > 0)
		return {
			type: "owner",
			key: `manifest:${sha}`,
			reason: `it isn't a plain dependency update: ${f.manifestProblems.join("; ")}`,
		};
	if ((f.breaking ?? []).length > 0)
		return {
			type: "owner",
			key: `major:${sha}`,
			reason: `it is a breaking update (${f.breaking.map((b) => (b.kind === "added" ? `new: ${b.name}` : `${b.name} ${b.from ?? ""} → ${b.to ?? ""}`.trim())).join(", ")}), which needs the owner's look`,
		};
	if (
		pr.mergeStateStatus === "BEHIND" ||
		pr.mergeStateStatus === "DIRTY" ||
		pr.mergeable === "CONFLICTING"
	) {
		if (f.rebaseAsked)
			return { type: "wait", reason: "rebase asked; waiting for Dependabot" };
		return { type: "rebase", reason: `${pr.mergeStateStatus}/${pr.mergeable}` };
	}
	if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
		return { type: "wait", reason: "GitHub is still computing mergeability" };
	if (!hasReleaseNote(pr.body, f.note))
		return { type: "add-note", note: f.note, reason: "no release note" };

	const checks = f.checks ?? [];
	if (checks.length === 0) return { type: "wait", reason: "no checks yet" };
	if (checks.some((c) => c.bucket === "pending"))
		return { type: "wait", reason: "checks running" };
	const failed = checks.filter((c) => !ok(c.bucket));
	if (failed.some((c) => c.name === "release-gate"))
		return {
			type: "owner",
			key: `release-gate:${sha}`,
			reason:
				"the release-gate check fails (master is frozen for a release, or the gate is broken); it waits",
		};
	const rest = failed.filter((c) => c.name !== "release-note");
	if (failed.length > 0 && rest.length === 0)
		return { type: "refresh-note", reason: "release-note check is stale" };
	if (rest.length > 0) {
		const reruns = new Set();
		for (const c of rest) {
			const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.link ?? "");
			if (!m)
				return {
					type: "owner",
					key: `check:${c.name}:${sha}`,
					reason: `the \`${c.name}\` check failed and isn't a GitHub Actions job the sweep can read`,
				};
			const run = f.runs?.[m[1]];
			if (!run || run.headSha !== sha || run.headBranch !== pr.headRefName)
				return { type: "wait", reason: `run ${m[1]} isn't for this head` };
			const job = (run.jobs ?? []).find((j) => String(j.id) === m[2]);
			const kind = classifyJob(job);
			if (kind === "build" || run.attempt >= 2) {
				if (!f.agentEnabled)
					return {
						type: "owner",
						key: `ci:${sha}`,
						reason: `\`${c.name}\` fails in a ${kind === "build" ? "build, lint or typecheck" : "test"} step${run.attempt >= 2 ? ", again after a rerun" : ""}; the update probably broke it and needs a fix by hand`,
					};
				if (f.agentTried)
					return {
						type: "owner",
						key: `agent:${sha}`,
						reason: `\`${c.name}\` still fails after the sweep's fix attempt on this commit`,
					};
				return {
					type: "agent",
					reason: `${c.name}: ${kind}${run.attempt >= 2 ? " (failed again on rerun)" : ""}`,
					failure: { check: c.name, runId: m[1], jobId: m[2], kind },
				};
			}
			reruns.add(m[1]);
		}
		return {
			type: "rerun",
			runIds: [...reruns],
			reason: `${rest.map((c) => c.name).join(", ")} failed in a test or runner step`,
		};
	}
	const missing = (f.required ?? []).filter(
		(n) => !checks.some((c) => c.name === n && ok(c.bucket)),
	);
	if (missing.length > 0)
		return {
			type: "wait",
			reason: `required checks missing: ${missing.join(", ")}`,
		};
	if ((f.required ?? []).length === 0)
		return { type: "wait", reason: "no required checks reported" };
	return { type: "merge", sha, reason: "all checks green" };
}

/**
 * Agent text made fit to post publicly: links, issue references, tokens,
 * addresses, emails and absolute paths dropped, then only plain characters
 * kept (no markdown, HTML, @-mentions or backticks), capped. Post it inside
 * codeBlock().
 */
export function scrub(text, max = COMMENT_MAX) {
	let s = String(text ?? "")
		.replace(/\r/g, "")
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
		.replace(/\bwww\.\S+/gi, "[link]")
		.replace(
			/\b(gh[opsur]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|lin_(api|oauth)_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,})/g,
			"[redacted]",
		)
		.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
		.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[redacted]")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted]")
		.replace(/[A-Za-z0-9.-]*\.ts\.net\b/gi, "[redacted]")
		.replace(/(^|[\s(])~?\/[^\s)]*/g, "$1[path]")
		.replace(/\b[\w.-]+\/[\w.-]+#\d+/g, "[ref]")
		.replace(/#\d+/g, "[ref]")
		.replace(/[^A-Za-z0-9 .,:;()'"_/+=\-\n[\]]/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (s.length > max) s = `${s.slice(0, max - 3)}...`;
	return s;
}

/** Scrubbed text as an inert block in a comment. */
export const codeBlock = (s) => `\`\`\`text\n${s}\n\`\`\``;

/** Problems with the agent's commits, from `git diff --name-only`. */
export function agentChangeProblems(files) {
	const bad = matching(files, AGENT_FORBIDDEN);
	return bad.length > 0 ? [`changes files it may not: ${bad.join(", ")}`] : [];
}

/** The agent's result file, validated. */
export function parseResult(text) {
	let r;
	try {
		r = JSON.parse(text);
	} catch {
		return {
			status: "cannot-fix",
			summary: "The agent wrote no readable result.",
		};
	}
	const status = r?.status === "fixed" ? "fixed" : "cannot-fix";
	const summary = typeof r?.summary === "string" ? r.summary : "";
	return { status, summary: summary || "(no summary)" };
}

// --- Effects ---------------------------------------------------------------

const say = (...a) => console.log("dependabot-sweep:", ...a);

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		...opts,
	});
	if (r.error) throw r.error;
	if (r.status !== 0 && !opts.allowFail)
		throw new Error(
			`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").slice(-5).join(" | ")}`,
		);
	return r;
}
const out = (cmd, args, opts) => run(cmd, args, opts).stdout;
const gh = (args, opts) => out("gh", args, opts);
const ghJson = (args, opts) => JSON.parse(gh(args, opts) || "null");

function loadState(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function gatherFacts(n, ctx) {
	const view = (fields) => ghJson(["pr", "view", String(n), "--json", fields]);
	const pr = view(
		"number,title,author,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,mergeable,body,files,comments",
	);
	const sha = pr.headRefOid;
	const commits = ghJson([
		"api",
		`repos/{owner}/{repo}/pulls/${n}/commits?per_page=100`,
	]).map((c) => ({
		sha: c.sha,
		author: c.author?.login ?? null,
		committer: c.committer?.login ?? null,
		verified: c.commit?.verification?.verified === true,
		message: String(c.commit?.message ?? ""),
	}));
	const checksOf = (extra) => {
		const r = run(
			"gh",
			[
				"pr",
				"checks",
				String(n),
				"--json",
				"name,bucket,link,workflow",
				...extra,
			],
			{ allowFail: true },
		);
		try {
			return JSON.parse(r.stdout || "[]");
		} catch {
			return [];
		}
	};
	const checks = checksOf([]);
	const required = [...new Set(checksOf(["--required"]).map((c) => c.name))];
	const runs = {};
	for (const c of checks) {
		const m = /\/actions\/runs\/(\d+)\/job\//.exec(c.link ?? "");
		if (m && !ok(c.bucket) && !runs[m[1]]) {
			const r = ghJson([
				"run",
				"view",
				m[1],
				"--json",
				"attempt,headSha,headBranch,jobs",
			]);
			runs[m[1]] = {
				attempt: r.attempt,
				headSha: r.headSha,
				headBranch: r.headBranch,
				jobs: (r.jobs ?? []).map((j) => ({
					id: j.databaseId,
					name: j.name,
					conclusion: j.conclusion,
					steps: (j.steps ?? []).map((s) => ({
						name: s.name,
						conclusion: s.conclusion,
					})),
				})),
			};
		}
	}
	// What the PR's head changes against where it forked from master
	// (fetched by name, checked), read from git, not from the PR's text.
	const botMessages = commits
		.filter((c) => c.author === BOT)
		.map((c) => c.message);
	const names = dependabotNames(pr.title, botMessages);
	const bump = bumpFromTitle(pr.title);
	let breaking = [];
	let mp = ["its head could not be read"];
	if (BRANCH_RE.test(pr.headRefName) && SHA_RE.test(sha)) {
		run("git", [
			"fetch",
			"-q",
			"origin",
			"master",
			`refs/heads/${pr.headRefName}`,
		]);
		// The PR's head must be what was fetched, or the check below would
		// read another commit: fail rather than skip it.
		const heads = out("git", [
			"ls-remote",
			"origin",
			`refs/heads/${pr.headRefName}`,
		]);
		if (!heads.startsWith(sha))
			throw new Error("the PR's head moved while reading it; next run");
		const base = out("git", ["merge-base", "origin/master", sha]).trim();
		const pkgAt = (rev) => {
			const r = run("git", ["show", `${rev}:package.json`], {
				allowFail: true,
			});
			try {
				return r.status === 0 ? JSON.parse(r.stdout) : null;
			} catch {
				return null;
			}
		};
		const basePkg = pkgAt(base);
		const headPkg = pkgAt(sha);
		const files = out("git", ["diff", "--name-only", base, sha])
			.trim()
			.split("\n")
			.filter(Boolean);
		const addedLockLines = out("git", [
			"diff",
			"--no-ext-diff",
			"--unified=0",
			base,
			sha,
			"--",
			"pnpm-lock.yaml",
		])
			.split("\n")
			.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
			.map((l) => l.slice(1));
		mp = manifestProblems({ files, basePkg, headPkg, names, addedLockLines });
		breaking = breakingBumps(basePkg, headPkg);
		if (bump && isBreaking(bump.from, bump.to))
			breaking.push({ ...bump, kind: "major" });
		if (metadataMajor(botMessages) && breaking.length === 0)
			breaking.push({
				name: names.join(", "),
				from: null,
				to: "a new major",
				kind: "major",
			});
	}
	const mine = (pr.comments ?? []).filter((c) => c.author?.login === ctx.me);
	return {
		pr: {
			...pr,
			author: pr.author?.login ?? "",
			files: (pr.files ?? []).map((x) => x.path),
		},
		commits,
		sweepShas: ctx.state.sweepShas ?? [],
		manifestProblems: mp,
		breaking,
		names,
		agentEnabled: ctx.agentEnabled,
		checks,
		required,
		runs,
		rebaseAsked: Boolean(ctx.state.rebaseAsked?.[sha]),
		agentTried: Boolean(ctx.state.agentTried?.[sha]),
		note: releaseNote(bump, ctx.alerts),
		bump,
		commented: (key) => mine.some((c) => c.body.includes(marker(key))),
	};
}

const marker = (key) => `<!-- crb-sweep:${key} -->`;

function comment(n, text, key, ctx) {
	const file = join(ctx.tmp, `comment-${n}.md`);
	writeFileSync(file, `${text}${key ? `\n\n${marker(key)}` : ""}\n`);
	gh(["pr", "comment", String(n), "--body-file", file]);
}

/** The bubblewrap sandbox the agent (and the PR's install) runs in. */
export function sandboxArgs({ home, repo, worktree, emptyDir, gitdir }) {
	const a = [
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
	];
	const rw = (p) => existsSync(p) && a.push("--bind", p, p);
	const ro = (p) => existsSync(p) && a.push("--ro-bind", p, p);
	const hideDir = (p) => existsSync(p) && a.push("--tmpfs", p);
	const hideFile = (p) => existsSync(p) && a.push("--ro-bind", "/dev/null", p);
	a.push("--tmpfs", "/tmp", "--tmpfs", "/dev/shm");
	rw(worktree);
	rw(join(home, ".cache"));
	rw(join(home, ".local/share/pnpm"));
	// git: only the object store and this worktree's own git dir are
	// writable (commits); the repository's config, hooks and refs aren't,
	// nor the files that say where the worktree's repository is.
	rw(join(repo, ".git/objects"));
	if (gitdir) {
		rw(gitdir);
		ro(join(gitdir, "commondir"));
		ro(join(gitdir, "gitdir"));
	}
	rw(join(home, ".claude"));
	rw(join(home, ".claude.json"));
	for (const p of ["settings.json", "settings.local.json", "CLAUDE.md"])
		ro(join(home, ".claude", p));
	for (const p of [
		"hooks",
		"plugins",
		"skills",
		"agents",
		"commands",
		"output-styles",
	])
		ro(join(home, ".claude", p));
	hideDir(join(home, ".claude/projects")); // transcripts and memory
	hideDir(join(home, ".config"));
	ro(join(home, ".config/carbonless")); // the test queue's config
	ro(join(home, ".config/git")); // the commit identity
	hideDir(join(home, ".local/state"));
	hideDir(join(home, ".ssh"));
	hideDir(join(home, "carbonless-private"));
	hideDir(join(home, ".aws"));
	hideDir(join(home, ".docker"));
	for (const f of [
		".npmrc",
		".netrc",
		".git-credentials",
		".pypirc",
		".bash_history",
	])
		hideFile(join(home, f));
	hideFile(join(repo, "CLAUDE.local.md"));
	hideDir(join(repo, ".superpowers"));
	a.push("--setenv", "GH_CONFIG_DIR", emptyDir);
	for (const v of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
		"LINEAR_API_KEY",
		"NPM_TOKEN",
		"NODE_AUTH_TOKEN",
		"SSH_AUTH_SOCK",
	])
		a.push("--unsetenv", v);
	a.push("--setenv", "GIT_TERMINAL_PROMPT", "0", "--chdir", worktree);
	return a;
}

/** The agent's claude command (inside the sandbox). */
export function agentArgs({ worktree, home }) {
	const w = `/${worktree}`; // "//abs/path": an absolute path rule
	const allowed = [
		`Read(${w}/**)`,
		`Edit(${w}/**)`,
		"Grep",
		"Glob",
		"Bash(pnpm lint)",
		"Bash(pnpm typecheck)",
		"Bash(pnpm test *)",
		"Bash(git status*)",
		"Bash(git diff*)",
		"Bash(git log*)",
		"Bash(git show*)",
		"Bash(git add *)",
		"Bash(git commit *)",
	];
	const h = `/${home}`;
	const denied = [
		"Bash(git -c*)",
		"Bash(git -C*)",
		"Bash(git * -c *)",
		"Bash(git *--exec*)",
		"Bash(git *--ext-diff*)",
		"Bash(git *--textconv*)",
		"Bash(git *--output*)",
		`Edit(${w}/.git)`,
		`Edit(${w}/.github/**)`,
		`Edit(${w}/scripts/release*)`,
		`Edit(${w}/package.json)`,
		`Edit(${w}/pnpm-lock.yaml)`,
		`Edit(${w}/.claude/**)`,
		`Edit(${w}/node_modules/**)`,
		`Edit(${w}/.crb-dev/sweep/pr.json)`,
		`Edit(${w}/.crb-dev/sweep/failure.log)`,
		`Read(${h}/.config/**)`,
		`Read(${h}/.local/state/**)`,
		`Read(${h}/.ssh/**)`,
		`Read(${h}/.claude/**)`,
		`Read(${h}/.claude.json)`,
		`Read(${h}/.npmrc)`,
		`Read(${h}/carbonless-private/**)`,
	];
	return [
		"-p",
		"--safe-mode",
		"--strict-mcp-config",
		"--mcp-config",
		'{"mcpServers":{}}',
		"--setting-sources",
		"project",
		"--name",
		"dependabot-sweep-fix",
		"--tools",
		"Read,Edit,Write,Grep,Glob,Bash",
		"--permission-mode",
		"dontAsk",
		"--permission-prompts",
		"none",
		"--allowedTools",
		...allowed,
		"--disallowedTools",
		...denied,
		"--output-format",
		"stream-json",
		"--verbose",
	];
}

function runAgent(n, facts, action, ctx) {
	const { pr } = facts;
	const sha = pr.headRefOid;
	const wt = join(
		ctx.root,
		".worktrees",
		`dependabot-sweep-${ctx.stamp}-pr${n}`,
	);
	const emptyDir = mkdtempSync(join(ctx.tmp, "gh-"));
	const cleanup = () => {
		run("git", ["worktree", "remove", "--force", wt], { allowFail: true });
	};
	ctx.cleanups.push(cleanup);
	try {
		run("git", ["worktree", "add", "-q", "--detach", wt, sha]);
		// Read now, before anything untrusted runs in the worktree.
		const gitdir = realpathSync(
			out("git", ["-C", wt, "rev-parse", "--absolute-git-dir"]).trim(),
		);
		const box = (cmd) => [
			...sandboxArgs({
				home: ctx.home,
				repo: ctx.root,
				worktree: wt,
				emptyDir,
				gitdir,
			}),
			"--",
			...cmd,
		];
		// The PR's lockfile, installed inside the sandbox (its packages' code
		// is untrusted too).
		run(
			"bwrap",
			box(["pnpm", "install", "--frozen-lockfile", "--prefer-offline"]),
			{
				stdio: ["ignore", "inherit", "inherit"],
			},
		);
		const dir = join(wt, ".crb-dev", "sweep");
		mkdirSync(dir, { recursive: true });
		const log = run(
			"gh",
			[
				"run",
				"view",
				action.failure.runId,
				"--job",
				action.failure.jobId,
				"--log-failed",
			],
			{ allowFail: true },
		).stdout;
		writeFileSync(
			join(dir, "failure.log"),
			log.split("\n").slice(-400).join("\n"),
		);
		writeFileSync(
			join(dir, "pr.json"),
			JSON.stringify(
				{
					number: n,
					title: pr.title,
					branch: pr.headRefName,
					head: sha,
					files: pr.files,
					bump: facts.bump,
					failedCheck: action.failure.check,
					failureKind: action.failure.kind,
				},
				null,
				2,
			),
		);
		const resultFile = join(dir, "result.json");
		const prompt = `${ctx.instructions}\n\n## This run\n\nWorktree: ${wt} (the PR's head, ${sha}, dependencies installed).\nInputs: .crb-dev/sweep/pr.json and .crb-dev/sweep/failure.log.\nWrite your result to .crb-dev/sweep/result.json.\n`;
		const jsonl = join(ctx.stateDir, `${ctx.stamp}-pr${n}.jsonl`);
		say(`#${n}: agent starts (log ${jsonl})`);
		const r = spawnSync(
			"bwrap",
			box([
				"timeout",
				"--kill-after=1m",
				ctx.timeout,
				"claude",
				...agentArgs({ worktree: wt, home: ctx.home }),
			]),
			{ input: prompt, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
		);
		writeFileSync(jsonl, r.stdout ?? "");
		if (r.status !== 0)
			say(
				`#${n}: agent exited ${r.status}: ${(r.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`,
			);
		ctx.state.agentTried = {
			...ctx.state.agentTried,
			[sha]: new Date().toISOString(),
		};
		ctx.saveState();
		const result = parseResult(
			existsSync(resultFile) ? readFileSync(resultFile, "utf8") : "",
		);
		// From here on, nothing the agent could have written is run or
		// trusted: the worktree's HEAD is read as a bare commit id, and every
		// git command runs in the main repository (its config and hooks were
		// read-only to the sandbox).
		let problems = [];
		let head = "";
		let files = [];
		if (result.status === "fixed") {
			head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
			if (!SHA_RE.test(head)) {
				problems.push("its worktree isn't on a plain commit");
			} else {
				const ancestor =
					run("git", ["merge-base", "--is-ancestor", sha, head], {
						allowFail: true,
					}).status === 0;
				if (!ancestor)
					problems.push("its commits don't build on the PR's head");
				else
					files = out("git", ["diff", "--name-only", sha, head])
						.trim()
						.split("\n")
						.filter(Boolean);
				if (ancestor && files.length === 0)
					problems.push("it committed nothing");
				problems = [...problems, ...agentChangeProblems(files)];
			}
		}
		const summary = scrub(result.summary);
		if (result.status !== "fixed" || problems.length > 0) {
			const why =
				problems.length > 0
					? `\n\nNot pushed: ${scrub(problems.join("; "), 300)}.`
					: "";
			comment(
				n,
				`Dependabot sweep: \`${action.failure.check}\` fails and the sweep couldn't fix it. The agent's notes:\n\n${codeBlock(summary)}${why}`,
				`agent:${sha}`,
				ctx,
			);
			return `agent: ${result.status}${problems.length ? ` (refused: ${problems.join("; ")})` : ""}`;
		}
		// One commit of exactly the checked tree on the PR's head, with a
		// fixed message and the trailer (no agent text in git history).
		const msgFile = join(ctx.tmp, `msg-${n}.txt`);
		writeFileSync(
			msgFile,
			`Adapt to ${pr.title.replace(/[^\w .@/-]/g, "").slice(0, 100)}\n\n${TRAILER}: ${ctx.stamp}\n`,
		);
		const newSha = out("git", [
			"commit-tree",
			`${head}^{tree}`,
			"-p",
			sha,
			"-F",
			msgFile,
		]).trim();
		ctx.state.sweepShas = [
			...new Set([...(ctx.state.sweepShas ?? []), newSha]),
		].slice(-500);
		ctx.saveState();
		run("git", [
			"push",
			"-q",
			`--force-with-lease=refs/heads/${pr.headRefName}:${sha}`,
			"origin",
			`${newSha}:refs/heads/${pr.headRefName}`,
		]);
		comment(
			n,
			`Dependabot sweep: pushed ${newSha.slice(0, 7)} to fix \`${action.failure.check}\`. The agent's notes:\n\n${codeBlock(summary)}`,
			`fixed:${newSha}`,
			ctx,
		);
		return `agent: fixed, pushed ${newSha.slice(0, 7)}`;
	} finally {
		cleanup();
		rmSync(emptyDir, { recursive: true, force: true });
	}
}

function baseWorktree(ctx) {
	if (ctx.base) return ctx.base;
	const wt = join(ctx.root, ".worktrees", `dependabot-sweep-${ctx.stamp}-base`);
	ctx.cleanups.push(() =>
		run("git", ["worktree", "remove", "--force", wt], { allowFail: true }),
	);
	run("git", ["worktree", "add", "-q", "--detach", wt, "origin/master"]);
	run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
		cwd: wt,
		stdio: ["ignore", "ignore", "inherit"],
	});
	ctx.base = wt;
	return wt;
}

function mergeOk(n, ctx) {
	const r = run("pnpm", ["release", "merge-ok", String(n)], {
		cwd: baseWorktree(ctx),
		allowFail: true,
	});
	return { ok: r.status === 0, text: `${r.stdout}${r.stderr}`.trim() };
}

function act(n, facts, action, ctx) {
	const { pr } = facts;
	const sha = pr.headRefOid;
	const once = (key, text) => {
		if (facts.commented(key)) return "already commented";
		comment(n, text, key, ctx);
		return "commented";
	};
	switch (action.type) {
		case "skip":
		case "wait":
			return action.type;
		case "owner":
			return once(
				action.key,
				`Dependabot sweep: not merging this automatically: ${action.reason}.`,
			);
		case "rebase": {
			comment(n, "@dependabot rebase", null, ctx);
			ctx.state.rebaseAsked = {
				...ctx.state.rebaseAsked,
				[sha]: new Date().toISOString(),
			};
			ctx.saveState();
			return "asked Dependabot to rebase";
		}
		case "add-note": {
			const file = join(ctx.tmp, `body-${n}.md`);
			writeFileSync(file, `${pr.body.trimEnd()}\n\n${action.note}\n`);
			gh(["pr", "edit", String(n), "--body-file", file]);
			return `added "${action.note}"`;
		}
		case "refresh-note": {
			const m = mergeOk(n, ctx);
			return `merge-ok (reruns the note check): ${m.ok ? "ok" : m.text.split("\n").pop()}`;
		}
		case "rerun": {
			for (const id of action.runIds) gh(["run", "rerun", id, "--failed"]);
			return `reran ${action.runIds.join(", ")}`;
		}
		case "agent":
			return runAgent(n, facts, action, ctx);
		case "merge": {
			const m = mergeOk(n, ctx);
			if (!m.ok) {
				if (/frozen|freeze/i.test(m.text))
					return once(
						`freeze:${sha}`,
						"Dependabot sweep: master is frozen for a release; this waits until the release is out.",
					);
				return `merge-ok refused: ${m.text.split("\n").pop()}`;
			}
			const now = ghJson([
				"pr",
				"view",
				String(n),
				"--json",
				"headRefOid",
			]).headRefOid;
			if (now !== sha) return "head moved; next run";
			gh([
				"pr",
				"merge",
				String(n),
				"--merge",
				"--admin",
				"--match-head-commit",
				sha,
			]);
			return `merged ${sha.slice(0, 7)}`;
		}
		default:
			throw new Error(`unknown action ${action.type}`);
	}
}

function main(argv) {
	let dryRun = false;
	let ref = "";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dry-run") dryRun = true;
		else if (argv[i] === "--ref") ref = argv[++i] ?? "";
		else {
			console.error(`dependabot-sweep: unknown argument ${argv[i]}`);
			return 2;
		}
	}
	const fake = process.env.CRB_SWEEP_PRS;
	if (fake !== undefined && !dryRun) {
		console.error(
			"dependabot-sweep: CRB_SWEEP_PRS is honoured with --dry-run only",
		);
		return 2;
	}
	const root = out("git", ["rev-parse", "--show-toplevel"]).trim();
	process.chdir(root);
	let numbers;
	if (fake !== undefined) {
		numbers = fake.split(/\s+/).filter(Boolean);
		if (numbers.some((x) => !/^\d+$/.test(x))) {
			console.error(`dependabot-sweep: CRB_SWEEP_PRS: not PR numbers: ${fake}`);
			return 2;
		}
	} else {
		numbers = ghJson([
			"pr",
			"list",
			"--author",
			"app/dependabot",
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number",
		])
			.map((p) => String(p.number))
			.sort((a, b) => a - b);
	}
	if (numbers.length === 0) {
		say("no open Dependabot PRs; nothing to do");
		return 0;
	}
	const home = homedir();
	const stateDir = join(
		process.env.XDG_STATE_HOME || join(home, ".local/state"),
		"carbonless",
		"dependabot-sweep",
	);
	const stateFile = join(stateDir, "state.json");
	const instructionsPath = "docs/agents/dependabot-sweep.md";
	const ctx = {
		root,
		home,
		stateDir,
		stamp: new Date().toISOString().replace(/[:.]/g, "").slice(0, 15),
		timeout: process.env.CRB_SWEEP_TIMEOUT || "90m",
		state: loadState(stateFile),
		saveState: () => {
			if (!dryRun)
				writeFileSync(stateFile, `${JSON.stringify(ctx.state, null, 1)}\n`);
		},
		instructions: ref
			? out("git", ["show", `${ref}:${instructionsPath}`])
			: readFileSync(instructionsPath, "utf8"),
		me: gh(["api", "user", "--jq", ".login"]).trim(),
		// The local fix agent is off unless CRB_SWEEP_AGENT=on: a failure the
		// update caused then gets an owner comment instead.
		agentEnabled: process.env.CRB_SWEEP_AGENT === "on",
		alerts: (
			ghJson([
				"api",
				"repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100",
			]) ?? []
		).map((a) => ({
			package: a.dependency?.package?.name,
			ghsa: a.security_advisory?.ghsa_id,
			patched: a.security_vulnerability?.first_patched_version?.identifier,
		})),
		cleanups: [],
		tmp: mkdtempSync(join(tmpdir(), "crb-sweep-")),
	};
	if (!dryRun) mkdirSync(stateDir, { recursive: true });
	const cleanupAll = () => {
		for (const c of ctx.cleanups.splice(0)) c();
		rmSync(ctx.tmp, { recursive: true, force: true });
	};
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"])
		process.on(sig, () => {
			cleanupAll();
			process.exit(143);
		});
	const lines = [];
	let failed = false;
	try {
		for (const n of numbers) {
			let line;
			try {
				const facts = gatherFacts(n, ctx);
				const action = decide(facts);
				if (dryRun) {
					line = `#${n} ${facts.pr.title} | would: ${action.type} (${action.reason})`;
					if (action.type === "add-note") line += ` "${action.note}"`;
					if (action.type === "agent")
						line += `\n    agent: bwrap <sandbox> -- timeout ${ctx.timeout} claude ${agentArgs({ worktree: "<worktree>", home }).join(" ")}`;
				} else {
					const result = act(n, facts, action, ctx);
					line = `#${n} ${facts.pr.title} | ${action.type} (${action.reason}) | ${result}`;
				}
			} catch (e) {
				failed = true;
				line = `#${n} | error: ${e.message}`;
			}
			say(line);
			lines.push(line);
		}
	} finally {
		cleanupAll();
	}
	if (!dryRun)
		appendFileSync(
			join(stateDir, `${ctx.stamp.slice(0, 8)}.log`),
			`${ctx.stamp}\n${lines.join("\n")}\n`,
		);
	if (failed) say("FAILED: one or more PRs hit an error (above)");
	return failed ? 1 : 0;
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
	// One sweep at a time: re-run under flock unless already holding it.
	if (!process.env.CRB_SWEEP_LOCKED && !process.argv.includes("--dry-run")) {
		const dir = join(
			process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
			"carbonless",
			"dependabot-sweep",
		);
		mkdirSync(dir, { recursive: true });
		const r = spawnSync(
			"flock",
			[
				"-n",
				"-E",
				"75",
				join(dir, ".lock"),
				process.execPath,
				self,
				...process.argv.slice(2),
			],
			{ stdio: "inherit", env: { ...process.env, CRB_SWEEP_LOCKED: "1" } },
		);
		if (r.status === 75) {
			say("another sweep is running; not starting a second");
			process.exit(0);
		}
		process.exit(r.status ?? 1);
	}
	process.exit(main(process.argv.slice(2)));
}
