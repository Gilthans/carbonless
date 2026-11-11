import { execFileSync } from "node:child_process";
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
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rcMoveTo } from "./rc-fixup.mjs";
import {
	bump,
	checkRcPublish,
	compareVersions,
	finishPlan,
	type Io,
	newestTag,
	next,
	nextRc,
	type PublishIo,
	parseManifest,
	parseTag,
	parseVersion,
	previousRelease,
	promote,
	publishRelease,
	type RunResult,
	rcBehindLatest,
	rcToPublish,
	releasePrs,
	renderChangelog,
	resolvePromote,
	stagedIds,
	status,
	tagNames,
	tarballDigests,
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
		| ((args: string[], opts?: { cwd?: string }) => Partial<RunResult> | string)
	>,
) {
	const calls: string[] = [];
	const lines: string[] = [];
	// A full checkout with nothing in package.json's history, and RC tags on
	// master, unless a test says otherwise.
	const defaults: typeof handlers = {
		"git rev-parse --is-shallow-repository": "false\n",
		"git log -p": "",
		"git merge-base --is-ancestor": "",
		"gh api repos/owner/repo/compare/": "ahead\n",
		"git status --porcelain": "",
		"git diff --quiet origin/master": "",
	};
	const io: Io = {
		repo: "owner/repo",
		log: (line) => lines.push(line),
		now: () => new Date("2026-11-04T10:00:00Z"),
		sleep: async () => {},
		run: async (cmd, args, opts) => {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			const pick = (from: typeof handlers) =>
				Object.keys(from)
					.filter((k) => line.startsWith(k))
					.sort((a, b) => b.length - a.length)[0];
			const own = pick(handlers);
			const fallback = own === undefined ? pick(defaults) : undefined;
			if (own === undefined && fallback === undefined) {
				return { code: 127, stdout: "", stderr: `unexpected: ${line}` };
			}
			const handler =
				(own !== undefined ? handlers[own] : defaults[fallback ?? ""]) ?? "";
			const out =
				typeof handler === "function" ? handler([...args], opts) : handler;
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

	it("the RC after the flip skips the interim RCs set in package.json by hand, whose tags never reached origin", async () => {
		// master's package.json went 0.1.0-rc.1 … 0.1.0-rc.4, then 0.1.0 (the flip);
		// only v0.1.0-rc.1 is on origin.
		const history = [
			'-\t"version": "0.1.0-rc.4",',
			'+\t"version": "0.1.0",',
			'-\t"version": "0.1.0-rc.3",',
			'+\t"version": "0.1.0-rc.4",',
			'+\t"version": "0.1.0-rc.1",',
			'+  "version": "0.2.0-rc.9",',
		].join("\n");
		const { io, calls } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
			"git log -p": history,
		});
		expect((await rcToPublish(io, "0.1.0")).version).toBe("0.1.0-rc.5");
		expect(calls).toContain("git log -p --format= HEAD -- package.json");
		// Another release's RCs don't count.
		expect((await rcToPublish(io, "0.3.0")).version).toBe("0.3.0-rc.1");
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

	it("package.json's history must be whole: a shallow checkout or a git error fails, never undercounts", async () => {
		const shallow = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
			"git rev-parse --is-shallow-repository": "true\n",
		});
		await expect(rcToPublish(shallow.io, "0.1.0")).rejects.toThrow(/shallow/);
		const broken = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
			"git log -p": { code: 128, stderr: "fatal: bad revision" },
		});
		await expect(rcToPublish(broken.io, "0.1.0")).rejects.toThrow(
			/git log -p .* failed \(128\): fatal: bad revision/,
		);
	});

	it("an RC run publishes only an X.Y.Z-rc.N, only to rc", () => {
		expect(() => checkRcPublish("0.2.0-rc.3", "rc")).not.toThrow();
		for (const bad of [
			"0.2.0",
			"0.2.0-rc.3 ",
			"0.2.0-beta.1",
			"x",
			"0.2.0-rc.03",
		]) {
			expect(() => checkRcPublish(bad, "rc")).toThrow(/refusing/);
		}
		expect(() => checkRcPublish("0.2.0-rc.3", "latest")).toThrow(/rc only/);
		const wf = readFileSync(
			join(import.meta.dirname, "../.github/workflows/release.yml"),
			"utf8",
		);
		// In the build (the version and its tarball), and again right before
		// the publish, in the job that has no dependency code.
		expect(wf).toContain(
			'pnpm exec tsx scripts/release.ts ci:check-publish rc "$VERSION"',
		);
		const guard = wf.indexOf(
			'[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$ ]]',
		);
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(wf.indexOf("npm publish"));
		expect(wf).toContain('npm publish "$TGZ" --tag rc --access public\n');
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

	it("rc's fix-up runs without dependencies, and refuses a bad version before asking npm", () => {
		expect(rcMoveTo({ latest: "0.2.0", rc: "0.2.0-rc.3" }, undefined)).toBe(
			"0.2.0",
		);
		expect(
			rcMoveTo({ latest: "0.2.0", rc: "0.3.0-rc.1" }, undefined),
		).toBeNull();
		expect(rcMoveTo(null, "0.1.0")).toBe("0.1.0");
		const r = (() => {
			try {
				execFileSync(
					process.execPath,
					[join(import.meta.dirname, "rc-fixup.mjs"), "1.0"],
					{
						stdio: "pipe",
						env: { ...process.env, PATH: "/nonexistent" },
					},
				);
				return 0;
			} catch (error) {
				return (error as { status?: number }).status;
			}
		})();
		expect(r).toBe(2);
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

	it("promote refuses an RC tag whose commit isn't on master", async () => {
		// People: GitHub's compare of the tag and master.
		const people = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.4", "v0.1.0-rc.9"),
			"npm view": NPM_404,
			"gh api repos/owner/repo/compare/v0.1.0-rc.9...master": "diverged\n",
		});
		await expect(resolvePromote(people.io, "")).rejects.toThrow(
			"v0.1.0-rc.9 is not on master",
		);
		expect(people.calls).toContain(
			"gh api repos/owner/repo/compare/v0.1.0-rc.9...master --jq .status",
		);
		// The workflow: its master checkout's history.
		const ci = fakeIo({
			"git tag -l": "v0.1.0-rc.4\nv0.1.0-rc.9\n",
			"npm view": NPM_404,
			"git merge-base --is-ancestor refs/tags/v0.1.0-rc.9": { code: 1 },
		});
		ci.io.tags = "local";
		await expect(resolvePromote(ci.io, "")).rejects.toThrow("is not on master");
		expect(await resolvePromote(ci.io, "v0.1.0-rc.4")).toEqual({
			tag: "v0.1.0-rc.4",
			release: "0.1.0",
		});
		expect(ci.calls).toContain(
			"git merge-base --is-ancestor refs/tags/v0.1.0-rc.4^{commit} HEAD",
		);
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
			"next merge to master publishes 0.2.0-rc.2 on rc",
		]);
	});

	it("status says what publish-rc will do: the first publish only tags, after the interim RCs in origin/master's history", async () => {
		const { io, lines, calls } = fakeIo({
			"gh api": contents("0.1.0"),
			"git ls-remote": lsRemote("v0.1.0-rc.1"),
			"npm view": NPM_404,
			"git log -p": '+\t"version": "0.1.0",\n-\t"version": "0.1.0-rc.4",',
		});
		await status(io);
		expect(lines).toContain("npm:     carbonless-review is not published yet");
		expect(lines).toContain(
			"next merge to master tags v0.1.0-rc.5 only: carbonless-review is not on npm yet, its first version is a release (pnpm release promote v0.1.0-rc.5)",
		);
		expect(calls).toContain(
			"git log -p --format= origin/master -- package.json",
		);
	});

	it("status says when a merge publishes nothing: the release is out, the next PR isn't merged", async () => {
		const { io, lines } = fakeIo({
			"gh api": contents("0.1.0"),
			"git ls-remote": lsRemote("v0.1.0-rc.5", "v0.1.0"),
			"npm view": npmView({ latest: "0.1.0", rc: "0.1.0" }, ["0.1.0"]),
		});
		await status(io);
		expect(lines.at(-1)).toMatch(
			/^next merge to master publishes nothing: 0\.1\.0 is released/,
		);
	});

	it("promote dispatches the workflow for the newest RC and prints the run's URL", async () => {
		const { io, calls, lines } = fakeIo({
			"git ls-remote": lsRemote("v0.1.0-rc.2", "v0.1.0-rc.3"),
			"gh workflow run":
				"✓ Created workflow_dispatch event for release.yml at master\nhttps://github.com/owner/repo/actions/runs/42\n",
		});
		const url = await promote(io, undefined, "minor");
		expect(url).toBe("https://github.com/owner/repo/actions/runs/42");
		expect(calls).toContain(
			"gh workflow run release.yml --repo owner/repo --ref master -f mode=promote -f rc=v0.1.0-rc.3 -f next=minor",
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
		// npm records the commit as gitHead: an RC or release is told apart
		// from a master build of the same version.
		const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		expect(pkg).toEqual({
			name: "carbonless-review",
			version: "0.1.0-rc.2",
			gitHead: git("rev-parse", "HEAD"),
		});
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

describe("pnpm release publish (the owner's, with npm's OTP)", () => {
	const SHA = "a".repeat(40);
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "crb-publish-test-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A promote run's artifact: the tarball and its manifest. */
	function artifact({
		version = "0.1.0",
		built = { version: "0.1.0", commit: SHA },
		manifest = {} as Record<string, string>,
		packageJson = {
			name: "carbonless-review",
			version: "0.1.0",
		} as Record<string, unknown>,
	} = {}) {
		const out = join(dir, "artifact");
		const pkg = join(dir, "pkg/package/dist");
		mkdirSync(pkg, { recursive: true });
		mkdirSync(out, { recursive: true });
		writeFileSync(join(pkg, "build-info.json"), JSON.stringify(built));
		writeFileSync(
			join(dir, "pkg/package/package.json"),
			JSON.stringify(packageJson),
		);
		const tgz = join(out, `carbonless-review-${version}.tgz`);
		execFileSync("tar", ["-czf", tgz, "-C", join(dir, "pkg"), "package"]);
		const m = {
			version,
			tag: `v${version}-rc.5`,
			sha: SHA,
			...tarballDigests(readFileSync(tgz)),
			next: "minor",
			tarball: `carbonless-review-${version}.tgz`,
			...manifest,
		};
		writeFileSync(join(out, "manifest.json"), JSON.stringify(m));
		return { out, manifest: m };
	}

	/** A PublishIo over fakeIo: the download copies `out`, real tar. */
	const goodRun = JSON.stringify({
		path: ".github/workflows/release.yml",
		display_title: "Promote the newest RC (next minor)",
		head_branch: "master",
		event: "workflow_dispatch",
		conclusion: "success",
	});

	function publishIo(
		out: string,
		handlers: Parameters<typeof fakeIo>[0] = {},
		{
			answer = true,
			npmCode = 0,
			// npm's answer after the publish: the tarball, or (a registry lag)
			// nothing for this many reads first.
			lag = 0,
			onAsk = () => {},
		} = {},
	) {
		let published = false;
		let reads = 0;
		const fake = fakeIo({
			"gh api repos/owner/repo/actions/runs/": goodRun,
			"gh api repos/owner/repo/git/ref/tags/v0.1.0-rc.5": JSON.stringify({
				sha: SHA,
				type: "commit",
			}),
			// The newest dispatched run is an rc fix-up, not a promote.
			"gh run list": JSON.stringify([
				{ databaseId: 78, displayTitle: "rc up to 0.0.9" },
				{ databaseId: 77, displayTitle: "Promote the newest RC (next minor)" },
			]),
			"gh run download": (args) => {
				const to = args[args.indexOf("--dir") + 1] ?? "";
				for (const f of ["manifest.json", "carbonless-review-0.1.0.tgz"]) {
					if (existsSync(join(out, f))) {
						writeFileSync(join(to, f), readFileSync(join(out, f)));
					}
				}
				return "";
			},
			tar: (args) => execFileSync("tar", args, { encoding: "utf8" }),
			"npm view carbonless-review@0.1.0 dist.integrity": () => {
				if (!published) return "";
				return reads++ < lag
					? ""
					: `${JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).integrity}\n`;
			},
			"npm view carbonless-review dist-tags": NPM_404,
			"gh workflow run release-finish.yml": "",
			...handlers,
		});
		const asked: string[] = [];
		const ran: string[] = [];
		const io: PublishIo = {
			...fake.io,
			ask: async (q) => {
				asked.push(q);
				onAsk();
				return answer;
			},
			interactive: async (cmd, args) => {
				ran.push([cmd, ...args].join(" "));
				// A failed exit may still have published (a timeout after the upload).
				if (npmCode === 0 || npmCode === 99) published = true;
				return npmCode;
			},
		};
		return { ...fake, io, asked, ran };
	}

	it("publishes the newest promote run's checked tarball to latest, npm asking for the OTP, then starts release-finish", async () => {
		const { out, manifest } = artifact();
		const p = publishIo(out);
		await publishRelease(p.io);
		expect(p.calls).toContain(
			"gh run list --repo owner/repo --workflow release.yml --branch master --event workflow_dispatch --status success --limit 20 --json databaseId,displayTitle",
		);
		expect(
			p.calls.some((c) =>
				c.startsWith("gh run download 77 --repo owner/repo --name release"),
			),
		).toBe(true);
		expect(p.asked).toHaveLength(1);
		expect(p.lines.join("\n")).toContain(`sha256 ${manifest.sha256}`);
		expect(p.ran).toHaveLength(1);
		expect(p.ran[0]).toMatch(
			/^npm publish \S+\/carbonless-review-0\.1\.0\.tgz --tag latest --access public$/,
		);
		// No OTP passed: npm asks on the terminal.
		expect(p.ran[0]).not.toContain("otp");
		expect(p.calls).toContain(
			"gh workflow run release-finish.yml --repo owner/repo --ref master -f version=0.1.0 -f run=77",
		);
	});

	it("refuses a tarball whose sha256 isn't the manifest's", async () => {
		const { out } = artifact({ manifest: { sha256: "0".repeat(64) } });
		const p = publishIo(out);
		await expect(publishRelease(p.io, "77")).rejects.toThrow(
			"not the tarball promote checked",
		);
		expect(p.ran).toEqual([]);
		expect(p.asked).toEqual([]);
	});

	it("refuses a tarball whose build-info isn't the RC's commit at the release's version", async () => {
		const other = artifact({
			built: { version: "0.1.0", commit: "b".repeat(40) },
		});
		const p = publishIo(other.out);
		await expect(publishRelease(p.io, "77")).rejects.toThrow(
			/build-info is 0\.1\.0 b{40}, not 0\.1\.0 a{40}/,
		);
		expect(p.ran).toEqual([]);
	});

	it("refuses a tarball whose own package.json isn't carbonless-review at the release, or has a publishConfig", async () => {
		for (const [packageJson, why] of [
			[{ name: "other", version: "0.1.0" }, "name other"],
			[{ name: "carbonless-review", version: "0.1.1" }, "version 0.1.1"],
			[
				{
					name: "carbonless-review",
					version: "0.1.0",
					publishConfig: { tag: "latest" },
				},
				"a publishConfig",
			],
		] as const) {
			rmSync(join(dir, "pkg"), { recursive: true, force: true });
			rmSync(join(dir, "artifact"), { recursive: true, force: true });
			const { out } = artifact({ packageJson: { ...packageJson } });
			const p = publishIo(out);
			await expect(publishRelease(p.io, "77")).rejects.toThrow(
				`the tarball's package.json says ${why}`,
			);
			expect(p.ran).toEqual([]);
			expect(p.asked).toEqual([]);
		}
	});

	it("refuses an RC tag that GitHub has elsewhere, or that isn't on master", async () => {
		const { out } = artifact();
		const moved = publishIo(out, {
			"gh api repos/owner/repo/git/ref/tags/v0.1.0-rc.5": JSON.stringify({
				sha: "c".repeat(40),
				type: "commit",
			}),
		});
		await expect(publishRelease(moved.io, "77")).rejects.toThrow(
			/v0\.1\.0-rc\.5 is at c{40} on GitHub/,
		);
		const off = publishIo(out, {
			"gh api repos/owner/repo/compare/v0.1.0-rc.5...master": "diverged\n",
		});
		await expect(publishRelease(off.io, "77")).rejects.toThrow(
			"v0.1.0-rc.5 is not on master",
		);
		expect([...moved.ran, ...off.ran]).toEqual([]);
	});

	it("takes only a successful, dispatched promote run of master", async () => {
		const { out } = artifact();
		for (const [bad, why] of [
			[{ head_branch: "try-promote" }, "branch try-promote"],
			[
				{ path: ".github/workflows/other.yml" },
				"workflow .github/workflows/other.yml",
			],
			[{ conclusion: "failure" }, "conclusion failure"],
			[{ event: "push" }, "event push"],
			[{ display_title: "rc up to 0.0.9" }, 'run "rc up to 0.0.9"'],
		] as const) {
			const p = publishIo(out, {
				"gh api repos/owner/repo/actions/runs/77": JSON.stringify({
					...JSON.parse(goodRun),
					...bad,
				}),
			});
			await expect(publishRelease(p.io, "77")).rejects.toThrow(
				`run 77 is not a successful promote of master (${why})`,
			);
			expect(p.calls.some((c) => c.startsWith("gh run download"))).toBe(false);
		}
	});

	it("resolves the RC tag exactly, an annotated one through its object", async () => {
		const { out } = artifact();
		const p = publishIo(out, {
			"gh api repos/owner/repo/git/ref/tags/v0.1.0-rc.5": JSON.stringify({
				sha: "d".repeat(40),
				type: "tag",
			}),
			[`gh api repos/owner/repo/git/tags/${"d".repeat(40)}`]: `${SHA}\n`,
		});
		await publishRelease(p.io, "77");
		expect(p.ran).toHaveLength(1);
		expect(p.calls.some((c) => c.includes("/commits/"))).toBe(false);
	});

	it("waits for npm to show the release before starting release-finish", async () => {
		const { out } = artifact();
		const p = publishIo(out, {}, { lag: 3 });
		await publishRelease(p.io, "77");
		expect(
			p.calls.filter((c) => c.startsWith("npm view carbonless-review@0.1.0"))
				.length,
		).toBeGreaterThan(4);
		expect(
			p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
		).toBe(true);

		const never = publishIo(out, {}, { lag: 1000 });
		await expect(publishRelease(never.io, "77")).rejects.toThrow(
			"npm doesn't show 0.1.0 yet; once it does, start release-finish",
		);
		expect(never.calls.some((c) => c.startsWith("gh workflow run"))).toBe(
			false,
		);
	});

	it("a failed npm publish whose tarball is on npm anyway counts as published", async () => {
		const { out } = artifact();
		const p = publishIo(out, {}, { npmCode: 99 });
		await publishRelease(p.io, "77");
		expect(
			p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
		).toBe(true);
	});

	it("refuses to run from a dirty checkout or from code that isn't origin/master's", async () => {
		const { out } = artifact();
		const dirty = publishIo(out, {
			"git status --porcelain": " M scripts/release-lib.ts\n",
		});
		await expect(publishRelease(dirty.io, "77")).rejects.toThrow(
			"from a clean checkout",
		);
		const changed = publishIo(out, {
			"git diff --quiet origin/master": { code: 1 },
		});
		await expect(publishRelease(changed.io, "77")).rejects.toThrow(
			"scripts/release*.ts or package.json differ from origin/master",
		);
		expect(changed.calls).toContain(
			"git diff --quiet origin/master -- scripts/release*.ts package.json",
		);
		expect(
			[...dirty.calls, ...changed.calls].some((c) => c.startsWith("gh ")),
		).toBe(false);
	});

	it("refuses a tarball swapped while the question waits", async () => {
		const { out } = artifact();
		let dir = "";
		const p = publishIo(
			out,
			{},
			{
				onAsk: () => {
					writeFileSync(join(dir, "carbonless-review-0.1.0.tgz"), "swapped");
				},
			},
		);
		const download = p.io.run;
		p.io.run = async (cmd, args, opts) => {
			if (cmd === "gh" && args[1] === "download") {
				dir = args[args.indexOf("--dir") + 1] ?? "";
			}
			return download(cmd, args, opts);
		};
		await expect(publishRelease(p.io, "77")).rejects.toThrow(
			"changed after it was checked",
		);
		expect(p.ran).toEqual([]);
	});

	it("refuses a release that isn't newer than latest", async () => {
		const { out } = artifact();
		const p = publishIo(out, {
			"npm view carbonless-review dist-tags": npmView({ latest: "0.2.0" }, [
				"0.2.0",
			]),
		});
		await expect(publishRelease(p.io, "77")).rejects.toThrow(
			"0.1.0 is not newer than latest (0.2.0)",
		);
		expect(p.ran).toEqual([]);
	});

	it("needs a terminal: never answered through a pipe", () => {
		expect(() =>
			execFileSync(
				join(import.meta.dirname, "../node_modules/.bin/tsx"),
				[join(import.meta.dirname, "release.ts"), "publish"],
				{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "y\n" },
			),
		).toThrow(/needs the owner at a terminal/);
	});

	describe("after the first release: approving what promote staged", () => {
		const STAGE = "0f1e2d3c-4b5a-4968-8776-655443322110";
		const onNpm = {
			"npm view carbonless-review dist-tags": npmView({ latest: "0.0.9" }, [
				"0.0.9",
			]),
			"npm stage list carbonless-review --json": JSON.stringify([
				{ id: STAGE, version: "0.1.0" },
			]),
		};
		/** `npm stage download` writing `file`'s bytes into its cwd. */
		const stageDownload = (file: string) => ({
			[`npm stage download ${STAGE}`]: (
				_args: string[],
				opts?: { cwd?: string },
			) => {
				writeFileSync(
					join(opts?.cwd ?? "", `carbonless-review-0.1.0-${STAGE}.tgz`),
					readFileSync(file),
				);
				return "";
			},
		});

		it("checks the staged tarball is promote's, then npm stage approve (npm asks for the OTP), then release-finish", async () => {
			const { out } = artifact({ manifest: { stageId: STAGE } });
			const p = publishIo(out, {
				...onNpm,
				...stageDownload(join(out, "carbonless-review-0.1.0.tgz")),
			});
			await publishRelease(p.io, "77");
			expect(p.calls).toContain(`npm stage download ${STAGE}`);
			expect(p.lines.join("\n")).toContain(`approve staged ${STAGE}`);
			expect(p.ran).toEqual([`npm stage approve ${STAGE}`]);
			expect(
				p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
			).toBe(true);
		});

		it("refuses while another staged entry for the version exists, naming both ids", async () => {
			const { out } = artifact({ manifest: { stageId: STAGE } });
			const OTHER = "99999999-8888-4777-8666-555555555555";
			const p = publishIo(out, {
				...onNpm,
				...stageDownload(join(out, "carbonless-review-0.1.0.tgz")),
				"npm stage list carbonless-review --json": JSON.stringify([
					{ id: OTHER, version: "0.1.0" },
					{ id: STAGE, version: "0.1.0" },
				]),
			});
			await expect(publishRelease(p.io, "77")).rejects.toThrow(
				`carbonless-review@0.1.0 is staged more than once: ${STAGE} (this promote run) and ${OTHER}`,
			);
			expect(p.asked).toEqual([]);
			expect(p.ran).toEqual([]);
			expect(
				stagedIds(
					JSON.stringify({
						items: [
							{ stageId: OTHER, version: "0.1.0" },
							{ version: "0.1.0" },
							{ id: STAGE, version: "0.0.9" },
						],
					}),
					"0.1.0",
				),
			).toEqual([OTHER, "?"]);
		});

		it("refuses a staged version that isn't the tarball promote checked", async () => {
			const { out } = artifact({ manifest: { stageId: STAGE } });
			const other = join(dir, "other.tgz");
			writeFileSync(other, "not it");
			const p = publishIo(out, { ...onNpm, ...stageDownload(other) });
			await expect(publishRelease(p.io, "77")).rejects.toThrow(
				`the staged ${STAGE} is not the tarball promote checked`,
			);
			expect(p.ran).toEqual([]);
			expect(p.asked).toEqual([]);
		});

		it("approved on npmjs.com already: nothing to approve, release-finish starts", async () => {
			const { out, manifest } = artifact({ manifest: { stageId: STAGE } });
			const p = publishIo(out, {
				...onNpm,
				"npm view carbonless-review@0.1.0 dist.integrity": `${manifest.integrity}\n`,
			});
			await publishRelease(p.io, "77");
			expect(p.calls.some((c) => c.startsWith("npm stage"))).toBe(false);
			expect(p.ran).toEqual([]);
			expect(
				p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
			).toBe(true);
		});

		it("a failed approve whose version is live anyway counts as done", async () => {
			const { out } = artifact({ manifest: { stageId: STAGE } });
			const p = publishIo(
				out,
				{
					...onNpm,
					...stageDownload(join(out, "carbonless-review-0.1.0.tgz")),
				},
				{ npmCode: 99 },
			);
			await publishRelease(p.io, "77");
			expect(
				p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
			).toBe(true);
			const failing = publishIo(
				out,
				{
					...onNpm,
					...stageDownload(join(out, "carbonless-review-0.1.0.tgz")),
				},
				{ npmCode: 1 },
			);
			await expect(publishRelease(failing.io, "77")).rejects.toThrow(
				"npm stage approve failed (1)",
			);
		});

		it("a promote run that staged nothing can't be published once the package exists", async () => {
			const { out } = artifact();
			const p = publishIo(out, onNpm);
			await expect(publishRelease(p.io, "77")).rejects.toThrow(
				"promote run 77 staged nothing, and carbonless-review is on npm now",
			);
			expect(p.ran).toEqual([]);
		});

		it("only a stage id npm could have made", () => {
			const { out } = artifact({ manifest: { stageId: "../../x" } });
			expect(() =>
				parseManifest(readFileSync(join(out, "manifest.json"), "utf8")),
			).toThrow("not a promote manifest");
		});
	});

	it("refuses a manifest whose version is not a release", () => {
		const { out } = artifact({ manifest: { version: "0.1.0-rc.5" } });
		expect(() =>
			parseManifest(readFileSync(join(out, "manifest.json"), "utf8")),
		).toThrow("not a promote manifest");
	});

	it("a version npm has with this tarball isn't published again; finish still starts", async () => {
		const { out, manifest } = artifact();
		const p = publishIo(out, {
			"npm view carbonless-review@0.1.0 dist.integrity": `${manifest.integrity}\n`,
		});
		await publishRelease(p.io, "77");
		expect(p.ran).toEqual([]);
		expect(p.lines.join("\n")).toContain("not published again");
		expect(
			p.calls.some((c) => c.startsWith("gh workflow run release-finish.yml")),
		).toBe(true);
	});

	it("a version npm has with another tarball fails", async () => {
		const { out } = artifact();
		const p = publishIo(out, {
			"npm view carbonless-review@0.1.0 dist.integrity": "sha512-b3RoZXI=\n",
		});
		await expect(publishRelease(p.io, "77")).rejects.toThrow(
			"already on npm with another tarball",
		);
		expect(p.ran).toEqual([]);
	});

	it("does nothing without a yes; a failed npm publish starts nothing and says how to retry", async () => {
		const { out } = artifact();
		const no = publishIo(out, {}, { answer: false });
		await publishRelease(no.io, "77");
		expect(no.ran).toEqual([]);
		expect(no.calls.some((c) => c.startsWith("gh workflow run"))).toBe(false);

		const failing = publishIo(out, {}, { npmCode: 1 });
		await expect(publishRelease(failing.io, "77")).rejects.toThrow(
			"run pnpm release publish 77 again",
		);
		expect(failing.calls.some((c) => c.startsWith("gh workflow run"))).toBe(
			false,
		);
		await expect(publishRelease(failing.io, "77; rm")).rejects.toThrow(
			"not a run id",
		);
	});
});

/**
 * Running dependency code: a package manager installing or running
 * packages, or anything from node_modules. Only `npm install -g npm@X.Y.Z`
 * (npm itself, pinned) is allowed, and `pnpm release promote|publish` as
 * text (the summaries name the owner's commands).
 */
const DEPENDENCY_CODE =
	/\bpnpm\b(?! release (promote|publish)\b)|\b(yarn|npx|tsx|bun|bunx)\b|\bnpm (ci|exec|x|run|run-script|test|start|i|add|install(?! -g npm@\d+\.\d+\.\d+\b))\b|node_modules/;

/** Every `run:` value of a workflow: its line and the lines nested under it. */
function runValues(text: string): string[] {
	const out: string[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*(?:- )?)run: /.exec(lines[i] ?? "");
		if (!m) continue;
		const indent = (m[1] ?? "").length;
		const value = [lines[i] ?? ""];
		while (
			i + 1 < lines.length &&
			((lines[i + 1] ?? "").trim() === "" ||
				(lines[i + 1] ?? "").search(/\S/) > indent)
		) {
			value.push(lines[++i] ?? "");
		}
		out.push(value.join("\n"));
	}
	return out;
}

/** A job's text without its comment lines. */
const code = (job: string) =>
	job
		.split("\n")
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");

/** A workflow file's text. */
const workflow = (file: string) =>
	readFileSync(join(import.meta.dirname, "../.github/workflows", file), "utf8");

/** A workflow's jobs, as [name, text]. */
function jobs(text: string): [string, string][] {
	const body = text.slice(text.indexOf("\njobs:\n") + 7);
	const parts = body.split(/^ {2}([\w-]+):$/m);
	const out: [string, string][] = [];
	for (let i = 1; i < parts.length; i += 2) {
		out.push([parts[i] ?? "", parts[i + 1] ?? ""]);
	}
	return out;
}

/** A job's `if:` expression (folded or on one line), "" without one. */
const ifOf = (job: string) => {
	const m = /^ {4}if: >-\n((?: {6}.*\n?)+)|^ {4}if: (.*)$/m.exec(code(job));
	if (!m) return "";
	return (m[1] ?? m[2] ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");
};

/** An expression's top-level `&&` terms; throws on a top-level `||`. */
function conjuncts(expr: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quoted = false;
	let term = "";
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];
		const two = expr.slice(i, i + 2);
		if (ch === "'") quoted = !quoted;
		else if (!quoted && ch === "(") depth++;
		else if (!quoted && ch === ")") depth--;
		else if (!quoted && depth === 0 && two === "||") {
			throw new Error(`a top-level || in ${expr}`);
		} else if (!quoted && depth === 0 && two === "&&") {
			out.push(term.trim());
			term = "";
			i++;
			continue;
		}
		term += ch;
	}
	out.push(term.trim());
	return out;
}

/** How a workflow_run job checks out the commit CI ran. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions
const HEAD_SHA = "ref: ${{ github.event.workflow_run.head_sha }}";

/** What every run of these jobs must be: each a top-level conjunct. */
const WORKFLOW_RUN_GUARD = [
	"github.event_name == 'workflow_run'",
	"github.event.workflow_run.event == 'push'",
	"github.event.workflow_run.head_repository.full_name == github.repository",
];
const DISPATCH_GUARD = [
	"github.event_name == 'workflow_dispatch'",
	"github.ref == 'refs/heads/master'",
];
const RELEASE_GUARDS: Record<string, string[]> = {
	"rc-build": WORKFLOW_RUN_GUARD,
	"rc-publish": WORKFLOW_RUN_GUARD,
	"promote-check": DISPATCH_GUARD,
	"promote-stage": DISPATCH_GUARD,
	fixup: DISPATCH_GUARD,
};

/**
 * Where a workflow's jobs aren't guarded as `guards` says: every job is
 * listed, its own `if` has each guard as a top-level conjunct (no `||` can
 * undo it), and a workflow_run job checks out the commit CI ran, never a
 * branch name (a fork's PR branch may be called master).
 */
function guardProblems(
	text: string,
	guards: Record<string, string[]>,
): string[] {
	const problems: string[] = [];
	const found = jobs(text);
	expect(found.map(([name]) => name).sort()).toEqual(
		Object.keys(guards).sort(),
	);
	for (const [name, job] of found) {
		let terms: string[];
		try {
			terms = conjuncts(ifOf(job));
		} catch (error) {
			problems.push(`${name}: ${(error as Error).message}`);
			continue;
		}
		for (const g of guards[name] ?? []) {
			if (!terms.includes(g)) {
				const what = /head_repository|github\.ref|event_name|event ==/.exec(
					g,
				)?.[0];
				problems.push(`${name}: no ${what} conjunct (${g})`);
			}
		}
		if (guards[name] === WORKFLOW_RUN_GUARD) {
			const sha = HEAD_SHA;
			const checkouts = code(job).split("actions/checkout@").length - 1;
			const pinned = code(job).split(sha).length - 1;
			if (checkouts !== pinned || /head_branch/.test(code(job))) {
				problems.push(`${name}: checks out something other than ${sha}`);
			}
		}
	}
	return problems;
}

describe("release-finish: each step only once", () => {
	const SHA = "a".repeat(40);
	const manifest = {
		version: "0.1.0",
		tag: "v0.1.0-rc.5",
		sha: SHA,
		sha256: "0".repeat(64),
		integrity: "sha512-cmVsZWFzZQ==",
		next: "minor" as const,
		tarball: "carbonless-review-0.1.0.tgz",
	};
	const finishIo = (
		integrity: string | null,
		tagAt?: string,
		handlers: Parameters<typeof fakeIo>[0] = {},
	) =>
		fakeIo({
			"npm view carbonless-review@0.1.0 dist.integrity":
				integrity === null ? NPM_404 : `${integrity}\n`,
			"git rev-parse -q --verify refs/tags/v0.1.0^{commit}":
				tagAt === undefined ? { code: 1 } : `${tagAt}\n`,
			"git rev-parse -q --verify refs/tags/v0.1.0-rc.5^{commit}": `${SHA}\n`,
			"git merge-base --is-ancestor": "",
			...handlers,
		}).io;

	it("fails unless npm has the release with the promote run's tarball", async () => {
		await expect(
			finishPlan(finishIo(null), "0.1.0", manifest, "0.1.0"),
		).rejects.toThrow(
			"npm doesn't show carbonless-review@0.1.0 yet: start release-finish again",
		);
		await expect(
			finishPlan(finishIo("sha512-b3RoZXI="), "0.1.0", manifest, "0.1.0"),
		).rejects.toThrow("is another tarball");
		await expect(
			finishPlan(finishIo(manifest.integrity), "0.2.0", manifest, "0.1.0"),
		).rejects.toThrow("released 0.1.0, not 0.2.0");
	});

	it("refuses a manifest whose tag isn't at its commit, or whose commit isn't on master", async () => {
		await expect(
			finishPlan(
				finishIo(manifest.integrity, undefined, {
					"git rev-parse -q --verify refs/tags/v0.1.0-rc.5^{commit}": `${"e".repeat(40)}\n`,
				}),
				"0.1.0",
				manifest,
				"0.1.0",
			),
		).rejects.toThrow(/v0\.1\.0-rc\.5 is not at a{40} here \(e{40}\)/);
		await expect(
			finishPlan(
				finishIo(manifest.integrity, undefined, {
					"git merge-base --is-ancestor": { code: 1 },
				}),
				"0.1.0",
				manifest,
				"0.1.0",
			),
		).rejects.toThrow(/a{40} is not on master/);
	});

	it("waits for the registry to show the release before failing", async () => {
		let reads = 0;
		const sleeps: number[] = [];
		const io = finishIo(null, undefined, {
			"npm view carbonless-review@0.1.0 dist.integrity": () =>
				reads++ < 2 ? NPM_404 : `${manifest.integrity}\n`,
		});
		io.sleep = async (ms) => {
			sleeps.push(ms);
		};
		expect(await finishPlan(io, "0.1.0", manifest, "0.1.0")).toEqual({
			pushTag: true,
			nextPr: true,
		});
		expect(sleeps).toEqual([15_000, 15_000]);
	});

	it("pushes the tag once, refuses one elsewhere, and opens the next PR only while master is still on the release", async () => {
		expect(
			await finishPlan(
				finishIo(manifest.integrity),
				"0.1.0",
				manifest,
				"0.1.0",
			),
		).toEqual({ pushTag: true, nextPr: true });
		expect(
			await finishPlan(
				finishIo(manifest.integrity, SHA),
				"0.1.0",
				manifest,
				"0.1.0",
			),
		).toEqual({ pushTag: false, nextPr: true });
		expect(
			await finishPlan(
				finishIo(manifest.integrity, SHA),
				"0.1.0",
				manifest,
				"0.2.0",
			),
		).toEqual({ pushTag: false, nextPr: false });
		await expect(
			finishPlan(
				finishIo(manifest.integrity, "b".repeat(40)),
				"0.1.0",
				manifest,
				"0.1.0",
			),
		).rejects.toThrow(/v0\.1\.0 is at b{40}, not a{40}/);
	});

	it("each workflow step it plans is skipped when the plan says done", () => {
		const wf = workflow("release-finish.yml");
		expect(wf).toContain("if: steps.plan.outputs.push_tag == 'true'");
		expect(wf).toContain("if: steps.plan.outputs.next_pr == 'true'");
		// The run is checked before its artifact is used.
		expect(wf.indexOf('ci:check-run "$RUN"')).toBeGreaterThan(-1);
		expect(wf.indexOf('ci:check-run "$RUN"')).toBeLessThan(
			wf.indexOf("actions/download-artifact"),
		);
		// A rerun never force-pushes over an existing next branch.
		expect(wf).not.toContain("--force");
		expect(wf).toContain('git ls-remote --exit-code --heads origin "$branch"');
		// rc moves through release.yml (the registered trusted publisher).
		expect(wf).toContain(
			'gh workflow run release.yml --repo "$GITHUB_REPOSITORY" --ref master -f mode=fixup -f version="$VERSION"',
		);
		expect(wf).not.toMatch(/npm (publish|dist-tag|stage)/);
		const promote = jobs(workflow("release.yml"))
			.filter(([name]) => name.startsWith("promote-"))
			.map(([, text]) => text)
			.join("\n");
		const release = workflow("release.yml");
		// What the owner approves is named on the run and in its summary.
		expect(release).toContain(
			"inputs.mode == 'promote' && format('Promote {0} (next {1})', inputs.rc || 'the newest RC', inputs.next)",
		);
		expect(promote).toContain(
			'for (const k of ["version", "tag", "sha", "sha256", "integrity", "next", "tarball"])',
		);
		expect(promote).toContain("pnpm release publish $GITHUB_RUN_ID");
		// A release is only staged (latest, fixed at stage time); never published.
		expect(promote).toContain(
			'npm stage publish "$TGZ" --tag latest --access public --json',
		);
		expect(promote).not.toMatch(/npm publish|npm dist-tag/);
	});

	it("the OIDC jobs check the tarball's own package.json, and promote stages once per version", () => {
		const byName = new Map(jobs(workflow("release.yml")));
		const rc = byName.get("rc-publish") ?? "";
		const stage = byName.get("promote-stage") ?? "";
		// The name, the exact version and no publishConfig, before npm sees it.
		for (const [job, before] of [
			[rc, 'npm publish "$TGZ"'],
			[stage, 'npm stage publish "$TGZ"'],
		] as const) {
			const check = job.indexOf("package/package.json");
			expect(check).toBeGreaterThan(-1);
			expect(check).toBeLessThan(job.indexOf(before));
			expect(job).toContain("publishConfig");
		}
		expect(rc).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'p.version === process.argv[1] ? "" : `version ${p.version}`',
		);
		expect(stage).toContain(
			'p.name !== "carbonless-review" || p.version !== m.version || p.publishConfig !== undefined',
		);
		// npm stage list needs the owner's login, not OIDC: CI doesn't try it
		// (pnpm release publish checks for a second staged entry). The stage
		// id is parsed as JSON, not grepped (M3), and shown at once.
		expect(code(stage)).not.toContain("npm stage list");
		expect(stage).toContain('(o["carbonless-review"] ?? o).stageId');
		expect(stage).not.toContain("grep -oE");
		// The two node snippets, run as they are in the workflow.
		const snippet = (after: string) => {
			const start = stage.indexOf(after) + after.length;
			return stage.slice(start, stage.indexOf("'", start));
		};
		const run = (code: string, ...args: string[]) =>
			execFileSync(process.execPath, ["-e", code, ...args], {
				encoding: "utf8",
			}).trim();
		const stageIdOf = snippet(`id="$(node -e '`);
		const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
		expect(
			run(stageIdOf, JSON.stringify({ "carbonless-review": { stageId: id } })),
		).toBe(id);
		expect(
			run(
				stageIdOf,
				JSON.stringify({ "carbonless-review": { stageId: "x; rm" } }),
			),
		).toBe("");
		// npm runs outside the checkout in the OIDC jobs: no project .npmrc.
		for (const [name, job] of byName) {
			if (!/id-token: write/.test(job)) continue;
			for (const step of job.split(/\n(?= {6}- )/)) {
				if (!step.startsWith("      - ")) continue; // the job's header
				const body = code(step);
				if (
					/\bnpm (install|i|publish|view|dist-tag|stage)\b|rc-fixup\.mjs/.test(
						body,
					)
				) {
					expect(step, `${name}`).toContain(
						// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions
						"working-directory: ${{ runner.temp }}\n",
					);
				}
			}
		}
		// Step outputs reach run: through env, never pasted into scripts.
		for (const file of ["release.yml", "release-finish.yml"]) {
			const runs = runValues(workflow(file));
			expect(runs.length, file).toBeGreaterThan(5);
			for (const run of runs) expect(run, file).not.toContain("${{");
		}
	});

	it("every run: script parses: bash -n, and each `node -e '…'` body as JavaScript", () => {
		const files = readdirSync(
			join(import.meta.dirname, "../.github/workflows"),
		).filter((f) => f.endsWith(".yml"));
		for (const file of files) {
			for (const run of runValues(workflow(file))) {
				const [head = "", ...rest] = run.split("\n");
				const inline = head.replace(/^\s*(?:- )?run: /, "");
				const lines = inline === "|" ? rest : [inline];
				const indent = Math.min(
					...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)),
				);
				const script = lines.map((l) => l.slice(indent)).join("\n");
				// A quote inside a single-quoted `node -e` body ends it early.
				expect(
					() => execFileSync("bash", ["-n"], { input: script, stdio: "pipe" }),
					`${file}: ${head.trim()}\n${script}`,
				).not.toThrow();
				for (const [, body] of script.matchAll(/node -e '([^']*)'/g)) {
					expect(
						() => new Script(body ?? ""),
						`${file}: node -e\n${body}`,
					).not.toThrow();
				}
			}
		}
	});

	it("public repository: fork PRs reach no credential, no OIDC, no `npm` environment", () => {
		const files = readdirSync(
			join(import.meta.dirname, "../.github/workflows"),
		).filter((f) => f.endsWith(".yml"));
		expect(files.sort()).toEqual([
			"ci.yml",
			"release-finish.yml",
			"release.yml",
		]);
		/** A workflow's `on:` block. */
		const triggers = (text: string) =>
			code(
				text.slice(
					text.indexOf("\non:\n"),
					text.search(/\n(permissions|concurrency|jobs):/),
				),
			);
		for (const file of files) {
			const text = code(workflow(file));
			// pull_request_target runs with the base's token and secrets on a
			// fork's code; no workflow uses repository secrets at all.
			expect(text, file).not.toContain("pull_request_target");
			expect(text, file).not.toMatch(/\bsecrets\./);
			// npm makes provenance itself (trusted publishing, public repo).
			expect(text, file).not.toContain("--provenance");
		}
		// CI is the only workflow a pull request (a fork's too) runs: read-only,
		// no environment, no OIDC, no write anywhere.
		const ci = code(workflow("ci.yml"));
		expect(triggers(ci)).toMatch(/^ {2}pull_request:$/m);
		expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
		expect(ci).not.toMatch(/: write\b|id-token|environment:/);
		// The release workflows: a completed CI on master, or a dispatch (which
		// needs write access to the repository); never a PR or a push.
		expect(triggers(workflow("release-finish.yml")).trim()).toBe(
			"on:\n  workflow_dispatch:\n    inputs:\n      version:\n        description: The published release (X.Y.Z)\n        required: true\n      run:\n        description: The promote run that built it (its id)\n        required: true",
		);
		const release = workflow("release.yml");
		const on = triggers(release);
		expect(on.match(/^ {2}\w+:$/gm)).toEqual([
			"  workflow_run:",
			"  workflow_dispatch:",
		]);
		expect(on).toContain(
			"workflows: [CI]\n    types: [completed]\n    branches: [master]",
		);
		expect(guardProblems(release, RELEASE_GUARDS)).toEqual([]);
		expect(
			guardProblems(workflow("release-finish.yml"), {
				finish: DISPATCH_GUARD,
			}),
		).toEqual([]);
		// The check catches a guard that is there but doesn't hold, and a
		// checkout of the branch's name instead of the commit CI ran.
		// rc-publish's guard (the concurrency group has the same words).
		const push =
			"      github.event.workflow_run.event == 'push' &&\n      github.event.workflow_run.head_repository";
		expect(release).toContain(push);
		for (const [mutated, problem] of [
			[
				release.replace(push, push.replace("'push' &&", "'push' || true &&")),
				/rc-(build|publish): a top-level \|\|/,
			],
			[
				release.replace(
					"github.event.workflow_run.head_repository.full_name == github.repository &&\n      needs",
					"needs",
				),
				/rc-publish: no head_repository/,
			],
			[
				release.replace(HEAD_SHA, HEAD_SHA.replace("head_sha", "head_branch")),
				/rc-build: checks out/,
			],
			[
				release.replace(
					"inputs.mode == 'fixup' &&\n      github.ref == 'refs/heads/master'",
					"inputs.mode == 'fixup'",
				),
				/fixup: no github.ref/,
			],
		] as const) {
			expect(mutated).not.toBe(release);
			expect(guardProblems(mutated, RELEASE_GUARDS).join("\n")).toMatch(
				problem,
			);
		}
	});

	it("an RC run fails when npm shows no provenance for the RC, after a bounded wait", () => {
		const rc = new Map(jobs(workflow("release.yml"))).get("rc-publish") ?? "";
		const step =
			rc.split(/\n(?= {6}- )/).find((s) => s.includes("dist.attestations")) ??
			"";
		// After the publish (and the tag and rc), only when an RC was published.
		expect(rc.indexOf("dist.attestations")).toBeGreaterThan(
			rc.indexOf('npm publish "$TGZ"'),
		);
		expect(step).toContain("if: env.PUBLISH == 'true' && env.FIRST == 'false'");
		expect(step).toContain("TRIES: 10");
		expect(step).toContain("WAIT: 15");
		// The script itself, as the runner runs it, with a fake npm.
		const script = (runValues(step)[0] ?? "")
			.replace(/^\s*run: \|\n/, "")
			.replace(/^ {10}/gm, "");
		expect(script).toContain("npm view");
		const dir = mkdtempSync(join(tmpdir(), "crb-attest-"));
		try {
			const run = (answers: string[]) => {
				writeFileSync(join(dir, "count"), "0");
				writeFileSync(
					join(dir, "npm"),
					`#!/usr/bin/env bash
n=$(( $(cat "${dir}/count") + 1 )); echo "$n" >"${dir}/count"
echo "$*" >>"${dir}/calls"
case "$(sed -n "\${n}p" "${dir}/answers")" in
  fail) echo "E500" >&2; exit 1 ;;
  empty) ;;
  *) echo '{"url":"https://registry.npmjs.org/-/npm/v1/attestations/x","provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}' ;;
esac
`,
					{ mode: 0o755 },
				);
				writeFileSync(join(dir, "answers"), `${answers.join("\n")}\n`);
				writeFileSync(join(dir, "calls"), "");
				let code = 0;
				try {
					execFileSync(
						"bash",
						["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
						{
							stdio: "pipe",
							env: {
								...process.env,
								PATH: `${dir}:${process.env.PATH}`,
								VERSION: "0.2.0-rc.1",
								TRIES: "3",
								WAIT: "0",
							},
						},
					);
				} catch (error) {
					code = (error as { status?: number }).status ?? -1;
				}
				const calls = readFileSync(join(dir, "calls"), "utf8")
					.split("\n")
					.filter(Boolean);
				return { code, calls };
			};
			const ok = run(["empty", "fail", "attested"]);
			expect(ok.code).toBe(0);
			expect(ok.calls).toEqual(
				Array(3).fill(
					"view carbonless-review@0.2.0-rc.1 dist.attestations --json --prefer-online",
				),
			);
			const none = run(["empty", "empty", "empty", "attested"]);
			expect(none.code).toBe(1);
			expect(none.calls).toHaveLength(3);
			expect(run(["fail", "fail", "fail"]).code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("an expression's top-level conjuncts; a top-level || is refused", () => {
		expect(conjuncts("a == 'x' && (b || c) && d")).toEqual([
			"a == 'x'",
			"(b || c)",
			"d",
		]);
		expect(conjuncts("a && 'p || q'")).toEqual(["a", "'p || q'"]);
		expect(() => conjuncts("a == 'push' || true && b")).toThrow(/\|\|/);
		expect(() => conjuncts("a && b || c")).toThrow(/\|\|/);
	});

	it("no workflow has an npm token; only master's `npm` environment gets OIDC, with no dependency code", () => {
		const files = readdirSync(
			join(import.meta.dirname, "../.github/workflows"),
		).filter((f) => f.endsWith(".yml"));
		const withOidc: string[] = [];
		for (const file of files) {
			const text = workflow(file);
			expect(text, file).not.toMatch(
				/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|registry-url/,
			);
			// Not for the whole workflow: only per job.
			expect(text.slice(0, text.indexOf("\njobs:\n")), file).not.toMatch(
				/^\s+id-token:/m,
			);
			for (const [name, job] of jobs(text)) {
				const npmWrite = /npm (publish|dist-tag|stage publish)/.test(job);
				const oidc = /id-token: write/.test(job);
				if (oidc) withOidc.push(`${file}:${name}`);
				// npm writes only with OIDC, in the environment; OIDC only there.
				if (npmWrite) expect(oidc, `${file}:${name}`).toBe(true);
				if (oidc) {
					expect(job, `${file}:${name}`).toMatch(/^ {4}environment: npm$/m);
					// No dependency code: no package manager runs anything but
					// installing npm itself (pinned), nothing from node_modules.
					expect(code(job), `${file}:${name}`).not.toMatch(DEPENDENCY_CODE);
					// Third-party actions run with the OIDC credential too: pinned.
					for (const uses of job.match(/uses: \S+/g) ?? []) {
						expect(uses, `${file}:${name}`).toMatch(/@[0-9a-f]{40}$/);
					}
				}
			}
		}
		expect(withOidc.sort()).toEqual([
			"release.yml:fixup",
			"release.yml:promote-stage",
			"release.yml:rc-publish",
		]);
		// Every action in the release workflows is pinned to a commit.
		for (const file of ["release.yml", "release-finish.yml"]) {
			for (const uses of workflow(file).match(/uses: \S+/g) ?? []) {
				expect(uses, file).toMatch(/@[0-9a-f]{40}$/);
			}
		}
		// What counts as dependency code.
		for (const bad of [
			"npm ci",
			"npm install",
			"npm i express",
			"npm install -g npm@latest",
			"npx foo",
			"npm exec foo",
			"npm run build",
			"yarn",
			"pnpm -r build",
			"pnpm release local",
			"node node_modules/x/cli.js",
			"tsx a.ts",
			"bun install",
			"bunx foo",
		]) {
			expect(bad).toMatch(DEPENDENCY_CODE);
		}
		for (const fine of [
			"npm install -g npm@12.2.1",
			'npm publish "$TGZ" --tag rc',
			"npm dist-tag add x rc",
			"npm stage publish x",
			"npm view carbonless-review version",
			"node scripts/rc-fixup.mjs",
			"echo `pnpm release publish 77`",
		]) {
			expect(fine).not.toMatch(DEPENDENCY_CODE);
		}
		// What can publish is the owner's to review (with a rule on master).
		const owners = readFileSync(
			join(import.meta.dirname, "../.github/CODEOWNERS"),
			"utf8",
		);
		for (const path of [
			"/.github/",
			"/scripts/release*.ts",
			"/scripts/rc-fixup.mjs",
			"/.npmrc",
			"/.nvmrc",
			"/package.json",
		]) {
			expect(owners).toMatch(
				new RegExp(`^${path.replace(/[.*]/g, "\\$&")} @Gilthans$`, "m"),
			);
		}
		// The fix-up those jobs run has no dependencies.
		const fixup = readFileSync(
			join(import.meta.dirname, "rc-fixup.mjs"),
			"utf8",
		);
		expect(fixup.match(/^import .* from "([^"]+)";$/gm)).toEqual([
			'import { execFileSync } from "node:child_process";',
			'import { fileURLToPath } from "node:url";',
		]);
	});
});
