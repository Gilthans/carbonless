import type { Locator, Page } from "@playwright/test";
import {
	DEMO_FILES,
	DEMO_PEOPLE,
	demoThreads,
} from "../test/fake-gh/demo-threads";
import { fileSection, openFiles } from "./files-ui";
import { expect, type Pr, type PrOptions, test } from "./fixtures";

/**
 * Who is who in long, many-party threads (the threads demo's data): an
 * avatar beside every author, GitHub's or their initial, and a tint per
 * person, the same in every thread of the PR.
 */
const options: PrOptions = {
	baseDate: "2026-01-01T00:00:00Z",
	files: DEMO_FILES,
	scenario: {
		user: {
			login: DEMO_PEOPLE.viewer.login,
			avatarUrl: DEMO_PEOPLE.viewer.avatarUrl,
		},
	},
};

async function setup(pr: (opts?: PrOptions) => Promise<Pr>, page: Page) {
	const p = await pr(options);
	const head = p.repo.shas.at(-1) ?? "";
	p.editScenario((s) => {
		const graph = s.prs[p.number]?.graphql;
		if (graph) graph.reviewThreads = demoThreads(head);
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

test("a many-party thread: avatars, and a tint per person the same in every thread", async ({
	page,
	pr,
	startCrb,
	isMobile,
}) => {
	if (isMobile) await page.setViewportSize({ width: 360, height: 780 });
	await setup(pr, page);
	const s = await startCrb();
	await page.goto(s.url);
	const ttl = card(page, "src/cache.ts:12");
	// Closed: the opener's avatar in the header, the rest behind Show more.
	await expect(
		ttl.getByTestId("thread-head").getByTestId("avatar"),
	).toBeVisible();
	const more = ttl.getByTestId("thread-more");
	await expect(more).toHaveAccessibleName("Show more, 9 replies");
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
	await expect(ttl.getByTestId("thread-comment")).toHaveCount(9);
	// GitHub's avatar where there is one, the initial where there isn't.
	const img = ttl
		.locator('[data-author="badyan"]')
		.first()
		.getByTestId("avatar");
	await expect(img).toHaveAttribute("alt", "");
	await expect
		.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	const dima = ttl.locator('[data-author="dima"]').first();
	await expect(dima.getByTestId("avatar-fallback")).toHaveAttribute(
		"data-initial",
		"D",
	);
	// A tint per person: five people, five tints; the opener's body too.
	const first = byPerson(await tints(ttl));
	expect(new Set(first.values()).size).toBe(first.size);
	expect(first.size).toBe(5);
	expect(await bg(ttl.getByTestId("thread-body"))).toBe(first.get("badyan"));
	// Different from the card it sits on.
	expect(await bg(ttl)).not.toBe(first.get("badyan"));
	await expectNoPageOverflow(page);
	if (shots) {
		await ttl.screenshot({ path: `${shots}/overview-card-open-${device}.png` });
	}
	// The same people in another thread keep their tints.
	const retry = card(page, "src/api/client.ts:34");
	await retry.getByTestId("thread-more").click();
	await expect(retry.getByTestId("thread-comment")).toHaveCount(11);
	const second = byPerson(await tints(retry));
	for (const who of ["badyan", "dima", "lena", "octo-author"]) {
		expect(second.get(who), who).toBe(first.get(who));
	}
	expect(second.get("sam-k")).not.toBe(undefined);
	expect([...first.values()]).not.toContain(second.get("sam-k"));
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
		name: /^10 comments on line 12/,
	});
	await bubble.click();
	const opened = section.getByTestId("files-thread");
	await expect(opened.getByTestId("thread-comment")).toHaveCount(10);
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
