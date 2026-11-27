import { describe, expect, it } from "vitest";
import {
	AGENT_ACK,
	agentArgs,
	agentChangeProblems,
	agentEnabledFrom,
	breakingBumps,
	bumpFromTitle,
	classifyJob,
	codeBlock,
	decide,
	dependabotNames,
	hasReleaseNote,
	manifestProblems,
	metadataMajor,
	missingScans,
	otherNoteLines,
	parseResult,
	releaseNote,
	SCAN_REBASE_WAIT_MS,
	SCAN_WAITING,
	sandboxArgs,
	scrub,
} from "./dependabot-sweep.mjs";
import { prBodyNote } from "./release-notes";

const SHA = "a".repeat(40);
const BOT_COMMIT = {
	sha: SHA,
	author: "dependabot[bot]",
	committer: "web-flow",
	verified: true,
};
const pass = (name: string) => ({
	name,
	bucket: "pass",
	link: `https://github.com/o/r/actions/runs/1/job/${name.length}`,
});
const REQUIRED = ["checks", "windows-agent", "release-note", "release-gate"];

/** A green, mergeable Dependabot PR; override what a case is about. */
function facts(over: Record<string, unknown> = {}, pr = {}) {
	return {
		pr: {
			number: 201,
			title: "Bump dompurify from 3.4.16 to 3.4.17",
			author: "app/dependabot",
			state: "OPEN",
			isDraft: false,
			headRefName: "dependabot/npm_and_yarn/dompurify-3.4.17",
			headRefOid: SHA,
			mergeStateStatus: "BLOCKED",
			mergeable: "MERGEABLE",
			body: "Bumps dompurify.\n\nRelease note: none (dependency update)\n",
			files: ["package.json", "pnpm-lock.yaml"],
			...pr,
		},
		commits: [BOT_COMMIT],
		sweepShas: [],
		manifestProblems: [],
		breaking: [],
		agentEnabled: false,
		checks: REQUIRED.map(pass),
		required: REQUIRED,
		runs: {},
		rebaseAsked: false,
		agentTried: false,
		note: "Release note: none (dependency update)",
		...over,
	};
}

function failedRun(step: string, attempt = 1, headSha = SHA) {
	return {
		checks: [
			...REQUIRED.filter((n) => n !== "checks").map(pass),
			{
				name: "checks",
				bucket: "fail",
				link: "https://github.com/o/r/actions/runs/77/job/88",
			},
		],
		runs: {
			"77": {
				attempt,
				headSha,
				headBranch: "dependabot/npm_and_yarn/dompurify-3.4.17",
				jobs: [
					{
						id: 88,
						name: "checks",
						steps: [
							{
								name: "Run pnpm install --frozen-lockfile",
								conclusion: "success",
							},
							{ name: step, conclusion: "failure" },
						],
					},
				],
			},
		},
	};
}

