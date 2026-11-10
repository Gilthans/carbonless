import { existsSync } from "node:fs";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { JOIN } from "../../shared/agent.js";
import { agentsDir } from "../agent/checkout.js";
import { agentConfig } from "../agent/host.js";
import type { HomeService } from "../home/homeService.js";
import { StartedReviews } from "../home/started.js";
import { type SessionRegistry, UnknownReviewError } from "../registry.js";
import type { Session } from "../session.js";
import { slugify } from "../slug.js";
import {
	type JoinableDeps,
	type JoinableReview,
	listJoinable,
} from "./reviews.js";
import { createMcpServer, type McpRequestContext } from "./server.js";
import { isSafeOrigin, parseSessionToken, REVIEW_ID } from "./watch.js";

/**
 * `/mcp`: crb's MCP server over Streamable HTTP, stateless (a crb restart
 * needs no re-initialise), behind the access key and Host/Origin checks
 * like every route. `/mcp/watch/<review>`: a joined session's watcher, a
 * held GET that is its keep-alive.
 */

export interface McpRouteDeps {
	registry: SessionRegistry;
	reviews(origin: string, query?: string): Promise<JoinableReview[]>;
	/** The key the watcher's URL carries (the server's own); null: keyless. */
	accessKey: string | null;
	/** A proxy's origin in front (config `serve.publicUrl`). */
	publicUrl?: string;
	/** This server's address, when the request's Host can't be used. */
	baseUrl(): string;
	/** The watcher's keep-alive period (tests). */
	keepAliveMs?: number;
}

/** This server as the request reached it: a proxy's origin, the Host, else baseUrl. */
export function originOf(
	request: Pick<FastifyRequest, "headers">,
	deps: Pick<McpRouteDeps, "publicUrl" | "baseUrl">,
): string {
	const host = request.headers.host ?? "";
	if (deps.publicUrl) {
		const pub = new URL(deps.publicUrl);
		if (host.toLowerCase() === pub.host.toLowerCase()) return pub.origin;
	}
	const origin = `http://${host}`;
	return isSafeOrigin(origin) ? origin : deps.baseUrl();
}

/** Fastify's headers set so far (the security headers), on a hijacked reply. */
function carryHeaders(reply: FastifyReply): void {
	for (const [name, value] of Object.entries(reply.getHeaders())) {
		if (value !== undefined) reply.raw.setHeader(name, value as string);
	}
}

export function registerMcp(app: FastifyInstance, deps: McpRouteDeps): void {
	app.post("/mcp", async (request, reply) => {
		const ctx: McpRequestContext = {
			origin: originOf(request, deps),
			key: deps.accessKey,
			remote: request.ip,
		};
		const server = createMcpServer(deps, ctx);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		reply.hijack();
		carryHeaders(reply);
		reply.raw.on("close", () => {
			void transport.close().catch(() => {});
			void server.close().catch(() => {});
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(request.raw, reply.raw, request.body);
		} catch (error) {
			console.error(error);
			if (!reply.raw.headersSent) {
				reply.raw.writeHead(500, { "content-type": "application/json" });
				reply.raw.end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal server error" },
						id: null,
					}),
				);
			}
		}
	});
	// Stateless: no server-sent stream to open, no session to end.
	const noStream = async (_request: FastifyRequest, reply: FastifyReply) =>
		reply
			.code(405)
			.header("allow", "POST")
			.send({ error: "Method not allowed" });
	app.get("/mcp", noStream);
	app.delete("/mcp", noStream);

	app.get<{ Params: { review: string } }>(
		"/mcp/watch/:review",
		async (request, reply) => {
			const id = request.params.review;
			if (!REVIEW_ID.test(id)) {
				return reply.code(404).send({ error: "Not a review id" });
			}
			const bearer = /^Bearer (\S+)$/.exec(
				request.headers.authorization ?? "",
			)?.[1];
			const token = parseSessionToken(bearer);
			if (!token || token.id !== id) {
				return reply
					.code(401)
					.send({ error: "Expected Authorization: Bearer <token>" });
			}
			let session: Session;
			try {
				session = await deps.registry.get(id);
			} catch (error) {
				if (error instanceof UnknownReviewError) {
					return reply.code(410).send({ error: "No such review" });
				}
				// The review can't open right now: the watcher retries.
				return reply.code(503).send({ error: (error as Error).message });
			}
			const host = session.agent;
			const lease = host ? await host.sessionWatch(token.secret) : null;
			if (!host || !lease) {
				return reply
					.code(410)
					.send({ error: "Not joined to this review: call attach again" });
			}
			const m = session.prMeta();
			const pr = `${m.owner}/${m.repo}#${m.number}`;
			reply.hijack();
			carryHeaders(reply);
			const res = reply.raw;
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"x-accel-buffering": "no",
			});
			res.flushHeaders();
			let done = false;
			const keepAlive = setInterval(
				() => res.write("\n"),
				deps.keepAliveMs ?? JOIN.keepAliveMs,
			);
			const finish = (line: string | null) => {
				if (done) return;
				done = true;
				clearInterval(keepAlive);
				if (line === null) res.destroy();
				else res.end(`${line}\n`);
			};
			res.on("close", () => {
				done = true;
				clearInterval(keepAlive);
				lease.close();
			});
			// Gone while the review opened: no 'close' is coming.
			if (request.socket.destroyed) {
				done = true;
				clearInterval(keepAlive);
				lease.close();
				return;
			}
			void lease.deliver.then(() =>
				finish(
					`carbonless: a question is waiting on ${pr}. Call crb's next tool, answer with reply, then run this watch command again.`,
				),
			);
			void lease.ended.then((how) => {
				if (how === "closed") return finish(null);
				if (how === "replaced") {
					return finish(
						"carbonless: a newer watcher took over for this session; don't run this one again.",
					);
				}
				const why = host.join.view().left?.why ?? "detached";
				finish(
					`carbonless: you are no longer joined to ${pr} (${why}); don't run this watch again. Call attach if the reviewer asks you to join again.`,
				);
			});
		},
	);
}

/** listJoinable's sources on a running server: the registry, the clones, Home's cache. */
export function joinableDeps(
	registry: SessionRegistry,
	home: HomeService | undefined,
): JoinableDeps {
	const started = new StartedReviews();
	const dir = (id: string, file: string) => join(agentsDir(), id, file);
	return {
		open: () =>
			registry.list().map(({ session, lastUsed }) => {
				const m = session.prMeta();
				return {
					id: session.id,
					owner: m.owner,
					repo: m.repo,
					number: m.number,
					title: m.title,
					headBranch: m.headBranch,
					baseBranch: m.baseBranch,
					state: m.state,
					lastUsed,
					agent: session.agent !== null,
					buddy: session.agent?.buddy() ?? null,
					asOf: session.info().asOf,
				};
			}),
		// An open review with an agent is the reviewer's own; else Home's
		// login (read once per server, as Home's first page does).
		viewer: async () => {
			const own = registry.list().find((e) => e.session.agent !== null);
			if (own) return own.session.info().viewer;
			const known = home?.knownViewer();
			if (known) return slugify(known);
			const login = home ? await home.viewerLogin() : "";
			return login ? slugify(login) : null;
		},
		started: (slug) => started.list(slug),
		cached: (owner, repo, number) => home?.cachedPr(owner, repo, number),
		acpConfigured: async () => (await agentConfig()).agent !== null,
		acpOff: (id) => existsSync(dir(id, "acp-off")),
		joinedOnDisk: (id) => existsSync(dir(id, "joined.json")),
	};
}

export { listJoinable };
