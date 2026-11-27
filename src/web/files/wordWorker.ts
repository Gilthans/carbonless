import { type MarkJob, markJobs } from "./wordWork";

/**
 * The word-marks worker (wordWork.ts): marks each job's pairs and groups off the main
 * thread, jobs in the order they come, and answers with the job's id and
 * its marks, or the error that stopped them (the job fails, not the worker).
 */
const scope = globalThis as unknown as {
	onmessage: (event: MessageEvent<{ id: number; jobs: MarkJob[] }>) => void;
	postMessage: (message: unknown) => void;
};
scope.onmessage = (event) => {
	const { id, jobs } = event.data;
	try {
		scope.postMessage({ id, marks: markJobs(jobs) });
	} catch (error) {
		scope.postMessage({ id, error: String(error) });
	}
};
