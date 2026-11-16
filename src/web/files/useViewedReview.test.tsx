// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewView } from "../../shared/types";
import { useViewedReview, type Viewing } from "./comparison";

const HEAD = "f".repeat(40);

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
	viewedHead: string | undefined;
}

const render = (initialProps: Props) =>
	renderHook(
		(p: Props) =>
			useViewedReview(p.served, p.fetching, p.viewing, p.viewedHead),
		{
			initialProps,
		},
	);

afterEach(cleanup);

describe("useViewedReview (CAR-194)", () => {
	// The head viewed, then a comment on it starts PS2: the session names
	// PS2 (the comparison moves to it) while the session's own review,
	// cached from before, is still PS1's and read again.
	const ps1 = view("r1", 1);
	const head = view("r2", null);
	const ps2 = view("r2", 2);

	it("never shows the previous patch set's cached review under the new one's name: the viewed head's stays until the read answers", () => {
		const hook = render({
			served: head,
			fetching: false,
			viewing: { kind: "head", oid: HEAD },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBe(head);
		hook.rerender({
			served: ps1,
			fetching: true,
			viewing: { kind: "patchset", number: 2 },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBe(head);
		hook.rerender({
			served: ps2,
			fetching: false,
			viewing: { kind: "patchset", number: 2 },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBe(ps2);
	});

	it("nothing that fits was shown before: none yet (the skeleton), not the other patch set's", () => {
		const hook = render({
			served: ps1,
			fetching: true,
			viewing: { kind: "patchset", number: 2 },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBeUndefined();
	});

	it("a held view of another commit doesn't fit", () => {
		const hook = render({
			served: view("r0", null),
			fetching: false,
			viewing: { kind: "head", oid: "a".repeat(40) },
			viewedHead: "a".repeat(40),
		});
		hook.rerender({
			served: ps1,
			fetching: true,
			viewing: { kind: "patchset", number: 2 },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBeUndefined();
	});

	it("a settled answer shows as served, whatever its patch set", () => {
		const hook = render({
			served: ps1,
			fetching: false,
			viewing: { kind: "patchset", number: 2 },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBe(ps1);
	});

	it("a viewed head takes any review served for it", () => {
		const hook = render({
			served: ps2,
			fetching: true,
			viewing: { kind: "head", oid: HEAD },
			viewedHead: HEAD,
		});
		expect(hook.result.current).toBe(ps2);
	});
});
