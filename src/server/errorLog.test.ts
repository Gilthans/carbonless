import { describe, expect, it } from "vitest";
import {
	FAILURE_LOG_WINDOW_MS,
	FailureLog,
	failureLine,
	MAX_MESSAGE,
	redact,
} from "./errorLog";
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

	it("cuts out a credential before a host with no scheme, a Bearer: value, and every line break or control character (C1, U+2028/9, NEL)", () => {
		const line = redact(
			"fetch x-access-token:abcdEFGH1234@github.com/o/r failed; Authorization: Bearer: abcdefghijklmnop; a\u2028forged line\u2029b\u0085c\u009b31md",
		);
		for (const secret of [
			"abcdEFGH1234",
			"x-access-token",
			"abcdefghijklmnop",
		]) {
			expect(line).not.toContain(secret);
		}
		expect(line).toMatch(/<credentials>@github\.com/);
		expect(line).not.toMatch(/[\u0080-\u009f\u2028\u2029]/);
		// A line break ends the line: what follows never shows as a line of its own.
		expect(line).not.toContain("forged line");
		// Paths stay: they say where.
		expect(redact("git failed in /home/x/.cache/carbonless/repos/o/r")).toBe(
			"git failed in /home/x/.cache/carbonless/repos/o/r",
		);
		expect(redact("a\u009b31mb")).toBe("a 31mb");
	});

	it("cuts a long message", () => {
		expect(redact("x".repeat(MAX_MESSAGE * 2))).toHaveLength(MAX_MESSAGE + 1);
	});
});

describe("FailureLog", () => {
	it("logs the same failure (review, route, status, class) once a minute, then says how many it left out", () => {
		const lines: string[] = [];
		let now = 1_000_000;
		const log = new FailureLog(
			(l) => lines.push(l),
			() => now,
		);
		const failure = (reviewId: string, error: Error) => ({
			method: "GET",
			route: "/api/r/:id/placements",
			reviewId,
			status: 500,
			error,
		});
		log.log(failure("r1", new GitError("one")));
		log.log(failure("r1", new GitError("two")));
		log.log(failure("r1", new GitError("three")));
		// Another review, another class: their own lines.
		log.log(failure("r2", new GitError("other review")));
		log.log(failure("r1", new GhError("gh down")));
		expect(lines).toHaveLength(3);
		now += FAILURE_LOG_WINDOW_MS - 1;
		log.log(failure("r1", new GitError("four")));
		expect(lines).toHaveLength(3);
		now += 1;
		log.log(failure("r1", new GitError("five")));
		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain(
			": five (and 3 more like it in the last minute)",
		);
	});
});
