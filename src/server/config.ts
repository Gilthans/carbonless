import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
	serve: { host: string; port: number };
	views: ViewConfig[];
	refresh: { minutes: number };
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
}) as CrbConfig;

const DEFAULT_VIEW = "My PRs";
const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

const configFile = () => join(configDir(), "config.json");

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === "object" && v !== null && !Array.isArray(v);

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
			const { host, port } = raw.serve;
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
				const name =
					typeof view.name === "string" && view.name.trim()
						? view.name.trim()
						: DEFAULT_VIEW;
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
	return { config: { serve, views, refresh }, problems };
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
 * has that carbonless doesn't know (top level, in `serve`, `refresh` and
 * each view) are kept; parts that were bad are written valid. Throws when
 * `change` returns an invalid config.
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
		const rawViews = Array.isArray(raw?.views) ? raw.views : [];
		const out = {
			...(raw ?? {}),
			serve: { ...keep(raw?.serve), ...c.serve },
			views: c.views.map((v, i) => ({ ...keep(rawViews[i]), ...v })),
			refresh: { ...keep(raw?.refresh), ...c.refresh },
		};
		await writeFileAtomic(configFile(), `${JSON.stringify(out, null, "\t")}\n`);
		return c;
	});
	updates = run.catch(() => {});
	return run;
}
