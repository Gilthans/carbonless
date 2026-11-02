import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * `$<variable>`, or `~/<fallback>` when it's unset, empty or relative: the
 * XDG spec says relative values are invalid and must be ignored.
 */
function xdg(variable: string, fallback: string): string {
	const value = process.env[variable];
	const base = value && isAbsolute(value) ? value : join(homedir(), fallback);
	return join(base, "carbonless");
}

/** The machine's config (config.json): `$XDG_CONFIG_HOME/carbonless`. */
export const configDir = (): string => xdg("XDG_CONFIG_HOME", ".config");

/** The running server's files (server.json, key, serve.log): `$XDG_STATE_HOME/carbonless`. */
export const stateDir = (): string =>
	xdg("XDG_STATE_HOME", join(".local", "state"));

/** carbonless's own clones (repos/<owner>/<repo>.git): `$XDG_CACHE_HOME/carbonless`. */
export const cacheDir = (): string => xdg("XDG_CACHE_HOME", ".cache");
