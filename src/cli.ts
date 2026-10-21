#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { buildApp } from "./server/app.js";
import { getCommit, resolveRepoRoot } from "./server/git.js";

const USAGE = `Usage: carbonless [repo] [base] [head] [options]

Compare two commits of a git repository in the browser.

Arguments:
  repo    Path inside a git repository (default: current directory)
  base    Older commit or ref (default: HEAD~1)
  head    Newer commit or ref (default: HEAD)

Options:
  --port <n>   Port to listen on (default: random free port)
  --host <h>   Host to bind (default: 127.0.0.1)
  --no-open    Do not open the browser
  --api-only   Serve only the API (used by the dev server)
  -h, --help   Show this help`;

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
		},
	});

	if (values.help) {
		console.log(USAGE);
		return;
	}

	const [repoArg = ".", base = "HEAD~1", head = "HEAD"] = positionals;
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`Invalid port: ${values.port}`);
	}

	const repoPath = await resolveRepoRoot(repoArg);
	// Fail fast on bad refs instead of serving a page that only shows an error.
	await Promise.all([getCommit(repoPath, base), getCommit(repoPath, head)]);

	const app = await buildApp({
		repoPath,
		base,
		head,
		webRoot: values["api-only"]
			? undefined
			: fileURLToPath(new URL("./web/", import.meta.url)),
	});
	await app.listen({ port, host: values.host });

	const address = app.server.address();
	const actualPort =
		typeof address === "object" && address ? address.port : port;
	const url = `http://${values.host}:${actualPort}/`;
	// Tests and agents parse this line to find the server.
	console.log(`carbonless listening on ${url}`);

	if (values.open) {
		await open(url);
	}

	const shutdown = async () => {
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	console.error(
		`carbonless: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