describe("decide", () => {
	it("merges a green Dependabot PR at its head commit", () => {
		expect(decide(facts())).toMatchObject({ type: "merge", sha: SHA });
	});

	it("skips PRs that aren't Dependabot's", () => {
		expect(decide(facts({}, { author: "someone" })).type).toBe("skip");
		expect(decide(facts({}, { isDraft: true })).type).toBe("skip");
	});

	it("leaves a PR with a commit by anyone else to the owner", () => {
		for (const commit of [
			{ ...BOT_COMMIT, author: "someone" },
			{ ...BOT_COMMIT, verified: false },
			{ ...BOT_COMMIT, committer: "someone" },
		]) {
			expect(
				decide(
					facts({ commits: [BOT_COMMIT, { ...commit, sha: "b".repeat(40) }] }),
				),
			).toMatchObject({ type: "owner", key: `commits:${SHA}` });
		}
		expect(decide(facts({ commits: [] })).type).toBe("owner");
	});

	it("never merges a PR carrying the sweep's own fix: the owner reviews it", () => {
		const mine = {
			sha: "c".repeat(40),
			author: "owner",
			committer: "owner",
			verified: false,
		};
		const d = decide(
			facts({ commits: [BOT_COMMIT, mine], sweepShas: [mine.sha] }),
		);
		expect(d).toMatchObject({ type: "owner", key: `sweep-fix:${SHA}` });
		expect(d.reason).toContain("ccccccc");
	});

	it("never merges workflow or release-script changes", () => {
		for (const f of [
			".github/workflows/ci.yml",
			"scripts/release.ts",
			"scripts/release-gate.mjs",
		]) {
			expect(decide(facts({}, { files: ["package.json", f] }))).toMatchObject({
				type: "owner",
				key: `protected:${SHA}`,
			});
		}
	});

	it("never merges a breaking bump of any dependency", () => {
		const b = [{ name: "vitest", from: "^5.0.0", to: "^6.0.0", kind: "major" }];
		expect(decide(facts({ breaking: b }))).toMatchObject({
			type: "owner",
			key: `major:${SHA}`,
		});
	});

	it("never merges what isn't a plain manifest update", () => {
		expect(
			decide(facts({ manifestProblems: ["it changes more than x"] })),
		).toMatchObject({ type: "owner", key: `manifest:${SHA}` });
	});

	it("asks Dependabot to rebase once per head commit", () => {
		expect(decide(facts({}, { mergeStateStatus: "BEHIND" })).type).toBe(
			"rebase",
		);
		expect(
			decide(facts({}, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }))
				.type,
		).toBe("rebase");
		expect(
			decide(facts({ rebaseAsked: true }, { mergeStateStatus: "BEHIND" })).type,
		).toBe("wait");
	});

	it("leaves a behind PR with sweep commits to the owner (Dependabot won't rebase it)", () => {
		const mine = {
			sha: "c".repeat(40),
			author: "o",
			committer: "o",
			verified: false,
		};
		expect(
			decide(
				facts(
					{ commits: [BOT_COMMIT, mine], sweepShas: [mine.sha] },
					{ mergeStateStatus: "BEHIND" },
				),
			).type,
		).toBe("owner");
	});

	it("adds the release note before anything else", () => {
		expect(decide(facts({}, { body: "Bumps dompurify." }))).toMatchObject({
			type: "add-note",
			note: "Release note: none (dependency update)",
		});
	});

	it("waits for running or missing checks", () => {
		expect(decide(facts({ checks: [] })).type).toBe("wait");
		expect(
			decide(
				facts({
					checks: [
						...REQUIRED.map(pass),
						{ name: "e2e (1/4)", bucket: "pending" },
					],
				}),
			).type,
		).toBe("wait");
		expect(decide(facts({ checks: REQUIRED.slice(1).map(pass) })).type).toBe(
			"wait",
		);
	});

	it("doesn't merge while any check, required or not, failed", () => {
		const d = decide(
			facts({
				checks: [
					...REQUIRED.map(pass),
					{ name: "lint-extra", bucket: "fail", link: "" },
				],
			}),
		);
		expect(d.type).toBe("owner");
	});

	it("reruns a test step's failure once, then hands it to the agent", () => {
		expect(decide(facts(failedRun("Run pnpm test")))).toMatchObject({
			type: "rerun",
			runIds: ["77"],
		});
		expect(
			decide(facts({ ...failedRun("Run pnpm test", 2), agentEnabled: true })),
		).toMatchObject({
			type: "agent",
			failure: { runId: "77", jobId: "88" },
		});
	});

	it("hands a build, lint or typecheck failure to the agent at once", () => {
		for (const s of [
			"Run pnpm lint",
			"Run pnpm typecheck",
			"Run pnpm install --frozen-lockfile",
		]) {
			expect(decide(facts({ ...failedRun(s), agentEnabled: true })).type).toBe(
				"agent",
			);
		}
	});

	it("asks the owner instead of the agent while the agent is off (the default)", () => {
		for (const f of [failedRun("Run pnpm lint"), failedRun("Run pnpm test", 2)])
			expect(decide(facts(f))).toMatchObject({
				type: "owner",
				key: `ci:${SHA}`,
			});
	});

	it("tries the agent once per head commit", () => {
		expect(
			decide(
				facts({
					...failedRun("Run pnpm lint"),
					agentTried: true,
					agentEnabled: true,
				}),
			),
		).toMatchObject({
			type: "owner",
			key: `agent:${SHA}`,
		});
	});

	it("ignores a run that isn't for this head", () => {
		expect(
			decide(facts(failedRun("Run pnpm lint", 1, "d".repeat(40)))).type,
		).toBe("wait");
	});

	it("waits on a freeze and refreshes a stale release-note check", () => {
		const fail = (n: string) => ({ name: n, bucket: "fail", link: "" });
		expect(
			decide(
				facts({
					checks: [...REQUIRED.slice(0, 3).map(pass), fail("release-gate")],
				}),
			).type,
		).toBe("owner");
		expect(
			decide(
				facts({
					checks: [
						pass("checks"),
						pass("windows-agent"),
						pass("release-gate"),
						fail("release-note"),
					],
				}),
			).type,
		).toBe("refresh-note");
	});
});

