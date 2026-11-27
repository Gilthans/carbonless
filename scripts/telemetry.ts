// pnpm telemetry pull [<remote>] [--device <name>] [--dir <cache dir>]
//
// The reading side of the telemetry mailbox (docs/telemetry-mailbox.md,
// CAR-323): fetches the mailbox's device branches (`device/*`, nothing
// else) into a local cache and lays each device's snapshot out under
// `<dir>/devices/<device>/`, then prints where each device's traces landed:
// `pnpm test-profile <that>/traces` reads them as a server's.
//
// The remote is the reviewer's private repo: it comes from the command line
// or $CRB_TELEMETRY_MAILBOX, never from a tracked file (this repo is public).
// Read-only on the remote: it only fetches.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE =
	"usage: pnpm telemetry pull [<remote>] [--device <name>] [--dir <cache dir>]\n       (the remote may also come from $CRB_TELEMETRY_MAILBOX)";

const DEVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** git, with the remote in the environment (never argv: it may hold a token). */
function git(gitDir: string, args: string[], remote?: string): string {
	return execFileSync("git", [`--git-dir=${gitDir}`, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			...(remote
				? {
						GIT_CONFIG_COUNT: "2",
						GIT_CONFIG_KEY_0: "remote.mailbox.url",
						GIT_CONFIG_VALUE_0: remote,
						GIT_CONFIG_KEY_1: "core.autocrlf",
						GIT_CONFIG_VALUE_1: "false",
					}
				: {}),
		},
	});
}

/** The default cache: one per remote, under crb's cache dir. */
export function defaultDir(remote: string): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
	const id = createHash("sha256").update(remote).digest("hex").slice(0, 12);
	return join(base, "carbonless", "telemetry-mailbox", id);
}

export interface PulledDevice {
	device: string;
	/** Its snapshot: state.json, logs/, traces/. */
	dir: string;
	traces: string;
	traceFiles: number;
	/** When it pushed this snapshot (the commit's date). */
	pushedAt: string;
}

/** Fetches the mailbox and checks out each device's snapshot. */
export function pull(opts: {
	remote: string;
	device?: string;
	dir?: string;
}): PulledDevice[] {
	const dir = opts.dir ?? defaultDir(opts.remote);
	const repo = join(dir, "mailbox.git");
	mkdirSync(dir, { recursive: true });
	if (!existsSync(join(repo, "HEAD"))) {
		execFileSync("git", ["init", "--quiet", "--bare", repo]);
	}
	const spec = opts.device
		? `+refs/heads/device/${opts.device}:refs/heads/device/${opts.device}`
		: "+refs/heads/device/*:refs/heads/device/*";
	// --prune: a device whose branch was deleted goes here too.
	git(repo, ["fetch", "--quiet", "--prune", "mailbox", spec], opts.remote);
	const branches = git(repo, [
		"for-each-ref",
		"--format=%(refname:strip=3) %(committerdate:iso-strict)",
		"refs/heads/device/",
	])
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split(" ") as [string, string])
		.filter(([d]) => DEVICE.test(d) && (!opts.device || d === opts.device));
	const out: PulledDevice[] = [];
	for (const [device, pushedAt] of branches) {
		const target = join(dir, "devices", device);
		rmSync(target, { recursive: true, force: true });
		// Its own index, the snapshot's own paths (devices/<device>/…).
		const env = { GIT_INDEX_FILE: join(dir, `index-${device}`) };
		execFileSync(
			"git",
			[
				`--git-dir=${repo}`,
				`--work-tree=${dir}`,
				"-c",
				"core.autocrlf=false",
				"checkout",
				"--force",
				`refs/heads/device/${device}`,
				"--",
				`devices/${device}`,
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } },
		);
		const traces = join(target, "traces");
		const traceFiles = existsSync(traces)
			? readdirSync(traces).filter((n) => statSync(join(traces, n)).isFile())
					.length
			: 0;
		out.push({ device, dir: target, traces, traceFiles, pushedAt });
	}
	return out;
}

function main(argv: string[]): void {
	const [command, ...rest] = argv;
	if (command !== "pull") throw new Error(USAGE);
	let remote = process.env.CRB_TELEMETRY_MAILBOX;
	let device: string | undefined;
	let dir: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i] as string;
		if (a === "--device") device = rest[++i];
		else if (a === "--dir") dir = rest[++i];
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			return;
		} else if (a.startsWith("-"))
			throw new Error(`unknown option ${a}\n${USAGE}`);
		else remote = a;
	}
	if (!remote) throw new Error(`no remote\n${USAGE}`);
	if (device !== undefined && !DEVICE.test(device)) {
		throw new Error(`--device ${device}: not a device name`);
	}
	const pulled = pull({ remote, device, dir });
	if (pulled.length === 0) {
		console.log(device ? `no branch device/${device}` : "no device branches");
		return;
	}
	for (const p of pulled) {
		console.log(
			`${p.device}: pushed ${p.pushedAt}, ${p.traceFiles} trace files\n  ${p.dir}\n  pnpm test-profile ${p.traces}`,
		);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		const e = error as Error & { stderr?: string };
		console.error(e.stderr?.trim() || e.message);
		process.exitCode = 1;
	}
}
