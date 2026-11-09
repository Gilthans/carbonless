import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
	type AgentConfig,
	type AgentMessageRequest,
	MAX_AGENT_TEXT,
	type OpenAgentThreadRequest,
} from "../shared/agent.js";
import {
	type ClusterState,
	COMMENTS_BATCH,
	type EditRequest,
	type NewThreadRequest,
	type ReplyRequest,
	type StateChange,
	type ThreadsStage,
	type VerdictRequest,
	type WriteError,
} from "../shared/types.js";
import { registerAccessKey, registerHostCheck } from "./access.js";
import { checkAgent } from "./agent/acp.js";
import { agentsDir } from "./agent/checkout.js";
import {
	type AgentHost,
	agentConfig,
	noteAgentConfigSaved,
} from "./agent/host.js";
import { isSafePath } from "./agent/prompt.js";
import { UnknownAgentThreadError } from "./agent/store.js";
import { parseAsOf } from "./asOf.js";
import { updateConfig } from "./config.js";
import { GhError, WriteRefusedError } from "./errors.js";
import { NODE_ID, parsePrArg } from "./gh.js";
import { GitError } from "./git.js";
import type { HomeService } from "./home/homeService.js";
import { registerHomeRoutes } from "./home/routes.js";
import { HomeSearch } from "./home/search.js";
import { MARKER_ID } from "./marker.js";
import { newThreadProblem } from "./newThreads.js";
import { type HeadSpec, parseHead } from "./pinnedHead.js";
import {
	type OpenRequest,
	RefusedReviewError,
	type SessionRegistry,
	UnknownReviewError,
} from "./registry.js";
import {
	InvalidChangeError,
	RefusedChangeError,
	refusedMessage,
	StaleSnapshotError,
} from "./review/reviews.js";
import {
	type Session,
	SessionClosedError,
	UnknownReadError,
} from "./session.js";
import { editProblem, replyProblem } from "./threadWrites.js";
import { verdictProblem } from "./verdict.js";
import {
	BUILD,
	mismatchMessage,
	parseBuildInfo,
	sameBuild,
	VERSION_HEADER,
} from "./version.js";

export interface AppOptions {
	/** Directory with the built web UI. Omit to serve only the API. */
	webRoot?: string;
	/**
	 * Required on every request when set (see access.ts). Without a key the
	 * server must be bound to loopback (`loopback`).
	 */
	accessKey: string | null;
	/**
	 * Bound to loopback, so only loopback Host headers (and `publicUrl`'s)
	 * are accepted. Default: when there is no key.
	 */
	loopback?: boolean;
	/** The origin a proxy in front serves it at (config `serve.publicUrl`). */
	publicUrl?: string;
	/**
	 * The server's own address (`http://<host>:<port>`, no key), for the
	 * review URLs it hands out. Default: the request's Host.
	 */
	baseUrl?: () => string;
	/** Startup steps of reviews being opened (crb serve logs them). */
	progress?: (message: string) => void;
	/** Home (`/api/home/*`); omit for a server without it (tests). */
	home?: HomeService;
}

/** A malformed request (HTTP 400). */
class BadRequestError extends Error {}

/** A review with no agent: --viewer, --as-of (HTTP 404, code "no-agent"). */
class NoAgentError extends Error {}

/** The review a `/api/r/:id/...` request is for (set by its preHandler). */
const sessions = new WeakMap<FastifyRequest, Session>();
const sessionOf = (request: FastifyRequest): Session => {
	const session = sessions.get(request);
	if (!session) throw new Error("No review for this request");
	return session;
};

const VIEWER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

/** No framing (clickjacking) and no Referer leaking the access key. */
const SECURITY_HEADERS = {
	"x-frame-options": "DENY",
	"content-security-policy": "frame-ancestors 'none'",
	"referrer-policy": "no-referrer",
};

