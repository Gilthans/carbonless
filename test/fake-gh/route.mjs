// The fake gh's router (CAR-106): one `crb serve` shared by a Playwright
// worker's tests has one environment, so $CRB_FAKE_GH can't name each test's
// scenario. It names a router file instead, which the harness rewrites as
// tests start and end:
//
//   { "router": 1,
//     "current": { "test": "<title>", "scenario": "<path>", "log": "<path>",
//                  "repos": ["acme/widget-1-3"] },
//     "finished": { "acme/widget-1-2": "<title>" },
//     "strays": "<path>" }                       (optional)
//
// Each call goes by its repository (repoOf): the current test's repos (and
// a call naming none: auth status, api user) to the current scenario and
// log; any other repo, a finished test's above all, is a stray: exit 1, a
// line in the stray log ("strays", else $CRB_FAKE_GH_LOG). A stray is never
// answered from the wrong scenario. Relative paths in the router are against
// its directory. A plain scenario file goes on as before.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** `-R`/`--repo`'s value among `args` before a `--`; undefined without one. */
function repoFlag(args) {
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--") return undefined;
		if (args[i] === "-R" || args[i] === "--repo") return args[i + 1];
	}
	return undefined;
}

/** `-f`/`-F key=value` fields of a `gh api` call. */
function apiFields(args) {
	const out = {};
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] !== "-f" && args[i] !== "-F") continue;
		const [key, ...rest] = args[i + 1].split("=");
		out[key] = rest.join("=");
	}
	return out;
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;
const REST = /^repos\/([^/]+)\/([^/?]+)(?:[/?]|$)/;
const INLINE =
	/\brepository\(owner: ("(?:[^"\\]|\\.)*"), name: ("(?:[^"\\]|\\.)*")\)/g;

/**
 * The repositories a gh call is about, as gh.mjs answers it:
 * `{ kind: "repos", repos }` (owner/repo, lowercased), `{ kind: "none" }`
 * for a call about no one repo (the account, a node by id, the cwd's
 * remote), or `{ kind: "unknown" }` for a form this doesn't know: a router
 * treats that as a stray, so a new form in gh.mjs fails loudly until it is
 * classified here (route.test.ts checks every form gh.mjs supports).
 */
export function repoOf(args) {
	const repos = (list) => ({
		kind: "repos",
		repos: [...new Set(list.map((r) => r.toLowerCase()))],
	});
	const [a0, a1] = args;
	const cmd = `${a0} ${a1}`;
	if (cmd === "auth status") return { kind: "none" };
	if (cmd === "api user" && args.length === 2) return { kind: "none" };
	// `repo view --json nameWithOwner`: the cwd's remote, which is the
	// scenario's nameWithOwner.
	if (cmd === "repo view") return { kind: "none" };
	if (cmd === "repo clone") {
		return SLUG.test(args[2] ?? "") ? repos([args[2]]) : { kind: "unknown" };
	}
	if (cmd === "pr view" || cmd === "search prs") {
		const r = repoFlag(args);
		return r && SLUG.test(r) ? repos([r]) : { kind: "unknown" };
	}
	if (cmd === "api graphql") {
		const f = apiFields(args);
		const query = f.query ?? "";
		const found = [];
		if (f.owner !== undefined || f.name !== undefined) {
			if (!f.owner || !f.name) return { kind: "unknown" };
			found.push(`${f.owner}/${f.name}`);
		} else if (/\$owner\b|\$name\b|\$number\b/.test(query)) {
			// A query over a repo's variables, called without them.
			return { kind: "unknown" };
		}
		for (const m of query.matchAll(INLINE)) {
			found.push(`${JSON.parse(m[1])}/${JSON.parse(m[2])}`);
		}
		return found.length ? repos(found) : { kind: "none" };
	}
	if (a0 === "api") {
		const path = a1 === "-X" ? args[3] : a1;
		const m = REST.exec(path ?? "");
		return m ? repos([`${m[1]}/${m[2]}`]) : { kind: "unknown" };
	}
	return { kind: "unknown" };
}

/** Whether `value` is a router file's content. */
export const isRouter = (value) =>
	value !== null && typeof value === "object" && value.router === 1;

/**
 * Where a call reads its scenario: the file at `path` ($CRB_FAKE_GH, already
 * resolved) when it is a scenario, else the router's choice for `args`.
 * Returns `{ scenarioPath, text, logPath }` (`text` the scenario as read,
 * `logPath` the call log or undefined), or `{ stray }`, the message of a
 * call no test's scenario may answer (written to the stray log here).
 */
export function routeCall(path, args, env) {
	const text = readFileSync(path, "utf8");
	let router;
	try {
		router = JSON.parse(text);
	} catch {
		// Not JSON: gh.mjs's own parse says so, as before.
		return { scenarioPath: path, text, logPath: env.CRB_FAKE_GH_LOG };
	}
	if (!isRouter(router)) {
		return { scenarioPath: path, text, logPath: env.CRB_FAKE_GH_LOG };
	}
	const at = (p) => resolve(dirname(path), p);
	const call = repoOf(args);
	const stray = (repo, why) => {
		const message = `fake gh: stray call for ${repo} (${why}): gh ${args.join(" ")}`;
		const log = router.strays ? at(router.strays) : env.CRB_FAKE_GH_LOG;
		if (log) appendFileSync(log, `${message.replaceAll("\n", " ")}\n`);
		return { stray: message };
	};
	const named = call.kind === "repos" ? call.repos : [];
	if (call.kind === "unknown")
		return stray("?", "a call the router can't place");
	const current = router.current;
	if (!current?.scenario) {
		return stray(named.join(", ") || "no repo", "no test running");
	}
	const scenarioPath = at(current.scenario);
	const scenarioText = readFileSync(scenarioPath, "utf8");
	if (named.length > 0) {
		const owned = ownedRepos(current, scenarioText);
		const finished = new Map(
			Object.entries(router.finished ?? {}).map(([k, v]) => [
				k.toLowerCase(),
				v,
			]),
		);
		for (const repo of named) {
			if (owned.has(repo)) continue;
			const test = finished.get(repo);
			return stray(
				repo,
				test === undefined ? "no test's repo" : `test '${test}', finished`,
			);
		}
	}
	return {
		scenarioPath,
		text: scenarioText,
		logPath: current.log ? at(current.log) : undefined,
	};
}

/**
 * The current test's repos, lowercased: the router's list, and its
 * scenario's nameWithOwner, `repos` and `viewerRepos`.
 */
function ownedRepos(current, scenarioText) {
	const out = new Set((current.repos ?? []).map((r) => r.toLowerCase()));
	let s;
	try {
		s = JSON.parse(scenarioText);
	} catch {
		return out;
	}
	if (s.nameWithOwner) out.add(s.nameWithOwner.toLowerCase());
	for (const k of Object.keys(s.repos ?? {})) out.add(k.toLowerCase());
	for (const r of s.viewerRepos ?? []) {
		if (typeof r?.name === "string") out.add(r.name.toLowerCase());
	}
	return out;
}
