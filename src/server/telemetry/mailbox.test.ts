import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import { type CrbConfig, DEFAULT_CONFIG } from "../config";
import { cacheDir, stateDir } from "../paths";
import { sanitize, scrubText } from "./collect";
import {
	type MailboxStatus,
	type PushOptions,
	pushMailbox,
	readStatus,
} from "./mailbox";
import { startMailboxTimer } from "./schedule";

// Real git processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const KEY = "Zx9-accessKeyValue-0123456789abcdef";
const TOKEN = `ghp_${"A".repeat(36)}`;

describe.concurrent("scrubbing what is sent", () => {
	it("removes the access key, tokens and URLs' userinfo from text", () => {
		const text = [
			`carbonless listening on http://100.64.0.1:4747/?key=${KEY}`,
			`open https://host.example/r/abc?x=1&key=${KEY}`,
			`token ${TOKEN} here`,
			"push to https://me:s3cr3tpass@github.com/me/mailbox.git",
			`raw key ${KEY} alone`,
		].join("\n");
		const out = scrubText(text, [KEY]);
		expect(out).not.toContain(KEY);
		expect(out).not.toContain(TOKEN);
		expect(out).not.toContain("s3cr3tpass");
		expect(out).not.toContain("me:");
		expect(out).toContain("https://[removed]@github.com/me/mailbox.git");
		expect(out).toContain("http://100.64.0.1:4747/?key=[removed]");
	});

	it("drops values named like secrets and an env's values, keeps the rest", () => {
		const config = {
			serve: { host: "0.0.0.0", port: 4747 },
			agent: {
				command: "claude",
				args: ["--x"],
				env: { ANTHROPIC_API_KEY: "sk-ant-xyz", WEIRD_NAME: "hunter2" },
			},
			telemetry: {
				mailbox: "https://x-access-token:abc123@github.com/me/m.git",
				device: "laptop",
				every: 15,
			},
			nested: { apiToken: "t", password: "p", Secret: "s", authHeader: "a" },
		};
		const out = JSON.stringify(sanitize(config, [KEY]));
		for (const secret of ["sk-ant-xyz", "hunter2", "abc123", '"t"', '"p"']) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain("ANTHROPIC_API_KEY");
		expect(out).toContain("github.com/me/m.git");
		expect(out).toContain('"device":"laptop"');
		expect(out).toContain('"host":"0.0.0.0"');
	});
});

