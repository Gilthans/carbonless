// CAR-314: which files and workflow steps `pnpm lint` hands to shellcheck,
// where a finding in a workflow step is reported, and how the pinned binary
// is fetched (an injected fetch). No real shellcheck runs here: `pnpm lint`
// itself runs it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assetFor,
	blockFile,
	DOWNLOAD_TIMEOUT_MS,
	ensureBinary,
	HashMismatch,
	isShellShebang,
	isWorkflow,
	maskExpressions,
	remapGcc,
	shellcheckArgs,
	shellScripts,
	windowsJobLines,
	workflowRunBlocks,
} from "./shellcheck.mjs";

describe("isShellShebang", () => {
	it.each([
		"#!/bin/sh",
		"#!/bin/bash",
		"#!/usr/bin/env bash",
		"#!/usr/bin/env sh",
		"#!/usr/bin/env -S bash -e",
		"#! /bin/bash -eu",
	])("%s is shell", (line) => {
		expect(isShellShebang(`${line}\necho hi\n`)).toBe(true);
	});

	it.each([
		"#!/usr/bin/env node",
		"#!/usr/bin/env zsh",
		"#!/usr/bin/python3",
		"#!/usr/bin/env fish",
		"// #!/bin/bash",
		"",
	])("%s is not", (line) => {
		expect(isShellShebang(`${line}\n#!/bin/bash\n`)).toBe(false);
	});
});

describe("shellScripts", () => {
	let tmp: string;
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("takes .sh/.bash files and shell-shebang files, not other scripts", () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		mkdirSync(join(tmp, "bin"));
		const files: Record<string, string> = {
			"a.sh": "echo a\n",
			"b.bash": "echo b\n",
			"bin/gh": "#!/usr/bin/env bash\necho gh\n",
			"bin/tool": "#!/usr/bin/env node\nconsole.log(1)\n",
			"bin/notes": "plain text\n",
			"x.ts": "#!/bin/bash\n",
		};
		for (const [p, text] of Object.entries(files))
			writeFileSync(join(tmp, p), text);
		expect(shellScripts(tmp, [...Object.keys(files), "gone"])).toEqual([
			"a.sh",
			"b.bash",
			"bin/gh",
		]);
	});
});

describe("assetFor", () => {
	it("maps the platforms with a pinned release, and only those", () => {
		expect(assetFor("linux", "x64")).toBe("linux.x86_64");
		expect(assetFor("linux", "arm64")).toBe("linux.aarch64");
		expect(assetFor("darwin", "arm64")).toBe("darwin.aarch64");
		expect(assetFor("win32", "x64")).toBeNull();
		expect(assetFor("linux", "ia32")).toBeNull();
	});
});

describe("isWorkflow", () => {
	it("is a yml/yaml directly in .github/workflows", () => {
		expect(isWorkflow(".github/workflows/ci.yml")).toBe(true);
		expect(isWorkflow(".github/workflows/x.yaml")).toBe(true);
		expect(isWorkflow(".github/dependabot.yml")).toBe(false);
		expect(isWorkflow(".github/workflows/sub/ci.yml")).toBe(false);
	});
});

describe("shellcheckArgs", () => {
	let tmp: string;
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("passes paths after `--`, so a file named like a flag stays a file", () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		writeFileSync(join(tmp, "-x.sh"), "echo x\n");
		writeFileSync(join(tmp, "-e"), "#!/bin/sh\necho e\n");
		const files = shellScripts(tmp, ["-x.sh", "-e"]);
		expect(files).toEqual(["-x.sh", "-e"]);
		const args = shellcheckArgs("/repo", ["--format=gcc"], files);
		expect(args).toEqual([
			"--rcfile=/repo/.shellcheckrc",
			"--external-sources",
			"--format=gcc",
			"--",
			"-x.sh",
			"-e",
		]);
	});
});

