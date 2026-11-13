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

/** The body as text, or null past `max` bytes (read no further). */
async function readCapped(res: Response, max: number): Promise<string | null> {
	if (Number(res.headers.get("content-length") ?? 0) > max) {
		await res.body?.cancel().catch(() => {});
		return null;
	}
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Why a check of the registry failed (short: the Global settings page shows it). */
export class RegistryError extends Error {}

/**
 * The version on the channel (`rc` for a prerelease, else `latest`, unless
 * `channel` says) when it is strictly newer; on `rc`, `latest` too when it
 * is newer still. Null when none is. Throws a RegistryError on any failure
 * (offline, 404 before the first publish, a bad answer).
 */
export async function checkRegistry(
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
	let res: Response;
	try {
		res = await get(`${opts.registry}/-/package/${PACKAGE}/dist-tags`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
		});
	} catch (error) {
		throw new RegistryError(
			(error as Error)?.name === "TimeoutError"
				? "Registry timed out"
				: "Registry unreachable",
		);
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new RegistryError(`Registry answered ${res.status}`);
	}
	// dist-tags are a few names and versions: anything big is not one.
	let tags: unknown;
	try {
		const text = await readCapped(res, MAX_ANSWER);
		if (text === null) throw new Error("too big");
		tags = JSON.parse(text);
	} catch {
		throw new RegistryError("Registry gave a bad answer");
	}
	if (typeof tags !== "object" || tags === null) {
		throw new RegistryError("Registry gave a bad answer");
	}
	const t = tags as Record<string, unknown>;
	const channel = opts.channel ?? channelOf(current);
	// rc also takes latest when it is newer (a fix released without
	// moving rc): the reviewer stays on rc, and misses nothing.
	const candidates = channel === "rc" ? [t.rc, t.latest] : [t.latest];
	let best: string | null = null;
	for (const v of candidates) {
		if (
			typeof v === "string" &&
			v.length <= MAX_VERSION &&
			isNewer(v, current) &&
			(best === null || isNewer(v, best))
		) {
			best = v;
		}
	}
	return best;
}

/** checkRegistry, null on any failure: a check that never shows an error. */
export const newerOnRegistry = (
	current: string,
	opts: Parameters<typeof checkRegistry>[1],
): Promise<string | null> => checkRegistry(current, opts).catch(() => null);
