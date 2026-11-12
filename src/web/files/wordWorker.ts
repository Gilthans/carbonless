import { markPairs } from "./wordWork";

/**
 * The word-marks worker (wordWork.ts): marks each job's pairs off the main
 * thread, jobs in the order they come, and answers with the job's id and
 * its marks, or the error that stopped them (the job fails, not the worker).
 */
const scope = globalThis as unknown as {
	onmessage: (
		event: MessageEvent<{ id: number; pairs: [string, string][] }>,
	) => void;
	postMessage: (message: unknown) => void;
};
scope.onmessage = (event) => {
	const { id, pairs } = event.data;
	try {
		scope.postMessage({ id, marks: markPairs(pairs) });
	} catch (error) {
		scope.postMessage({ id, error: String(error) });
	}
};
