import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoOf } from "../../test/fake-gh/route.mjs";
import {
	type FakeGhRouter,
	fakeGhEnv,
	prView,
	release,
	type Scenario,
	writeRouter,
} from "../../test/fake-gh/scenario";
import { fakeGhServerCalls } from "../../test/fake-gh/server.mjs";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";

// Fake-gh processes: see GIT_TEST_TIMEOUTS.
vi.setConfig(GIT_TEST_TIMEOUTS);

const GH_MJS = resolve(import.meta.dirname, "../../test/fake-gh/gh.mjs");

const graphql = (query: string, fields: Record<string, string> = {}) => [
	"api",
	"graphql",
	"-f",
	`query=${query}`,
	...Object.entries(fields).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
];
const R = { owner: "acme", name: "widget-1-3" };
const REPO = "acme/widget-1-3";
const PR_Q = (inner: string, vars = "") =>
	`query($owner: String!, $name: String!, $number: Int!${vars}) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${inner} } } }`;

/**
 * One sample of every call form gh.mjs answers, with the repos the router
 * must find in it ("none": about no one repo, so the current test's).
 */
const FORMS: [string, string[], string[] | "none"][] = [
	["auth status", ["auth", "status"], "none"],
	[
		"auth status of a host (gh.ts's logged-out check)",
		["auth", "status", "--active", "--hostname", "github.com"],
		"none",
	],
	["api user", ["api", "user"], "none"],
	[
		"repo view (the cwd's remote)",
		["repo", "view", "--json", "nameWithOwner"],
		"none",
	],
	[
		"repo clone",
		["repo", "clone", REPO, "/c/widget.git", "--", "--bare", "--quiet"],
		[REPO],
	],
	["pr view", ["pr", "view", "7", "-R", REPO, "--json", "title"], [REPO]],
	[
		"search prs",
		[
			"search",
			"prs",
			"--repo",
			REPO,
			"--limit",
			"30",
			"--sort",
			"updated",
			"--json",
			"number",
			"--",
			"-R",
			"acme/other",
		],
		[REPO],
	],
	[
		"REST reply",
		[
			"api",
			"-X",
			"POST",
			`repos/${REPO}/pulls/7/comments/1000/replies`,
			"-H",
			"Accept: application/vnd.github.full+json",
			"--input",
			"-",
		],
		[REPO],
	],
	[
		"REST edit",
		["api", "-X", "PATCH", `repos/${REPO}/pulls/comments/1000`, "--input", "-"],
		[REPO],
	],
	[
		"REST delete",
		["api", "-X", "DELETE", `repos/${REPO}/pulls/comments/1000`],
		[REPO],
	],
	["REST comment read", ["api", `repos/${REPO}/pulls/comments/1000`], [REPO]],
	[
		"REST new thread",
		["api", "-X", "POST", `repos/${REPO}/pulls/7/comments`, "--input", "-"],
		[REPO],
	],
	[
		"REST compare",
		[
			"api",
			`repos/${REPO}/compare/main...abcdef1?per_page=1&page=2`,
			"--jq",
			".merge_base_commit.sha",
		],
		[REPO],
	],
	[
		"REST verdict",
		["api", "-X", "POST", `repos/${REPO}/pulls/7/reviews`, "--input", "-"],
		[REPO],
	],
	[
		"REST reviews",
		["api", `repos/${REPO}/pulls/7/reviews`, "--paginate", "--slurp"],
		[REPO],
	],
	[
		"REST dismissal",
		[
			"api",
			"-X",
			"PUT",
			`repos/${REPO}/pulls/7/reviews/5/dismissals`,
			"--input",
			"-",
		],
		[REPO],
	],
	["REST branch", ["api", `repos/${REPO}/branches/main`], [REPO]],
	[
		"REST protection",
		["api", `repos/${REPO}/branches/main/protection`],
		[REPO],
	],
	[
		"REST rules",
		["api", `repos/${REPO}/rules/branches/main`, "--paginate", "--slurp"],
		[REPO],
	],
	[
		"REST review comments",
		["api", `repos/${REPO}/pulls/7/comments`, "--paginate", "--slurp"],
		[REPO],
	],
	[
		"GraphQL verdict read",
		graphql(PR_Q("mergeStateStatus reviewDecision isRequired"), {
			...R,
			number: "7",
		}),
		[REPO],
	],
	["GraphQL viewer", graphql("query { viewer { login avatarUrl } }"), "none"],
	[
		"GraphQL viewer's orgs",
		graphql(
			"query { viewer { organizations(first: 100) { nodes { login } } } }",
		),
		"none",
	],
	[
		"GraphQL viewer's teams",
		graphql(
			"query { viewer { organizations(first: 100) { nodes { login teams(first: 100) { nodes { slug } } } } } }",
		),
		"none",
	],
	[
		"GraphQL org members",
		graphql(
			"query($org: String!, $cursor: String) { organization(login: $org) { membersWithRole(first: 100, after: $cursor) { nodes { login } } } }",
			{ org: "acme" },
		),
		"none",
	],
	[
		"GraphQL user search",
		graphql(
			"query($q: String!) { search(query: $q, type: USER, first: 10) { nodes { login } } }",
			{ q: "oct type:user" },
		),
		"none",
	],
	[
		"GraphQL viewer's repos",
		graphql(
			"query($cursor: String) { viewer { repositories(first: 100, after: $cursor, affiliations: [OWNER], ownerAffiliations: [OWNER]) { nodes { nameWithOwner } } } }",
		),
		"none",
	],
	[
		"GraphQL repo exists",
		graphql(
			"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }",
			R,
		),
		[REPO],
	],
	[
		"GraphQL Home's PR list",
		graphql(
			"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { open: pullRequests(states: OPEN, first: 50) { nodes { number } } } }",
			R,
		),
		[REPO],
	],
	[
		"GraphQL Home's details, by alias",
		graphql(
			'query { r0: repository(owner: "acme", name: "Widget-1-3") { p7: pullRequest(number: 7) { ...F } } r1: repository(owner: "acme", name: "api") { p3: pullRequest(number: 3) { ...F } } } fragment F on PullRequest { title }',
		),
		[REPO, "acme/api"],
	],
	[
		"GraphQL resolve",
		graphql(
			"mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
			{ id: "T7-0" },
		),
		"none",
	],
	[
		"GraphQL a thread by id",
		graphql(
			"query($id: ID!) { node(id: $id) { ... on PullRequestReviewThread { id } } }",
			{ id: "T7-0" },
		),
		"none",
	],
	[
		"GraphQL a review's comments",
		graphql(
			"query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequestReview { comments(first: 100, after: $endCursor) { nodes { id } } } } }",
			{ id: "R1", endCursor: "cursor:100" },
		),
		"none",
	],
	[
		"GraphQL threads' comment pages, by alias",
		graphql(
			'query { t0: node(id: "T7-0") { ... on PullRequestReviewThread { comments(first: 100, after: "cursor:100") { nodes { id } } } } }',
		),
		"none",
	],
	[
		"GraphQL threads' contents",
		graphql(
			'query { nodes(ids: ["T7-0", "T7-1"]) { ... on PullRequestReviewThread { comments(first: 100) { nodes { bodyHTML } } } } }',
		),
		"none",
	],
	[
		"GraphQL timeline",
		graphql(
			PR_Q(
				"timelineItems(first: 100, skip: $skip) { nodes { __typename } }",
				", $skip: Int!",
			),
			{ ...R, number: "7", skip: "0" },
		),
		[REPO],
	],
	[
		"GraphQL a connection's page",
		graphql(
			PR_Q(
				"reviewThreads(first: 100, after: $endCursor) { nodes { id } }",
				", $endCursor: String",
			),
			{ ...R, number: "7" },
		),
		[REPO],
	],
	[
		"GraphQL a connection's last page",
		graphql(PR_Q("commits(last: 1) { nodes { commit { oid } } }"), {
			...R,
			number: "7",
		}),
		[REPO],
	],
	[
		"GraphQL the description",
		graphql(PR_Q("bodyHTML"), { ...R, number: "7" }),
		[REPO],
	],
];