describe("workflowRunBlocks", () => {
	// A GitHub Actions expression, built so it isn't a JS placeholder look-alike.
	const gha = (e: string) => `\${{ ${e} }}`;
	const wf = [
		"name: t", // 1
		"on:", // 2
		"  workflow_dispatch:", // 3
		"    inputs:", // 4
		"      run:", // 5: an input named run, no step
		"        description: x", // 6
		"defaults:", // 7
		"  run:", // 8
		"    shell: bash", // 9
		"jobs:", // 10
		"  linux:", // 11
		"    runs-on: ubuntu-latest", // 12
		"    defaults:", // 13
		"      run:", // 14
		"        working-directory: x", // 15
		"    steps:", // 16
		"      - run: pnpm install", // 17
		"      - name: block", // 18
		"        env:", // 19
		`          X: ${gha("github.token")}`, // 20
		"        run: |", // 21
		'          cd "$RUNNER_TEMP"', // 22
		"          if true; then", // 23
		`            echo ${gha("matrix.shard")}`, // 24
		"          fi", // 25
		"", // 26
		"      - name: python", // 27
		"        shell: python", // 28
		"        run: print(1)", // 29
		"      - name: shell after", // 30
		"        run: echo $A", // 31
		"        shell: sh", // 32
		"      - run: 'echo ''$C'''", // 33
		'      - run: "echo $D"', // 34
		"  win:", // 35
		"    runs-on: windows-latest", // 36
		"    steps:", // 37
		"      - run: Get-ChildItem", // 38
		"      - shell: bash", // 39
		'        run: echo "$B"', // 40
		"",
	].join("\n");

	it("finds the sh/bash steps, at their lines, with expressions masked", () => {
		expect(workflowRunBlocks(wf)).toEqual([
			{ line: 17, col: 13, shell: "bash", script: "pnpm install\n" },
			{
				line: 22,
				col: 10,
				shell: "bash",
				script: `cd "$RUNNER_TEMP"\nif true; then\n  echo _GHA${"_".repeat(15)}\nfi\n`,
			},
			{ line: 31, col: 13, shell: "sh", script: "echo $A\n" },
			{ line: 33, col: 14, shell: "bash", script: "echo '$C'\n" },
			{ line: 34, col: 14, shell: "bash", script: "echo $D\n" },
			{ line: 40, col: 13, shell: "bash", script: 'echo "$B"\n' },
		]);
	});

	it.each([
		["script on the next line", ["      - run:", "          echo $X"]],
		["folded", ["      - run: >", "          echo $X"]],
		[
			"block with an indentation indicator",
			["      - run: |2", "          echo"],
		],
		["plain over several lines", ["      - run: echo", "          $X"]],
		["quoted over several lines", ['      - run: "echo', '          $X"']],
		["escapes in double quotes", ['      - run: "echo \\"$X\\""']],
		["an empty block", ["      - run: |", "      - run: echo"]],
	])("refuses a step it can't read (%s), naming file:line", (_, step) => {
		const text = [
			"jobs:",
			"  j:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			...step,
			"",
		].join("\n");
		expect(() => workflowRunBlocks(text, ".github/workflows/x.yml")).toThrow(
			/^\.github\/workflows\/x\.yml:5: shellcheck can't read this run: step/,
		);
	});

	it("masks an expression holding `}` and keeps its length", () => {
		const e = gha("format('{0}', x)");
		expect(maskExpressions(`a ${e} $b`)).toBe(
			`a _GHA${"_".repeat(e.length - 4)} $b`,
		);
	});

	it("maps a finding back to its workflow line and column", () => {
		const blocks = workflowRunBlocks(wf, ".github/workflows/t.yml");
		const lines = wf.split("\n");
		const where = new Map(
			blocks.map((b, n) => [
				`/tmp/x/${n}.sh`,
				{ file: ".github/workflows/t.yml", ...b },
			]),
		);
		// Each finding's line and column within the file shellcheck read.
		const at = (n: number, needle: string) => {
			const file = blockFile(blocks[n] as (typeof blocks)[number]).split("\n");
			const line = file.findIndex((l) => l.includes(needle));
			return `/tmp/x/${n}.sh:${line + 1}:${(file[line] ?? "").indexOf(needle) + 1}: note: x [SC1]`;
		};
		const out = remapGcc(
			[at(0, "install"), at(1, "true"), at(4, "$D"), "other:1:1: y"].join("\n"),
			where,
		);
		const found = out.split("\n").map((l) => /^[^:]+:(\d+):(\d+):/.exec(l));
		const char = (m: RegExpExecArray | null) =>
			m ? lines[Number(m[1]) - 1]?.slice(Number(m[2]) - 1) : undefined;
		expect(found[0]?.[1]).toBe("17");
		expect(char(found[0] ?? null)).toBe("install");
		expect(found[1]?.[1]).toBe("23");
		expect(char(found[1] ?? null)).toMatch(/^true; then/);
		expect(found[2]?.[1]).toBe("34");
		expect(char(found[2] ?? null)).toMatch(/^\$D"/);
		expect(out.split("\n")[3]).toBe("other:1:1: y");
	});

	it("reads every step of our own workflows, leaving out only the known non-steps", () => {
		const dir = join(import.meta.dirname, "..", ".github", "workflows");
		let windowsRuns = 0;
		const uncovered = readdirSync(dir).flatMap((f) => {
			const text = readFileSync(join(dir, f), "utf8");
			const lines = text.split("\n");
			// A block's script starts on the line after its `run:`.
			const covered = new Set(
				workflowRunBlocks(text, f).map((b) =>
					/^\s*(?:- )?run:/.test(lines[b.line - 1] ?? "") ? b.line : b.line - 1,
				),
			);
			// The Windows job's steps are PowerShell: left out by where they
			// are, whatever their command says.
			const windows = windowsJobLines(text);
			return lines.flatMap((l, n) => {
				if (!/^\s*(?:- )?run:/.test(l) || covered.has(n + 1)) return [];
				if (windows.has(n + 1)) {
					windowsRuns++;
					return [];
				}
				return [`${f}: ${l.trim()}`];
			});
		});
		// The Windows job is there and has steps: the range isn't empty.
		expect(windowsRuns).toBeGreaterThan(0);
		expect(uncovered.sort()).toEqual(
			[
				// workflow_dispatch's `inputs: run:`.
				"release-finish.yml: run:",
				// Top-level `defaults: run:`.
				"release-finish.yml: run:",
				"release.yml: run:",
			].sort(),
		);
	});

	it("windowsJobLines spans the Windows job only, ending at the next job", () => {
		const text = [
			"on:",
			"  push:",
			"jobs:",
			"  lin:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo a",
			"  win:",
			"    runs-on: windows-latest",
			"    steps:",
			"      - run: Get-ChildItem",
			"      - run: pnpm test",
			"  lin2:",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo b",
		].join("\n");
		expect([...windowsJobLines(text)]).toEqual([8, 9, 10, 11, 12]);
		// The same range is what workflowRunBlocks leaves out.
		expect(workflowRunBlocks(text).map((b) => b.line)).toEqual([7, 16]);
	});

	it("a job key with a comment ends the Windows job before it", () => {
		const text = [
			"jobs:",
			"  win:",
			"    runs-on: windows-latest # pwsh",
			"    steps:",
			"      - run: Get-ChildItem",
			"  lin: # linux",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo $A",
			"",
		].join("\n");
		expect(workflowRunBlocks(text)).toEqual([
			{ line: 9, col: 13, shell: "bash", script: "echo $A\n" },
		]);
	});

	it("checks each block in its own shell, with set -e", () => {
		const [file] = workflowRunBlocks(
			"jobs:\n  j:\n    steps:\n      - shell: sh\n        run: echo\n",
		).map(blockFile);
		expect(file).toBe("# shellcheck shell=sh\nset -e\necho\n");
	});
});

describe("ensureBinary", () => {
	let tmp: string;
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	const url = "https://example.invalid/shellcheck-v0.0.0.linux.x86_64.tar.gz";
	/** A release-shaped tarball holding a `shellcheck` script, and its sha256. */
	function tarball() {
		const src = join(tmp, "src", "shellcheck-v0.0.0");
		mkdirSync(src, { recursive: true });
		writeFileSync(join(src, "shellcheck"), "#!/bin/sh\necho fake\n");
		const tgz = join(tmp, "release.tar.gz");
		const r = spawnSync("tar", [
			"-czf",
			tgz,
			"-C",
			join(tmp, "src"),
			"shellcheck-v0.0.0",
		]);
		expect(r.status).toBe(0);
		const body = readFileSync(tgz);
		return { body, sha256: createHash("sha256").update(body).digest("hex") };
	}
	const serve = (body: Buffer) => {
		const calls: { signal?: AbortSignal }[] = [];
		const fetch = async (_u: string, init: { signal?: AbortSignal }) => {
			calls.push(init);
			return new Response(new Uint8Array(body));
		};
		return { fetch, calls };
	};

	it("installs a tarball with the pinned hash, with a download timeout", async () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		const { body, sha256 } = tarball();
		const { fetch, calls } = serve(body);
		const dir = join(tmp, "cache", "v0");
		const bin = await ensureBinary(dir, {
			url,
			sha256,
			fetch,
			env: {},
			log: () => {},
		});
		expect(bin).toBe(join(dir, "shellcheck"));
		expect(readFileSync(join(dir, "shellcheck"), "utf8")).toContain(
			"echo fake",
		);
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(DOWNLOAD_TIMEOUT_MS).toBe(60_000);
		// Cached: no second download.
		await ensureBinary(dir, { url, sha256, fetch, env: {}, log: () => {} });
		expect(calls).toHaveLength(1);
	});

	it.each([{}, { CI: "true" }])(
		"rejects bytes with another hash, and installs nothing (env %o)",
		async (env) => {
			tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
			const { body } = tarball();
			const { fetch } = serve(body);
			const dir = join(tmp, "cache", "v0");
			await expect(
				ensureBinary(dir, {
					url,
					sha256: "0".repeat(64),
					fetch,
					env,
					log: () => {},
				}),
			).rejects.toBeInstanceOf(HashMismatch);
			expect(existsSync(dir)).toBe(false);
			expect(readdirSync(join(tmp))).not.toContain("cache");
		},
	);

	const offline = async () => {
		throw new TypeError("fetch failed", {
			cause: new Error("getaddrinfo ENOTFOUND github.com"),
		});
	};

	it("offline in CI: fails, saying the URL and the cause", async () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		await expect(
			ensureBinary(join(tmp, "v0"), {
				url,
				sha256: "0".repeat(64),
				fetch: offline,
				env: { CI: "true" },
				log: () => {},
			}),
		).rejects.toThrow(
			`couldn't download ${url}: fetch failed: getaddrinfo ENOTFOUND github.com`,
		);
	});

	it("offline locally: a loud SKIPPED with the URL and cause, and no binary", async () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		const logs: string[] = [];
		const bin = await ensureBinary(join(tmp, "v0"), {
			url,
			sha256: "0".repeat(64),
			fetch: offline,
			env: {},
			log: (m: string) => logs.push(m),
		});
		expect(bin).toBeNull();
		expect(logs.join("\n")).toContain(
			`shellcheck SKIPPED: ${url}: fetch failed: getaddrinfo ENOTFOUND github.com`,
		);
	});

	it("an HTTP error or a timeout counts as offline", async () => {
		tmp = mkdtempSync(join(tmpdir(), "crb-shellcheck-test-"));
		const notFound = async () => new Response("", { status: 404 });
		await expect(
			ensureBinary(join(tmp, "v0"), {
				url,
				sha256: "0",
				fetch: notFound,
				env: { CI: "1" },
				log: () => {},
			}),
		).rejects.toThrow("HTTP 404");
		const timeout = async () => {
			throw new DOMException(
				"The operation was aborted due to timeout",
				"TimeoutError",
			);
		};
		const logs: string[] = [];
		await ensureBinary(join(tmp, "v0"), {
			url,
			sha256: "0",
			fetch: timeout,
			env: {},
			log: (m: string) => logs.push(m),
		});
		expect(logs.join("\n")).toContain(`SKIPPED: ${url}: timed out`);
	});
});
