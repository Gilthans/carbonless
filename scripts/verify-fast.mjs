#!/usr/bin/env node
// Fast pre-check for a change: lint, typecheck, the unit tests related to the
// changed files (Vitest --changed) and only the e2e specs mapped to them.
// `pnpm verify` stays the gate before saying work is done.
//
//   pnpm verify:fast [base] [--dry-run] [--project=chromium|phone]
//
// base: a git ref to diff against; default $CRB_BASE, else the local branch
// this one forked from most recently (fewest commits since the merge-base).
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const passthrough = args.filter((a) => a.startsWith("--") && a !== "--dry-run");

const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

const base =
	args.find((a) => !a.startsWith("--")) ?? process.env.CRB_BASE ?? forkPoint();

/** The local branch with the fewest commits between its merge-base and HEAD. */
function forkPoint() {
	const current = git("rev-parse", "--abbrev-ref", "HEAD");
	let best = { ref: "HEAD", ahead: Number.POSITIVE_INFINITY };
	for (const ref of lines(
		git("for-each-ref", "--format=%(refname:short)", "refs/heads"),
	)) {
		if (ref === current) continue;
		let mb;
		try {
			mb = git("merge-base", "HEAD", ref);
		} catch {
			continue;
		}
		const ahead = Number(git("rev-list", "--count", `${mb}..HEAD`));
		if (ahead < best.ahead) best = { ref, ahead };
	}
	return best.ref;
}

// Committed since base, staged, unstaged and untracked.
const changed = [
	...new Set([
		...lines(git("diff", "--name-only", base)),
		...lines(git("ls-files", "--others", "--exclude-standard")),
	]),
];

const specs = readdirSync("e2e")
	.filter((f) => f.endsWith(".spec.ts"))
	.map((f) => f.replace(/\.spec\.ts$/, ""));

