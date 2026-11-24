import type { Collector } from "./collector";

/*
 * A page's milestones, read off what is on screen (not off the queries
 * behind it), so they hold however a page loads: Home's repos one by one
 * or all at once, a review's threads before or after its diff.
 *
 * Per route, the milestones and which of them end the page's span:
 * - overview: header, threads (the list, its skeleton gone), threads_code
 *   (no thread's code still loading); ends at threads_code. A failed
 *   threads read (the list's data-state) is a milestone with an error,
 *   and the page ends failed, never complete.
 * - files: header, first_file (the first file with nothing busy in it),
 *   where it ends; and diff_rows (the first diff line on screen), `user`:
 *   files open collapsed unless the address lands on one, so it may come
 *   with the reviewer's first click, after the page's span ended.
 * - verdict: header.
 * - home: home_rows (a row), home_done (no skeleton row, no repo loading),
 *   and per view repo (by its index, never its name) repo_rows, repo_done;
 *   a repo whose read failed ends the page failed.
 * - any other page ends at once.
 */

const q = (root: ParentNode, selector: string) =>
	root.querySelector(selector) !== null;

/** Milestones still looked for after their page's span ended. */
const LATE: Record<string, string> = { files: "browser.ui.diff_rows" };

/** Whether the page's milestones are still looked for. */
export function watching(trace: Collector): boolean {
	if (trace.pageOpen) return true;
	const late = LATE[trace.page.route];
	return late !== undefined && !trace.reached(late);
}

/** Checks the page's milestones against `root`; ends the page once its last is in. */
export function checkMilestones(root: ParentNode, trace: Collector): void {
	if (!watching(trace)) return;
	const { route } = trace.page;
	if (route === "files" && q(root, '[data-testid="diff-line"]')) {
		trace.milestone("browser.ui.diff_rows", undefined, undefined, {
			user: true,
		});
	}
	if (!trace.pageOpen) return;
	if (route === "overview" || route === "files" || route === "verdict") {
		if (q(root, '[data-testid="header-title"]'))
			trace.milestone("browser.ui.header");
	}
	if (route === "overview") {
		if (
			q(root, '[data-trace="threads"]') &&
			!q(root, '[data-testid="threads-loading"]')
		) {
			const threads = root.querySelectorAll('[data-testid="thread"]').length;
			if (q(root, '[data-trace="threads"][data-state="failed"]')) {
				trace.milestone("browser.ui.threads", { threads }, undefined, {
					error: "failed",
				});
				trace.endPage("failed");
				return;
			}
			trace.milestone("browser.ui.threads", { threads });
			if (!q(root, '[data-testid="thread-code-loading"]')) {
				trace.milestone("browser.ui.threads_code", { threads });
			}
		}
		if (
			trace.reached("browser.ui.header") &&
			trace.reached("browser.ui.threads_code")
		)
			trace.endPage("complete");
		return;
	}
	if (route === "files") {
		const first = root.querySelector("[data-file-index]");
		if (first && !q(first, '[aria-busy="true"]')) {
			trace.milestone("browser.ui.first_file", {
				files: root.querySelectorAll("[data-file-index]").length,
			});
		}
		if (
			trace.reached("browser.ui.header") &&
			trace.reached("browser.ui.first_file")
		)
			trace.endPage("complete");
		return;
	}
	if (route === "verdict") {
		if (trace.reached("browser.ui.header")) trace.endPage("complete");
		return;
	}
	if (route === "home") {
		checkHome(root, trace);
		return;
	}
	trace.endPage("complete");
}

function checkHome(root: ParentNode, trace: Collector): void {
	const rows = [
		...root.querySelectorAll<HTMLElement>('[data-testid="home-row"]'),
	];
	if (rows.length > 0)
		trace.milestone("browser.ui.home_rows", { rows: rows.length });
	const chips = [
		...root.querySelectorAll<HTMLElement>('[data-testid="view-repo"]'),
	];
	const repos = chips.length;
	chips.forEach((chip, index) => {
		const name = chip.dataset.repo?.toLowerCase();
		if (!name) return;
		const mine = rows.filter((r) => r.dataset.repo?.toLowerCase() === name);
		if (mine.length > 0) {
			trace.milestone(
				"browser.ui.repo_rows",
				{ "repo.index": index, repos, rows: mine.length },
				`repo_rows:${name}`,
			);
		}
		const state = chip.dataset.state;
		if (state === "ready" || state === "failed") {
			trace.milestone(
				"browser.ui.repo_done",
				{ "repo.index": index, repos, rows: mine.length, "repo.state": state },
				`repo_done:${name}`,
			);
		}
	});
	const loading =
		q(root, '[data-testid="row-skeleton"]') ||
		q(root, '[data-testid="view-repo"][data-state="loading"]') ||
		q(root, '[data-testid="view-repo"][data-state="saving"]');
	if (q(root, "[data-section]") && !loading) {
		const failed = root.querySelectorAll(
			'[data-testid="view-repo"][data-state="failed"]',
		).length;
		trace.milestone(
			"browser.ui.home_done",
			{ rows: rows.length, repos, ...(failed ? { failed } : {}) },
			undefined,
			failed ? { error: "failed" } : {},
		);
		trace.endPage(failed ? "failed" : "complete");
	}
}
