import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "../shared/agent.js";
import { writeFileAtomic } from "./atomicFile.js";
import { configDir } from "./paths.js";

/** A Home view: a name and the repos it lists. */
export interface ViewConfig {
	name: string;
	/** "owner/repo", lowercased. */
	repos: string[];
}

/** The machine's config.json; see docs/superpowers/specs (Home, "Views and repos"). */
export interface CrbConfig {
	/**
	 * `publicUrl`: the origin people open crb at when a proxy (e.g. `tailscale
	 * serve` for HTTPS) sits in front of it; links use it, and the key is
	 * required even on a loopback bind.
	 */
	serve: { host: string; port: number; publicUrl?: string };
	views: ViewConfig[];
	refresh: { minutes: number };
	/** The reviewer's own ACP agent (review buddy); null: off. */
	agent: AgentConfig | null;
	/** `check: false`: never ask npm for a newer crb (no update toast). */
	updates: { check: boolean };
}

/** The config as read, and what was bad in the file and replaced by a default. */
export interface ConfigRead {
	config: CrbConfig;
	problems: string[];
}

export const DEFAULT_CONFIG: CrbConfig = Object.freeze({
	serve: Object.freeze({ host: "127.0.0.1", port: 4747 }),
	views: Object.freeze([]) as unknown as ViewConfig[],
	refresh: Object.freeze({ minutes: 2 }),
	agent: null,
	updates: Object.freeze({ check: true }),
}) as CrbConfig;

const DEFAULT_VIEW = "My PRs";
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const configFile = () => join(configDir(), "config.json");

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** An http(s) origin as written (no path, query or credentials), else null. */
export function parsePublicUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	const bare =
		(url.protocol === "http:" || url.protocol === "https:") &&
		url.pathname === "/" &&
		!url.search &&
		!url.hash &&
		!url.username &&
		!url.password;
	return bare ? url.origin : null;
}

/** A view's name as read: trimmed, "My PRs" when it has none. */
const viewName = (view: Json): string =>
	typeof view.name === "string" && view.name.trim()
		? view.name.trim()
		: DEFAULT_VIEW;

