import { withdrawnReason } from "../../shared/update.js";
import { channelOf, isNewer } from "./semver.js";

/** carbonless's package on npm. */
export const PACKAGE = "carbonless-review";

/** The registry asked (`$CRB_NPM_REGISTRY`, else npm's). */
export const registryUrl = (env: NodeJS.ProcessEnv = process.env): string =>
	(env.CRB_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");

export const TIMEOUT_MS = 10_000;
/** The largest answer read. */
const MAX_ANSWER = 64 * 1024;
/** The longest version taken (it reaches the page and a command line). */
const MAX_VERSION = 64;

/** The body as text, or null past `max` bytes (read no further). */
export async function readCapped(
	res: Response,
	max: number,
): Promise<string | null> {
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
 * What a check learned: the version to offer, and whether the running one
 * is withdrawn (CAR-212).
 */
export interface RegistryAnswer {
	/** The newest good version to offer; null: none. */
	newer: string | null;
	/**
	 * The running version's withdrawal reason (withdrawnReason); null: not
	 * withdrawn (or not on npm); undefined: unknown this time (its request
	 * failed: the last check's answer stands).
	 */
	withdrawn: string | null | undefined;
	/** The versions asked about (candidates, `also`) that npm says are deprecated. */
	deprecated: string[];
}

/** The largest version manifest read (it carries the last ten notes). */
export const MAX_MANIFEST = 256 * 1024;

/**
 * npm's own accept: the abbreviated document where the registry has one.
 * (A version's document is the same either way; the e2e fake registry
 * tells a check's request from the notes' by it.)
 */
export const CHECK_ACCEPT =
	"application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

type VersionAnswer =
	| { kind: "found"; deprecated: unknown }
	| { kind: "missing" }
	| { kind: "failed" };

/**
 * One version's `deprecated` field, from its document on the registry
 * (`/<package>/<version>`: one version, not the whole packument). Never
 * throws: a failure is `failed`, a 404 `missing`.
 */
async function versionAnswer(
	version: string,
	opts: { registry: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<VersionAnswer> {
	const get = opts.fetch ?? fetch;
	try {
		const res = await get(
			`${opts.registry}/${PACKAGE}/${encodeURIComponent(version)}`,
			{
				headers: { accept: CHECK_ACCEPT },
				signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return res.status === 404 ? { kind: "missing" } : { kind: "failed" };
		}
		const text = await readCapped(res, MAX_MANIFEST);
		if (text === null) return { kind: "failed" };
		const doc = JSON.parse(text) as unknown;
		if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
			return { kind: "failed" };
		}
		return {
			kind: "found",
			deprecated: (doc as Record<string, unknown>).deprecated,
		};
	} catch {
		return { kind: "failed" };
	}
}

/** npm shows a version as deprecated: a non-empty message (anything else: not). */
const isDeprecated = (deprecated: unknown): boolean =>
	typeof deprecated === "string" && deprecated !== "";

/**
 * The version on the channel (`rc` for a prerelease, else `latest`, unless
 * `channel` says) when it is strictly newer; on `rc`, `latest` too when it
 * is newer still; never a deprecated one (CAR-212): the newest candidate
 * npm doesn't say is deprecated, and none whose own request failed. Also
 * whether the running version is withdrawn, and which of `also` (an
 * earlier offer) is deprecated now. Throws a RegistryError when the
 * dist-tags can't be read (offline, 404 before the first publish, a bad
 * answer); a version's own request failing never throws.
 */
export async function checkRegistry(
	current: string,
	opts: {
		registry: string;
		/** The dist-tag to follow; default: the running version's (channelOf). */
		channel?: "rc" | "latest";
		/** More versions to ask whether they are deprecated (an earlier offer). */
		also?: readonly string[];
		fetch?: typeof fetch;
		timeoutMs?: number;
	},
): Promise<RegistryAnswer> {
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
	const tagged = channel === "rc" ? [t.rc, t.latest] : [t.latest];
	const candidates = [
		...new Set(
			tagged.filter(
				(v): v is string =>
					typeof v === "string" &&
					v.length <= MAX_VERSION &&
					isNewer(v, current),
			),
		),
	].sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
	const also = (opts.also ?? []).filter(
		(v) => v.length <= MAX_VERSION && !candidates.includes(v),
	);
	// Each version once, all at once: the running one, the candidates, `also`.
	const asked = [current, ...candidates, ...also];
	const answers = await Promise.all(asked.map((v) => versionAnswer(v, opts)));
	const answerOf = new Map(asked.map((v, i) => [v, answers[i]]));
	const own = answerOf.get(current);
	const withdrawn =
		own?.kind === "found"
			? withdrawnReason(own.deprecated)
			: own?.kind === "missing"
				? null
				: undefined;
	const deprecated = [...candidates, ...also].filter((v) => {
		const a = answerOf.get(v);
		return a?.kind === "found" && isDeprecated(a.deprecated);
	});
	// A candidate whose request failed is not offered this time.
	const newer =
		candidates.find(
			(v) => answerOf.get(v)?.kind === "found" && !deprecated.includes(v),
		) ?? null;
	return { newer, withdrawn, deprecated };
}

/** checkRegistry's offer, null on any failure: a check that never shows an error. */
export const newerOnRegistry = (
	current: string,
	opts: Parameters<typeof checkRegistry>[1],
): Promise<string | null> =>
	checkRegistry(current, opts).then(
		(a) => a.newer,
		() => null,
	);
