export type OutcomeDoc = {
	job: string;
	attempt?: number;
	verdict: string;
	failed?: {
		file: string;
		title: string;
		project?: string | null;
		verdict: string;
	}[];
};
export type Attempt = {
	n: number;
	status: string;
	conclusion: string | null;
	url?: string;
	createdAt?: string;
	jobs?: { name: string; conclusion: string | null }[];
	outcomes?: OutcomeDoc[];
};
export type Run = {
	id: number;
	branch: string;
	event: string;
	url?: string;
	createdAt?: string;
	attempts: Attempt[];
};
export type TopFlaky = {
	file: string;
	title: string;
	project: string | null;
	count: number;
	job: string;
	lastSeen: string;
	lastRun?: string;
};
export type Summary = {
	runs: number;
	attempts: number;
	passed: number;
	failed: number;
	cancelled: number;
	inProgress: number;
	flaky: number;
	consistent: number;
	nonTest: number;
	unknown: number;
	flakeRate: number;
	master: { attempts: number; flaky: number; flakeRate: number };
	failedAttempts: {
		run: number;
		attempt: number;
		verdict: string;
		reason: string;
	}[];
	topFlaky: TopFlaky[];
};
export const DERIVED_JOBS: Set<string>;
export function parseSince(since: string, now?: Date): Date;
export function judgeAttempt(
	attempt: Attempt,
	laterPassed: boolean,
): { verdict: string; reason: string };
export function aggregate(runs: Run[]): Summary;
export function render(
	s: Summary,
	o: { title: string; markdown?: boolean },
): string;
export function collect(o: {
	repo: string;
	since: Date;
	branch?: string;
	gh?: (args: string[]) => string;
	outcomes?: (runId: number) => OutcomeDoc[];
}): Run[];
export function transient(stderr: string): boolean;
