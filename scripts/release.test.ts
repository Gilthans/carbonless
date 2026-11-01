import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bump,
	compareVersions,
	type Io,
	newestTag,
	next,
	nextRc,
	parseTag,
	parseVersion,
	previousRelease,
	promote,
	type RunResult,
	rcBehindLatest,
	rcToPublish,
	releasePrs,
	renderChangelog,
	resolvePromote,
	status,
	tagNames,
	withVersion,
} from "./release-lib.js";

const v = (text: string) => {
	const parsed = parseVersion(text);
	if (!parsed) throw new Error(text);
	return parsed;
};

describe("version math", () => {
	it("parses releases, RCs and their tags; nothing else", () => {
		expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
		expect(parseVersion("1.2.3-rc.10")).toEqual({
			major: 1,
			minor: 2,
			patch: 3,
			rc: 10,
		});
		expect(parseTag("v0.1.0-rc.1")).toEqual(v("0.1.0-rc.1"));
		expect(parseTag("refs/tags/v2.0.0")).toEqual(v("2.0.0"));
		for (const bad of ["0.1", "01.0.0", "0.1.0-beta.1", "0.1.0-rc", "x"]) {
			expect(parseVersion(bad)).toBeNull();
		}
		expect(parseTag("0.1.0")).toBeNull();
		expect(parseTag("vnext")).toBeNull();
	});

	it("orders an RC before its release, numerically", () => {
		const sorted = ["0.2.0", "0.1.0", "0.2.0-rc.10", "0.2.0-rc.2", "0.10.0"]
			.map(v)
			.sort(compareVersions);
		expect(sorted).toEqual(
			["0.1.0", "0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "0.10.0"].map(v),
		);
	});

	it("the next RC is one past the highest of the tags and npm, for that release only", () => {
		expect(nextRc(v("0.1.0"), [], [])).toEqual(v("0.1.0-rc.1"));
		expect(
			nextRc(v("0.1.0"), ["v0.1.0-rc.1", "v0.1.0-rc.3", "v0.0.9-rc.7"], []),
		).toEqual(v("0.1.0-rc.4"));
		// npm saw rc.5 even though its tag is gone: never reuse it.
		expect(
			nextRc(
				v("0.1.0"),
				["v0.1.0-rc.3"],
				["0.1.0-rc.5", "0.1.0", "0.2.0-rc.9"],
			),
		).toEqual(v("0.1.0-rc.6"));
		expect(() => nextRc(v("0.1.0-rc.1"), [], [])).toThrow(/next release/);
	});

	it("bumps a release", () => {
		expect(bump(v("1.2.3"), "patch")).toEqual(v("1.2.4"));
		expect(bump(v("1.2.3"), "minor")).toEqual(v("1.3.0"));
		expect(bump(v("1.2.3"), "major")).toEqual(v("2.0.0"));
	});

	it("finds the newest RC or release tag, and the release before one", () => {
		const tags = ["v0.1.0", "v0.2.0-rc.2", "v0.2.0-rc.10", "junk", "v0.1.1"];
		expect(newestTag(tags, true)?.tag).toBe("v0.2.0-rc.10");
		expect(newestTag(tags, false)?.tag).toBe("v0.1.1");
		expect(newestTag([], true)).toBeNull();
		expect(previousRelease(tags, v("0.2.0"))).toBe("v0.1.1");
		expect(previousRelease(tags, v("0.1.0"))).toBeNull();
	});

	it("reads tag names from ls-remote and tag -l", () => {
		expect(
			tagNames("abc\trefs/tags/v0.1.0-rc.1\ndef\trefs/tags/v0.1.0^{}\n"),
		).toEqual(["v0.1.0-rc.1", "v0.1.0"]);
		expect(tagNames("v1.0.0\nv1.1.0\n")).toEqual(["v1.0.0", "v1.1.0"]);
	});

	it("sets package.json's version and keeps its formatting", () => {
		const pkg =
			'{\n\t"name": "x",\n\t"version": "0.1.0-rc.1",\n\t"dependencies": {\n\t\t"version": "1"\n\t}\n}\n';
		expect(withVersion(pkg, "0.2.0")).toBe(
			pkg.replace('"0.1.0-rc.1"', '"0.2.0"'),
		);
		expect(() => withVersion("{}", "1.0.0")).toThrow();
	});
});

describe("renderChangelog", () => {
	const prs = [
		{ number: 7, title: "Second ", mergedAt: "2026-11-03T00:00:00Z" },
		{ number: 5, title: "First", mergedAt: "2026-11-02T00:00:00Z" },
	];

	it("starts the file, PRs in merge order", () => {
		expect(renderChangelog(null, "0.1.0", "2026-11-04", prs)).toBe(
			"# Changelog\n\n## 0.1.0 (2026-11-04)\n\n- First (#5)\n- Second (#7)\n",
		);
	});

	it("puts a new release on top and replaces a rerun's section", () => {
		const first = renderChangelog(null, "0.1.0", "2026-11-04", prs);
		const second = renderChangelog(first, "0.2.0", "2026-12-01", []);
		expect(second).toBe(
			"# Changelog\n\n## 0.2.0 (2026-12-01)\n\n- No PRs.\n\n## 0.1.0 (2026-11-04)\n\n- First (#5)\n- Second (#7)\n",
		);
		expect(
			renderChangelog(second, "0.2.0", "2026-12-02", prs.slice(0, 1)),
		).toBe(
			"# Changelog\n\n## 0.2.0 (2026-12-02)\n\n- Second (#7)\n\n## 0.1.0 (2026-11-04)\n\n- First (#5)\n- Second (#7)\n",
		);
	});
});

/** A runner answering from handlers keyed by "cmd arg1 arg2…" prefixes. */
function fakeIo(
	handlers: Record<
		string,
		| Partial<RunResult>
		| string
		| ((args: string[]) => Partial<RunResult> | string)
	>,
) {
	const calls: string[] = [];
	const lines: string[] = [];
	const io: Io = {
		repo: "owner/repo",
		log: (line) => lines.push(line),
		now: () => new Date("2026-11-04T10:00:00Z"),
		sleep: async () => {},
		run: async (cmd, args) => {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			const key = Object.keys(handlers)
				.filter((k) => line.startsWith(k))
				.sort((a, b) => b.length - a.length)[0];
			if (key === undefined) {
				return { code: 127, stdout: "", stderr: `unexpected: ${line}` };
			}
			const handler = handlers[key] ?? "";
			const out = typeof handler === "function" ? handler([...args]) : handler;
			return typeof out === "string"
				? { code: 0, stdout: out, stderr: "" }
				: { code: 0, stdout: "", stderr: "", ...out };
		},
	};
	return { io, calls, lines };
}

const lsRemote = (...tags: string[]) =>
	tags.map((t, i) => `${String(i).repeat(40)}\trefs/tags/${t}`).join("\n");
const npmView = (distTags: Record<string, string>, versions: string[]) =>
	JSON.stringify({ "dist-tags": distTags, versions });
const NPM_404 = {
	code: 1,
	stderr:
		"npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/carbonless-review",
};
const contents = (version: string) =>
	Buffer.from(JSON.stringify({ name: "carbonless-review", version })).toString(
		"base64",
	);

describe("workflow steps", () => {
	it("the first push publishes the RC after the interim ones, flagged as the first publish", async () => {
		const { io } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
		});
		expect(await rcToPublish(io, "0.1.0")).toEqual({
			version: "0.1.0-rc.2",
			firstPublish: true,
			blocked: null,
		});
	});

	it("later pushes count npm's versions too", async () => {
		const { io } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0", "v0.2.0-rc.1"),
			"npm view": npmView({ latest: "0.1.0", rc: "0.2.0-rc.2" }, [
				"0.1.0",
				"0.2.0-rc.2",
			]),
		});
		expect(await rcToPublish(io, "0.2.0")).toEqual({
			version: "0.2.0-rc.3",
			firstPublish: false,
			blocked: null,
		});
		await expect(rcToPublish(io, "0.2.0-rc.1")).rejects.toThrow(/X\.Y\.Z/);
	});

	it("no RC of a version that is released: rc would move backwards", async () => {
		// promote published 0.1.0; master stays at 0.1.0 until "next: 0.2.0" merges.
		const byNpm = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.4"),
			"npm view": npmView({ latest: "0.1.0", rc: "0.1.0" }, [
				"0.1.0-rc.4",
				"0.1.0",
			]),
		});
		const r = await rcToPublish(byNpm.io, "0.1.0");
		expect(r.blocked).toMatch(/0\.1\.0 is released.*"next" PR/);
		// Its tag alone is enough (npm's view may lag a publish).
		const byTag = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.4", "v0.1.0"),
			"npm view": npmView({ latest: "0.0.9", rc: "0.1.0-rc.4" }, [
				"0.0.9",
				"0.1.0-rc.4",
			]),
		});
		expect((await rcToPublish(byTag.io, "0.1.0")).blocked).not.toBeNull();
		expect((await rcToPublish(byTag.io, "0.2.0")).blocked).toBeNull();
	});

	it("the workflows' steps read the checkout's tags, never origin", async () => {
		const { io, calls } = fakeIo({
			"git tag -l": "v0.1.0-rc.1\nv0.1.0-rc.7\n",
			"npm view": NPM_404,
		});
		io.tags = "local";
		expect((await rcToPublish(io, "0.1.0")).version).toBe("0.1.0-rc.8");
		expect(calls.some((c) => c.startsWith("git ls-remote"))).toBe(false);
		expect(calls).toContain(
			"npm view carbonless-review dist-tags versions --json --prefer-online",
		);
	});

	it("rc is never left behind latest", () => {
		const state = (distTags: Record<string, string>) => ({
			distTags,
			versions: [],
		});
		expect(rcBehindLatest(null)).toBeNull();
		expect(rcBehindLatest(state({ latest: "0.1.0" }))).toBe("0.1.0");
		expect(rcBehindLatest(state({ latest: "0.1.0", rc: "0.1.0-rc.9" }))).toBe(
			"0.1.0",
		);
		expect(rcBehindLatest(state({ latest: "0.1.0", rc: "0.1.0" }))).toBeNull();
		expect(
			rcBehindLatest(state({ latest: "0.1.0", rc: "0.2.0-rc.1" })),
		).toBeNull();
	});

	it("rc's floor is what this run published, whatever a stale read says", () => {
		const state = (distTags: Record<string, string>) => ({
			distTags,
			versions: [],
		});
		// Promote's first publish, read back as a 404.
		expect(rcBehindLatest(null, "0.1.0")).toBe("0.1.0");
		// Promote of 0.2.0, latest not updated yet.
		expect(
			rcBehindLatest(state({ latest: "0.1.0", rc: "0.2.0-rc.3" }), "0.2.0"),
		).toBe("0.2.0");
		// publish-rc's read misses its own 0.2.0-rc.1: rc is not moved back to 0.1.0.
		expect(
			rcBehindLatest(state({ latest: "0.1.0", rc: "0.1.0" }), "0.2.0-rc.1"),
		).toBe("0.2.0-rc.1");
		expect(
			rcBehindLatest(state({ latest: "0.1.0", rc: "0.1.0" }), "0.2.0-rc.1"),
		).not.toBe("0.1.0");
		// A release that landed meanwhile still wins over this run's RC.
		expect(
			rcBehindLatest(
				state({ latest: "0.1.0", rc: "0.1.0-rc.5" }),
				"0.1.0-rc.5",
			),
		).toBe("0.1.0");
		// rc already on (or past) the floor: nothing to do.
		expect(
			rcBehindLatest(
				state({ latest: "0.1.0", rc: "0.2.0-rc.1" }),
				"0.2.0-rc.1",
			),
		).toBeNull();
	});

	it("promote refuses a release that isn't newer than latest", async () => {
		const { io } = fakeIo({
			"git ls-remote": lsRemote("v0.1.1-rc.1", "v0.2.0"),
			"npm view": npmView({ latest: "0.2.0" }, ["0.2.0"]),
		});
		await expect(resolvePromote(io, "v0.1.1-rc.1")).rejects.toThrow(
			/0\.1\.1 is not newer than latest \(0\.2\.0\)/,
		);
	});

	it("an npm failure other than 404 fails, never passes for a first publish", async () => {
		const { io } = fakeIo({
			"git ls-remote": lsRemote(),
			"npm view": { code: 1, stderr: "npm error code ETIMEDOUT" },
		});
		await expect(rcToPublish(io, "0.1.0")).rejects.toThrow(/ETIMEDOUT/);
	});

	it("promote plans the newest RC by default", async () => {
		const { io } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2", "v0.1.0-rc.10"),
			"npm view": NPM_404,
		});
		expect(await resolvePromote(io, "")).toEqual({
			tag: "v0.1.0-rc.10",
			release: "0.1.0",
		});
		expect(await resolvePromote(io, "v0.1.0-rc.2")).toMatchObject({
			release: "0.1.0",
		});
		await expect(resolvePromote(io, "v0.1.0-rc.3")).rejects.toThrow(
			/not on origin/,
		);
		await expect(resolvePromote(io, "v0.1.0")).rejects.toThrow(/not an RC/);
	});

	it("promote refuses a release that exists; an older RC whose release doesn't is fine", async () => {
		const done = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2", "v0.1.0"),
			"npm view": npmView({ latest: "0.1.0" }, ["0.1.0"]),
		});
		await expect(resolvePromote(done.io, "v0.1.0-rc.2")).rejects.toThrow(
			/already released/,
		);
		const newer = fakeIo({
			"git ls-remote": lsRemote("v0.1.0", "v0.1.1-rc.1", "v0.2.0-rc.1"),
			"npm view": npmView({ latest: "0.1.0", rc: "0.2.0-rc.1" }, [
				"0.1.0",
				"0.2.0-rc.1",
			]),
		});
		expect(await resolvePromote(newer.io, "v0.1.1-rc.1")).toEqual({
			tag: "v0.1.1-rc.1",
			release: "0.1.1",
		});
	});
});

