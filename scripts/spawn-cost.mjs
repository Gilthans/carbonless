#!/usr/bin/env node
// What a git process costs to start here, against a read through a running
// `git cat-file --batch` (CAR-320; docs/test-profiling.md, "Processes per
// request"). CI's Windows job prints it: `pnpm spawn-counts`' counts times
// this cost is what a page waits on processes there.
//
//   node scripts/spawn-cost.mjs [runs]   (default 20; in a git checkout)
import { execFileSync, spawn } from "node:child_process";

const runs = Number(process.argv[2]) || 20;
const head = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
const files = execFileSync("git", ["ls-tree", "--name-only", head], {
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean);
const names = Array.from(
	{ length: runs },
	(_, i) => `${head}:${files[i % files.length]}`,
);

const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;

// One process per read, as crb read each file before.
let start = process.hrtime.bigint();
for (const name of names) {
	execFileSync("git", ["cat-file", "-t", name], { encoding: "utf8" });
}
const each = ms(start);

// One long-running process, every read through it (catFile.ts).
start = process.hrtime.bigint();
await new Promise((resolve, reject) => {
	const child = spawn("git", ["cat-file", "--batch-check"]);
	let out = "";
	child.stdout.on("data", (c) => {
		out += c;
		if (out.split("\n").length > names.length) child.stdin.end();
	});
	child.on("error", reject);
	child.on("close", resolve);
	child.stdin.write(names.map((n) => `${n}\n`).join(""));
});
const batched = ms(start);

console.log(
	`${process.platform}: ${runs} reads, a git each: ${each.toFixed(0)} ms (${(each / runs).toFixed(1)} ms per process); through one cat-file --batch: ${batched.toFixed(0)} ms`,
);
