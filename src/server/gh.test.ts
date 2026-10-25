import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fetchOverview,
	fetchPrMeta,
	GhError,
	parsePrArg,
	runGh,
	slugify,
} from "./gh";

describe("parsePrArg", () => {
	it.each([
		[
			"https://github.com/Acme/Widget/pull/12",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"https://github.com/Acme/Widget/pull/12/",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"https://github.com/Acme/Widget/pull/12/files",
			{ owner: "Acme", repo: "Widget", number: 12 },
		],
		[
			"http://www.github.com/a-b/c.d_e/pull/7?diff=split#x",
			{ owner: "a-b", repo: "c.d_e", number: 7 },
		],
		["  acme/widget#12 ", { owner: "acme", repo: "widget", number: 12 }],
		["a-b/c.d#1", { owner: "a-b", repo: "c.d", number: 1 }],
		["12", { number: 12 }],
	])("parsePrArg(%s)", (arg, expected) => {
		expect(parsePrArg(arg)).toEqual(expected);
	});

	it.each([
		"main",
		"",
		"0",
		"acme/widget",
		"https://gitlab.com/a/b/pull/1",
		"https://github.com/a/b/issues/1",
		"-5",
		"1.5",
		"99999999999999999999",
		"../x#1",
		"-x/y#1",
		"x/.#1",
		"x/..#1",
		"acme/widget#2147483648",
		"a_b/c#1",
		"https://github.com/../x/pull/1",
	])("rejects %j", (arg) => {
		expect(() => parsePrArg(arg)).toThrow(GhError);
	});

	it("names the input in the error", () => {
		expect(() => parsePrArg("main")).toThrow(
			"Not a PR: main. Use a PR URL, owner/repo#123 or a number",
		);
	});
});

describe("slugify", () => {
	it("slugifies logins", () => {
		expect(slugify("Dan_O.Riyan")).toBe("dan-o-riyan");
	});
	it("caps at 64 characters", () => {
		expect(slugify("a".repeat(100))).toHaveLength(64);
	});
});

describe("runGh", () => {
	it("reports a missing gh binary", async () => {
		const saved = process.env.PATH;
		process.env.PATH = "/nonexistent-dir";
		try {
			await expect(runGh(["auth", "status"])).rejects.toThrow(
				"gh is not installed. Install it from https://cli.github.com",
			);
		} finally {
			process.env.PATH = saved;
		}
	});
});

/**
 * A tiny fake `gh` on PATH. Behaviour comes from env vars:
 * FAKE_AUTH=out (auth status fails logged out), FAKE_AUTH=net (fails offline),
 * FAKE_PRVIEW_ERR / FAKE_GQL_ERR (stderr of a failing call), FAKE_VIEW (stdout
 * of `pr view`), FAKE_GQL_DIR (dir with <connection>-<page>.json responses,
 * and body-1.json for the description's bodyHTML).
 * Every call's arguments are appended to FAKE_LOG.
 */
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
"auth status")
  [ "$FAKE_AUTH" = out ] && { echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1; }
  [ "$FAKE_AUTH" = net ] && { echo "error connecting to api.github.com" >&2; exit 1; }
  exit 0 ;;
"pr view")
  [ -n "$FAKE_PRVIEW_ERR" ] && { printf '%s\\n' "$FAKE_PRVIEW_ERR" >&2; exit 1; }
  printf '%s' "$FAKE_VIEW"; exit 0 ;;
"api graphql")
  [ -n "$FAKE_GQL_ERR" ] && { printf '%s\\n' "$FAKE_GQL_ERR" >&2; exit 1; }
  case "$*" in *"{ bodyHTML }"*) c=body;; *"reviewThreads("*) c=reviewThreads;; *"comments(first: 100, after"*) c=comments;; *) c=reviews;; esac
  case "$*" in *endCursor=*) p=2;; *) p=1;; esac
  cat "$FAKE_GQL_DIR/$c-$p.json"; exit 0 ;;