describe("releasePrs", () => {
	let repo: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	const commit = (message: string) => {
		git("commit", "--allow-empty", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "crb-release-"));
		git("init", "-q", "-b", "master");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("picks the PRs merged after the previous release up to the RC", async () => {
		const old = commit("old");
		git("tag", "v0.1.0");
		const a = commit("a");
		const b = commit("b");
		git("tag", "v0.2.0-rc.1");
		const later = commit("later");
		const pr = (number: number, oid: string | null) => ({
			number,
			title: `PR ${number}`,
			mergedAt: `2026-11-0${number}T00:00:00Z`,
			mergeCommit: oid ? { oid } : null,
		});
		const { io, calls } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0", "v0.2.0-rc.1"),
			"gh pr list": JSON.stringify([
				pr(1, old),
				pr(2, a),
				pr(3, b),
				pr(4, later),
				pr(5, null),
				pr(6, "f".repeat(40)),
			]),
			"git merge-base": (args) => {
				try {
					execFileSync("git", args, { cwd: repo, stdio: "ignore" });
					return "";
				} catch {
					return { code: 1 };
				}
			},
		});
		const prs = await releasePrs(io, "0.2.0", "v0.2.0-rc.1", repo);
		expect(prs.map((p) => p.number)).toEqual([2, 3]);
		expect(calls).toContain(
			"gh pr list --repo owner/repo --state merged --base master --limit 1000 --json number,title,mergedAt,mergeCommit",
		);
	});
});

