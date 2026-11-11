import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOOK_HEADER } from "../src/server/testHooks";
import { type Span, traceparent, tracer } from "../src/server/trace";
import {
	type FakeGhRouter,
	fakeGhEnv,
	writeRouter,
} from "../test/fake-gh/scenario";
import { fakeGhServerCalls } from "../test/fake-gh/server.mjs";
import { type Served, startServe, stopChild } from "./crb-process";
import { crbEnv } from "./pr-setup";

/*
 * One `crb serve` per Playwright worker, shared by its tests in turn
 * (CAR-106, `crbServer: "shared"` in fixtures.ts). What keeps a test from
 * seeing another's:
 * - its own repo and PR number (`acme/widget-<worker>-<seq>#<n>`): its
 *   clone, review ids, refs and fake thread ids are its own;
 * - the fake gh's router (test/fake-gh/route.mjs): a gh call goes to the
 *   scenario of the test that owns its repo; one for a finished test's repo,
 *   or with no test running, is a stray: refused and logged;
 * - after each test (`finish`), the server's test-only reset
 *   (src/server/testHooks.ts) and checks that nothing leaked: the reset
 *   left nothing running, the fake gh runs no call, no stray gh call, the
 *   config dir unchanged. A leak fails the test that leaked, and the server
 *   is thrown away so the next test starts clean.
 */

/** Restart a shared server whose RSS grew this much past its first test's. */
const RECYCLE_GROWTH = 256 * 1024 * 1024;
/** How long the fake gh may take to end calls the reset killed. */
const GH_SETTLE_MS = 3000;
/** The reset's own bound (RESET_SETTLE_MS) plus room for a loaded machine. */
const RESET_TIMEOUT_MS = 20_000;

/** A sha256 over the files under `dir` (paths and contents); "" when none. */
export function dirHash(dir: string): string {
	if (!existsSync(dir)) return "";
	const hash = createHash("sha256");
	const files = (readdirSync(dir, { recursive: true }) as string[])
		.filter((f) => statSync(join(dir, f)).isFile())
		.sort();
	for (const f of files) {
		hash.update(`${f}\0`);
		hash.update(readFileSync(join(dir, f)));
		hash.update("\0");
	}
	return files.length ? hash.digest("hex") : "";
}

/** The last `n` lines of `text`, for a message (a server's output grows all its life). */
export function tail(text: string, n = 200): string {
	const lines = text.trimEnd().split("\n");
	return lines.length <= n
		? lines.join("\n")
		: [`… (${lines.length - n} lines before)`, ...lines.slice(-n)].join("\n");
}

/** The files under `dir`, for a message. */
function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

/** What a shared test tells `finish`. */
export interface SharedTest {
	title: string;
	/** Its scenario and gh log (the router's `current`). */
	scenario: string;
	log: string;
	/** Its repos (owner/repo). */
	repos: string[];
}

export interface SharedServerState {
	sessions: string[];
	rss: number;
	gh: string[];
	git: string[];
}

/** A worker's shared `crb serve`, started on first use. */
export class SharedServer {
	readonly root = mkdtempSync(join(tmpdir(), "crb-e2e-shared-"));
	readonly router = join(this.root, "fake-gh-router.json");
	readonly strays = join(this.root, "strays.log");
	readonly #token = randomBytes(16).toString("hex");
	#served: Served | null = null;
	/** Its dirs (cache, state, config): one per server, so a restart starts clean. */
	#dir = "";
	#starts = 0;
	#tests = 0;
	#firstRss = 0;
	#strayOffset = 0;
	#configHash = "";
	#finished: Record<string, string> = {};
	/** Strays that came between tests: no test's to fail, so the worker's (close). */
	#between: string[] = [];
	/**
	 * The worker's span, in a trace of its own: the shared server's parent,
	 * so each test's requests (their traceparent another trace) nest under
	 * the test, the first test's too.
	 */
	#span: Span | null = null;
	#seq = 0;

	constructor(readonly worker: number) {
		writeRouter(this.router, { router: 1 });
	}

	/** A test's repo and PR number, distinct from every other test's in this worker. */
	nextPr(): { ownerRepo: string; number: number } {
		const seq = ++this.#seq;
		return {
			ownerRepo: `acme/widget-${this.worker}-${seq}`,
			number: 100 + seq,
		};
	}

