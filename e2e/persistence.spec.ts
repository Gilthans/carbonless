import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { testGitEnv } from "../test/git-fixture";
import { openFiles, progress } from "./files-ui";
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

const clusters = progress;

async function checkFirstCluster(page: Page) {
	await page
		.getByRole("region", { name: "src/util.ts" })
		.getByRole("button", { name: "Expand file" })
		.click();
	const box = page
		.getByRole("region", { name: "src/util.ts" })
		.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await box.click();
	// The file's one cluster: marking it finishes the file, which closes.
	await expect(box).toHaveCount(0);
	await expect(clusters(page)).toHaveAttribute("aria-valuenow", "25");
	// Shown at once; stored once nothing is left unsaved.
	await expect(page.getByTestId("sync-notices")).toHaveCount(0);
}

/** The patch set graph's last slot: "up to date", or the head dot. */
const tail = (page: Page) => page.getByTestId("ps-tail");
const toast = (page: Page) => page.getByTestId("head-toast");

test.describe("a restarted server", () => {
	// The client finds the new server through server.json; its own, to stop.
	test.use({ crbClient: "cli", crbServer: "own" });

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
	await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
	await expect(toast(page)).toHaveCount(0);

	p.moveHead({
		message: "later push",
		files: { "src/util.ts": text(util.map((l) => `${l} pushed`)) },
	});
	const refreshed = page.waitForResponse(
		(r) => r.url().endsWith("/refresh") && r.ok(),
	);
	const reloaded = page.waitForResponse(
		(r) => r.url().endsWith("/review") && r.ok(),
	);
	await page.getByRole("button", { name: "Refresh" }).click();
	await refreshed;
	await reloaded;
	await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
	// The graph's last slot holds the head dot now, and the toast says so;
	// the review itself stays on its patch set.
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	await expect(toast(page)).toContainText("1 new commit");
	await expect(
		page.getByRole("region", { name: "src/util.ts" }),
	).not.toContainText("pushed");
	await expect(clusters(page)).toHaveAttribute("aria-valuenow", "25");
	// A finished file shows closed: open it to see its mark.
	const utilFile = page.getByRole("region", { name: "src/util.ts" });
	await utilFile.getByRole("button", { name: "Expand file" }).click();
	await expect(
		utilFile.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeChecked();
});

// Its own crb serve: it reads the server's clone under workdir.
const ownTest = test.extend({ crbServer: "own" as const });

ownTest(
	"opening without checking anything off creates no snapshot",
	async ({ page, pr, startCrb, workdir }) => {
		const p = await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await expect(clusters(page)).toContainText("0 / 4 clusters reviewed");

		p.moveHead({
			message: "later push",
			files: { "src/extra.ts": "export const extra = 1;\n" },
		});
		await page.getByRole("button", { name: "Refresh" }).click();
		// The unpinned review follows the new head: five clusters, up to date.
		await expect(clusters(page)).toContainText("0 / 5 clusters reviewed");
		await expect(tail(page)).toHaveAttribute("data-state", "up-to-date");
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
	},
);

test("a push found by the head poll shows the head dot and the toast; nothing changes under the reader", async ({
	page,
	pr,
	startCrb,
}) => {
	const p = await pr(fixture);
	const s = await startCrb();
	await page.clock.install();
	await openFiles(page, s.url);
	await expect(clusters(page)).toContainText("0 / 4 clusters reviewed");

	p.moveHead({
		message: "later push",
		files: { "src/extra.ts": "export const extra = 1;\n" },
	});
	await page.clock.fastForward("05:01");
	await expect(toast(page)).toContainText("1 new commit");
	await expect(tail(page)).toHaveAttribute("data-state", "head");
	// Nothing changed under the reader.
	await expect(clusters(page)).toContainText("0 / 4 clusters reviewed");
});