describe("pnpm release", () => {
	it("status shows master's next version, both channels and the next RC", async () => {
		const { io, lines } = fakeIo({
			"gh api repos/owner/repo/contents/package.json?ref=master":
				contents("0.2.0"),
			"git ls-remote": lsRemote("v0.1.0-rc.4", "v0.1.0", "v0.2.0-rc.1"),
			"npm view": npmView({ latest: "0.1.0", rc: "0.2.0-rc.1" }, [
				"0.1.0",
				"0.2.0-rc.1",
			]),
		});
		await status(io);
		expect(lines).toEqual([
			"master:  next release 0.2.0",
			"rc:      npm 0.2.0-rc.1, newest tag v0.2.0-rc.1",
			"latest:  npm 0.1.0, newest tag v0.1.0",
			"next merge to master publishes 0.2.0-rc.2",
		]);
	});

	it("status before the first publish", async () => {
		const { io, lines } = fakeIo({
			"gh api": contents("0.1.0"),
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
		});
		await status(io);
		expect(lines).toContain("npm:     carbonless-review is not published yet");
		expect(lines).toContain("next merge to master publishes 0.1.0-rc.2");
	});

	it("promote dispatches the workflow for the newest RC and prints the run's URL", async () => {
		const { io, calls, lines } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2", "v0.1.0-rc.3"),
			"gh workflow run":
				"✓ Created workflow_dispatch event for promote.yml at master\nhttps://github.com/owner/repo/actions/runs/42\n",
		});
		const url = await promote(io, undefined, "minor");
		expect(url).toBe("https://github.com/owner/repo/actions/runs/42");
		expect(calls).toContain(
			"gh workflow run promote.yml --repo owner/repo --ref master -f rc=v0.1.0-rc.3 -f next=minor",
		);
		expect(lines.at(-1)).toBe(url);
	});

	it("promote finds the run when gh doesn't print it", async () => {
		let polls = 0;
		const { io } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2"),
			"gh workflow run": "",
			"gh run list": () =>
				++polls < 3
					? JSON.stringify([{ url: "old", createdAt: "2026-11-01T00:00:00Z" }])
					: JSON.stringify([
							{ url: "new", createdAt: "2026-11-04T10:00:01Z" },
							{ url: "old", createdAt: "2026-11-01T00:00:00Z" },
						]),
		});
		expect(await promote(io, "v0.1.0-rc.2", "patch")).toBe("new");
		expect(polls).toBe(3);
	});

	it("promote refuses what isn't an RC on origin, or is released, before dispatching", async () => {
		const { io, calls } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2", "v0.1.0"),
		});
		await expect(promote(io, "v0.1.0-rc.2", "minor")).rejects.toThrow(
			/already released/,
		);
		await expect(promote(io, "v0.2.0-rc.1", "minor")).rejects.toThrow(
			/not on origin/,
		);
		await expect(promote(io, "main", "minor")).rejects.toThrow(/not an RC/);
		expect(calls.some((c) => c.startsWith("gh workflow"))).toBe(false);
	});

	describe("next", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "crb-next-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		const nextIo = (tags: string[], master = "0.3.0") =>
			fakeIo({
				"git ls-remote": lsRemote(...tags),
				"gh api": contents(master),
				"git fetch origin master": "",
				"git worktree add": (args) => {
					const wt = args[4] ?? "";
					mkdirSync(wt, { recursive: true });
					writeFileSync(
						join(wt, "package.json"),
						`{\n\t"name": "carbonless-review",\n\t"version": "${master}"\n}\n`,
					);
					return "";
				},
				"git commit": "",
				"git push": "",
				"gh pr create": "https://github.com/owner/repo/pull/9\n",
				"git worktree remove": "",
				"git branch -D": "",
			});

		it("a kind bumps the newest release; a PR changes only package.json", async () => {
			const wt = join(dir, "wt");
			const { io, calls } = nextIo(["v0.2.0", "v0.3.0-rc.1"]);
			expect(await next(io, "patch", wt)).toBe(
				"https://github.com/owner/repo/pull/9",
			);
			expect(readFileSync(join(wt, "package.json"), "utf8")).toContain(
				'"version": "0.2.1"',
			);
			expect(calls).toContain(
				`git worktree add -b next/0.2.1 ${wt} origin/master`,
			);
			expect(calls.find((c) => c.startsWith("git commit"))).toMatch(
				/^git commit --only -m next: 0\.2\.1\n[\s\S]*-- package\.json$/,
			);
			expect(calls).toContain("git push -u origin next/0.2.1");
			expect(calls.slice(-2)).toEqual([
				`git worktree remove --force ${wt}`,
				"git branch -D next/0.2.1",
			]);
		});

		it("takes an explicit version; refuses one not after the newest release, or master's", async () => {
			const { io } = nextIo(["v0.2.0"]);
			expect(await next(io, "1.0.0", join(dir, "a"))).toMatch(/pull\/9/);
			await expect(next(io, "0.2.0", join(dir, "b"))).rejects.toThrow(
				/not after/,
			);
			await expect(next(io, "0.3.0", join(dir, "c"))).rejects.toThrow(
				/already at/,
			);
			await expect(next(io, "0.4.0-rc.1", join(dir, "d"))).rejects.toThrow(
				/not patch/,
			);
			expect(existsSync(join(dir, "b"))).toBe(false);
		});

		it("a kind needs a release to bump", async () => {
			const { io } = nextIo(["v0.1.0-rc.2"]);
			await expect(next(io, "minor", join(dir, "a"))).rejects.toThrow(
				/nothing is released/,
			);
		});
	});
});