describe("missing code scanning results (CAR-311)", () => {
	const NOW = Date.parse("2026-11-27T06:00:00Z");
	const ago = (ms: number) => new Date(NOW - ms).toISOString();
	const noScan = (over: Record<string, unknown> = {}, pr = {}) =>
		facts(
			{ scanTools: ["CodeQL"], scansMissing: ["CodeQL"], now: NOW, ...over },
			pr,
		);

	it("finds a required tool with no completed check run on the head", () => {
		const done = {
			name: "CodeQL",
			app: "github-advanced-security",
			status: "completed",
		};
		expect(missingScans(["CodeQL"], [])).toEqual(["CodeQL"]);
		expect(missingScans(["CodeQL"], [done])).toEqual([]);
		expect(
			missingScans(["CodeQL"], [{ ...done, status: "in_progress" }]),
		).toEqual(["CodeQL"]);
		// A workflow job can't stand in for the code scanning app's run.
		expect(
			missingScans(["CodeQL"], [{ ...done, app: "github-actions" }]),
		).toEqual(["CodeQL"]);
		expect(missingScans([], [])).toEqual([]);
	});

	it("asks Dependabot to rebase instead of merging, once per PR", () => {
		const first = decide(noScan());
		expect(first).toMatchObject({ type: "rebase", scan: true });
		expect(first.reason).toContain("CodeQL");
		// Asked at this head, Dependabot hasn't rebased yet: wait a while.
		expect(
			decide(noScan({ scanRebase: { sha: SHA, at: ago(60_000) } })).type,
		).toBe("wait");
	});

	it("leaves it to the owner when results are still missing after the rebase", () => {
		const d = decide(
			noScan({ scanRebase: { sha: "b".repeat(40), at: ago(60_000) } }),
		);
		expect(d).toMatchObject({ type: "owner", key: `scan:${SHA}` });
		expect(d.comment).toMatch(/after a rebase/);
	});

	it("leaves it to the owner when Dependabot never rebased", () => {
		const d = decide(
			noScan({ scanRebase: { sha: SHA, at: ago(SCAN_REBASE_WAIT_MS + 1) } }),
		);
		expect(d).toMatchObject({ type: "owner", key: `scan-norebase:${SHA}` });
	});

	it("merges once the results are there, and never before checks finish", () => {
		expect(decide(noScan({ scansMissing: [] })).type).toBe("merge");
		expect(
			decide(
				noScan({
					scanRebase: { sha: "b".repeat(40), at: ago(60_000) },
					scansMissing: [],
				}),
			).type,
		).toBe("merge");
		const running = noScan({
			checks: [...REQUIRED.map(pass), { name: "analyze", bucket: "pending" }],
		});
		expect(decide(running).type).toBe("wait");
	});

	it("knows the ruleset's refusal, the fallback when the check runs misled it", () => {
		expect(
			SCAN_WAITING.test(
				"gh pr merge 201 --merge --admin exited 1: GraphQL: Repository rule violations found |  | Code scanning is waiting for results from CodeQL for the commits 2d16cc3 or 7d79f0b. |  |  (mergePullRequest)",
			),
		).toBe(true);
		expect(SCAN_WAITING.test("Required status check is expected")).toBe(false);
	});

	it("posts fixed text only", () => {
		const evil = "@evil <img src=x> https://evil.example `x` #9";
		for (const scanRebase of [
			{ sha: "b".repeat(40), at: ago(1) },
			{ sha: SHA, at: ago(SCAN_REBASE_WAIT_MS + 1) },
		]) {
			const d = decide(
				noScan(
					{ scanRebase },
					{
						title: evil,
						body: `${evil}\n\nRelease note: none (dependency update)`,
					},
				),
			);
			expect(d.type).toBe("owner");
			expect(d.comment).not.toMatch(/evil|@|<|`|http/);
			expect(d.key).toMatch(/^[a-z-]+:[0-9a-f]{40}$/);
		}
	});
});

describe("classifyJob", () => {
	const job = (name: string) => ({ steps: [{ name, conclusion: "failure" }] });
	it("tells tests from builds and runners", () => {
		expect(classifyJob(job("Run pnpm test"))).toBe("test");
		expect(classifyJob(job("Run pnpm exec vitest run x.test.ts"))).toBe("test");
		expect(classifyJob(job("A shard failed"))).toBe("test");
		expect(classifyJob(job("Pack smoke test, on a packed tarball"))).toBe(
			"build",
		);
		expect(classifyJob(job("Run pnpm lint"))).toBe("build");
		expect(classifyJob({ steps: [] })).toBe("infra");
	});
});

describe("breakingBumps", () => {
	it("flags breaking and new dependencies, dev ones too", () => {
		const base = {
			dependencies: { a: "^1.2.0", b: "^0.3.1", c: "^2.0.0" },
			devDependencies: { v: "^1.0.0" },
		};
		const head = {
			dependencies: { a: "^2.0.0", b: "^0.4.0", c: "^2.1.0", d: "^1.0.0" },
			devDependencies: { v: "^9.0.0" },
		};
		expect(
			breakingBumps(base, head).map((x: { name: string }) => x.name),
		).toEqual(["a", "b", "d", "v"]);
	});
	it("reads Dependabot's semver-major metadata", () => {
		expect(
			metadataMajor([
				"Bump x\n---\nupdated-dependencies:\n- dependency-name: x\n  update-type: version-update:semver-major\n",
			]),
		).toBe(true);
		expect(metadataMajor(["update-type: version-update:semver-patch"])).toBe(
			false,
		);
	});
});

describe("manifestProblems", () => {
	const base = {
		name: "carbonless-review",
		scripts: { test: "vitest" },
		dependencies: { fastify: "^5.1.0" },
		devDependencies: { dompurify: "^3.4.16" },
	};
	const head = {
		...base,
		devDependencies: { dompurify: "^3.4.17" },
	};
	const ok = {
		files: ["package.json", "pnpm-lock.yaml"],
		basePkg: base,
		headPkg: head,
		names: ["dompurify"],
		addedLockLines: [
			"  dompurify@3.4.17:",
			"    resolution: {integrity: sha512-abc==}",
		],
	};
	it("accepts a version bump of the named package", () => {
		expect(manifestProblems(ok)).toEqual([]);
		expect(
			manifestProblems({
				...ok,
				files: ["pnpm-lock.yaml"],
				names: ["glob"],
				addedLockLines: [
					"    resolution: {tarball: https://registry.npmjs.org/glob/-/glob-14.0.2.tgz}",
				],
			}),
		).toEqual([]);
	});
	it("refuses other files", () => {
		expect(
			manifestProblems({ ...ok, files: [...ok.files, "src/server/x.ts"] }),
		).toHaveLength(1);
		expect(
			manifestProblems({ ...ok, files: [...ok.files, ".npmrc"] }),
		).toHaveLength(1);
	});
	it("refuses package.json changes beyond the named versions", () => {
		for (const h of [
			{ ...head, scripts: { test: "vitest", postinstall: "curl x | sh" } },
			{ ...head, dependencies: { fastify: "^5.2.0" } },
			{ ...head, devDependencies: { dompurify: "^3.4.17", evil: "1.0.0" } },
		])
			expect(manifestProblems({ ...ok, headPkg: h })).toHaveLength(1);
		expect(manifestProblems({ ...ok, names: [] })).toHaveLength(2);
		expect(manifestProblems({ ...ok, headPkg: null })).toHaveLength(1);
	});
	it("refuses lockfile sources other than the npm registry", () => {
		for (const line of [
			"    resolution: {tarball: https://evil.example/x.tgz}",
			"    resolution: {tarball: http://registry.npmjs.org/x.tgz}",
			"    resolution: {type: git, repo: https://github.com/a/b, commit: abc}",
			"    version: link:../x",
			"    version: file:x.tgz",
			"  x@git+https://github.com/a/b.git:",
		])
			expect(manifestProblems({ ...ok, addedLockLines: [line] })).toHaveLength(
				1,
			);
	});
});

describe("dependabotNames", () => {
	it("takes the title's package and the commits' metadata", () => {
		expect(
			dependabotNames("Bump the dev group with 2 updates", [
				'---\nupdated-dependencies:\n- dependency-name: vitest\n- dependency-name: "@types/node"\n',
			]),
		).toEqual(["vitest", "@types/node"]);
		expect(dependabotNames("Bump dompurify from 3.4.16 to 3.4.17")).toEqual([
			"dompurify",
		]);
	});
});

describe("hasReleaseNote", () => {
	const note = "Release note: none (dependency update)";
	it("finds only a line the sweep writes", () => {
		expect(hasReleaseNote(`Bumps x.\n\n${note}\n`, note)).toBe(true);
		expect(hasReleaseNote(`Bumps x.\n\n  ${note}  \n`, note)).toBe(true);
		expect(hasReleaseNote("Bumps x.\n\nRelease note (fixed): Y\n", note)).toBe(
			false,
		);
		expect(hasReleaseNote(`Bumps x. ${note}\n`, note)).toBe(false);
	});
	it("doesn't take other Release note lines for the sweep's", () => {
		expect(
			hasReleaseNote(
				"Bumps x.\n<details>\n<summary>Release notes</summary>\nRelease note: none (upstream)\n</details>\n",
				note,
			),
		).toBe(false);
		expect(
			hasReleaseNote("Bumps x.\n> Release note (new): from upstream\n", note),
		).toBe(false);
		expect(hasReleaseNote("Release notes\nRelease notesy", note)).toBe(false);
	});
});

describe("release notes", () => {
	const alerts = [
		{ package: "dompurify", ghsa: "GHSA-c6gr-qvv4-5v3f", patched: "3.4.17" },
		{ package: "dompurify", ghsa: "GHSA-c6gr-qvv4-5v3f", patched: "3.4.17" },
		{ package: "dompurify", ghsa: "GHSA-zzzz-zzzz-zzzz", patched: "3.5.0" },
		{ package: "glob", ghsa: "GHSA-3g3m-2fjr-6pw4", patched: "14.0.2" },
		{ package: "dompurify", ghsa: "<b>evil</b>", patched: "1.0.0" },
	];
	it("writes a fixed note only for alerts the bump closes, from their ids", () => {
		const bump = bumpFromTitle("Bump dompurify from 3.4.16 to 3.4.17");
		const note = releaseNote(bump, alerts);
		expect(note).toBe(
			"Release note (fixed): Updated dompurify to 3.4.17, which closes security advisory GHSA-c6gr-qvv4-5v3f",
		);
		expect(prBodyNote(note).status).toBe("notes");
	});
	it("says none otherwise, in a line merge-ok accepts", () => {
		const note = releaseNote(
			bumpFromTitle("Bump vitest from 5.0.4 to 5.0.5"),
			alerts,
		);
		expect(note).toBe("Release note: none (dependency update)");
		expect(prBodyNote(`Bumps.\n\n${note}\n`).status).toBe("none");
		expect(releaseNote(null, alerts)).toBe(note);
	});
});

describe("agent output", () => {
	it("scrubs tokens, addresses, paths, html and mentions, and caps the length", () => {
		const s = scrub(
			"token gho_abcdefghijklmnop1234 at 100.64.1.2 and me@example.com in /home/dev/x.ts <img src=x> @dependabot merge box.tail1.ts.net",
		);
		for (const bad of [
			"gho_",
			"100.64",
			"example.com",
			"/home/dev",
			"<img",
			"@dependabot",
			"ts.net",
		])
			expect(s).not.toContain(bad);
		expect(scrub("x".repeat(5000), 100).length).toBeLessThanOrEqual(100);
	});
	it("drops links, issue references, markdown and absolute paths; keeps repo paths", () => {
		const s = scrub(
			"see [docs](https://evil.example/x) ![i](http://x/y.png) www.evil.example closes #12 and acme/widget#7 in /tmp/abc and ~/x; `code` **b** fixed src/web/a.ts",
		);
		for (const bad of [
			"http",
			"evil.example",
			"#12",
			"acme/widget",
			"/tmp",
			"~/",
			"`",
			"*",
			"!",
		])
			expect(s).not.toContain(bad);
		expect(s).toContain("src/web/a.ts");
	});
	it("posts agent text as an inert code block", () => {
		const b = codeBlock(scrub("x ``` y"));
		expect(b.startsWith("```text\n")).toBe(true);
		expect(b.endsWith("\n```")).toBe(true);
		expect(b.slice(8, -4)).not.toContain("`");
	});
	it("treats an unreadable or odd result as cannot-fix", () => {
		expect(parseResult("nope").status).toBe("cannot-fix");
		expect(parseResult('{"status":"merged","summary":"x"}').status).toBe(
			"cannot-fix",
		);
		expect(parseResult('{"status":"fixed","summary":"done"}')).toEqual({
			status: "fixed",
			summary: "done",
		});
	});
	it("refuses agent changes to protected and dependency files", () => {
		expect(agentChangeProblems(["src/a.ts"])).toEqual([]);
		for (const f of [
			".github/x.yml",
			"scripts/release.ts",
			"package.json",
			"pnpm-lock.yaml",
			".claude/settings.json",
			"x/.claude/y",
		])
			expect(agentChangeProblems(["src/a.ts", f])).toHaveLength(1);
	});
});