const MAX_CHANGES = 1000;
const MAX_REASON = 500;
const STAGES: readonly string[] = [
	"summary",
	"first",
	"firstCode",
	"full",
] satisfies ThreadsStage[];
const STATES: readonly string[] = [
	"unreviewed",
	"reviewed",
	"crossed-off",
] satisfies ClusterState[];
const POSITIVE = /^[1-9]\d{0,8}$/;
const INDEX = /^(0|[1-9]\d{0,8})$/;
/** A full object id (the only form a route passes on to git). */
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** loadFileHunks/loadContext's error for an index the snapshot doesn't have. */
const NO_FILE = /^No file \d+ in this snapshot$/;
/** Session.reviewAt/rereview's error for a patch set the reviewer hasn't. */
const NO_PATCHSET = /^No patch set \d+$/;

export async function buildApp(
	registry: SessionRegistry,
	options: AppOptions,
): Promise<FastifyInstance> {
	const app = Fastify({
		// No logger: request URLs can carry the access key.
		logger: false,
		bodyLimit: 4 * 1024 * 1024,
		// close() must not wait for the browser to drop its keep-alive and
		// preconnected sockets. Every write is already an atomic git commit,
		// so there's nothing to drain.
		forceCloseConnections: true,
	});
	// First hook, so even the access checks' 401/403 replies carry them.
	app.addHook("onRequest", async (_request, reply) => {
		reply.headers(SECURITY_HEADERS);
	});
	registerHostCheck(app, {
		loopback: options.loopback ?? options.accessKey === null,
		publicUrl: options.publicUrl,
	});
	await registerAccessKey(app, options.accessKey, options.publicUrl);
	// A crb of another build must not drive this server (the browser sends
	// no header and isn't checked: its page comes from this server).
	app.addHook("onRequest", async (request, reply) => {
		const raw = request.headers[VERSION_HEADER];
		if (raw === undefined) return;
		const client = parseBuildInfo(Array.isArray(raw) ? raw[0] : raw);
		if (client && sameBuild(BUILD, client)) return;
		return reply.status(409).send({
			error: client
				? mismatchMessage(BUILD, client)
				: `Unreadable ${VERSION_HEADER} header`,
			code: "version-mismatch",
			server: BUILD,
		});
	});

	app.setErrorHandler((error, _request, reply) => {
		const send = (status: number, message: string) =>
			reply.status(status).send({ error: message });
		if (error instanceof StaleSnapshotError) return send(409, "stale");
		if (error instanceof UnknownReadError) return send(410, "read gone");
		if (error instanceof SessionClosedError) return send(503, error.message);
		if (error instanceof UnknownReviewError) {
			return reply
				.status(404)
				.send({ error: error.message, code: "unknown-review" });
		}
		if (error instanceof RefusedReviewError) {
			return reply.status(409).send({ error: error.message, code: "refused" });
		}
		if (error instanceof RefusedChangeError) {
			return reply.status(400).send({ error: error.message, keys: error.keys });
		}
		if (error instanceof BadRequestError) return send(400, error.message);
		if (error instanceof NoAgentError) {
			return reply.status(404).send({ error: error.message, code: "no-agent" });
		}
		if (error instanceof UnknownAgentThreadError) {
			return send(404, error.message);
		}
		if (
			error instanceof RangeError &&
			(NO_FILE.test(error.message) || NO_PATCHSET.test(error.message))
		) {
			return send(404, error.message);
		}
		if (error instanceof WriteRefusedError) {
			const body: WriteError = {
				error: error.message,
				code: error.code,
				...(error.url ? { url: error.url } : {}),
				...(error.current ? { current: error.current } : {}),
			};
			return reply.status(WRITE_STATUS[error.code]).send(body);
		}
		if (error instanceof GhError) return send(502, error.message);
		if (error instanceof GitError) return send(500, error.message);
		// Fastify's own client errors: bad JSON, body too large, ...
		const status = (error as { statusCode?: number }).statusCode;
		if (
			status &&
			status >= 400 &&
			status < 500 &&
			isThreadWrite(
				_request.method,
				_request.url.replace(REVIEW_PREFIX, "/api"),
			)
		) {
			const body: WriteError = {
				error: (error as Error).message,
				code: "invalid",
			};
			return reply.status(400).send(body);
		}
		if (status && status >= 400 && status < 500) {
			return send(status, (error as Error).message);
		}
		console.error(error);
		return send(500, "Internal server error");
	});

	app.get("/api/version", async () => BUILD);
	// Opens (or finds) the review of a PR: crb <pr>.
	app.post("/api/reviews", async (request) => {
		const req = parseOpenBody(request.body);
		const { id } = await openReview(registry, req, options.progress);
		const key = options.accessKey ? `?key=${options.accessKey}` : "";
		return { id, url: `${baseUrl(request)}/r/${id}${key}` };
	});
	const baseUrl = (request: FastifyRequest) =>
		options.baseUrl?.() ?? `http://${request.headers.host ?? "localhost"}`;

	// A review's routes, by its id: /api/r/<id>/session, ...
	await app.register(
		async (review) => {
			review.addHook<{ Params: { id: string } }>(
				"preHandler",
				async (request) => {
					sessions.set(request, await registry.get(request.params.id));
				},
			);
			review.get("/session", async (request) => sessionOf(request).info());
			// The last overview read; `maxAge` (ms) asks for one read at most that long ago.
			review.get<{ Querystring: { maxAge?: string } }>(
				"/overview",
				async (request) => {
					const { maxAge } = request.query;
					if (maxAge !== undefined && !INDEX.test(maxAge)) {
						throw new BadRequestError(
							"maxAge must be a number of milliseconds",
						);
					}
					const overview = await sessionOf(request).overview(
						maxAge === undefined ? undefined : Number(maxAge),
					);
					// The server's clock: the page judges the age by it, not its own.
					return { ...overview, servedAt: new Date().toISOString() };
				},
			);
			// A read's review threads, once `stage` is in (OverviewRead).
			review.get<{ Querystring: { read?: string; stage?: string } }>(
				"/threads",
				(request) => {
					const { read, stage } = request.query;
					if (!read) throw new BadRequestError("read is required");
					if (!STAGES.includes(stage ?? "")) {
						throw new BadRequestError(`Unknown stage: ${String(stage)}`);
					}
					return sessionOf(request).threads(read, stage as ThreadsStage);
				},
			);
			// The comments of a read's threads, by id (OverviewRead.comments).
			review.get<{ Querystring: { read?: string; ids?: string } }>(
				"/comments",
				(request) => {
					const { read, ids } = request.query;
					if (!read) throw new BadRequestError("read is required");
					const list = (ids ?? "").split(",").filter(Boolean);
					if (list.length > COMMENTS_BATCH) {
						throw new BadRequestError(
							`At most ${COMMENTS_BATCH} threads a request`,
						);
					}
					return sessionOf(request).comments(read, list);
				},
			);
			// A read's timeline (OverviewRead).
			review.get<{ Querystring: { read?: string } }>("/timeline", (request) => {
				const { read } = request.query;
				if (!read) throw new BadRequestError("read is required");
				return sessionOf(request).timeline(read);
			});
			// The current patch set's review; `patchset=<n>` an earlier one as
			// reviewed (read-only); `head=<oid>` the snapshot of that head,
			// viewed (its first lasting action starts the patch set).
			review.get<{ Querystring: { patchset?: unknown; head?: unknown } }>(
				"/review",
				(request) => {
					const { patchset, head } = request.query;
					if (patchset !== undefined && head !== undefined) {
						throw new BadRequestError("patchset and head can't be combined");
					}
					if (patchset !== undefined) {
						return sessionOf(request).reviewAt(patchsetParam(patchset));
					}
					if (head !== undefined) {
						return sessionOf(request).viewHead(oidParam("head", head));
					}
					return sessionOf(request).review();
				},
			);
			// The engine's answer for patch set `from` to patch set `to` (its
			// pinned snapshot) or to `head` (its snapshot against the base
			// tip): `{ pending: true }` until it is computed (Session.rereview).
			review.get<{
				Querystring: { from?: unknown; to?: unknown; head?: unknown };
			}>("/rereview", (request) => {
				const { from, to, head } = request.query;
				if ((to === undefined) === (head === undefined)) {
					throw new BadRequestError(
						"to (a patch set) or head (a commit id), one of them",
					);
				}
				return sessionOf(request).rereview(
					patchsetParam(from),
					to !== undefined
						? { patchset: patchsetParam(to) }
						: { head: oidParam("head", head) },
				);
			});
			// A file's hunks; with `from=<n>`, the since view's: the interdiff
			// from patch set n to the snapshot (Session.interdiffHunks).
			review.get<{
				Params: { index: string };
				Querystring: { revision?: unknown; from?: unknown };
			}>("/files/:index/hunks", (request) => {
				const revision = revisionParam(request.query.revision);
				const index = fileIndex(request.params.index);
				const { from } = request.query;
				if (from !== undefined) {
					return sessionOf(request).interdiffHunks(
						patchsetParam(from),
						revision,
						index,
					);
				}
				return sessionOf(request).fileHunks(revision, index);
			});
			review.get<{
				Params: { index: string };
				Querystring: { revision?: unknown; newFrom?: string; newTo?: string };
			}>("/files/:index/context", (request) => {
				const index = fileIndex(request.params.index);
				const revision = revisionParam(request.query.revision);
				const { newFrom, newTo } = request.query;
				if (
					!POSITIVE.test(newFrom ?? "") ||
					!POSITIVE.test(newTo ?? "") ||
					Number(newFrom) > Number(newTo)
				) {
					throw new BadRequestError(
						"newFrom and newTo must be line numbers with newFrom <= newTo",
					);
				}
				return sessionOf(request).context(
					revision,
					index,
					Number(newFrom),
					Number(newTo),
				);
			});
			review.post("/review/states", (request) => {
				const { revision, changes } = parseStatesBody(request.body);
				return sessionOf(request).setStates(revision, changes);
			});
			// Thread writes, posted to GitHub at once (threadWrites.ts, newThreads.ts).
			review.post("/threads", (request) => {
				const problem = newThreadProblem(request.body);
				if (problem) throw new WriteRefusedError(problem, "invalid");
				const r = request.body as NewThreadRequest;
				const line =
					r.subject === "line"
						? {
								...(r.startSide ? { startSide: r.startSide } : {}),
								...(r.startLine ? { startLine: r.startLine } : {}),
								side: r.side,
								line: r.line,
								startCol: r.startCol ?? null,
								endCol: r.endCol ?? null,
							}
						: {};
				return sessionOf(request).startThread({
					clientId: r.clientId,
					body: r.body,
					attemptedAt: r.attemptedAt,
					retry: r.retry,
					path: r.path,
					commit: r.commit,
					subject: r.subject,
					...line,
				});
			});
			review.post<{ Params: { threadId: string } }>(
				"/threads/:threadId/replies",
				(request) => {
					const problem = replyProblem(request.body);
					if (problem) throw new WriteRefusedError(problem, "invalid");
					const { body, attemptedAt, retry, clientId, knownCommentIds } =
						request.body as ReplyRequest;
					return sessionOf(request).replyToThread(
						threadIdParam(request.params.threadId),
						{
							body,
							attemptedAt,
							retry,
							clientId,
							knownCommentIds,
						},
					);
				},
			);
			review.post<{ Params: { threadId: string } }>(
				"/threads/:threadId/resolved",
				(request) => {
					const resolved = (request.body as { resolved?: unknown } | null)
						?.resolved;
					if (typeof resolved !== "boolean") {
						throw new WriteRefusedError(
							"resolved must be true or false",
							"invalid",
						);
					}
					return sessionOf(request).setThreadResolved(
						threadIdParam(request.params.threadId),
						resolved,
					);
				},
			);
			review.patch<{ Params: { threadId: string; commentId: string } }>(
				"/threads/:threadId/comments/:commentId",
				(request) => {
					const problem = editProblem(request.body);
					if (problem) throw new WriteRefusedError(problem, "invalid");
					const { body, from, force } = request.body as EditRequest;
					return sessionOf(request).editThreadComment(
						threadIdParam(request.params.threadId),
						commentIdParam(request.params.commentId),
						{ body, from, force },
					);
				},
			);
			review.delete<{ Params: { threadId: string; commentId: string } }>(
				"/threads/:threadId/comments/:commentId",
				(request) =>
					sessionOf(request).deleteThreadComment(
						threadIdParam(request.params.threadId),
						commentIdParam(request.params.commentId),
					),
			);
			// What blocks the merge (read only when asked); `maxAge` as for the overview.
			review.get<{ Querystring: { maxAge?: string } }>(
				"/verdict",
				(request) => {
					const { maxAge } = request.query;
					if (maxAge !== undefined && !INDEX.test(maxAge)) {
						throw new BadRequestError(
							"maxAge must be a number of milliseconds",
						);
					}
					return sessionOf(request).verdict(
						maxAge === undefined ? undefined : Number(maxAge),
					);
				},
			);
			// The reviewer's verdict, sent to GitHub at once (verdict.ts).
			review.post("/verdict", (request) => {
				const problem = verdictProblem(request.body);
				if (problem) throw new WriteRefusedError(problem, "invalid");
				const r = request.body as VerdictRequest;
				return sessionOf(request).submitVerdict({
					clientId: r.clientId,
					event: r.event,
					...(r.body === undefined ? {} : { body: r.body }),
					commit: r.commit,
					attemptedAt: r.attemptedAt,
					retry: r.retry,
				});
			});
			// The reviewer's own agent (review buddy): status, private threads.
			review.get("/agent", (request) => agentOf(request).status());
			review.get("/agent/threads", async (request) => ({
				threads: await agentOf(request).threads(),
			}));
			review.post("/agent/threads", (request) =>
				agentOf(request).open(parseAgentOpen(request.body)),
			);
			review.post<{ Params: { tid: string } }>(
				"/agent/threads/:tid/messages",
				(request) =>
					agentOf(request).message(
						agentThreadParam(request.params.tid),
						parseAgentMessage(request.body),
					),
			);
			review.post<{ Params: { tid: string } }>(
				"/agent/threads/:tid/resolved",
				(request) => {
					const resolved = (request.body as { resolved?: unknown } | null)
						?.resolved;
					if (typeof resolved !== "boolean") {
						throw new BadRequestError("resolved must be true or false");
					}
					return agentOf(request).setResolved(
						agentThreadParam(request.params.tid),
						resolved,
					);
				},
			);
			review.post("/agent/cancel", async (request) => {
				await agentOf(request).cancel();
				return { ok: true };
			});
			review.post("/refresh", (request) => sessionOf(request).refresh());
			review.get("/head", (request) => sessionOf(request).checkHead());
		},
		{ prefix: "/api/r/:id" },
	);

	// The setup modal: what is configured, save the agent, or try it once.
	app.get("/api/config/agent", () => agentConfig());
	app.put("/api/config/agent", async (request) => {
		const agent = parseAgentConfig(request.body, true);
		try {
			const c = await updateConfig((config) => ({ ...config, agent }));
			noteAgentConfigSaved();
			return { agent: c.agent };
		} catch (error) {
			throw new BadRequestError((error as Error).message);
		}
	});
	app.post("/api/config/agent/check", (request) => {
		const agent = parseAgentConfig(request.body, false);
		if (!agent) throw new BadRequestError("Expected an agent");
		return checkAgent(agent, agentsDir());
	});

	// A typed, pasted or clicked address: the PR's review, opened if need
	// be. With the web UI the page answers at once and opens the review
	// itself (POST /api/reviews, then on to /r/<id>), so the reviewer sees it
	// load; without it, the open and a redirect.
	app.get<{
		Params: { owner: string; repo: string; number: string };
		Querystring: { head?: string };
	}>("/pr/:owner/:repo/:number", async (request, reply) => {
		const { owner, repo, number } = request.params;
		try {
			const req: OpenRequest = { pr: `${owner}/${repo}#${number}` };
			const parsed = parsePrArg(req.pr);
			const { head } = request.query;
			if (head !== undefined) req.head = parseHead(head);
			if (webRoot && "owner" in parsed) {
				return openingPage(reply, prTitle(options.home, parsed));
			}
			const { id } = await openReview(registry, req, options.progress);
			return reply.redirect(`/r/${id}`, 302);
		} catch (error) {
			if (error instanceof GitError) throw error;
			return notFoundPage(reply, (error as Error).message);
		}
	});

	if (options.home) {
		await registerHomeRoutes(app, options.home, new HomeSearch(options.home));
	}

	const isApi = (url: string) => /^\/api(\/|\?|$)/.test(url);
	const webRoot =
		options.webRoot && existsSync(options.webRoot) ? options.webRoot : null;
	/** The web 404 page, saying why (`reason`); JSON without the web UI. */
	const notFoundPage = async (
		reply: import("fastify").FastifyReply,
		reason: string,
	) => {
		if (!webRoot) return reply.status(404).send({ error: reason });
		const html = await readFile(join(webRoot, "index.html"), "utf8");
		const meta = `<meta name="crb-not-found" content="${escapeAttribute(reason)}">`;
		return reply
			.status(404)
			.type("text/html; charset=utf-8")
			.send(html.replace("</head>", `${meta}</head>`));
	};
	/** The web page for a /pr/... address, with the PR's title when Home knows it. */
	const openingPage = async (
		reply: import("fastify").FastifyReply,
		title: string | null,
	) => {
		const html = await readFile(join(webRoot as string, "index.html"), "utf8");
		return reply
			.type("text/html; charset=utf-8")
			.send(withPrTitle(html, title));
	};
	if (webRoot) {
		await app.register(fastifyStatic, { root: webRoot });
		// Client routes (TanStack Router) all load the single page.
		app.setNotFoundHandler((request, reply) => {
			if (isApi(request.url) || !["GET", "HEAD"].includes(request.method)) {
				return reply.status(404).send({ error: "Not found" });
			}
			return reply.sendFile("index.html");
		});
	} else {
		app.setNotFoundHandler((_request, reply) =>
			reply.status(404).send({ error: "Not found" }),
		);
	}

	return app;
}

