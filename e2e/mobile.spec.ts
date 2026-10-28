import type { Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { barBottom, fileAction, fileSection, openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

const LONG_DIR = "src/server/review/storage/adapters/git/refs/internal/legacy";
const lines = (n: number, tag: string) =>
	`${Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n")}\n`;

/** Enough files to scroll, one of them on a long path. */
const fixture: PrOptions = {
	base: Object.fromEntries([
		...Array.from({ length: 24 }, (_, i) => [
			`src/f${i}.ts`,
			lines(30, `f${i}`),
		]),
		[`${LONG_DIR}/compatibility.ts`, lines(10, "long")],
	]),
	files: [
		{
			message: "PR change",
			files: Object.fromEntries([
				...Array.from({ length: 24 }, (_, i) => [
					`src/f${i}.ts`,
					lines(30, `f${i}`).replace(`f${i} 5\n`, `f${i} 5 changed\n`),
				]),
				[
					`${LONG_DIR}/compatibility.ts`,
					lines(10, "long").replace("long 2\n", "long 2 changed\n"),
				],
			]),
		},
	],
};

/** Waits until the page has stopped scrolling (smooth scrolls take a while). */
async function settled(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((done) => {
				let last = Number.NaN;
				let still = 0;
				const tick = () => {
					still = window.scrollY === last ? still + 1 : 0;
					last = window.scrollY;
					if (still >= 5) done();
					else requestAnimationFrame(tick);
				};
				tick();
			}),
	);
}

async function expectNoPageOverflow(page: Page) {
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("no horizontal page scroll on the overview and files pages", async ({
	page,
	pr,
	startCrb,
}, testInfo) => {
	await pr(fixture);
	const s = await startCrb();
	const widths =
		testInfo.project.name === "phone"
			? [360, 412]
			: [page.viewportSize()?.width ?? 1280];
	for (const width of widths) {
		await page.setViewportSize({ width, height: 800 });
		await page.goto(s.url);
		await expect(
			page.getByRole("region", { name: "What it does" }),
		).toBeVisible();
		await expectNoPageOverflow(page);
		// Five-digit counts must fit too.
		await page.route("**/api/review", async (route) => {
			const response = await route.fetch();
			const view = await response.json();
			for (const file of view.files) {
				for (const c of file.clusters) c.lines *= 12345;
			}
			view.progress.lines = { total: 98765, reviewed: 12345, crossedOff: 4321 };
			view.progress.clusters = { total: 54321, reviewed: 1234, crossedOff: 0 };
			await route.fulfill({ response, json: view });
		});
		await openFiles(page, s.url, "Lines");
		await expect(page.getByText("12345 / 94444 lines reviewed")).toBeVisible();
		await expectNoPageOverflow(page);
		const header = fileSection(page, "src/f0.ts").getByRole("progressbar", {
			name: "File progress",
		});
		await expect(header).toHaveText(/^0 \/ 24690/);
		const fits = await header
			.locator("span")
			.first()
			.evaluate((el) => el.scrollWidth <= el.clientWidth);
		expect(fits).toBe(true);
		await page.unroute("**/api/review");
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f0.ts");
		await section.getByRole("button", { name: "Expand file" }).click();
		await expect(section.getByTestId("diff-line").first()).toBeVisible();
		await expectNoPageOverflow(page);
	}
});

const WIDE = "w".repeat(300);
/** GitHub HTML that is wider than a phone in every way it can be. */
const WIDE_HTML = [
	`<p dir="auto">${WIDE} <a href="https://example.com/${WIDE}">https://example.com/${WIDE}</a></p>`,
	`<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto"><pre><span class="pl-k">const</span> x = "${WIDE}";</pre></div>`,
	`<markdown-accessiblity-table><table><thead><tr>${"<th>column header</th>".repeat(12)}</tr></thead><tbody><tr>${"<td>value</td>".repeat(12)}</tr></tbody></table></markdown-accessiblity-table>`,
	'<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="https://camo.githubusercontent.com/big"><img src="https://camo.githubusercontent.com/big" alt="big screenshot" width="2000" height="400" style="max-width: 100%;"></a></p>',
].join("\n");

test("GitHub-rendered descriptions and threads never widen the page", async ({
	page,
	pr,
	startCrb,
}, testInfo) => {
	await page.route("https://**/*", (route) =>
		route.fulfill({
			contentType: "image/png",
			body: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
				"base64",
			),
		}),
	);
	await pr({
		bodyHTML: WIDE_HTML,
		threads: [
			reviewThread({ path: `${LONG_DIR}/compatibility.ts` }, [
				threadComment({ login: "rev1", text: WIDE, html: WIDE_HTML }),
			]),
		],
	});
	const s = await startCrb();
	await page.setViewportSize({
		width: testInfo.project.name === "phone" ? 360 : 1280,
		height: 800,
	});
	await page.goto(s.url);
	const what = page.getByRole("region", { name: "What it does" });
	await expect(what.getByAltText("big screenshot")).toBeVisible();
	await expectNoPageOverflow(page);
	if (testInfo.project.name === "phone") {
		// Too wide for a phone: the table scrolls inside its own box.
		const table = what.locator("table");
		expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
			true,
		);
	}
	const humans = page.getByRole("region", { name: "Human reviews" });
	await expect(humans.locator(".markdown-body table")).toBeAttached();
	const more = humans.getByRole("button", { name: "Show more" });
	await more.click();
	await expect(humans.locator(".markdown-body table")).toBeVisible();
	await expectNoPageOverflow(page);
});

