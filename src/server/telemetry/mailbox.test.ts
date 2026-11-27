import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBareRepo,
	GIT_TEST_TIMEOUTS,
	testGitEnv,
} from "../../../test/git-fixture";
import { type CrbConfig, DEFAULT_CONFIG } from "../config";
import { runGit } from "../git";
import { cacheDir, stateDir } from "../paths";
import { sanitize, scrubText } from "./collect";
import {
	gitEnv,
	type MailboxStatus,
	type PushOptions,
	pushMailbox,
	readStatus,
	scrubbed,
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
			args: ["--api-key=abcdef123", "--token", "tok98765", "--verbose"],
		};
		const out = JSON.stringify(sanitize(config, [KEY]));
		expect(out).toContain("--verbose");
		for (const secret of [
			"sk-ant-xyz",
			"hunter2",
			"abc123",
			'"t"',
			'"p"',
			"abcdef123",
			"tok98765",
		]) {
			expect(out).not.toContain(secret);
		}
		expect(out).toContain("ANTHROPIC_API_KEY");
		expect(out).toContain("github.com/me/m.git");
		expect(out).toContain('"device":"laptop"');
		expect(out).toContain('"host":"0.0.0.0"');
	});
});

describe.concurrent("the mailbox's git environment", () => {
	const config = (env: Record<string, string>) => {
		const out: Record<string, string> = {};
		for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) {
			out[env[`GIT_CONFIG_KEY_${i}`] as string] = env[
				`GIT_CONFIG_VALUE_${i}`
			] as string;
		}
		return out;
	};

	it("a background push can't prompt: no terminal, askpass, GCM UI or ssh questions", () => {
		const env = gitEnv({
			mailbox: "https://h/m.git",
			interactive: false,
			env: {},
		});
		expect(env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			SSH_ASKPASS_REQUIRE: "never",
			GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
		});
		expect(env.GIT_ASKPASS).toMatch(/no-askpass$/);
		expect(env.SSH_ASKPASS).toBe(env.GIT_ASKPASS);
		expect(config(env)).toMatchObject({
			"remote.mailbox.url": "https://h/m.git",
			"remote.mailbox.pushurl": "https://h/m.git",
			"credential.interactive": "false",
			"core.autocrlf": "false",
			"protocol.ext.allow": "never",
			"push.gpgSign": "false",
		});
	});

	it("keeps the user's ssh command, in batch mode when it's OpenSSH's", () => {
		const bg = (env: NodeJS.ProcessEnv, sshCommand?: string) =>
			gitEnv({ mailbox: "m", interactive: false, env, sshCommand })
				.GIT_SSH_COMMAND;
		expect(bg({ GIT_SSH_COMMAND: "ssh -i ~/.ssh/k" })).toBe(
			"ssh -i ~/.ssh/k -o BatchMode=yes",
		);
		expect(bg({}, "/usr/bin/ssh -F cfg")).toBe(
			"/usr/bin/ssh -F cfg -o BatchMode=yes",
		);
		expect(bg({}, '"C:/Program Files/OpenSSH/ssh.exe"')).toBe(
			'"C:/Program Files/OpenSSH/ssh.exe" -o BatchMode=yes',
		);
		// Another client's options are its own; $GIT_SSH is a bare program.
		expect(bg({}, "plink -batch")).toBeUndefined();
		// core.sshCommand comes before $GIT_SSH in git's order.
		expect(bg({ GIT_SSH: "/opt/my-ssh" }, "ssh -F cfg")).toBe(
			"ssh -F cfg -o BatchMode=yes",
		);
		expect(bg({ GIT_SSH: "/opt/my-ssh" })).toBeUndefined();
	});

	it("crb telemetry on|send in a terminal may prompt (the reviewer's own action)", () => {
		const env = gitEnv({ mailbox: "m", interactive: true, env: {} });
		for (const k of [
			"GIT_TERMINAL_PROMPT",
			"GIT_ASKPASS",
			"GCM_INTERACTIVE",
			"GIT_SSH_COMMAND",
		]) {
			expect(env[k]).toBeUndefined();
		}
		expect(config(env)["credential.interactive"]).toBeUndefined();
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
			maxBuffer: 64 * 1024 * 1024,
			env: testGitEnv({
				GIT_AUTHOR_NAME: "Someone",
				GIT_AUTHOR_EMAIL: "someone@example.com",
				GIT_COMMITTER_NAME: "Someone",
				GIT_COMMITTER_EMAIL: "someone@example.com",
			}),
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

	it("keeps the branch one commit over many pushes; traces stay for 7 days, then leave", async () => {
		const name = (i: number) => `crb-1-abc.20261127.00000${i}.jsonl`;
		for (let i = 0; i < 6; i++) {
			// Rotated: each push finds one more closed file.
			traceFile(name(i), `{"push":${i}}\n`, (6 - i) * 60_000);
			expect((await pushed()).ok).toBe(true);
		}
		expect(remoteGit("rev-list", "--count", "device/laptop")).toBe("1");
		const traced = () =>
			tree()
				.filter((p) => p.includes("/traces/"))
				.map((p) => p.split("/").at(-1));
		expect(traced()).toEqual([0, 1, 2, 3, 4, 5].map(name));
		// The state's history carries every push.
		expect(show("state-history.jsonl").split("\n")).toHaveLength(6);
		expect(remoteGit("tag")).toBe("");

		// Past the window: gone from the next snapshot.
		const old = (Date.now() - 8 * 24 * 60 * 60_000) / 1000;
		for (const i of [0, 1]) utimesSync(join(traces, name(i)), old, old);
		expect((await pushed()).ok).toBe(true);
		expect(traced()).toEqual([2, 3, 4, 5].map(name));
	});

	it("caps new data per push, newest first; what was sent stays; the rest follows", async () => {
		const big = (c: string) => `${c.repeat(199_999)}\n`;
		const day = 24 * 60 * 60_000;
		traceFile("crb-1-a.20261124.000000.jsonl", big("o"), 3 * day);
		expect((await pushed({ newCap: 300_000 })).ok).toBe(true);
		traceFile("crb-1-a.20261125.000000.jsonl", big("m"), 2 * day);
		traceFile("crb-1-a.20261126.000000.jsonl", big("n"), day);
		const traced = () =>
			tree()
				.filter((p) => p.includes("/traces/"))
				.map((p) => p.split("/").at(-1));

		// The newest fits; the next one waits; the one sent before stays.
		const second = await pushed({ newCap: 300_000 });
		expect(second).toMatchObject({ ok: true, tracesWaiting: 1 });
		expect(traced()).toEqual([
			"crb-1-a.20261124.000000.jsonl",
			"crb-1-a.20261126.000000.jsonl",
		]);
		// The next push brings it.
		const third = await pushed({ newCap: 300_000 });
		expect(third.ok).toBe(true);
		expect(third.tracesWaiting).toBeUndefined();
		expect(traced()).toEqual([
			"crb-1-a.20261124.000000.jsonl",
			"crb-1-a.20261125.000000.jsonl",
			"crb-1-a.20261126.000000.jsonl",
		]);
		expect(show("traces/crb-1-a.20261124.000000.jsonl")).toBe(
			"o".repeat(199_999),
		);
	});

	it("reads and scrubs only what a trace file added since the last push", async () => {
		// Over one read chunk (4 MiB), a secret on lines across it.
		const line = `{"k":"${KEY}","pad":"${"x".repeat(1000)}"}\n`;
		const count = Math.ceil((5 * 1024 * 1024) / line.length);
		const body = line.repeat(count);
		traceFile("crb-1-b19.20261127.000000.jsonl", body);
		scrubbed.bytes = 0;
		expect((await pushed()).ok).toBe(true);
		const first = scrubbed.bytes;
		expect(first).toBeGreaterThanOrEqual(body.length);

		// Unchanged: nothing read again.
		scrubbed.bytes = 0;
		expect((await pushed()).ok).toBe(true);
		expect(scrubbed.bytes).toBe(0);

		// Grown by one line: that line only.
		writeFileSync(join(traces, "crb-1-b19.20261127.000000.jsonl"), line, {
			flag: "a",
		});
		scrubbed.bytes = 0;
		expect((await pushed()).ok).toBe(true);
		expect(scrubbed.bytes).toBe(line.length);

		const sent = remoteGit(
			"cat-file",
			"blob",
			"device/laptop:devices/laptop/traces/crb-1-b19.20261127.000000.jsonl",
		);
		expect(sent).not.toContain(KEY);
		expect(sent.split("\n")).toHaveLength(count + 1);
	});

	it("sends logs and traces a global gitignore would skip", async () => {
		traceFile("crb-1-abc.20261127.000000.jsonl", "{}\n");
		const global = join(work, "global.gitconfig");
		const ignores = join(work, "global.ignore");
		writeFileSync(ignores, "*.log\n*.jsonl\n*.json\n");
		writeFileSync(
			global,
			`[core]\n\texcludesFile = ${ignores.replaceAll("\\", "/")}\n`,
		);
		const saved = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = global;
		try {
			expect((await pushed()).ok).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved;
		}
		expect(tree()).toEqual(
			expect.arrayContaining([
				"devices/laptop/logs/serve.log",
				"devices/laptop/state.json",
				"devices/laptop/traces/crb-1-abc.20261127.000000.jsonl",
			]),
		);
	});

	it.skipIf(process.platform === "win32")(
		"never puts the remote in git's argv",
		async () => {
			const shim = join(work, "shim");
			mkdirSync(shim);
			const log = join(work, "argv.log");
			const real = execFileSync("sh", ["-c", "command -v git"], {
				encoding: "utf8",
			}).trim();
			writeFileSync(
				join(shim, "git"),
				`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`,
			);
			chmodSync(join(shim, "git"), 0o755);
			const saved = process.env.PATH;
			process.env.PATH = `${shim}${delimiter}${saved}`;
			try {
				expect((await pushed()).ok).toBe(true);
			} finally {
				process.env.PATH = saved;
			}
			const argv = readFileSync(log, "utf8");
			expect(argv).toMatch(/push --quiet --no-verify --force-with-lease/);
			expect(argv).not.toContain(remote.path);
		},
	);

	const blob = (path: string) =>
		remoteGit("cat-file", "blob", `device/laptop:devices/laptop/${path}`);
	const outboxJson = () => join(stateDir(), "telemetry", "outbox.json");

	it("a push stopped between copying and recording never sends a line twice", async () => {
		const f = join(traces, "crb-1-abc.20261127.000000.jsonl");
		traceFile("crb-1-abc.20261127.000000.jsonl", '{"a":1}\n');
		expect((await pushed()).ok).toBe(true);
		const recorded = readFileSync(outboxJson(), "utf8");
		writeFileSync(f, '{"a":2}\n', { flag: "a" });
		expect((await pushed()).ok).toBe(true);
		// As if that push had stopped after copying, before recording it.
		writeFileSync(outboxJson(), recorded);
		writeFileSync(f, '{"a":3}\n', { flag: "a" });
		expect((await pushed()).ok).toBe(true);
		expect(blob("traces/crb-1-abc.20261127.000000.jsonl")).toBe(
			'{"a":1}\n{"a":2}\n{"a":3}',
		);
	});

	it("pushes that failed don't pile up: the first that lands adds no more than the cap", async () => {
		const name = "crb-2-abc.20261127.000000.jsonl";
		const line = `${"x".repeat(999)}\n`;
		const cap = 1_500_000;
		const missing = {
			telemetry: {
				mailbox: join(work, "missing.git"),
				device: "laptop",
				every: 15,
			},
		};
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(traces, name), line.repeat(1000), { flag: "a" });
			const failed = await pushed({ ...missing, newCap: cap });
			expect(failed.ok).toBe(false);
		}
		const landed = await pushed({ newCap: cap });
		expect(landed.ok).toBe(true);
		expect(landed.tracesWaiting).toBe(1);
		const size = Number(
			remoteGit(
				"cat-file",
				"-s",
				`device/laptop:devices/laptop/traces/${name}`,
			),
		);
		expect(size).toBeLessThanOrEqual(cap);
		expect(size % line.length).toBe(0);
		expect(landed.newBytes).toBeGreaterThanOrEqual(size);
		expect(landed.newBytes).toBeLessThanOrEqual(cap);
		// The rest follows, a cap at a time.
		for (let i = 0; i < 3; i++) await pushed({ newCap: cap });
		expect(blob(`traces/${name}`)).toBe(line.repeat(4000).trimEnd());
	});

	it("a deleted branch gets the window back a cap at a time, not in one push", async () => {
		const day = 24 * 60 * 60_000;
		const big = (c: string) => `${c.repeat(999)}\n`.repeat(1000);
		traceFile("crb-1-a.20261125.000000.jsonl", big("o"), 2 * day);
		traceFile("crb-1-a.20261126.000000.jsonl", big("n"), day);
		expect((await pushed()).ok).toBe(true);
		remoteGit("update-ref", "-d", "refs/heads/device/laptop");
		const again = await pushed({ newCap: 1_500_000 });
		expect(again).toMatchObject({ ok: true, tracesWaiting: 1 });
		// Deleted, not someone else's: no takeover.
		expect(again.tookOver).toBeUndefined();
		// The newest whole, the next in part: no more than the cap.
		const sizes = tree()
			.filter((p) => p.includes("/traces/"))
			.map((p) => Number(remoteGit("cat-file", "-s", `device/laptop:${p}`)));
		expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_500_000);
		expect(sizes).toContain(1_000_000);
		expect((await pushed({ newCap: 1_500_000 })).ok).toBe(true);
		expect(blob("traces/crb-1-a.20261125.000000.jsonl")).toBe(
			big("o").trimEnd(),
		);
		expect(blob("traces/crb-1-a.20261126.000000.jsonl")).toBe(
			big("n").trimEnd(),
		);
	});

	it("a push that landed but wasn't recorded isn't taken for another crb's", async () => {
		const dir = join(stateDir(), "telemetry");
		expect((await pushed()).ok).toBe(true);
		const ref = join(dir, "mailbox.git", "refs", "mailbox", "pushed");
		const first = {
			ref: readFileSync(ref, "utf8"),
			pushed: readFileSync(join(dir, "pushed.json"), "utf8"),
		};
		const second = await pushed();
		expect(second.ok).toBe(true);
		// As if crb had stopped right after the remote took the second push.
		writeFileSync(
			join(dir, "pending.json"),
			JSON.stringify({
				commit: second.commit,
				manifest: JSON.parse(readFileSync(join(dir, "pushed.json"), "utf8")),
			}),
		);
		writeFileSync(ref, first.ref);
		writeFileSync(join(dir, "pushed.json"), first.pushed);
		const third = await pushed();
		expect(third.ok).toBe(true);
		expect(third.tookOver).toBeUndefined();
	});

	it("locks a killed git left behind don't stop the next push", async () => {
		expect((await pushed()).ok).toBe(true);
		const repo = join(stateDir(), "telemetry", "mailbox.git");
		writeFileSync(join(repo, "index.lock"), "");
		writeFileSync(join(repo, "refs", "mailbox", "pushed.lock"), "");
		const next = await pushed();
		expect(next.error).toBeUndefined();
		expect(next.ok).toBe(true);
	});

	it("a trace file replaced under the same name, and a rotated serve.log, are copied anew", async () => {
		const name = "crb-1-abc.20261127.000000.jsonl";
		traceFile(name, '{"old":1}\n{"old":2}\n{"old":3}\n');
		expect((await pushed()).ok).toBe(true);
		rmSync(join(traces, name));
		traceFile(name, '{"new":1}\n');
		// serve.log moves to serve.log.1 (client.ts), a new one starts.
		const log = join(stateDir(), "serve.log");
		renameSync(log, `${log}.1`);
		writeFileSync(log, "crb: new start\n");
		expect((await pushed()).ok).toBe(true);
		expect(blob(`traces/${name}`)).toBe('{"new":1}');
		expect(blob("logs/serve.log")).toBe("crb: new start");
		expect(blob("logs/serve.log.1")).toMatch(/^crb: carbonless listening/);
	});

	it.skipIf(process.platform === "win32")(
		"an attached git stays in crb's session (a terminal can prompt), a timed one leaves it",
		async () => {
			const own = execFileSync(
				"ps",
				["-o", "sid=", "-p", String(process.pid)],
				{
					encoding: "utf8",
				},
			).trim();
			const sid = async (attached: boolean) =>
				(
					await runGit(work, ["-c", "alias.sid=!ps -o sid= -p $$", "sid"], {
						timeoutMs: 30_000,
						attached,
					})
				).trim();
			expect(await sid(true)).toBe(own);
			expect(await sid(false)).not.toBe(own);
		},
	);

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

		const took = await pushed();
		expect(took).toMatchObject({ ok: true, tookOver: true });
		expect(remoteGit("rev-parse", "device/desktop")).toBe(other);
		expect(remoteGit("rev-parse", "main")).toBe(other);
		expect(remoteGit("rev-parse", "device/laptop")).not.toBe(other);
		expect(tree()).toContain("devices/laptop/state.json");
		// Which machine pushed, for the reader to tell two apart.
		expect(JSON.parse(show("state.json")).machine).toEqual({
			hostname: hostname(),
			stateDir: stateDir(),
		});
		// Its own branch again: no takeover the next time.
		expect((await pushed()).tookOver).toBeUndefined();
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

	it.skipIf(process.platform === "win32")(
		"a background push to a remote that wants a login fails without asking anyone",
		async () => {
			const server = createServer((_req, res) => {
				res.writeHead(401, { "WWW-Authenticate": 'Basic realm="mailbox"' });
				res.end();
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			const { port } = server.address() as AddressInfo;
			// An askpass that would record being asked, as a desktop's would.
			const asked = join(work, "asked");
			const askpass = join(work, "askpass.sh");
			writeFileSync(
				askpass,
				`#!/bin/sh\necho asked >> '${asked}'\necho secret\n`,
			);
			chmodSync(askpass, 0o755);
			const empty = join(work, "empty.gitconfig");
			writeFileSync(empty, "");
			const saved = { ...process.env };
			Object.assign(process.env, {
				GIT_ASKPASS: askpass,
				SSH_ASKPASS: askpass,
				GIT_CONFIG_GLOBAL: empty,
				GIT_CONFIG_NOSYSTEM: "1",
			});
			try {
				const status = await pushed({
					telemetry: {
						mailbox: `http://127.0.0.1:${port}/m.git`,
						device: "laptop",
						every: 15,
					},
				});
				expect(status.ok).toBe(false);
				expect(existsSync(asked)).toBe(false);
			} finally {
				for (const k of [
					"GIT_ASKPASS",
					"SSH_ASKPASS",
					"GIT_CONFIG_GLOBAL",
					"GIT_CONFIG_NOSYSTEM",
				]) {
					if (saved[k] === undefined) delete process.env[k];
					else process.env[k] = saved[k];
				}
				await new Promise((done) => server.close(done));
			}
		},
	);

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
			await t.stop();
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
			await t.stop();
		});

		it("a clock set back makes a push due, not stuck", async () => {
			let calls = 0;
			const now = Date.parse("2026-11-27T10:00:00Z");
			mkdirSync(join(stateDir(), "telemetry"), { recursive: true });
			// The last attempt "in the future": the clock went back an hour.
			writeFileSync(
				join(stateDir(), "telemetry", "status.json"),
				JSON.stringify(statusOf(true, now + 3600_000)),
			);
			const t = startMailboxTimer({
				readConfig: async () => ({ config: config(), problems: [] }),
				traceDir: () => null,
				log: () => {},
				now: () => now,
				timer: false,
				push: async () => {
					calls++;
					return { status: statusOf(true, now) };
				},
			});
			await t.tick();
			expect(calls).toBe(1);
			await t.stop();
		});

		it("stop() stops a push under way and waits for it", async () => {
			let aborted = false;
			let started = false;
			const t = startMailboxTimer({
				readConfig: async () => ({ config: config(), problems: [] }),
				traceDir: () => null,
				log: () => {},
				timer: false,
				push: (o) =>
					new Promise((_, reject) => {
						started = true;
						o.signal?.addEventListener("abort", () => {
							aborted = true;
							reject(new Error("git was stopped"));
						});
					}),
			});
			const ticking = t.tick();
			await vi.waitFor(() => expect(started).toBe(true));
			await t.stop();
			expect(aborted).toBe(true);
			await ticking;
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
			await t.stop();
		});
	});
});
