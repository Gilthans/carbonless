import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prView,
	release,
	reviewThread,
	type Scenario,
	threadComment,
} from "../../test/fake-gh/scenario";
import { GIT_TEST_TIMEOUTS } from "../../test/git-fixture";
import { createPrFixture, type PrFixture } from "../../test/pr-fixture";
import { OverviewRead } from "./overviewRead";
import type { ThreadCodeSource } from "./threadCode";

vi.setConfig(GIT_TEST_TIMEOUTS);

const HUNK = "@@ -1,2 +1,2 @@\n line 1\n-line 2";

describe("OverviewRead.hunk (CAR-8)", () => {
	let pr: PrFixture;
	beforeEach(() => {
		pr = createPrFixture();
	});
	afterEach(() => pr.cleanup());

	const serve = (over: Partial<Scenario> = {}) =>
		pr.scenario({
			...over,
			prs: {
				12: {
					view: prView({ headRefOid: pr.head(), baseRefName: "main" }),
					graphql: {
						reviewThreads: [
							reviewThread({ path: "a.txt", line: 2, diffSide: "LEFT" }, [
								threadComment({
									login: "rev1",
									text: "Old 2",
									commit: pr.head(),
									diffHunk: HUNK,
								}),
							]),
						],
						reviews: [],
					},
				},
			},
		});

	const open = () =>
		new OverviewRead({
			ref: { owner: "acme", repo: "widget", number: 12 },
			viewer: "octo-cat",
			writes: "on",
			code: {
				window: async () => null,
				code: async () => null,
			} as unknown as ThreadCodeSource,
			base: async () => ({ snapshot: pr.mergeBase, ref: "refs/heads/main" }),
		});

	it("after the background read failed, its retry waits for a read of the same thread already on its way (comments), never calling it unreadable meanwhile", async () => {
		serve({ failGraphql: "diffHunk" });
		const read = open();
		await read.settled;
		const [thread] = (await read.threads("summary")).threads;
		const id = thread?.id ?? "";
		// GitHub answers again, but slowly: a card's comments are asked now.
		serve({ hold: ["threadContent", "comments"] });
		const hunk = read.hunk(id);
		const comments = read.comments([id]);
		release(process.env.CRB_FAKE_GH ?? "", "threadContent");
		release(process.env.CRB_FAKE_GH ?? "", "comments");
		await comments;
		expect(await hunk).toBe(HUNK);
		read.abort();
	});
});