/** `/api/r/<id>`, before a review route's own path. */
const REVIEW_PREFIX = /^\/api\/r\/[^/?]+/;

const escapeAttribute = (text: string) =>
	text.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);

/**
 * The page `html` with the PR's `title` in its `crb-pr-title` meta (none
 * for null), escaped: a PR's title is anyone's text.
 */
export function withPrTitle(html: string, title: string | null): string {
	if (title === null) return html;
	const meta = `<meta name="crb-pr-title" content="${escapeAttribute(title)}">`;
	return html.replace("</head>", `${meta}</head>`);
}

/** `pr`'s title as Home last read it; null when Home doesn't know it. */
export function prTitle(
	home: HomeService | undefined,
	pr: { owner: string; repo: string; number: number },
): string | null {
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const known = home
		?.knownPrs()
		.find(
			(f) =>
				f.number === pr.number &&
				same(f.owner, pr.owner) &&
				same(f.repo, pr.repo),
		);
	return known?.title ?? null;
}

/** Opens the review; a refusal is a RefusedReviewError (registry.ts). */
const openReview = (
	registry: SessionRegistry,
	req: OpenRequest,
	progress?: (message: string) => void,
) => registry.open(req, progress);

/** POST /api/reviews' body: `{ pr, head?, asOf?, viewer? }`, all strings. */
function parseOpenBody(body: unknown): OpenRequest {
	const fail = (message: string) => new BadRequestError(message);
	if (typeof body !== "object" || body === null) {
		throw fail("Expected a JSON body");
	}
	const { pr, head, asOf, viewer } = body as Record<string, unknown>;
	if (typeof pr !== "string") throw fail("pr is required");
	const parsePr = () => {
		try {
			return parsePrArg(pr);
		} catch (error) {
			throw fail((error as Error).message);
		}
	};
	if (!("owner" in parsePr())) {
		throw fail("pr must be a PR URL or owner/repo#n");
	}
	const req: OpenRequest = { pr };
	const optional = (name: string, value: unknown) => {
		if (value !== undefined && typeof value !== "string") {
			throw fail(`${name} must be a string`);
		}
		return value as string | undefined;
	};
	const h = optional("head", head);
	const a = optional("asOf", asOf);
	const v = optional("viewer", viewer);
	try {
		if (h !== undefined) req.head = parseHead(h) satisfies HeadSpec;
		if (a !== undefined) req.asOf = parseAsOf(a);
	} catch (error) {
		throw fail((error as Error).message);
	}
	if (req.head && req.asOf) throw fail("--head can't be combined with --as-of");
	if (v !== undefined) {
		if (!VIEWER.test(v)) throw fail(`Invalid --viewer: ${v}`);
		req.viewer = v;
	}
	return req;
}

