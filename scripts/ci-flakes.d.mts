export type FlakyTest = {
	file: string;
	title: string;
	project?: string | null;
	verdict: string;
};
export type OutcomeDoc = {
	job?: string;
	slug?: string;
	attempt?: number;
	verdict: string | null;
	failed?: FlakyTest[];
};
export type Attempt = {
	n: number;
	status: string;
	conclusion: string | null;
	url?: string;
	createdAt?: string;
	jobs?: {
		name: string;
		conclusion: string | null;
		steps?: { name: string; conclusion: string | null }[];
	}[];
	outcomes?: OutcomeDoc[];
};
export type Run = {
	id: number;
	branch: string;
	event: string;
	url?: string;
	createdAt?: string;
	fork?: boolean;
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
	forkRuns: number;
	attempts: number;
	passed: number;
	failed: number;
	notRun: number;
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
export type Gh = (args: string[], o?: { binary?: boolean }) => string;
export const DERIVED_JOBS: Set<string>;
export const SHARDS_FAILED_STEP: string;
export function slugOf(job: string): string;
export function parseArtifactName(
	name: string,
): { slug: string; attempt: number; verdict: string | null } | null;
export function checkDoc(
	doc: unknown,
	runId: number,
	warn?: (m: string) => void,
): OutcomeDoc | null;
export function parseSince(since: string, now?: Date): Date;
export function judgeAttempt(
	attempt: Attempt,
	laterPassed: boolean,
): { verdict: string; reason: string };
export function aggregate(runs: Run[]): Summary;
export function term(text: unknown): string;
export function render(
	s: Summary,
	o: { title: string; markdown?: boolean },
): string;
export function transient(stderr: string): boolean;
export function realGh(args: string[], o?: { binary?: boolean }): string;
export function unzipFile(buf: Buffer, name: string): Buffer | null;
export function collect(o: {
	repo: string;
	since: Date;
	until?: Date;
	branch?: string;
	gh?: Gh;
	warn?: (m: string) => void;
}): Run[];
export function within(runs: Run[], since: Date): Run[];
