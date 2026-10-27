import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import {
	type ClusterState,
	COMMENTS_BATCH,
	type EditRequest,
	type ReplyRequest,
	type StateChange,
	type ThreadsStage,
	type WriteError,
} from "../shared/types.js";
import { registerAccessKey, registerHostCheck } from "./access.js";
import { GhError, WriteRefusedError } from "./errors.js";
import { NODE_ID } from "./gh.js";
import { GitError } from "./git.js";
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

export interface AppOptions {
	/** Directory with the built web UI. Omit to serve only the API. */
	webRoot?: string;
	/**
	 * Required on every request when set (see access.ts). Without a key the
	 * server must be bound to loopback, and only loopback Host headers for the
	 * listening port are accepted.
	 */
	accessKey: string | null;
}

/** A malformed request (HTTP 400). */
class BadRequestError extends Error {}

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
/** loadFileHunks/loadContext's error for an index the snapshot doesn't have. */
const NO_FILE = /^No file \d+ in this snapshot$/;

export async function buildApp(
	session: Session,
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
	registerHostCheck(app, options.accessKey === null);
	await registerAccessKey(app, options.accessKey);

	app.setErrorHandler((error, _request, reply) => {
		const send = (status: number, message: string) =>
			reply.status(status).send({ error: message });
		if (error instanceof StaleSnapshotError) return send(409, "stale");
		if (error instanceof UnknownReadError) return send(410, "read gone");
		if (error instanceof SessionClosedError) return send(503, error.message);
		if (error instanceof RefusedChangeError) {
			return reply.status(400).send({ error: error.message, keys: error.keys });
		}
		if (error instanceof BadRequestError) return send(400, error.message);
		if (error instanceof RangeError && NO_FILE.test(error.message)) {
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
			isThreadWrite(_request.url)
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

	app.get("/api/session", async () => session.info());
	// The last overview read; `maxAge` (ms) asks for one read at most that long ago.
	app.get<{ Querystring: { maxAge?: string } }>(
		"/api/overview",
		async (request) => {
			const { maxAge } = request.query;
			if (maxAge !== undefined && !INDEX.test(maxAge)) {
				throw new BadRequestError("maxAge must be a number of milliseconds");
			}
			const overview = await session.overview(
				maxAge === undefined ? undefined : Number(maxAge),
			);
			// The server's clock: the page judges the age by it, not its own.
			return { ...overview, servedAt: new Date().toISOString() };
		},
	);
	// A read's review threads, once `stage` is in (OverviewRead).
	app.get<{ Querystring: { read?: string; stage?: string } }>(
		"/api/threads",
		(request) => {
			const { read, stage } = request.query;
			if (!read) throw new BadRequestError("read is required");
			if (!STAGES.includes(stage ?? "")) {
				throw new BadRequestError(`Unknown stage: ${String(stage)}`);
			}
			return session.threads(read, stage as ThreadsStage);
		},
	);
	// The comments of a read's threads, by id (OverviewRead.comments).
	app.get<{ Querystring: { read?: string; ids?: string } }>(
		"/api/comments",
		(request) => {
			const { read, ids } = request.query;
			if (!read) throw new BadRequestError("read is required");
			const list = (ids ?? "").split(",").filter(Boolean);
			if (list.length > COMMENTS_BATCH) {
				throw new BadRequestError(
					`At most ${COMMENTS_BATCH} threads a request`,
				);
			}
			return session.comments(read, list);
		},
	);
	// A read's timeline (OverviewRead).
	app.get<{ Querystring: { read?: string } }>("/api/timeline", (request) => {
		const { read } = request.query;
		if (!read) throw new BadRequestError("read is required");
		return session.timeline(read);
	});
	app.get("/api/review", () => session.review());
	app.get<{ Params: { index: string }; Querystring: { revision?: unknown } }>(
		"/api/files/:index/hunks",
		(request) =>
			session.fileHunks(
				revisionParam(request.query.revision),
				fileIndex(request.params.index),
			),
	);
	app.get<{
		Params: { index: string };
		Querystring: { revision?: unknown; newFrom?: string; newTo?: string };
	}>("/api/files/:index/context", (request) => {
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
		return session.context(revision, index, Number(newFrom), Number(newTo));
	});
	app.post("/api/review/states", (request) => {
		const { revision, changes } = parseStatesBody(request.body);
		return session.setStates(revision, changes);
	});
	// Thread writes, posted to GitHub at once (threadWrites.ts).
	app.post<{ Params: { threadId: string } }>(
		"/api/threads/:threadId/replies",
		(request) => {
			const problem = replyProblem(request.body);
			if (problem) throw new WriteRefusedError(problem, "invalid");
			const { body, attemptedAt, retry, clientId, knownCommentIds } =
				request.body as ReplyRequest;
			return session.replyToThread(threadIdParam(request.params.threadId), {
				body,
				attemptedAt,
				retry,
				clientId,
				knownCommentIds,
			});
		},
	);
	app.post<{ Params: { threadId: string } }>(
		"/api/threads/:threadId/resolved",
		(request) => {
			const resolved = (request.body as { resolved?: unknown } | null)
				?.resolved;
			if (typeof resolved !== "boolean") {
				throw new WriteRefusedError(
					"resolved must be true or false",
					"invalid",
				);
			}
			return session.setThreadResolved(
				threadIdParam(request.params.threadId),
				resolved,
			);
		},
	);
	app.patch<{ Params: { threadId: string; commentId: string } }>(
		"/api/threads/:threadId/comments/:commentId",
		(request) => {
			const problem = editProblem(request.body);
			if (problem) throw new WriteRefusedError(problem, "invalid");
			const { body, from, force } = request.body as EditRequest;
			return session.editThreadComment(
				threadIdParam(request.params.threadId),
				commentIdParam(request.params.commentId),
				{ body, from, force },
			);
		},
	);
	app.delete<{ Params: { threadId: string; commentId: string } }>(
		"/api/threads/:threadId/comments/:commentId",
		(request) =>
			session.deleteThreadComment(
				threadIdParam(request.params.threadId),
				commentIdParam(request.params.commentId),
			),
	);
	app.post("/api/refresh", () => session.refresh());
	app.get("/api/head", () => session.checkHead());

	const isApi = (url: string) => /^\/api(\/|\?|$)/.test(url);
	if (options.webRoot && existsSync(options.webRoot)) {
		await app.register(fastifyStatic, { root: options.webRoot });
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

/** WriteError's HTTP statuses. */
const WRITE_STATUS: Record<WriteError["code"], number> = {
	invalid: 400,
	"writes-off": 403,
	forbidden: 403,
	gone: 404,
	"pending-review": 409,
	changed: 409,
};

const isThreadWrite = (url: string) =>
	/^\/api\/threads\/[^/?]+\/(replies|resolved|comments\/[^/?]+)(\?|$)/.test(
		url,
	);

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
