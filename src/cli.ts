#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runClient } from "./client.js";
import { tracer } from "./server/trace.js";
import { BUILD, formatVersion } from "./server/version.js";

const USAGE = `Usage: crb <pr> [options]
       crb serve [options]

crb <pr> prints the link to the pull request's review, served by this
machine's crb serve (started in the background when none is running).

Arguments:
  pr      https://github.com/<owner>/<repo>/pull/<n>, <owner>/<repo>#<n>,
          or <n> for a PR of the GitHub repository in the current directory

Options:
  --head <sha|reviewed>
               View the PR's changes up to this commit of it (reviewed: the
               one your last GitHub review was on, replies aside), in a
               review of its own
  --open       Also open it in the browser
  --version    Print crb's version
  -h, --help   Show this help

crb serve runs the server in the foreground, for every review. Host and
port default to config.json's serve (~/.config/carbonless; else
127.0.0.1:4747). Behind a proxy (e.g. tailscale serve for HTTPS), set
serve.publicUrl to the address it serves: links use it, and the access
key is required.

Serve options:
  --host <h>   Host to bind. Any other than 127.0.0.1, ::1 or localhost
               requires the access key, printed in the URL
  --port <n>   Port to listen on (0: any free port)
  --new-key    Replace the access key (old links stop working)
  --api-only   Serve only the API (used by the dev server)`;

const SERVE_ONLY = ["port", "host", "api-only", "new-key"] as const;
const CLIENT_ONLY = ["open", "head", "as-of", "viewer"] as const;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		allowNegative: true,
		options: {
			port: { type: "string" },
			host: { type: "string" },
			open: { type: "boolean", default: false },
			"api-only": { type: "boolean", default: false },
			"new-key": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
			version: { type: "boolean", default: false },
			head: { type: "string" },
			// Hidden dev flags, not in the usage: view the PR as of a past
			// moment, with another login as "you".
			"as-of": { type: "string" },
			viewer: { type: "string" },
		},
	});

	if (values.help) {
		console.log(USAGE);
		return;
	}
	if (values.version) {
		console.log(formatVersion(BUILD));
		return;
	}
	const [first, ...extra] = positionals;
	// Opt-in ($CRB_TRACE_DIR): this process's span, from its start to its exit.
	const traced = tracer(first === "serve" ? "crb" : "crb-client");
	traced.root(first === "serve" ? "crb serve" : "crb <pr>");
	if (first === "serve") {
		if (extra.length > 0) throw new Error("crb serve takes no arguments");
		for (const option of CLIENT_ONLY) {
			if (values[option] !== undefined && values[option] !== false) {
				throw new Error(`--${option} belongs to crb <pr>`);
			}
		}
		return serve(values);
	}
	if (!first || extra.length > 0) {
		throw new Error("Expected one PR argument. Run crb --help for usage");
	}
	for (const option of SERVE_ONLY) {
		if (values[option] !== undefined && values[option] !== false) {
			throw new Error(`--${option} belongs to crb serve`);
		}
	}
	const viewer = values.viewer;
	if (
		viewer !== undefined &&
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(viewer)
	) {
		throw new Error(`Invalid --viewer: ${viewer}`);
	}
	await runClient({
		pr: first,
		cwd: process.cwd(),
		head: values.head,
		asOf: values["as-of"],
		viewer,
		open: values.open,
	});
}

async function serve(values: {
	port?: string;
	host?: string;
	"api-only": boolean;
	"new-key": boolean;
}): Promise<void> {
	let port: number | undefined;
	if (values.port !== undefined) {
		port = Number(values.port);
		if (!/^\d+$/.test(values.port) || port > 65535) {
			throw new Error(`Invalid port: ${values.port}`);
		}
	}
	// Loaded here, not at the top: crb <pr> is only a client, and the server
	// (Fastify and all under it) costs it ~0.4 s of CPU to load.
	const [{ startServer }, { killDetachedGits }] = await Promise.all([
		import("./server/serve.js"),
		import("./server/git.js"),
	]);
	const server = await startServer({
		host: values.host,
		port,
		newKey: values["new-key"],
		webRoot: values["api-only"]
			? undefined
			: fileURLToPath(new URL("./web/", import.meta.url)),
		log: (message) => console.error(`crb: ${message}`),
	});

	let closing = false;
	const shutdown = async () => {
		// A second Ctrl-C means "now": don't wait for anything.
		if (closing) process.exit(1);
		closing = true;
		// Timed gits run in their own process groups: Ctrl-C missed them.
		killDetachedGits();
		try {
			await server.close();
			process.exit(0);
		} catch (error) {
			console.error(`crb: shutdown failed: ${(error as Error).message}`);
			process.exit(1);
		}
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Tests and agents parse this line to find the server.
	const key = server.key ? `?key=${server.key}` : "";
	const traced = tracer();
	if (traced.enabled) {
		traced
			.start("crb serve: listening", undefined, {
				startMs: performance.timeOrigin,
			})
			.end();
	}
	console.error(`carbonless listening on ${server.url}/${key}`);
	if (server.publicUrl)
		console.error(`carbonless open at ${server.publicUrl}/${key}`);
}

main().catch((error: unknown) => {
	console.error(
		`crb: ${error instanceof Error ? error.message : String(error)}`,
	);
	// Not process.exit(1): on Windows, exiting at once after a fetch with an
	// AbortSignal.timeout and a second one on the same connection aborts
	// Node (libuv assertion in src\win\async.c, exit 0xC0000409).
	process.exitCode = 1;
});
