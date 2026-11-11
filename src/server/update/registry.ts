import { channelOf, isNewer } from "./semver.js";

/** carbonless's package on npm. */
export const PACKAGE = "carbonless-review";

/** The registry asked (`$CRB_NPM_REGISTRY`, else npm's). */
export const registryUrl = (env: NodeJS.ProcessEnv = process.env): string =>
	(env.CRB_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");

const TIMEOUT_MS = 10_000;
/** The largest answer read. */
const MAX_ANSWER = 64 * 1024;
/** The longest version taken (it reaches the page and a command line). */
const MAX_VERSION = 64;

/**
 * The version on the running version's channel (`rc` for a prerelease,
 * else `latest`) when it is strictly newer; null when it isn't, and on any
 * failure (offline, 404 before the first publish, a bad answer): a check
 * never shows an error and never blocks anything.
 */
export async function newerOnRegistry(
	current: string,
	opts: {
		registry: string;
		/** The dist-tag to follow; default: the running version's (channelOf). */
		channel?: "rc" | "latest";
		fetch?: typeof fetch;
		timeoutMs?: number;
	},
): Promise<string | null> {
	const get = opts.fetch ?? fetch;
	try {
		const res = await get(`${opts.registry}/-/package/${PACKAGE}/dist-tags`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
		});
		if (!res.ok) return null;
		// dist-tags are a few names and versions: anything big is not one.
		if (Number(res.headers.get("content-length") ?? 0) > MAX_ANSWER) {
			return null;
		}
		const text = await res.text();
		if (text.length > MAX_ANSWER) return null;
		const tags = JSON.parse(text) as unknown;
		if (typeof tags !== "object" || tags === null) return null;
		const offered = (tags as Record<string, unknown>)[
			opts.channel ?? channelOf(current)
		];
		return typeof offered === "string" &&
			offered.length <= MAX_VERSION &&
			isNewer(offered, current)
			? offered
			: null;
	} catch {
		return null;
	}
}
