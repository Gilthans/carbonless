// What scripts/queue.mjs needs to know about a test command's arguments.

/**
 * Playwright flags that pick a few tests rather than the suite: a grep, the
 * last run's failures, specs changed since a ref. A run with them is short
 * (usually), so it doesn't wait for the queue.
 */
const PICKS = /^(-g|--grep|--grep-invert|--last-failed|--only-changed)(=|$)/;

/** Bare Playwright flags that take a value as the next word. */
const TAKES_VALUE = new Set([
	"-c",
	"--config",
	"-j",
	"--workers",
	"--project",
	"--reporter",
	"--repeat-each",
	"--retries",
	"--timeout",
	"--max-failures",
	"--output",
	"--shard",
	"--global-timeout",
	"--trace",
	"--grep",
	"-g",
	"--grep-invert",
]);

/**
 * True when `… playwright test <args>` runs some specs, not the whole suite:
 * a spec file or directory, a pattern, or a flag in PICKS. Only the words
 * after `test` count; a word after a flag in TAKES_VALUE is its value.
 */
export function filteredRun(args) {
	const at = args.indexOf("test");
	const words = args.slice(at + 1);
	return words.some((word, i) => {
		if (PICKS.test(word)) return true;
		if (word.startsWith("-")) return false;
		return !TAKES_VALUE.has(words[i - 1] ?? "");
	});
}
