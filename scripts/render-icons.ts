/**
 * Renders the PNG favicons from src/web/brand/mark.svg into src/web/public
 * (committed; rerun after changing the mark): `pnpm icons`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const web = resolve(import.meta.dirname, "../src/web");
const svg = readFileSync(resolve(web, "brand/mark.svg")).toString("base64");
const src = `data:image/svg+xml;base64,${svg}`;

/** [file, size, background] — the touch icon sits on the app's surface. */
const ICONS: [string, number, string | null][] = [
	["favicon-16.png", 16, null],
	["favicon-32.png", 32, null],
	["apple-touch-icon.png", 180, "#12141f"],
];

const browser = await chromium.launch();
try {
	for (const [file, size, background] of ICONS) {
		const page = await browser.newPage({
			viewport: { width: size, height: size },
		});
		const pad = background ? Math.round(size * 0.14) : 0;
		await page.setContent(
			`<body style="margin:0;background:${background ?? "transparent"}">` +
				`<img src="${src}" style="display:block;width:${size - 2 * pad}px;height:${size - 2 * pad}px;margin:${pad}px"></body>`,
		);
		await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
		await page.screenshot({
			path: resolve(web, "public", file),
			omitBackground: background === null,
		});
		await page.close();
	}
} finally {
	await browser.close();
}