/** WriteError's HTTP statuses. */
const WRITE_STATUS: Record<WriteError["code"], number> = {
	invalid: 400,
	"writes-off": 403,
	forbidden: 403,
	gone: 404,
	"pending-review": 409,
	changed: 409,
	stale: 409,
};

const isThreadWrite = (method: string, url: string) =>
	/^\/api\/threads\/[^/?]+\/(replies|resolved|comments\/[^/?]+)(\?|$)/.test(
		url,
	) ||
	(method === "POST" && /^\/api\/(threads|verdict)(\?|$)/.test(url));

/** The review's agent; a NoAgentError for one that has none. */
function agentOf(request: FastifyRequest): AgentHost {
	const agent = sessionOf(request).agent;
	if (!agent) {
		throw new NoAgentError(
			"No agent here: this review is as of a past moment or as someone else",
		);
	}
	return agent;
}

const AGENT_THREAD_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

function agentThreadParam(raw: string): string {
	if (!AGENT_THREAD_ID.test(raw)) {
		throw new BadRequestError(`Not an agent thread id: ${raw}`);
	}
	return raw;
}

/** A question's or reply's text: not blank, at most MAX_AGENT_TEXT bytes. */
function agentTextProblem(text: unknown): string | null {
	if (typeof text !== "string" || !text.trim())
		return "A question can't be blank";
	if (Buffer.byteLength(text) > MAX_AGENT_TEXT) {
		return `A question is at most ${MAX_AGENT_TEXT} bytes`;
	}
	return null;
}

