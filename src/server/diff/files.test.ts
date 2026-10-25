import { execFileSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createDiffFixture,
	SUB_SHA,
	SUB_SHA2,
} from "../../../test/diff-fixture.js";
import {
	createGitFixture,
	type GitFixture,
	testGitEnv,
} from "../../../test/git-fixture.js";
import { buildAllClusters, buildClusters } from "./clusters.js";
import { type ChangedFile, listChangedFiles } from "./files.js";

let fixture: GitFixture;
let files: ChangedFile[];
const byPath = (path: string) => {
	const f = files.find((x) => x.path === path);
	if (!f) throw new Error(`no ${path}`);
	return f;
};

beforeAll(async () => {
	fixture = createDiffFixture();
	files = await listChangedFiles(
		fixture.path,
		fixture.shas[0] as string,
		fixture.shas[1] as string,
	);
});

afterAll(() => fixture.cleanup());

const base = () => fixture.shas[0] as string;
const head = () => fixture.shas[1] as string;
const kinds = async (path: string) =>
	(await buildClusters(fixture.path, base(), head(), byPath(path))).map(
		(c) => c.kind,
	);

describe("listChangedFiles", () => {
	it("lists every change with status, modes and counts", () => {
		expect(files.map((f) => [f.path, f.status]).sort()).toEqual(
			[
				["added.ts", "added"],
				["dir/my file.ts", "modified"],
				["docs/über.md", "modified"],
				["empty.txt", "added"],
				["gone.ts", "deleted"],
				["img.bin", "modified"],
				["mod.ts", "modified"],
				["new-name.ts", "renamed"],
				['q"uote.txt', "modified"],
				["script.sh", "modified"],
				["vendor", "modified"],
			].sort(),
		);
		expect(byPath("new-name.ts")).toMatchObject({
			oldPath: "old-name.ts",
			additions: 1,
			deletions: 1,
		});
		expect(byPath("script.sh")).toMatchObject({
			oldMode: "100644",
			newMode: "100755",
			additions: 0,
		});
		expect(byPath("img.bin")).toMatchObject({ binary: true });
		expect(byPath("vendor")).toMatchObject({
			submodule: true,
			oldOid: SUB_SHA,
			newOid: SUB_SHA2,
		});
		expect(byPath("added.ts")).toMatchObject({
			additions: 1,
			deletions: 0,
			newMode: "100644",
		});
		expect(byPath("gone.ts")).toMatchObject({ deletions: 1 });
		expect(byPath("gone.ts").newMode).toBeUndefined();
		expect(byPath("added.ts").oldMode).toBeUndefined();
		expect(byPath("empty.txt")).toMatchObject({ additions: 0, deletions: 0 });
		expect(byPath("dir/my file.ts")).toMatchObject({ additions: 1 });
	});
});

describe("buildClusters", () => {
	it("splits distant edits into separate line clusters", async () => {
		const clusters = await buildClusters(
			fixture.path,
			base(),
			head(),
			byPath("mod.ts"),
		);
		expect(clusters.map((c) => [c.kind, c.removed, c.added])).toEqual([
			["lines", ["line 2"], ["LINE 2"]],
			["lines", ["line 9"], ["LINE 9"]],
		]);
	});
	it("rename with edit gives file then lines", async () => {
		expect(await kinds("new-name.ts")).toEqual(["file", "lines"]);
	});
	it("binary gives one file cluster", async () => {
		expect(await kinds("img.bin")).toEqual(["file"]);
	});
	it("submodule gives one file cluster and no lines", async () => {
		expect(await kinds("vendor")).toEqual(["file"]);
	});
	it("empty add gives one file cluster", async () => {
		expect(await kinds("empty.txt")).toEqual(["file"]);
	});
	it("chmod gives one file cluster", async () => {
		expect(await kinds("script.sh")).toEqual(["file"]);
	});
	it("round-trips paths with spaces, unicode and quotes", async () => {
		const [c] = await buildClusters(
			fixture.path,
			base(),
			head(),
			byPath("docs/über.md"),
		);
		expect(c).toMatchObject({ removed: ["eins"], added: ["zwei"] });
		const [s] = await buildClusters(
			fixture.path,
			base(),
			head(),
			byPath("dir/my file.ts"),
		);
		expect(s).toMatchObject({ added: ["two"] });
		const [q] = await buildClusters(
			fixture.path,
			base(),
			head(),
			byPath('q"uote.txt'),
		);
		expect(q).toMatchObject({ removed: ["x"], added: ["y"] });
	});
});

