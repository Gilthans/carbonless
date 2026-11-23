import { describe, expect, it } from "vitest";
import { failureLine, MAX_MESSAGE, redact } from "./errorLog";
import { GhError } from "./errors";
import { GitError } from "./git";

describe("failureLine", () => {
	it("names the method, route pattern, status, class and review; the message's first line", () => {
		expect(
			failureLine({
				method: "GET",
				route: "/api/r/:id/placements",
				reviewId: "01abc",
				status: 500,
				error: new GitError("git diff failed: bad object\nmore"),
			}),
		).toBe(
			"crb: GET /api/r/:id/placements 500 GitError review 01abc: git diff failed: bad object",
		);
		expect(
			failureLine({
				method: "POST",
				route: undefined,
				reviewId: undefined,
				status: 502,
				error: new GhError("gh: HTTP 502"),
			}),
		).toBe("crb: POST ? 502 GhError: gh: HTTP 502");
	});

	it("never prints the access key, a URL, a token, or a review id that isn't one", () => {
		const line = failureLine({
			method: "GET",
			route: "/api/r/:id/threads",
			reviewId: "<script>",
			status: 502,
			error: new GhError(
				"fetch https://user:ghp_ABCDEF0123456789@github.com/o/r?key=k3y failed; key=k3y token=abc Authorization: Bearer abcdefghijkl k3y github_pat_XYZ123 \u001b[31m",
			),
			accessKey: "k3y",
		});
		for (const secret of [
			"k3y",
			"ghp_",
			"github_pat_",
			"github.com",
			"abcdefghijkl",
			"token=abc",
			"<script>",
			"\u001b",
		]) {
			expect(line).not.toContain(secret);
		}
		expect(line).toContain("fetch <url> failed");
	});

	it("cuts a long message", () => {
		expect(redact("x".repeat(MAX_MESSAGE * 2))).toHaveLength(MAX_MESSAGE + 1);
	});
});
