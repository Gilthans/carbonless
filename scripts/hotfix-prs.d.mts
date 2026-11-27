export type HotfixCommit = { sha: string; parents: string[]; subject: string };
export function parseCommits(text: string): HotfixCommit[];
export function checkHotfixPrs(args: {
	commits: HotfixCommit[];
	pulls: unknown;
	rules: unknown;
	branch: string;
}): string;
export function prMerges(
	commits: HotfixCommit[],
	branch: string,
): { sha: string; number: number }[];
