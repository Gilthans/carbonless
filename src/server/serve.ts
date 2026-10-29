import { buildApp } from "./app.js";
import { readConfig } from "./config.js";
import { SessionRegistry } from "./registry.js";
import {
	accessKey,
	newKey,
	removeServerState,
	rotateAccessKey,
	writeServerState,
} from "./serverState.js";
import { BUILD } from "./version.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface StartedServer {
	/** Where it listens: `http://<host>:<port>`, no key. */
	url: string;
	/** The access key its pages need (a bind beyond loopback), else null. */
	key: string | null;
	/** Closes every review and the listener, and removes server.json. */
	close(): Promise<void>;
}

/**
 * `crb serve`: one server for every review of this machine. Host and port
 * come from config.json unless given; any host but loopback needs the
 * access key (kept in the state dir; `newKey` rotates it). Writes
 * server.json once listening, so a failed bind leaves another's alone.
 */
export async function startServer(opts: {
	host?: string;
	port?: number;
	webRoot?: string;
	newKey?: boolean;
	/** Startup steps and config problems (crb serve: stderr). */
	log?: (message: string) => void;
}): Promise<StartedServer> {
	const log = opts.log ?? (() => {});
	const { config, problems } = await readConfig();
	for (const problem of problems) log(`config: ${problem}`);
	const host = opts.host ?? config.serve.host;
	const port = opts.port ?? config.serve.port;
	const loopback = LOOPBACK.has(host);
	// A new key is kept only once this server listens: a failed start must
	// not change the key a running server checks.
	const fresh = opts.newKey ? newKey() : null;
	const key = loopback ? null : (fresh ?? (await accessKey()));

	const registry = new SessionRegistry();
	let url = "";
	const app = await buildApp(registry, {
		accessKey: key,
		webRoot: opts.webRoot,
		baseUrl: () => url,
		progress: log,
	});
	try {
		await app.listen({ port, host });
	} catch (error) {
		await registry.closeAll();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			throw new Error(`Port ${port} on ${host} is already in use`);
		}
		throw error;
	}
	if (fresh) await rotateAccessKey(fresh);
	const address = app.server.address();
	const actualPort =
		typeof address === "object" && address ? address.port : port;
	const urlHost = host.includes(":") ? `[${host}]` : host;
	url = `http://${urlHost}:${actualPort}`;
	await writeServerState({
		url,
		host,
		port: actualPort,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		version: BUILD,
	});

	let closed: Promise<void> | null = null;
	return {
		url,
		key,
		close: () => {
			closed ??= (async () => {
				await removeServerState();
				await app.close();
				// Their background reads of GitHub and the clones stop with them.
				await registry.closeAll();
			})();
			return closed;
		},
	};
}
