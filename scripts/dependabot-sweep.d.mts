export const BOT: string;
export const TRAILER: string;
export const PROTECTED: RegExp[];
export const AGENT_FORBIDDEN: RegExp[];
export const COMMENT_MAX: number;
export interface Bump {
	name: string;
	from: string | null;
	to: string;
	kind?: "major" | "added";
}
export interface Alert {
	package: string;
	ghsa: string;
	patched: string;
}
export interface Action {
	type:
		| "skip"
		| "owner"
		| "rebase"
		| "wait"
		| "add-note"
		| "refresh-note"
		| "rerun"
		| "agent"
		| "merge";
	reason: string;
	comment?: string;
	key?: string;
	sha?: string;
	note?: string;
	runIds?: string[];
	failure?: { check: string; runId: string; jobId: string; kind: string };
}
export function matching(files: string[], patterns?: RegExp[]): string[];
export function versionOf(range: string): [number, number] | null;
export function isBreaking(from: string, to: string): boolean;
export function breakingBumps(basePkg: unknown, headPkg: unknown): Bump[];
export function dependabotNames(title: string, messages?: string[]): string[];
export function metadataMajor(messages?: string[]): boolean;
export function manifestProblems(o: {
	files: string[];
	basePkg: unknown;
	headPkg: unknown;
	names: string[];
	addedLockLines: string[];
}): string[];
export function codeBlock(s: string): string;
export const NONE_NOTE: string;
export function isSweepNote(line: string): boolean;
export function otherNoteLines(body: string | null | undefined): string[];
export const AGENT_ACK: string;
export function agentEnabledFrom(env: Record<string, string | undefined>): {
	on: boolean;
	refused?: string;
};
export function bumpFromTitle(
	title: string,
): { name: string; from: string; to: string } | null;
export function hasReleaseNote(
	body: string | null | undefined,
	note?: string,
): boolean;
export function releaseNote(
	bump: { name: string; to: string } | null,
	alerts: Alert[],
): string;
export function classifyJob(job: unknown): "test" | "build" | "infra";
// biome-ignore lint/suspicious/noExplicitAny: facts are plain JSON from gh
export function decide(facts: any): Action;
export function scrub(text: string, max?: number): string;
export function agentChangeProblems(files: string[]): string[];
export function parseResult(text: string): {
	status: "fixed" | "cannot-fix";
	summary: string;
};
export function sandboxArgs(o: {
	home: string;
	repo: string;
	worktree: string;
	emptyDir: string;
	gitdir?: string;
}): string[];
export function agentArgs(o: { worktree: string; home: string }): string[];
