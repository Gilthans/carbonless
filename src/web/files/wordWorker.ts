import { markPairs } from "./wordWork";

/**
 * The word-marks worker (wordWork.ts): marks each job's pairs off the main
 * thread, jobs in the order they come, and answers with the job's id.
 */
const scope = globalThis as unknown as {
	onmessage: (
		event: MessageEvent<{ id: number; pairs: [string, string][] }>,
	) => void;
	postMessage: (message: unknown) => void;
};
scope.onmessage = (event) => {
	const { id, pairs } = event.data;
	scope.postMessage({ id, marks: markPairs(pairs) });
};
