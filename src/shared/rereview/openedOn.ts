/**
 * The patch set a thread was opened on: the one whose window, from its
 * start to the next one's, holds the thread's publication time. Earlier
 * than PS1 counts as PS1; null when there is no patch set (or no time).
 * Computed where the patch sets are known (the page's session), so a
 * patch set started after the threads were read still counts.
 *
 * Pure: nothing from `src/server/`.
 */
export function openedOn(
	createdAt: string,
	patchsets: readonly { number: number; startedAt: number }[],
): number | null {
	if (patchsets.length === 0) return null;
	const at = Date.parse(createdAt);
	if (Number.isNaN(at)) return null;
	const sorted = [...patchsets].sort((a, b) => a.startedAt - b.startedAt);
	let found = sorted[0]?.number ?? null;
	for (const p of sorted) {
		if (p.startedAt <= at) found = p.number;
		else break;
	}
	return found;
}
