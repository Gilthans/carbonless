import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { ClusterState, StateChange } from "../shared/types.js";
import { registerAccessKey, registerHostCheck } from "./access.js";
import { GhError } from "./errors.js";
import { GitError } from "./git.js";
import {
	InvalidChangeError,
	StaleSnapshotError,
	UnknownClusterError,
} from "./review/reviews.js";
import type { Session } from "./session.js";

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

const MAX_CHANGES = 1000;
const MAX_REASON = 500;
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
	// No logger: request URLs can carry the access key.
	const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
	registerHostCheck(app, options.accessKey === null);
	await registerAccessKey(app, options.accessKey);

	app.setErrorHandler((error, _request, reply) => {
		const send = (status: number, message: string) =>
			reply.status(status).send({ error: message });
		if (error instanceof StaleSnapshotError) return send(409, "stale");
		if (
			error instanceof BadRequestError ||
			error instanceof UnknownClusterError ||
			error instanceof InvalidChangeError
		) {
			return send(400, error.message);
		}
		if (error instanceof RangeError && NO_FILE.test(error.message)) {
			return send(404, error.message);
		}
		if (error instanceof GhError) return send(502, error.message);
		if (error instanceof GitError) return send(500, error.message);
		// Fastify's own client errors: bad JSON, body too large, ...
		const status = (error as { statusCode?: number }).statusCode;
		if (status && status >= 400 && status < 500) {
			return send(status, (error as Error).message);
		}
		console.error(error);
		return send(500, "Internal server error");
	});

	app.get("/api/session", async () => session.info());
	app.get("/api/overview", () => session.overview());
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
	return {
		revision,
		changes: changes.map((change: unknown): StateChange => {
			if (typeof change !== "object" || change === null) {
				throw fail("Each change must be an object");
			}
			const { key, state, reason } = change as Record<string, unknown>;
			if (typeof key !== "string")
				throw fail("A change's key must be a string");
			if (typeof state !== "string" || !STATES.includes(state)) {
				throw fail(`Unknown cluster state: ${String(state)}`);
			}
			if (reason === undefined) {
				return { key, state: state as ClusterState };
			}
			if (typeof reason !== "string" || reason.length > MAX_REASON) {
				throw fail(
					`A reason must be a string of at most ${MAX_REASON} characters`,
				);
			}
			return { key, state: state as ClusterState, reason };
		}),
	};
}