describe("agent sandbox", () => {
	it("gives the agent no gh, push, scripts or install, only its worktree", () => {
		const a = agentArgs({ worktree: "/w", home: "/h" }) as string[];
		const allowed = a.slice(
			a.indexOf("--allowedTools") + 1,
			a.indexOf("--disallowedTools"),
		);
		expect(
			allowed.some((t) => /gh|push|node|source|install|curl|wget/.test(t)),
		).toBe(false);
		expect(allowed).toContain("Edit(//w/**)");
		expect(a).toContain("--safe-mode");
		expect(a).toContain("--strict-mcp-config");
	});
	it("hides the credentials and keeps the home read-only", () => {
		const a = sandboxArgs({
			home: "/nonexistent-home",
			repo: "/nonexistent-repo",
			worktree: "/w",
			emptyDir: "/e",
		}) as string[];
		expect(a.slice(0, 4)).toEqual(["--die-with-parent", "--ro-bind", "/", "/"]);
		expect(a.join(" ")).toContain("--setenv GH_CONFIG_DIR /e");
		expect(a.join(" ")).toContain("--unsetenv GH_TOKEN");
	});
});

describe("plain versions only (F1)", () => {
	const base = { devDependencies: { dompurify: "^3.4.16" } };
	const at = (v: string) => ({ devDependencies: { dompurify: v } });
	const check = (v: string) =>
		manifestProblems({
			files: ["package.json", "pnpm-lock.yaml"],
			basePkg: base,
			headPkg: at(v),
			names: ["dompurify"],
			addedLockLines: [],
		});
	it("accepts a plain version with the base's range prefix", () => {
		expect(check("^3.4.17")).toEqual([]);
		expect(check("^3.5.0-rc.1")).toEqual([]);
	});
	it("refuses aliases, protocols, URLs, ranges and a changed prefix", () => {
		for (const v of [
			"npm:evil@3.4.17",
			"workspace:*",
			"catalog:",
			"patch:dompurify@3.4.17#./p.patch",
			"https://evil.example/d.tgz",
			"github:evil/dompurify",
			"3.x",
			">=3.4.17",
			"~3.4.17",
			"3.4.17",
		])
			expect(check(v).length).toBeGreaterThan(0);
	});
	it("refuses those specs in added lockfile lines", () => {
		for (const line of [
			"      dompurify: npm:evil@3.4.17",
			"      x: workspace:*",
			"      y: catalog:",
			"    z: patch:z@1.0.0#p.patch",
		])
			expect(
				manifestProblems({
					files: ["pnpm-lock.yaml"],
					basePkg: base,
					headPkg: base,
					names: ["dompurify"],
					addedLockLines: [line],
				}),
			).toHaveLength(1);
	});
});