describe("the fake gh's router: which repo a call is about", () => {
	it.each(FORMS)("%s", (_name, args, repos) => {
		expect(repoOf(args)).toEqual(
			repos === "none" ? { kind: "none" } : { kind: "repos", repos },
		);
	});

	it("doesn't place a form it doesn't know: the router makes it a stray", () => {
		for (const args of [
			["issue", "list", "-R", REPO],
			["api", "orgs/acme/members"],
			["api", "-X", "POST", "graphql"],
			["pr", "view", "7", "--json", "title"],
			["repo", "clone", "not-a-slug", "/c"],
			// A query over a repo's variables, called without them.
			graphql(PR_Q("bodyHTML"), { number: "7" }),
			graphql(PR_Q("bodyHTML"), { owner: "acme", number: "7" }),
		]) {
			expect(repoOf(args), args.join(" ")).toEqual({ kind: "unknown" });
		}
	});

	/**
	 * gh.mjs's recognizers, read from its source: a new form added there
	 * without a sample above (and so, maybe, without a place in route.mjs)
	 * fails here.
	 */
	describe("every form gh.mjs answers has a sample", () => {
		const source = readFileSync(GH_MJS, "utf8");
		const literal = String.raw`(\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[gimsuy]*)`;
		const evalRegex = (text: string) => {
			const m = /^\/(.*)\/([a-z]*)$/s.exec(text);
			if (!m) throw new Error(`not a regex literal: ${text}`);
			return new RegExp(m[1] as string, (m[2] as string).replace("g", ""));
		};
		const queries = FORMS.flatMap(([, args]) =>
			args[1] === "graphql"
				? args.filter((a) => a.startsWith("query=")).map((a) => a.slice(6))
				: [],
		);
		const restPaths = FORMS.flatMap(([, args]) =>
			args[0] === "api" && args[1] !== "graphql"
				? [(args[1] === "-X" ? args[3] : args[1]) ?? ""]
				: [],
		);

		it("each REST path pattern", () => {
			const patterns = [
				...source.matchAll(new RegExp(`${literal}(?=\\.exec\\()`, "g")),
			]
				.map((m) => m[1] as string)
				.filter((p) => p.startsWith("/^repos"));
			expect(patterns.length).toBeGreaterThan(8);
			for (const p of patterns) {
				const re = evalRegex(p);
				expect(
					restPaths.some((path) => re.test(path)),
					p,
				).toBe(true);
			}
		});

		it("each GraphQL query recognizer", () => {
			const patterns = [
				...source.matchAll(
					new RegExp(
						`${literal}\\.(?:test|exec)\\(\\s*f\\.query|f\\.query\\.matchAll\\(\\s*${literal}`,
						"g",
					),
				),
			].map((m) => (m[1] ?? m[2]) as string);
			const includes = [
				...source.matchAll(
					/f\.query(?: \?\? "")?\)?\??\.includes\("([^"]+)"\)/g,
				),
			].map((m) => m[1] as string);
			expect(patterns.length).toBeGreaterThan(15);
			for (const p of patterns) {
				const re = evalRegex(p);
				expect(
					queries.some((q) => re.test(q)),
					p,
				).toBe(true);
			}
			for (const text of includes) {
				expect(
					queries.some((q) => q.includes(text)),
					text,
				).toBe(true);
			}
		});

		it("each command", () => {
			const known = /const known = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
			const commands = [...known.matchAll(/"([^"]+)"/g)].map(
				(m) => m[1] as string,
			);
			// Answered before the list: Home's PR search.
			commands.push("search prs");
			expect(commands.length).toBeGreaterThan(5);
			const sampled = new Set(FORMS.map(([, args]) => `${args[0]} ${args[1]}`));
			for (const c of commands) expect(sampled.has(c), c).toBe(true);
		});
	});
});

