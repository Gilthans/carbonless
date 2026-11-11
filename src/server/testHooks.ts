import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { clearSnapshotCaches } from "./diff/snapshot.js";
import { ghRunning } from "./gh.js";
import { gitChildren } from "./git.js";
import type { HomeService } from "./home/homeService.js";
import type { SessionRegistry } from "./registry.js";

/*
 * Test-only routes (CAR-106: one `crb serve` shared by a Playwright worker's
 * tests). They exist only when `crb serve` starts with $CRB_TEST_HOOKS set to
 * a 32-hex token, which nothing but the test harness sets: a normal server
 * has no such routes (404). Each request must carry the token in the
 * `x-crb-test-hook` header (else 403), and passes the server's host and
 * access-key checks like any other.
 *
 * POST /api/_test/reset: puts the server's memory back as a fresh process
 *   has it: every session closed (no gh or git of theirs runs after; an
 *   open under way closes what it lands with), the registry's request map
 *   forgotten, Home's caches and the snapshot caches dropped. Waits, all of
 *   it within one bounded wait, until no open, close, gh call, gh process
 *   or git process is left, and answers `{ closed, ghInFlight, ghChildren,
 *   gitChildren, leftovers }` (leftovers: what still ran at the deadline).
 * GET /api/_test/state: open sessions, Home's cached repos, RSS, and what
 *   gh and git run now.
 */

export const TEST_HOOKS_ENV = "CRB_TEST_HOOKS";
export const TEST_HOOK_HEADER = "x-crb-test-hook";
const TOKEN = /^[0-9a-f]{32}$/;

/** How long a reset waits for gh and git to end before answering with what's left. */
export const RESET_SETTLE_MS = 5000;

/** The token in `value` ($CRB_TEST_HOOKS), or null when it isn't one. */
export function testHookToken(value: string | undefined): string | null {
	return value && TOKEN.test(value) ? value : null;
}

export interface ResetAnswer {
	/** Sessions it closed. */
	closed: number;
	/** gh calls still running (gh.ts), when it answered. */
	ghInFlight: number;
	/** gh processes not yet exited. */
	ghChildren: number;
	/** git processes not yet exited. */
	gitChildren: number;
	/** What was still running when the wait ran out: `gh …`, `git …`. */
	leftovers: string[];
}

export interface TestState {
	sessions: string[];
	homeRepos: string[];
	rss: number;
	gh: string[];
	ghChildren: string[];
	git: string[];
}

/**
 * Waits until no gh call, gh process or git process runs (and none starts
 * within a tick after), at most `timeoutMs`; returns what still runs.
 */
async function settle(deadline: number) {
	const now = () => ({ ...ghRunning(), git: gitChildren() });
	const idle = (r: ReturnType<typeof now>) =>
		r.calls.length + r.children.length + r.git.length === 0;
	for (;;) {
		let r = now();
		if (idle(r)) {
			// A read's next step starts in a later tick: look again after one.
			await new Promise((resolve) => setTimeout(resolve, 0));
			r = now();
			if (idle(r)) return r;
		}
		if (Date.now() >= deadline) return r;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export async function registerTestHooks(
	app: FastifyInstance,
	options: {
		token: string;
		registry: SessionRegistry;
		home?: HomeService;
		settleMs?: number;
	},
): Promise<void> {
	const expected = Buffer.from(options.token);
	const allowed = (request: FastifyRequest) => {
		const raw = request.headers[TEST_HOOK_HEADER];
		const given = Buffer.from(typeof raw === "string" ? raw : "");
		return given.length === expected.length && timingSafeEqual(given, expected);
	};
	await app.register(async (scope) => {
		scope.addHook("onRequest", async (request, reply) => {
			if (!allowed(request)) {
				return reply.status(403).send({ error: "Not allowed" });
			}
		});
		scope.post("/api/_test/reset", async (): Promise<ResetAnswer> => {
			const settleMs = options.settleMs ?? RESET_SETTLE_MS;
			const deadline = Date.now() + settleMs;
			// One deadline for it all: a held open or close is a leftover, never a hang.
			const { closed, pending } = await options.registry.reset(settleMs);
			// Home's reads started before this drop their answers (its generation).
			options.home?.reset();
			// Per snapshot, not content alone: a fresh process has none.
			clearSnapshotCaches();
			const left = await settle(deadline);
			return {
				closed,
				ghInFlight: left.calls.length,
				ghChildren: left.children.length,
				gitChildren: left.git.length,
				leftovers: [
					...pending,
					...left.calls,
					...left.children.map((c) => `${c} (process)`),
					...left.git,
				],
			};
		});
		scope.get("/api/_test/state", async (): Promise<TestState> => {
			const gh = ghRunning();
			return {
				sessions: options.registry.openIds(),
				homeRepos: options.home?.cachedRepos() ?? [],
				rss: process.memoryUsage().rss,
				gh: gh.calls,
				ghChildren: gh.children,
				git: gitChildren(),
			};
		});
	});
}
