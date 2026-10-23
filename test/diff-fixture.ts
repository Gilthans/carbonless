import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createGitFixture,
	type GitFixture,
	testGitEnv,
} from "./git-fixture.js";

export const SUB_SHA = "c".repeat(40);
export const SUB_SHA2 = "d".repeat(40);

const numbered = (n: number) =>
	`${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

/**
 * Two commits covering every kind of file change: edits, add, delete, rename
 * with edit, chmod, binary, submodule, empty file, and paths with spaces,
 * unicode and quotes.
 */
export function createDiffFixture(): GitFixture {
	const fixture = createGitFixture([
		{
			message: "base",
			files: {
				"mod.ts": numbered(10),
				"gone.ts": "bye\n",
				"old-name.ts": numbered(20),
				"script.sh": "echo hi\n",
				"dir/my file.ts": "one\n",
				"docs/über.md": "eins\n",
				'q"uote.txt': "x\n",
			},
			binary: { "img.bin": new Uint8Array([0, 1, 2, 3]) },
			submodule: { vendor: SUB_SHA },
		},
		{
			message: "head",
			files: {
				"mod.ts": numbered(10)
					.replace("line 2\n", "LINE 2\n")
					.replace("line 9\n", "LINE 9\n"),
				"added.ts": "new\n",
				"empty.txt": "",
				"dir/my file.ts": "one\ntwo\n",
				"docs/über.md": "zwei\n",
				'q"uote.txt': "y\n",
			},
			rename: { "old-name.ts": "new-name.ts" },
			delete: ["gone.ts"],
			chmod: { "script.sh": "755" },
			binary: { "img.bin": new Uint8Array([0, 9, 9, 9, 9]) },
			submodule: { vendor: SUB_SHA2 },
		},
	]);
	// Edit the renamed file too (kept similar enough for rename detection).
	writeFileSync(
		join(fixture.path, "new-name.ts"),
		numbered(20).replace("line 5\n", "LINE 5\n"),
	);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: fixture.path,
			encoding: "utf8",
			env: testGitEnv(),
		}).trim();
	git("add", "new-name.ts");
	git("commit", "-q", "--amend", "--no-edit");
	fixture.shas[1] = git("rev-parse", "HEAD");
	return fixture;
}