describe("the telemetry mailbox", () => {
	let remote: { path: string; cleanup: () => void };
	let traces: string;
	let work: string;
	const remoteGit = (...args: string[]) =>
		execFileSync("git", ["--git-dir", remote.path, ...args], {
			encoding: "utf8",
			input: "",
			env: testGitEnv(),
		}).trim();
	const config = (): CrbConfig => ({
		...DEFAULT_CONFIG,
		agent: {
			command: "agent",
			args: [],
			env: { OPENAI_API_KEY: "sk-live-secretvalue" },
			leash: "open",
		},
		telemetry: { mailbox: remote.path, device: "laptop", every: 15 },
	});
	const opts = (over: Partial<PushOptions> = {}): PushOptions => {
		const c = config();
		return {
			telemetry: c.telemetry as NonNullable<CrbConfig["telemetry"]>,
			config: c,
			traceDir: traces,
			by: "serve",
			...over,
		};
	};
	const pushed = async (over: Partial<PushOptions> = {}) => {
		const r = await pushMailbox(opts(over));
		if (!r.status) throw new Error("busy");
		return r.status;
	};
	const show = (path: string, branch = "device/laptop") =>
		remoteGit("show", `${branch}:devices/laptop/${path}`);
	const tree = (branch = "device/laptop") =>
		remoteGit("ls-tree", "-r", "--name-only", branch).split("\n");
	const traceFile = (name: string, body: string, ageMs = 0) => {
		const path = join(traces, name);
		writeFileSync(path, body);
		const t = (Date.now() - ageMs) / 1000;
		utimesSync(path, t, t);
	};

	beforeEach(() => {
		remote = createBareRepo();
		work = mkdtempSync(join(tmpdir(), "crb-mailbox-"));
		traces = join(work, "traces");
		mkdirSync(traces, { recursive: true });
		mkdirSync(stateDir(), { recursive: true });
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(join(stateDir(), "key"), `${KEY}\n`);
		writeFileSync(
			join(stateDir(), "serve.log"),
			`crb: carbonless listening on http://127.0.0.1:4747/?key=${KEY}\r\nline two\n`,
		);
	});
	afterEach(() => {
		remote.cleanup();
		rmSync(work, { recursive: true, force: true });
		rmSync(stateDir(), { recursive: true, force: true });
		rmSync(cacheDir(), { recursive: true, force: true });
	});

	it("pushes traces, logs and state to device/<device>, secrets removed", async () => {
		traceFile("crb-1-abc.20261127.000000.jsonl", '{"a":1}\n{"partial');
		traceFile("other-tool-1-abc.jsonl", "{}\n");
		// A clone with review refs.
		const clone = join(cacheDir(), "repos", "acme", "widget.git");
		execFileSync("git", ["init", "--quiet", "--bare", clone], {
			env: testGitEnv(),
		});
		const blob = execFileSync(
			"git",
			["--git-dir", clone, "hash-object", "-w", "--stdin"],
			{ input: "x", encoding: "utf8", env: testGitEnv() },
		).trim();
		for (const ref of [
			"refs/crb/reviews/r1/meta",
			"refs/crb/reviews/r2/meta",
			"refs/crb/reviews/r2/reviewers/me/progress",
		]) {
			execFileSync("git", ["--git-dir", clone, "update-ref", ref, blob], {
				env: testGitEnv(),
			});
		}

		const status = await pushed();
		expect(status).toMatchObject({ ok: true, device: "laptop" });

		expect(remoteGit("for-each-ref", "--format=%(refname)")).toBe(
			"refs/heads/device/laptop",
		);
		expect(tree()).toEqual(
			expect.arrayContaining([
				"devices/laptop/state.json",
				"devices/laptop/state-history.jsonl",
				"devices/laptop/logs/serve.log",
				"devices/laptop/traces/crb-1-abc.20261127.000000.jsonl",
			]),
		);
		// Only crb's trace files, up to the last whole line.
		expect(tree().some((p) => p.includes("other-tool"))).toBe(false);
		expect(show("traces/crb-1-abc.20261127.000000.jsonl")).toBe('{"a":1}');
		// The log as written (CRLF kept), the key gone.
		const log = remoteGit(
			"cat-file",
			"blob",
			"device/laptop:devices/laptop/logs/serve.log",
		);
		expect(log).not.toContain(KEY);
		expect(log).toContain("\r\n");
		const state = JSON.parse(show("state.json"));
		expect(JSON.stringify(state)).not.toContain(KEY);
		expect(JSON.stringify(state)).not.toContain("sk-live-secretvalue");
		expect(state.crb.version).toEqual(expect.any(String));
		expect(state.git).toMatch(/^git version/);
		expect(state.config.telemetry.device).toBe("laptop");
		expect(state.clones).toEqual([
			expect.objectContaining({
				repo: "acme/widget",
				crbRefs: 3,
				reviews: 2,
				bytes: expect.any(Number),
			}),
		]);
		expect(state.traces.dir).toBe(traces);
	});

	it("keeps the branch one snapshot whatever the number of pushes; old traces leave", async () => {
		for (let i = 0; i < 6; i++) {
			traceFile(`crb-1-abc.20261127.00000${i}.jsonl`, `{"push":${i}}\n`);
			if (i >= 2)
				rmSync(join(traces, `crb-1-abc.20261127.00000${i - 2}.jsonl`));
			expect((await pushed()).ok).toBe(true);
		}
		expect(remoteGit("rev-list", "--count", "device/laptop")).toBe("1");
		const files = tree().filter((p) => p.includes("/traces/"));
		expect(files).toEqual([
			"devices/laptop/traces/crb-1-abc.20261127.000004.jsonl",
			"devices/laptop/traces/crb-1-abc.20261127.000005.jsonl",
		]);
		// The state's history carries every push.
		expect(show("state-history.jsonl").split("\n")).toHaveLength(6);
		expect(remoteGit("tag")).toBe("");
	});

	it("leaves the oldest traces out past the cap", async () => {
		const big = (c: string) => `${c.repeat(199_999)}\n`;
		traceFile("crb-1-a.20261125.000000.jsonl", big("o"), 3000);
		traceFile("crb-1-a.20261126.000000.jsonl", big("m"), 2000);
		traceFile("crb-1-a.20261127.000000.jsonl", big("n"), 1000);
		// The state, its history and the log take a few KB; two traces fit.
		const status = await pushed({ maxBytes: 450_000 });
		expect(status.ok).toBe(true);
		expect(status.tracesLeftOut).toBe(1);
		const files = tree().filter((p) => p.includes("/traces/"));
		expect(files).toEqual([
			"devices/laptop/traces/crb-1-a.20261126.000000.jsonl",
			"devices/laptop/traces/crb-1-a.20261127.000000.jsonl",
		]);
	});

	it("writes only its own branch, taking it over with a lease when it moved", async () => {
		expect((await pushed()).ok).toBe(true);
		// Someone else's branch, and this device's moved meanwhile (a
		// reinstall, another crb with the same name).
		const other = remoteGit(
			"commit-tree",
			remoteGit("hash-object", "-t", "tree", "-w", "--stdin"),
			"-m",
			"other",
		);
		remoteGit("update-ref", "refs/heads/device/desktop", other);
		remoteGit("update-ref", "refs/heads/main", other);
		remoteGit("update-ref", "refs/heads/device/laptop", other);

		expect((await pushed()).ok).toBe(true);
		expect(remoteGit("rev-parse", "device/desktop")).toBe(other);
		expect(remoteGit("rev-parse", "main")).toBe(other);
		expect(remoteGit("rev-parse", "device/laptop")).not.toBe(other);
		expect(tree()).toContain("devices/laptop/state.json");
	});

	it("a missing remote fails quietly: status says so, nothing throws", async () => {
		const status = await pushed({
			telemetry: {
				mailbox: join(work, "nope.git"),
				device: "laptop",
				every: 15,
			},
		});
		expect(status.ok).toBe(false);
		expect(status.error).toBeTruthy();
		expect(await readStatus()).toMatchObject({ ok: false });
	});

	it("a rejected push fails quietly and keeps the last ok time", async () => {
		expect((await pushed()).ok).toBe(true);
		const lastOk = (await readStatus())?.lastOkAt;
		// Each push replaces the last: a remote that refuses that rejects it.
		remoteGit("config", "receive.denyNonFastForwards", "true");
		const status = await pushed();
		expect(status.ok).toBe(false);
		expect(status.error).toMatch(/non-fast-forward|rejected/);
		expect(status.lastOkAt).toBe(lastOk);
	});

	describe("crb serve's timer", () => {
		const statusOf = (ok: boolean, at: number): MailboxStatus => ({
			at: new Date(at).toISOString(),
			ok,
			...(ok ? {} : { error: "auth failed" }),
			device: "laptop",
			mailbox: remote.path,
			by: "serve",
		});

		it("is off without the config, pushes when on, then once an interval, even failing", async () => {
			let on = false;
			let now = Date.parse("2026-11-27T10:00:00Z");
			const pushes: number[] = [];
			const logs: string[] = [];
			const t = startMailboxTimer({
				readConfig: async () => ({
					config: on ? config() : DEFAULT_CONFIG,
					problems: [],
				}),
				traceDir: () => traces,
				log: (m) => logs.push(m),
				now: () => now,
				timer: false,
				push: async (o) => {
					pushes.push(now);
					const status = statusOf(false, now);
					writeFileSync(
						join(stateDir(), "telemetry", "status.json"),
						JSON.stringify(status),
					);
					expect(o.by).toBe("serve");
					return { status };
				},
			});
			mkdirSync(join(stateDir(), "telemetry"), { recursive: true });
			await t.tick();
			expect(pushes).toEqual([]);
			on = true;
			await t.tick();
			expect(pushes).toHaveLength(1);
			// Failed: not again until the interval passed (no tight loop).
			now += 60_000;
			await t.tick();
			now += 13 * 60_000;
			await t.tick();
			expect(pushes).toHaveLength(1);
			now += 60_000;
			await t.tick();
			expect(pushes).toHaveLength(2);
			// Logged once for the same failure.
			expect(logs.filter((l) => l.includes("failed"))).toHaveLength(1);
			on = false;
			await t.tick();
			expect(logs.at(-1)).toBe("telemetry: off");
			t.stop();
		});

		it("never throws into serving, and runs one push at a time", async () => {
			let calls = 0;
			let release: () => void = () => {};
			const logs: string[] = [];
			const t = startMailboxTimer({
				readConfig: async () => ({ config: config(), problems: [] }),
				traceDir: () => null,
				log: (m) => logs.push(m),
				timer: false,
				push: () => {
					calls++;
					return new Promise((_, reject) => {
						release = () => reject(new Error("disk full"));
					});
				},
			});
			const first = t.tick();
			const second = t.tick();
			expect(second).toBe(first);
			await vi.waitFor(() => expect(calls).toBe(1));
			release();
			await first;
			expect(calls).toBe(1);
			expect(logs).toEqual(["telemetry: error: disk full"]);
			t.stop();
		});

		it("pushes for real through the timer", async () => {
			const t = startMailboxTimer({
				readConfig: async () => ({ config: config(), problems: [] }),
				traceDir: () => traces,
				log: () => {},
				timer: false,
			});
			await t.tick();
			expect(tree()).toContain("devices/laptop/state.json");
			const status = JSON.parse(
				readFileSync(join(stateDir(), "telemetry", "status.json"), "utf8"),
			);
			expect(status).toMatchObject({ ok: true, by: "serve" });
			t.stop();
		});
	});
});
