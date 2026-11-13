#!/usr/bin/env node
// A page for the owner's QA of word diff step 2 (CAR-30): over a corpus of
// public PRs (scripts/pairing-corpus.mjs), every unequal cluster whose layout
// step 2's similarity pairing changes, today's side by side (by position)
// next to step 2's (a pair on one row), with the pair scores, worst first.
// Carbonless's own pipeline does the diffing (DIFF_ARGS, buildSnapshot,
// loadFileHunks, hunkView, layoutRows). Not CI; no corpus data lives here.
//
//   node scripts/pairing-compare.mjs <corpus dir> <out.html>
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "tsx/esm/api";

const [corpus, outFile] = process.argv.slice(2);
if (!corpus || !outFile) {
	console.error(
		"usage: node scripts/pairing-compare.mjs <corpus dir> <out.html>",
	);
	process.exit(2);
}
const CAP = 300;

register();
const here = new URL(".", import.meta.url).href;
const load = (p) => import(new URL(p, here).href);
const { buildSnapshot, loadFileHunks } = await load(
	"../src/server/diff/snapshot.ts",
);
const { hunkView } = await load("../src/web/files/whitespace.ts");
const { layoutRows } = await load("../src/web/files/sideBySide.ts");
const { lineSimilarity } = await load("../src/web/files/linePairing.ts");
const { wordMarks } = await load("../src/web/files/wordDiff.ts");
const lib = await load("./pairing-compare-lib.ts");
const { esc, markup } = lib;

const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			HOME: tmpdir(),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "c",
			GIT_AUTHOR_EMAIL: "c@example.com",
			GIT_COMMITTER_NAME: "c",
			GIT_COMMITTER_EMAIL: "c@example.com",
		},
		maxBuffer: 64 * 1024 * 1024,
	}).trim();

const copyTree = (from, to, paths) => {
	for (const p of paths) {
		mkdirSync(dirname(join(to, p)), { recursive: true });
		writeFileSync(join(to, p), readFileSync(join(from, p)));
	}
};

const stats = {
	prs: 0,
	files: 0,
	clusters: 0,
	unequal: 0,
	changed: 0,
	equalChanged: 0,
	skipped: 0,
};
const cases = [];
const hash = (s) => {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	return (h >>> 0).toString(36).slice(0, 4);
};

