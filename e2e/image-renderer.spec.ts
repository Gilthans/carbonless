import type { Locator } from "@playwright/test";
import {
	expectNoPageOverflow,
	fileSection,
	openFiles,
	tapHeight,
} from "./files-ui";
import { expect, test } from "./fixtures";

/*
 * Custom renderers (CAR-38, spec "Renderer switch"): an image file's header
 * has a "Show as" chip; the pick is kept per path for this viewer, and
 * only changes the view, never a review state.
 */

const PNG = "img/logo.png";
const BMP = "img/icon.bmp";
const TS = "src/a.ts";

// Image signatures with a NUL in them: git calls them binary.
const png = (n: number) =>
	new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, n]);
const bmp = (n: number) => new Uint8Array([0x42, 0x4d, 0, 0, 0, n]);

const chip = (section: Locator) =>
	section.getByRole("button", { name: /^Show as/ });

test("renderer switch: Image ↔ Binary persists across reload; a .ts file has no chip", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	await pr({
		base: { [TS]: "one\ntwo\n" },
		baseBinary: { [PNG]: png(1), [BMP]: bmp(1) },
		files: [
			{
				message: "images changed",
				binary: { [PNG]: png(2), [BMP]: bmp(2) },
				files: { [TS]: "one\nTWO\n" },
			},
		],
	});
	const s = await startCrb();
	await openFiles(page, s.url);
	const image = fileSection(page, PNG);
	const other = fileSection(page, BMP);
	await expect(chip(image)).toHaveAccessibleName("Show as: Image");
	await expect(chip(other)).toHaveAccessibleName("Show as: Image");
	await expect(fileSection(page, TS)).toBeVisible();
	await expect(chip(fileSection(page, TS))).toHaveCount(0);

	// Image (no ImageView yet): the binary row and its box, no lines read.
	await image.getByRole("button", { name: "Expand file" }).click();
	await expect(
		image.getByRole("checkbox", { name: "Mark cluster reviewed" }),
	).toBeVisible();

	await chip(image).click();
	const menu = page.getByRole("menu", { name: "Show as" });
	const items = menu.getByRole("menuitemradio");
	await expect(items).toHaveText(["Image", "Binary"]);
	await expect(
		menu.getByRole("menuitemradio", { name: "Image" }),
	).toHaveAttribute("aria-checked", "true");
	if (isMobile) {
		expect(await tapHeight(chip(image))).toBeGreaterThanOrEqual(40);
		for (const item of await items.all()) {
			expect(await tapHeight(item)).toBeGreaterThanOrEqual(40);
		}
	}
	await expectNoPageOverflow(page);
	await menu.getByRole("menuitemradio", { name: "Binary" }).click();
	await expect(menu).toHaveCount(0);
	await expect(chip(image)).toHaveAccessibleName("Show as: Binary");
	// Today's binary rows; the box is still unticked (a pick writes nothing).
	const box = image.getByRole("checkbox", { name: "Mark cluster reviewed" });
	await expect(box).toBeVisible();
	await expect(box).not.toBeChecked();
	await expect(image.getByText("Binary file changed")).toBeVisible();
	await expect(chip(other)).toHaveAccessibleName("Show as: Image");

	await page.reload();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Binary",
	);
	await expect(chip(fileSection(page, BMP))).toHaveAccessibleName(
		"Show as: Image",
	);
	await expect(
		fileSection(page, PNG).getByRole("progressbar", { name: "File progress" }),
	).toHaveText(/0 \/ 1/);

	// And back.
	await chip(fileSection(page, PNG)).click();
	await page
		.getByRole("menu", { name: "Show as" })
		.getByRole("menuitemradio", { name: "Image" })
		.click();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Image",
	);
	await page.reload();
	await expect(chip(fileSection(page, PNG))).toHaveAccessibleName(
		"Show as: Image",
	);
	await expectNoPageOverflow(page);
});
