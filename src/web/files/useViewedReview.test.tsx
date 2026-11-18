// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewView } from "../../shared/types";
import { useViewedReview, type Viewing } from "./comparison";

const view = (revision: string, patchset: number | null): ReviewView => ({
	revision,
	patchset,
	files: [],
	progress: {} as ReviewView["progress"],
});

interface Props {
	served: ReviewView | undefined;
	fetching: boolean;
	viewing: Viewing | null;
	viewedRevision: string | undefined;
}

const render = (initialProps: Props) =>
	renderHook(
		(p: Props) =>
			useViewedReview(p.served, p.fetching, p.viewing, p.viewedRevision),
		{ initialProps },
	);

const HEAD: Viewing = { kind: "head", oid: "f".repeat(40) };
const PS2: Viewing = { kind: "patchset", number: 2 };

afterEach(cleanup);

describe("useViewedReview (CAR-194)", () => {
	// The head viewed (snapshot r2), then a comment on it starts PS2 on
	// that snapshot: the session names PS2 (the comparison moves to it)
	// while the session's own review, cached from before, is still PS1's
	// (r1) and read again.
	const ps1 = view("r1", 1);
	const head = view("r2", null);
	const ps2 = view("r2", 2);

	it("never shows the previous patch set's cached review under the new one's name: the viewed head's snapshot stays until the read answers", () => {
		const hook = render({
			served: head,
			fetching: false,
			viewing: HEAD,
			viewedRevision: undefined,
		});
		expect(hook.result.current).toBe(head);
		hook.rerender({
			served: ps1,
			fetching: true,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBe(head);
		hook.rerender({
			served: ps2,
			fetching: false,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBe(ps2);
	});

	it("a held view of the same head on another base (another snapshot) doesn't fit: none yet", () => {
		const hook = render({
			served: view("rA", null),
			fetching: false,
			viewing: HEAD,
			viewedRevision: undefined,
		});
		// PS2 started on the head's snapshot against the moved base: rB.
		hook.rerender({
			served: ps1,
			fetching: true,
			viewing: PS2,
			viewedRevision: "rB",
		});
		expect(hook.result.current).toBeUndefined();
	});

	it("the same patch set's view stays while the read answers another's", () => {
		const hook = render({
			served: ps2,
			fetching: false,
			viewing: PS2,
			viewedRevision: "r2",
		});
		hook.rerender({
			served: ps1,
			fetching: true,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBe(ps2);
	});

	it("nothing that fits was shown before: none yet (the skeleton), not the other patch set's", () => {
		const hook = render({
			served: ps1,
			fetching: true,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBeUndefined();
	});

	it("a read again that fails settles: the served view shows (with the error), never stuck", () => {
		const hook = render({
			served: ps1,
			fetching: true,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBeUndefined();
		hook.rerender({
			served: ps1,
			fetching: false,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBe(ps1);
	});

	it("a settled answer shows as served, whatever its patch set", () => {
		const hook = render({
			served: ps1,
			fetching: false,
			viewing: PS2,
			viewedRevision: "r2",
		});
		expect(hook.result.current).toBe(ps1);
	});

	it("a viewed head takes any review served for it", () => {
		const hook = render({
			served: ps2,
			fetching: true,
			viewing: HEAD,
			viewedRevision: undefined,
		});
		expect(hook.result.current).toBe(ps2);
	});
});