esac
echo "unexpected: $*" >&2; exit 2
`;

describe("runGh with a fake gh", () => {
	let dir: string;
	const saved: Record<string, string | undefined> = {};
	const setEnv = (vars: Record<string, string>) => {
		for (const [k, v] of Object.entries(vars)) {
			if (!(k in saved)) saved[k] = process.env[k];
			process.env[k] = v;
		}
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
		const bin = join(dir, "gh");
		writeFileSync(bin, FAKE_GH);
		chmodSync(bin, 0o755);
		setEnv({
			PATH: `${dir}:/usr/bin:/bin`,
			FAKE_LOG: join(dir, "log"),
			FAKE_AUTH: "",
			FAKE_PRVIEW_ERR: "",
			FAKE_GQL_ERR: "",
		});
		writeFileSync(join(dir, "log"), "");
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	const ref = { owner: "Acme", repo: "Widget", number: 12 };
	const log = () => readFileSync(join(dir, "log"), "utf8");

	it("reports a logged out gh", async () => {
		setEnv({
			FAKE_AUTH: "out",
			FAKE_PRVIEW_ERR:
				"gh: To get started with GitHub CLI, please run:  gh auth login",
		});
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			new GhError("gh is not logged in. Run: gh auth login"),
		);
		await expect(runGh(["auth", "status"])).rejects.toThrow(
			"gh is not logged in. Run: gh auth login",
		);
	});

	it("checks the active account on the right host, not every account", async () => {
		setEnv({
			GH_HOST: "ghe.example.com",
			FAKE_PRVIEW_ERR: "boom",
			FAKE_AUTH: "out",
		});
		await expect(fetchPrMeta(ref)).rejects.toThrow("gh is not logged in");
		expect(log()).toContain("auth status --active --hostname ghe.example.com");
	});

	it("does not call an offline failure 'not logged in'", async () => {
		setEnv({
			FAKE_AUTH: "net",
			FAKE_PRVIEW_ERR: "error connecting to api.github.com\nsecond line",
		});
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			new GhError("error connecting to api.github.com"),
		);
	});

	it("maps a missing PR to a one-line message", async () => {
		setEnv({
			FAKE_PRVIEW_ERR:
				"GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)",
		});
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			new GhError("PR Acme/Widget#12 not found"),
		);
	});

	it("maps a missing PR the same way when the GraphQL call fails first", async () => {
		setEnv({
			FAKE_VIEW: readFileSync("test/fixtures/gh/pr-view.json", "utf8"),
			FAKE_GQL_ERR:
				"GraphQL: Could not resolve to a PullRequest with the number of 12.",
		});
		await expect(fetchOverview(ref, "me")).rejects.toThrow(
			new GhError("PR Acme/Widget#12 not found"),
		);
	});

	it("passes any other failure through as gh's first stderr line", async () => {
		setEnv({ FAKE_PRVIEW_ERR: "HTTP 502: Bad Gateway\nmore detail" });
		await expect(fetchPrMeta(ref)).rejects.toThrow(
			new GhError("HTTP 502: Bad Gateway"),
		);
	});

	it("takes canonical owner/repo from the PR url", async () => {
		setEnv({
			FAKE_VIEW: JSON.stringify({
				number: 12,
				title: "t",
				url: "https://github.com/acme/widget/pull/12",
				state: "OPEN",
				baseRefName: "main",
				headRefName: "f",
				headRefOid: "abc",
				headRepository: { name: "widget" },
				headRepositoryOwner: { login: "fork" },
			}),
		});
		const meta = await fetchPrMeta({
			owner: "ACME",
			repo: "Widget",
			number: 12,
		});
		expect(meta).toMatchObject({
			owner: "acme",
			repo: "widget",
			headRepo: "fork/widget",
			headOid: "abc",
		});
	});

	it("rejects a PR url with an unsafe owner", async () => {
		setEnv({
			FAKE_VIEW: JSON.stringify({
				number: 12,
				url: "https://github.com/../widget/pull/12",
				state: "OPEN",
				baseRefName: "main",
				headRefName: "f",
				headRefOid: "abc",
			}),
		});
		await expect(fetchPrMeta(ref)).rejects.toThrow(GhError);
	});

	it("follows pagination for review threads", async () => {
		const page = (nodes: unknown[], next: boolean) =>
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								pageInfo: { hasNextPage: next, endCursor: "c1" },
								nodes,
							},
							comments: { pageInfo: { hasNextPage: false }, nodes: [] },
							reviews: { pageInfo: { hasNextPage: false }, nodes: [] },
						},
					},
				},
			});
		const thread = (path: string) => ({
			isResolved: false,
			isOutdated: false,
			path,
			line: 1,
			first: {
				nodes: [
					{
						author: { login: "a", __typename: "User" },
						bodyText: "b",
						bodyHTML: "<p>b</p>",
						createdAt: "",
					},
				],
			},
			comments: {
				totalCount: 1,
				nodes: [{ author: { login: "a", __typename: "User" } }],
			},
		});
		const gql = join(dir, "gql");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(gql);
		for (const c of ["reviewThreads", "comments", "reviews"]) {
			writeFileSync(
				join(gql, `${c}-1.json`),
				page(
					c === "reviewThreads" ? [thread("one.ts")] : [],
					c === "reviewThreads",
				),
			);
		}
		writeFileSync(
			join(gql, "reviewThreads-2.json"),
			page([thread("two.ts")], false),
		);
		writeFileSync(
			join(gql, "body-1.json"),
			JSON.stringify({
				data: { repository: { pullRequest: { bodyHTML: "<p>Hi</p>" } } },
			}),
		);
		setEnv({
			FAKE_GQL_DIR: gql,
			FAKE_VIEW: readFileSync("test/fixtures/gh/pr-view.json", "utf8"),
		});
		const o = await fetchOverview(ref, "me");
		expect(o.threads.map((t) => t.path)).toEqual(["one.ts", "two.ts"]);
		expect(o.bodyHtml).toBe("<p>Hi</p>");
		// One description query; the threads query paged twice.
		expect(log().match(/\{ bodyHTML \}/g)).toHaveLength(1);
		expect(log().match(/reviewThreads\(/g)).toHaveLength(2);
		// Text and code only for each thread's opening comment; the latest
		// one's time; authors for the rest.
		expect(log()).toContain(
			"path subjectType line originalLine originalStartLine diffSide startDiffSide first: comments(first: 1) { nodes { author { login __typename } bodyText bodyHTML createdAt diffHunk originalCommit { oid } } }",
		);
		expect(log()).toContain(
			"latest: comments(last: 1) { nodes { createdAt } }",
		);
		expect(log()).toContain(
			"comments(first: 100) { totalCount nodes { author { login __typename } createdAt } }",
		);
	});

	it("fails rather than show an empty description when bodyHTML is missing", async () => {
		const gql = join(dir, "gql");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(gql);
		const empty = (c: string) =>
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							[c]: { pageInfo: { hasNextPage: false }, nodes: [] },
						},
					},
				},
			});
		for (const c of ["reviewThreads", "comments", "reviews"]) {
			writeFileSync(join(gql, `${c}-1.json`), empty(c));
		}
		writeFileSync(
			join(gql, "body-1.json"),
			JSON.stringify({ data: { repository: { pullRequest: {} } } }),
		);
		setEnv({
			FAKE_GQL_DIR: gql,
			FAKE_VIEW: readFileSync("test/fixtures/gh/pr-view.json", "utf8"),
		});
		await expect(fetchOverview(ref, "me")).rejects.toThrow(
			"unexpected response for the PR body",
		);
	});
});
