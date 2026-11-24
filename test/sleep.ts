/**
 * The two sleeps a test may take (CAR-260; lint forbids any other:
 * biome-plugins/no-sleep-in-tests.grit). A fixed sleep never waits for
 * something to happen: on a loaded machine it comes later. Hold the answer,
 * wait on the state (`waitFor`, `expect.poll`) or move a fake clock.
 */

/**
 * Gives something that must NOT happen a window to happen in, before the
 * test checks it didn't (no refetch, no second call, no collapse). Only for
 * proving an absence, where no event marks "it would have come by now". On
 * a loaded machine a late, wrong effect may slip past the window: the test
 * then passes when it should fail, never the other way round, so it can't
 * flake. Never use it to wait for something that should happen, nor in a
 * before/after hook. `why` names what must not happen (it reads at the
 * call site). Over 500 ms it is an app timer's window, which belongs on a
 * fake clock: lint flags both (biome-plugins/no-sleep-in-tests.grit).
 */
export function quietFor(ms: number, _why: string): Promise<void> {
	// biome-ignore lint/plugin/no-sleep-in-tests: proves an absence (see above)
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * A fake's own latency (a server that answers late, a holder that keeps a
 * lock a while): the delay is the scenario under test, not a wait for the
 * test's state. The test still waits on state, never on this having passed.
 */
export function fakeDelay(ms: number): Promise<void> {
	// biome-ignore lint/plugin/no-sleep-in-tests: a fake's latency (see above)
	return new Promise((r) => setTimeout(r, ms));
}