for (const lang of readdirSync(corpus, { withFileTypes: true })) {
	if (!lang.isDirectory()) continue;
	for (const prName of readdirSync(join(corpus, lang.name))) {
		const dir = join(corpus, lang.name, prName);
		let meta;
		try {
			meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
		} catch {
			continue;
		}
		const repo = mkdtempSync(join(tmpdir(), "pairing-compare-"));
		try {
			git(repo, "init", "--quiet", "--initial-branch=main");
			copyTree(
				join(dir, "base"),
				repo,
				meta.files.map((f) => f.previous ?? f.path),
			);
			git(repo, "add", "-A");
			git(repo, "commit", "--quiet", "-m", "base");
			const base = git(repo, "rev-parse", "HEAD");
			for (const f of meta.files)
				if (f.previous) rmSync(join(repo, f.previous));
			copyTree(
				join(dir, "head"),
				repo,
				meta.files.map((f) => f.path),
			);
			git(repo, "add", "-A");
			git(repo, "commit", "--quiet", "-m", "head");
			const head = git(repo, "rev-parse", "HEAD");
			const snapshot = await buildSnapshot(repo, base, head);
			stats.prs++;
			for (let index = 0; index < snapshot.files.length; index++) {
				const file = snapshot.files[index];
				if (file.binary) continue;
				stats.files++;
				const { hunks } = await loadFileHunks(repo, snapshot, index, {
					headings: false,
				});
				for (const hunk of hunks) {
					const view = hunkView(hunk.lines, false);
					for (const run of view.runs) {
						if (run.key === undefined) continue;
						stats.clusters++;
						const gitLines = run.lines;
						const dels = gitLines.filter((l) => l.kind === "del");
						const adds = gitLines.filter((l) => l.kind === "add");
						const unequal =
							dels.length > 0 && adds.length > 0 && dels.length !== adds.length;
						const at = new Map(gitLines.map((l, i) => [l, i]));
						const gitRows = gitLines.map((line) => ({ kind: "line", line }));
						const todaySide = layoutRows(gitRows);
						const step2Side = layoutRows(run.rows, view.partners);
						const layouts = {
							today: lib.rowIndexes(todaySide, at),
							step2: lib.rowIndexes(step2Side, at),
							todayUnified: gitLines.map((_, i) => i),
							step2Unified: run.rows.flatMap((r) =>
								r.kind === "line" ? [at.get(r.line)] : [],
							),
							pairs: lib.pairIndexes(view.pairs, at),
							// Step 1 marks only an equal cluster, i-th with i-th.
							todayPairs:
								dels.length > 0 && dels.length === adds.length
									? dels.map((d, i) => [at.get(d), at.get(adds[i])])
									: [],
						};
						if (unequal) stats.unequal++;
						if (!lib.changedByStep2(layouts)) continue;
						if (!unequal) {
							stats.equalChanged++;
							continue;
						}
						stats.changed++;
						const scores = layouts.pairs.map(([d, a]) =>
							lineSimilarity(gitLines[d].text, gitLines[a].text),
						);
						const scoreOf = new Map(
							layouts.pairs.map(([d], i) => [d, scores[i]]),
						);
						const marks = new Map();
						for (const [d, a] of layouts.pairs) {
							const m = wordMarks(gitLines[d].text, gitLines[a].text);
							marks.set(d, m.old);
							marks.set(a, m.new);
						}
						const source = `${meta.repo}#${meta.number} ${file.path}`;
						const first = gitLines.find((l) => l.kind === "add") ?? gitLines[0];
						const where = `L${first.newNo ?? first.oldNo}`;
						cases.push({
							id: `P${hash(`${source}:${where}`)}`,
							source,
							where,
							lang: meta.lang,
							size: gitLines.length,
							dels: dels.length,
							adds: adds.length,
							minScore: Math.min(...scores),
							move: lib.farthestMove(layouts),
							layouts,
							gitLines,
							scoreOf,
							marks,
						});
					}
				}
			}
		} catch (e) {
			stats.skipped++;
			console.error(`skipped ${prName}: ${String(e.message).split("\n")[0]}`);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}
}

cases.sort(lib.byWorst);
const shown = cases.slice(0, CAP);

const cell = (c, i, side, score) => {
	if (i === null) return `<td class="n"></td><td class="c empty"></td>`;
	const l = c.gitLines[i];
	const no = side === "old" ? l.oldNo : l.newNo;
	const text = score ? markup(l.text, c.marks.get(i)) : esc(l.text);
	const word = score && c.marks.get(i)?.length ? " w" : "";
	return `<td class="n">${no ?? ""}</td><td class="c ${side}${word}"><div class="x"><code>${text || "&nbsp;"}</code></div></td>`;
};
const table = (c, rows, step2) =>
	`<div class="tbl"><table>${rows
		.map(([d, a]) => {
			const s =
				step2 &&
				d !== null &&
				a !== null &&
				c.scoreOf.get(d) !== undefined &&
				c.layouts.pairs.some(([pd, pa]) => pd === d && pa === a)
					? `<span class="score" title="line similarity">${c.scoreOf.get(d).toFixed(2)}</span>`
					: "";
			return `<tr>${cell(c, d, "old", step2)}<td class="s">${s}</td>${cell(c, a, "new", step2)}</tr>`;
		})
		.join("")}</table></div>`;
const unified = (c) =>
	`<div class="tbl"><table>${c.layouts.step2Unified
		.map((i) => {
			const l = c.gitLines[i];
			return `<tr><td class="n">${l.kind === "del" ? (l.oldNo ?? "") : (l.newNo ?? "")}</td><td class="c ${l.kind === "del" ? "old" : "new"}"><div class="x"><code>${markup(l.text, c.marks.get(i)) || "&nbsp;"}</code></div></td></tr>`;
		})
		.join("")}</table></div>`;

const card = (c, n) => `<article id="${c.id}">
<header><b class="id">${c.id}</b><span class="src">${esc(c.source)} <i>${c.where}</i></span>
<span class="facts" title="lowest pair score, farthest row move, lines removed/added">min ${c.minScore.toFixed(2)} · move ${c.move} · −${c.dels}/+${c.adds}</span><span class="rank">#${n + 1}</span></header>
<div class="cols"><section><h3>Today</h3>${table(c, c.layouts.today, false)}</section>
<section><h3>Step 2</h3>${table(c, c.layouts.step2, true)}</section></div>
<details><summary>Unified, step 2</summary>${unified(c)}</details></article>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pairing compare</title>
<style>
:root{--canvas:#0b0d16;--surface:#12141f;--raised:#191c2b;--line:#262a3d;--ink:#f4f1ec;--muted:#a0a2c6;--code:#0e1019;--code-ink:#e6e3f2;
--add:#0f2b22;--add-ink:#74e8ac;--del:#2d1221;--del-ink:#ff94aa;--add-word:#1e5a43;--del-word:#5c2441;--warn:#f5b625;--accent:#8fa6ff}
*{box-sizing:border-box}html{background:var(--canvas)}
body{margin:0;padding:16px;background:var(--canvas);color:var(--ink);font:15px/1.45 system-ui,sans-serif;max-width:1500px;margin-inline:auto}
h1{font-size:20px;margin:0 0 12px}h3{font-size:12px;margin:0 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:16px}
.counts div{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.counts b{display:block;font-size:20px}.counts span{color:var(--muted);font-size:12px}
.note{color:var(--muted);font-size:13px;margin:0 0 16px}
article{background:var(--surface);border:1px solid var(--line);border-radius:10px;margin-bottom:16px;padding:10px;min-width:0}
article>header{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin-bottom:8px}
.id{background:var(--raised);border-radius:6px;padding:2px 8px;color:var(--accent)}
.src{overflow-wrap:anywhere;flex:1 1 200px}.src i{color:var(--muted)}.facts{color:var(--warn);font-size:13px}.rank{color:var(--muted);font-size:13px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:900px){.cols{grid-template-columns:1fr}}
section{min-width:0}.tbl{overflow-x:auto;background:var(--code);border-radius:6px}
table{border-collapse:collapse;width:100%;table-layout:fixed;font:12px/1.5 ui-monospace,Menlo,monospace}
.x{overflow-x:auto;scrollbar-width:thin}
td{vertical-align:top;padding:0 4px;min-height:40px}td.n{color:var(--muted);text-align:right;width:4.5ch;user-select:none}
td.c{white-space:pre;color:var(--code-ink)}td.c.old{background:var(--del)}td.c.new{background:var(--add)}td.empty{background:var(--code)!important}
td.c.old.w mark{background:var(--del-word)}td.c.new.w mark{background:var(--add-word)}mark{color:inherit}
td.s{width:4ch;padding:0;text-align:center}.score{color:var(--warn);font-size:11px;white-space:nowrap}
details{margin-top:8px}summary{cursor:pointer;color:var(--muted);font-size:13px;min-height:40px;display:flex;align-items:center}
</style></head><body>
<h1>Step 2 pairing vs today, real PRs</h1>
<div class="counts">
<div><b>${stats.prs}</b><span>PRs</span></div><div><b>${stats.files}</b><span>files</span></div>
<div><b>${stats.clusters}</b><span>clusters seen</span></div><div><b>${stats.unequal}</b><span>unequal clusters</span></div>
<div><b>${stats.changed}</b><span>changed by step 2</span></div></div>
<p class="note">${shown.length < cases.length ? `Showing the worst ${shown.length} of ${cases.length} cases; ${cases.length - shown.length} cut. ` : `All ${cases.length} cases shown. `}Worst first: lowest pair score, then farthest row move, then cluster size. Files were picked for having both removed and added lines, so unequal clusters are over-represented. Equal clusters changed by step 2: ${stats.equalChanged}.</p>
${shown.map(card).join("\n")}
</body></html>`;
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.error(
	JSON.stringify({ ...stats, cases: cases.length, shown: shown.length }),
);