describe("tricky changes", () => {
	let fx: GitFixture;
	let changed: ChangedFile[];
	const get = (path: string) => {
		const f = changed.find((x) => x.path === path);
		if (!f) throw new Error(`no ${path}`);
		return f;
	};
	const clustersOf = (path: string) =>
		buildClusters(
			fx.path,
			fx.shas[0] as string,
			fx.shas[1] as string,
			get(path),
		);

	beforeAll(async () => {
		const bytes = (last: number) => {
			const b = new Uint8Array(500);
			b[499] = last;
			return b;
		};
		fx = createGitFixture([
			{
				message: "base",
				files: {
					foo: "x\n",
					"link.txt": "target\n",
					"five.ts": "1\n2\n3\n4\n5\n",
				},
				binary: { "a.bin": bytes(1), "b.bin": bytes(1) },
			},
			{
				message: "head",
				files: { "foo/bar": "inner\n", "five.ts": "1\nTWO\n3\nFOUR\n5\n" },
				delete: ["foo", "link.txt"],
				rename: { "a.bin": "c.bin" },
				binary: { "c.bin": bytes(2), "b.bin": bytes(2) },
				chmod: { "b.bin": "755" },
			},
		]);
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: fx.path,
				encoding: "utf8",
				env: testGitEnv(),
			}).trim();
		symlinkSync("five.ts", join(fx.path, "link.txt"));
		git("add", "--all");
		git("commit", "-q", "--amend", "--no-edit");
		fx.shas[1] = git("rev-parse", "HEAD");
		changed = await listChangedFiles(
			fx.path,
			fx.shas[0] as string,
			fx.shas[1] as string,
		);
	});

	afterAll(() => fx.cleanup());

	it("keeps file-to-symlink headers out of cluster content", async () => {
		expect(get("link.txt").status).toBe("type-changed");
		const clusters = await clustersOf("link.txt");
		const content = clusters.flatMap((c) => [...c.removed, ...c.added]);
		expect(content).toEqual(["target", "five.ts"]);
	});

	it("does not leak a directory's files into a same-named deleted file", async () => {
		const clusters = await clustersOf("foo");
		expect(clusters.map((c) => [c.removed, c.added])).toEqual([[["x"], []]]);
	});

	it("is not affected by diff.interHunkContext in repo config", async () => {
		execFileSync("git", ["config", "diff.interHunkContext", "5"], {
			cwd: fx.path,
			env: testGitEnv(),
		});
		const clusters = await clustersOf("five.ts");
		expect(clusters.map((c) => c.added)).toEqual([["TWO"], ["FOUR"]]);
	});

	it.each(["diff.noprefix", "diff.mnemonicPrefix"])(
		"is not affected by %s in repo config",
		async (key) => {
			execFileSync("git", ["config", key, "true"], {
				cwd: fx.path,
				env: testGitEnv(),
			});
			try {
				const clusters = await clustersOf("five.ts");
				expect(clusters.map((c) => c.added)).toEqual([["TWO"], ["FOUR"]]);
			} finally {
				execFileSync("git", ["config", "--unset", key], {
					cwd: fx.path,
					env: testGitEnv(),
				});
			}
		},
	);

	it("throws when the parsed lines don't match the file's counts", async () => {
		const wrong = { ...get("five.ts"), additions: 99 };
		await expect(
			buildClusters(fx.path, fx.shas[0] as string, fx.shas[1] as string, wrong),
		).rejects.toThrow(/five\.ts/);
	});

	it("fails closed when the listing and the patch disagree on files", async () => {
		const [base, head] = [fx.shas[0] as string, fx.shas[1] as string];
		const all = await listChangedFiles(fx.path, base, head);
		// A file the patch doesn't have.
		const ghost = { ...get("five.ts"), path: "ghost.ts" };
		await expect(
			buildAllClusters(fx.path, base, head, [...all, ghost]),
		).rejects.toThrow(/no section for ghost\.ts/);
		// A section no listed file claims.
		await expect(
			buildAllClusters(fx.path, base, head, all.slice(1)),
		).rejects.toThrow(/not in the listing/);
		expect(await buildAllClusters(fx.path, base, head, all)).toHaveLength(
			all.length,
		);
	});

	it("names both a rename and a binary content change", async () => {
		const [c] = await clustersOf("c.bin");
		expect(c?.label).toBe("Renamed from a.bin, binary file changed");
	});

	it("names both a binary change and a mode change", async () => {
		const [c] = await clustersOf("b.bin");
		expect(c?.label).toBe("Binary file changed, mode changed 100644 → 100755");
	});
});

describe("control characters in paths", () => {
	it("clusters a path containing a carriage return or throws", async () => {
		const name = "cr\rname.txt";
		const fx = createGitFixture([
			{ message: "a", files: { [name]: "old\n" } },
			{ message: "b", files: { [name]: "new\n" } },
		]);
		try {
			const [base, head] = fx.shas as [string, string];
			const [file] = await listChangedFiles(fx.path, base, head);
			expect(file?.path).toBe(name);
			const result = await buildClusters(
				fx.path,
				base,
				head,
				file as ChangedFile,
			).catch((e: unknown) => e);
			if (Array.isArray(result)) {
				expect(result[0]).toMatchObject({ removed: ["old"], added: ["new"] });
			} else {
				expect(result).toBeInstanceOf(Error);
			}
		} finally {
			fx.cleanup();
		}
	});
});