test.describe("phone", () => {
	test.skip(({ isMobile }) => !isMobile, "phone layout only");

	test("the floating Files button opens the tree; picking a file closes it and scrolls there", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const tree = page.getByTestId("file-tree");
		await expect(tree).toBeHidden();
		const button = page.getByRole("button", { name: "Files", exact: true });
		await button.click();
		const sheet = page.getByRole("dialog", { name: "Files" });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId("file-tree")).toBeVisible();

		// Escape closes it, and focus goes back to the button.
		await page.keyboard.press("Escape");
		await expect(sheet).toBeHidden();
		await expect(button).toBeFocused();

		await button.click();
		const target = fileSection(page, "src/f23.ts");
		await expect(target).not.toBeInViewport();
		await sheet.getByRole("button", { name: /f23\.ts/ }).click();
		await expect(sheet).toBeHidden();
		await expect(target).toBeInViewport();
		// Opened, its header at the top below the page bar, focused.
		const collapse = target.getByRole("button", { name: "Collapse file" });
		await expect(collapse).toBeFocused();
		await expect(target.getByTestId("diff-line").first()).toBeVisible();
		await expect
			.poll(async () => {
				const top = (await target.locator("header").boundingBox())?.y ?? 0;
				return Math.round(top - (await barBottom(page)));
			})
			.toBe(0);
	});

	test("the sheet locks the page scroll and closes when the screen widens", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "Files" });
		await expect(sheet).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.style.overflow),
		).toBe("hidden");
		await page.setViewportSize({ width: 1024, height: 800 });
		await expect(sheet).toHaveCount(0);
		expect(
			await page.evaluate(() => document.documentElement.style.overflow),
		).toBe("");
		await page.setViewportSize({ width: 412, height: 800 });
		await expect(
			page.getByRole("button", { name: "Files", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("dialog", { name: "Files" })).toBeHidden();
	});

	test("cluster controls have separate 40px touch targets", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f0.ts");
		const expand = section.getByRole("button", { name: "Expand file" });
		const expandBox = await expand.boundingBox();
		expect(expandBox?.width).toBeGreaterThanOrEqual(40);
		expect(expandBox?.height).toBeGreaterThanOrEqual(40);
		await expand.click();
		const box = await section.getByTestId("cluster-box-target").boundingBox();
		const toggle = await section
			.getByRole("button", { name: "Cross off cluster" })
			.boundingBox();
		if (!box || !toggle) throw new Error("controls not rendered");
		for (const b of [box, toggle]) {
			expect(b.width).toBeGreaterThanOrEqual(40);
			expect(b.height).toBeGreaterThanOrEqual(40);
		}
		const overlap =
			box.x < toggle.x + toggle.width &&
			toggle.x < box.x + box.width &&
			box.y < toggle.y + toggle.height &&
			toggle.y < box.y + box.height;
		expect(overlap).toBe(false);
		// Tapping the box's target checks the box, not the toggle.
		await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
		await expect(
			section.getByRole("checkbox", { name: "Mark cluster reviewed" }),
		).toBeChecked();
	});

	test("a long path starts scrolled to the file name", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await openFiles(page, s.url);
		const path = fileSection(page, `${LONG_DIR}/compatibility.ts`).getByTestId(
			"file-path",
		);
		await expect(path).not.toHaveAttribute("title");
		await expect
			.poll(() =>
				path.evaluate((el) => ({
					scrolled: el.scrollLeft > 0,
					atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
				})),
			)
			.toEqual({ scrolled: true, atEnd: true });
		await expect(
			fileSection(page, `${LONG_DIR}/compatibility.ts`).getByTestId(
				"path-fade",
			),
		).toBeVisible();
		await path.focus();
		await expect(path).toBeFocused();
		// The rest of the path is reachable by scrolling left.
		await path.evaluate((el) => {
			el.scrollLeft = 0;
		});
		expect(await path.evaluate((el) => el.scrollLeft)).toBe(0);
		// Finished, the fade starts from the header's green, not a grey block.
		const section = fileSection(page, `${LONG_DIR}/compatibility.ts`);
		await fileAction(section, "Mark remaining reviewed");
		await expect(section.locator("header")).toHaveAttribute("data-finished");
		await path.evaluate((el) => {
			el.scrollLeft = el.scrollWidth;
		});
		const header = await section
			.locator("header")
			.evaluate((el) => getComputedStyle(el).backgroundColor);
		await expect
			.poll(() =>
				section
					.getByTestId("path-fade")
					.evaluate((el) => getComputedStyle(el).backgroundImage),
			)
			.toContain(header);
	});

	test("file actions sit inline as 40px icons under a full-width path", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		for (const width of [360, 412]) {
			await page.setViewportSize({ width, height: 800 });
			await openFiles(page, s.url);
			const section = fileSection(page, `${LONG_DIR}/compatibility.ts`);
			await expect(
				section.getByRole("button", { name: "File actions" }),
			).toHaveCount(0);
			const path = section.getByTestId("file-path");
			const pathBox = await path.boundingBox();
			const headerBox = await section.locator("header").boundingBox();
			if (!pathBox || !headerBox) throw new Error("header not rendered");
			// Row 1: the change-kind icon, the path, then the change counts;
			// the path takes the rest of the header's width.
			const kind = await section.getByTestId("change-kind").boundingBox();
			if (!kind) throw new Error("no change-kind icon");
			const counts = await section.getByTestId("change-count").boundingBox();
			if (!counts) throw new Error("no change counts");
			expect(kind.width).toBeLessThanOrEqual(16);
			expect(kind.x + kind.width).toBeLessThanOrEqual(pathBox.x);
			expect(pathBox.x + pathBox.width).toBeLessThanOrEqual(counts.x);
			expect(Math.abs(counts.y - pathBox.y)).toBeLessThan(pathBox.height);
			expect(pathBox.width).toBeGreaterThanOrEqual(
				headerBox.width - 16 - kind.width - counts.width - 16,
			);
			// Row 2: progress plus ⊘ ✓, 40px each, below the path.
			for (const name of ["Cross off file", "Mark remaining reviewed"]) {
				const button = section.getByRole("button", { name, exact: true });
				await expect(button).toBeVisible();
				const box = await button.boundingBox();
				expect(box?.width).toBeGreaterThanOrEqual(40);
				expect(box?.height).toBeGreaterThanOrEqual(40);
				expect(box?.y).toBeGreaterThanOrEqual(pathBox.y + pathBox.height - 1);
			}
			const fileProgress = section.getByRole("progressbar", {
				name: "File progress",
			});
			const progressBox = await fileProgress.boundingBox();
			expect(progressBox?.y).toBeGreaterThanOrEqual(
				pathBox.y + pathBox.height - 1,
			);
			// Two rows only, everything inside the header.
			expect(headerBox.height).toBeLessThanOrEqual(100);
			const inside = await section
				.locator("header button, header [role=progressbar]")
				.evaluateAll(
					(els, right) =>
						els.every((el) => el.getBoundingClientRect().right <= right + 0.5),
					headerBox.x + headerBox.width,
				);
			expect(inside).toBe(true);
			// The file name and a good part of the path are readable.
			const shown = await path.evaluate((el) => el.clientWidth);
			expect(shown).toBeGreaterThanOrEqual(width - 64 - counts.width - 8);
			await expectNoPageOverflow(page);
			await section
				.getByRole("button", { name: "Mark remaining reviewed" })
				.click();
			await expect(fileProgress).toHaveAttribute("aria-valuenow", "100");
			await expect(
				section.getByRole("button", { name: "Cross off file" }),
			).toBeDisabled();
			// Undo for the next width.
			await section.getByRole("button", { name: "Expand file" }).click();
			await section
				.getByRole("checkbox", { name: "Mark cluster reviewed" })
				.click();
			await expect(fileProgress).toHaveAttribute("aria-valuenow", "0");
		}
	});

	test("the sticky headers stay compact on a phone", async ({
		page,
		pr,
		startCrb,
	}) => {
		await pr(fixture);
		const s = await startCrb();
		await page.setViewportSize({ width: 360, height: 740 });
		await openFiles(page, s.url);
		const section = fileSection(page, "src/f3.ts");
		await section.getByRole("button", { name: "Expand file" }).click();
		await section.getByTestId("diff-line").last().scrollIntoViewIfNeeded();
		await page.mouse.wheel(0, 300);
		const header = section.locator("header");
		// Once the wheel scroll settles, the header sits right below the bar.
		await expect
			.poll(async () => {
				const box = await header.boundingBox();
				return Math.round(Math.abs((box?.y ?? 1e9) - (await barBottom(page))));
			})
			.toBeLessThanOrEqual(1);
		const box = await header.boundingBox();
		if (!box) throw new Error("header not rendered");
		// The bar and the header together take under 30% of the screen.
		expect(box.y + box.height).toBeLessThanOrEqual(740 * 0.3);
	});
});

