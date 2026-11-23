import { describe, expect, it } from "vitest";
import {
	agentArgs,
	agentChangeProblems,
	bumpFromTitle,
	classifyJob,
	decide,
	parseResult,
	releaseNote,
	runtimeBumps,
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
		runtimeBumps: [],
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

	it("trusts the sweep's own pushed commits", () => {
		const mine = {
			sha: "c".repeat(40),
			author: "owner",
			committer: "owner",
			verified: false,
		};
		expect(
			decide(facts({ commits: [BOT_COMMIT, mine], sweepShas: [mine.sha] }))
				.type,
		).toBe("merge");
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

	it("never merges a breaking runtime dependency bump", () => {
		const rb = [
			{ name: "fastify", from: "^5.1.0", to: "^6.0.0", kind: "major" },
		];
		expect(decide(facts({ runtimeBumps: rb })).type).toBe("owner");
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
		expect(decide(facts(failedRun("Run pnpm test", 2)))).toMatchObject({
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
			expect(decide(facts(failedRun(s))).type).toBe("agent");
		}
	});

	it("tries the agent once per head commit", () => {
		expect(
			decide(facts({ ...failedRun("Run pnpm lint"), agentTried: true })),
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

describe("runtimeBumps", () => {
	it("flags breaking and new runtime dependencies, not dev ones", () => {
		const base = {
			dependencies: { a: "^1.2.0", b: "^0.3.1", c: "^2.0.0" },
			devDependencies: { v: "^1.0.0" },
		};
		const head = {
			dependencies: { a: "^2.0.0", b: "^0.4.0", c: "^2.1.0", d: "^1.0.0" },
			devDependencies: { v: "^9.0.0" },
		};
		expect(
			runtimeBumps(base, head).map((x: { name: string }) => x.name),
		).toEqual(["a", "b", "d"]);
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
