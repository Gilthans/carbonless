import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { testGitEnv } from "../test/git-fixture";
import { expect, OWNER_REPO, type PrOptions, test } from "./fixtures";

const core = Array.from({ length: 78 }, (_, i) => `core ${i + 1}`);
const util = Array.from({ length: 10 }, (_, i) => `util ${i + 1}`);
const text = (lines: string[]) => `${lines.join("\n")}\n`;

/** Four clusters, as in files.spec.ts. */
const fixture: PrOptions = {
	base: {
		"src/core.ts": text(core),
		"src/util.ts": text(util),
		"docs/old.md": "# Notes\n\nNothing changes here.\n",
	},
	files: [
		{
			message: "PR change",
			rename: { "docs/old.md": "docs/new.md" },
			files: {
				"src/core.ts": text(
					core.flatMap((line, i) =>
						i === 4
							? ["core 5 a", "core 5 b"]
							: i === 14
								? ["core 15 changed"]
								: [line],
					),
				),
				"src/util.ts": text(
					util.map((l, i) => (i === 2 ? "util 3 changed" : l)),
				),
			},
		},
	],
};

const clusters = (page: Page) =>
	page.getByRole("progressbar", { name: "Clusters" });

async function openFiles(page: Page, url: string) {
	await page.goto(new URL("/files", url).href);
	await expect(clusters(page)).toBeVisible();
}

async function checkFirstCluster(page: Page) {
	await page
		.getByRole("region", { name: "src/util.ts" })
		.getByRole("button", { name: "Expand file" })
		.click();
	const box = page
		.getByRole("region", { name: "src/util.ts" })
		.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await box.click();
	await expect(box).toBeChecked();
	await expect(clusters(page)).toHaveAttribute("aria-valuenow", "25");
}

const banner = (page: Page) => page.getByText("New commits were pushed");

test("progress survives a restart", async ({ page, pr, startCrb }) => {
	await pr(fixture);
	const first = await startCrb();
	await openFiles(page, first.url);
	await checkFirstCluster(page);
	// Leave first: its page would poll the stopped server.
	await page.goto("about:blank");
	await first.stop();

	const second = await startCrb();
	await openFiles(page, second.url);
	await expect(clusters(page)).toHaveAttribute("aria-valuenow", "25");
});

test("a started review stays on its snapshot after a push", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await checkFirstCluster(page);
	await expect(banner(page)).toBeHidden();

	p.moveHead({
		message: "later push",
		files: { "src/util.ts": text(util.map((l) => `${l} pushed`)) },
	});
	const refreshed = page.waitForResponse(
		(r) => r.url().endsWith("/api/refresh") && r.ok(),
	);
	const reloaded = page.waitForResponse(
		(r) => r.url().endsWith("/api/review") && r.ok(),
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await refreshed;
	await reloaded;
	await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
	await expect(banner(page)).toBeVisible();
	await expect(banner(page)).toContainText("snapshot from");
	await expect(
		page.getByRole("region", { name: "src/util.ts" }),
	).not.toContainText("pushed");
	await expect(clusters(page)).toHaveAttribute("aria-valuenow", "25");
	await expect(
		page.getByRole("link", { name: "Open the PR on GitHub" }),
	).toHaveAttribute("href", `https://github.com/${OWNER_REPO}/pull/7`);
	await expect(
		page
			.getByRole("region", { name: "src/util.ts" })
			.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeChecked();
});

test("opening without checking anything off creates no snapshot", async ({
	page,
	pr,
	startCrb,
	workdir,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(clusters(page)).toContainText("0 / 4 reviewed");

	p.moveHead({
		message: "later push",
		files: { "src/extra.ts": "export const extra = 1;\n" },
	});
	await page.getByRole("button", { name: "Refresh" }).click();
	// The unpinned review follows the new head: five clusters, no banner.
	await expect(clusters(page)).toContainText("0 / 5 reviewed");
	await expect(banner(page)).toBeHidden();
	await expect(
		page.getByRole("region", { name: "src/extra.ts" }),
	).toBeVisible();

	const [owner, repo] = OWNER_REPO.split("/") as [string, string];
	const refs = execFileSync("git", ["for-each-ref", "refs/crb/reviews/"], {
		cwd: join(workdir, "cache", "carbonless", "repos", owner, `${repo}.git`),
		encoding: "utf8",
		env: testGitEnv(),
	});
	// Positive control: the review exists, it just has no reviewer refs.
	expect(refs).toMatch(/refs\/crb\/reviews\/[^/\s]+\/meta/);
	expect(refs).not.toContain("/reviewers/");
});

test("a push found by the head poll on an unstarted review asks for a Refresh", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await page.clock.install();
	await openFiles(page, s.url);
	await expect(clusters(page)).toContainText("0 / 4 reviewed");

	p.moveHead({
		message: "later push",
		files: { "src/extra.ts": "export const extra = 1;\n" },
	});
	await page.clock.fastForward("05:01");
	await expect(
		page.getByText(
			"New commits were pushed to this PR. Press Refresh to load them.",
		),
	).toBeVisible();
	await expect(page.getByText("snapshot from")).toBeHidden();
	// Nothing changed under the reader.
	await expect(clusters(page)).toContainText("0 / 4 reviewed");
});