test("desktop keeps the file tree in a sidebar", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(isMobile, "desktop layout only");
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	await expect(page.getByTestId("file-tree")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Files", exact: true }),
	).toHaveCount(0);
	await expect(
		fileSection(page, "src/f0.ts").getByRole("button", {
			name: "Mark remaining reviewed",
		}),
	).toBeVisible();
	// Wide headers keep one row: the path beside the actions.
	const section = fileSection(page, `${LONG_DIR}/compatibility.ts`);
	const path = await section.getByTestId("file-path").boundingBox();
	const mark = await section
		.getByRole("button", { name: "Mark remaining reviewed" })
		.boundingBox();
	if (!path || !mark) throw new Error("header not rendered");
	expect(
		Math.abs(path.y + path.height / 2 - (mark.y + mark.height / 2)),
	).toBeLessThanOrEqual(2);
});

test("an open tooltip causes no horizontal page overflow", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	test.skip(!isMobile, "phone layout only");
	await page.setViewportSize({ width: 360, height: 740 });
	await pr(fixture);
	const s = await startCrb();
	await openFiles(page, s.url);
	const section = fileSection(page, `${LONG_DIR}/compatibility.ts`);
	for (const name of ["Cross off file", "Mark remaining reviewed"]) {
		// Focus, not tap: a tap would also run the action (which then hides it).
		const button = section.getByRole("button", { name });
		// Already in view, so focusing doesn't scroll (a scroll closes it).
		await button.scrollIntoViewIfNeeded();
		await settled(page);
		await button.focus();
		// Its own tooltip (another header button may sit under the pointer).
		const tipId = await button.getAttribute("aria-describedby");
		await expect(page.locator(`[id="${tipId}"]`)).toBeVisible();
		await expectNoPageOverflow(page);
	}
	await settled(page);
	await section.getByRole("progressbar", { name: "File progress" }).focus();
	// Its text is the progressbar's value text, so it is hidden from the a11y tree.
	const tip = page.locator("[role=tooltip]:not([hidden])").filter({
		hasText: /^not started · \d+ lines? added, \d+ deleted · 1 cluster · /,
	});
	await expect(tip).toBeVisible();
	await expectNoPageOverflow(page);
	const box = await tip.boundingBox();
	expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
});

