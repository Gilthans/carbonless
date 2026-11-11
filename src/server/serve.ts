import { sweepStaleCheckouts } from "./agent/checkout.js";
import { setServerPort } from "./agent/host.js";
import { buildApp } from "./app.js";
import { readConfig, updateConfig } from "./config.js";
import { configAccess, HomeService } from "./home/homeService.js";
import { SessionRegistry } from "./registry.js";
import {
	accessKey,
	newKey,
	removeServerState,
	rotateAccessKey,
	writeServerState,
} from "./serverState.js";
import { TEST_HOOKS_ENV, testHookToken } from "./testHooks.js";
import { BUILD } from "./version.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface StartedServer {
	/** Where it listens: `http://<host>:<port>`, no key. */
	url: string;
	/**
	 * The access key its pages need (a bind beyond loopback, or a public
	 * URL), else null.
	 */
	key: string | null;
	/** Where people open it, when a proxy serves it (`serve.publicUrl`). */
	publicUrl: string | null;
	/** Closes every review and the listener, and removes server.json. */
	close(): Promise<void>;
}

/**
 * `crb serve`: one server for every review of this machine. Host and port
 * come from config.json unless given; any host but loopback, or a
 * `serve.publicUrl` (a proxy in front), needs the access key (kept in the
 * state dir; `newKey` rotates it). Writes
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
	const publicUrl = config.serve.publicUrl ?? null;
	if (publicUrl && port !== config.serve.port) {
		log(
			`serve.publicUrl is for port ${config.serve.port}; links from this server (port ${port}) may open another`,
		);
	}
	// A new key is kept only once this server listens: a failed start must
	// not change the key a running server checks.
	const fresh = opts.newKey ? newKey() : null;
	// A proxy reaches a loopback bind for anyone it serves: keyed too.
	const key = loopback && !publicUrl ? null : (fresh ?? (await accessKey()));

	// Agent checkouts left by servers that stopped (none is open here yet).
	await sweepStaleCheckouts(new Set()).catch(() => {});
	// Test-only routes, only with the harness's token (testHooks.ts).
	const hooksEnv = process.env[TEST_HOOKS_ENV];
	const testHooks = testHookToken(hooksEnv);
	if (hooksEnv && !testHooks) {
		log(`${TEST_HOOKS_ENV} is not a 32-hex token: test hooks off`);
	}
	const registry = new SessionRegistry();
	// Home reads GitHub only when its page asks (no timer to stop).
	const home = new HomeService({
		config: configAccess(readConfig, updateConfig),
	});
	let url = "";
	const app = await buildApp(registry, {
		home,
		accessKey: key,
		loopback,
		...(publicUrl ? { publicUrl } : {}),
		webRoot: opts.webRoot,
		baseUrl: () => publicUrl ?? url,
		progress: log,
		testHooks,
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
	setServerPort(actualPort);
	const urlHost = host.includes(":") ? `[${host}]` : host;
	url = `http://${urlHost}:${actualPort}`;
	await writeServerState({
		url,
		host,
		port: actualPort,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		version: BUILD,
		...(key ? { keyed: true } : {}),
		...(publicUrl ? { publicUrl } : {}),
	});

	let closed: Promise<void> | null = null;
	return {
		url,
		key,
		publicUrl,
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
