// Starts this process's fake gh server (serve.mjs) in a worker thread, once.
// A thread of its own: a test may block its main thread on a gh call
// (spawnSync), and the calls must go on meanwhile.
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const KEY = Symbol.for("carbonless.fakeGhServer");
const STATE = Symbol.for("carbonless.fakeGhServerState");

/**
 * The value for $CRB_FAKE_GH_SERVER ("127.0.0.1:<port>"), starting the
 * server on first use; "" when it could not start, and test/fake-gh/gh then
 * runs each call in a process of its own. The worker doesn't keep the
 * process alive.
 */
export function fakeGhServer() {
	if (typeof globalThis[KEY] === "string") return globalThis[KEY];
	// [status (0 starting, 1 listening, 2 failed), port, calls, running]
	const state = new Int32Array(new SharedArrayBuffer(16));
	const worker = new Worker(join(import.meta.dirname, "serve.mjs"), {
		workerData: { state: state.buffer },
	});
	worker.unref();
	globalThis[STATE] = state;
	worker.on("error", () => {
		globalThis[KEY] = "";
	});
	Atomics.wait(state, 0, 0, 30_000);
	globalThis[KEY] =
		Atomics.load(state, 0) === 1 ? `127.0.0.1:${Atomics.load(state, 1)}` : "";
	return globalThis[KEY];
}

/** Calls the server has taken, and those still running (fake-gh.test.ts). */
export function fakeGhServerCalls() {
	const state = globalThis[STATE];
	return {
		served: state ? Atomics.load(state, 2) : 0,
		running: state ? Atomics.load(state, 3) : 0,
	};
}
