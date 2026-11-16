export type GatePr = {
	number?: number | string;
	title?: string;
	html_url?: string;
	base?: { ref?: string };
	head?: { ref?: string; repo?: { full_name?: string } | null };
};
export type Gate = {
	ok: boolean;
	frozen: boolean;
	blocker: string | null;
	message: string;
};
export function isNextPr(pr: GatePr | null | undefined, repo: string): boolean;
export function releaseGate(input: {
	version: string;
	tags: unknown;
	npmVersions?: unknown;
	pulls: unknown;
	repo: string;
	pr?: GatePr;
}): Gate;