/** The file's JSON object; null when missing; a problem when it isn't one. */
async function readRaw(): Promise<{ raw: Json | null; problem?: string }> {
	let text: string;
	try {
		text = await readFile(configFile(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { raw: null };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			raw: null,
			problem: `config.json is not valid JSON (${(error as Error).message}); using the defaults`,
		};
	}
	if (!isObject(parsed)) {
		return { raw: null, problem: "config.json is not a JSON object" };
	}
	return { raw: parsed };
}

/** `raw` as a config: every bad part replaced by its default, with a problem. */
function validate(raw: Json | null): ConfigRead {
	const problems: string[] = [];
	const d = DEFAULT_CONFIG;
	const serve = { ...d.serve };
	if (raw?.serve !== undefined) {
		if (!isObject(raw.serve)) {
			problems.push("serve must be an object; using the defaults");
		} else {
			const { host, port, publicUrl } = raw.serve;
			if (host !== undefined) {
				if (typeof host === "string" && host.trim()) serve.host = host.trim();
				else {
					problems.push(
						`serve.host must be a non-empty string; using ${d.serve.host}`,
					);
				}
			}
			if (port !== undefined) {
				if (
					Number.isInteger(port) &&
					(port as number) >= 0 &&
					(port as number) <= 65535
				) {
					serve.port = port as number;
				} else {
					problems.push(
						`serve.port must be a port number; using ${d.serve.port}`,
					);
				}
			}
			if (publicUrl !== undefined) {
				const origin = parsePublicUrl(publicUrl);
				if (origin) serve.publicUrl = origin;
				else {
					problems.push(
						"serve.publicUrl must be an http(s) URL with no path; ignored",
					);
				}
			}
		}
	}
	const views: ViewConfig[] = [];
	if (raw?.views !== undefined) {
		if (!Array.isArray(raw.views)) {
			problems.push("views must be an array; using none");
		} else {
			raw.views.forEach((view: unknown, i) => {
				if (!isObject(view)) {
					problems.push(`views[${i}] is not an object; dropped`);
					return;
				}
				const name = viewName(view);
				const repos: string[] = [];
				const list = view.repos ?? [];
				if (!Array.isArray(list)) {
					problems.push(`views[${i}].repos must be an array; using none`);
				} else {
					for (const repo of list) {
						const r = typeof repo === "string" ? repo.trim().toLowerCase() : "";
						if (!REPO.test(r)) {
							problems.push(
								`views[${i}].repos: ${JSON.stringify(repo)} is not owner/repo; dropped`,
							);
						} else if (!repos.includes(r)) repos.push(r);
					}
				}
				views.push({ name, repos });
			});
		}
	}
	const refresh = { ...d.refresh };
	if (raw?.refresh !== undefined) {
		const minutes = isObject(raw.refresh) ? raw.refresh.minutes : undefined;
		if (!isObject(raw.refresh)) {
			problems.push("refresh must be an object; using the defaults");
		} else if (minutes !== undefined) {
			if (typeof minutes === "number" && minutes > 0 && minutes <= 1440) {
				refresh.minutes = minutes;
			} else {
				problems.push(
					`refresh.minutes must be a positive number; using ${d.refresh.minutes}`,
				);
			}
		}
	}
	const agent = validateAgent(raw?.agent, problems);
	const updates = { ...d.updates };
	if (raw?.updates !== undefined) {
		const check = isObject(raw.updates) ? raw.updates.check : undefined;
		if (!isObject(raw.updates)) {
			problems.push("updates must be an object; using the defaults");
		} else if (check !== undefined) {
			if (typeof check === "boolean") updates.check = check;
			else problems.push("updates.check must be true or false; using true");
		}
	}
	return { config: { serve, views, refresh, agent, updates }, problems };
}

/** The agent section: null when absent, null, or without a usable command. */
function validateAgent(raw: unknown, problems: string[]): AgentConfig | null {
	if (raw === undefined || raw === null) return null;
	if (!isObject(raw)) {
		problems.push("agent must be an object or null; agent disabled");
		return null;
	}
	const { command, args, env, leash } = raw;
	if (typeof command !== "string" || !command.trim()) {
		problems.push("agent.command must be a non-empty string; agent disabled");
		return null;
	}
	const agent: AgentConfig = {
		command: command.trim(),
		args: [],
		env: {},
		leash: "open",
	};
	if (args !== undefined) {
		if (Array.isArray(args) && args.every((a) => typeof a === "string")) {
			agent.args = [...args];
		} else problems.push("agent.args must be an array of strings; using []");
	}
	if (env !== undefined) {
		if (
			isObject(env) &&
			Object.values(env).every((v) => typeof v === "string")
		) {
			agent.env = { ...(env as Record<string, string>) };
		} else problems.push("agent.env must be an object of strings; using {}");
	}
	if (leash !== undefined && leash !== "open") {
		problems.push(
			`agent.leash "${String(leash)}" is not available yet; using "open"`,
		);
	}
	return agent;
}

/**
 * The config, `$XDG_CONFIG_HOME/carbonless/config.json`. A missing file is
 * the defaults; a bad part (or a file that isn't JSON) is replaced by its
 * default and named in `problems`. Read anew each call: a hand edit counts.
 */
export async function readConfig(): Promise<ConfigRead> {
	const { raw, problem } = await readRaw();
	const read = validate(raw);
	if (problem) read.problems.unshift(problem);
	return read;
}

/** One update at a time in this process: each reads the last one's file. */
let updates: Promise<unknown> = Promise.resolve();

/**
 * Applies `change` to the config and writes it, atomically. Keys the file
 * has that carbonless doesn't know (top level, in `serve`, `refresh`,
 * `agent` and each view) are kept; parts that were bad are written valid;
 * no agent is written as `"agent": null`. Throws when `change` returns an
 * invalid config.
 */
export function updateConfig(
	change: (c: CrbConfig) => CrbConfig,
): Promise<CrbConfig> {
	const run = updates.then(async () => {
		const { raw } = await readRaw();
		const next = change(validate(raw).config);
		const checked = validate(next as unknown as Json);
		if (checked.problems.length > 0) {
			throw new Error(checked.problems.join("; "));
		}
		const c = checked.config;
		const keep = (v: unknown): Json => (isObject(v) ? v : {});
		// A view's unknown keys stay with that view: matched by its name as
		// read, never by its place (bad views are dropped, views move).
		const rawViews = (Array.isArray(raw?.views) ? raw.views : []).filter(
			isObject,
		);
		const unused = rawViews.map((v) => ({ v, name: viewName(v) }));
		const rawOf = (name: string): Json => {
			const i = unused.findIndex((u) => u.name === name);
			return i < 0 ? {} : (unused.splice(i, 1)[0]?.v ?? {});
		};
		const out = {
			...(raw ?? {}),
			serve: { ...keep(raw?.serve), ...c.serve },
			views: c.views.map((v) => ({ ...rawOf(v.name), ...v })),
			refresh: { ...keep(raw?.refresh), ...c.refresh },
			agent: c.agent === null ? null : { ...keep(raw?.agent), ...c.agent },
			updates: { ...keep(raw?.updates), ...c.updates },
		};
		await writeFileAtomic(configFile(), `${JSON.stringify(out, null, "\t")}\n`);
		return c;
	});
	updates = run.catch(() => {});
	return run;
}