// Path patterns to the e2e specs (names under e2e/) that cover them. A source
// file matching none of these runs the whole e2e suite: unmapped means unknown,
// not untested. Files outside src/, e2e/ and test/ (docs, scripts) run none.
const E2E_MAP = [
	[
		/^src\/web\/(overview|threads)\/|^src\/server\/(overview|overviewRead|threadCode|timeline)\.ts$|^src\/web\/(GithubHtml|githubHtml)/,
		["overview", "timeline", "mobile"],
	],
	[/^src\/web\/threads\//, ["files-threads", "thread-people"]],
	[
		/^src\/web\/files\/(ThreadRow|FilesPage)\.tsx$|^src\/web\/overview\/OverviewPage\.tsx$|^test\/fake-gh\/(demo-threads|showcase)\.ts$|^src\/web\/index\.css$/,
		["thread-people"],
	],
	[
		/^src\/web\/threads\/|^src\/web\/overview\/(OverviewPage|WriteWarnings)\.tsx$|^src\/web\/files\/(SyncNotices|ThreadRow)\.tsx$|^src\/server\/(threadWrites|app)\.ts$/,
		["thread-writes", "comment-edits"],
	],
	[
		/^src\/web\/files\/|^src\/server\/diff\//,
		[
			"files",
			"files-threads",
			"sticky",
			"invisibles",
			"whitespace",
			"mobile",
			"saves",
		],
	],
	[
		/^src\/web\/files\/(codeSpan|linePicks|selectionActions|SelectionBar|DiffBody|FileDiff|SyncNotices)\.tsx?$|^src\/web\/threads\/(NewThread|newThreads|drafts|threadWrites|spanMarks)\.tsx?$|^src\/web\/code\/Invisibles\.tsx$|^src\/server\/(newThreads|marker)\.ts$/,
		["new-threads"],
	],
	[/^src\/server\/review\//, ["files", "persistence"]],
	[/^src\/server\/home\/|^src\/shared\/home\.ts$/, ["home-api", "home"]],
	[/^src\/web\/home\/|^src\/web\/router\.tsx$/, ["home"]],
	[/^src\/web\/code\//, ["invisibles", "whitespace", "files"]],
	[/^src\/web\/shortcuts\.tsx$/, ["shortcuts", "settings", "home"]],
	[
		/^src\/web\/(Settings\.tsx|viewSettings\.ts)$/,
		["settings", "invisibles", "whitespace", "shortcuts"],
	],
	[/^src\/web\/sticky\.ts$/, ["sticky", "files"]],
	[
		/^src\/server\/asOf\.ts$|^src\/web\/(HeadBanner|RelativeTime)\.tsx$/,
		["asof", "overview", "pinned-head"],
	],
	[/^src\/server\/pinnedHead\.ts$/, ["pinned-head"]],
	[
		/^src\/web\/(brand\/|Tooltip\.tsx$|theme)|^src\/web\/index\.css$/,
		["design", "mobile"],
	],
	[/^src\/web\/pageActive\.ts$/, ["keepalive"]],
	[/^src\/server\/access\.ts$|^src\/web\/accessKey\.ts$/, ["cli", "keepalive"]],
	[/^test\/methodology-fixture\.ts$/, ["methodology"]],
	[/^e2e\/files-ui\.ts$/, ["files", "sticky", "mobile"]],
	[
		/^src\/(cli|client)\.ts$|^src\/server\/(serve|registry|serverState|config|paths|version|app)\.ts$|^src\/web\/(router\.tsx|reviewId\.ts|api\.ts|App\.tsx|pages\.tsx)$|^scripts\/build-info\.mjs$/,
		["serve", "cli"],
	],
];
// Shared plumbing: anything here can break any spec.
const ALL =
	/^(e2e\/(fixtures|pr-setup)\.ts|test\/(fake-gh|git-fixture)|playwright\.config|vite\.config|package\.json|pnpm-lock|tsconfig)/;

const e2e = new Set();
let allE2e = false;
const reasons = [];
for (const file of changed) {
	// Unit-test-only files.
	if (
		/\.test\.tsx?$|^test\/(setup|diff-fixture|pr-fixture|methodology-matrix)\.ts$|^vitest\.config/.test(
			file,
		)
	) {
		continue;
	}
	const spec = file.match(/^e2e\/(.+)\.spec\.ts$/);
	if (spec?.[1]) {
		e2e.add(spec[1]);
		continue;
	}
	if (ALL.test(file)) {
		allE2e = true;
		reasons.push(`${file} -> all`);
		continue;
	}
	const hits = E2E_MAP.filter(([re]) => re.test(file)).flatMap(([, s]) => s);
	if (hits.length) {
		for (const s of hits) e2e.add(s);
	} else if (/^(src|e2e|test)\//.test(file)) {
		allE2e = true;
		reasons.push(`${file} -> all (unmapped)`);
	}
}
for (const s of e2e) if (!specs.includes(s)) e2e.delete(s);

console.log(`verify:fast against ${base}: ${changed.length} changed file(s)`);
for (const r of reasons) console.log(`  ${r}`);
console.log(
	`  e2e: ${allE2e ? "all specs" : e2e.size ? [...e2e].join(", ") : "none"}`,
);

const steps = [
	["pnpm", ["lint"]],
	["pnpm", ["typecheck"]],
	["pnpm", ["exec", "vitest", "run", "--changed", base, "--passWithNoTests"]],
];
if (allE2e || e2e.size) {
	steps.push(["pnpm", ["build"]]);
	const files = allE2e ? [] : [...e2e].map((s) => `e2e/${s}.spec.ts`);
	// The whole suite waits its turn on the machine (scripts/queue.mjs).
	steps.push([
		"node",
		[
			"scripts/queue.mjs",
			"--unless-filtered",
			"pnpm",
			"exec",
			"playwright",
			"test",
			...files,
			...passthrough,
		],
	]);
}

for (const [cmd, a] of steps) {
	console.log(`\n$ ${cmd} ${a.join(" ")}`);
	if (dryRun) continue;
	const { status } = spawnSync(cmd, a, { stdio: "inherit" });
	if (status !== 0) process.exit(status ?? 1);
}
