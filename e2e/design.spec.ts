import type { Page } from "@playwright/test";
import { reviewThread, threadComment } from "../test/fake-gh/scenario";
import { fileSection, openFiles } from "./files-ui";
import { expect, type PrOptions, test } from "./fixtures";

/*
 * Screenshots for design review, not assertions: runs only with
 * DESIGN_SHOTS=<dir> (`DESIGN_SHOTS=/tmp/shots pnpm test:e2e design`).
 */
const dir = process.env.DESIGN_SHOTS;
test.skip(!dir, "set DESIGN_SHOTS to a directory to take design screenshots");

const lines = (s: string) => `${s.trim()}\n`;

const CACHE_BEFORE = lines(`
import { readFile } from "node:fs/promises";
import type { Widget } from "./types";

/** Loads widgets from disk every time. */
export class WidgetStore {
	constructor(private readonly root: string) {}

	async get(id: string): Promise<Widget> {
		const raw = await readFile(\`\${this.root}/\${id}.json\`, "utf8");
		return JSON.parse(raw) as Widget;
	}

	async list(ids: string[]): Promise<Widget[]> {
		const out: Widget[] = [];
		for (const id of ids) out.push(await this.get(id));
		return out;
	}
}

${Array.from({ length: 40 }, (_, i) => `export const LIMIT_${i} = ${i * 8};`).join("\n")}

export function describe(w: Widget): string {
	return \`\${w.name} (\${w.size})\`;
}
`);

const CACHE_AFTER = lines(`
import { readFile } from "node:fs/promises";
import type { Widget } from "./types";

const TTL_MS = 30_000; // keep entries for 30 seconds

/** Loads widgets from disk, caching each for TTL_MS. */
export class WidgetStore {
	private readonly cache = new Map<string, { at: number; widget: Widget }>();

	constructor(private readonly root: string) {}

	async get(id: string): Promise<Widget> {
		const hit = this.cache.get(id);
		if (hit && Date.now() - hit.at < TTL_MS) return hit.widget;
		const raw = await readFile(\`\${this.root}/\${id}.json\`, "utf8");
		const widget = JSON.parse(raw) as Widget;
		this.cache.set(id, { at: Date.now(), widget });
		return widget;
	}

	async list(ids: string[]): Promise<Widget[]> {
		return Promise.all(ids.map((id) => this.get(id)));
	}
}

${Array.from({ length: 40 }, (_, i) => `export const LIMIT_${i} = ${i * 8};`).join("\n")}

export function describe(w: Widget): string {
	return \`\${w.name} · \${w.size} bytes\`;
}
`);

const fixture: PrOptions = {
	overview: {
		title: "Cache widgets between requests",
		headRefName: "feature/widget-cache",
	},
	bodyHTML: [
		'<p dir="auto">Widgets were read from disk on <strong>every</strong> request. This keeps each one for 30 seconds.</p>',
		'<ul dir="auto"><li>Adds a TTL cache to <code class="notranslate">WidgetStore</code></li><li>Loads lists in parallel</li></ul>',
		'<div class="highlight highlight-source-ts notranslate position-relative overflow-auto" dir="auto"><pre><span class="pl-k">const</span> <span class="pl-c1">TTL_MS</span> <span class="pl-c1">=</span> <span class="pl-c1">30_000</span><span class="pl-kos">;</span></pre></div>',
	].join("\n"),
	base: {
		"src/cache/store.ts": CACHE_BEFORE,
		"src/cache/types.ts": lines(`
export interface Widget {
	name: string;
	size: number;
}
`),
		"docs/caching.md": lines(`
# Caching

Nothing is cached yet.
`),
		"scripts/bench.sh": lines(`
#!/bin/sh
node bench.js
`),
	},
	files: [
		{
			message: "Cache widgets",
			files: {
				"src/cache/store.ts": CACHE_AFTER,
				"src/cache/types.ts": lines(`
export interface Widget {
	name: string;
	/** Bytes on disk. */
	size: number;
}
`),
				"docs/caching.md": lines(`
# Caching

Widgets are cached for **30 seconds** after their first read.
`),
				"scripts/bench.sh": lines(`
#!/bin/sh
set -eu
node bench.js --runs 20
`),
				"config/cache.json": lines(`
{ "ttlMs": 30000, "maxEntries": 500 }
`),
			},
		},
	],
	threads: [
		reviewThread({ path: "src/cache/store.ts", line: 4 }, [
			threadComment({
				login: "lint-bot",
				bot: true,
				text: "TTL_MS could come from config/cache.json",
				html: '<p dir="auto"><code class="notranslate">TTL_MS</code> could come from config/cache.json</p>',
			}),
		]),
		reviewThread({ path: "src/cache/store.ts", line: 15 }),
		reviewThread({ path: "src/cache/index.ts", line: 2 }, [
			threadComment({
				login: "devon",
				text: "Long",
				html: Array.from(
					{ length: 9 },
					(_, i) =>
						`<p dir="auto">Point ${i + 1}: the cache should be keyed by <code class="notranslate">widgetId</code>.</p>`,
				).join("\n"),
			}),
			threadComment({ login: "octo-author", text: "Agreed" }),
		]),
	],
	reviews: [
		{
			author: { login: "mira", __typename: "User" },
			state: "APPROVED",
			submittedAt: "2026-01-04T09:00:00Z",
		},
		{
			author: { login: "devon", __typename: "User" },
			state: "CHANGES_REQUESTED",
			submittedAt: "2026-01-04T11:00:00Z",
		},
	],
};

