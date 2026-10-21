import { expect, test } from "./fixtures";

test("shows the two compared commits", async ({
	page,
	makeRepo,
	startCarbonless,
}) => {
	const repo = makeRepo([
		{ message: "First version", files: { "readme.md": "# Hello\n" } },
		{ message: "Second version", files: { "readme.md": "# Hello, world\n" } },
	]);
	const server = await startCarbonless(repo.path);

	await page.goto(server.url);

	const base = page.getByRole("region", { name: "Base" });
	const head = page.getByRole("region", { name: "Head" });
	await expect(base.getByText("First version")).toBeVisible();
	await expect(head.getByText("Second version")).toBeVisible();
	await expect(base.getByText(repo.shas[0]?.slice(0, 7) ?? "")).toBeVisible();
});

test("compares explicit refs passed on the command line", async ({
	page,
	makeRepo,
	startCarbonless,
}) => {
	const repo = makeRepo([
		{ message: "One", files: { "a.txt": "1\n" } },
		{ message: "Two", files: { "a.txt": "2\n" } },
		{ message: "Three", files: { "a.txt": "3\n" } },
	]);
	const server = await startCarbonless(repo.path, {
		args: [repo.shas[0] ?? "", "HEAD~1"],
	});

	await page.goto(server.url);

	await expect(
		page.getByRole("region", { name: "Base" }).getByText("One"),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Head" }).getByText("Two"),
	).toBeVisible();
});
