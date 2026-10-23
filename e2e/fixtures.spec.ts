import { test } from "./fixtures";

// The harness itself: console errors fail a test unless declared.

test("a declared console error passes", async ({
	page,
	expectConsoleError,
}) => {
	expectConsoleError(/expected boom/);
	await page.evaluate(() => console.error("expected boom"));
});

test("an undeclared console error fails the test", async ({
	page,
	expectConsoleError,
}) => {
	test.fail();
	expectConsoleError(/expected boom/);
	await page.evaluate(() => console.error("surprise"));
});