describe("ci:set-version", { timeout: 30_000 }, () => {
	let repo: string;
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("the build records the new version and the clean commit, not -dirty", () => {
		repo = mkdtempSync(join(tmpdir(), "crb-setversion-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		git("init", "-q");
		mkdirSync(join(repo, "scripts"));
		writeFileSync(
			join(repo, "scripts/build-info.mjs"),
			readFileSync(join(import.meta.dirname, "build-info.mjs")),
		);
		writeFileSync(
			join(repo, "package.json"),
			'{\n\t"name": "carbonless-review",\n\t"version": "0.1.0"\n}\n',
		);
		writeFileSync(join(repo, ".gitignore"), "dist/\n");
		git("add", ".");
		git("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "x");
		const out = execFileSync(
			join(import.meta.dirname, "../node_modules/.bin/tsx"),
			[
				join(import.meta.dirname, "release.ts"),
				"ci:set-version",
				"0.1.0-rc.2",
				repo,
			],
			{ encoding: "utf8" },
		);
		expect(out).toBe("version=0.1.0-rc.2\n");
		expect(readFileSync(join(repo, "package.json"), "utf8")).toContain(
			'"version": "0.1.0-rc.2"',
		);
		expect(git("status", "--porcelain")).toBe("");
		execFileSync("node", ["scripts/build-info.mjs"], { cwd: repo });
		expect(
			JSON.parse(readFileSync(join(repo, "dist/build-info.json"), "utf8")),
		).toEqual({ version: "0.1.0-rc.2", commit: git("rev-parse", "HEAD") });
	});

	it("refuses a tree that is dirty anyway", () => {
		repo = mkdtempSync(join(tmpdir(), "crb-setversion-"));
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "package.json"), '{\n\t"version": "0.1.0"\n}\n');
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "x"],
			{ cwd: repo },
		);
		writeFileSync(join(repo, "stray.txt"), "x");
		expect(() =>
			execFileSync(
				join(import.meta.dirname, "../node_modules/.bin/tsx"),
				[
					join(import.meta.dirname, "release.ts"),
					"ci:set-version",
					"0.1.0-rc.2",
					repo,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		).toThrow(/not clean/);
	});
});
