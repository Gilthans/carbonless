import type { FastifyInstance } from "fastify";
import type { AnnotationOp } from "../../shared/home.js";
import { GhError } from "../errors.js";
import { GitError } from "../git.js";
import {
	HomeRequestError,
	type HomeService,
	NotOnHomeError,
} from "./homeService.js";
import type { HomeSearch } from "./search.js";

/**
 * Home's API, `/api/home/*` (contract: src/shared/home.ts). Registered as
 * its own Fastify scope so its errors map here: a bad request 400, a PR
 * Home doesn't list 404, GitHub failing 502. The app's own hooks (host,
 * access key, cross-site writes, version) run first, as for every route.
 */

export const MAX_NOTE = 500;
const MAX_REPOS = 100;
const MAX_QUERY = 300;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;

/** The op a request body names, or a HomeRequestError saying what's wrong. */
export function parseAnnotationOp(
	body: unknown,
	now: number = Date.now(),
): AnnotationOp {
	const fail = (m: string) => new HomeRequestError(m);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw fail("Expected a JSON body");
	}
	const b = body as Record<string, unknown>;
	switch (b.op) {
		case "snooze": {
			const until =
				typeof b.until === "string" ? Date.parse(b.until) : Number.NaN;
			if (!Number.isFinite(until)) throw fail("until must be an ISO date-time");
			if (until <= now) throw fail("A snooze must end in the future");
			if (typeof b.wakeOnActivity !== "boolean") {
				throw fail("wakeOnActivity must be true or false");
			}
			return {
				op: "snooze",
				until: new Date(until).toISOString(),
				wakeOnActivity: b.wakeOnActivity,
			};
		}
		case "wait":
			if (typeof b.who !== "string" || !LOGIN.test(b.who)) {
				throw fail("who must be a GitHub login (your own means me)");
			}
			return { op: "wait", who: b.who };
		case "note":
			if (typeof b.text !== "string") throw fail("text must be a string");
			if (b.text.length > MAX_NOTE) {
				throw fail(`A note is at most ${MAX_NOTE} characters`);
			}
			return { op: "note", text: b.text };
		case "wake":
			return { op: "wake" };
		default:
			throw fail("op must be snooze, wait, note or wake");
	}
}

export async function registerHomeRoutes(
	app: FastifyInstance,
	home: HomeService,
	search: HomeSearch,
	options: {
		/**
		 * Start Home's timed refresh on its first request (default): a
		 * server whose Home is never opened never asks GitHub for it.
		 */
		startOnRequest?: boolean;
	} = {},
): Promise<void> {
	await app.register(async (scope) => {
		if (options.startOnRequest !== false) {
			scope.addHook("onRequest", async () => home.start());
		}
		scope.setErrorHandler((error, _request, reply) => {
			const send = (status: number, message: string) =>
				reply.status(status).send({ error: message });
			if (error instanceof HomeRequestError) return send(400, error.message);
			if (error instanceof NotOnHomeError) return send(404, error.message);
			if (error instanceof GhError) return send(502, error.message);
			if (error instanceof GitError) return send(500, error.message);
			const status = (error as { statusCode?: number }).statusCode;
			if (status && status >= 400 && status < 500) {
				return send(status, (error as Error).message);
			}
			console.error(error);
			return send(500, "Internal server error");
		});

		scope.get("/api/home", () => home.view());
		scope.post("/api/home/refresh", () => home.refresh());
		scope.post<{ Params: { owner: string; repo: string; number: string } }>(
			"/api/home/prs/:owner/:repo/:number/annotations",
			(request) => {
				const { owner, repo, number } = request.params;
				if (!OWNER.test(owner) || !REPO.test(repo) || !NUMBER.test(number)) {
					throw new HomeRequestError(`Not a PR: ${owner}/${repo}#${number}`);
				}
				return home.annotate(
					owner,
					repo,
					Number(number),
					parseAnnotationOp(request.body),
				);
			},
		);
		scope.put("/api/home/view", (request) => {
			const repos = (request.body as { repos?: unknown } | null)?.repos;
			if (
				!Array.isArray(repos) ||
				repos.length > MAX_REPOS ||
				!repos.every((r) => typeof r === "string" && r.length <= 300)
			) {
				throw new HomeRequestError(
					`repos must be at most ${MAX_REPOS} strings`,
				);
			}
			return home.setRepos(repos as string[]);
		});
		scope.get<{ Querystring: { q?: unknown; only?: unknown } }>(
			"/api/home/search",
			(request) => {
				const q = request.query.q ?? "";
				if (typeof q !== "string" || q.length > MAX_QUERY) {
					throw new HomeRequestError(
						`q must be at most ${MAX_QUERY} characters`,
					);
				}
				const { only } = request.query;
				if (only !== undefined && only !== "repos") {
					throw new HomeRequestError("only must be repos");
				}
				return search.search(q, only === "repos" ? { only } : {});
			},
		);
	});
}
