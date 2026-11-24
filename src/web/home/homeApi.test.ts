import { describe, expect, it } from "vitest";
import type { RepoHome } from "../../shared/home";
import {
	askOf,
	PROGRESS_ERROR_MS,
	PROGRESS_POLL_MS,
	repoInterval,
	repoRefetchInterval,
} from "./homeApi";

const answer = (over: Partial<RepoHome> = {}): RepoHome => ({
	repo: "acme/api",
	rows: [],
	refreshedAt: "2026-11-24T12:00:00Z",
	error: null,
	failures: 0,
	...over,
});

describe("a repo's next ask (CAR-290 fix round 1)", () => {
	it("while a first read lands: at once; after a failed ask, PROGRESS_ERROR_MS (never 10 a second)", () => {
		const landing = answer({ complete: false, progress: 2, refreshedAt: null });
		expect(repoRefetchInterval(2, { status: "success", data: landing })).toBe(
			PROGRESS_POLL_MS,
		);
		expect(repoRefetchInterval(2, { status: "error", data: landing })).toBe(
			PROGRESS_ERROR_MS,
		);
		expect(PROGRESS_ERROR_MS).toBeGreaterThanOrEqual(5_000);
		// Whole: refresh.minutes, as before.
		const whole = answer({ complete: true });
		expect(repoRefetchInterval(2, { status: "error", data: whole })).toBe(
			repoInterval(2, whole),
		);
	});

	it("says what the page shows: the batches seen, or a whole list (never cut to a batch)", () => {
		expect(askOf(undefined)).toEqual({});
		expect(askOf(answer({ complete: false, progress: 3 }))).toEqual({
			seen: 3,
		});
		expect(askOf(answer({ complete: true }))).toEqual({ whole: true });
		// An older answer without `complete` is whole.
		expect(askOf(answer())).toEqual({ whole: true });
		// Rows of a first read that failed: not whole, the next read may show batches.
		expect(askOf(answer({ error: "boom", refreshedAt: null }))).toEqual({});
	});
});
