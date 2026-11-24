import { acpLog } from "../test/fake-acp/scenario";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { CALC, chip, expect, fixture, reviewDrawer, test } from "./agent-ui";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * The agent reads the review through crb (CAR-182): asked about the whole
 * review, the spawned fake agent reads `review`, `diff` and `file` over
 * crb's MCP, then answers. What it got is in the fake agent's log: the
 * PR's diff with crb's analysis, a file's lines, the patch sets and the
 * GitHub thread's place on the head.
 */

type Logged = { error: boolean; value: Record<string, unknown> };

test("asked about the whole review, the agent reads the diff, a file and the review's threads at the head through crb", async ({
	page,
	pr,
	agentCrb,
	acpLogPath,
	isMobile,
}) => {
	// An agent turn of several MCP calls: past 30 s on a loaded machine.
	test.slow();
	const p = await pr(fixture);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: CALC, line: 3, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Is total right?", commit: head }),
			]),
		];
	});
	const s = await agentCrb({
		scenario: {
			agent: { name: "Fake Agent", version: "9.9.9" },
			answers: [{ text: "One change: `total` in src/calc.ts:3." }],
			mcp: {
				tools: [
					"review",
					"diff",
					{ name: "file", args: { path: CALC, startLine: 3, endLine: 3 } },
					{ name: "file", args: { path: "--output=x" } },
				],
			},
		},
	});
	await page.goto(s.url);
	await chip(page).click();
	const drawer = reviewDrawer(page);
	const box = drawer.getByRole("textbox", { name: "Ask agent" });
	await box.fill("Walk me through this PR");
	if (isMobile) {
		await drawer.getByRole("button", { name: "Send to agent" }).click();
	} else await box.press("Control+Enter");
	await expect(drawer.getByTestId("agent-message-ai")).toHaveText(
		"One change: total in src/calc.ts:3.",
	);
	const calls = acpLog(acpLogPath).filter((e) =>
		String(e.method).startsWith("mcp/"),
	);
	const response = (method: string, nth = 0) =>
		calls.filter((e) => e.method === method)[nth]?.response as Logged;

	const diff = response("mcp/diff");
	expect(diff.error).toBe(false);
	expect(diff.value.comparison).toMatchObject({ head, from: null, to: null });
	expect(diff.value.files).toEqual([
		expect.objectContaining({
			path: CALC,
			status: "modified",
			diff: expect.stringContaining(
				"-export const v3 = 3;\n+export const total = v1 + v2;",
			),
			pairs: [[3, 3]],
			whitespaceOnly: { LEFT: [], RIGHT: [] },
		}),
	]);

	const file = response("mcp/file");
	expect(file.value).toMatchObject({
		path: CALC,
		commit: head,
		startLine: 3,
		endLine: 3,
		text: "export const total = v1 + v2;",
	});
	// A path that could be an option is refused, never handed to git.
	expect(response("mcp/file", 1)).toMatchObject({
		error: true,
		value: { error: "invalid" },
	});

	const review = response("mcp/review").value.review as Record<string, unknown>;
	expect(review).toMatchObject({
		patchsets: [],
		lastReviewed: null,
		sinceLast: null,
	});
	expect(review.threads).toEqual([
		expect.objectContaining({
			path: CALC,
			atHead: expect.objectContaining({ kind: "placed", path: CALC, line: 3 }),
		}),
	]);
});