async function shot(page: Page, name: string, isMobile: boolean, full = false) {
	await page.waitForTimeout(250);
	await page.screenshot({
		path: `${dir}/design-${name}-${isMobile ? "phone" : "desktop"}.png`,
		fullPage: full,
	});
}

test("design screenshots", async ({ page, pr, startCrb, isMobile }) => {
	test.setTimeout(60_000);
	if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
	else await page.setViewportSize({ width: 1360, height: 860 });
	await page.route("https://**/*", (route) => route.abort());
	await pr(fixture);
	const s = await startCrb();

	await page.goto(s.url);
	await expect(page.getByRole("region", { name: "Is it ready" })).toBeVisible();
	await shot(page, "overview", isMobile, true);
	// The checks list open, and the long thread expanded.
	await page.getByRole("button", { name: /failing/ }).click();
	await page
		.getByTestId("thread")
		.filter({ hasText: "Point 1:" })
		.getByRole("button", { name: "Show more" })
		.click();
	await page.evaluate(() => window.scrollTo(0, 0));
	await shot(page, "overview-open", isMobile, true);

	// A tooltip: the compact Refresh button's.
	await page.getByRole("button", { name: "Refresh" }).focus();
	await shot(page, "tooltip", isMobile);
	await page.keyboard.press("Escape");

	await openFiles(page, s.url, "Lines");
	await shot(page, "files-top", isMobile);

	// Reviewed and crossed-off clusters, a done file and a crossed-off file.
	await fileSection(page, "docs/caching.md")
		.getByRole("button", { name: "Mark remaining reviewed" })
		.click();
	await fileSection(page, "scripts/bench.sh")
		.getByRole("button", { name: "Cross off file" })
		.click();
	const store = fileSection(page, "src/cache/store.ts");
	await store.getByRole("button", { name: "Expand file" }).click();
	const box = store
		.getByRole("checkbox", { name: "Mark cluster reviewed" })
		.first();
	await box.click();
	await expect(box).toBeChecked();
	await store.getByRole("button", { name: "Cross off cluster" }).last().click();
	await expect(store.getByText("Crossed off")).toBeVisible();
	await page.evaluate(() => window.scrollTo(0, 0));
	await shot(page, "files-diff", isMobile);

	// Scrolled into the diff: header, progress bar and file header stuck.
	await store
		.getByTestId("diff-line")
		.filter({ hasText: "return Promise.all" })
		.first()
		.evaluate((el) => el.scrollIntoView({ block: "center" }));
	await shot(page, "files-sticky", isMobile);

	// A file header's progress tooltip.
	await store.getByRole("progressbar", { name: "File progress" }).focus();
	await shot(page, "tooltip-progress", isMobile);
	await page.keyboard.press("Escape");

	if (isMobile) {
		await page.getByRole("button", { name: "Files", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Files" })).toBeVisible();
		await shot(page, "tree-sheet", isMobile);
	}
});
