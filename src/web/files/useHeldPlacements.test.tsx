// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlacementsAnswer } from "../../shared/types";
import { useHeldPlacements, type Viewing } from "./comparison";

const placed = (
	revision: string,
	patchset: number | null,
	readId = "read1",
): PlacementsAnswer => ({
	readId,
	revision,
	patchset,
	threads: [
		{
			id: "t1",
			placement: {
				status: "placed",
			} as unknown as PlacementsAnswer["threads"][number]["placement"],
		},
	],
});

interface Props {
	served: PlacementsAnswer | null;
	holding: boolean;
	readId: string | undefined;
	viewing: Viewing | null;
	viewedRevision: string | undefined;
}

const render = (initialProps: Props) =>
	renderHook(
		(p: Props) =>
			useHeldPlacements(
				p.served,
				p.holding,
				p.readId,
				p.viewing,
				p.viewedRevision,
			),
		{ initialProps },
	);

const HEAD: Viewing = { kind: "head", oid: "f".repeat(40) };
const PS2: Viewing = { kind: "patchset", number: 2 };

afterEach(cleanup);

describe("useHeldPlacements (CAR-208)", () => {
	// The head viewed (snapshot r2); the first mark on it starts PS2 on r2.
	const head = placed("r2", null);
	const onHead: Props = {
		served: head,
		holding: true,
		readId: "read1",
		viewing: null,
		viewedRevision: undefined,
	};
	const onPs2: Props = {
		served: null,
		holding: true,
		readId: "read1",
		viewing: PS2,
		viewedRevision: "r2",
	};

	it("PS2 started on the viewed head: the head's placements stay, under PS2's number (where a drag stores), until PS2's answer lands", () => {
		const hook = render(onHead);
		expect(hook.result.current).toBe(head);
		hook.rerender(onPs2);
		const held = hook.result.current;
		expect(held?.threads).toBe(head.threads);
		expect(held?.patchset).toBe(2);
		// The same object on every render while held (the placement map keeps).
		hook.rerender({ ...onPs2 });
		expect(hook.result.current).toBe(held);
		const ps2 = placed("r2", 2);
		hook.rerender({ ...onPs2, served: ps2 });
		expect(hook.result.current).toBe(ps2);
	});

	it("PS2 on another snapshot (the head on a moved base): none held", () => {
		const hook = render(onHead);
		hook.rerender({ ...onPs2, viewedRevision: "rB" });
		expect(hook.result.current).toBeNull();
	});

	it("another read's placements: none held", () => {
		const hook = render(onHead);
		hook.rerender({ ...onPs2, readId: "read2" });
		expect(hook.result.current).toBeNull();
	});

	it("a failed read (not holding): none held, the failure shows", () => {
		const hook = render(onHead);
		hook.rerender({ ...onPs2, holding: false });
		expect(hook.result.current).toBeNull();
	});

	it("a viewed head never gets a held answer", () => {
		const hook = render({ ...onPs2, served: placed("r2", 2) });
		hook.rerender({
			...onPs2,
			viewing: HEAD,
			viewedRevision: undefined,
		});
		expect(hook.result.current).toBeNull();
	});
});
