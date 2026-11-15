import { describe, expect, it } from "vitest";
import { bytesPair, formatBytes, stageGeometry } from "./stage";

describe("stageGeometry", () => {
	it("same size: one rect equal to the stage", () => {
		const g = stageGeometry({ w: 493, h: 312 }, { w: 493, h: 312 }, 1000);
		expect(g).toMatchObject({ w: 493, h: 312, scale: 1, sized: true });
		expect(g.before).toEqual({ x: 0, y: 0, w: 493, h: 312 });
		expect(g.after).toEqual({ x: 0, y: 0, w: 493, h: 312 });
	});

	it("taller after: the stage is the larger height, before pinned top-left", () => {
		const g = stageGeometry({ w: 493, h: 312 }, { w: 493, h: 340 }, 1000);
		expect([g.w, g.h]).toEqual([493, 340]);
		expect(g.before).toEqual({ x: 0, y: 0, w: 493, h: 312 });
		expect(g.after).toEqual({ x: 0, y: 0, w: 493, h: 340 });
	});

	it("narrower and taller vs wider and shorter: max width × max height", () => {
		const g = stageGeometry({ w: 440, h: 340 }, { w: 493, h: 312 }, 1000);
		expect([g.w, g.h]).toEqual([493, 340]);
		expect(g.before).toEqual({ x: 0, y: 0, w: 440, h: 340 });
		expect(g.after).toEqual({ x: 0, y: 0, w: 493, h: 312 });
	});

	it("fit in a 320px box scales both by 320/493", () => {
		const g = stageGeometry({ w: 440, h: 340 }, { w: 493, h: 312 }, 320);
		const s = 320 / 493;
		expect(g.scale).toBeCloseTo(s);
		expect(g.w).toBeCloseTo(320);
		expect(g.h).toBeCloseTo(340 * s);
		expect(g.before?.w).toBeCloseTo(440 * s);
		expect(g.before?.h).toBeCloseTo(340 * s);
		expect(g.after?.w).toBeCloseTo(320);
		expect(g.after?.h).toBeCloseTo(312 * s);
	});

	it("never scales up at Fit", () => {
		const g = stageGeometry({ w: 40, h: 30 }, { w: 40, h: 30 }, 320);
		expect(g).toMatchObject({ w: 40, h: 30, scale: 1 });
	});

	it("one side null (added or deleted): the other side's size", () => {
		const added = stageGeometry(null, { w: 200, h: 100 }, 1000);
		expect(added).toMatchObject({ w: 200, h: 100, sized: true });
		expect(added.before).toBeUndefined();
		expect(added.after).toEqual({ x: 0, y: 0, w: 200, h: 100 });
		const deleted = stageGeometry({ w: 200, h: 100 }, null, 1000);
		expect(deleted).toMatchObject({ w: 200, h: 100 });
		expect(deleted.after).toBeUndefined();
	});

	it("no intrinsic size (an SVG's 0×0): the box's width at 4:3, unsized, image over the whole stage", () => {
		const g = stageGeometry(null, { w: 0, h: 0 }, 320);
		expect(g).toMatchObject({ w: 320, h: 240, scale: 1, sized: false });
		expect(g.after).toEqual({ x: 0, y: 0, w: 320, h: 240 });
	});

	it("one sized side and one 0×0: the sized one sets the stage; the 0×0 fills it", () => {
		const g = stageGeometry({ w: 0, h: 0 }, { w: 200, h: 100 }, 1000);
		expect(g).toMatchObject({ w: 200, h: 100, sized: true });
		expect(g.before).toEqual({ x: 0, y: 0, w: 200, h: 100 });
	});
});

describe("formatBytes", () => {
	it.each([
		[0, "0 B"],
		[900, "900 B"],
		[41 * 1024, "41 KB"],
		[41.6 * 1024, "42 KB"],
		[2.1 * 1024 * 1024, "2.1 MB"],
		[12 * 1024 * 1024, "12 MB"],
	])("%d → %s", (n, text) => expect(formatBytes(n)).toBe(text));

	it("a pair in one unit names it once", () => {
		expect(bytesPair(41 * 1024, 44 * 1024)).toBe("41 → 44 KB");
		expect(bytesPair(900 * 1024, 1.2 * 1024 * 1024)).toBe("900 KB → 1.2 MB");
		expect(bytesPair(undefined, 44 * 1024)).toBe("44 KB");
		expect(bytesPair(41 * 1024, undefined)).toBe("41 KB");
		expect(bytesPair(undefined, undefined)).toBe("");
	});
});
