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

/** A download whose bytes aren't the pinned ones: always fails, never skips. */
export class HashMismatch extends Error {}

export const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The binary in `dir` (`<dir>/shellcheck`), downloading `url` first when it
 * isn't there and checking the tarball against `sha256` before anything is
 * written. A download that fails (offline, a timeout, an HTTP error) throws
 * with `env.CI` set, so CI never skips; locally it logs a loud SKIPPED and
 * returns null (CI checks). A hash mismatch throws everywhere.
 */
export async function ensureBinary(
	dir,
	{ url, sha256, fetch: get = fetch, env = process.env, log = console.error },
) {
	const bin = join(dir, "shellcheck");
	if (existsSync(bin)) return bin;
	const name = url.slice(url.lastIndexOf("/") + 1);
	log(`shellcheck: downloading ${name}`);
	let body;
	try {
		const res = await get(url, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		body = Buffer.from(await res.arrayBuffer());
	} catch (e) {
		const cause = errorText(e);
		if (env.CI)
			throw new Error(`shellcheck: couldn't download ${url}: ${cause}`);
		log(
			`\n*** shellcheck SKIPPED: ${url}: ${cause} (CI checks the shell scripts) ***\n`,
		);
		return null;
	}
	const sum = createHash("sha256").update(body).digest("hex");
	if (sum !== sha256)
		throw new HashMismatch(
			`shellcheck: ${url} has sha256 ${sum}, expected ${sha256}`,
		);
	const tmp = `${dir}.tmp-${process.pid}`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const tgz = join(tmp, name);
		writeFileSync(tgz, body);
		const tar = spawnSync(
			"tar",
			["-xzf", tgz, "-C", tmp, "--strip-components=1"],
			{ stdio: "inherit" },
		);
		if (tar.status !== 0 || !existsSync(join(tmp, "shellcheck")))
			throw new Error(`shellcheck: no shellcheck in ${name}`);
		chmodSync(join(tmp, "shellcheck"), 0o755);
		rmSync(tgz);
		mkdirSync(dirname(dir), { recursive: true });
		try {
			renameSync(tmp, dir);
		} catch (e) {
			// Another lint run got there first.
			if (!existsSync(bin)) throw e;
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	return bin;
}

function errorText(e) {
	if (!(e instanceof Error)) return String(e);
	const cause = e.cause instanceof Error ? `: ${e.cause.message}` : "";
	return `${e.name === "TimeoutError" ? "timed out" : e.message}${cause}`;
}

/**
 * shellcheck's argv: the repo's rc file (also for workflow steps, written
 * outside the repo, and never a developer's ~/.shellcheckrc), the flags,
 * then `--` so no path is read as an option.
 */
export function shellcheckArgs(root, flags, files) {
	return [
		`--rcfile=${join(root, ".shellcheckrc")}`,
		"--external-sources",
		...flags,
		"--",
		...files,
	];
}

/** Whether a path is a GitHub Actions workflow. */
export function isWorkflow(path) {
	return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

const indentOf = (l) => l.length - l.trimStart().length;

/**
 * `${{ … }}` as a word of the same length (`_GHA___…`), so shellcheck sees a
 * plain word and a column after it still maps back.
 */
export function maskExpressions(s) {
	return s.replace(
		/\$\{\{[\s\S]*?\}\}/g,
		(m) => `_GHA${"_".repeat(m.length - 4)}`,
	);
}

/**
 * The shell of every sh/bash `run:` step in a workflow's text, as `{ line,
 * col, shell, script }`: `line` is the 1-based line its script starts on,
 * `col` the 0-based column shellcheck's column 1 maps to. Steps that run
 * another shell (a `shell:` other than bash or sh, or a Windows job's default
 * pwsh) are left out. Line-based, for the shapes our workflows use: a plain
 * one-line value, a one-line quoted one without escapes, and a `|` block.
 * Anything else throws, naming `file:line`, rather than go unchecked.
 */
export function workflowRunBlocks(text, file = "workflow") {
	const lines = text.split("\n");
	const blocks = [];
	let windowsJob = false;
	let inJobs = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		// Steps live under the top-level `jobs:` (`on: … inputs: run:` and
		// the top-level `defaults: run:` are no steps).
		if (/^\S/.test(l) && !l.startsWith("#"))
			inJobs = /^jobs:\s*(?:#.*)?$/.test(l);
		if (!inJobs) continue;
		// A job (two-space key under `jobs:`): note whether it runs on Windows.
		if (/^ {2}[\w-]+:\s*$/.test(l)) {
			windowsJob = false;
			for (let j = i + 1; j < lines.length; j++) {
				if (/^ {0,2}\S/.test(lines[j])) break;
				if (/^ {4}runs-on:.*windows/.test(lines[j])) windowsJob = true;
			}
		}
		const m = /^(\s*)(- )?run:(?:\s+(.*))?$/.exec(l);
		if (!m) continue;
		const keyIndent = m[1].length + (m[2] ? 2 : 0);
		const value = (m[3] ?? "").replace(/\s+#.*$/, "").trimEnd();
		const fail = (why) => {
			throw new Error(
				`${file}:${i + 1}: shellcheck can't read this run: step (${why})`,
			);
		};
		if (value === "") {
			const next = lines.slice(i + 1).find((n) => n.trim() !== "");
			// `defaults: run: shell: bash`: a mapping, not a step's script.
			if (
				!m[2] &&
				next &&
				indentOf(next) > keyIndent &&
				/^\s*(?:shell|working-directory):(?:\s|$)/.test(next)
			)
				continue;
			fail("its script starts on the next line: use `run: |`");
		}
		const shell = stepShell(lines, i, keyIndent, Boolean(m[2]));
		if (shell ? !/^(?:ba)?sh$/.test(shell) : windowsJob) continue;
		const sh = shell === "sh" ? "sh" : "bash";
		const valueCol = l.indexOf(m[3]);
		if (/^\|[-+]?$/.test(value)) {
			const body = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const b = lines[j];
				if (b.trim() !== "" && indentOf(b) <= keyIndent) break;
				body.push(b);
			}
			while (body.length && body[body.length - 1].trim() === "") body.pop();
			const indent = Math.min(
				...body.filter((b) => b.trim() !== "").map(indentOf),
			);
			if (!Number.isFinite(indent)) fail("an empty block");
			blocks.push({
				line: i + 2,
				col: indent,
				shell: sh,
				script: `${maskExpressions(body.map((b) => b.slice(Math.min(indent, indentOf(b)))).join("\n"))}\n`,
			});
			i = j - 1;
		} else if (/^[|>]/.test(value)) {
			fail(`the block style ${value}: use \`run: |\``);
		} else if (/^['"]/.test(value)) {
			const q = value[0];
			const inner = value.slice(1, -1);
			if (value.length < 2 || value.at(-1) !== q)
				fail("a quoted value over several lines");
			if (q === '"' && /[\\"]/.test(inner))
				fail("escapes in a double-quoted value");
			if (q === "'" && /'(?!')/.test(inner.replace(/''/g, "")))
				fail("a broken single-quoted value");
			blocks.push({
				line: i + 1,
				col: valueCol + 1,
				shell: sh,
				script: `${maskExpressions(q === "'" ? inner.replace(/''/g, "'") : inner)}\n`,
			});
		} else {
			const next = lines[i + 1];
			if (
				next !== undefined &&
				next.trim() !== "" &&
				indentOf(next) > keyIndent
			)
				fail("a plain value over several lines: use `run: |`");
			blocks.push({
				line: i + 1,
				col: valueCol,
				shell: sh,
				script: `${maskExpressions(value)}\n`,
			});
		}
	}
	return blocks;
}

/**
 * The `shell:` of the step whose `run:` is at line `i`, or null. A `- run:`
 * starts its step: only the lines after it are the step's.
 */
function stepShell(lines, i, keyIndent, startsStep) {
	for (let j = startsStep ? -1 : i - 1; j >= 0; j--) {
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
	// what a step without its own shell is checked as.
	return null;
}

/**
 * Each block as the file shellcheck reads: its shell, and `set -e` (Actions
 * runs bash steps with -e: `bash -e {0}`, or -eo pipefail with `shell:
 * bash`, so a failing `cd` stops the step, SC2164), then the script.
 */
export const HEADER_LINES = 2;
export function blockFile(block) {
	return `# shellcheck shell=${block.shell}\nset -e\n${block.script}`;
}

/** shellcheck's gcc-format output with each block file's place mapped back. */
export function remapGcc(out, where) {
	return out.replace(/^(.+?):(\d+):(\d+):/gm, (all, name, line, col) => {
		const w = where.get(name);
		if (!w) return all;
		return `${w.file}:${w.line + Number(line) - 1 - HEADER_LINES}:${w.col + Number(col)}:`;
	});
}

function checkWorkflows(bin, root, workflows, flags) {
	const tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-"));
	try {
		const where = new Map();
		const names = [];
		for (const file of workflows) {
			const text = readFileSync(join(root, file), "utf8");
			for (const b of workflowRunBlocks(text, file)) {
				const name = join(tmp, `${names.length}.sh`);
				writeFileSync(name, blockFile(b));
				where.set(name, { file, ...b });
				names.push(name);
			}
		}
		if (names.length === 0) return 0;
		const r = spawnSync(
			bin,
			shellcheckArgs(
				root,
				[
					...flags,
					// `node -e '…${x}…'`: JavaScript in single quotes is meant literally.
					"--exclude=SC2016",
					"--format=gcc",
				],
				names,
			),
			{ cwd: root, encoding: "utf8" },
		);
		process.stdout.write(remapGcc(r.stdout ?? "", where));
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
	// Every argument starting with `-` is a shellcheck flag (in its
	// `--flag=value` form), so a file named like a flag can't be named here;
	// with no files given, the tracked ones are found (and passed after `--`).
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
	const name = `shellcheck-${VERSION}.${asset}.tar.gz`;
	const bin = await ensureBinary(
		join(root, "node_modules", ".cache", "shellcheck", VERSION),
		{
			url: `https://github.com/koalaman/shellcheck/releases/download/${VERSION}/${name}`,
			sha256: SHA256[asset],
		},
	);
	if (!bin) return 0;
	let status = 0;
	if (files.length > 0) {
		const r = spawnSync(bin, shellcheckArgs(root, flags, files), {
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
