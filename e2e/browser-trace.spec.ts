import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLUSH_MS } from "../src/web/trace/collector";
import { homePr } from "../test/fake-gh/scenario";
import { expect, installClock, reviewPage, test } from "./fixtures";

/*
 * The page's spans (CAR-288): a crb serve that traces, with them on, puts
 * them in its trace files, and its own request spans under the page's
 * fetches (their traceparent).
 */

// Its own crb serve, tracing into <workdir>/trace with the page's spans on.
test.use({ crbServer: "own", browserTrace: true });

interface OtlpSpan {
	name: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	attributes: { key: string; value: Record<string, unknown> }[];
}

function readSpans(dir: string): OtlpSpan[] {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return [];
	}
	return files.flatMap((f) =>
		readFileSync(join(dir, f), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) =>
				(
					JSON.parse(line) as {
						resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
					}
				).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
			),
	);
}

const attr = (s: OtlpSpan, key: string) => {
	const v = s.attributes.find((a) => a.key === key)?.value;
	return v ? Object.values(v)[0] : undefined;
};

test("a review and Home record their spans, the server's requests under the page's", async ({
	page,
	context,
	expectConsoleError,
	workdir,
	pr,
	startCrb,
	ownerRepo,
	prNumber,
}) => {
	const TITLE = "Secret title never in a span";
	const made = await pr();
	made.editScenario((s) => {
		s.repos = {
			[ownerRepo]: {
				prs: [
					homePr({
						repo: ownerRepo,
						number: prNumber,
						title: TITLE,
						author: "alice",
					}),
				],
			},
		};
	});
	const config = join(workdir, "config", "carbonless");
	mkdirSync(config, { recursive: true });
	writeFileSync(
		join(config, "config.json"),
		JSON.stringify({ views: [{ name: "Mine", repos: [ownerRepo] }] }),
	);
	// The fake avatars' host doesn't resolve.
	expectConsoleError(/ERR_NAME_NOT_RESOLVED/);
	const crb = await startCrb();
	// The harness's traceparent (the test's) would stand in for the page's.
	await context.setExtraHTTPHeaders({});
	const dir = join(workdir, "trace");
	// The page posts its spans every FLUSH_MS: each page's land before the
	// next (a beacon on leaving isn't something a test can wait for).
	await installClock(page);
	const landed = (names: string[], documents: number) =>
		expect
			.poll(
				async () => {
					await page.clock.fastForward(FLUSH_MS);
					const got = readSpans(dir).map((s) => s.name);
					const roots = got.filter((n) => n === "browser.navigation");
					return [
						...names.filter((n) => !got.includes(n)),
						...(roots.length < documents ? ["browser.navigation"] : []),
					];
				},
				{ message: "the page's spans reach the trace" },
			)
			.toEqual([]);

	await page.goto(crb.url);
	await expect(page.getByTestId("header-title")).toBeVisible();
	await landed(["browser.ui.header", "browser.ui.threads_code"], 1);
	await page.goto(reviewPage(crb.url, "files"));
	// Files open collapsed: the first diff rows come with a click.
	await page
		.getByRole("region", { name: "a.txt" })
		.getByRole("button", { name: "Expand file" })
		.click();
	await expect(page.getByTestId("diff-line").first()).toBeVisible();
	await landed(["browser.ui.first_file", "browser.ui.diff_rows"], 2);
	await page.goto(new URL("/", crb.url).href);
	await expect(page.getByText(TITLE)).toBeVisible();
	await landed(
		["browser.ui.home_rows", "browser.ui.home_done", "browser.ui.repo_done"],
		3,
	);
	// Its exit writes the server's buffered request spans.
	await crb.stop();
	const spans = readSpans(dir);
	const browser = spans.filter((s) => s.name.startsWith("browser."));
	const roots = browser.filter((s) => s.name === "browser.navigation");
	expect(roots).toHaveLength(3);
	expect(roots.map((r) => attr(r, "route"))).toEqual(
		expect.arrayContaining(["overview", "files", "home"]),
	);
	for (const root of roots) expect(root.parentSpanId).toBeUndefined();
	// Every page span hangs off its document's navigation.
	const pages = browser.filter((s) => s.name === "browser.page");
	for (const p of pages) {
		expect(roots.map((r) => r.spanId)).toContain(p.parentSpanId);
	}
	// The server's request spans of the review's reads sit under the
	// page's fetches, in the page's trace.
	const fetches = browser.filter((s) => s.name === "browser.fetch");
	const review = fetches.find((f) => attr(f, "api") === "/api/r/:id/review");
	expect(review, "the page's /review fetch").toBeDefined();
	const served = spans.filter(
		(s) => s.parentSpanId === review?.spanId && !s.name.startsWith("browser."),
	);
	expect(served.map((s) => s.name)).toEqual([
		expect.stringMatching(/^GET \/api\/r\/:id\/review$/),
	]);
	expect(served[0]?.traceId).toBe(review?.traceId);
	// No PR text, repo or path in what the page sent.
	const sent = JSON.stringify(browser);
	expect(sent).not.toContain(TITLE);
	expect(sent).not.toContain(ownerRepo);
});