function clientIdProblem(clientId: unknown): string | null {
	return typeof clientId === "string" && MARKER_ID.test(clientId)
		? null
		: "clientId must be 1 to 100 letters, digits or _.:-";
}

/** POST agent/threads' body; the span checked like a new comment's. */
function parseAgentOpen(body: unknown): OpenAgentThreadRequest {
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<
		string,
		unknown
	>;
	const problem = clientIdProblem(b.clientId) ?? agentTextProblem(b.text);
	if (problem) throw new BadRequestError(problem);
	const span = (
		typeof b.span === "object" && b.span !== null ? b.span : {}
	) as Record<string, unknown>;
	const spanProblem = newThreadProblem({
		...span,
		clientId: b.clientId,
		body: b.text,
		attemptedAt: "",
		retry: false,
	});
	if (spanProblem) throw new BadRequestError(spanProblem);
	if (!isSafePath(span.path as string)) {
		throw new BadRequestError("path must be a file's path in the repository");
	}
	const line =
		span.subject === "line"
			? {
					subject: "line" as const,
					side: span.side,
					line: span.line,
					startSide: span.startSide ?? span.side,
					startLine: span.startLine ?? span.line,
					...(span.startCol !== undefined && span.startCol !== null
						? { startCol: span.startCol, endCol: span.endCol }
						: {}),
				}
			: { subject: "file" as const };
	return {
		clientId: b.clientId as string,
		text: b.text as string,
		span: {
			...line,
			path: span.path,
			commit: span.commit,
		} as OpenAgentThreadRequest["span"],
	};
}

