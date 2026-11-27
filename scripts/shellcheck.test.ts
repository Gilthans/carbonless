// CAR-314: which files and workflow steps `pnpm lint` hands to shellcheck,
// and where a finding in a workflow step is reported. No shellcheck runs here
// (the binary is a download): `pnpm lint` itself runs it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assetFor,
	isShellShebang,
	isWorkflow,
	shellScripts,
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

describe("workflowRunBlocks", () => {
	// A GitHub Actions expression, built so it isn't a JS placeholder look-alike.
	const gha = (e: string) => `\${{ ${e} }}`;
	const wf = [
		"name: t", // 1
		"jobs:", // 2
		"  linux:", // 3
		"    runs-on: ubuntu-latest", // 4
		"    steps:", // 5
		"      - run: pnpm install", // 6
		"      - name: block", // 7
		"        env:", // 8
		`          X: ${gha("github.token")}`, // 9
		"        run: |", // 10
		'          cd "$RUNNER_TEMP"', // 11
		"          if true; then", // 12
		`            echo ${gha("matrix.shard")}`, // 13
		"          fi", // 14
		"", // 15
		"      - name: python", // 16
		"        shell: python", // 17
		"        run: print(1)", // 18
		"      - name: shell after", // 19
		"        run: echo $A", // 20
		"        shell: bash", // 21
		"  win:", // 22
		"    runs-on: windows-latest", // 23
		"    steps:", // 24
		"      - run: Get-ChildItem", // 25
		"      - shell: bash", // 26
		'        run: echo "$B"', // 27
		"",
	].join("\n");

	it("finds the bash steps, at their lines, with expressions replaced", () => {
		expect(workflowRunBlocks(wf)).toEqual([
			{ line: 6, indent: 13, script: "pnpm install\n" },
			{
				line: 11,
				indent: 10,
				script: 'cd "$RUNNER_TEMP"\nif true; then\n  echo _GHA_EXPR_\nfi\n',
			},
			{ line: 20, indent: 13, script: "echo $A\n" },
			{ line: 27, indent: 13, script: 'echo "$B"\n' },
		]);
	});

	it("maps a column in a one-line step back to the workflow", () => {
		const b = workflowRunBlocks(wf)[0];
		if (!b) throw new Error("no block");
		// shellcheck's column 1 of the block is the `p` of `pnpm`.
		const lines = wf.split("\n");
		expect(lines[b.line - 1]?.[b.indent]).toBe("p");
	});
});
