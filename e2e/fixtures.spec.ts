import { expect, test, watchConsoleErrors } from "./fixtures";

// The harness itself: console errors fail a test unless declared.

test("a declared console error passes", async ({
	page,
	expectConsoleError,
}) => {
	expectConsoleError(/expected boom/);
	await page.evaluate(() => console.error("expected boom"));
});

test("an undeclared console error is reported", async ({ context }) => {
	// A second page: the auto fixture watches only `page`, so this test sees
	// what the watcher reports without failing (no test.fail(), whose expected
	// failure prints a ✘ on every run).
	const other = await context.newPage();
	const watch = watchConsoleErrors(other);
	watch.expect(/expected boom/);
	await other.evaluate(() => {
		console.error("expected boom");
		console.error("surprise");
		setTimeout(() => {
			throw new Error("uncaught");
		});
	});
	await expect.poll(() => watch.unexpected()).toEqual(["surprise", "uncaught"]);
});
