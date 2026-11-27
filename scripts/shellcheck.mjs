#!/usr/bin/env node
// Runs a pinned shellcheck on every tracked shell script (`pnpm lint`,
// CAR-314): files named *.sh or *.bash, any file whose first line is a
// sh/bash shebang (test/fake-gh/gh), and the bash `run:` steps of
// .github/workflows/*.yml (reported at their line in the workflow). Disable a
// check inline with a reason: `# shellcheck disable=SCnnnn # why`.
//
//   node scripts/shellcheck.mjs [--shellcheck-flag=value...] [files...]
//
// The binary is koalaman/shellcheck's release for this platform, downloaded
// once into node_modules/.cache/shellcheck/<version>/ and checked against the
// sha256 below (GitHub's digest of that asset). Windows has no tarball
// release and no job lints there: it skips, saying so. To move the pin, take
// the new release's `.tar.gz` digests from
// `gh api repos/koalaman/shellcheck/releases/tags/<tag>`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "v0.11.0";

const SHA256 = {
	"linux.x86_64":
		"b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6",
	"linux.aarch64":
		"68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc",
	"darwin.x86_64":
		"c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51",
	"darwin.aarch64":
		"339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f",
};

/** The release asset's platform part for Node's platform and arch, or null. */
export function assetFor(platform, arch) {
	const os = { linux: "linux", darwin: "darwin" }[platform];
	const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
	const key = os && cpu ? `${os}.${cpu}` : null;
	return key && key in SHA256 ? key : null;
}

/** Whether a file's text starts with a sh or bash shebang. */
export function isShellShebang(text) {
	const first = text.slice(0, text.indexOf("\n") >>> 0);
	return /^#!\s*\S*\/(?:env\s+(?:-\S+\s+)*)?(?:ba)?sh(?:\s|$)/.test(first);
}

/** The tracked shell scripts among `paths` (repo-relative), read from `root`. */
export function shellScripts(root, paths) {
	return paths.filter((p) => {
		if (/\.(?:sh|bash)$/.test(p)) return true;
		if (/\.(?:[cm]?[jt]sx?|json|md|css|ya?ml|html|svg|png)$/.test(p))
			return false;
		const full = join(root, p);
		if (!existsSync(full)) return false;
		const head = readFileSync(full).subarray(0, 200).toString("utf8");
		return isShellShebang(head);
	});
}

