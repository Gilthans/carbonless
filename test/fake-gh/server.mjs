// Starts this process's fake gh server (serve.mjs) in a worker thread, once.
// A thread of its own: a test may block its main thread on a gh call
// (spawnSync), and the calls must go on meanwhile.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	MessageChannel,
	receiveMessageOnPort,
	Worker,
} from "node:worker_threads";

const KEY = Symbol.for("carbonless.fakeGhServer");
const STATE = Symbol.for("carbonless.fakeGhServerState");

/**
 * The most a request may hold before it is complete: a write's body and the
 * environment are well under it; a client sending more is cut off.
 */
export const MAX_REQUEST = 16 * 1024 * 1024;

/**
 * The value for $CRB_FAKE_GH_SERVER ("127.0.0.1:<port>:<token>"), starting
 * the server on first use; "" when it could not listen, and test/fake-gh/gh
 * then runs each call in a process of its own. Throws at once with the
 * error when the server's code fails to load. The worker doesn't keep the
 * process alive.
 */
export function fakeGhServer() {
	if (typeof globalThis[KEY] === "string") return globalThis[KEY];
	const started = startFakeGhServer();
	globalThis[STATE] = started.state;
	globalThis[KEY] = started.address;
	return globalThis[KEY];
}

/**
 * Starts a fake gh server running `serve` (serve.mjs; a test's broken one):
 * its address ("" when it could not listen) and state.
 */
export function startFakeGhServer(
	serve = pathToFileURL(join(import.meta.dirname, "serve.mjs")).href,
) {
	// [status (0 starting, 1 listening, 2 failed), port, calls, running]
	const state = new Int32Array(new SharedArrayBuffer(16));
	const token = randomBytes(16).toString("hex");
	const { port1, port2 } = new MessageChannel();
	// A bootstrap: a serve.mjs that fails to load says so at once, rather
	// than leave this thread waiting out the timeout.
	const worker = new Worker(
		`const { workerData } = await import("node:worker_threads");
		try {
			await import(${JSON.stringify(serve)});
		} catch (error) {
			workerData.errors.postMessage(String(error?.stack ?? error));
			const state = new Int32Array(workerData.state);
			Atomics.store(state, 0, 2);
			Atomics.notify(state, 0);
		}`,
		{
			eval: true,
			workerData: {
				state: state.buffer,
				token,
				maxRequest: MAX_REQUEST,
				errors: port2,
			},
			transferList: [port2],
		},
	);
	worker.unref();
	// A crash later: the shim can't connect and runs the call in a process.
	worker.on("error", () => {});
	Atomics.wait(state, 0, 0, 30_000);
	const failed = receiveMessageOnPort(port1)?.message;
	port1.close();
	if (failed) {
		void worker.terminate();
		throw new Error(`The fake gh server failed to load: ${failed}`);
	}
	const address =
		Atomics.load(state, 0) === 1
			? `127.0.0.1:${Atomics.load(state, 1)}:${token}`
			: "";
	return { address, state };
}

/** Calls the server has taken, and those still running (fake-gh.test.ts). */
export function fakeGhServerCalls() {
	const state = globalThis[STATE];
	return {
		served: state ? Atomics.load(state, 2) : 0,
		running: state ? Atomics.load(state, 3) : 0,
	};
}
