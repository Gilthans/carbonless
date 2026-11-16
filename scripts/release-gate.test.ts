import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNextPr, releaseGate } from "./release-gate.mjs";

const REPO = "owner/repo";

/** A PR as GitHub's REST API lists it. */
const pull = (
	number: number,
	ref: string,
	repo: string | null = REPO,
	title = `pr ${number}`,
) => ({
	number,
	title,
	html_url: `https://github.com/${REPO}/pull/${number}`,
	base: { ref: "master" },
	head: { ref, repo: repo === null ? null : { full_name: repo } },
});

const NEXT = pull(12, "next/0.3.0", REPO, "next: 0.3.0");
const FEATURE = pull(20, "car-1-feature");
/** matching-refs, as `gh api --paginate --slurp` pages it. */
const tagPages = (...tags: string[]) => [
	tags.map((t) => ({ ref: `refs/tags/${t}` })),
];

describe("release gate (CAR-191)", () => {
	it("passes any PR while master's version isn't released", () => {
		const gate = releaseGate({
			version: "0.3.0",
			tags: tagPages("v0.2.0", "v0.3.0-rc.1"),
			pulls: [[FEATURE]],
			repo: REPO,
			pr: FEATURE,
		});
		expect(gate).toMatchObject({ ok: true, frozen: false, blocker: null });
		expect(gate.message).toBe(
			"0.3.0 is not released yet: merges to master are open",
		);
	});

	it("blocks any other PR once the version is released, naming the open next PR", () => {
		const gate = releaseGate({
			version: "0.2.0",
			tags: tagPages("v0.2.0-rc.3", "v0.2.0"),
			pulls: [[FEATURE, NEXT]],
			repo: REPO,
			pr: FEATURE,
		});
		expect(gate.ok).toBe(false);
		expect(gate.frozen).toBe(true);
		expect(gate.blocker).toBe(
			`merge #12 next: 0.3.0 (https://github.com/${REPO}/pull/12) first`,
		);
		expect(gate.message).toBe(
			`frozen: 0.2.0 is released and master's version is still 0.2.0 (a merge now publishes no RC and misses the changelog): merge #12 next: 0.3.0 (https://github.com/${REPO}/pull/12) first`,
		);
	});

	it("passes the next PR itself while frozen", () => {
		const gate = releaseGate({
			version: "0.2.0",
			tags: ["v0.2.0"],
			pulls: [NEXT],
			repo: REPO,
			pr: NEXT,
		});
		expect(gate).toMatchObject({ ok: true, frozen: true });
		expect(gate.message).toContain('#12 is the "next" PR');
	});

	it("a fork's next/* branch, or a next-looking branch that isn't next/X.Y.Z, is not exempt", () => {
		const fork = pull(30, "next/0.3.0", "someone/repo");
		const deletedFork = pull(31, "next/0.3.0", null);
		const loose = pull(32, "next/whatever");
		for (const pr of [fork, deletedFork, loose]) {
			expect(isNextPr(pr, REPO), String(pr.number)).toBe(false);
			const gate = releaseGate({
				version: "0.2.0",
				tags: ["refs/tags/v0.2.0"],
				pulls: [NEXT, pr],
				repo: REPO,
				pr,
			});
			expect(gate.ok, String(pr.number)).toBe(false);
			// Nor is a fork's next/* named as the PR to merge.
			expect(gate.blocker).toBe(
				`merge #12 next: 0.3.0 (https://github.com/${REPO}/pull/12) first`,
			);
		}
	});

	it("with no open next PR, says to run release-finish again", () => {
		const gate = releaseGate({
			version: "0.2.0",
			tags: tagPages("v0.2.0"),
			pulls: [[FEATURE, pull(30, "next/0.3.0", "someone/repo")]],
			repo: REPO,
			pr: FEATURE,
		});
		expect(gate.ok).toBe(false);
		expect(gate.blocker).toMatch(/^no "next" PR is open: run release-finish/);
	});

	it("counts npm's versions as released when given; an RC tag is not the release", () => {
		const base = {
			version: "0.2.0",
			tags: ["v0.2.0-rc.4"],
			pulls: [],
			repo: REPO,
			pr: FEATURE,
		};
		expect(releaseGate(base).ok).toBe(true);
		expect(releaseGate({ ...base, npmVersions: ["0.2.0-rc.4"] }).ok).toBe(true);
		expect(releaseGate({ ...base, npmVersions: ["0.2.0"] }).ok).toBe(false);
	});

	it("leaves PRs to other bases alone, and refuses a version that isn't X.Y.Z", () => {
		expect(
			releaseGate({
				version: "0.2.0",
				tags: ["v0.2.0"],
				pulls: [],
				repo: REPO,
				pr: { ...FEATURE, base: { ref: "side" } },
			}).ok,
		).toBe(true);
		expect(() =>
			releaseGate({ version: "0.2.0-rc.1", tags: [], pulls: [], repo: REPO }),
		).toThrow(/must be a release X\.Y\.Z/);
	});

	it("runs as CI runs it: plain node, no dependencies, the head from the environment", () => {
		const dir = mkdtempSync(join(tmpdir(), "crb-release-gate-"));
		try {
			const files = (version: string, tags: string[], pulls: unknown[]) => {
				writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
				writeFileSync(
					join(dir, "tags.json"),
					JSON.stringify(tagPages(...tags)),
				);
				writeFileSync(join(dir, "pulls.json"), JSON.stringify([pulls]));
			};
			const cli = (env: Record<string, string>) => {
				try {
					const out = execFileSync(
						process.execPath,
						[
							join(import.meta.dirname, "release-gate.mjs"),
							join(dir, "package.json"),
							join(dir, "tags.json"),
							join(dir, "pulls.json"),
						],
						{
							encoding: "utf8",
							stdio: "pipe",
							env: { PATH: process.env.PATH, GITHUB_REPOSITORY: REPO, ...env },
						},
					);
					return { code: 0, out };
				} catch (error) {
					const e = error as { status: number; stdout: string; stderr: string };
					return { code: e.status, out: e.stdout + e.stderr };
				}
			};
			const feature = {
				PR_NUMBER: "20",
				HEAD_REF: "car-1-feature",
				HEAD_REPO: REPO,
			};
			files("0.3.0", ["v0.2.0"], [NEXT, FEATURE]);
			expect(cli(feature).code).toBe(0);
			files("0.2.0", ["v0.2.0"], [NEXT, FEATURE]);
			const blocked = cli(feature);
			expect(blocked.code).toBe(1);
			expect(blocked.out).toMatch(/^::error title=Release freeze::frozen: /);
			expect(blocked.out).toContain("merge #12 next: 0.3.0");
			expect(blocked.out).toContain("rerun this check");
			expect(
				cli({ PR_NUMBER: "12", HEAD_REF: "next/0.3.0", HEAD_REPO: REPO }).code,
			).toBe(0);
			expect(
				cli({
					PR_NUMBER: "30",
					HEAD_REF: "next/0.3.0",
					HEAD_REPO: "someone/repo",
				}).code,
			).toBe(1);
			// No repository: usage, never a pass.
			const noRepo = (() => {
				try {
					execFileSync(
						process.execPath,
						[join(import.meta.dirname, "release-gate.mjs"), "a", "b", "c"],
						{ stdio: "pipe", env: { PATH: process.env.PATH } },
					);
					return 0;
				} catch (error) {
					return (error as { status: number }).status;
				}
			})();
			expect(noRepo).toBe(2);
			// Unreadable answers fail, never pass.
			writeFileSync(join(dir, "pulls.json"), "not json");
			expect(cli(feature).code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		// Node built-ins only.
		const source = readFileSync(
			join(import.meta.dirname, "release-gate.mjs"),
			"utf8",
		);
		expect(source.match(/^import .* from "([^"]+)";$/gm)).toEqual([
			'import { readFileSync, realpathSync } from "node:fs";',
			'import { fileURLToPath } from "node:url";',
		]);
	});
});
