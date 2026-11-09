import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createGitFixture,
	GIT_TEST_TIMEOUTS,
	type GitFixture,
} from "../../../test/git-fixture.js";
import {
	buildAllHeadings,
	FUNCNAME_ATTRIBUTES,
	funcnameAttributesFile,
} from "./headings.js";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

// A method in a class: only Python's rule names the def (the default rule
// would say the class).
const py = (n: number) =>
	`${[
		"class Box:",
		"    def work(self):",
		...Array.from(
			{ length: 12 },
			(_, i) => `        x${i} = ${i === 8 ? n : 0}`,
		),
	].join("\n")}\n`;

let fixture: GitFixture;
const files = [{ path: "a.py" }];
const headings = () =>
	buildAllHeadings(
		fixture.path,
		fixture.shas[0] as string,
		fixture.shas[1] as string,
		files,
	);

beforeAll(() => {
	fixture = createGitFixture([
		{ message: "base", files: { "a.py": py(1) } },
		{ message: "head", files: { "a.py": py(2) } },
	]);
});
afterAll(() => fixture.cleanup());

describe("the funcname attributes file", () => {
	it("is named by its content, and written again when the cache is cleared", async () => {
		const path = await funcnameAttributesFile();
		expect(path).toMatch(/funcname-[0-9a-f]{12}\.gitattributes$/);
		expect(readFileSync(path, "utf8")).toBe(FUNCNAME_ATTRIBUTES);
		rmSync(path);
		const [hunks] = await headings();
		expect(hunks?.[0]?.heading).toBe("def work(self):");
		expect(existsSync(path)).toBe(true);
	});
});

describe("git without --attr-source (before 2.40)", () => {
	let bin: string;
	let path: string | undefined;
	beforeAll(() => {
		bin = mkdtempSync(join(tmpdir(), "carbonless-old-git-"));
		const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const refusals = join(bin, "refusals");
		writeFileSync(
			join(bin, "git"),
			[
				"#!/bin/sh",
				'for a in "$@"; do case "$a" in --attr-source=*)',
				`  echo x >> '${refusals}'; echo "unknown option: $a" >&2; exit 129;;`,
				"esac; done",
				`exec '${real}' "$@"`,
				"",
			].join("\n"),
		);
		chmodSync(join(bin, "git"), 0o755);
		path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
	});
	afterAll(() => {
		process.env.PATH = path;
		rmSync(bin, { recursive: true, force: true });
	});

	it("still gives headings by carbonless's list, learning so once", async () => {
		for (let i = 0; i < 2; i++) {
			const [hunks] = await headings();
			expect(hunks?.[0]?.heading).toBe("def work(self):");
		}
		const refusals = readFileSync(join(bin, "refusals"), "utf8");
		expect(refusals.trim().split("\n")).toHaveLength(1);
	});
});
