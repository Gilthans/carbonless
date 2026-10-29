import type { Locator, Page } from "@playwright/test";
import {
	DEMO_PR,
	DEMO_THREADS,
	demoThreads,
} from "../test/fake-gh/demo-threads";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Who is who in the threads demo's threads (two people ping-ponging, a
 * third joining some): an
 * avatar beside every author, GitHub's or their initial, and a tint per
 * person, the same in every thread of the PR.
 */
const options: PrOptions = DEMO_PR;
/** The 7-comment thread's line, and the range thread's last. */
const TTL = DEMO_THREADS[0]?.place.line;
const MAP = DEMO_THREADS[4]?.place.line;

async function setup(pr: (opts?: PrOptions) => Promise<Pr>, page: Page) {
	const p = await pr(options);
	p.editScenario((s) => {
		const graph = s.prs[p.number]?.graphql;
		if (graph) graph.reviewThreads = demoThreads(p.repo);
	});
	// GitHub's avatars, served here: a tiny grey PNG, never the network.
	await page.route("https://avatars.githubusercontent.com/**", (route) =>
		route.fulfill({ contentType: "image/png", body: PNG }),
	);
	return p;
}

/** A 1x1 grey PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN4+/btfwAJdAPyRIT0OQAAAABJRU5ErkJggg==",
	"base64",
);

const humans = (page: Page) =>
	page.getByRole("region", { name: "Human reviews" });
const card = (page: Page, place: string) =>
	humans(page)
		.getByTestId("thread")
		.filter({
			has: page.getByTestId("thread-place").getByText(place, { exact: true }),
		});

const bg = (l: Locator) =>
	l.evaluate((el) => getComputedStyle(el).backgroundColor);

/** Each comment's author and its body's background, in order. */
async function tints(scope: Locator): Promise<[string, string][]> {
	const items = scope.getByTestId("thread-comment");
	const out: [string, string][] = [];
	for (let i = 0; i < (await items.count()); i++) {
		const item = items.nth(i);
		out.push([
			(await item.getAttribute("data-author")) ?? "",
			await bg(item.getByTestId("thread-comment-body")),
		]);
	}
	return out;
}

/** People's colours from `pairs` as login → colour, checking each keeps one. */
function byPerson(pairs: [string, string][]): Map<string, string> {
	const map = new Map<string, string>();
	for (const [who, color] of pairs) {
		const seen = map.get(who);
		if (seen) expect(color, `${who} keeps one tint`).toBe(seen);
		map.set(who, color);
	}
	return map;
}

async function expectNoPageOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
}

test("avatars, and a tint per person the same in every thread", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	// The showcase's twenty files and eight threads: a long walk.
	test.slow();
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr, page);
	const s = await startCrb();
	await page.goto(s.url);
	const ttl = card(page, `src/cache.ts:${TTL}`);
	// Closed: the opener's avatar in the header, the rest behind Show more.
	await expect(
		ttl.getByTestId("thread-head").getByTestId("avatar"),
	).toBeVisible();
	const more = ttl.getByTestId("thread-more");
	await expect(more).toHaveAccessibleName("Show more, 6 replies");
	await expect(ttl.getByTestId("thread-comment")).toHaveCount(0);
	// Waits on the viewer.
	await expect(ttl.getByRole("img", { name: "Your turn" })).toBeVisible();
	const shots = process.env.THREAD_SHOTS;
	const device = isMobile ? "phone" : "desktop";
	if (shots) {
		await ttl.scrollIntoViewIfNeeded();
		await ttl.screenshot({
			path: `${shots}/overview-card-closed-${device}.png`,
		});
	}
	await more.click();
	await expect(ttl.getByTestId("thread-comment")).toHaveCount(6);
	// GitHub's avatar where there is one, the initial where there isn't.
	const img = ttl
		.locator('[data-author="badyan"]')
		.first()
		.getByTestId("avatar");
	await expect(img).toHaveAttribute("alt", "");
	await expect
		.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	// A tint per person: the viewer, the author and badyan, three tints;
	// the viewer's opener on theirs too.
	const first = byPerson(await tints(ttl));
	expect([...first.keys()].sort()).toEqual([
		"Octo_Cat",
		"badyan",
		"octo-author",
	]);
	expect(new Set(first.values()).size).toBe(3);
	expect(await bg(ttl.getByTestId("thread-body"))).toBe(first.get("Octo_Cat"));
	// Different from the card it sits on.
	expect(await bg(ttl)).not.toBe(first.get("badyan"));
	await expectNoPageOverflow(page);
	if (shots) {
		await ttl.screenshot({ path: `${shots}/overview-card-open-${device}.png` });
	}
	// The same people in another thread keep their tints; dima (no
	// avatar: their initial) gets one of their own.
	const retry = card(page, `src/cache.ts:${MAP}`);
	await expect(
		retry.getByTestId("thread-head").getByTestId("avatar-fallback"),
	).toHaveAttribute("data-initial", "D");
	await retry.getByTestId("thread-more").click();
	await expect(retry.getByTestId("thread-comment")).toHaveCount(2);
	const second = byPerson(await tints(retry));
	for (const who of ["badyan", "octo-author"]) {
		expect(second.get(who), who).toBe(first.get(who));
	}
	const dima = await bg(retry.getByTestId("thread-body"));
	expect([...first.values()]).not.toContain(dima);
	// The buttons on a phone: 40px, no page scroll.
	for (const b of [
		retry.getByRole("button", { name: "Resolve", exact: true }),
		retry.getByTestId("reply-box").getByRole("button", { name: "Reply" }),
		retry.getByTestId("thread-more"),
	]) {
		expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
	}
	await expectNoPageOverflow(page);

	// Files changed: the same avatars and tints.
	await openFiles(page, s.url);
	const section = fileSection(page, "src/cache.ts");
	await section.getByRole("button", { name: "Expand file" }).click();
	const bubble = section.getByRole("button", {
		name: new RegExp(`^7 comments on line ${TTL}`),
	});
	await bubble.click();
	const opened = section.getByTestId("files-thread");
	await expect(opened.getByTestId("thread-comment")).toHaveCount(7);
	const files = byPerson(await tints(opened));
	for (const [who, color] of first) expect(files.get(who), who).toBe(color);
	await expect(
		opened.locator('[data-author="Octo_Cat"]').first().getByTestId("avatar"),
	).toBeVisible();
	await expect(
		opened.getByRole("button", { name: "Resolve", exact: true }),
	).toBeVisible();
	await expectNoPageOverflow(page);
	if (shots) {
		await opened.screenshot({
			path: `${shots}/files-thread-open-${device}.png`,
		});
	}
});