async function ensureBinary(root, asset) {
	const dir = join(root, "node_modules", ".cache", "shellcheck", VERSION);
	const bin = join(dir, "shellcheck");
	if (existsSync(bin)) return bin;
	const name = `shellcheck-${VERSION}.${asset}.tar.gz`;
	const url = `https://github.com/koalaman/shellcheck/releases/download/${VERSION}/${name}`;
	console.error(`shellcheck: downloading ${name}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`shellcheck: ${url}: HTTP ${res.status}`);
	const body = Buffer.from(await res.arrayBuffer());
	const sum = createHash("sha256").update(body).digest("hex");
	if (sum !== SHA256[asset])
		throw new Error(
			`shellcheck: ${name} has sha256 ${sum}, expected ${SHA256[asset]}`,
		);
	const tmp = `${dir}.tmp-${process.pid}`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	const tgz = join(tmp, name);
	writeFileSync(tgz, body);
	const tar = spawnSync(
		"tar",
		["-xzf", tgz, "-C", tmp, "--strip-components=1"],
		{ stdio: "inherit" },
	);
	if (tar.status !== 0) throw new Error(`shellcheck: tar failed on ${name}`);
	chmodSync(join(tmp, "shellcheck"), 0o755);
	rmSync(tgz);
	mkdirSync(dirname(dir), { recursive: true });
	try {
		renameSync(tmp, dir);
	} catch (e) {
		// Another lint run got there first.
		rmSync(tmp, { recursive: true, force: true });
		if (!existsSync(bin)) throw e;
	}
	return bin;
}

/** Whether a path is a GitHub Actions workflow. */
export function isWorkflow(path) {
	return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

const indentOf = (l) => l.length - l.trimStart().length;

/**
 * The shell of every `run:` step in a workflow's text, as `{ line, indent,
 * script }`: `line` is the 1-based line its first script line is on,
 * `indent` the columns dedented away. `${{ … }}` becomes `_GHA_EXPR_` (same
 * shape for shellcheck, a plain word). Steps that run another shell (a
 * `shell:` other than bash or sh, or a Windows job's default pwsh) are left
 * out. Line-based, for the plain block style our workflows use.
 */
export function workflowRunBlocks(text) {
	const lines = text.split("\n");
	const blocks = [];
	let windowsJob = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		// A job (two-space key under `jobs:`): note whether it runs on Windows.
		if (/^ {2}[\w-]+:\s*$/.test(l)) {
			windowsJob = false;
			for (let j = i + 1; j < lines.length; j++) {
				if (/^ {0,2}\S/.test(lines[j])) break;
				if (/^ {4}runs-on:.*windows/.test(lines[j])) windowsJob = true;
			}
		}
		const m = /^(\s*)(?:- )?run:\s?(.*)$/.exec(l);
		if (!m) continue;
		const runIndent = indentOf(l) + (l.trimStart().startsWith("- ") ? 2 : 0);
		const shell = stepShell(lines, i, runIndent);
		if (shell ? !/^(?:ba)?sh\b/.test(shell) : windowsJob) continue;
		const value = m[2].replace(/\s+#.*$/, "");
		let body;
		let first = i + 1;
		if (/^[|>][-+]?$/.test(value.trim())) {
			body = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const b = lines[j];
				if (b.trim() !== "" && indentOf(b) <= runIndent) break;
				body.push(b);
			}
			while (body.length && body[body.length - 1].trim() === "") body.pop();
			i = j - 1;
		} else {
			body = [m[2]];
			first = i;
		}
		const indent = Math.min(
			...body.filter((b) => b.trim() !== "").map(indentOf),
		);
		if (!Number.isFinite(indent)) continue;
		const script = body
			.map((b) => b.slice(Math.min(indent, indentOf(b))))
			.join("\n")
			.replace(/\$\{\{[^}]*\}\}/g, "_GHA_EXPR_");
		blocks.push({
			line: first + 1,
			indent: first === i ? l.indexOf(m[2]) : indent,
			script: `${script}\n`,
		});
	}
	return blocks;
}

/** The `shell:` of the step whose `run:` is at line `i`, or the job/workflow default. */
function stepShell(lines, i, keyIndent) {
	for (let j = i - 1; j >= 0; j--) {
		const l = lines[j];
		if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
		const ind = indentOf(l) + (l.trimStart().startsWith("- ") ? 2 : 0);
		if (ind < keyIndent) break;
		const m = /^\s*(?:- )?shell:\s*(\S+)/.exec(l);
		if (m && ind === keyIndent) return m[1];
		if (l.trimStart().startsWith("- ") && ind === keyIndent) break;
	}
	for (let j = i + 1; j < lines.length; j++) {
		const l = lines[j];
		if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
		if (indentOf(l) < keyIndent || l.trimStart().startsWith("- ")) break;
		const m = /^\s*shell:\s*(\S+)/.exec(l);
		if (m && indentOf(l) === keyIndent) return m[1];
	}
	// `defaults: run: shell:` (ours say bash) needs no special case: bash is
	// what shellcheck checks anyway.
	return null;
}

function checkWorkflows(bin, root, workflows, flags) {
	const tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-"));
	try {
		const where = new Map();
		const names = [];
		for (const wf of workflows) {
			const text = readFileSync(join(root, wf), "utf8");
			for (const b of workflowRunBlocks(text)) {
				const name = join(tmp, `${names.length}.sh`);
				// Actions runs bash steps with -e (`bash -e {0}`, or -eo pipefail
				// with `shell: bash`): a failing `cd` stops the step (SC2164).
				writeFileSync(name, `set -e\n${b.script}`);
				where.set(name, { wf, ...b });
				names.push(name);
			}
		}
		if (names.length === 0) return 0;
		const r = spawnSync(
			bin,
			[
				...flags,
				"--shell=bash",
				// `node -e '…${x}…'`: JavaScript in single quotes is meant literally.
				"--exclude=SC2016",
				"--format=gcc",
				...names,
			],
			{ cwd: root, encoding: "utf8" },
		);
		const out = (r.stdout ?? "").replace(
			/^(.+?\.sh):(\d+):(\d+):/gm,
			(all, name, line, col) => {
				const w = where.get(name);
				if (!w) return all;
				return `${w.wf}:${w.line + Number(line) - 2}:${w.indent + Number(col)}:`;
			},
		);
		process.stdout.write(out);
		process.stderr.write(r.stderr ?? "");
		return r.status ?? 1;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function main() {
	const asset = assetFor(process.platform, process.arch);
	if (!asset) {
		console.error(
			`shellcheck: skipped, no pinned release for ${process.platform}/${process.arch}`,
		);
		return 0;
	}
	const root = resolve(import.meta.dirname, "..");
	const args = process.argv.slice(2);
	const flags = args.filter((a) => a.startsWith("-"));
	let paths = args.filter((a) => !a.startsWith("-"));
	let files;
	if (paths.length === 0) {
		const ls = spawnSync("git", ["ls-files", "-z"], {
			cwd: root,
			encoding: "utf8",
		});
		if (ls.status !== 0) throw new Error("shellcheck: git ls-files failed");
		paths = ls.stdout.split("\0").filter(Boolean);
		files = shellScripts(root, paths);
	} else files = paths.filter((p) => !isWorkflow(p));
	const workflows = paths.filter(isWorkflow);
	if (files.length === 0 && workflows.length === 0) return 0;
	const bin = await ensureBinary(root, asset);
	let status = 0;
	if (files.length > 0) {
		const r = spawnSync(bin, ["--external-sources", ...flags, ...files], {
			cwd: root,
			stdio: "inherit",
		});
		status = r.status ?? 1;
	}
	if (workflows.length > 0)
		status = checkWorkflows(bin, root, workflows, flags) || status;
	return status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().then(
		(code) => process.exit(code),
		(e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		},
	);
}
