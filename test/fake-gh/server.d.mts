/**
 * The value for $CRB_FAKE_GH_SERVER, starting this process's fake gh server
 * on first use; "" when it could not listen. Throws when its code fails to
 * load.
 */
export function fakeGhServer(): string;
/** Calls the server has taken, and those still running. */
export function fakeGhServerCalls(): { served: number; running: number };
/** The most a request may hold before it is complete. */
export const MAX_REQUEST: number;
/** Starts a fake gh server running `serve` (a module URL; serve.mjs by default). */
export function startFakeGhServer(serve?: string): {
	address: string;
	state: Int32Array;
};
