#!/usr/bin/env node
// Builds the corpus for scripts/pairing-compare.mjs: recent merged PRs of
// popular public repos, with the base (merge base) and head contents of a few
// changed text files each. Read-only: `gh api` GETs only. The corpus lives
// outside the repo (its data is other people's code); nothing in this script
// is corpus data.
//
//   node scripts/pairing-corpus.mjs <corpus dir> [--per-language N] [--files N]
//
// Layout: <dir>/<lang>/<owner>__<repo>__<number>/{meta.json, base/<path>, head/<path>}
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPOS = {
	ts: [
		"microsoft/vscode",
		"vercel/next.js",
		"angular/angular",
		"microsoft/TypeScript",
		"vuejs/core",
		"sveltejs/svelte",
	],
	go: [
		"kubernetes/kubernetes",
		"moby/moby",
		"hashicorp/terraform",
		"prometheus/prometheus",
		"gohugoio/hugo",
		"etcd-io/etcd",
	],
	python: [
		"django/django",
		"pandas-dev/pandas",
		"python/cpython",
		"fastapi/fastapi",
		"scikit-learn/scikit-learn",
		"psf/requests",
	],
	java: [
		"spring-projects/spring-boot",
		"elastic/elasticsearch",
		"apache/kafka",
		"spring-projects/spring-framework",
		"google/guava",
		"apache/dubbo",
	],
	csharp: [
		"dotnet/runtime",
		"dotnet/aspnetcore",
		"dotnet/roslyn",
		"dotnet/efcore",
		"dotnet/sdk",
		"JamesNK/Newtonsoft.Json",
	],
	rust: [
		"rust-lang/rust",
		"tokio-rs/tokio",
		"denoland/deno",
		"rust-lang/cargo",
		"astral-sh/ruff",
		"BurntSushi/ripgrep",
	],
};

const TEXT = /\.(ts|tsx|js|jsx|mjs|go|py|java|cs|rs|kt|rb|c|cc|cpp|h|hpp|md)$/i;
const SKIP =
	/(^|\/)(vendor|node_modules|dist|build|testdata|__snapshots__|generated|\.yarn)\/|\.(min\.js|lock|snap|pb\.go|d\.ts|svg|json|yaml|yml)$|(^|\/)(go\.sum|package-lock\.json)$|(_generated|\.generated|\.g|\.designer)\./i;
const MAX_BYTES = 200 * 1024;

const args = process.argv.slice(2);
const dir = args[0];
const flag = (name, dflt) => {
	const i = args.indexOf(name);
	return i < 0 ? dflt : Number(args[i + 1]);
};
if (!dir || dir.startsWith("--")) {
	console.error(
		"usage: node scripts/pairing-corpus.mjs <corpus dir> [--per-language N] [--files N]",
	);
	process.exit(2);
}
const perLanguage = flag("--per-language", 25);
const filesPerPr = flag("--files", 4);

async function gh(path, raw = false) {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { stdout } = await run(
				"gh",
				[
					"api",
					"--method",
					"GET",
					...(raw ? ["-H", "Accept: application/vnd.github.raw"] : []),
					path,
				],
				{ maxBuffer: 16 * 1024 * 1024 },
			);
			return raw ? stdout : JSON.parse(stdout);
		} catch (e) {
			const msg = String(e.stderr ?? e);
			if (/404|403.*(too large|not found)|Not Found/i.test(msg)) return null;
			if (attempt === 2) return null;
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
		}
	}
	return null;
}

async function rateLeft() {
	const r = await gh("rate_limit");
	return r?.resources?.core?.remaining ?? 0;
}

function write(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

async function fetchPr(lang, repo, number) {
	const pr = await gh(`repos/${repo}/pulls/${number}`);
	if (!pr?.merged_at || pr.changed_files > 40) return false;
	const files = await gh(`repos/${repo}/pulls/${number}/files?per_page=100`);
	if (!files) return false;
	const picked = files
		.filter(
			(f) =>
				(f.status === "modified" || f.status === "renamed") &&
				f.additions > 0 &&
				f.deletions > 0 &&
				f.changes <= 400 &&
				TEXT.test(f.filename) &&
				!SKIP.test(f.filename),
		)
		.sort((a, b) => b.changes - a.changes)
		.slice(0, filesPerPr);
	if (picked.length === 0) return false;
	const cmp = await gh(`repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`);
	const mergeBase = cmp?.merge_base_commit?.sha;
	if (!mergeBase) return false;
	const out = join(dir, lang, `${repo.replace("/", "__")}__${number}`);
	const kept = [];
	for (const f of picked) {
		const oldPath = f.previous_filename ?? f.filename;
		const [oldText, newText] = await Promise.all([
			gh(`repos/${repo}/contents/${oldPath}?ref=${mergeBase}`, true),
			gh(`repos/${repo}/contents/${f.filename}?ref=${pr.head.sha}`, true),
		]);
		if (oldText == null || newText == null) continue;
		if (
			Buffer.byteLength(oldText) > MAX_BYTES ||
			Buffer.byteLength(newText) > MAX_BYTES ||
			oldText.includes("\0") ||
			newText.includes("\0")
		)
			continue;
		write(join(out, "base", oldPath), oldText);
		write(join(out, "head", f.filename), newText);
		kept.push({ path: f.filename, previous: f.previous_filename ?? null });
	}
	if (kept.length === 0) return false;
	write(
		join(out, "meta.json"),
		JSON.stringify({ lang, repo, number, title: pr.title, files: kept }),
	);
	return true;
}

for (const [lang, repos] of Object.entries(REPOS)) {
	const perRepo = Math.ceil(perLanguage / repos.length);
	let got = 0;
	for (const repo of repos) {
		if (got >= perLanguage) break;
		if ((await rateLeft()) < 300) {
			console.error("rate limit nearly spent; stopping");
			process.exit(1);
		}
		const list = await gh(
			`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=60`,
		);
		let fromRepo = 0;
		for (const p of list ?? []) {
			if (fromRepo >= perRepo || got >= perLanguage) break;
			if (!p.merged_at || p.user?.type === "Bot") continue;
			if (await fetchPr(lang, repo, p.number)) {
				fromRepo++;
				got++;
			}
		}
		console.error(`${lang} ${repo}: ${fromRepo} PRs`);
	}
	console.error(`${lang}: ${got} PRs`);
}