	/** The env a gh call of the shared server gets: its router, its stray log. */
	ghEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,
			...fakeGhEnv(),
			CRB_FAKE_GH: this.router,
			CRB_FAKE_GH_LOG: this.strays,
		};
	}

	/** The running server, if any. */
	get served(): Served | null {
		return this.#served;
	}

	get configDir(): string {
		return join(this.#dir, "config");
	}

	/** Whether the server needs starting (none yet, or it was discarded). */
	get idle(): boolean {
		return this.#served === null;
	}

	/** Stray log lines since the last look. */
	#freshStrays(): string[] {
		const strays = existsSync(this.strays)
			? readFileSync(this.strays, "utf8")
			: "";
		const fresh = strays.slice(this.#strayOffset);
		this.#strayOffset = strays.length;
		return fresh.split("\n").filter((l) => l.trim());
	}

	/** The test running now: its gh calls go to its scenario from here on. */
	begin(test: SharedTest): void {
		// Strays since the last test's checks aren't this test's: the worker
		// reports them (close).
		for (const line of this.#freshStrays()) {
			this.#between.push(`${line} (before '${test.title}' began)`);
		}
		const router: FakeGhRouter = {
			router: 1,
			current: {
				test: test.title,
				scenario: test.scenario,
				log: test.log,
				repos: test.repos,
			},
			finished: this.#finished,
		};
		writeRouter(this.router, router);
	}

	/**
	 * Starts the server, unless it runs. Throws, with its output, when the
	 * one this worker had has died: it is replaced first, so the next test
	 * finds one running.
	 */
	async start(): Promise<Served> {
		const dead = this.#served && !alive(this.#served);
		const died = dead ? tail((this.#served as Served).output()) : null;
		if (dead) this.#served = null;
		if (!this.#served) {
			this.#dir = join(this.root, `s${++this.#starts}`);
			mkdirSync(this.#dir);
			const env: NodeJS.ProcessEnv = {
				...crbEnv(this.#dir),
				CRB_FAKE_GH: this.router,
				CRB_FAKE_GH_LOG: this.strays,
				CRB_TEST_HOOKS: this.#token,
			};
			this.#span ??= tracer("playwright-worker").start(
				"e2e: shared crb serve",
				{ "crb.kind": "shared-server" },
				{ parent: null },
			);
			if (this.#span.context) {
				env.TRACEPARENT = traceparent(this.#span.context);
			} else {
				delete env.TRACEPARENT;
			}
			this.#served = await startServe(this.#dir, [], env);
			this.#firstRss = 0;
			this.#configHash = dirHash(this.configDir);
		}
		if (died !== null) {
			throw new Error(
				`the worker's shared crb serve had died (a new one runs now); its output:\n${died}`,
			);
		}
		return this.#served;
	}

	/** POST /api/_test/reset (or GET /state) on the running server. */
	async #hook(path: string, method: "POST" | "GET"): Promise<unknown> {
		const served = this.#served as Served;
		const headers: Record<string, string> = {
			[TEST_HOOK_HEADER]: this.#token,
		};
		const parent = process.env.TRACEPARENT;
		if (parent) headers.traceparent = parent;
		const res = await fetch(`${new URL(served.url).origin}${path}`, {
			method,
			headers,
			signal: AbortSignal.timeout(RESET_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
		return res.json();
	}

	/** The server's GET /api/_test/state (which also writes its buffered spans). */
	async state(): Promise<SharedServerState> {
		return (await this.#hook("/api/_test/state", "GET")) as SharedServerState;
	}

	/**
	 * After a test that used the server: resets it and checks that nothing
	 * of the test is left. Returns the leaks found (none: []). `expected`
	 * leaks (the canaries in fixtures.spec.ts) are taken out of the list, and
	 * one expected but not found is a problem of its own. On any leak, or a
	 * server grown too big, the server is stopped: the next test starts one.
	 */
	async finish(test: SharedTest, expected: RegExp[]): Promise<string[]> {
		let problems: string[] = [];
		const served = this.#served;
		let state: SharedServerState | null = null;
		if (served && !alive(served)) {
			problems.push(
				`the shared crb serve died; its output:\n${tail(served.output())}`,
			);
			this.#served = null;
		} else if (served) {
			let reset = true;
			try {
				const answer = (await this.#hook("/api/_test/reset", "POST")) as {
					leftovers: string[];
				};
				if (answer.leftovers.length > 0) {
					problems.push(
						`the reset left these running: ${answer.leftovers.join("; ")}`,
					);
				}
			} catch (error) {
				reset = false;
				problems.push(
					`the reset failed: ${(error as Error).message}; crb serve's output:\n${tail(served.output(), 50)}`,
				);
			}
			const until = Date.now() + GH_SETTLE_MS;
			while (fakeGhServerCalls().running > 0 && Date.now() < until) {
				await new Promise((r) => setTimeout(r, 20));
			}
			const running = fakeGhServerCalls().running;
			if (running > 0) {
				problems.push(`the fake gh still runs ${running} call(s)`);
			}
			// One hang is enough: a server that didn't reset isn't asked again.
			if (reset) {
				try {
					state = await this.state();
					if (state.sessions.length > 0) {
						problems.push(
							`sessions open after the reset: ${state.sessions.join(", ")}`,
						);
					}
				} catch (error) {
					problems.push(`the state route failed: ${(error as Error).message}`);
				}
			}
		}
		if (this.#dir && dirHash(this.configDir) !== this.#configHash) {
			problems.push(
				`crb serve's config dir changed (a test that writes config takes test.use({ crbServer: "own" })): ${filesUnder(this.configDir).join(", ")}`,
			);
		}
		// A leak takes the server with it, before anything else: what leaked
		// (a git in the clone, a held open) stops with it. No graceful stop:
		// the leak may hold it up.
		if (problems.length > 0) await this.discard(true);
		// The test is over: its repos are finished, a gh call for one a stray.
		this.end(test);
		if (this.#dir) {
			try {
				rmSync(join(this.#dir, "cache", "carbonless", "repos"), {
					recursive: true,
					force: true,
					maxRetries: 3,
				});
			} catch (error) {
				problems.push(
					`could not delete the clones: ${(error as Error).message}`,
				);
			}
		}
		// One problem per stray: an expected one takes no other with it.
		for (const line of this.#freshStrays()) {
			problems.push(`stray gh call: ${line}`);
		}
		if (problems.length > 0) await this.discard(true);
		this.#tests++;
		if (state) this.#record(state, test);
		for (const pattern of expected) {
			const at = problems.findIndex((p) => pattern.test(p));
			if (at === -1) {
				problems.push(`expected a leak matching ${pattern}, none was found`);
			} else {
				problems = problems.filter((_, i) => i !== at);
			}
		}
		if (
			this.#served &&
			state &&
			this.#firstRss > 0 &&
			state.rss > this.#firstRss + RECYCLE_GROWTH
		) {
			await this.discard();
		}
		return problems;
	}

	/** After a shared test that never opened on the server: its repos are finished. */
	end(test: SharedTest): void {
		for (const repo of test.repos)
			this.#finished[repo.toLowerCase()] = test.title;
		writeRouter(this.router, { router: 1, finished: this.#finished });
	}

	/** RSS and open sessions after each test, in the test's trace and the worker's. */
	#record(state: SharedServerState, test: SharedTest): void {
		if (this.#firstRss === 0) this.#firstRss = state.rss;
		const traced = tracer("playwright-worker");
		const attrs = {
			"crb.kind": "shared-server-state",
			"crb.test": test.title,
			rss: state.rss,
			sessions: state.sessions.length,
			tests: this.#tests,
			starts: this.#starts,
		};
		traced.start("crb shared state", attrs).end();
		this.#span?.set({
			rss: state.rss,
			tests: this.#tests,
			starts: this.#starts,
		});
	}

	/**
	 * Stops the server (`kill`: at once, else SIGTERM, killing it if it
	 * must): the next test starts a new one.
	 */
	async discard(kill = false): Promise<void> {
		const served = this.#served;
		this.#served = null;
		if (!served || !alive(served)) return;
		if (kill) {
			const exited = new Promise((r) => served.child.once("exit", r));
			served.child.kill("SIGKILL");
			await exited;
			return;
		}
		await stopChild(served.child).catch(() => {
			if (alive(served)) served.child.kill("SIGKILL");
		});
	}

	/**
	 * Worker teardown: stops the server and removes its files. Throws (the
	 * run fails) on strays no test was running for: between tests, or after
	 * the last.
	 */
	async close(): Promise<void> {
		await this.discard();
		this.#span?.end({ tests: this.#tests, starts: this.#starts });
		tracer("playwright-worker").flush();
		const strays = [
			...this.#between,
			...this.#freshStrays().map((l) => `${l} (after the last test)`),
		];
		rmSync(this.root, { recursive: true, force: true });
		if (strays.length > 0) {
			throw new Error(
				`stray gh calls on the worker's shared crb serve, outside any test:\n- ${strays.join("\n- ")}`,
			);
		}
	}
}

function alive(served: Served): boolean {
	return served.child.exitCode === null && served.child.signalCode === null;
}
