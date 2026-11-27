import { readdir, readFile, stat } from "node:fs/promises";
import { arch, hostname, platform, release } from "node:os";
import { join } from "node:path";
import type { CrbConfig } from "../config.js";
import { runGit } from "../git.js";
import { cacheDir, stateDir } from "../paths.js";
import { readLiveServerState } from "../serverState.js";
import { BUILD } from "../version.js";

/*
 * What the telemetry mailbox sends (docs/telemetry-mailbox.md): the trace
 * files, crb's logs (tails) and a snapshot of this machine's crb. The
 * mailbox is the reviewer's own private repo, so names stay; nothing that
 * authenticates leaves: the access key, tokens, anything named like a
 * secret, URLs' userinfo.
 */

const REMOVED = "[removed]";

/** A config key whose value is a secret, whatever it holds. */
const SECRET_NAME = /key|token|secret|passw|credential|auth|cookie|session/i;

/** An option naming a secret, its value apart (`--token`, `-api-key`). */
const SECRET_OPTION = /^-{1,2}[\w-]*(?:key|token|secret|passw)[\w-]*$/i;

/** Text that is a secret wherever it appears. */
const SECRET_TEXT: [RegExp, string][] = [
	// scheme://user:pass@host → scheme://[removed]@host
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@"'<>]+@/gi, `$1${REMOVED}@`],
	// crb's links carry the access key as ?key=…
	[/([?&](?:key|token|access_token)=)[^&\s"'<>]+/gi, `$1${REMOVED}`],
	// GitHub tokens (classic, fine-grained, app), common API keys.
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REMOVED],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REMOVED],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/g, REMOVED],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, REMOVED],
	[/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REMOVED}`],
	// A command-line option carrying one: --api-key=…, -token …, --password x
	[
		/(-{1,2}[\w-]*(?:key|token|secret|passw)[\w-]*)(=|[ \t]+)[^\s"'\\]+/gi,
		`$1$2${REMOVED}`,
	],
];

/**
 * `text` with every secret replaced: the literal `secrets` (the access
 * key) and anything shaped like a credential.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of secrets) {
		if (s.length >= 8) out = out.split(s).join(REMOVED);
	}
	for (const [pattern, to] of SECRET_TEXT) out = out.replace(pattern, to);
	return out;
}

/**
 * A JSON value with secrets removed: a key named like a secret loses its
 * value, an `env` keeps only its names (an agent's API keys go by any
 * name), and every string is scrubbed.
 */
export function sanitize(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") return scrubText(value, secrets);
	if (Array.isArray(value)) {
		// argv: `--token`, then its value as the next element.
		return value.map((v, i) =>
			i > 0 &&
			typeof v === "string" &&
			typeof value[i - 1] === "string" &&
			SECRET_OPTION.test(value[i - 1] as string)
				? REMOVED
				: sanitize(v, secrets),
		);
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (SECRET_NAME.test(k)) out[k] = REMOVED;
			else if (k === "env" && typeof v === "object" && v !== null) {
				out[k] = Object.fromEntries(Object.keys(v).map((n) => [n, REMOVED]));
			} else out[k] = sanitize(v, secrets);
		}
		return out;
	}
	return value;
}

/** The access key (stateDir/key), to scrub from what's sent; [] if none. */
export async function knownSecrets(): Promise<string[]> {
	const key = await readFile(join(stateDir(), "key"), "utf8").catch(() => "");
	return key.trim() ? [key.trim()] : [];
}

/** Bytes under `path` (files only, symlinks not followed); 0 when missing. */
async function sizeOnDisk(path: string): Promise<number> {
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(path);
	} catch {
		return 0;
	}
	if (!st.isDirectory()) return st.size;
	let total = 0;
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		if (e.isDirectory()) total += await sizeOnDisk(join(path, e.name));
		else if (e.isFile()) {
			total += await stat(join(path, e.name)).then(
				(s) => s.size,
				() => 0,
			);
		}
	}
	return total;
}

interface CloneState {
	repo: string;
	bytes: number;
	/** Refs under refs/crb/. */
	crbRefs: number;
	/** Reviews with a meta ref (refs/crb/reviews/<id>/meta). */
	reviews: number;
	/** When it last fetched (FETCH_HEAD's mtime), if ever. */
	lastFetch: string | null;
	/** `git count-objects -v`, as numbers. */
	objects: Record<string, number>;
}

/** Each of crb's clones (cacheDir/repos/<owner>/<repo>.git). */
async function cloneStates(): Promise<CloneState[]> {
	const root = join(cacheDir(), "repos");
	const out: CloneState[] = [];
	const owners = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const owner of owners) {
		if (!owner.isDirectory()) continue;
		const repos = await readdir(join(root, owner.name), {
			withFileTypes: true,
		}).catch(() => []);
		for (const repo of repos) {
			if (!repo.isDirectory() || !repo.name.endsWith(".git")) continue;
			const path = join(root, owner.name, repo.name);
			const refs = (
				await runGit(
					path,
					["for-each-ref", "--format=%(refname)", "refs/crb/"],
					{
						allowFailure: true,
						timeoutMs: 60_000,
					},
				)
			)
				.split("\n")
				.filter(Boolean);
			const reviews = refs.filter((r) =>
				/^refs\/crb\/reviews\/[^/]+\/meta$/.test(r),
			).length;
			const counted = await runGit(path, ["count-objects", "-v"], {
				allowFailure: true,
				timeoutMs: 60_000,
			});
			const objects: Record<string, number> = {};
			for (const line of counted.split("\n")) {
				const m = /^([\w-]+):\s*(\d+)$/.exec(line.trim());
				if (m) objects[m[1] as string] = Number(m[2]);
			}
			const fetched = await stat(join(path, "FETCH_HEAD")).then(
				(s) => s.mtime.toISOString(),
				() => null,
			);
			out.push({
				repo: `${owner.name}/${repo.name.slice(0, -".git".length)}`,
				bytes: await sizeOnDisk(path),
				crbRefs: refs.length,
				reviews,
				lastFetch: fetched,
				objects,
			});
		}
	}
	return out;
}

export interface StateOptions {
	config: CrbConfig;
	traceDir: string | null;
	/** Who pushes: the server's timer or `crb telemetry send`. */
	by: "serve" | "cli";
	secrets: readonly string[];
	now: Date;
}

/** state.json: which crb, on what, its config (no secrets) and its clones. */
export async function collectState(opts: StateOptions): Promise<unknown> {
	const gitVersion = (
		await runGit(process.cwd(), ["--version"], {
			allowFailure: true,
			timeoutMs: 30_000,
		})
	).trim();
	const server = await readLiveServerState().catch(() => null);
	const state = {
		at: opts.now.toISOString(),
		by: opts.by,
		crb: { version: BUILD.version, commit: BUILD.commit },
		os: { platform: platform(), arch: arch(), release: release() },
		// Which machine and install pushed it: two crbs sharing a device
		// name, or a reinstall, read apart.
		machine: { hostname: hostname(), stateDir: stateDir() },
		node: process.version,
		git: gitVersion || null,
		server: server
			? {
					pid: server.pid,
					startedAt: server.startedAt,
					uptimeSeconds: Math.max(
						0,
						Math.round(
							(opts.now.getTime() - Date.parse(server.startedAt)) / 1000,
						),
					),
					version: server.version,
					url: server.url,
					publicUrl: server.publicUrl ?? null,
				}
			: null,
		process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
		config: opts.config,
		traces: opts.traceDir
			? { dir: opts.traceDir, bytes: await sizeOnDisk(opts.traceDir) }
			: null,
		clones: await cloneStates(),
	};
	return sanitize(state, opts.secrets);
}