function parseAgentMessage(body: unknown): AgentMessageRequest {
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<
		string,
		unknown
	>;
	const problem = clientIdProblem(b.clientId) ?? agentTextProblem(b.text);
	if (problem) throw new BadRequestError(problem);
	return { clientId: b.clientId as string, text: b.text as string };
}

/**
 * The setup modal's agent: `{command, args, env, leash}` (null when
 * `nullable`, to remove it), checked as config.json's agent section is.
 */
function parseAgentConfig(
	body: unknown,
	nullable: boolean,
): AgentConfig | null {
	if (body === null && nullable) return null;
	const fail = (m: string) => new BadRequestError(m);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw fail("agent must be an object or null");
	}
	const {
		command,
		args = [],
		env = {},
		leash = "open",
	} = body as Record<string, unknown>;
	if (
		typeof command !== "string" ||
		!command.trim() ||
		command.includes("\0")
	) {
		throw fail("agent.command must be a non-empty string");
	}
	if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
		throw fail("agent.args must be an array of strings");
	}
	if (
		typeof env !== "object" ||
		env === null ||
		Array.isArray(env) ||
		!Object.values(env).every((v) => typeof v === "string")
	) {
		throw fail("agent.env must be an object of strings");
	}
	if (leash !== "open") {
		throw fail(`agent.leash "${String(leash)}" is not available yet`);
	}
	return {
		command: command.trim(),
		args: args as string[],
		env: env as Record<string, string>,
		leash: "open",
	};
}

