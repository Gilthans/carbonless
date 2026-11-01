import { waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * A fetch answer that waits for the test (design principle 8's tests):
 * `response` settles once `release(body)` is called, never on a timer.
 */
export function heldJson(): {
	response: Promise<Response>;
	release: (body: unknown, status?: number) => void;
} {
	let settle: (r: Response) => void = () => {};
	const response = new Promise<Response>((resolve) => {
		settle = resolve;
	});
	return {
		response,
		release: (body, status = 200) =>
			settle(new Response(JSON.stringify(body), { status })),
	};
}

/**
 * Loading never looks empty (design principle 8), in a component test:
 * while the answer is held, `loading` shows and none of `empty` (nor
 * `result`) does; once `release()` lets it go, `result` shows and
 * `loading` is gone. Each is a query (`screen.queryBy…`), read anew.
 */
export async function expectLoadingThen(opts: {
	loading: () => HTMLElement | null;
	empty?: Array<() => HTMLElement | null>;
	release: () => void;
	result: () => HTMLElement | null;
}): Promise<void> {
	await waitFor(() => expect(opts.loading()).toBeInTheDocument());
	for (const empty of opts.empty ?? []) expect(empty()).toBeNull();
	expect(opts.result()).toBeNull();
	opts.release();
	await waitFor(() => expect(opts.result()).toBeInTheDocument());
	expect(opts.loading()).toBeNull();
}
