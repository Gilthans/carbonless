import { expect, test } from "./fixtures";

test("Settings sits in the app bar, compact header included, and switches hidden characters", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await pr();
	const s = await startCrb();
	await page.goto(`${s.url}files`);
	const section = page.getByRole("region", { name: "a.txt" });
	await section.getByRole("button", { name: "Expand file" }).click();
	await expect(section.locator('[data-inv="eol"]').first()).toBeAttached();
	// The old toggle is gone from Files: Settings replaces it.
	await expect(
		page.getByRole("button", { name: "Show all characters" }),
	).toHaveCount(0);

	const gear = page
		.getByTestId("app-header-row")
		.getByRole("button", { name: "Settings" });
	const box = await gear.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(40);
	expect(box?.width).toBeGreaterThanOrEqual(40);
	if (!isMobile) {
		await gear.hover();
		// The tip repeats the name, so it's hidden from the accessibility tree.
		await expect(
			page.locator("[role=tooltip]:not([hidden])", { hasText: "Settings" }),
		).toBeVisible();
	}
	await gear.click();
	const dialog = page.getByRole("dialog", { name: "Settings" });
	await expect(dialog).toBeVisible();
	const toggle = dialog.getByRole("switch", { name: "Show hidden characters" });
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(40);
	const d = await dialog.boundingBox();
	if (isMobile) {
		// A bottom sheet on a phone.
		expect((d?.y ?? 0) + (d?.height ?? 0)).toBeGreaterThan(770);
		expect(d?.width).toBeGreaterThan(350);
	} else {
		// A popover under the gear.
		expect(d?.y).toBeGreaterThan((box?.y ?? 0) + (box?.height ?? 0) - 1);
	}
	const shots = process.env.DESIGN_SHOTS;
	if (shots) {
		await page.screenshot({
			path: `${shots}/settings-${isMobile ? "phone" : "desktop"}.png`,
		});
	}
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(gear).toBeFocused();
	await expect(section.locator('[data-inv="eol"]')).toHaveCount(0);
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth -
			document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);

	// Still there in the compact sticky header, deep in the page.
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	await expect(gear).toBeInViewport();
	await gear.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	if (isMobile) {
		// A tap on the sheet's backdrop closes it.
		await page.mouse.click(180, 60);
		await expect(dialog).toBeHidden();
		await expect(gear).toHaveAttribute("aria-expanded", "false");
	} else {
		// A click outside closes the popover.
		await page.mouse.click(10, 500);
		await expect(dialog).toBeHidden();
	}
});