function threadIdParam(raw: string): string {
	if (!NODE_ID.test(raw)) {
		throw new WriteRefusedError(`Not a thread id: ${raw}`, "invalid");
	}
	return raw;
}

function commentIdParam(raw: string): string {
	if (!NODE_ID.test(raw)) {
		throw new WriteRefusedError(`Not a comment id: ${raw}`, "invalid");
	}
	return raw;
}

function fileIndex(raw: string): number {
	if (!INDEX.test(raw)) throw new BadRequestError(`Invalid file index: ${raw}`);
	return Number(raw);
}

function revisionParam(raw: unknown): string {
	if (typeof raw !== "string" || !raw) {
		throw new BadRequestError("revision is required");
	}
	return raw;
}

function patchsetParam(raw: unknown): number {
	if (typeof raw !== "string" || !POSITIVE.test(raw)) {
		throw new BadRequestError("A patch set number is required");
	}
	return Number(raw);
}

function oidParam(name: string, raw: unknown): string {
	if (typeof raw !== "string" || !OID.test(raw)) {
		throw new BadRequestError(`${name} must be a commit id`);
	}
	return raw;
}

function parseStatesBody(body: unknown): {
	revision: string;
	changes: StateChange[];
} {
	const fail = (message: string) => new BadRequestError(message);
	if (typeof body !== "object" || body === null) {
		throw fail("Expected a JSON body");
	}
	const { revision, changes } = body as Record<string, unknown>;
	if (typeof revision !== "string") throw fail("revision is required");
	if (!Array.isArray(changes)) throw fail("changes must be an array");
	if (changes.length > MAX_CHANGES) {
		throw fail(`At most ${MAX_CHANGES} changes per request`);
	}
	// A change with a key but a bad state or reason is refused by its key, with
	// every other one like it; one without a key fails the whole body.
	const refused: { key: string; message: string }[] = [];
	const parsed = changes.map((change: unknown): StateChange | undefined => {
		if (typeof change !== "object" || change === null) {
			throw fail("Each change must be an object");
		}
		const { key, state, reason } = change as Record<string, unknown>;
		if (typeof key !== "string") throw fail("A change's key must be a string");
		if (typeof state !== "string" || !STATES.includes(state)) {
			refused.push({ key, message: `Unknown cluster state: ${String(state)}` });
			return undefined;
		}
		if (reason === undefined) return { key, state: state as ClusterState };
		if (typeof reason !== "string" || reason.length > MAX_REASON) {
			refused.push({
				key,
				message: `A reason must be a string of at most ${MAX_REASON} characters`,
			});
			return undefined;
		}
		return { key, state: state as ClusterState, reason };
	});
	const [first] = refused;
	if (first) {
		throw new InvalidChangeError(
			refusedMessage(first.message, refused.length),
			refused.map((r) => r.key),
		);
	}
	return {
		revision,
		changes: parsed.filter((c): c is StateChange => c !== undefined),
	};
}
