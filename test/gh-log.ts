/**
 * The calls of a fake gh log (PrFixture.ghLog), one string each: a call is
 * logged as its arguments on one line, so a query's own lines go with the
 * call they belong to (a call starts with a gh command word).
 */
export function ghCallsOf(log: string): string[] {
	const calls: string[] = [];
	for (const line of log.split("\n")) {
		if (/^(api|auth|pr|repo|search) /.test(line)) calls.push(line);
		else if (calls.length > 0) calls[calls.length - 1] += `\n${line}`;
	}
	return calls;
}

/**
 * What a gh call reads, for counting a read's calls: `overview` (the one
 * query of its first paint), `threads` (a page of their summaries),
 * `timeline`, `contents` (threads' comments), `head` (the PR's head and
 * base), `viewer` (the gh login), else its first 40 characters.
 */
function ghCallKind(call: string): string {
	if (/^api graphql .*query PrOverview\(/s.test(call)) return "overview";
	if (/reviewThreads\((first|last): /.test(call)) return "threads";
	if (/timelineItems\(/.test(call)) return "timeline";
	if (/nodes\(ids:/.test(call)) return "contents";
	if (/^pr view .*headRefOid/.test(call)) return "head";
	if (/^api graphql .*query \{ viewer \{ login/s.test(call)) return "viewer";
	return call.slice(0, 40);
}

/** The kinds (ghCallKind) of a fake gh log's calls after the first `from`, sorted. */
export function ghCallKinds(log: string, from = 0): string[] {
	return ghCallsOf(log).slice(from).map(ghCallKind).sort();
}
