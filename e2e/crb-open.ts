import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAsOf } from "../src/server/asOf";
import { parsePrArg } from "../src/server/gh";
import { parseHead } from "../src/server/pinnedHead";
import type { ServerState } from "../src/server/serverState";
import { VERSION_HEADER } from "../src/server/version";
import { type Served, START_TIMEOUT_MS } from "./crb-process";
import { crbEnv } from "./pr-setup";

/*
 * `crb <pr>` without the client process (CAR-106): the harness POSTs
 * /api/reviews to the test's own crb serve, as runClient (src/client.ts)
 * does: the same body, the server's build in the version header, the key's
 * cookie when the server is keyed. It answers like runCli: an exit code,
 * stdout (the URL) and the client's output (`crb: <error>` on a failure).
 *
 * What only the client does (resolving a bare PR number, checking flags,
 * finding or starting a server, --open, --help) it refuses loudly: a test
 * about those uses `test.use({ crbClient: "cli" })`.
 */

/** Which `crb <pr>` startCrb runs: a POST of its own, or the built CLI. */
export type CrbClient = "http" | "cli";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** The client flags this path sends as the client would, each with a value. */
const FLAGS: Record<string, "head" | "asOf" | "viewer"> = {
	"--head": "head",
	"--as-of": "asOf",
	"--viewer": "viewer",
};

/** The HTTP path can't do this as the CLI would: the test needs the CLI. */
export class NeedsCliError extends Error {
	constructor(what: string) {
		super(
			`startCrb over HTTP can't ${what} as crb <pr> would: test.use({ crbClient: "cli" })`,
		);
	}
}

/** `args` as runClient's request, or NeedsCliError for what only the CLI does. */
export function clientRequest(
	arg: string,
	args: string[],
): { pr: string; head?: string; asOf?: string; viewer?: string } {
	// The client's grammar (prForServer): owner/repo#n and URLs go to the
	// server as given; a bare number it resolves through the git remote.
	let parsed: ReturnType<typeof parsePrArg>;
	try {
		parsed = parsePrArg(arg);
	} catch {
		throw new NeedsCliError(`check the PR argument "${arg}"`);
	}
	if (!("owner" in parsed)) {
		throw new NeedsCliError(`resolve the PR argument "${arg}"`);
	}
	const req: { pr: string; head?: string; asOf?: string; viewer?: string } = {
		pr: arg,
	};
	for (let i = 0; i < args.length; i++) {
		const flag = args[i] as string;
		const key = FLAGS[flag];
		const value = args[i + 1];
		if (!key || value === undefined || value.startsWith("--")) {
			throw new NeedsCliError(`take ${flag}${key ? " without a value" : ""}`);
		}
		if (req[key] !== undefined) throw new NeedsCliError(`repeat ${flag}`);
		req[key] = value;
		i++;
	}
	// The client's checks (src/main.ts, runClient): their errors are the
	// client's, so a test of them runs the CLI.
	if (req.head !== undefined) {
		try {
			parseHead(req.head);
		} catch {
			throw new NeedsCliError(`check --head ${req.head}`);
		}
	}
	if (req.asOf !== undefined) {
		try {
			req.asOf = parseAsOf(req.asOf);
		} catch {
			throw new NeedsCliError(`check --as-of ${req.asOf}`);
		}
	}
	if (req.head !== undefined && req.asOf !== undefined)
		throw new NeedsCliError("combine --head with --as-of");
	if (
		req.viewer !== undefined &&
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(req.viewer)
	)
		throw new NeedsCliError(`check --viewer ${req.viewer}`);
	return req;
}

/** The server.json `served` wrote: its address, build and whether it's keyed. */
function stateOf(served: Served, workdir: string): ServerState {
	const env = crbEnv(workdir);
	const file = join(env.XDG_STATE_HOME as string, "carbonless", "server.json");
	const state = JSON.parse(readFileSync(file, "utf8")) as ServerState;
	if (state.pid !== served.child.pid) {
		throw new Error(
			`${file} names pid ${state.pid}, not the test's crb serve (${served.child.pid})`,
		);
	}
	return state;
}

/**
 * Opens `arg`'s review on `served` over HTTP, answering as runCli would:
 * code 0 and the URL on stdout, or code 1 and `crb: <why>`.
 */
export async function openOverHttp(
	served: Served,
	workdir: string,
	arg: string,
	args: string[],
): Promise<{ code: number | null; stdout: string; output: string }> {
	const req = clientRequest(arg, args);
	const state = stateOf(served, workdir);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		[VERSION_HEADER]: JSON.stringify(state.version),
	};
	if (!LOOPBACK.has(state.host) || state.keyed) {
		const key = new URL(served.url).searchParams.get("key");
		if (!key)
			throw new Error(`crb serve is keyed but printed no key: ${served.url}`);
		headers.cookie = `crb_key_${state.port}=${key}`;
	}
	const failed = (message: string) => ({
		code: 1,
		stdout: "",
		output: `crb: ${message}\n`,
	});
	// runCli's bound: a hung open fails as a failed one, with the server's log.
	const signal = AbortSignal.timeout(START_TIMEOUT_MS);
	let res: Response;
	let body: { url?: unknown; error?: unknown };
	try {
		res = await fetch(`${state.url}/api/reviews`, {
			method: "POST",
			headers,
			body: JSON.stringify(req),
			signal,
		});
		body = (await res.json().catch((error: unknown) => {
			if (signal.aborted) throw error;
			return {};
		})) as typeof body;
	} catch (error) {
		return failed(
			signal.aborted
				? `crb serve did not answer the open in ${START_TIMEOUT_MS / 1000} s`
				: `Could not reach crb serve at ${state.url}: ${(error as Error).message}`,
		);
	}
	if (!res.ok || typeof body.url !== "string") {
		return failed(
			typeof body.error === "string"
				? body.error
				: `crb serve answered ${res.status}`,
		);
	}
	return { code: 0, stdout: `${body.url}\n`, output: `${body.url}\n` };
}
