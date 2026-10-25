#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { buildApp } from "./server/app.js";
import { parseAsOf } from "./server/asOf.js";
import { Session } from "./server/session.js";

const USAGE = `Usage: crb <pr> [options]

Review a GitHub pull request in the browser.

Arguments:
  pr      https://github.com/<owner>/<repo>/pull/<n>, <owner>/<repo>#<n>,
          or <n> for a PR of the GitHub repository in the current directory

Options:
  --port <n>   Port to listen on (default: random free port)
  --host <h>   Host to bind (default: 127.0.0.1). Any other than 127.0.0.1,
               ::1 or localhost requires a random access key, printed in the URL
  --no-open    Do not open the browser
  --api-only   Serve only the API (used by the dev server)
  -h, --help   Show this help`;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		allowNegative: true,
		options: {
			port: { type: "string", default: "0" },
			host: { type: "string", default: "127.0.0.1" },
			open: { type: "boolean", default: true },
			"api-only": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
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
	const [pr, ...extra] = positionals;
	if (!pr || extra.length > 0) {
		throw new Error("Expected one PR argument. Run crb --help for usage");
	}
	const port = Number(values.port);
	if (!/^\d+$/.test(values.port) || port > 65535) {
		throw new Error(`Invalid port: ${values.port}`);
	}
	const asOf =
		values["as-of"] === undefined ? undefined : parseAsOf(values["as-of"]);
	const viewer = values.viewer;
	if (
		viewer !== undefined &&
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(viewer)
	) {
		throw new Error(`Invalid --viewer: ${viewer}`);
	}
	const host = values.host;
	const accessKey = LOOPBACK.has(host)
		? null
		: randomBytes(24).toString("base64url");

	// Progress goes to stderr: stdout's only line is the listening URL.
	const session = await Session.open(
		pr,
		process.cwd(),
		(message) => console.error(`crb: ${message}`),
		{ asOf, viewer },
	);
	// The overview's GitHub reads take seconds: start them while the
	// browser opens. A failure isn't kept; the page's own read reports it.
	session.overview().catch(() => {});
	const app = await buildApp(session, {
		accessKey,
		webRoot: values["api-only"]
			? undefined
			: fileURLToPath(new URL("./web/", import.meta.url)),
	});
	try {
		await app.listen({ port, host });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			throw new Error(`Port ${port} on ${host} is already in use`);
		}
		throw error;
	}

	// Before printing the URL: whoever reads it may signal us right away.
	let closing = false;
	const shutdown = async () => {
		// A second Ctrl-C means "now": don't wait for anything.
		if (closing) process.exit(1);
		closing = true;
		try {
			await app.close();
			process.exit(0);
		} catch (error) {
			console.error(`crb: shutdown failed: ${(error as Error).message}`);
			process.exit(1);
		}
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	const address = app.server.address();
	const actualPort =
		typeof address === "object" && address ? address.port : port;
	const urlHost = host.includes(":") ? `[${host}]` : host;
	const url = `http://${urlHost}:${actualPort}/${accessKey ? `?key=${accessKey}` : ""}`;
	// Tests and agents parse this line to find the server.
	console.log(`carbonless listening on ${url}`);

	if (values.open) {
		await open(url).catch((error: unknown) => {
			console.error(`crb: could not open the browser: ${String(error)}`);
		});
	}
}

main().catch((error: unknown) => {
	console.error(
		`crb: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