/** The router, run through the fake gh as crb runs it (the shim and its server, or a process). */
describe("the fake gh's router", () => {
	let tmp: string;
	let routerPath: string;
	const scenarioOf = (name: string, over: Partial<Scenario> = {}) => {
		const path = join(tmp, `${name}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				repoPath: tmp,
				user: { login: `user-${name}` },
				nameWithOwner: `acme/${name}`,
				prs: { "7": { view: prView({ title: `PR of ${name}` }) } },
				...over,
			} satisfies Scenario),
		);
		return path;
	};
	const route = (r: Omit<FakeGhRouter, "router">) =>
		writeRouter(routerPath, { router: 1, strays: "strays.log", ...r });
	const current = (
		name: string,
		extra: Partial<NonNullable<FakeGhRouter["current"]>> = {},
	) => ({
		test: `test ${name}`,
		scenario: `${name}.json`,
		log: `${name}.log`,
		...extra,
	});
	const read = (name: string) => {
		const path = join(tmp, name);
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	};
	const env = (server = true) => ({
		...process.env,
		...fakeGhEnv(),
		...(server ? {} : { CRB_FAKE_GH_SERVER: "" }),
		CRB_FAKE_GH: routerPath,
		CRB_FAKE_GH_LOG: join(tmp, "unused.log"),
	});
	const gh = (args: string[], server = true) => {
		const r = spawnSync("gh", args, {
			env: env(server),
			cwd: tmp,
			encoding: "utf8",
		});
		return { code: r.status, out: r.stdout, err: r.stderr };
	};
	const view = (repo: string, server = true) =>
		gh(["pr", "view", "7", "-R", repo, "--json", "title"], server);

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "crb-fake-gh-route-"));
		routerPath = join(tmp, "router.json");
		scenarioOf("widget-1-2");
		scenarioOf("widget-1-3");
	});
	afterEach(async () => {
		await vi.waitFor(() => expect(fakeGhServerCalls().running).toBe(0));
		rmSync(tmp, { recursive: true, force: true });
	});

	it.each([
		["through its server", true],
		["in a process of its own", false],
	])(
		"sends the current test's calls to its scenario and log, %s",
		(_n, server) => {
			route({
				current: current("widget-1-3"),
				finished: { "acme/widget-1-2": "test widget-1-2" },
			});
			expect(view("acme/widget-1-3", server)).toEqual({
				code: 0,
				out: `${JSON.stringify({ title: "PR of widget-1-3" })}\n`,
				err: "",
			});
			// No repo: the current test's.
			expect(JSON.parse(gh(["api", "user"], server).out)).toEqual({
				login: "user-widget-1-3",
			});
			expect(read("widget-1-3.log")).toBe(
				"pr view 7 -R acme/widget-1-3 --json title\napi user\n",
			);
			expect(read("unused.log")).toBe("");
			expect(read("strays.log")).toBe("");
		},
	);

	it("each test's calls go to its own log, the next test's to its", () => {
		route({ current: current("widget-1-2") });
		expect(view("acme/widget-1-2").code).toBe(0);
		route({
			current: current("widget-1-3"),
			finished: { "acme/widget-1-2": "test widget-1-2" },
		});
		expect(view("acme/widget-1-3").code).toBe(0);
		expect(read("widget-1-2.log")).toBe(
			"pr view 7 -R acme/widget-1-2 --json title\n",
		);
		expect(read("widget-1-3.log")).toBe(
			"pr view 7 -R acme/widget-1-3 --json title\n",
		);
	});

	it("a finished test's repo is a stray: exit 1 naming it and its test, never served", () => {
		route({
			current: current("widget-1-3"),
			finished: { "acme/widget-1-2": "test widget-1-2" },
		});
		const r = view("acme/Widget-1-2");
		expect(r.code).toBe(1);
		expect(r.out).toBe("");
		expect(r.err).toContain(
			"stray call for acme/widget-1-2 (test 'test widget-1-2', finished)",
		);
		expect(read("strays.log")).toContain(
			"stray call for acme/widget-1-2 (test 'test widget-1-2', finished): gh pr view 7 -R acme/Widget-1-2",
		);
		expect(read("widget-1-3.log")).toBe("");
		expect(read("widget-1-2.log")).toBe("");
	});

	it("any other repo, a call with no test running, and an unknown form are strays", () => {
		route({ current: current("widget-1-3") });
		expect(view("acme/other").err).toContain(
			"stray call for acme/other (no test's repo)",
		);
		expect(gh(["issue", "list"]).err).toContain(
			"(a call the router can't place)",
		);
		route({ finished: { "acme/widget-1-3": "test widget-1-3" } });
		const r = gh(["api", "user"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("stray call for no repo (no test running)");
		expect(read("strays.log").trim().split("\n")).toHaveLength(3);
		expect(read("widget-1-3.log")).toBe("");
	});

	it("without a stray log in the router, strays go to $CRB_FAKE_GH_LOG", () => {
		writeRouter(routerPath, { router: 1, current: current("widget-1-3") });
		expect(view("acme/other").code).toBe(1);
		expect(read("unused.log")).toContain("stray call for acme/other");
	});

	it("the current test owns its scenario's repos and the router's list", () => {
		scenarioOf("widget-1-3", {
			repos: { "acme/api": { prs: [] } },
			viewerRepos: [{ name: "acme/lib", relation: "OWNER" }],
		} as Partial<Scenario>);
		route({ current: current("widget-1-3", { repos: ["acme/extra"] }) });
		for (const repo of [
			"acme/api",
			"acme/lib",
			"acme/extra",
			"ACME/WIDGET-1-3",
		]) {
			expect(view(repo).err, repo).not.toContain("stray");
		}
		// A query over two repos is a stray if either isn't the test's.
		const both = gh(
			graphql(
				'query { r0: repository(owner: "acme", name: "api") { p7: pullRequest(number: 7) { ...F } } r1: repository(owner: "acme", name: "nope") { p3: pullRequest(number: 3) { ...F } } } fragment F on PullRequest { title }',
			),
		);
		expect(both.err).toContain("stray call for acme/nope");
	});

	it("a gate holds on the test's own scenario file, and release() lets it go", async () => {
		const scenario = scenarioOf("widget-1-3", { hold: ["prView"] });
		route({ current: current("widget-1-3") });
		const child = spawn(
			"gh",
			["pr", "view", "7", "-R", REPO, "--json", "title"],
			{
				env: env(),
				cwd: tmp,
			},
		);
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		const exited = new Promise((r) => child.on("close", r));
		await vi.waitFor(() => expect(read("widget-1-3.log")).toContain("pr view"));
		expect(out).toBe("");
		release(scenario, "prView");
		await expect(exited).resolves.toBe(0);
		expect(JSON.parse(out)).toEqual({ title: "PR of widget-1-3" });
		// The router file is never written by a call.
		expect(JSON.parse(readFileSync(routerPath, "utf8")).current.scenario).toBe(
			"widget-1-3.json",
		);
	});

	it("a write saves the test's scenario (failNext used up), not the router", () => {
		scenarioOf("widget-1-3", {
			failNext: { op: "verdict", status: 502 },
		} as Partial<Scenario>);
		route({ current: current("widget-1-3") });
		const before = readFileSync(routerPath, "utf8");
		const r = spawnSync(
			"gh",
			["api", "-X", "POST", `repos/${REPO}/pulls/7/reviews`, "--input", "-"],
			{
				env: env(),
				cwd: tmp,
				encoding: "utf8",
				input: JSON.stringify({ event: "COMMENT", body: "x" }),
			},
		);
		expect(r.status).toBe(1);
		expect(
			JSON.parse(readFileSync(join(tmp, "widget-1-3.json"), "utf8")).failNext,
		).toBeUndefined();
		expect(readFileSync(routerPath, "utf8")).toBe(before);
	});

	it("a plain scenario file works as before, logging to $CRB_FAKE_GH_LOG", () => {
		const r = spawnSync("gh", ["api", "user"], {
			env: { ...env(), CRB_FAKE_GH: join(tmp, "widget-1-3.json") },
			cwd: tmp,
			encoding: "utf8",
		});
		expect(JSON.parse(r.stdout)).toEqual({ login: "user-widget-1-3" });
		expect(read("unused.log")).toBe("api user\n");
	});
});