describe("owner comments carry no PR-sourced text (F2)", () => {
	const evil = "@evil <img src=x> https://evil.example `x` #9";
	it("uses fixed text for every owner reason", () => {
		const cases = [
			facts({}, { headRefName: `x/${evil}` }),
			facts({
				commits: [
					BOT_COMMIT,
					{ ...BOT_COMMIT, sha: "b".repeat(40), author: evil },
				],
			}),
			facts({}, { files: ["package.json", `.github/${evil}.yml`] }),
			facts({ manifestProblems: [evil] }),
			facts({
				breaking: [{ name: evil, from: evil, to: evil, kind: "major" }],
			}),
			facts({
				checks: [
					...REQUIRED.map(pass),
					{ name: evil, bucket: "fail", link: evil },
				],
			}),
			facts({
				...failedRun("Run pnpm lint"),
				checks: [
					...REQUIRED.filter((n) => n !== "checks").map(pass),
					{
						name: evil,
						bucket: "fail",
						link: "https://github.com/o/r/actions/runs/77/job/88",
					},
				],
			}),
			facts(
				{},
				{
					body: `Release note (new): ${evil}\n\nRelease note: none (dependency update)`,
				},
			),
		];
		for (const f of cases) {
			const d = decide(f);
			expect(d.type).toBe("owner");
			expect(d.comment).toBeTruthy();
			expect(d.comment).not.toMatch(/evil|@|<|`|http/);
			expect(d.key).not.toContain("evil");
			expect(d.key).toMatch(/^[a-z-]+:[0-9a-f]{40}$/);
		}
	});
});

describe("other Release note lines block the merge (F3)", () => {
	const sweep = "Release note: none (dependency update)";
	it("merges with only the sweep's line, despite upstream 'Release notes' headings", () => {
		expect(
			decide(
				facts(
					{},
					{
						body: `Bumps x.\n<details>\n<summary>Release notes</summary>\n</details>\n\n${sweep}\n`,
					},
				),
			).type,
		).toBe("merge");
		expect(
			otherNoteLines(
				"Release note (fixed): Updated dompurify to 3.4.17, which closes security advisory GHSA-c6gr-qvv4-5v3f",
			),
		).toEqual([]);
	});
	it("asks the owner when another Release note line is anywhere in it", () => {
		for (const extra of [
			"<details>\n<blockquote>\n<p>Release note: none (upstream)</p>\n</blockquote>\n</details>",
			"> Release note (new): quoted",
			"Release note (improved): someone's",
			"release note: lowercase",
			"See the Release note below, mid-sentence",
			"<!-- Release note: hidden in a comment --!>",
		]) {
			expect(
				decide(facts({}, { body: `Bumps x.\n${extra}\n\n${sweep}\n` })),
			).toMatchObject({ type: "owner", key: `note-lines:${SHA}` });
		}
	});
});

describe("agent guard", () => {
	it("keeps the agent off until a reviewed sandbox revision is acknowledged", () => {
		expect(AGENT_ACK).toBe("");
		expect(agentEnabledFrom({}).on).toBe(false);
		expect(agentEnabledFrom({}).refused).toBeUndefined();
		const r = agentEnabledFrom({ CRB_SWEEP_AGENT: "on" });
		expect(r.on).toBe(false);
		expect(r.refused).toMatch(/refused/);
		expect(
			agentEnabledFrom({ CRB_SWEEP_AGENT: "on", CRB_SWEEP_AGENT_ACK: "" }).on,
		).toBe(false);
		expect(
			agentEnabledFrom({
				CRB_SWEEP_AGENT: "on",
				CRB_SWEEP_AGENT_ACK: "anything",
			}).on,
		).toBe(false);
	});
});
