/**
 * The value for $CRB_FAKE_GH_SERVER, starting this process's fake gh server
 * on first use; "" when it could not start.
 */
export function fakeGhServer(): string;
/** Calls the server has taken, and those still running. */
export function fakeGhServerCalls(): { served: number; running: number };
