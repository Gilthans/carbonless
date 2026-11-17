import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ask, CALC, expect, fixture, openFile, row, test } from "./agent-ui";
import { expectNoPageOverflow, fileSection, marksReady } from "./files-ui";

// Its own crb serve: the agent's config, its fake ACP env and checkouts.
test.use({ crbServer: "own" });

/**
 * Comment on an agent conversation's card: a new GitHub thread on its span
 * (the fake gh), after which the conversation is that thread's, behind its
 * agent button, and no longer a card on the code. On a line and on a whole
 * file, desktop and phone.
 */

const AGENT = { name: "Fake Agent", version: "9.9.9" };

/** Holds every seen mark (the answer stays new; no timer race). */
const holdSeen = (page: Page) =>
	page.route(/\/api\/r\/[^/]+\/agent\/threads\/[^/]+\/seen$/, () => {});

/** Opens the GitHub thread's agent conversation from its agent button. */
async function openConversation(thread: Locator) {
	await thread.getByTestId("thread-agent-button").click();
	const panel = thread.getByTestId("thread-agent-panel");
	await expect(panel).toHaveAttribute("data-open", "true");
	return panel;
}

/** Asks about the whole of `path` through the API (no page entry for it yet). */
async function askOnFile(
	url: string,
	path: string,
	commit: string,
	text: string,
) {
	const u = new URL(url);
	const id = /^\/r\/([^/]+)/.exec(u.pathname)?.[1];
	const key = u.searchParams.get("key");
	const res = await fetch(
		`${u.origin}/api/r/${id}/agent/threads${key ? `?${new URLSearchParams({ key })}` : ""}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientId: "file-q",
				text,
				span: { subject: "file", path, commit },
			}),
		},
	);
	if (!res.ok)
		throw new Error(`Ask answered ${res.status}: ${await res.text()}`);
}

test("Comment on a line's conversation: Cancel keeps it; posted, the GitHub thread's agent button holds it, the card leaves the code, across a reload", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// An answered question, a Cancel, a post, the agent read again, a reload.
	test.slow();
	await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 3, "Does total add everything?");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	const comment = card.getByRole("button", { name: "Comment on GitHub" });
	// Cancel: nothing changes.
	await comment.click();
	const composer = section.getByTestId("new-thread");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await expect(box).toHaveValue("");
	// It says it carries the conversation; it stays a comment.
	await expect(
		composer.getByRole("img", {
			name: "Moves your agent conversation to this thread",
		}),
	).toBeVisible();
	await expect(
		composer.getByRole("button", { name: "Ask agent instead" }),
	).toHaveAttribute("aria-disabled", "true");
	await composer.getByRole("button", { name: "Cancel" }).click();
	await expect(composer).toHaveCount(0);
	await expect(card).toBeVisible();
	// Posted: GitHub's thread on line 3, the conversation behind its agent button.
	await comment.click();
	await expect(box).toBeFocused();
	await box.fill("Shouldn't total add v3 too?");
	if (isMobile) await expectNoPageOverflow(page);
	await composer.getByTestId("new-thread-post").click();
	const thread = section
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3 too?" });
	await expect(thread).toBeVisible();
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Does total add everything?",
	]);
	await expect(panel.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	// Kept in the agent ref: the same after a reload.
	await page.reload();
	const again = await openFile(page, s.url, CALC);
	await again
		.locator('tr[data-testid="diff-line"][data-new-no="3"]')
		.getByRole("button", { name: /^1 comment on line 3/ })
		.click();
	const reloaded = again
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3 too?" });
	await expect(reloaded).toBeVisible();
	await expect(again.getByTestId("agent-thread")).toHaveCount(0);
	await expect(
		(await openConversation(reloaded)).getByTestId("agent-message-ai"),
	).toHaveText("It adds v1 and v2.");
});

test("Comment on a whole file's conversation: posted on the file, the conversation goes with it", async ({
	page,
	pr,
	agentCrb,
}) => {
	// An answered question, a post GitHub takes, the agent read again.
	test.slow();
	const p = await pr(fixture);
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "Fine as a whole." }] },
	});
	await holdSeen(page);
	await askOnFile(
		s.url,
		CALC,
		p.repo.shas.at(-1) ?? "",
		"Is this file needed?",
	);
	const section = await openFile(page, s.url, CALC);
	await section
		.getByRole("button", { name: /agent thread.* on this file/ })
		.click();
	const card = section
		.getByTestId("agent-thread")
		.filter({ hasText: "Is this file needed?" });
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"Fine as a whole.",
	);
	await card.getByRole("button", { name: "Comment on GitHub" }).click();
	const composer = section.getByTestId("new-thread");
	await expect(composer).toContainText("whole file");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Do we need this file?");
	await composer.getByTestId("new-thread-post").click();
	const thread = section
		.getByTestId("file-threads")
		.getByTestId("files-thread")
		.filter({ hasText: "Do we need this file?" });
	await expect(thread).toBeVisible();
	await expect(section.getByTestId("agent-thread")).toHaveCount(0);
	await expect(
		(await openConversation(thread)).getByTestId("agent-message-human"),
	).toHaveText(["Is this file needed?"]);
});

/** GitHub's threads in the fake gh's scenario: where each was posted. */
function storedThreads(p: { scenarioPath: string }) {
	const s = JSON.parse(readFileSync(p.scenarioPath, "utf8")) as {
		prs: Record<
			string,
			{
				graphql?: {
					reviewThreads?: {
						path: string;
						line: number;
						first?: { nodes: { originalCommit?: { oid: string } }[] };
					}[];
				};
			}
		>;
	};
	return Object.values(s.prs).flatMap((pr) =>
		(pr.graphql?.reviewThreads ?? []).map((t) => ({
			path: t.path,
			line: t.line,
			originalCommit: t.first?.nodes[0]?.originalCommit?.oid,
		})),
	);
}

test("Comment on a conversation asked on PS1, the PR's new head on screen: the page goes to PS1, the GitHub thread is on PS1's commit and holds the conversation", async ({
	page,
	pr,
	agentCrb,
	isMobile,
}) => {
	// An answer, a mark, a push, the head's view, a post.
	test.slow();
	const p = await pr(fixture);
	const ps1 = p.repo.shas.at(-1) ?? "";
	const s = await agentCrb({
		scenario: { agent: AGENT, answers: [{ text: "It adds v1 and v2." }] },
	});
	await holdSeen(page);
	const section = await openFile(page, s.url, CALC);
	const card = await ask(page, section, 3, "Asked on PS1");
	await expect(card.getByTestId("agent-message-ai")).toHaveText(
		"It adds v1 and v2.",
	);
	// The mark starts PS1 (the file's only cluster: it closes).
	await marksReady(page, section);
	await section
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first()
		.click();
	await expect(
		section.getByRole("button", { name: "Expand file" }),
	).toBeVisible();
	// Pushed: two lines on top, the asked line is 5 on the new head.
	const lines = (top: string[]) =>
		`${[
			...top,
			...Array.from({ length: 12 }, (_, i) =>
				i === 2
					? "export const total = v1 + v2;"
					: `export const v${i + 1} = ${i + 1};`,
			),
		].join("\n")}\n`;
	const head = p.moveHead({
		message: "two lines on top",
		files: { [CALC]: lines(["// one", "// two"]) },
	});
	await page.reload();
	await expect(page.getByTestId("ps-tail")).toHaveAttribute(
		"data-state",
		"head",
		// The head check's fetch on a loaded machine (rereview.spec's GIT_WAIT).
		{ timeout: 30_000 },
	);
	await page
		.getByTestId("head-toast")
		.getByRole("button", { name: "View" })
		.click();
	// The new head on screen: the conversation traced onto its line 5.
	const onHead = fileSection(page, CALC);
	await onHead.getByRole("button", { name: "Expand file" }).click();
	// The head's diff is built on its first view (git diff and placement
	// against the new head): up to 30 s on a loaded machine, as the head
	// check above (rereview.spec's GIT_WAIT).
	await expect(row(onHead, 5)).toBeVisible({ timeout: 30_000 });
	await row(onHead, 5).getByTestId("agent-bubble").click();
	const traced = onHead
		.getByTestId("agent-thread")
		.filter({ hasText: "Asked on PS1" });
	const comment = traced.getByRole("button", { name: "Comment on GitHub" });
	await expect(comment).not.toHaveAttribute("aria-disabled", "true");
	await comment.click();
	// PS1 on screen (where the conversation's line is), its file open, the
	// composer on PS1's line 3.
	await expect(page).toHaveURL(/[?&]ps=1(&|$)/);
	const onPs1 = fileSection(page, CALC);
	const composer = onPs1.getByTestId("new-thread");
	await expect(composer).toContainText("line 3, new");
	const box = composer.getByRole("textbox", { name: "Comment" });
	await expect(box).toBeFocused();
	await box.fill("Shouldn't total add v3?");
	if (isMobile) await expectNoPageOverflow(page);
	await composer.getByTestId("new-thread-post").click();
	const thread = onPs1
		.getByTestId("files-thread")
		.filter({ hasText: "Shouldn't total add v3?" });
	await expect(thread).toBeVisible();
	// GitHub has it on PS1's commit, not the head's.
	expect(head).not.toBe(ps1);
	expect(storedThreads(p)).toMatchObject([
		{ path: CALC, line: 3, originalCommit: ps1 },
	]);
	// The conversation is the thread's now: behind its agent button.
	await expect(onPs1.getByTestId("agent-thread")).toHaveCount(0);
	const panel = await openConversation(thread);
	await expect(panel.getByTestId("agent-message-human")).toHaveText([
		"Asked on PS1",
	]);
});
