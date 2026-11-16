export type Failure = {
	file: string;
	title: string;
	project: string | null;
	line?: number;
	error: string;
};
export type Labelled = Omit<Failure, "line"> & {
	verdict: "flaky" | "consistent" | "not-rerun";
	rerunError?: string;
};
export type Results = {
	failed: Failure[];
	passed: { file: string; title: string; project: string | null }[];
};
export const RERUN_CAP: number;
export const WHOLE_FILE: string;
export function errorHead(message: unknown): string;
export function testKey(t: {
	file: string;
	title: string;
	project?: string | null;
}): string;
export function vitestResults(report: unknown, cwd: string): Results;
export function playwrightResults(report: unknown, testDir?: string): Results;
export function reportErrors(runner: string, report: unknown): string[];
export function rerunArgs(
	runner: "vitest" | "playwright",
	failed: Failure[],
	opts: { scripts: string; outputDir: string },
): string[];
export function labelFailures(
	failed: Failure[],
	rerun: Results | null,
): Labelled[];
export function jobVerdict(o: {
	jobStatus: string;
	testsStep: string;
	failed: Labelled[];
	otherFailed: string[];
}): string;
export function otherFailedSteps(steps: unknown): string[];
export function cell(text: unknown): string;
export function summaryMarkdown(doc: {
	job: string;
	verdict: string;
	note?: string;
	failed: Labelled[];
}): string;
export function readResults(
	runner: string,
	report: unknown,
	cwd: string,
): (Results & { errors: string[] }) | null;
