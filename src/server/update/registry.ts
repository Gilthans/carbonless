import { channelOf, isNewer } from "./semver.js";

/** carbonless's package on npm. */
export const PACKAGE = "carbonless-review";

/** The registry asked (`$CRB_NPM_REGISTRY`, else npm's). */
export const registryUrl = (env: NodeJS.ProcessEnv = process.env): string =>
	(env.CRB_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");

const TIMEOUT_MS = 10_000;

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
		const tags = (await res.json()) as unknown;
		if (typeof tags !== "object" || tags === null) return null;
		const offered = (tags as Record<string, unknown>)[
			opts.channel ?? channelOf(current)
		];
		return typeof offered === "string" && isNewer(offered, current)
			? offered
			: null;
	} catch {
		return null;
	}
}
