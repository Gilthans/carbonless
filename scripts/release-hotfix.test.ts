import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_TEST_TIMEOUTS, testGitEnv } from "../test/git-fixture";
import { checkCiPassed } from "./ci-passed.mjs";
import { rcMoveTo } from "./rc-fixup.mjs";
import { releaseGate } from "./release-gate.mjs";
import {
	hotfixStart,
	hotfixStartTag,
	hotfixStatus,
	hotfixVersion,
	missingOnMaster,
	type PortItem,
	portPr,
	promoteHotfix,
	resolveHotfix,
} from "./release-hotfix.js";
import {
	finishPlan,
	type Io,
	type Manifest,
	parseManifest,
	type RunResult,
} from "./release-lib.js";
import {
	coverage,
	decodeNotesInput,
	formatNotesFile,
	hotfixNotes,
	type Linear,
	releaseRange,
} from "./release-notes.js";
import { hotfixAdvice } from "./release-withdraw.js";

type Handler =
	| Partial<RunResult>
	| string
	| ((args: string[]) => Partial<RunResult> | string);

/** A runner answering from handlers keyed by "cmd arg1 arg2…" prefixes; anything else fails. */
function fakeIo(handlers: Record<string, Handler>) {
	const calls: string[] = [];
	const lines: string[] = [];
	const io: Io = {
		repo: "owner/repo",
		log: (line) => lines.push(line),
		now: () => new Date("2026-11-27T10:00:00Z"),
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
			const h = handlers[key] ?? "";
			const out = typeof h === "function" ? h([...args]) : h;
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
const contents = (version: string) =>
	Buffer.from(JSON.stringify({ name: "carbonless-review", version })).toString(
		"base64",
	);
const A = "a".repeat(40);
const B = "b".repeat(40);
const HEAD = "c".repeat(40);

/** Writes to GitHub or git among the calls (reads are api GETs, ls-remote, compare). */
const writes = (calls: string[]) =>
	calls.filter(
		(c) =>
			/^gh api -X (POST|PATCH|PUT|DELETE)/.test(c) ||
			/^gh (workflow|pr|release) /.test(c) ||
			/^git (push|tag)/.test(c),
	);

describe("pnpm release hotfix: where it starts", () => {
	it("the next patch not yet tagged", () => {
		expect(hotfixVersion("v0.4.0", ["v0.4.0"])).toBe("0.4.1");
		expect(hotfixVersion("v0.4.1", ["v0.4.0", "v0.4.1"])).toBe("0.4.2");
		expect(() => hotfixVersion("v0.4.0-rc.3", [])).toThrow(/release tag/);
		expect(() => hotfixVersion("0.4.0", [])).toThrow(/release tag/);
	});

	it("only the newest release by semver; never an RC, another commit or an older line", () => {
		const tags = ["v0.3.0", "v0.3.1", "v0.4.0-rc.9", "v0.4.0", "v0.5.0-rc.2"];
		expect(hotfixStartTag(tags).tag).toBe("v0.4.0");
		expect(hotfixStartTag(tags, "v0.4.0").tag).toBe("v0.4.0");
		expect(() => hotfixStartTag(tags, "v0.4.0-rc.9")).toThrow(
			/not a release tag.*never another commit/,
		);
		expect(() => hotfixStartTag(tags, "master")).toThrow(/not a release tag/);
		expect(() => hotfixStartTag(tags, A)).toThrow(/not a release tag/);
		expect(() => hotfixStartTag(tags, "v0.3.1")).toThrow(
			/older release line: only the newest release \(v0\.4\.0\)/,
		);
		expect(() => hotfixStartTag(tags, "v0.4.7")).toThrow(/not on origin/);
		// A second hotfix of the line starts from the first one's tag.
		const after = [...tags, "v0.4.1"];
		expect(() => hotfixStartTag(after, "v0.4.0")).toThrow(
			/v0\.4\.1 is out: a hotfix of this line starts from it \(pnpm release hotfix v0\.4\.1\)/,
		);
		expect(hotfixStartTag(after).tag).toBe("v0.4.1");
		expect(() => hotfixStartTag(["v0.1.0-rc.1"])).toThrow(
			/nothing is released/,
		);
	});

	const startIo = (
		over: Record<string, Handler> = {},
		tags = ["v0.3.0", "v0.4.0", "v0.5.0-rc.2"],
		distTags: Record<string, string> = { latest: "0.4.0", rc: "0.5.0-rc.2" },
	) =>
		fakeIo({
			"git ls-remote --tags": lsRemote(...tags),
			"npm view": npmView(distTags, ["0.3.0", "0.4.0", "0.5.0-rc.2"]),
			"gh api repos/owner/repo/contents/package.json": `${contents("0.5.0")}\n`,
			"gh api repos/owner/repo/git/ref/tags/v0.4.0": JSON.stringify({
				sha: A,
				type: "commit",
			}),
			"gh api repos/owner/repo/git/ref/tags/v0.4.1": JSON.stringify({
				sha: B,
				type: "commit",
			}),
			"git ls-remote --heads origin": "",
			"gh api -X POST repos/owner/repo/git/refs": "{}",
			...over,
		});

	it("creates hotfix/X.Y.Z+1 at the release tag's commit, and writes nothing else", async () => {
		const { io, calls, lines } = startIo();
		expect(await hotfixStart(io)).toEqual({
			branch: "hotfix/0.4.1",
			version: "0.4.1",
			sha: A,
		});
		expect(writes(calls)).toEqual([
			`gh api -X POST repos/owner/repo/git/refs -f ref=refs/heads/hotfix/0.4.1 -f sha=${A}`,
		]);
		expect(lines.join("\n")).toContain("pnpm release promote --hotfix 0.4.1");
	});

	it("after a withdraw (latest moved back to 0.3.0) it still starts from the withdrawn v0.4.0", async () => {
		const { io, calls } = startIo({}, undefined, {
			latest: "0.3.0",
			rc: "0.3.0",
		});
		expect((await hotfixStart(io)).branch).toBe("hotfix/0.4.1");
		expect(writes(calls)).toHaveLength(1);
		// What withdraw advised: the same release.
		expect(hotfixAdvice(["0.3.0", "0.4.0", "0.5.0-rc.2"], ["0.4.0"])).toBe(
			"Now ship a fix: pnpm release hotfix v0.4.0",
		);
	});

	it("withdraw's advice never names a release hotfix refuses", () => {
		const published = ["0.3.0", "0.4.0", "0.5.0-rc.1"];
		const advice = hotfixAdvice(published, ["0.3.0"]);
		expect(advice).toContain("only the newest release gets a hotfix (v0.4.0");
		expect(advice).not.toContain("hotfix v0.3.0");
		expect(hotfixAdvice(published, ["0.5.0-rc.1"])).toBe(
			"Now ship a fix: its PR to master publishes the next RC.",
		);
		// The newest by semver, whatever order they were named in.
		expect(hotfixAdvice(published, ["0.3.0", "0.4.0"])).toBe(
			"Now ship a fix: pnpm release hotfix v0.4.0",
		);
	});

	it("a second hotfix of the line starts at the first's tag", async () => {
		const { io } = startIo({}, ["v0.4.0", "v0.4.1"]);
		expect(await hotfixStart(io, "v0.4.1")).toEqual({
			branch: "hotfix/0.4.2",
			version: "0.4.2",
			sha: B,
		});
		await expect(
			hotfixStart(startIo({}, ["v0.4.0", "v0.4.1"]).io, "v0.4.0"),
		).rejects.toThrow(/start.* from it/);
	});

	it("an existing branch: at the same commit nothing is done; elsewhere refused", async () => {
		const same = startIo({
			"git ls-remote --heads origin": `${A}\trefs/heads/hotfix/0.4.1\n`,
		});
		expect((await hotfixStart(same.io)).sha).toBe(A);
		expect(writes(same.calls)).toEqual([]);
		const moved = startIo({
			"git ls-remote --heads origin": `${B}\trefs/heads/hotfix/0.4.1\n`,
		});
		await expect(hotfixStart(moved.io)).rejects.toThrow(
			/hotfix\/0\.4\.1 is on origin at b{40}, not v0\.4\.0.*a PR into it/,
		);
		expect(writes(moved.calls)).toEqual([]);
	});

	it("refused when master's next release is that version, or npm has it without a tag", async () => {
		const master = startIo({
			"gh api repos/owner/repo/contents/package.json": `${contents("0.4.1")}\n`,
		});
		await expect(hotfixStart(master.io)).rejects.toThrow(
			/master's next release is 0\.4\.1 too/,
		);
		const npm = startIo({
			"npm view": npmView({ latest: "0.4.0" }, ["0.4.0", "0.4.1"]),
		});
		await expect(hotfixStart(npm.io)).rejects.toThrow(
			/0\.4\.1 is on npm already/,
		);
		expect([...writes(master.calls), ...writes(npm.calls)]).toEqual([]);
	});
});

describe("pnpm release promote --hotfix", () => {
	const ciRun = (over: Record<string, unknown> = {}) => ({
		id: 7,
		path: ".github/workflows/ci.yml",
		event: "workflow_dispatch",
		head_branch: "hotfix/0.4.1",
		head_sha: HEAD,
		head_repository: { full_name: "owner/repo" },
		status: "completed",
		conclusion: "success",
		run_attempt: 1,
		...over,
	});
	const promoteIo = (over: Record<string, Handler> = {}) =>
		fakeIo({
			"git ls-remote --tags": lsRemote("v0.4.0-rc.3", "v0.4.0", "v0.5.0-rc.1"),
			"npm view": npmView({ latest: "0.4.0", rc: "0.5.0-rc.1" }, [
				"0.4.0",
				"0.5.0-rc.1",
			]),
			"gh api repos/owner/repo/git/ref/heads/hotfix/0.4.1": `${HEAD}\n`,
			[`gh api repos/owner/repo/compare/v0.4.0...${HEAD}`]: "ahead\n",
			"gh api repos/owner/repo/actions/workflows/ci.yml/runs": JSON.stringify({
				workflow_runs: [ciRun()],
			}),
			"gh workflow run": "https://github.com/owner/repo/actions/runs/99\n",
			...over,
		});

	it("dispatches master's release.yml with the hotfix branch and the branch's notes", async () => {
		const { io, calls } = promoteIo();
		const asked: string[][] = [];
		const url = await promoteHotfix(io, "0.4.1", async (...a) => {
			asked.push(a);
			return "H4sINOTES";
		});
		expect(url).toBe("https://github.com/owner/repo/actions/runs/99");
		expect(asked).toEqual([["hotfix/0.4.1", HEAD, "0.4.1"]]);
		expect(writes(calls)).toEqual([
			"gh workflow run release.yml --repo owner/repo --ref master -f mode=promote -f hotfix=hotfix/0.4.1 -f notes=H4sINOTES",
		]);
	});

	it("refused until CI passed on the head; with no run there it starts one", async () => {
		const failed = promoteIo({
			"gh api repos/owner/repo/actions/workflows/ci.yml/runs": JSON.stringify({
				workflow_runs: [ciRun({ conclusion: "failure" })],
			}),
		});
		await expect(
			promoteHotfix(failed.io, "0.4.1", async () => ""),
		).rejects.toThrow(/CI did not pass/);
		expect(writes(failed.calls)).toEqual([]);
		// Runs of master or of a PR at that commit don't count.
		const none = promoteIo({
			"gh api repos/owner/repo/actions/workflows/ci.yml/runs": JSON.stringify({
				workflow_runs: [
					ciRun({ event: "push", head_branch: "master" }),
					ciRun({ event: "pull_request", head_branch: "fix" }),
				],
			}),
		});
		await expect(
			promoteHotfix(none.io, "0.4.1", async () => ""),
		).rejects.toThrow(/started one; promote again once it passes/);
		expect(writes(none.calls)).toEqual([
			"gh workflow run ci.yml --repo owner/repo --ref hotfix/0.4.1",
		]);
	});

	it("refused when the head isn't on top of the start tag, nothing is on it, or the notes refuse", async () => {
		for (const [status, error] of [
			["diverged", /not on top of v0\.4\.0 \(diverged\)/],
			["identical", /nothing on top of v0\.4\.0 yet/],
			["behind", /not on top/],
		] as const) {
			const { io, calls } = promoteIo({
				[`gh api repos/owner/repo/compare/v0.4.0...${HEAD}`]: `${status}\n`,
			});
			await expect(promoteHotfix(io, "0.4.1", async () => "")).rejects.toThrow(
				error,
			);
			expect(writes(calls)).toEqual([]);
		}
		const { io, calls } = promoteIo();
		await expect(
			promoteHotfix(io, "0.4.1", async () => {
				throw new Error(
					"hotfix/0.4.1 can't be promoted: 1 without a release note",
				);
			}),
		).rejects.toThrow(/without a release note/);
		expect(writes(calls)).toEqual([]);
	});

	it("only the next patch of the newest release, not yet released", async () => {
		await expect(
			promoteHotfix(promoteIo().io, "0.4.2", async () => ""),
		).rejects.toThrow(
			/not a hotfix of the newest release \(v0\.4\.0\): the next one is 0\.4\.1/,
		);
		await expect(
			promoteHotfix(promoteIo().io, "0.3.1", async () => ""),
		).rejects.toThrow(/not a hotfix of the newest release/);
		const released = promoteIo({
			"git ls-remote --tags": lsRemote("v0.4.0", "v0.4.1"),
		});
		await expect(
			promoteHotfix(released.io, "0.4.1", async () => ""),
		).rejects.toThrow(/already released/);
		await expect(
			promoteHotfix(promoteIo().io, "0.4.1-rc.1", async () => ""),
		).rejects.toThrow(/not a release/);
		await expect(
			promoteHotfix(
				promoteIo({
					"gh api repos/owner/repo/git/ref/heads/hotfix/0.4.1": { code: 1 },
				}).io,
				"0.4.1",
				async () => "",
			),
		).rejects.toThrow(
			/no hotfix\/0\.4\.1 on origin: pnpm release hotfix v0\.4\.0/,
		);
	});

	it("the workflow's plan reads its checkout: the branch's head after the start tag", async () => {
		const { io, calls } = fakeIo({
			"git tag -l": "v0.4.0\nv0.5.0-rc.1\n",
			"npm view": npmView({ latest: "0.4.0" }, ["0.4.0"]),
			"git rev-parse -q --verify refs/remotes/origin/hotfix/0.4.1^{commit}": `${HEAD}\n`,
			"git rev-parse refs/tags/v0.4.0^{commit}": `${A}\n`,
			"git merge-base --is-ancestor refs/tags/v0.4.0": "",
		});
		io.tags = "local";
		expect(await resolveHotfix(io, "0.4.1")).toEqual({
			branch: "hotfix/0.4.1",
			tag: "v0.4.0",
			release: "0.4.1",
			sha: HEAD,
		});
		expect(calls.some((c) => c.startsWith("gh "))).toBe(false);
		const off = fakeIo({
			"git tag -l": "v0.4.0\n",
			"npm view": npmView({ latest: "0.4.0" }, ["0.4.0"]),
			"git rev-parse -q --verify refs/remotes/origin/hotfix/0.4.1^{commit}": `${HEAD}\n`,
			"git rev-parse refs/tags/v0.4.0^{commit}": `${A}\n`,
			"git merge-base --is-ancestor refs/tags/v0.4.0": { code: 1 },
		});
		off.io.tags = "local";
		await expect(resolveHotfix(off.io, "0.4.1")).rejects.toThrow(
			/not on top of v0\.4\.0/,
		);
	});

	it("CI's verdict for a hotfix branch: its push or dispatch at exactly that commit", () => {
		const check = (...runs: Record<string, unknown>[]) =>
			checkCiPassed(
				JSON.stringify({ workflow_runs: runs }),
				HEAD,
				"owner/repo",
				"hotfix/0.4.1",
			);
		expect(check(ciRun())).toMatch(/^CI passed on c{40} \(run 7\)/);
		expect(check(ciRun({ event: "push" }))).toMatch(/^CI passed/);
		expect(() => check(ciRun({ head_branch: "hotfix/0.4.2" }))).toThrow(
			/no run/,
		);
		expect(() => check(ciRun({ event: "pull_request" }))).toThrow(/no run/);
		expect(() =>
			check(ciRun({ head_repository: { full_name: "fork/repo" } })),
		).toThrow(/no run/);
		expect(() =>
			checkCiPassed("{}", HEAD, "owner/repo", "hotfix/0.4.1; rm -rf /"),
		).toThrow(/not master or a hotfix branch/);
		// master's verdict is unchanged: a dispatch there never counts.
		expect(() =>
			checkCiPassed(
				JSON.stringify({
					workflow_runs: [ciRun({ head_branch: "master" })],
				}),
				HEAD,
				"owner/repo",
			),
		).toThrow(/no run for a push to master/);
	});
});

describe("a hotfix's manifest and finish", () => {
	const manifest: Manifest = {
		version: "0.4.1",
		tag: "v0.4.0",
		sha: HEAD,
		hotfix: "hotfix/0.4.1",
		sha256: "0".repeat(64),
		integrity: "sha512-cmVsZWFzZQ==",
		next: "minor",
		tarball: "carbonless-review-0.4.1.tgz",
	};

	it("a hotfix manifest names its branch and the release one patch below", () => {
		expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
		for (const bad of [
			{ hotfix: "hotfix/0.4.2" },
			{ hotfix: "master" },
			{ tag: "v0.3.0" },
			{ tag: "v0.4.0-rc.3" },
			{
				hotfix: "hotfix/0.4.1",
				version: "0.4.0",
				tarball: "carbonless-review-0.4.0.tgz",
			},
		]) {
			expect(() =>
				parseManifest(JSON.stringify({ ...manifest, ...bad })),
			).toThrow(/not a promote manifest/);
		}
		// Without `hotfix`, a release tag is no RC: refused as before.
		const { hotfix: _, ...rc } = manifest;
		expect(() => parseManifest(JSON.stringify(rc))).toThrow(
			/not a promote manifest/,
		);
	});

	const finishIo = (over: Record<string, Handler> = {}) =>
		fakeIo({
			"npm view carbonless-review@0.4.1 dist.integrity": `${manifest.integrity}\n`,
			"git rev-parse -q --verify refs/tags/v0.4.1^{commit}": { code: 1 },
			"git rev-parse -q --verify refs/tags/v0.4.0^{commit}": `${A}\n`,
			"git merge-base --is-ancestor": "",
			...over,
		});

	it("Review Focus 5: rc on 0.5.0-rc.3 stays, latest moves, no next PR, master not frozen", async () => {
		const { io, calls } = finishIo();
		expect(await finishPlan(io, "0.4.1", manifest, "0.5.0")).toEqual({
			pushTag: true,
			nextPr: false,
			hotfix: "hotfix/0.4.1",
		});
		expect(calls).toContain(
			`git merge-base --is-ancestor ${HEAD} refs/remotes/origin/hotfix/0.4.1`,
		);
		expect(calls).toContain(
			`git merge-base --is-ancestor refs/tags/v0.4.0 ${HEAD}`,
		);
		// rc: the fixup's rule (scripts/rc-fixup.mjs) after latest moved to 0.4.1.
		expect(rcMoveTo({ latest: "0.4.1", rc: "0.5.0-rc.3" }, "0.4.1")).toBeNull();
		expect(rcMoveTo({ latest: "0.4.1", rc: "0.4.0" }, "0.4.1")).toBe("0.4.1");
		// The freeze: master's 0.5.0 isn't released by a v0.4.1 tag.
		const gate = releaseGate({
			version: "0.5.0",
			tags: ["v0.4.0", "v0.4.1", "v0.5.0-rc.3"],
			npmVersions: ["0.4.0", "0.4.1", "0.5.0-rc.3"],
			pulls: [],
			repo: "owner/repo",
		});
		expect(gate.ok).toBe(true);
		expect(gate.blocker).toBeNull();
		// Even with master's package.json still at the hotfix's version.
		expect(
			(await finishPlan(finishIo().io, "0.4.1", manifest, "0.4.1")).nextPr,
		).toBe(false);
	});

	it("refuses a hotfix commit off its branch, or not after its start", async () => {
		await expect(
			finishPlan(
				finishIo({
					[`git merge-base --is-ancestor ${HEAD} refs/remotes/origin/hotfix/0.4.1`]:
						{ code: 1 },
				}).io,
				"0.4.1",
				manifest,
				"0.5.0",
			),
		).rejects.toThrow(/c{40} is not on hotfix\/0\.4\.1/);
		await expect(
			finishPlan(
				finishIo({
					"git merge-base --is-ancestor refs/tags/v0.4.0": { code: 1 },
				}).io,
				"0.4.1",
				manifest,
				"0.5.0",
			),
		).rejects.toThrow(/not on top of v0\.4\.0/);
		await expect(
			finishPlan(
				finishIo({
					"git rev-parse -q --verify refs/tags/v0.4.0^{commit}": `${HEAD}\n`,
				}).io,
				"0.4.1",
				manifest,
				"0.5.0",
			),
		).rejects.toThrow(/not on top of v0\.4\.0/);
	});
});

describe("the port PR's text", () => {
	const item = (over: Partial<PortItem>): PortItem => ({
		pr: 301,
		title: "Fix the thing (CAR-300)",
		ticket: "CAR-300",
		sha: A,
		applies: true,
		...over,
	});

	it("names the ported tickets in the title and lists what needs a port by hand", () => {
		const { title, body } = portPr("0.4.1", [
			item({}),
			item({
				pr: 302,
				title: "Other (CAR-310)",
				ticket: "CAR-310",
				applies: false,
			}),
		]);
		expect(title).toBe("Hotfix 0.4.1 to master (CAR-300)");
		expect(body).toContain("- Fix the thing (CAR-300) (#301)");
		expect(body).toMatch(/Not ported.*\n- Other \(CAR-310\) \(#302\)/);
		expect(body).toContain(
			"Release note: none (ported from hotfix 0.4.1, whose notes shipped there)",
		);
		expect(portPr("0.4.1", []).body).toContain("on master already");
	});

	it("a PR title from git can't add HTML or notify anyone", () => {
		const { body } = portPr("0.4.1", [
			item({ title: "<img src=x onerror=alert(1)> for @someone </details>" }),
		]);
		expect(body).not.toContain("<img");
		expect(body).not.toContain("</details>");
		expect(body).not.toMatch(/@someone/);
		expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});
});

describe("against a repository", {
	timeout: GIT_TEST_TIMEOUTS.testTimeout,
}, () => {
	let root: string;
	let repo: string;
	const env = testGitEnv();
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
	const commit = (subject: string, files: Record<string, string> = {}) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(repo, path)), { recursive: true });
			writeFileSync(join(repo, path), text);
			git("add", path);
		}
		git("commit", "--allow-empty", "-q", "-m", subject);
		return git("rev-parse", "HEAD");
	};
	const repoIo = (cwd = () => repo) => {
		const lines: string[] = [];
		const io: Io = {
			repo: "owner/repo",
			tags: "local",
			log: (line) => lines.push(line),
			now: () => new Date("2026-11-27T10:00:00Z"),
			sleep: async () => {},
			run: (cmd, args, opts) =>
				// A PR's description (no note there): the only gh read.
				cmd === "gh" && /^repos\/owner\/repo\/pulls\/\d+$/.test(args[1] ?? "")
					? Promise.resolve({ code: 0, stdout: "\n", stderr: "" })
					: cmd !== "git"
						? Promise.resolve({ code: 127, stdout: "", stderr: `no ${cmd}` })
						: new Promise((resolve) => {
								const child = spawn(cmd, args, {
									cwd: opts?.cwd ?? cwd(),
									env,
								});
								let stdout = "";
								let stderr = "";
								child.stdout.on("data", (d) => {
									stdout += d;
								});
								child.stderr.on("data", (d) => {
									stderr += d;
								});
								child.on("close", (code) =>
									resolve({ code: code ?? 1, stdout, stderr }),
								);
							}),
		};
		return { io, lines };
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "crb-hotfix-"));
		repo = join(root, "repo");
		mkdirSync(repo);
		git("init", "-q", "-b", "master");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		commit("start", {
			"src/a.ts": "one\ntwo\nthree\n",
			"src/b.ts": "alpha\n",
			"src/c.ts": "x\n",
		});
		commit("Feature (CAR-10) (#10)");
		git("tag", "v0.4.0");
		// master moves on.
		commit("Next feature (CAR-20) (#20)", { "src/c.ts": "x\ny\n" });
		commit("Rewrite b (CAR-21) (#21)", { "src/b.ts": "beta\n" });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** hotfix/0.4.1 from v0.4.0 with `fixes` (squash commits), tagged v0.4.1; back on master. */
	const hotfix = (...fixes: [string, Record<string, string>][]) => {
		git("switch", "-q", "-c", "hotfix/0.4.1", "v0.4.0");
		const shas = fixes.map(([s, f]) => commit(s, f));
		git("tag", "v0.4.1");
		git("switch", "-q", "master");
		return shas;
	};

	it("the notes range of a hotfix is its branch's PRs; the next release's is master's since v0.4.0", async () => {
		hotfix(["Fix a (CAR-30) (#30)", { "src/a.ts": "one\nTWO\nthree\n" }]);
		const { io } = repoIo();
		const fix = await releaseRange(io, "0.4.1", "refs/tags/v0.4.1");
		expect(fix.from).toBe("v0.4.0");
		expect(fix.prs.map((p) => p.number)).toEqual([30]);
		// 0.5.0 after the hotfix: from v0.4.1 (off master), so master's own PRs.
		commit("Hotfix 0.4.1 to master (CAR-30) (#40)");
		const next = await releaseRange(io, "0.5.0", "HEAD");
		expect(next.from).toBe("v0.4.1");
		expect(next.prs.map((p) => p.number)).toEqual([20, 21, 40]);
		// The port PR's ticket shipped in 0.4.1: covered, needs no new note.
		const files = new Map([
			[
				"0.4.1",
				JSON.parse(
					formatNotesFile({
						version: "0.4.1",
						date: "2026-11-27",
						notes: [
							{ id: "CAR-30", kind: "fixed", prs: [30], text: "Fixed a." },
						],
						none: [],
					}),
				),
			],
		]);
		const { missing } = coverage(next, null, files, "0.5.0");
		expect(missing.map((m) => m.id)).toEqual(["CAR-20", "CAR-21"]);
	});

	it("promote --hotfix collects notes for exactly the branch's PRs, refusing one without", async () => {
		hotfix(
			["Fix a (CAR-30) (#30)", { "src/a.ts": "one\nTWO\nthree\n" }],
			["Fix c (CAR-31) (#31)", { "src/c.ts": "fixed\n" }],
		);
		const head = git("rev-parse", "hotfix/0.4.1");
		const clone = join(root, "clone");
		execFileSync("git", ["clone", "-q", repo, clone], { env });
		const notes: Record<string, string> = { "CAR-30": "fixed: Fixed a." };
		const linear: Linear = {
			query: async <T>(_q: string, variables?: Record<string, unknown>) => {
				const id = String(variables?.id);
				return {
					issue: {
						id: `uuid-${id}`,
						identifier: id,
						title: id,
						state: { name: "Done", type: "completed" },
						labels: { nodes: [{ name: "Bug" }] },
						comments: {
							nodes: notes[id]
								? [
										{
											body: `Release note (${notes[id]?.replace(/: .*/, "")}): ${notes[id]?.replace(/^\w+: /, "")}`,
											updatedAt: "2026-11-27T00:00:00Z",
										},
									]
								: [],
						},
						attachments: { nodes: [] },
					},
				} as T;
			},
		};
		const found = { linear, tried: [] };
		const { io } = repoIo(() => clone);
		await expect(
			hotfixNotes(io, "0.4.1", "hotfix/0.4.1", head, found),
		).rejects.toThrow(/CAR-31 \(#31\)/);
		notes["CAR-31"] = "fixed: Fixed c.";
		const encoded = await hotfixNotes(io, "0.4.1", "hotfix/0.4.1", head, found);
		const file = decodeNotesInput(encoded, "0.4.1");
		// The branch's PRs only: none of master's (#20, #21).
		expect(file.notes.map((n) => [n.id, n.prs])).toEqual([
			["CAR-30", [30]],
			["CAR-31", [31]],
		]);
		// The branch moved on since promote read it: refused.
		await expect(
			hotfixNotes(io, "0.4.1", "hotfix/0.4.1", A, found),
		).rejects.toThrow(/moved on/);
	});

	it("finds what master lacks: by ticket, by patch, and whether it applies", async () => {
		// On master by ticket (the fix PR to master first, another patch);
		// by patch-id (same change, another title); missing and clean;
		// missing and conflicting (master rewrote b).
		commit("Fix c on master (CAR-31) (#41)", { "src/c.ts": "x\ny\nz\n" });
		const samePatch = { "src/a.ts": "one\ntwo\nTHREE\n" };
		commit("Unrelated title (#42)", samePatch);
		const [byTicket, byPatch, clean, conflict] = hotfix(
			["Fix c (CAR-31) (#31)", { "src/c.ts": "x\nfixed\n" }],
			["Fix three (#32)", samePatch],
			["Fix one (CAR-33) (#33)", { "src/a.ts": "ONE\ntwo\nthree\n" }],
			["Fix b (CAR-34) (#34)", { "src/b.ts": "alpha!\n" }],
		);
		expect([byTicket, byPatch].every(Boolean)).toBe(true);
		const { io } = repoIo();
		const missing = await missingOnMaster(io, "v0.4.1");
		expect(missing).toEqual([
			{
				pr: 33,
				title: "Fix one (CAR-33)",
				ticket: "CAR-33",
				sha: clean,
				applies: true,
			},
			{
				pr: 34,
				title: "Fix b (CAR-34)",
				ticket: "CAR-34",
				sha: conflict,
				applies: false,
			},
		]);
		// Nothing left behind: no worktree, master untouched.
		expect(git("worktree", "list").split("\n")).toHaveLength(1);
		expect(git("status", "--porcelain")).toBe("");
		expect(git("log", "-1", "--format=%s")).toBe("Unrelated title (#42)");
	});

	it("keeps the port branch with the picks that applied, each with its source", async () => {
		const [fix] = hotfix(
			["Fix one (CAR-33) (#33)", { "src/a.ts": "ONE\ntwo\nthree\n" }],
			["Fix b (CAR-34) (#34)", { "src/b.ts": "alpha!\n" }],
		);
		const tree = join(root, "port");
		const { io } = repoIo();
		const items = await missingOnMaster(io, "v0.4.1", {
			worktree: tree,
			keep: "hotfix-port/0.4.1",
		});
		expect(items.map((i) => [i.pr, i.applies])).toEqual([
			[33, true],
			[34, false],
		]);
		const log = execFileSync(
			"git",
			["log", "--format=%s%n%b", "master..hotfix-port/0.4.1"],
			{ cwd: repo, encoding: "utf8", env },
		);
		expect(log).toContain("Fix one (CAR-33) (#33)");
		expect(log).toContain(`(cherry picked from commit ${fix})`);
		expect(log).not.toContain("Fix b");
		expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe(
			"ONE\ntwo\nthree\n",
		);
		expect(existsSync(join(tree, ".git"))).toBe(true);
	});

	it("nothing missing once the port PR merged", async () => {
		hotfix(["Fix one (CAR-33) (#33)", { "src/a.ts": "ONE\ntwo\nthree\n" }]);
		commit("Hotfix 0.4.1 to master (CAR-33) (#50)", {
			"src/a.ts": "ONE\ntwo\nthree\n",
		});
		const { io } = repoIo();
		expect(await missingOnMaster(io, "v0.4.1")).toEqual([]);
	});

	it("pnpm release status lists a hotfix whose fix master lacks", async () => {
		hotfix(["Fix one (CAR-33) (#33)", { "src/a.ts": "ONE\ntwo\nthree\n" }]);
		// People run it in a clone: tags and master from origin.
		const clone = join(root, "clone");
		execFileSync("git", ["clone", "-q", repo, clone], { env });
		const { io, lines } = repoIo(() => clone);
		io.tags = "origin";
		await hotfixStatus(io);
		expect(lines).toEqual([
			"hotfix:  v0.4.1: master lacks #33 (CAR-33): merge its port PR (hotfix-port/0.4.1), or port by hand",
		]);
		commit("Hotfix 0.4.1 to master (CAR-33) (#50)", {
			"src/a.ts": "ONE\ntwo\nthree\n",
		});
		const after = repoIo(() => clone);
		after.io.tags = "origin";
		await hotfixStatus(after.io);
		expect(after.lines).toEqual(["hotfix:  v0.4.1: on master"]);
	});
});

describe("the workflows", () => {
	const wf = (file: string) =>
		readFileSync(
			join(import.meta.dirname, "../.github/workflows", file),
			"utf8",
		);
	/** Lines of `run:` blocks (shell), comments dropped. */
	const shell = (text: string) => {
		const out: string[] = [];
		let indent = -1;
		for (const line of text.split("\n")) {
			const m = /^(\s*)(?:- )?run: (.*)$/.exec(line);
			if (m) {
				indent = (m[1] ?? "").length;
				out.push(m[2] ?? "");
				continue;
			}
			if (indent >= 0) {
				const lead = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
				if (line.trim() !== "" && lead <= indent) indent = -1;
				else out.push(line);
			}
		}
		return out.filter((l) => !l.trim().startsWith("#")).join("\n");
	};

	it("the hotfix input reaches a shell only through env, validated first", () => {
		const text = wf("release.yml");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expressions
		expect(text).toContain("HOTFIX_INPUT: ${{ inputs.hotfix }}");
		expect(shell(text)).not.toMatch(/\$\{\{[^}]*inputs\./);
		expect(shell(wf("release-finish.yml"))).not.toMatch(/\$\{\{/);
		const validate = text.indexOf(
			'[[ "$HOTFIX_INPUT" =~ ^hotfix/[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
		);
		expect(validate).toBeGreaterThan(-1);
		expect(validate).toBeLessThan(
			text.indexOf("refs/remotes/origin/$HOTFIX_INPUT"),
		);
	});

	it("an RC is made from master's CI only, never a hotfix branch's", () => {
		const text = wf("release.yml");
		expect(text).toMatch(
			/ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[master\]\n/,
		);
		// rc-build publishes only master's tip.
		expect(text).toContain("git ls-remote origin refs/heads/master");
		// CI runs on a hotfix branch's pushes (for promote's check).
		expect(wf("ci.yml")).toContain('branches: [master, "hotfix/**"]');
	});

	it("release-finish: the port PR only for a hotfix, its title and body from files", () => {
		const text = wf("release-finish.yml");
		expect(text).toContain("if: steps.plan.outputs.hotfix != ''");
		expect(text).toContain(
			'gh pr create --base master --head "$branch" --title "$(cat "$out/title")" --body-file "$out/body.md"',
		);
		// ci:port runs without the token.
		expect(text).toMatch(
			/crb_release\(\) \{ env -u GH_TOKEN[^\n]*\}\n[\s\S]*crb_release ci:port/,
		);
	});
});
