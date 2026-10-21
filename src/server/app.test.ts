import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitFixture, type GitFixture } from "../../test/git-fixture";
import { buildApp } from "./app";

describe("GET /api/comparison", () => {
	let repo: GitFixture;

	beforeAll(() => {
		repo = createGitFixture([
			{ message: "Add greeting", files: { "hello.txt": "hello\n" } },
			{ message: "Change greeting", files: { "hello.txt": "hi\n" } },
		]);
	});

	afterAll(() => repo.cleanup());

	it("returns both commits", async () => {
		const app = await buildApp({
			repoPath: repo.path,
			base: "HEAD~1",
			head: "HEAD",
		});
		const response = await app.inject({
			method: "GET",
			url: "/api/comparison",
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			repoPath: repo.path,
			base: { sha: repo.shas[0], subject: "Add greeting" },
			head: { sha: repo.shas[1], subject: "Change greeting" },
		});
	});

	it("returns 400 with git's message for a bad ref", async () => {
		const app = await buildApp({
			repoPath: repo.path,
			base: "nope",
			head: "HEAD",
		});
		const response = await app.inject({
			method: "GET",
			url: "/api/comparison",
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toBeTruthy();
	});
});