test("an opened thread card fits a 360px screen; its toggle and buttons are 40px tall", async ({
	page,
	pr,
	startCrb,
}) => {
	const wide = `${"x".repeat(300)} end`;
	await pr({
		threads: [
			reviewThread({ path: `${LONG_DIR}/compatibility.ts`, line: 2 }, [
				threadComment({ login: "rev1", text: "Point" }),
				threadComment({
					login: "octo-author",
					text: wide,
					html: `<p dir="auto">${wide}</p><pre><code>${wide}</code></pre>`,
				}),
			]),
		],
	});
	const s = await startCrb();
	await page.setViewportSize({ width: 360, height: 780 });
	await page.goto(s.url);
	const humans = page.getByRole("region", { name: "Human reviews" });
	const toggle = humans.getByRole("button", { name: "Show more, 1 reply" });
	expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	await toggle.click();
	await expect(humans.getByTestId("thread-comment")).toHaveCount(1);
	for (const name of ["Resolve", "Reply", "Show less"]) {
		const b = await humans
			.getByRole("button", { name, exact: true })
			.boundingBox();
		expect(b?.height ?? 0, name).toBeGreaterThanOrEqual(40);
		expect(b?.width ?? 0, name).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);
});

test("opened thread fits the viewport with a 300-char line", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	const long = `long ${"y".repeat(300)} end`;
	const wide = `${"x".repeat(300)} end`;
	const p = await pr({
		base: { "src/wide.ts": lines(10, "w") },
		files: [
			{
				message: "PR change",
				files: { "src/wide.ts": lines(10, "w").replace("w 4\n", `${long}\n`) },
			},
		],
	});
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[7]?.graphql;
		if (!graph) throw new Error("no PR in the scenario");
		graph.reviewThreads = [
			reviewThread({ path: "src/wide.ts", line: 4, subjectType: "LINE" }, [
				threadComment({ login: "rev1", text: "Too long", commit: head }),
				threadComment({
					login: "octo-author",
					text: wide,
					html: `<p dir="auto">${wide}</p><pre><code>${wide}</code></pre>`,
				}),
			]),
		];
	});
	const s = await startCrb();
	await page.setViewportSize({ width: 360, height: 780 });
	await openFiles(page, s.url);
	const section = fileSection(page, "src/wide.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	const bubble = section.getByRole("button", { name: "2 comments" });
	await expect(bubble).toBeVisible();
	// At the visible edge of the code, though the line runs far past it.
	const box = await bubble.boundingBox();
	expect((box?.x ?? 1e9) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
	expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
	if (isMobile) expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
	// The code under the bubble keeps room at its end.
	const pad = await bubble.evaluate((b) =>
		Number.parseFloat(
			getComputedStyle(b.closest("td") as Element).paddingRight,
		),
	);
	expect(pad).toBeGreaterThanOrEqual(40);
	await bubble.click();
	// A tap doesn't leave the tooltip over the opened thread.
	await expect(page.locator('[role="tooltip"]:not([hidden])')).toHaveCount(0);
	const thread = section.getByTestId("files-thread");
	await expect(thread.getByTestId("thread-comment")).toHaveCount(2);
	await expectNoPageOverflow(page);
	const fits = async () => {
		const b = await thread.boundingBox();
		expect(b?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((b?.x ?? 0) + (b?.width ?? 1e9)).toBeLessThanOrEqual(360);
	};
	await fits();
	// Scrolled sideways, the thread stays in view.
	await section
		.locator("table")
		.locator("xpath=..")
		.evaluate((el) => {
			el.scrollLeft = el.scrollWidth;
		});
	await fits();
	await expect(bubble).toBeInViewport();
	await expectNoPageOverflow(page);
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/files-thread-${isMobile ? "phone" : "desktop"}-360.png`,
		});
	}
});
